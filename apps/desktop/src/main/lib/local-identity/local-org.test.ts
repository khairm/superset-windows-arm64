/**
 * (CLOUD-SEVERANCE-P2) Tests for the frozen local organization id.
 *
 * The failure this guards is not cosmetic: a resolver that returns a different
 * id than last boot points the app at an empty host.db, which leaves the
 * companion's anti-rollback anchor ahead of its device index and refuses the
 * bridge permanently. So the tests care most about the two ways that happens —
 * re-deriving when a decision already exists, and guessing under ambiguity.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

async function loadModule() {
	// The module resolves its paths per call from the environment, so one
	// instance serves every case; only the memoised decision has to be
	// dropped between them.
	const module = await import("./local-org");
	module.resetLocalOrgCacheForTests();
	return module;
}

function makeOrgDir(organizationId: string, withDb: boolean): void {
	const dir = join(home, "host", organizationId);
	mkdirSync(dir, { recursive: true });
	if (withDb) writeFileSync(join(dir, "host.db"), "");
}

const ORG_A = "30e16b5a-e2af-4874-b126-acc7b3f17aa9";
const ORG_B = "8f14e45f-ceea-4e78-9c6c-1a2b3c4d5e6f";
const DAEMON_ONLY = "00000000-0000-4000-8000-000000000000";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "fork-local-org-"));
	process.env.SUPERSET_HOME_DIR = home;
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	delete process.env.SUPERSET_HOME_DIR;
});

describe("resolveLocalOrgId", () => {
	it("adopts the only host database rather than minting a new id", async () => {
		makeOrgDir(ORG_A, true);
		const { resolveLocalOrgId } = await loadModule();
		const decision = await resolveLocalOrgId();
		expect(decision.organizationId).toBe(ORG_A);
		expect(decision.source).toBe("adopted");
	});

	it("ignores a host directory that holds no database", async () => {
		// The pty-daemon writes under an all-zero uuid on machines that never
		// signed in. Adopting it would point the app at an organization that
		// has never held data.
		makeOrgDir(DAEMON_ONLY, false);
		makeOrgDir(ORG_A, true);
		const { resolveLocalOrgId } = await loadModule();
		expect((await resolveLocalOrgId()).organizationId).toBe(ORG_A);
	});

	it("mints only when there is provably nothing to adopt", async () => {
		const { resolveLocalOrgId } = await loadModule();
		const decision = await resolveLocalOrgId();
		expect(decision.source).toBe("minted");
		expect(decision.organizationId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("refuses to guess between two host databases", async () => {
		makeOrgDir(ORG_A, true);
		makeOrgDir(ORG_B, true);
		const { resolveLocalOrgId } = await loadModule();
		await expect(resolveLocalOrgId()).rejects.toThrow(/Refusing to guess/);
	});

	it("breaks a tie with the last signed-in membership", async () => {
		makeOrgDir(ORG_A, true);
		makeOrgDir(ORG_B, true);
		const { resolveLocalOrgId } = await loadModule();
		const decision = await resolveLocalOrgId(async () => [ORG_B]);
		expect(decision.organizationId).toBe(ORG_B);
		expect(decision.source).toBe("adopted-tiebreak");
	});

	it("still refuses when the membership matches both candidates", async () => {
		makeOrgDir(ORG_A, true);
		makeOrgDir(ORG_B, true);
		const { resolveLocalOrgId } = await loadModule();
		await expect(resolveLocalOrgId(async () => [ORG_A, ORG_B])).rejects.toThrow(
			/Refusing to guess/,
		);
	});

	it("serves the persisted decision and never re-derives it", async () => {
		// A restored backup appearing later must not move the app onto it.
		makeOrgDir(ORG_A, true);
		const first = await loadModule();
		expect((await first.resolveLocalOrgId()).organizationId).toBe(ORG_A);

		makeOrgDir(ORG_B, true);
		const second = await loadModule();
		const decision = await second.resolveLocalOrgId();
		expect(decision.organizationId).toBe(ORG_A);
		expect(decision.source).toBe("persisted");
	});

	it("fails loud on a corrupt decision file instead of re-deriving", async () => {
		makeOrgDir(ORG_A, true);
		writeFileSync(join(home, "fork-local-org.json"), "{not json");
		const { resolveLocalOrgId } = await loadModule();
		await expect(resolveLocalOrgId()).rejects.toThrow(/unreadable/);
	});
});
