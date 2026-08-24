import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { accountSlugSchema } from "../../../claude-accounts/pi-client";
import { protectedProcedure, router } from "../../index";

const workspaceInput = z.object({ workspaceId: z.string().uuid() });

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
	setWorkspaceAccount: protectedProcedure
		.input(
			workspaceInput.extend({
				slug: accountSlugSchema.nullable(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				await ctx.claudeAccounts.setWorkspaceAccount(
					input.workspaceId,
					input.slug,
				);
				return { ok: true as const };
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						error instanceof Error
							? error.message
							: "Claude account change failed; workspace state is unchanged",
					cause: error,
				});
			}
		}),
});
