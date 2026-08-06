import type { AppRouter } from "@superset/host-service";
import type { AgentLifecyclePayload } from "@superset/workspace-client";
import type { inferRouterOutputs } from "@trpc/server";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import {
	getV2NotificationSourceKey,
	getV2TerminalNotificationSource,
	useV2NotificationStore,
} from "renderer/stores/v2-notifications";
import type { HostNotificationWorkspaceState } from "../components/HostNotificationSubscriber";
import { markV2AgentLifecycleTargetSeen } from "./lifecycleEvents";

/**
 * (BUS-RESYNC) Reconcile the agent-status dots against the host's durable
 * truth after the WS event bus (re)connects.
 *
 * The bus is fire-and-forget on both ends: `EventBus.broadcast` writes to the
 * sockets that happen to be connected and keeps no queue, and the client
 * replays only its `fs:watch` commands on open. So every agent-lifecycle event
 * emitted while the renderer was disconnected — a host-service restart, a
 * suspended machine, a socket that died quietly — is destroyed. Working and
 * permission states cannot self-heal from that: an agent blocked on a question
 * emits no further hook events, so its red dot never arrives and never will
 * (live incident: a bus dead for 7h43m after a host restart swallowed a pending
 * AskUserQuestion).
 *
 * This is the repair. It is status-only by construction — it routes through
 * `markV2AgentLifecycleTargetSeen`, the same store path the live listener uses
 * MINUS the chime and native-notification path, because replaying hours of
 * history must never ring.
 *
 * The snapshot is OLDER TRUTH than anything the (now open) bus delivers while
 * it is in flight, so every write below is fenced against live events: a row is
 * skipped when the store already holds a newer event for that terminal, and a
 * stale-clear only fires when the store entry is byte-for-byte the object that
 * was there before the request went out. A clear additionally requires that the
 * host POSITIVELY DISOWN the terminal (GHOST-TERMINAL) — "not in the live
 * bindings" is not the same claim as "not mine".
 */
interface ResyncResult {
	applied: number;
	pendingPermission: number;
	unknownPermission: number;
	cleared: number;
	seededSeen: number;
	/**
	 * (GHOST-TERMINAL) Terminals the host has no session row for at all. Their
	 * axes are left untouched — see the sweep.
	 */
	ghostsSkipped: number;
	skippedUnknownWorkspace: number;
	skippedAlreadySeen: number;
	skippedNewerLocal: number;
	/** The result arrived after its connection epoch ended; nothing was applied. */
	discarded: boolean;
}

type AgentStatusSnapshotRow =
	inferRouterOutputs<AppRouter>["notifications"]["agentStatusSnapshot"]["rows"][number];

function log(record: Record<string, unknown>): void {
	try {
		console.info(
			`[bus-resync] ${JSON.stringify({ ts: new Date().toISOString(), ...record })}`,
		);
	} catch {
		// never let logging break a reconcile
	}
}

/**
 * Every terminal id the store currently holds any dot state for — the exact
 * set the stale-clear sweep can ask about. Tens of entries in practice, so it
 * rides in the query input rather than being re-derived host-side.
 */
function collectCandidateTerminalIds(
	state: ReturnType<typeof useV2NotificationStore.getState>,
): string[] {
	const ids = new Set<string>();
	for (const entry of Object.values(state.sources)) {
		if (entry.source.type !== "terminal") continue;
		ids.add(entry.source.id);
	}
	for (const terminalId of Object.keys(state.backgroundRunningTerminals)) {
		ids.add(terminalId);
	}
	for (const terminalId of Object.keys(state.shellRunningTerminals)) {
		ids.add(terminalId);
	}
	return [...ids];
}

