import type { SelectProject, SelectWorkspace } from "@superset/local-db";
import type { electronTrpc } from "renderer/lib/electron-trpc";
import type { z } from "zod";

export interface CommandResult<
	TData extends Record<string, unknown> = Record<string, unknown>,
> {
	success: boolean;
	data?: TData;
	error?: string;
}

export interface BulkItemError {
	index: number;
	error: string;
	[key: string]: unknown;
}

export function buildBulkResult<T>({
	items,
	errors,
	itemKey,
	allFailedMessage,
	total,
}: {
	items: T[];
	errors: BulkItemError[];
	itemKey: string;
	allFailedMessage: string;
	total: number;
}): CommandResult<Record<string, unknown>> {
	const data: Record<string, unknown> = {
		[itemKey]: items,
		summary: { total, succeeded: items.length, failed: errors.length },
	};
	if (errors.length > 0) data.errors = errors;
	return {
		success: items.length > 0,
		data,
		error: items.length === 0 ? allFailedMessage : undefined,
	};
}

/**
 * (RECYCLE-BIN) Outcome of the remote `delete_workspace` tool's soft delete.
 * Discriminated so a refusal always carries a reason the agent can report back
 * — a silently-dropped delete would look like a success to the caller.
 */
export type SoftDeleteWorkspaceOutcome =
	| { ok: true }
	| { ok: false; reason: string };

// Available mutations and queries passed to tool handlers
export interface ToolContext {
	// Mutations
	createWorktree: ReturnType<typeof electronTrpc.workspaces.create.useMutation>;
	setActive: ReturnType<typeof electronTrpc.workspaces.setActive.useMutation>;
	/**
	 * (RECYCLE-BIN) Moves a workspace to the Recycle Bin — the SAME soft delete
	 * the sidebar's own Delete performs (deletedAt tombstone; worktree, branch
	 * and terminals untouched; Restore returns it). The remote tool deliberately
	 * has NO handle on the physical `workspaces.delete` mutation: permanent
	 * destroy is reachable only from inside the bin, and a remote agent must not
	 * be able to bypass that. Mains are refused (MASTER-ARCHIVE-ONLY).
	 */
	softDeleteWorkspace: (workspaceId: string) => SoftDeleteWorkspaceOutcome;
	updateWorkspace: ReturnType<
		typeof electronTrpc.workspaces.update.useMutation
	>;
	terminalCreateOrAttach: ReturnType<
		typeof electronTrpc.terminal.createOrAttach.useMutation
	>;
	terminalWrite: ReturnType<typeof electronTrpc.terminal.write.useMutation>;
	// Query helpers
	refetchWorkspaces: () => Promise<unknown>;
	getWorkspaces: () => SelectWorkspace[] | undefined;
	getProjects: () => SelectProject[] | undefined;
	getActiveWorkspaceId: () => string | null;
	getWorktreePathByWorkspaceId: (workspaceId: string) => string | undefined;
}

// Tool definition with schema and execute function
export interface ToolDefinition<
	T extends z.ZodType,
	TResult extends Record<string, unknown> = Record<string, unknown>,
> {
	name: string;
	schema: T;
	execute: (
		params: z.infer<T>,
		ctx: ToolContext,
	) => Promise<CommandResult<TResult>>;
}
