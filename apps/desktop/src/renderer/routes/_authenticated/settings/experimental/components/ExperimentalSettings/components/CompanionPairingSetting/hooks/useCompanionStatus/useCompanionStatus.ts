import { useQuery } from "@tanstack/react-query";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";

/**
 * (COMPANION-PAIRING-UI) The one read of `companion.status`, shared by every row
 * in the companion block.
 *
 * Local host only, and that is not a default — the QR advertises the private LAN
 * address of the machine running the bridge, and the panic switch acts on THAT
 * machine's device store. A relayed host would answer for a different desktop.
 *
 * One `queryKey` for every caller on purpose: two rows asking the same question
 * must never render two different answers, and react-query then does one fetch
 * and one invalidation for both (the same reason `MultiRepoMembersSection`
 * shares its probe's key).
 */
export function useCompanionStatus() {
	const { activeHostUrl } = useLocalHostService();

	const query = useQuery({
		queryKey: ["companion-status", activeHostUrl],
		enabled: activeHostUrl !== null,
		queryFn: () => {
			if (activeHostUrl === null) {
				throw new Error("no local host service URL");
			}
			return getHostServiceClientByUrl(activeHostUrl).companion.status.query();
		},
	});

	return { ...query, activeHostUrl };
}

/**
 * The row-level explanation shared by the pairing and panic rows.
 *
 * Off / enabled-but-failed-to-start / running are three different problems that
 * need three different actions from the user, so they get three different
 * sentences. `ready` is what the caller substitutes for the running case, since
 * that is the only one where the two rows have anything different to say.
 */
export function describeCompanionStatus(
	state: Pick<
		ReturnType<typeof useCompanionStatus>,
		"activeHostUrl" | "data" | "isPending" | "error"
	>,
	ready: string,
): string {
	if (state.activeHostUrl === null) {
		return "Waiting for the local host service to start.";
	}
	if (state.error) {
		return `Could not read the companion bridge status: ${
			state.error instanceof Error ? state.error.message : String(state.error)
		}`;
	}
	if (state.isPending || !state.data) {
		return "Checking whether the companion bridge is running…";
	}
	if (!state.data.enabled) {
		return "Set SUPERSET_COMPANION_BRIDGE=1 and restart the host service to enable it.";
	}
	if (!state.data.running) {
		return "The companion bridge is enabled but did not start. The host-service log carries the reason (search for [companion-bridge]).";
	}
	return ready;
}
