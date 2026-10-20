import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveHandle } from "./question-store";
import { handleTranscript } from "./read-api";
import {
	hostDbReader,
	NOW,
	snapshot,
	type TreeFixture,
	terminalRow,
	treeDeps,
	workspaceRow,
} from "./test-fixtures";
import type { SealedRequestContext, TerminalId } from "./types";

const TERM = "terminal-1";
const WS = "workspace-1";
const LAST_EVENT_AT = NOW - 5_000;

const CTX = {
	granted: ["transcript.read"],
	device: { deviceId: "d", revokedAtMs: null, writesDisabledAtMs: null },
} as unknown as SealedRequestContext;

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function setup(transcriptPath: string) {
	const fixture: TreeFixture = {
		projects: [],
		workspaces: [workspaceRow(WS, null)],
		terminals: [terminalRow(TERM, WS)],
		bindings: [
			{
				terminalId: TERM,
				workspaceId: WS,
				agentId: "claude",
				agentSessionId: "session-1",
				definitionId: null,
				startedAt: NOW - 60_000,
				lastEventAt: LAST_EVENT_AT,
				lastEventType: "Stop",
			},
		],
		mirror: snapshot([], []),
	};
	const reads: Array<{ hostTerminalId: string; lastEventAt: number }> = [];
	const deps = treeDeps(fixture, {
		db: {
			...hostDbReader(fixture),
			transcriptPathFor: async () => transcriptPath,
		},
		markReadFromCompanion: (input) => reads.push(input),
	});
	return { deps, reads };
}

function transcriptFile(): string {
	const root = mkdtempSync(join(tmpdir(), "transcript-read-"));
	roots.push(root);
	const path = join(root, "session-1.jsonl");
	writeFileSync(path, "");
	return path;
}

const terminalId = deriveHandle("terminal", TERM) as unknown as TerminalId;

describe("the newest transcript page is a read", () => {
	it("advances on the newest page, with `before` omitted or null", async () => {
		const { deps, reads } = setup(transcriptFile());
		await handleTranscript(deps, CTX, { terminalId, limit: 10 });
		await handleTranscript(deps, CTX, { terminalId, limit: 10, before: null });
		expect(reads).toEqual([
			{ hostTerminalId: TERM, lastEventAt: LAST_EVENT_AT },
			{ hostTerminalId: TERM, lastEventAt: LAST_EVENT_AT },
		]);
	});

	it("does not advance on an older page", async () => {
		const { deps, reads } = setup(transcriptFile());
		const before = Buffer.from(JSON.stringify({ o: 0 }), "utf8").toString(
			"base64url",
		);
		await handleTranscript(deps, CTX, { terminalId, limit: 10, before });
		expect(reads).toEqual([]);
	});

	it("does not advance when the read fails", async () => {
		const missing = join(transcriptFile(), "..", "missing.jsonl");
		const { deps, reads } = setup(missing);
		await expect(
			handleTranscript(deps, CTX, { terminalId, limit: 10 }),
		).rejects.toThrow();
		expect(reads).toEqual([]);
	});
});
