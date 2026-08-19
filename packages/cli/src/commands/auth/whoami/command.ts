import { command } from "../../../lib/command";
import { resolveLocalOrganizationId } from "../../../lib/local-org";

/**
 * (CLOUD-SEVERANCE-P2) `whoami` answers from this machine.
 *
 * It used to ask the cloud for the user and organization behind the stored
 * token. There is no such user, so the honest answer is the local identity —
 * and it stays a real answer rather than a refusal because scripts use this
 * command to discover the organization id they then pass to other commands.
 */
export default command({
	description: "Show the local identity this CLI operates as",
	skipMiddleware: true,
	run: async () => {
		const organizationId = resolveLocalOrganizationId();
		return {
			data: { local: true, organizationId: organizationId ?? null },
			message: organizationId
				? `Local machine (organization ${organizationId}) — no account, no cloud`
				: "Local machine — no organization resolved yet; open the Superset desktop app once",
		};
	},
});
