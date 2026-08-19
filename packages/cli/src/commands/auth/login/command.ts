import { CLIError, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";

/**
 * (CLOUD-SEVERANCE-P2) `superset auth login` refuses.
 *
 * There is no account to log into. Upstream's implementation opened a browser
 * against the cloud's OAuth endpoint and wrote the resulting session into
 * `config.json`; on this fork that endpoint resolves a `.invalid` hostname, so
 * leaving the command in place would have produced a DNS failure or a hang
 * rather than an answer — and this is the command the CLI's own error text
 * used to recommend, so a user who hit any auth trouble would have been sent
 * straight here.
 *
 * The implementation is deleted rather than guarded so the OAuth endpoints are
 * not in the shipped binary.
 */
export default command({
	description: "Not available: this fork has no accounts",
	skipMiddleware: true,
	options: {
		organization: string().desc("Organization id or slug"),
	},
	run: async () => {
		throw new CLIError(
			"There is no account to sign in to.",
			"This build talks to no Superset server; it works against this machine only.",
		);
	},
});
