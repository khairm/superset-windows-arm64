import { CLIError } from "@superset/cli-framework";
import { command } from "../../lib/command";
import { requireLocalOrganizationId } from "../../lib/local-org";
import {
	isProcessAlive,
	readManifest,
	removeManifest,
} from "../../lib/host/manifest";

export default command({
	description: "Stop the host service daemon",
	run: async ({ ctx }) => {
		// (CLOUD-SEVERANCE-P2) The organization is this machine's, resolved from
		// disk — asking the cloud who we are is both impossible and pointless
		// when the answer only ever names a local directory.
		const organization = {
			id: requireLocalOrganizationId(ctx.config.organizationId),
			name: "this machine",
		};

		const manifest = readManifest(organization.id);
		if (!manifest) {
			return {
				data: { running: false },
				message: `No host service running for ${organization.name}`,
			};
		}

		if (isProcessAlive(manifest.pid)) {
			try {
				process.kill(manifest.pid, "SIGTERM");
			} catch (error) {
				throw new CLIError(
					`Failed to stop host service (pid ${manifest.pid}): ${
						error instanceof Error ? error.message : "unknown error"
					}`,
				);
			}

			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				if (!isProcessAlive(manifest.pid)) break;
				await new Promise((r) => setTimeout(r, 100));
			}

			if (isProcessAlive(manifest.pid)) {
				try {
					process.kill(manifest.pid, "SIGKILL");
				} catch {}
			}
		}

		removeManifest(organization.id);

		return {
			data: { pid: manifest.pid, organizationId: organization.id },
			message: `Stopped host service for ${organization.name}`,
		};
	},
});
