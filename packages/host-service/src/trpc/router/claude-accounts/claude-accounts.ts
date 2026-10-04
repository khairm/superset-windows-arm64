import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { accountSlugSchema } from "../../../claude-accounts/pi-client";
import type { ClaudeScheduleTarget } from "../../../claude-accounts/types";
import { protectedProcedure, router } from "../../index";

const workspaceInput = z.object({ workspaceId: z.string().uuid() });

// (CLAUDE-ACCOUNT-SCHEDULE)
const scheduleTarget = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("account"), slug: accountSlugSchema }),
	z.object({ kind: z.literal("default") }),
]) satisfies z.ZodType<ClaudeScheduleTarget>;

async function asPreconditionFailed<T>(
	run: () => Promise<T>,
	fallbackMessage: string,
): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof TRPCError) throw error;
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: error instanceof Error ? error.message : fallbackMessage,
			cause: error,
		});
	}
}

export const claudeAccountsRouter = router({
	capability: protectedProcedure.query(({ ctx }) =>
		ctx.claudeAccounts.getCapability(),
	),
	roster: protectedProcedure.query(({ ctx }) => ctx.claudeAccounts.getRoster()),
	getWorkspaceState: protectedProcedure
		.input(workspaceInput)
		.query(({ ctx, input }) =>
			ctx.claudeAccounts.getWorkspaceState(input.workspaceId),
		),
	getWorkspaceStates: protectedProcedure.query(({ ctx }) =>
		ctx.claudeAccounts.getWorkspaceStates(),
	),
	pinWorkspaceToMachineDefault: protectedProcedure
		.input(workspaceInput.extend({ onlyIfFollowing: z.boolean().optional() }))
		.mutation(({ ctx, input }) =>
			ctx.claudeAccounts.pinWorkspaceToMachineDefault(input.workspaceId, {
				onlyIfFollowing: input.onlyIfFollowing,
			}),
		),
	setWorkspaceAccount: protectedProcedure
		.input(
			workspaceInput.extend({
				slug: accountSlugSchema.nullable(),
			}),
		)
		.mutation(({ ctx, input }) =>
			asPreconditionFailed(async () => {
				await ctx.claudeAccounts.setWorkspaceAccount(
					input.workspaceId,
					input.slug,
				);
				return { ok: true as const };
			}, "Claude account change failed; workspace state is unchanged"),
		),
	setAutoSwitch: protectedProcedure
		.input(workspaceInput.extend({ enabled: z.boolean() }))
		.mutation(({ ctx, input }) =>
			asPreconditionFailed(async () => {
				await ctx.claudeAccounts.setAutoSwitch(
					input.workspaceId,
					input.enabled,
				);
				return { ok: true as const };
			}, "Auto-switch change failed; workspace state is unchanged"),
		),
	scheduleSwitch: protectedProcedure
		.input(
			workspaceInput.extend({
				target: scheduleTarget,
				fireAt: z.number().int().positive(),
			}),
		)
		.mutation(({ ctx, input }) =>
			asPreconditionFailed(
				() =>
					ctx.claudeAccounts.scheduleSwitch(
						input.workspaceId,
						input.target,
						input.fireAt,
					),
				"Scheduling the Claude account switch failed",
			),
		),
	clearScheduledSwitch: protectedProcedure
		.input(workspaceInput.extend({ scheduleId: z.string().uuid() }))
		.mutation(({ ctx, input }) =>
			asPreconditionFailed(async () => {
				await ctx.claudeAccounts.clearScheduledSwitch(
					input.workspaceId,
					input.scheduleId,
				);
				return { ok: true as const };
			}, "Cancelling the scheduled Claude account switch failed"),
		),
	/**
	 * (WORKTREE-EXIT-CLEANUP) System-only teardown for a workspace the user has
	 * exited. The renderer sends it to every connected host, so a host that does
	 * not own the workspace answers `foundWorkspace: false` rather than failing.
	 */
	retireWorkspaceRuntime: protectedProcedure
		.input(workspaceInput)
		.mutation(({ ctx, input }) =>
			ctx.claudeAccounts.retireWorkspaceRuntime(input.workspaceId),
		),
});
