import { describe, expect, test } from "bun:test";
// biome-ignore lint/style/noRestrictedImports: test file needs fs/path for source verification
import { readdirSync, readFileSync, statSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: test file needs fs/path for source verification
import { join, relative, sep } from "node:path";

/**
 * (ACTIVITY-SPLIT) The host's activity stamp moves on every agent tick. Carried
 * on the shared workspace rows, it re-rendered every `useHostWorkspaces()`
 * consumer and every project query hook each time. It now lives in a separate
 * store, and only the ingest file below may name the field. A new reader of
 * `.lastActivityAt` on `HostWorkspaceItem` or `DashboardSidebarWorkspace`
 * type-checks as a missing property, the build does not gate that error, and
 * "Last active" silently falls back to `updatedAt`. This test is what catches it.
 */
const ALLOWED_FILES = new Set([
	"hooks/host-workspaces/useHostWorkspaces/useHostWorkspaces.utils.ts",
]);

const RENDERER_ROOT = join(import.meta.dir, "..", "..", "..");
const TOKEN = "lastActivityAt";

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* walk(full);
			continue;
		}
		if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
		if (/\.test\.tsx?$/.test(entry)) continue;
		yield full;
	}
}

describe("workspace activity readers", () => {
	test("only the ingest file names the activity stamp", () => {
		const offenders: string[] = [];
		for (const file of walk(RENDERER_ROOT)) {
			const path = relative(RENDERER_ROOT, file).split(sep).join("/");
			if (ALLOWED_FILES.has(path)) continue;
			if (readFileSync(file, "utf-8").includes(TOKEN)) offenders.push(path);
		}
		expect(
			offenders,
			"read activity via useHostWorkspaceActivityStore",
		).toEqual([]);
	});

	test("the allowlist has no stale entries", () => {
		const stale = [...ALLOWED_FILES].filter(
			(path) =>
				!readFileSync(join(RENDERER_ROOT, path), "utf-8").includes(TOKEN),
		);
		expect(stale).toEqual([]);
	});
});
