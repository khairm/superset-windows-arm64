// (AUTO-RESUME) Renderer <-> MAIN control surface for the auto-resume subsystem:
// the global toggle, the takeover-cancel signal from terminal panes, and the armed list
// for the per-terminal badge.
import { autoResumeManager } from "main/lib/auto-resume/manager/manager";
import { z } from "zod";
import { publicProcedure, router } from "../..";

export const createAutoResumeRouter = () => {
	return router({
		getEnabled: publicProcedure.query(
			() => autoResumeManager.getConfig().enabled,
		),

		setEnabled: publicProcedure
			.input(z.object({ enabled: z.boolean() }))
			.mutation(({ input }) => {
				autoResumeManager.setEnabled(input.enabled);
				return { success: true as const };
			}),

		// Trusted user interaction with a terminal = "I'm taking over" => cancel its
		// armed auto-resume so a reload/restart can't resurrect it.
		notifyActivity: publicProcedure
			.input(z.object({ terminalId: z.string() }))
			.mutation(({ input }) => {
				autoResumeManager.cancelForTerminal(input.terminalId);
				return { success: true as const };
			}),

		getArmed: publicProcedure.query(() => autoResumeManager.getArmedSummary()),
	});
};
