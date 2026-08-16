import { describe, expect, it } from "bun:test";
import { executeBulkWorkspaceSoftDelete } from "./bulkWorkspaceSoftDelete";

type Row = { id: string; type: string };

function rows(...items: Row[]): Row[] {
	return items;
}

describe("executeBulkWorkspaceSoftDelete (RECYCLE-BIN)", () => {
	it("soft-deletes every selected row instead of destroying it", () => {
		const softDeleted: string[] = [];

		const result = executeBulkWorkspaceSoftDelete({
			targets: rows(
				{ id: "ws-1", type: "worktree" },
				{ id: "ws-2", type: "session" },
			),
			softDelete: (workspace) => {
				softDeleted.push(workspace.id);
				return true;
			},
		});

		expect(softDeleted).toEqual(["ws-1", "ws-2"]);
		expect(result.softDeletedIds).toEqual(["ws-1", "ws-2"]);
		expect(result.skippedMainIds).toEqual([]);
		expect(result.refusedIds).toEqual([]);
	});

	it("skips main workspaces, matching the single-row delete (MASTER-ARCHIVE-ONLY)", () => {
		const softDeleted: string[] = [];

		const result = executeBulkWorkspaceSoftDelete({
			targets: rows(
				{ id: "main-1", type: "main" },
				{ id: "ws-1", type: "worktree" },
			),
			softDelete: (workspace) => {
				softDeleted.push(workspace.id);
				return true;
			},
		});

		expect(softDeleted).toEqual(["ws-1"]);
		expect(result.softDeletedIds).toEqual(["ws-1"]);
		// Reported, not silently folded into the deleted set: a main that stayed
		// put must not be dropped from the selection as if it had been deleted.
		expect(result.skippedMainIds).toEqual(["main-1"]);
	});

	it("keeps a row the state hook refused out of the deleted set", () => {
		// deleteWorkspace refuses a row whose host record (and therefore type) is
		// unresolvable. That row is still in the active lane, so reporting it as
		// deleted would deselect it while nothing changed.
		const result = executeBulkWorkspaceSoftDelete({
			targets: rows(
				{ id: "ws-refused", type: "worktree" },
				{ id: "ws-1", type: "worktree" },
			),
			softDelete: (workspace) => workspace.id !== "ws-refused",
		});

		expect(result.softDeletedIds).toEqual(["ws-1"]);
		expect(result.refusedIds).toEqual(["ws-refused"]);
		expect(result.skippedMainIds).toEqual([]);
	});

	it("reports nothing deleted when the selection is only mains", () => {
		const softDeleted: string[] = [];

		const result = executeBulkWorkspaceSoftDelete({
			targets: rows({ id: "main-1", type: "main" }),
			softDelete: (workspace) => {
				softDeleted.push(workspace.id);
				return true;
			},
		});

		expect(softDeleted).toEqual([]);
		expect(result.softDeletedIds).toEqual([]);
	});
});