/**
 * (DOT-PERSIST) COLD START IS A PROPERTY OF THE RENDERER SESSION, DECIDED ONCE.
 *
 * The store and `terminalSeenAt` both live in sessionStorage, so "both empty"
 * identifies a real app start — but only for whichever resync runs FIRST.
 * Re-deriving it per resync from the live store answered "no" to every resync
 * after that one, and there are two ordinary ways to have more:
 *
 *  1. MULTI-HOST. One subscriber per host URL, each with its own resync. The
 *     first one to answer fills the store, so the slower host — a relay, which
 *     is exactly the slow one — saw a non-empty store and replayed its idle
 *     agents' turn-end events as unread review-green, on every app start.
 *  2. A ROW WHOSE LAST EVENT PRECEDES THIS SESSION. Whether its workspace was
 *     visible at launch or only became visible later (`workspacesKey` changing
 *     reruns the resync mid-session), a green that completed before this
 *     session existed is history the user has already lived past, not news.
 *
 * And one way that must NOT seed:
 *
 *  3. A COMPLETION THAT HAPPENED DURING THIS SESSION. A terminal (or a whole
 *     workspace) born mid-session during a bus outage finishes its work while
 *     the bus is dead; this resync is the only thing that can restore that
 *     green. Seeding it away is the bug the whole-store check was introduced
 *     to fix.
 *
 * The SESSION BOUNDARY separates 2 from 3, which look identical row-by-row (no
 * entry, no seen record): the row's own `lastEventAt` says which side of it the
 * event happened on. Two things make that comparison honest, and both were
 * wrong when the boundary was simply `Date.now()` at the first resync:
 *
 *  - WHEN the session began. The first resync runs only once the bus has
 *    connected, which on a cold start is well after the renderer process
 *    started. An agent that finished DURING that window is stamped before the
 *    boundary, classified as pre-session, and its genuine unread green is
 *    seeded away and cleared — no clock skew required. So the boundary is
 *    anchored to `moduleLoadMonotonicMs`, the renderer's own start.
 *  - WHOSE CLOCK it is in. `lastEventAt` carries the HOST's clock; a renderer
 *    `Date.now()` carries this machine's. Across a relay (or after a suspend
 *    that resumed with a corrected clock) the two disagree, and the skew moves
 *    the boundary in either direction — swallowing live greens or replaying
 *    dead ones. Elapsed time measured inside ONE process on a MONOTONIC clock
 *    is skew-free, so the boundary is translated into the answering host's
 *    clock domain on that host's first answering snapshot: `hostNow -
 *    elapsedMs`, where `elapsedMs` is a `performance.now()` difference. Two
 *    `Date.now()` readings would NOT be skew-free: a backwards wall-clock
 *    correction mid-session (an NTP step while the app runs) shrinks or negates
 *    the elapsed term, putting the boundary in the host's FUTURE, where genuine
 *    post-launch completions read as pre-session and their greens are seeded
 *    away. Kept PER HOST because each host stamps its own rows — one host's
 *    clock says nothing about another's, and the relay is exactly the skewed
 *    one.
 *
 * An older host that answers without `hostNow` — or a renderer with no
 * `performance.now` to measure elapsed time with — leaves its boundary unset,
 * and an unset boundary seeds NOTHING: a stale green is a dot the user
 * dismisses, a swallowed green is work they never learn finished.
 *
 * (An earlier proxy — "is this workspace being reconciled for the first time" —
 * misfired for a workspace BORN during a bus outage in a cold-started session:
 * its genuine minutes-old completion green was seeded away because its
 * workspace was new to the resync.)
 *
 * A renderer reload is deliberately not a cold start: sessionStorage survives
 * it, so the first resync after a reload sees a full store, the latch stays
 * false, and the dots the reload was supposed to preserve are preserved.
 */
let coldStartDecided = false;
let sessionBeganCold = false;
/**
 * When this renderer process began, on a MONOTONIC clock. Module evaluation is
 * the earliest moment this file can observe; it precedes the first bus connect
 * by however long startup takes, which is the whole point.
 *
 * `performance.now()` and not `Date.now()`: this anchor is only ever read as a
 * DURATION, and a wall-clock correction landing between the two readings would
 * corrupt that duration. `undefined` when the runtime has no monotonic clock,
 * which suppresses seeding rather than falling back to wall time.
 */
const moduleLoadMonotonicMs: number | undefined =
	typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: undefined;
/**
 * Per host URL: `moduleLoadMonotonicMs` expressed in THAT host's clock, latched
 * from its first answering snapshot. Meaningless unless `sessionBeganCold`; an
 * absent entry means "not translatable yet" and suppresses seeding entirely.
 */
const hostSessionBoundaries = new Map<string, number>();

/**
 * Fetch the host snapshot and reconcile every terminal source this host owns.
 * Returns null when the snapshot could not be fetched — the caller must treat
 * that as "truth unknown" and change nothing, since clearing dots on a failed
 * read would destroy exactly the state this exists to protect.
 *
 * `isCurrent` is the caller's epoch/mount guard: a snapshot that lands after
 * its socket closed (or after the subscriber unmounted) describes a connection
 * that no longer exists, and the epoch that replaced it runs its own resync.
 */
