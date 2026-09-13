/**
 * (CLOUD-SEVERANCE-P2) The link that never opens a socket.
 *
 * This replaces the HTTP transport on both cloud tRPC clients. It is the ONE
 * choke point for the ~133 cloud call sites scattered across the renderer:
 * rather than deleting each one — which would put this fork in conflict with
 * upstream on ninety-odd files every single night — the calls stay where they
 * are and simply cannot reach anything.
 *
 * Two behaviours, and the split is deliberate:
 *
 * ANSWERED LOCALLY. Only what a kept surface genuinely needs. The host
 * registry is the whole of it: this machine is the only host that exists, so
 * the row is synthesised here rather than fetched. Identity matters more than
 * shape — `machineId` must be the same `getHostId()` value the coordinator and
 * the host-service use, or every host-keyed row in the sidebar would belong to
 * a host nothing can reach.
 *
 * REFUSED LOUDLY. Everything else rejects with the procedure named. Returning
 * empty data instead would be quieter and much worse: an upstream merge that
 * puts a new cloud call behind a surface we kept would look exactly like "no
 * data yet" forever, whereas a named rejection shows up in the console the
 * first time it happens. Rejection — never a synchronous throw — because
 * several host-service and renderer call sites are written as
 * `void client.x.mutate(...).catch(...)`, and a synchronous throw there
 * escapes before the catch is attached.
 */

import type { AppRouter } from "@superset/trpc";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { cloudSeveredError, LOCAL_USER } from "shared/local-identity";
import {
	getLocalHostName,
	getLocalMachineId,
	getLocalOrganizationId,
} from "./local-identity";

/**
 * The single host row. `isOnline` is true unconditionally: the local
 * host-service's real reachability is already tracked by the coordinator poll
 * that the sidebar reads, and claiming otherwise here would grey out a machine
 * the user is sitting in front of.
 */
function localHostRow() {
	return {
		machineId: getLocalMachineId(),
		name: getLocalHostName(),
		isOnline: true,
		organizationId: getLocalOrganizationId(),
	};
}

/**
 * The membership row for that host. Not optional: the device picker
 * intersects the host list against this and drops any host the current user
 * does not appear on, so an empty list would filter the only host out.
 */
function localHostMemberRow() {
	return {
		hostId: getLocalMachineId(),
		userId: LOCAL_USER.id,
		role: "owner",
		createdAt: new Date(0),
	};
}

const LOCAL_ANSWERS: Record<string, () => unknown> = {
	/**
	 * The host registry answers under BOTH names upstream currently serves.
	 * `host.roster` / `host.listMembers` are the canonical procedures as of
	 * upstream 1.29, which moved the `v2-host` router under `host` and left
	 * `v2Host.*` behind as a dated compatibility alias (see `root.ts`). Keying
	 * only on the old names is what a rename costs here: the path is the whole
	 * lookup, so an unanswered procedure is indistinguishable from a severed
	 * one and rejects — which emptied the known-host roster and, with it, the
	 * device picker that intersects against `listMembers`. Both names are
	 * answered rather than just the new pair because the alias is still live
	 * and still called; when upstream drops it the dead key costs one entry.
	 */
	"host.roster": () => [localHostRow()],
	"host.listMembers": () => [localHostMemberRow()],
	"v2Host.list": () => [localHostRow()],
	"v2Host.listMembers": () => [localHostMemberRow()],
	/**
	 * The paywall treats "no answer yet" as not-ready and every gated feature
	 * as locked, so a rejection here would quietly disable parts of an app the
	 * user already has. There is no subscription to sell and no service to
	 * charge it to: everything is unlocked.
	 */
	"billing.activePlan": () => ({ plan: "enterprise" }),
};

export const cloudSeveredLink: TRPCLink<AppRouter> =
	() =>
	({ op }) =>
		observable((observer) => {
			const answer = LOCAL_ANSWERS[op.path];
			if (answer) {
				observer.next({ result: { type: "data", data: answer() } });
				observer.complete();
				return;
			}
			observer.error(
				TRPCClientError.from(cloudSeveredError(`cloud.${op.path}`)),
			);
		});
