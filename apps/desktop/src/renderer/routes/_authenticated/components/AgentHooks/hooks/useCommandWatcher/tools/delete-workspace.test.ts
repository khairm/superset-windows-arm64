import { describe, expect, it } from "bun:test";
import { deleteWorkspace } from "./delete-workspace";
import type { SoftDeleteWorkspaceOutcome, ToolContext } from "./types";

/**
 * (RECYCLE-BIN) The remote tool must never reach a physical destroy: the fake
 * context exposes ONLY the soft-delete function, so a regression that reaches
 * for a destroy mutation fails to type-check and to run.
 */
function makeCtx(
	softDeleteWorkspace: (workspaceId: string) => SoftDeleteWorkspaceOutcome,
): ToolContext {
	return { softDeleteWorkspace } as unknown as ToolContext;
}

describe("delete_workspace tool (RECYCLE-BIN)", () => {
	it("soft-deletes each workspace and reports it as recoverable", async () => {
		const softDeleted: string[] = [];
		const result = await deleteWorkspace.execute(
			{ workspaceIds: ["ws-1", "ws-2"] },
			makeCtx((workspaceId) => {
				softDeleted.push(workspaceId);
				return { ok: true };
			}),
		);

		expect(softDeleted).toEqual(["ws-1", "ws-2"]);
		expect(result.success).toBe(true);
		expect(result.data?.deleted).toEqual([
			{ workspaceId: "ws-1", recoverable: true },
			{ workspaceId: "ws-2", recoverable: true },
		]);
		expect(result.data?.errors).toBeUndefined();
	});

	it("refuses a main workspace loudly and still deletes the rest", async () => {
		const softDeleted: string[] = [];
		const result = await deleteWorkspace.execute(
			{ workspaceIds: ["ws-main", "ws-1"] },
			makeCtx((workspaceId) => {
				if (workspaceId === "ws-main") {
					return {
						ok: false,
						reason: "ws-main is a main workspace — mains are archive-only",
					};
				}
				softDeleted.push(workspaceId);
				return { ok: true };
			}),
		);

		// The main was never soft-deleted, and the caller is told why.
		expect(softDeleted).toEqual(["ws-1"]);
		expect(result.data?.deleted).toEqual([
			{ workspaceId: "ws-1", recoverable: true },
		]);
		expect(result.data?.errors).toEqual([
			{
				index: 0,
				workspaceId: "ws-main",
				error: "ws-main is a main workspace — mains are archive-only",
			},
		]);
		expect(result.data?.summary).toEqual({
			total: 2,
			succeeded: 1,
			failed: 1,
		});
	});

	it("fails the whole command when every id is refused", async () => {
		const result = await deleteWorkspace.execute(
			{ workspaceIds: ["ws-main"] },
			makeCtx(() => ({ ok: false, reason: "mains are archive-only" })),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("All workspace deletions failed");
		expect(result.data?.deleted).toEqual([]);
	});

	it("reports a thrown soft delete as a per-item error", async () => {
		const result = await deleteWorkspace.execute(
			{ workspaceIds: ["ws-1"] },
			makeCtx(() => {
				throw new Error("collection write failed");
			}),
		);

		expect(result.success).toBe(false);
		expect(result.data?.errors).toEqual([
			{ index: 0, workspaceId: "ws-1", error: "collection write failed" },
		]);
	});
});
