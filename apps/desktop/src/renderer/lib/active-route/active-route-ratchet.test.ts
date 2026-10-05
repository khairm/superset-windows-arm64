import { describe, expect, test } from "bun:test";
// biome-ignore lint/style/noRestrictedImports: test file needs fs/path for source verification
import { readdirSync, readFileSync, statSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: test file needs fs/path for source verification
import { join } from "node:path";

// (NAV-LOCAL-RENDER) Sidebar rows, sections and the layouts above them never
// subscribe to the router: one subscription there re-renders every row and
// rebuilds the live queries on each click. Counts are exact in both directions.
const RENDERER_ROOT = join(import.meta.dir, "..", "..");
const SIDEBAR_DIR =
	"routes/_authenticated/_dashboard/components/DashboardSidebar";
const SCANNED_FILES = [
	"routes/_authenticated/layout.tsx",
	"routes/_authenticated/_dashboard/layout.tsx",
	"hooks/host-workspaces/useHostWorkspaces/useHostWorkspaces.ts",
	"routes/_authenticated/providers/SandboxAccessProvider/SandboxAccessProvider.tsx",
];
const ALLOWED: Record<string, number> = {
	[`${SIDEBAR_DIR}/components/DashboardSidebarHeader/DashboardSidebarHeader.tsx`]: 1,
};
const ROUTER_HOOK_CALL =
	/\buse(?:MatchRoute|RouterState|Location|Params|Search|Match|Matches)\(/g;

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(join(RENDERER_ROOT, dir))) {
		const relative = `${dir}/${entry}`;
		if (statSync(join(RENDERER_ROOT, relative)).isDirectory()) {
			if (entry === "fixtures") continue;
			yield* walk(relative);
			continue;
		}
		if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
		yield relative;
	}
}

describe("active-route ratchet", () => {
	test("router-subscribing hook calls match the allowlist exactly", () => {
		const files = [...walk(SIDEBAR_DIR), ...SCANNED_FILES];
		expect(files).toContain(`${SIDEBAR_DIR}/DashboardSidebar.tsx`);
		const counts: Record<string, number> = {};
		for (const file of files) {
			const calls =
				readFileSync(join(RENDERER_ROOT, file), "utf-8").match(ROUTER_HOOK_CALL)
					?.length ?? 0;
			if (calls > 0) counts[file] = calls;
		}
		expect(counts).toEqual(ALLOWED);
	});
});