export async function resyncAgentStatusFromHost({
	hostUrl,
	workspaces,
	isCurrent,
}: {
	hostUrl: string;
	workspaces: Map<string, HostNotificationWorkspaceState>;
	isCurrent?: () => boolean;
}): Promise<ResyncResult | null> {
	// The fence. Zustand replaces an entry OBJECT on every write, so comparing
	// identity after the await proves whether a live event touched that terminal
	// while the snapshot was in flight. Only an untouched entry may be
	// stale-cleared — and a terminal created after the host copied its bindings
	// has no entry here at all, so it fails the same check instead of being
	// cleared as "absent".
	const before = useV2NotificationStore.getState();
	const beforeSources = before.sources;
	const beforeBackground = before.backgroundRunningTerminals;
	const beforeShell = before.shellRunningTerminals;

	// (DOT-PERSIST) Decide the session's cold start on the FIRST resync only —
	// see the latch above. Deciding it per row ("this terminal has no entry and
	// no seen record") also matched every terminal created DURING a bus outage —
	// precisely the terminals whose completed-agent green was swallowed and which
	// this resync exists to restore — and seeded their review away on the spot.
	if (!coldStartDecided) {
		coldStartDecided = true;
		sessionBeganCold =
			Object.keys(beforeSources).length === 0 &&
			Object.keys(before.terminalSeenAt).length === 0;
	}

	// (GHOST-TERMINAL) Tell the host which terminals we actually hold state for.
	// Without this it answers with every `terminal_sessions` row it has ever
	// minted — rows are deleted only when a workspace is destroyed — and ships
	// that unbounded list on every reconnect. The sweep only ever asks "is THIS
	// terminal known", so the intersection answers the same question at a
	// bounded size.
	const candidateTerminalIds = collectCandidateTerminalIds(before);

	let rows: AgentStatusSnapshotRow[];
	let knownTerminalIds: string[];
	let hostNow: number;
	try {
		({ rows, knownTerminalIds, hostNow } = await getHostServiceClientByUrl(
			hostUrl,
		).notifications.agentStatusSnapshot.query({ candidateTerminalIds }));
	} catch (error) {
		console.error("[bus-resync] snapshot fetch FAILED — dots not reconciled", {
			hostUrl,
			error,
		});
		return null;
	}

	// (DOT-PERSIST) Latch this renderer's start in THIS host's clock, from the
	// first snapshot it answers. The elapsed term is read HERE, after the round
	// trip, not at request time: a longer elapsed puts the boundary earlier, an
	// earlier boundary seeds fewer rows away, and showing a green the user has
	// already seen beats swallowing one they have not.
	//
	// `hostNow` is a required field, so a missing one means a host older than it
	// — a real possibility for a relay that upgrades on its own schedule. It
	// leaves the boundary unset, which disables seeding for that host entirely
	// rather than guessing with the renderer's own clock.
	if (sessionBeganCold && !hostSessionBoundaries.has(hostUrl)) {
		if (moduleLoadMonotonicMs === undefined) {
			console.warn(
				"[bus-resync] renderer has no monotonic clock (performance.now) — cold-start seeding disabled; stale greens may persist",
			);
		} else if (typeof hostNow === "number") {
			const elapsedMs = performance.now() - moduleLoadMonotonicMs;
			hostSessionBoundaries.set(hostUrl, hostNow - elapsedMs);
		} else {
			console.warn(
				`[bus-resync] host ${hostUrl} answered without hostNow — cold-start seeding disabled for it; stale greens may persist`,
			);
		}
	}
	const hostSessionBoundary = hostSessionBoundaries.get(hostUrl);

	const result: ResyncResult = {
		applied: 0,
		pendingPermission: 0,
		unknownPermission: 0,
		cleared: 0,
		seededSeen: 0,
		ghostsSkipped: 0,
		skippedUnknownWorkspace: 0,
		skippedAlreadySeen: 0,
		skippedNewerLocal: 0,
		discarded: false,
	};

	if (isCurrent && !isCurrent()) {
		result.discarded = true;
		log({ event: "resync_discarded", hostUrl, rows: rows.length });
		return result;
	}

	const liveTerminalIds = new Set<string>();

	for (const row of rows) {
		liveTerminalIds.add(row.terminalId);
		const workspace = workspaces.get(row.originWorkspaceId);
		if (!workspace) {
			result.skippedUnknownWorkspace++;
			continue;
		}

		const source = getV2TerminalNotificationSource(row.terminalId);
		const sourceKey = getV2NotificationSourceKey(source);
		const preState = useV2NotificationStore.getState();
		const preEntry = preState.sources[sourceKey];

		// A live event that landed while the snapshot was in flight — the user
		// answering the question this row still calls pending, or a fresh
		// PermissionRequest — is NEWER truth than the row. Replaying the row over
		// it would re-assert a red the user just cleared, or clear one that just
		// arrived. Both timestamps are the host's clock (`payload.occurredAt` on
		// the lifecycle path, `binding.lastEventAt` in the snapshot).
		if (preEntry !== undefined && preEntry.occurredAt > row.lastEventAt) {
			result.skippedNewerLocal++;
			continue;
		}

		const apply = (payload: AgentLifecyclePayload) => {
			markV2AgentLifecycleTargetSeen({
				workspaceId: row.originWorkspaceId,
				payload,
				paneLayout: workspace.paneLayout,
			});
		};

		apply({
			eventType: row.lastEventType,
			terminalId: row.terminalId,
			occurredAt: row.lastEventAt,
		});
		result.applied++;

		// (DOT-PERSIST) The dot store and `terminalSeenAt` both live in
		// sessionStorage, so a REAL app restart starts with both empty — and the
		// resting `lastEventType` of every idle agent tab is a turn-end. Replaying
		// those unchanged would paint review-green on every open agent tab at every
		// launch, for completions reviewed days ago, which is precisely the state
		// (DOT-PERSIST) promises a restart clears. On a cold start every such row is
		// therefore marked seen AT the replayed event: working and permission
		// still paint (they are re-derived below and from the marker), a stale
		// green does not.
		//
		// Seeded only for events from BEFORE this session began — the invariant
		// itself, not a proxy for it (see the doc block on the session boundary).
		// The boundary is this renderer's process start carried into the host's
		// clock, so "before" means before the app was launched, not before the
		// bus finished connecting: an agent that finished while the bus was still
		// coming up is news, as is one whose workspace was invisible at launch and
		// appeared later. An untranslatable boundary seeds nothing.
		// `preEntry`/`seenAt` keep this from stomping a row the store already
		// learned about from a live event.
		const seedColdStart =
			sessionBeganCold &&
			hostSessionBoundary !== undefined &&
			row.lastEventAt < hostSessionBoundary &&
			preEntry === undefined &&
			preState.terminalSeenAt[row.terminalId] === undefined;
		if (seedColdStart) {
			useV2NotificationStore
				.getState()
				.markTerminalSeen(row.terminalId, row.lastEventAt);
			result.seededSeen++;
		}

		const state = useV2NotificationStore.getState();
		const seenAt = state.terminalSeenAt[row.terminalId];
		if (
			seenAt !== undefined &&
			seenAt >= row.lastEventAt &&
			state.sources[sourceKey]?.status === "review"
		) {
			state.clearSourceAttention(source, row.originWorkspaceId);
			result.skippedAlreadySeen++;
		}

		if (row.pendingPermission === null) {
			// The host could not read the marker directory. Unknown is not "no
			// question": leave the permission axis exactly as it was, including
			// re-latching a red the replayed `lastEventType` just cleared.
			if (
				preEntry?.axes.permission !== undefined &&
				preEntry.workspaceId === row.originWorkspaceId
			) {
				useV2NotificationStore
					.getState()
					.applySourceAxes(
						source,
						row.originWorkspaceId,
						{ set: ["permission"], clear: [] },
						preEntry.axes.permission,
					);
			}
			result.unknownPermission++;
		} else if (row.pendingPermission) {
			apply({
				eventType: "PermissionRequest",
				terminalId: row.terminalId,
				occurredAt: row.lastEventAt,
			});
			result.pendingPermission++;
		}
	}

	// Terminals the host POSITIVELY DISOWNS — it has a session row for them but
	// no live binding — have lost every latched axis riding the same
	// fire-and-forget bus. Review is deliberately preserved (a finished turn
	// nobody has looked at is still unread), but permission/working and the
	// background-running blue have no other way back to false once their
	// clearing event was destroyed. Terminals the host has never heard of are a
	// different animal entirely and are skipped below.
	const store = useV2NotificationStore.getState();
	const knownIds = new Set(knownTerminalIds);
	// `knownTerminalIds` is the host's answer INTERSECTED with what we asked
	// about, so an id we never asked about is absent from it by construction, not
	// by the host's judgement. Terminals that entered the store while the
	// snapshot was in flight are exactly that case.
	const askedAboutIds = new Set(candidateTerminalIds);
	const ghostTerminalIds: string[] = [];
	const ownedTerminals = new Map<string, string>();
	for (const entry of Object.values(store.sources)) {
		if (entry.source.type !== "terminal") continue;
		ownedTerminals.set(entry.source.id, entry.workspaceId);
	}
	// Blue-axis-only terminals have no `sources` entry to iterate. Every
	// background-running entry is agent-driven by construction (only the
	// `BackgroundRunning` lifecycle event writes that map), so absence from an
	// agent snapshot is evidence about it.
	for (const [terminalId, entry] of Object.entries(
		store.backgroundRunningTerminals,
	)) {
		if (!ownedTerminals.has(terminalId)) {
			ownedTerminals.set(terminalId, entry.workspaceId);
		}
	}
	for (const [terminalId, workspaceId] of ownedTerminals) {
		if (liveTerminalIds.has(terminalId)) continue;
		if (!workspaces.has(workspaceId)) continue;
		// (GHOST-TERMINAL) Absent from the live bindings is only evidence when the
		// host knows the terminal at all. A pane can hold a re-minted terminalId
		// with no `terminal_sessions` row — every hook POST for it comes back
		// `ignored: true`, and its dot is painted locally by the desktop's
		// Electron fallback. Clearing on "absent" would destroy exactly that dot,
		// on every reconnect, for a terminal that is genuinely working. Only a
		// terminal the host POSITIVELY DISOWNS (known, not live) may be swept.
		if (!knownIds.has(terminalId)) {
			// Only an id we actually SENT can be called a ghost. A terminal that
			// entered the store during the round trip was never in
			// `candidateTerminalIds`, so the host was never asked about it and its
			// absence from the intersected answer means nothing — reporting it as
			// GHOST-TERMINAL sent readers hunting a broken binding that does not
			// exist. It is skipped either way; the identity fence already keeps it
			// from being swept.
			if (askedAboutIds.has(terminalId)) ghostTerminalIds.push(terminalId);
			continue;
		}
		const source = getV2TerminalNotificationSource(terminalId);
		const sourceKey = getV2NotificationSourceKey(source);
		const entry = store.sources[sourceKey];
		let touched = false;

		if (
			entry !== undefined &&
			entry === beforeSources[sourceKey] &&
			(entry.axes.permission !== undefined || entry.axes.working !== undefined)
		) {
			store.applySourceAxes(entry.source, entry.workspaceId, {
				set: [],
				clear: ["permission", "working"],
			});
			touched = true;
		}

		const background = store.backgroundRunningTerminals[terminalId];
		if (
			background !== undefined &&
			background === beforeBackground[terminalId]
		) {
			store.clearTerminalBackgroundRunning(terminalId);
			touched = true;
		}

		// (AGENT-SHELL-BLUE) The OSC-133 latch is only clearable here for a
		// terminal the durable registry says ran an agent: a PLAIN shell has no
		// agent binding to begin with, so it is absent from every snapshot and
		// clearing it would extinguish a live `npm run dev` blue on every
		// reconnect. The snapshot carries no command state, so that half stays
		// unprovable and untouched.
		const shell = store.shellRunningTerminals[terminalId];
		if (
			shell !== undefined &&
			shell === beforeShell[terminalId] &&
			store.agentTerminals[terminalId]
		) {
			store.clearTerminalShellRunning(terminalId);
			touched = true;
		}

		if (touched) result.cleared++;
	}

	result.ghostsSkipped = ghostTerminalIds.length;
	if (ghostTerminalIds.length > 0) {
		// Loud on purpose: a pane holding a terminalId the host never minted is a
		// broken binding, not a dot problem, and it is invisible from the UI —
		// every hook POST for it silently returns `ignored: true`.
		console.warn(
			`[bus-resync] (GHOST-TERMINAL) ${ghostTerminalIds.length} terminal(s) unknown to host ${hostUrl} — axes left untouched: ${ghostTerminalIds.join(", ")}`,
		);
	}

	log({ event: "resync_complete", hostUrl, rows: rows.length, ...result });
	return result;
}
