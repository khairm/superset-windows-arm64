import { CLIError, string } from "@superset/cli-framework";
import { getHostId } from "@superset/shared/host-info";
import { command } from "../../../lib/command";
import { resolveHostTarget } from "../../../lib/host-target";
import { findWorkspaceOnHost } from "../../../lib/host-workspaces";

export default command({
	description: "Close (dispose) a terminal running in a workspace",
	options: {
		workspace: string().required().desc("Workspace ID"),
		host: string().desc("Host the workspace lives on (default: this machine)"),
		terminal: string().required().desc("Terminal ID to close"),
	},
	run: async ({ ctx, options }) => {
		const organizationId = ctx.config.organizationId;
		if (!organizationId) {
			throw new CLIError("No active organization", "Run: superset auth login");
		}

		const hostId = options.host ?? getHostId();
		const { workspace } = await findWorkspaceOnHost(
			{ organizationId, userJwt: ctx.bearer, hostId },
			options.workspace,
		);
		if (!workspace) {
			throw new CLIError(
				`Workspace not found on host ${hostId}: ${options.workspace}`,
				"Pass --host <id> if it lives on another machine",
			);
		}

		const target = resolveHostTarget({
			requestedHostId: hostId,
			organizationId,
			userJwt: ctx.bearer,
		});

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
