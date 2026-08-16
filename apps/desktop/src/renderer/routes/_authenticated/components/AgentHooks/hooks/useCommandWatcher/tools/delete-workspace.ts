import { z } from "zod";
import type {
	BulkItemError,
	CommandResult,
	ToolContext,
	ToolDefinition,
} from "./types";
import { buildBulkResult } from "./types";

const schema = z.object({
	workspaceIds: z.array(z.string().uuid()).min(1).max(5),
});

interface DeletedWorkspace {
	workspaceId: string;
	/** (RECYCLE-BIN) Always true — the row is in the bin, not destroyed. */
	recoverable: true;
}

/**
 * (RECYCLE-BIN) `delete_workspace` is a SOFT delete, exactly like the sidebar's
 * own Delete: each workspace moves to its Recycle Bin (worktree, branch and
 * terminals untouched) and Restore brings it back. It used to call the legacy
 * PHYSICAL delete — killing terminals, removing the worktree from disk and
 * dropping the DB records with no `deletedAt` and no way back — which made an
 * always-mounted remote command the one delete entry point that bypassed the
 * bin, and it accepted MAIN workspace ids that the local UI has always refused.
 *
 * Mains are refused per id with a reason rather than skipped silently
 * (MASTER-ARCHIVE-ONLY), and permanent destroy stays reachable only from inside
 * the bin.
 */
async function execute(
	params: z.infer<typeof schema>,
	ctx: ToolContext,
): Promise<CommandResult> {
	const deleted: DeletedWorkspace[] = [];
	const errors: BulkItemError[] = [];

	for (const [i, workspaceId] of params.workspaceIds.entries()) {
		try {
			const outcome = ctx.softDeleteWorkspace(workspaceId);
			if (!outcome.ok) {
				errors.push({ index: i, workspaceId, error: outcome.reason });
				continue;
			}
			deleted.push({ workspaceId, recoverable: true });
		} catch (error) {
			errors.push({
				index: i,
				workspaceId,
				error:
					error instanceof Error ? error.message : "Failed to delete workspace",
			});
		}
	}

	return buildBulkResult({
		items: deleted,
		errors,
		itemKey: "deleted",
		allFailedMessage: "All workspace deletions failed",
		total: params.workspaceIds.length,
	});
}

export const deleteWorkspace: ToolDefinition<typeof schema> = {
	name: "delete_workspace",
	schema,
	execute,
};
