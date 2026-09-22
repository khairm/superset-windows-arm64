import { boolean, CLIError, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { resolveWorkspaceTarget } from "../../../lib/host-workspaces";

export default command({
	description: "Close (dispose) a terminal running in a workspace",
	options: {
		workspace: string().required().desc("Workspace ID"),
		host: string().desc(
			"Host the workspace lives on (default: the cloud if your account has cloud workspaces, else this machine)",
		),
		local: boolean().desc("The workspace is on this machine"),
		terminal: string().required().desc("Terminal ID to close"),
	},
	run: async ({ ctx, options }) => {
		const organizationId = ctx.config.organizationId;
		if (!organizationId) {
			throw new CLIError("No active organization", "Run: superset auth login");
		}

		const { target } = await resolveWorkspaceTarget(
			{
				organizationId,
				userJwt: ctx.bearer,
				api: ctx.api,
				host: options.host ?? undefined,
				local: options.local ?? undefined,
			},
			options.workspace,
		);

		const result = await target.client.terminal.killSession.mutate({
			terminalId: options.terminal,
			workspaceId: options.workspace,
		});

		// (DISPOSE-LIMBO) The host reports `dispose-pending` when the daemon
		// never confirmed the close: the PTY may still be running and the reaper
		// will retry. Printing "Closed terminal" for that would be a lie — and
		// so is exiting 0, which is the only thing a script reads. A caller that
		// closes a terminal and then acts on the assumption it is gone has to
		// fail here, not proceed.
		if (result.status !== "disposed") {
			throw new CLIError(
				`Terminal ${options.terminal} did NOT close (${result.status}): ${
					"reason" in result ? result.reason : "unknown"
				}`,
				"The host will keep retrying. Re-check with: superset terminals list",
			);
		}

		return {
			data: result,
			message: `Closed terminal ${options.terminal}`,
		};
	},
});
