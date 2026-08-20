import type { WorkspaceState } from "@superset/panes";
import type {
	AgentLifecyclePayload,
	TerminalLifecyclePayload,
} from "@superset/workspace-client";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { getHostEventBus } from "renderer/lib/host-event-bus";
import { refreshHostServiceSecrets } from "renderer/lib/host-service-auth";
import { terminalRuntimeRegistry } from "renderer/lib/terminal/terminal-runtime-registry";
import type { PaneViewerData } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/types";
import { useNotificationBusStatusStore } from "renderer/stores/notification-bus";
import {
	collectTerminalPaneRefs,
	extractAlertContexts,
} from "../../lib/alertContexts";
import {
	forgetAlertContextSyncsForHost,
	queueAlertContextSync,
	registerWorkspaceHost,
	releaseAlertContextSync,
	unregisterWorkspaceHost,
} from "../../lib/companionAlertSync";
import {
	handleV2AgentLifecycleEvent,
	handleV2TerminalLifecycleEvent,
} from "../../lib/lifecycleEvents";
import { resyncAgentStatusFromHost } from "../../lib/resyncAgentStatus";
import { subscribeTerminalTitleListeners } from "../../lib/terminalTitleListeners";

export interface HostNotificationWorkspaceState {
	workspaceId: string;
	workspaceName: string;
	paneLayout: WorkspaceState<PaneViewerData> | null;
}

/**
 * (BUS-RESYNC) One delayed retry per open. The realistic transient is a host
 * that accepted the WS upgrade a beat before its tRPC surface was reachable; a
 * host that dies again produces a fresh close/open pair, which re-arms the
 * resync on its own.
 */
const RESYNC_RETRY_MS = 10_000;

/**
 * (MANUAL-DISMISS) How often an OPEN socket re-reconciles against the host
 * anyway.
 *
 * The reconnect-triggered resync repairs a bus that DIED. It cannot repair a
 * bus that stayed up while a single broadcast went missing, or a dot that this
 * renderer and the host disagree about for any other reason — a second window
 * dismissing a workspace's statuses is the case that motivated this: the host
 * knows, this renderer's socket saw nothing, and no reconnect is ever coming.
 * A minute is slow enough to be free (one small query per host) and fast
 * enough that a stale dot is a blip rather than a bug report.
 */
export const PERIODIC_RESYNC_MS = 60_000;

/**
 * (MANUAL-DISMISS) How long the in-flight gate may be held by ONE request.
 *
 * The gate is released by the request's own settle, so a host that accepts the
 * socket and then never answers the snapshot fetch holds it forever: no
 * periodic tick and no queued key can get out, and only a disconnect clears it
 * — which is exactly the event that is not coming from a host that is up but
 * unresponsive. Past this deadline the request is ABANDONED rather than
 * cancelled; its reply is already discarded by the generation guard, so the
 * only thing the deadline changes is that the next resync stops waiting for it.
 *
 * Comfortably longer than any healthy snapshot query, so a slow-but-alive host
 * is never double-requested, and well inside the periodic minute so a wedged
 * one costs at most one skipped tick.
 */
export const RESYNC_DEADLINE_MS = 30_000;

/**
 * (ALERT-CONTEXT-NAMES) Trailing delay on the title-change → sync trigger. A
 * terminal rewrites its title on every prompt redraw; this collapses a burst
 * into one pass over the host's workspaces.
 */
const TITLE_SYNC_DEBOUNCE_MS = 250;

/**
 * (MANUAL-DISMISS) The single-flight gate around `runResync`.
 *
 * ONE object rather than three bare refs, because the three are one state
 * machine and were previously spelled out four times: release-and-drain in the
 * settle AND in the deadline, abandon in the disconnect AND in the unmount.
 * Each copy was an independent chance to forget a `clearTimeout` or to drop the
 * queued key on the floor.
 *
 * OWNERSHIP IS THE POINT, and it is why the token is a number rather than a
 * boolean: a settle may only release the hold IT took. A reconnect abandons the
 * request on the wire so the new epoch can go out immediately, and the
 * abandoned request's own settle must not then open the gate under the request
 * that replaced it, nor drain a key that request will handle.
 *
 * This is NOT `resyncGenerationRef`, which stays where it is. That one decides
 * whose REPLY may be applied; this one decides who may be on the wire at all.
 */
