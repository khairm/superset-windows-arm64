import { TRPCError } from "@trpc/server";
import {
	installPlugin,
	setPluginEnabled,
	uninstallPlugin,
} from "main/lib/plugin-installs";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/**
 * Materialization only: skills, agent config, and the local install record are
 * written here, never read back for display. Install state is the account's —
 * the UI reads plugins.list — so it is the same on every machine.
 */
export const createPluginsRouter = () => {
	return router({
		install: publicProcedure
			.input(z.object({ name: z.string().min(1) }))
			.mutation(({ input }) => {
				const installed = installPlugin(input.name);
				if (installed === null) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: `Unknown plugin: ${input.name}`,
					});
				}
				return { installed };
			}),

		uninstall: publicProcedure
			.input(z.object({ name: z.string().min(1) }))
			.mutation(({ input }) => {
				return { installed: uninstallPlugin(input.name) };
			}),

		setEnabled: publicProcedure
			.input(z.object({ name: z.string().min(1), enabled: z.boolean() }))
			.mutation(({ input }) => {
				return { installed: setPluginEnabled(input.name, input.enabled) };
			}),
	});
};
