import { TRPCError } from "@trpc/server";
import type { HostServiceContext } from "../../../../types";

// (FORK-PRS-OFF)
export function assertPullRequestsEnabled(
	ctx: Pick<HostServiceContext, "runtime">,
): void {
	if (ctx.runtime.pullRequests.disabled) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Pull requests are disabled",
		});
	}
}
