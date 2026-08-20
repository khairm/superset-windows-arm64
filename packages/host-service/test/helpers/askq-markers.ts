import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * (MANUAL-DISMISS) Shared harness for the askq marker directory — the on-disk
 * truth behind the red dot.
 *
 * Every test that exercises `clearPendingQuestionMarkers` has to redirect
 * `homedir()` first: `askqMarkerDir` rebuilds its path from `USERPROFILE`
 * (Windows) / `HOME` (elsewhere) on EVERY call, and the code under test
 * unlinks what it finds. Without the redirect these tests delete out of the
 * developer's own `~/.superset`.
 */

/**
 * Redirects `homedir()` at both env vars for the calling test file and
 * restores them — plus removes every directory handed out — after each test.
 *
 * Call once at the top level of a test file and use the returned factory
 * inside the tests:
 *
 * ```ts
 * const fakeHome = withFakeHome("askq-dismiss-");
 * ```
 */
export function withFakeHome(prefix: string): () => Promise<string> {
	const realUserProfile = process.env.USERPROFILE;
	const realHome = process.env.HOME;
	const homes: string[] = [];

	afterEach(async () => {
		if (realUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = realUserProfile;
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		while (homes.length > 0) {
			const home = homes.pop();
			if (home !== undefined) await rm(home, { recursive: true, force: true });
		}
	});

	return async function fakeHome(): Promise<string> {
		const home = await mkdtemp(join(tmpdir(), prefix));
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		homes.push(home);
		return home;
	};
}

/** The directory every terminal's marker directory hangs off. */
export function askqMarkerRoot(home: string): string {
	return join(home, ".superset", "agent-subagent-running");
}

/**
 * The path `askqMarkerDir` is expected to build, spelled out independently of
 * the implementation so a change to either side is visible as a failure.
 */
export function askqMarkerDirFor(home: string, terminalId: string): string {
	return join(askqMarkerRoot(home), `${terminalId}.askq`);
}

/**
 * Owner files with exactly the mtimes the `dismissStartedAtMs` fence compares.
 * Returns the marker directory.
 */
export async function seedAskqOwners(
	home: string,
	terminalId: string,
	owners: { name: string; mtimeMs: number }[],
): Promise<string> {
	const dir = askqMarkerDirFor(home, terminalId);
	await mkdir(dir, { recursive: true });
	for (const owner of owners) {
		const path = join(dir, owner.name);
		await writeFile(path, "");
		await utimes(path, owner.mtimeMs / 1000, owner.mtimeMs / 1000);
	}
	return dir;
}

/** One owner file; returns its path, which is what the assertions want. */
export async function seedAskqOwner(
	home: string,
	terminalId: string,
	name: string,
	mtimeMs: number,
): Promise<string> {
	const dir = await seedAskqOwners(home, terminalId, [{ name, mtimeMs }]);
	return join(dir, name);
}

export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
