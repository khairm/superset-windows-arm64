import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure } from "../../../index";
import { assertPullRequestsEnabled } from "../shared/assert-enabled";
import { fetchPullRequestDiff } from "../shared/fetch-pull-request-diff";

export const getDiffByRepo = protectedProcedure
	.input(
		z.object({
			repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
			prNumber: z.number().int().positive(),
		}),
	)
	.query(async ({ ctx, input }) => {
		// (FORK-PRS-OFF)
		assertPullRequestsEnabled(ctx);
		try {
			return await fetchPullRequestDiff(input.repoFullName, input.prNumber);
		} catch (cause) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: `Failed to fetch diff for ${input.repoFullName}#${input.prNumber}: ${cause instanceof Error ? cause.message : String(cause)}`,
				cause,
			});
		}
	});
