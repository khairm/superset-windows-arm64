import { z } from "zod";
import { protectedProcedure } from "../../../index";
import { assertPullRequestsEnabled } from "../shared/assert-enabled";
import { fetchPullRequestContent } from "../shared/fetch-pull-request-content";

export const getContentByRepo = protectedProcedure
	.input(
		z.object({
			repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
			prNumber: z.number().int().positive(),
		}),
	)
	.query(({ ctx, input }) => {
		// (FORK-PRS-OFF)
		assertPullRequestsEnabled(ctx);
		const [owner, name] = input.repoFullName.split("/");
		return fetchPullRequestContent(
			{ owner: owner ?? "", name: name ?? "" },
			input.prNumber,
		);
	});
