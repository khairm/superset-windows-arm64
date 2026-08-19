import { boolean, CLIError, string } from "@superset/cli-framework";
import { command } from "../../lib/command";

/**
 * (CLOUD-SEVERANCE-P2) `superset update` refuses.
 *
 * Upstream's implementation downloaded a CLI binary from the `cli-latest`
 * rolling release on github.com/superset-sh and moved it over this one. On
 * this fork that is not an update, it is a REPLACEMENT: upstream's binary is
 * x64, it knows nothing about the local identity this machine resolved for
 * itself, and — the part that actually matters — it carries a live cloud
 * client. A single `superset update` would quietly undo the entire severance
 * and leave a CLI that phones home sitting on the user's PATH under the same
 * name it had before.
 *
 * The whole download implementation is deleted rather than guarded, so the
 * upstream release URL is not in the shipped binary at all.
 *
 * The options are kept so the command still parses the flags a user or a
 * script might pass, and answers them with a clear refusal instead of an
 * unknown-flag error.
 */
export default command({
	description: "Not available: this fork's CLI ships with the desktop app",
	skipMiddleware: true,
	options: {
		check: boolean().desc("Only check for updates; don't install"),
		force: boolean().desc("Re-install even if already on that version"),
		version: string().desc("Install a specific CLI version"),
	},
	run: async () => {
		throw new CLIError(
			"This fork's CLI cannot update itself.",
			"It ships inside the Superset desktop app and is replaced when the app is.",
		);
	},
});
