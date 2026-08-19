/**
 * (CLOUD-SEVERANCE-P2) The CLI's view of the frozen local organization.
 *
 * This MUST agree with the desktop app's resolver
 * (`apps/desktop/src/main/lib/local-identity/local-org.ts`) — the CLI finds a
 * running host-service by reading `~/.superset/host/<orgId>/manifest.json`, so
 * a different answer here means the CLI talks to a host that does not exist
 * while the app talks to the one that does.
 *
 * It is ONLY a reader. It does not scan, mint or write.
 *
 * An earlier version fell back to its own host-directory scan when the
 * decision file was missing, which quietly made it a second resolver — and one
 * that disagreed with the first, since the app breaks ties using the stored
 * membership and sorts by modification time while a scan here did neither. Two
 * answers to "which organization owns this machine" is the failure this whole
 * mechanism exists to prevent: the CLI would address a host-service the app is
 * not running. With no decision file, the honest answer is "ask the app to
 * decide", which is exactly what the commands that need it already say.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIError } from "@superset/cli-framework";
import { SUPERSET_HOME_DIR } from "./config";

/** Matches the desktop resolver exactly — see the note there on why no
 * version or variant constraint. A stricter rule on either side makes the two
 * disagree about which organization owns this machine. */
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveLocalOrganizationId(): string | undefined {
	const decisionFile = join(SUPERSET_HOME_DIR, "fork-local-org.json");
	if (!existsSync(decisionFile)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(decisionFile, "utf-8")) as {
			organizationId?: unknown;
		};
		if (
			typeof raw.organizationId === "string" &&
			UUID_PATTERN.test(raw.organizationId)
		) {
			return raw.organizationId;
		}
	} catch {
		// A corrupt decision file is the desktop app's problem to report — it
		// refuses to start on one, loudly and with instructions. The CLI just
		// says it has no organization, which routes the user to the same place.
	}
	return undefined;
}

/**
 * The organization id, or a loud error naming the one thing that fixes it.
 * Commands that address the local host all need this and all used to
 * hand-roll the same guard.
 */
export function requireLocalOrganizationId(configured?: string): string {
	const organizationId = resolveLocalOrganizationId() ?? configured;
	if (!organizationId) {
		throw new CLIError(
			"No local organization configured",
			"Open the Superset desktop app once so it can resolve one.",
		);
	}
	return organizationId;
}
