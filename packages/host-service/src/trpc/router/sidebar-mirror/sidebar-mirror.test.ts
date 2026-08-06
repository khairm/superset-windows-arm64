import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../../db";
import { sidebarMirrorMeta } from "../../../db/schema";
import { __testing, type SidebarMirrorSyncInput } from "./sidebar-mirror";

const ORG = "org-this-machine";
const dir = mkdtempSync(join(tmpdir(), "mirror-change-"));
const db = createDb(
	join(dir, "host.db"),
	join(import.meta.dirname, "..", "..", "..", "..", "drizzle"),
);

afterAll(() => {
	db.$client.close();
	// Best-effort. Windows keeps a handle on a WAL sidecar for a moment after
	// close, and a temp dir that outlives the run costs nothing.
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
});

function snapshot(
	overrides: Partial<SidebarMirrorSyncInput> = {},
): SidebarMirrorSyncInput {
	return {
		appLaunchId: "launch-1",
		workspaces: [
			{
				workspaceId: "w-1",
				projectId: "p-1",
				sectionId: null,
				tabOrder: 0,
				isHidden: false,
				archivedAt: null,
				snoozeUntil: null,
				snoozeLaunchId: null,
				completedAt: null,
				deletedAt: null,
				pinnedAt: null,
			},
			{
				workspaceId: "w-2",
				projectId: "p-1",
				sectionId: null,
				tabOrder: 1,
				isHidden: false,
				archivedAt: null,
				snoozeUntil: null,
				snoozeLaunchId: null,
				completedAt: null,
				deletedAt: null,
				pinnedAt: null,
			},
		],
		projects: [
			{ projectId: "p-1", tabOrder: 0, isPinned: false, isCollapsed: false },
		],
		...overrides,
	};
}

/**
 * (MIRROR-CHANGE-GSEQ) These are about ONE bit — did this write change
 * anything — because that bit decides whether the phone is told its tree is
 * stale. Both mistakes are real: never announcing leaves the phone blessing a
 * stale list forever, and announcing every heartbeat invalidates every client's
 * cache twelve times an hour.
 */
describe("(MIRROR-CHANGE-GSEQ) replaceMirror reports whether it changed anything", () => {
	it("reports the FIRST sync as a change", () => {
		expect(__testing.replaceMirror(db, snapshot(), ORG, 1_000).changed).toBe(
			true,
		);
	});

	it("does NOT report the five-minute heartbeat re-push of an identical snapshot", () => {
		__testing.replaceMirror(db, snapshot(), ORG, 2_000);
		expect(__testing.replaceMirror(db, snapshot(), ORG, 3_000).changed).toBe(
			false,
		);
	});

	it("is order-independent — the renderer's live queries do not promise a stable row order", () => {
		const base = snapshot();
		__testing.replaceMirror(db, base, ORG, 4_000);
		const reversed = snapshot({ workspaces: [...base.workspaces].reverse() });
		expect(__testing.replaceMirror(db, reversed, ORG, 5_000).changed).toBe(
			false,
		);
	});

	it("reports a curation change — a binned thread", () => {
		__testing.replaceMirror(db, snapshot(), ORG, 6_000);
		const binned = snapshot();
		const first = binned.workspaces[0];
		if (first === undefined) throw new Error("fixture has no workspaces");
		first.deletedAt = 6_500;
		expect(__testing.replaceMirror(db, binned, ORG, 7_000).changed).toBe(true);
	});

	it("reports a MEMBERSHIP change — a thread leaving the sidebar entirely", () => {
		__testing.replaceMirror(db, snapshot(), ORG, 8_000);
		const fewer = snapshot({ workspaces: snapshot().workspaces.slice(0, 1) });
		expect(__testing.replaceMirror(db, fewer, ORG, 9_000).changed).toBe(true);
	});

	it("reports a new LAUNCH ID as a change — the same rows under a new launch release every until-next-launch snooze", () => {
		__testing.replaceMirror(db, snapshot(), ORG, 10_000);
		expect(
			__testing.replaceMirror(
				db,
				snapshot({ appLaunchId: "launch-2" }),
				ORG,
				11_000,
			).changed,
		).toBe(true);
	});

	it("stores the hash it decided on, so the NEXT write has something to compare against", () => {
		__testing.replaceMirror(db, snapshot(), ORG, 12_000);
		const [meta] = db.select().from(sidebarMirrorMeta).limit(1).all();
		expect(meta?.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});
});