interface ResyncGate {
	/** Whether a request currently holds the gate. */
	isHeld: () => boolean;
	/** Park a key behind the live request. Latest wins; only one is held. */
	queue: (workspaceSetKey: string) => void;
	/**
	 * Take the gate for `generation` and arm its deadline. Past the deadline the
	 * request is ABANDONED rather than cancelled — its reply is already discarded
	 * by the generation guard, so all the deadline changes is that the next
	 * resync stops waiting for a host that is up but never answering. `drain`
	 * runs whatever was parked behind it.
	 */
	begin: (generation: number, drain: (workspaceSetKey: string) => void) => void;
	/** Release `generation`'s hold and run whatever it was holding up. */
	settle: (
		generation: number,
		drain: (workspaceSetKey: string) => void,
	) => void;
	/** Socket down or unmounted: drop the hold, the queue and the deadline. */
	abandon: () => void;
}

function createResyncGate(): ResyncGate {
	let token: number | null = null;
	let queuedKey: string | null = null;
	let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

	function clearDeadline(): void {
		if (deadlineTimer === null) return;
		clearTimeout(deadlineTimer);
		deadlineTimer = null;
	}

	function release(
		generation: number,
		drain: (workspaceSetKey: string) => void,
	): void {
		if (token !== generation) return;
		clearDeadline();
		token = null;
		const queued = queuedKey;
		if (queued === null) return;
		queuedKey = null;
		drain(queued);
	}

	return {
		isHeld: () => token !== null,
		queue: (workspaceSetKey) => {
			queuedKey = workspaceSetKey;
		},
		begin: (generation, drain) => {
			clearDeadline();
			token = generation;
			deadlineTimer = setTimeout(() => {
				deadlineTimer = null;
				release(generation, drain);
			}, RESYNC_DEADLINE_MS);
		},
		settle: release,
		abandon: () => {
			clearDeadline();
			token = null;
			queuedKey = null;
		},
	};
}

