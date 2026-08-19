/**
 * (CLOUD-SEVERANCE-P2) What is left of auth after the account is gone.
 *
 * Upstream's router opened a browser at `api.superset.sh/api/auth/desktop/
 * connect`, took the token back through a deep link or a loopback callback,
 * stored it, and tore every host-service down on sign-out. None of that
 * survives: there is no account to sign into, and the procedures that WROTE
 * the token store are deleted rather than no-op'd, because the store still
 * feeds the host-service's env and anything able to write it could restart
 * the user's terminals underneath them.
 *
 * `getStoredToken` stays as a read-only relic: the pre-severance token file may
 * still exist on this machine, main reads it to break an organization tie, and
 * the renderer's hydration path still asks for it. It answers honestly and
 * changes nothing.
 */

import { getHostId, getHostName } from "@superset/shared/host-info";
import { publicProcedure, router } from "../..";
import { loadToken } from "./utils/auth-functions";

export const createAuthRouter = () => {
	return router({
		getStoredToken: publicProcedure.query(() => loadToken()),

		getDeviceInfo: publicProcedure.query(() => ({
			deviceId: getHostId(),
			deviceName: getHostName(),
		})),
	});
};

export type AuthRouter = ReturnType<typeof createAuthRouter>;
