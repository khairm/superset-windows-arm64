import os from "node:os";
import { getHostId, getHostName } from "@superset/shared/host-info";
import { TRPCError } from "@trpc/server";
import {
	getHostInstallSource,
	HOST_SERVICE_VERSION,
} from "../../../install-source";
import type { ApiAuthProvider } from "../../../providers/auth/types";
import { machineOnlyProcedure, protectedProcedure, router } from "../../index";

const MIN_API_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

async function readBearer(apiAuth: ApiAuthProvider): Promise<string | null> {
	const authorization = (await apiAuth.getHeaders()).Authorization;
	return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

/**
 * A host started by `superset start` hands back the stored OAuth access token
 * as-is, expired or not; it only refreshes after a 401.
 */
function outlivesCommand(token: string): boolean {
	try {
		const payload = JSON.parse(
			Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
		) as { exp?: unknown };
		if (typeof payload.exp !== "number") return true;
		return payload.exp * 1000 - Date.now() > MIN_API_TOKEN_LIFETIME_MS;
	} catch {
		return true;
	}
}

/**
 * (CLOUD-SEVERANCE-P2) The organization, locally.
 *
 * Upstream asked the cloud for the organization behind the JWT and threw
 * PRECONDITION_FAILED when it could not be resolved — one of the few cloud
 * reads in this service that was not already wrapped in a catch, so a severed
 * client would have turned `host.info` from "describes this machine" into a
 * hard error. The id is the only part anything downstream uses; the name and
 * slug are display text for a screen that no longer has a cloud organization
 * to describe.
 */
function getOrganization(organizationId: string): {
	id: string;
	name: string;
	slug: string;
} {
	return { id: organizationId, name: "Local", slug: "local" };
}

export const hostRouter = router({
	info: protectedProcedure.query(async ({ ctx }) => {
		const organization = getOrganization(ctx.organizationId);

		return {
			hostId: getHostId(),
			hostName: getHostName(),
			version: HOST_SERVICE_VERSION,
			installSource: getHostInstallSource(),
			organization,
			platform: os.platform(),
			arch: os.arch(),
			uptime: process.uptime(),
		};
	}),
	/**
	 * The API token of the account that runs this host, so the CLI in one of
	 * its terminals acts as that account instead of its own login. The relay
	 * adds the host secret too, so a teammate there would pass every other
	 * check and leave with the owner's credential.
	 */
	apiToken: machineOnlyProcedure.query(async ({ ctx }) => {
		if (ctx.isLocalCaller !== true || !ctx.apiAuth) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "The API token is only given to callers on this machine.",
			});
		}
		const apiAuth = ctx.apiAuth;
		let token = await readBearer(apiAuth);
		if (token && !outlivesCommand(token)) {
			apiAuth.invalidateCache();
			token = await readBearer(apiAuth);
		}
		if (!token || !outlivesCommand(token)) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "This host has no unexpired API token to give.",
			});
		}
		return { token };
	}),
});
