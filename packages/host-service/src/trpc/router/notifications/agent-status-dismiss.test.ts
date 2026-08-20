import { describe, expect, it } from "bun:test";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	askqMarkerDirFor,
	askqMarkerRoot,
	exists,
	seedAskqOwners,
	withFakeHome,
} from "../../../../test/helpers/askq-markers";
import {
	askqMarkerDir,
	clearPendingQuestionMarkers,
} from "./agent-status-snapshot";

const fakeHome = withFakeHome("askq-dismiss-");

describe("(MANUAL-DISMISS) askqMarkerDir", () => {
	it.each([
		"../escape",
		"..",
		"",
		"a/b",
		"a\\b",
		"t 1",
		"café",
		"термінал",
		"t\0x",
		".",
	])("refuses %p, so no caller can build a path from it", (terminalId) => {
		expect(askqMarkerDir(terminalId)).toBeNull();
	});

	it("builds the same path the reader and the hook writers use", async () => {
		const home = await fakeHome();
		expect(askqMarkerDir("term-1")).toBe(askqMarkerDirFor(home, "term-1"));
	});
});

describe("(MANUAL-DISMISS) clearPendingQuestionMarkers", () => {
	it("removes nothing for an unsafe id, even one whose traversal would land on a real marker directory", async () => {
		const home = await fakeHome();
		// `../victim` would resolve to `<home>/.superset/victim.askq` if the guard
		// were applied anywhere but inside the path builder.
		const victim = join(home, ".superset", "victim.askq");
		await mkdir(victim, { recursive: true });
		await writeFile(join(victim, "_main"), "");

		const result = await clearPendingQuestionMarkers("../victim", Date.now());

		expect(result).toEqual({ removed: [], survivors: [] });
		expect(await exists(join(victim, "_main"))).toBe(true);
	});

	it("treats a missing marker directory as a successful no-op — the end state the caller asked for is already true", async () => {
		await fakeHome();
		expect(
			await clearPendingQuestionMarkers("term-never-asked", Date.now()),
		).toEqual({ removed: [], survivors: [] });
	});

	it("THROWS when the directory cannot be read for any reason other than absence — an unknown filesystem is not a successful dismissal", async () => {
		const home = await fakeHome();
		// A plain file where the directory belongs: readdir fails ENOTDIR.
		await mkdir(askqMarkerRoot(home), { recursive: true });
		await writeFile(join(askqMarkerRoot(home), "term-wedged.askq"), "");

		expect(
			clearPendingQuestionMarkers("term-wedged", Date.now()),
		).rejects.toThrow();
	});

	it("removes every owner that predates the click and leaves the directory behind only when one survives", async () => {
		const home = await fakeHome();
		const clickedAt = Date.now();
		const dir = await seedAskqOwners(home, "term-1", [
			{ name: "_main", mtimeMs: clickedAt - 60_000 },
			{ name: "sub-a", mtimeMs: clickedAt - 5 },
		]);

		const result = await clearPendingQuestionMarkers("term-1", clickedAt);

		expect(result.removed.sort()).toEqual(["_main", "sub-a"]);
		expect(result.survivors).toEqual([]);
		expect(await exists(dir)).toBe(false);
	});

	it("keeps an owner written AFTER the click — the user cannot dismiss a question they never saw", async () => {
		const home = await fakeHome();
		const clickedAt = Date.now();
		const dir = await seedAskqOwners(home, "term-1", [
			{ name: "_main", mtimeMs: clickedAt - 60_000 },
			{ name: "sub-late", mtimeMs: clickedAt + 1_000 },
		]);

		const result = await clearPendingQuestionMarkers("term-1", clickedAt);

		expect(result.removed).toEqual(["_main"]);
		expect(result.survivors).toEqual(["sub-late"]);
		expect(await readdir(dir)).toEqual(["sub-late"]);
	});

	it("keeps an owner written in the SAME millisecond as the click — equal timestamps do not prove the user saw it", async () => {
		const home = await fakeHome();
		const clickedAt = Date.now();
		const dir = await seedAskqOwners(home, "term-1", [
			{ name: "_main", mtimeMs: clickedAt - 60_000 },
			{ name: "sub-same", mtimeMs: clickedAt },
		]);

		// The mtime is asserted through the injected stat rather than through
		// `utimes`: the boundary under test is exact equality, and no filesystem
		// guarantees a round trip to the millisecond.
		const result = await clearPendingQuestionMarkers("term-1", clickedAt, {
			stat: async (path) =>
				path.endsWith("sub-same") ? { mtimeMs: clickedAt } : stat(path),
		});

		expect(result.removed).toEqual(["_main"]);
		expect(result.survivors).toEqual(["sub-same"]);
		expect(await readdir(dir)).toEqual(["sub-same"]);
	});

	it("reports an owner created AFTER the listing it was fenced against — the second read is what `survivors` means", async () => {
		const home = await fakeHome();
		const clickedAt = Date.now();
		const dir = await seedAskqOwners(home, "term-1", [
			{ name: "_main", mtimeMs: clickedAt - 60_000 },
		]);

		// A hook landing mid-sweep: the file appears after the readdir the loop is
		// iterating, so nothing in that loop can ever see it.
		const result = await clearPendingQuestionMarkers("term-1", clickedAt, {
			stat: async (path) => {
				if (path.endsWith("_main")) await writeFile(join(dir, "sub-new"), "");
				return stat(path);
			},
		});

		expect(result.removed).toEqual(["_main"]);
		expect(result.survivors).toEqual(["sub-new"]);
		expect(await readdir(dir)).toEqual(["sub-new"]);
	});

	it("counts an owner that vanished mid-sweep as REMOVED — ENOENT is the one stat failure that is evidence", async () => {
		const home = await fakeHome();
		const clickedAt = Date.now();
		const dir = await seedAskqOwners(home, "term-1", [
			{ name: "_main", mtimeMs: clickedAt - 60_000 },
			{ name: "sub-answered", mtimeMs: clickedAt - 1_000 },
		]);

		// Answered between the readdir and the stat: the file provably no longer
		// exists, which is the end state the dismissal was asking for.
		const result = await clearPendingQuestionMarkers("term-1", clickedAt, {
			stat: async (path) => {
				if (!path.endsWith("sub-answered")) return stat(path);
				await rm(path);
				throw Object.assign(new Error("ENOENT: no such file"), {
					code: "ENOENT",
				});
			},
		});

		expect(result.removed.sort()).toEqual(["_main", "sub-answered"]);
		expect(result.survivors).toEqual([]);
		expect(await exists(dir)).toBe(false);
	});

	it("keeps an owner whose stat fails for any reason OTHER than absence — unknown is not evidence the user has seen it", async () => {
		const home = await fakeHome();
		const clickedAt = Date.now();
		const dir = await seedAskqOwners(home, "term-1", [
			{ name: "_main", mtimeMs: clickedAt - 60_000 },
			{ name: "sub-b", mtimeMs: clickedAt - 1_000 },
		]);

		const result = await clearPendingQuestionMarkers("term-1", clickedAt, {
			stat: async (path) => {
				if (!path.endsWith("sub-b")) return stat(path);
				throw Object.assign(new Error("EPERM: operation not permitted"), {
					code: "EPERM",
				});
			},
		});

		expect(result.removed).toEqual(["_main"]);
		expect(result.survivors).toEqual(["sub-b"]);
		expect(await readdir(dir)).toEqual(["sub-b"]);
	});

	it("is a no-op on an empty marker directory and clears the directory itself", async () => {
		const home = await fakeHome();
		const dir = await seedAskqOwners(home, "term-1", []);

		expect(await clearPendingQuestionMarkers("term-1", Date.now())).toEqual({
			removed: [],
			survivors: [],
		});
		expect(await exists(dir)).toBe(false);
	});
});