export function HostNotificationSubscriber({
	hostUrl,
	workspaces,
}: {
	hostUrl: string;
	workspaces: HostNotificationWorkspaceState[];
}): null {
	const { data: volume = 100 } =
		electronTrpc.settings.getNotificationVolume.useQuery();
	const { data: muted = false } =
		electronTrpc.settings.getNotificationSoundsMuted.useQuery();
	const workspacesById = useMemo(
		() =>
			new Map(
				workspaces.map((workspace) => [workspace.workspaceId, workspace]),
			),
		[workspaces],
	);
	// Which workspace set a resync covered. A reconnect that lands before the
	// workspace rows hydrate can only reconcile what it knows, so a later
	// hydration must be allowed to complete the job. The HYDRATED ids are part of
	// the key, not just the id set: a workspace enters this list from its host row
	// with `paneLayout: null` and hydrates later without changing the id set, and
	// a replay evaluated against a null layout treats every terminal as not
	// visible — which can leave a green dot on the pane the user is looking at.
	/**
	 * (ALERT-CONTEXT-NAMES) The workspace ids this subscriber owns.
	 *
	 * Derived FIRST, and `workspacesKey` is built from it — the reverse of the
	 * earlier arrangement, which formatted the ids into a string and then parsed
	 * that string back out with `split("|")`. The array identity changes only
	 * when the SET does, so effects that care about membership can depend on it
	 * honestly, and the key remains the single string the resync epoch is keyed
	 * on.
	 */
	const workspaceIds = useMemo(
		() => [...workspacesById.keys()].sort(),
		[workspacesById],
	);
	const workspacesKey = useMemo(() => {
		const hydrated = workspaceIds.filter(
			(id) => workspacesById.get(id)?.paneLayout != null,
		);
		return `${workspaceIds.join(",")}|${hydrated.join(",")}`;
	}, [workspaceIds, workspacesById]);
	const connectedRef = useRef(false);
	const openEpochRef = useRef(0);
	// (BUS-RESYNC) Bumped by every resync this subscriber initiates. The epoch
	// alone is too coarse: hydration fires a SECOND request inside the SAME
	// epoch, and the first one can land after it with older truth — replaying
	// against the null pane layout it was issued under, which re-latches a
	// review-green on a pane the user is looking at. The per-row `>` fence
	// cannot reject that, because the stale reply carries the same
	// `lastEventAt` timestamps the fresh one does. Only the newest request may
	// apply.
	const resyncGenerationRef = useRef(0);
	const syncedKeyRef = useRef<string | null>(null);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// (MANUAL-DISMISS) Who is on the wire, what is queued behind them, and when
	// they stop being waited for. See `createResyncGate`.
	const resyncGateRef = useRef<ResyncGate | null>(null);
	resyncGateRef.current ??= createResyncGate();
	const resyncGate = resyncGateRef.current;
	const periodicTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	/** Stop the periodic reconciliation. Idempotent, so no caller has to check. */
	const stopPeriodicTimer = (): void => {
		if (periodicTimerRef.current === null) return;
		clearInterval(periodicTimerRef.current);
		periodicTimerRef.current = null;
	};

	const handleAgentLifecycle = useEffectEvent(
		(workspaceId: string, payload: AgentLifecyclePayload) => {
			const workspace = workspacesById.get(workspaceId);
			if (!workspace) return;
			handleV2AgentLifecycleEvent({
				workspaceId,
				workspaceName: workspace.workspaceName,
				payload,
				paneLayout: workspace.paneLayout,
				volume,
				muted,
			});
		},
	);

	const handleTerminalLifecycle = useEffectEvent(
		(workspaceId: string, payload: TerminalLifecyclePayload) => {
			const workspace = workspacesById.get(workspaceId);
			if (!workspace) return;
			handleV2TerminalLifecycleEvent({ payload });
		},
	);

	// (BUS-RESYNC) The seam. Every agent-lifecycle event the host broadcast
	// while this socket was down was destroyed — the bus keeps no queue — and a
	// blocked agent emits nothing further, so a lost red never returns on its
	// own. Reconcile against the host's durable truth whenever the socket opens,
	// and again if the workspace set grows while it is open.
	const runResync = useEffectEvent((workspaceSetKey: string) => {
		if (!connectedRef.current) return;
		// (MANUAL-DISMISS) SERIALIZATION LIVES HERE, not in the periodic tick.
		//
		// It used to live in `runPeriodicResync`, which only ever protected the
		// tick against itself. A workspace-key change is an edge and went straight
		// past it, so a hydrating workspace could start resync B on top of a live
		// resync A — and worse, A's `finally` then cleared the shared flag while B
		// was still on the wire, so the very next tick started C alongside B. The
		// gate belongs on the one function every caller goes through.
		//
		// Deferred, not dropped: a caller that arrives mid-flight is asking about a
		// workspace set the in-flight request was not issued for, so its answer
		// would be incomplete. The key is held and run on settle. Only the LATEST
		// is held — an intermediate set is a state the app has already left.
		if (resyncGate.isHeld()) {
			resyncGate.queue(workspaceSetKey);
			return;
		}
		const key = `${openEpochRef.current}:${workspaceSetKey}`;
		if (syncedKeyRef.current === key) return;
		syncedKeyRef.current = key;
		const epoch = openEpochRef.current;
		const generation = ++resyncGenerationRef.current;
		// The deadline is armed WITH the token and released the same way: only the
		// owner acts. A newer request has already replaced this timer by the time a
		// stale one fires, and the gate checks the token before touching anything,
		// so an abandoned request can neither free a live gate nor steal a key the
		// live request will drain.
		resyncGate.begin(generation, runResync);
		void resyncAgentStatusFromHost({
			hostUrl,
			workspaces: workspacesById,
			// A snapshot that lands after this socket closed (or after unmount)
			// describes a connection that no longer exists, and the epoch that
			// replaced it runs its own resync. Applying it would replay stale
			// history over whatever the new socket has already delivered. The
			// generation adds the same guarantee WITHIN an epoch: a later resync
			// (a workspace set that hydrated) supersedes this one outright.
			isCurrent: () =>
				connectedRef.current &&
				openEpochRef.current === epoch &&
				resyncGenerationRef.current === generation,
		})
			.then((result) => {
				if (result !== null) return;
				// Fetch failed: nothing was reconciled and nothing was cleared.
				// Re-arm so the retry below (or a later reconnect) tries again —
				// but only if no newer resync has since taken over, whose bookkeeping
				// this would otherwise clobber.
				if (resyncGenerationRef.current !== generation) return;
				syncedKeyRef.current = null;
				if (retryTimerRef.current) return;
				retryTimerRef.current = setTimeout(() => {
					retryTimerRef.current = null;
					runResync(workspaceSetKey);
				}, RESYNC_RETRY_MS);
			})
			.finally(() => {
				// Both settle paths, rejection included — a gate left held would
				// silently retire the periodic tick for the life of the socket.
				// `finally` re-throws whatever it was handed, so a rejection stays as
				// loud as it is today. The gate ignores a settle whose token it no
				// longer holds, and disarms the deadline on the way through.
				resyncGate.settle(generation, runResync);
			});
	});

	/**
	 * (MANUAL-DISMISS) One periodic reconciliation.
	 *
	 * `runResync` early-returns when the epoch+workspace key is the one it last
	 * synced, and on a quiet socket that key is unchanged by construction — the
	 * guard is there to stop hydration re-requesting, not to stop this. Clearing
	 * it is therefore the tick's job. An effect event so `workspacesKey` is read
	 * at FIRE time; the interval closure would otherwise hold the key from the
	 * render that created it.
	 *
	 * The in-flight check here is SUPPRESSION, and it is not the serialization —
	 * `runResync` owns that. A tick that arrived mid-flight has nothing to add:
	 * it carries the same key the live request was issued under, so queueing it
	 * would buy a duplicate pass a minute early. The next tick covers it.
	 *
	 * No generation mechanism of its own: `resyncGenerationRef` already discards
	 * a superseded reply.
	 */
	const runPeriodicResync = useEffectEvent(() => {
		if (!connectedRef.current || resyncGate.isHeld()) return;
		syncedKeyRef.current = null;
		runResync(workspacesKey);
	});

	/**
	 * (ALERT-CONTEXT-NAMES) What the last sync sent for each workspace, so an
	 * unchanged tick costs a pointer comparison instead of an extract and a hash.
	 * `revision` is bumped by a live title change, which moves without the layout
	 * object moving at all.
	 */
	const titleRevisionRef = useRef(0);
	const titleSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastSyncedLayoutRef = useRef(
		new Map<string, { layout: unknown; revision: number }>(),
	);

	/**
	 * (ALERT-CONTEXT-NAMES) Push every hydrated workspace's tab context to this
	 * host.
	 *
	 * ONE WORKSPACE PER CALL, deliberately: the host applies a snapshot as an
	 * atomic per-workspace replace, and a batched payload would either have to be
	 * all-or-nothing (one bad workspace costing every other its titles) or
	 * partially applied, which is the same as not being atomic.
	 *
	 * A workspace whose layout has not hydrated yet is SKIPPED rather than sent
	 * as empty — an empty snapshot EVICTS on the host, and cache-first rendering
	 * makes "no rows yet" the ordinary state for the first moments after mount
	 * rather than a statement that the workspace has no terminals.
	 *
	 * A workspace whose pane layout is the SAME OBJECT as last time is skipped
	 * before any work: the layout live-query hands back a new Map on every tick
	 * but the layouts inside it are unchanged references, so this turns most
	 * ticks into a pointer comparison per workspace instead of an extract and a
	 * hash. `titleRevision` bypasses that check, because a live title changes
	 * without the layout object changing at all.
	 */
	const syncAlertContexts = useEffectEvent(
		(current: Map<string, HostNotificationWorkspaceState>) => {
			for (const workspace of current.values()) {
				const layout = workspace.paneLayout;
				if (layout == null) continue;
				const seen = lastSyncedLayoutRef.current.get(workspace.workspaceId);
				if (
					seen?.layout === layout &&
					seen.revision === titleRevisionRef.current
				) {
					continue;
				}
				lastSyncedLayoutRef.current.set(workspace.workspaceId, {
					layout,
					revision: titleRevisionRef.current,
				});
				queueAlertContextSync({
					workspaceId: workspace.workspaceId,
					hostUrl,
					snapshot: extractAlertContexts({
						paneLayout: layout,
						// The PANE id is the runtime instance id. Passing the terminal id
						// alone resolves through `getPrimaryEntry`, which answers with
						// whichever instance happens to be first — or with an empty shadow
						// entry if one was ever minted.
						getTerminalTitle: (terminalId, paneId) =>
							terminalRuntimeRegistry.getTitle(terminalId, paneId),
					}),
				});
			}
		},
	);

	/**
	 * (ALERT-CONTEXT-NAMES) Coalesce a burst of title changes into ONE sync pass.
	 *
	 * A terminal rewrites its title on every prompt redraw, and each event would
	 * otherwise re-extract every workspace in this host. The trailing delay is
	 * the sender's own debounce, so a burst costs one pass rather than N — and
	 * nothing is lost by arriving a quarter-second later, since the sender
	 * debounces again before the mutation.
	 */
	const scheduleTitleSync = useEffectEvent(() => {
		if (titleSyncTimerRef.current !== null) return;
		titleSyncTimerRef.current = setTimeout(() => {
			titleSyncTimerRef.current = null;
			// A title moved, so the layout-identity shortcut must not suppress this.
			titleRevisionRef.current++;
			syncAlertContexts(workspacesById);
		}, TITLE_SYNC_DEBOUNCE_MS);
	});

	/** The CURRENT layouts, for effects keyed on something narrower. */
	const currentLayouts = useEffectEvent(() =>
		[...workspacesById.values()].map((workspace) => workspace.paneLayout),
	);

	const handleConnectionChange = useEffectEvent((connected: boolean) => {
		connectedRef.current = connected;
		// The offline pill reads THIS host's state from the store rather than
		// opening a bus of its own, so a relay socket that dies while the local
		// host stays up is still surfaced.
		useNotificationBusStatusStore
			.getState()
			.setNotificationBusConnected(hostUrl, connected);
		if (!connected) {
			// Nothing to reconcile against a socket that is down, and the reconnect
			// runs a resync of its own.
			stopPeriodicTimer();
			// (MANUAL-DISMISS) ABANDON whatever was on the wire rather than waiting
			// for it. Its epoch is dead — `isCurrent` will discard its reply — and
			// holding the gate for it would make the reconnect's resync, the one
			// that actually matters, wait out a dead socket's tRPC timeout. Its own
			// `finally` no longer owns the token, so it cannot release a gate the
			// new epoch has taken. The queued key goes with it: it was queued
			// against a workspace set the reconnect resync re-reads in full anyway.
			resyncGate.abandon();
			// A restarted host issues a new PSK; re-read it from the coordinator so
			// the next dial carries the current one instead of retrying a stale
			// secret until some unrelated render happens to refresh it.
			void refreshHostServiceSecrets();
			return;
		}
		openEpochRef.current++;
		// (ALERT-CONTEXT-NAMES) A reconnect means the host's tab-context registry
		// is not evidence about anything: it is process-local, so a host that
		// restarted has none. Forget what we believe it holds, so the sync below
		// re-sends in full rather than being suppressed by a hash the host no
		// longer has.
		forgetAlertContextSyncsForHost(hostUrl);
		syncAlertContexts(workspacesById);
		runResync(workspacesKey);
		// (MANUAL-DISMISS) Re-armed per open, and cleared first so a duplicate
		// "open" (the mount-time catch-up firing alongside a real edge) leaves one
		// interval rather than two.
		stopPeriodicTimer();
		periodicTimerRef.current = setInterval(() => {
			runPeriodicResync();
		}, PERIODIC_RESYNC_MS);
	});

	useEffect(() => {
		const bus = getHostEventBus(hostUrl);
		const removeAgentListener = bus.on(
			"agent:lifecycle",
			"*",
			handleAgentLifecycle,
		);
		const removeTerminalListener = bus.on(
			"terminal:lifecycle",
			"*",
			handleTerminalLifecycle,
		);
		// (BUS-RESYNC) Upstream replaced the boolean open/closed observer with a
		// four-state status; only the open/not-open edge matters here, so collapse
		// it back to the boolean the resync handler is written against.
		const removeConnectionListener = bus.subscribeConnectionStatus((status) => {
			handleConnectionChange(status.state === "open");
		});
		const release = bus.retain();
		// The socket is shared across all consumers of this host, so it may
		// already be open — in which case no "open" event is coming and this
		// mount would never reconcile.
		if (bus.getConnectionStatus().state === "open") {
			handleConnectionChange(true);
		} else {
			// Register the bus as down NOW rather than waiting for a close event
			// that already fired: a host that is unreachable at mount emits nothing
			// until its first successful open.
			useNotificationBusStatusStore
				.getState()
				.setNotificationBusConnected(hostUrl, false);
		}

		return () => {
			removeAgentListener();
			removeTerminalListener();
			removeConnectionListener();
			release();
			useNotificationBusStatusStore.getState().removeNotificationBus(hostUrl);
			if (retryTimerRef.current) {
				clearTimeout(retryTimerRef.current);
				retryTimerRef.current = null;
			}
			stopPeriodicTimer();
			connectedRef.current = false;
			syncedKeyRef.current = null;
			// Same reasoning as the disconnect branch: nothing may drain into a
			// component that is gone.
			resyncGate.abandon();
			if (titleSyncTimerRef.current) {
				clearTimeout(titleSyncTimerRef.current);
				titleSyncTimerRef.current = null;
			}
		};
	}, [hostUrl]);

	/**
	 * (ALERT-CONTEXT-NAMES) Publish which host owns each workspace, so the two
	 * user-intent seen sites can report a read chat without either of them having
	 * to know about hosts. This subscriber is the one place that holds the
	 * pairing, and it is already mounted one-per-host.
	 *
	 * KEYED ON THE MEMBERSHIP, NOT ON THE MAP. `workspacesById` is rebuilt on
	 * every layout live-query tick, so an identity-keyed effect re-ran several
	 * times a second — and its cleanup called `releaseAlertContextSync`, which
	 * throws away the "already sent" hash and any pending debounce. The sync
	 * therefore re-sent the whole snapshot on every tick and its debounce never
	 * elapsed. The unregister/release now runs on a genuine unmount or a genuine
	 * membership change, which is what "nothing is watching this workspace any
	 * more" actually means.
	 */
	useEffect(() => {
		for (const workspaceId of workspaceIds) {
			registerWorkspaceHost(workspaceId, hostUrl);
		}
		return () => {
			for (const workspaceId of workspaceIds) {
				unregisterWorkspaceHost(workspaceId, hostUrl);
				releaseAlertContextSync(workspaceId);
			}
		};
	}, [workspaceIds, hostUrl]);

	/**
	 * (ALERT-CONTEXT-NAMES) Re-sync tab context whenever the LAYOUTS move.
	 *
	 * KEYED ON `workspacesById`, WHICH CHANGES ON EVERY LAYOUT TICK — and that is
	 * the point rather than an oversight. Opening a second tab in a workspace
	 * that is already hydrated changes no membership and no id: only the layout
	 * moves. An earlier revision keyed this on the workspace SET to stop the
	 * churn, and silently killed the feature's primary case — `tabCount` stayed
	 * at 1, so the phone never named the tab, and a terminal opened after mount
	 * got no title listener either.
	 *
	 * Running it this often is cheap because nothing downstream does real work
	 * for an unchanged tick: the sync skips any workspace whose layout is the
	 * same OBJECT as last time, and the sender's hash guard catches whatever
	 * survives that.
	 */
	useEffect(() => {
		syncAlertContexts(workspacesById);
	}, [workspacesById]);

	/**
	 * (ALERT-CONTEXT-NAMES) Title listeners, reconciled only when the SET OF
	 * TERMINAL PANES changes.
	 *
	 * Keyed on a fingerprint of the `(terminalId, paneId)` pairs rather than on
	 * the layout map: subscribing is O(panes) and tears every listener down to
	 * rebuild an identical set, so doing it on every layout tick was pure churn
	 * — a pane RESIZE would re-subscribe every terminal in the host. The
	 * fingerprint changes exactly when a pane is opened, closed or moved between
	 * tabs, which is exactly when the listener set is actually different.
	 *
	 * The reconciliation itself lives in `subscribeTerminalTitleListeners`, which
	 * owns the `(terminalId, paneId)` rule and the wait-for-registration
	 * lifecycle, and is tested directly.
	 */
	const terminalPaneFingerprint = useMemo(() => {
		const refs: string[] = [];
		for (const workspace of workspacesById.values()) {
			if (workspace.paneLayout == null) continue;
			for (const ref of collectTerminalPaneRefs(workspace.paneLayout)) {
				refs.push(`${ref.terminalId}:${ref.paneId}`);
			}
		}
		return refs.sort().join(",");
	}, [workspacesById]);

	// The layouts are read through an effect event, so the fingerprint is the
	// only honest trigger: it changes exactly when the listener SET differs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run key, not a read value
	useEffect(() => {
		return subscribeTerminalTitleListeners({
			layouts: currentLayouts(),
			registry: terminalRuntimeRegistry,
			onTitleChange: scheduleTitleSync,
		});
	}, [terminalPaneFingerprint]);

	// A workspace set that hydrated (or grew) after the socket opened.
	useEffect(() => {
		runResync(workspacesKey);
	}, [workspacesKey]);

	return null;
}
