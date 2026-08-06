import { and, eq } from "drizzle-orm";
import type { HostDb } from "../../db/index.ts";
import { terminalSessions } from "../../db/schema.ts";
import type { EventBus } from "../../events/event-bus.ts";
import { portManager } from "../../ports/port-manager.ts";
import { getDaemonClient } from "../daemon-client-singleton.ts";
import { disposeSessionAndWait, isLiveTerminalSession } from "../terminal.ts";

interface ReapResult {
	reaped: number;
	failed: number;
	/** (BRIDGE-LIVENESS) Rows corrected from `active` to `disposed`. */
	corrected: number;
}

export const REAP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * A host-service restart begins with an empty port scanner while the detached
 * pty-daemon keeps dev servers alive. The reap pass re-registers those sessions,
 * but it runs only once immediately and then every {@link REAP_INTERVAL_MS} — and
 * the just-adopted daemon may not yet list its sessions the instant that first
 * pass runs. Re-sync the port scanner a few times over the first ~90s so restored
 * dev-server ports appear promptly, instead of waiting for the next reap tick or
 * a renderer attach. All offsets stay below REAP_INTERVAL_MS so the warm-up fully
 * covers the gap before the first scheduled reap.
 */
export const PORT_SCAN_WARMUP_DELAYS_MS = [
	2_000, 5_000, 10_000, 20_000, 45_000, 90_000,
];

interface TerminalRow {
	status: string;
	originWorkspaceId: string | null;
	disposeRequestedAt?: number | null;
	createdAt?: number;
	lastAttachedAt?: number | null;
}

/**
 * Rows the reaper must kill even though the daemon still lists them alive.
 * `disposeRequestedAt` is the durable intent-to-kill stamp: a dispose was
 * requested but never confirmed (success deletes the row or marks it
 * disposed), so retry it regardless of workspace liveness.
 */
export function shouldReapRow(row: TerminalRow): boolean {
	return (
		row.status === "disposed" ||
		row.status === "exited" ||
		!row.originWorkspaceId ||
		row.disposeRequestedAt != null
	);
}

export interface PortScanSyncPlan {
	register: { terminalId: string; workspaceId: string; pid: number }[];
	unregister: string[];
}

/**
 * Decide which terminals the port scanner should start and stop watching,
 * given the daemon's live sessions and this host's session rows. Pure so the
 * policy is unit testable without a daemon, database, or port manager.
 *
 * Register every alive daemon session that maps to an active workspace row and
 * isn't already owned by a live in-memory session. This is what makes a
 * workspace's dev-server ports appear before any renderer attaches to the
 * terminal — e.g. sessions the daemon kept alive across a host-service restart.
 * v1 desktop did this in its startup reconcile; v2 previously only registered
 * terminals a renderer had explicitly opened, so ports were detected less
 * completely.
 *
 * Unregister every currently-watched terminal the daemon no longer reports and
 * that no live in-memory session owns. Sessions adopted here never get the
 * daemon exit subscription that normally unregisters them, so without this they
 * would be scanned forever after the process exits. The `isLive` guard keeps a
 * renderer-attached session from being dropped if it's momentarily absent from
 * a racy `daemon.list()`.
 */
export function planPortScanSync({
	liveSessions,
	rowById,
	registeredTerminalIds,
	isLive,
}: {
	liveSessions: { id: string; pid: number }[];
	rowById: Map<string, TerminalRow>;
	registeredTerminalIds: string[];
	isLive: (terminalId: string) => boolean;
}): PortScanSyncPlan {
	const aliveIds = new Set(liveSessions.map((session) => session.id));

	const register: PortScanSyncPlan["register"] = [];
	for (const session of liveSessions) {
		if (isLive(session.id)) continue;
		const row = rowById.get(session.id);
		if (!row?.originWorkspaceId) continue;
		if (row.status !== "active") continue;
		register.push({
			terminalId: session.id,
			workspaceId: row.originWorkspaceId,
			pid: session.pid,
		});
	}

	const unregister: string[] = [];
	for (const terminalId of registeredTerminalIds) {
		if (aliveIds.has(terminalId)) continue;
		if (isLive(terminalId)) continue;
		unregister.push(terminalId);
	}

	return { register, unregister };
}

function loadTerminalRowsById(db: HostDb): Map<string, TerminalRow> {
	const rows = db
		.select({
			id: terminalSessions.id,
			status: terminalSessions.status,
			originWorkspaceId: terminalSessions.originWorkspaceId,
			disposeRequestedAt: terminalSessions.disposeRequestedAt,
			createdAt: terminalSessions.createdAt,
			lastAttachedAt: terminalSessions.lastAttachedAt,
		})
		.from(terminalSessions)
		.all();
	return new Map(rows.map((row) => [row.id, row]));
}

/**
 * (BRIDGE-LIVENESS) How recently a row must have been touched to be spared the
 * reverse walk regardless of the daemon's listing. Covers a session created
 * between the listing and this pass.
 */
export const STALE_ROW_MIN_AGE_MS = 60_000;

/**
 * (REAPER-CORRECTION-CAP) The most rows one pass may correct, whatever the
 * daemon said.
 *
 * The two-pass rule assumes the two listings are INDEPENDENT observations, and
 * they are not: a daemon that is degraded — mid-restart, partially adopted,
 * answering from a half-built registry — is degraded for minutes, which is
 * longer than the five minutes between passes. Both listings can therefore be
 * the same wrong listing, and the corrective write is the one direction with no
 * undo: a corrected row loses its place in the session dropdown and in pane
 * adoption, and nothing puts it back.
 *
 * A cap does not make that impossible, it makes it SURVIVABLE. The real backlog
 * this walk exists for was 403 rows, so a bound of a few per pass still drains
 * it inside a few hours, while a pathological pair of listings can only cost a
 * handful of live terminals before somebody notices — and the next pass, with a
 * healthy daemon, corrects nothing at all.
 */
export const STALE_ROW_MAX_CORRECTIONS_PER_PASS = 10;

/** The other half of the cap: never more than this share of the active rows. */
export const STALE_ROW_MAX_CORRECTION_FRACTION = 0.25;

/**
 * (REAPER-CORRECTION-CAP) `min(10, ceil(25% of active rows))`.
 *
 * The fraction is what protects a SMALL table, where 10 rows could be all of
 * them: correcting a quarter of a machine's live terminals in one pass is a
 * visible event with a visible cause, correcting all of them looks like the app
 * losing every session. `ceil` rather than `floor` because a floor would round
 * every table under four rows down to zero and turn the reverse walk off
 * entirely on exactly the machines where one corpse is most conspicuous.
 */
export function staleRowCorrectionCap(activeRowCount: number): number {
	return Math.min(
		STALE_ROW_MAX_CORRECTIONS_PER_PASS,
		Math.ceil(activeRowCount * STALE_ROW_MAX_CORRECTION_FRACTION),
	);
}

/**
 * (BRIDGE-LIVENESS) THE REVERSE WALK: rows whose pty is gone.
 *
 * `terminal_sessions.status` leaves `active` only via an explicit dispose or a
 * live in-process `onExit`. A host-service crash, a force-quit or a machine
 * reboot leaves the row `active` forever, and the reap pass only ever walked
 * daemon -> row, so nothing corrected it. Measured: 403 such rows, spanning 77
 * days, of which 3 had been attached in the last 24 h. They are why the phone
 * badged eight permanently-blocked agents that had not existed for weeks.
 *
 * PURE, because the conditions under which it is safe to write are the whole
 * point and they must be testable without a daemon:
 *
 *  1. The daemon listed SOMETHING ON BOTH PASSES. An empty listing is the
 *     documented racy-adoption case (`PORT_SCAN_WARMUP_DELAYS_MS`) and is never
 *     evidence — and "never evidence" has to include the OLDER of the two
 *     observations, not just this one. Passing the previous pass's emptiness in
 *     explicitly is what makes that a stated condition rather than a property
 *     that happens to fall out of the caller clearing its set.
 *  2. The row is `active` and workspace-owned. Anything else is already the
 *     forward walk's business.
 *  3. The daemon does not list it AND this process holds no live session for
 *     it. Either alone is insufficient — an adopted session is absent from
 *     memory by design.
 *  4. It was absent on the PREVIOUS pass too. Five minutes apart, so a single
 *     partially-populated `daemon.list()` cannot condemn a live terminal.
 *  5. It is older than `STALE_ROW_MIN_AGE_MS`, so a session created seconds ago
 *     cannot lose a race with the listing that was taken before it existed.
 *  6. (REAPER-CORRECTION-CAP) It is within the first `staleRowCorrectionCap()`
 *     candidates, OLDEST FIRST. Everything over the cap stays in
 *     `absentThisPass`, so it keeps its confirmed two-pass standing and is
 *     corrected on a later pass instead of restarting its clock.
 *
 * Being wrong here costs a LIVE terminal its place in the session dropdown and
 * in pane adoption (`listWorkspaceTerminalSessions` filters on `status`), which
 * is why the bar is six independent conditions and not one.
 */
export function planStaleRowCorrection({
	aliveIds,
	rowById,
	absentOnPreviousPass,
	previousPassListedTerminals,
	isLive,
	nowMs,
}: {
	aliveIds: ReadonlySet<string>;
	rowById: Map<string, TerminalRow>;
	absentOnPreviousPass: ReadonlySet<string>;
	/**
	 * Did the pass that produced `absentOnPreviousPass` see a non-empty daemon
	 * listing? Required, because "an empty listing is never evidence" is a claim
	 * about BOTH observations the two-pass rule rests on, and an
	 * absent-on-previous-pass set says nothing about how it was produced.
	 */
	previousPassListedTerminals: boolean;
	isLive: (terminalId: string) => boolean;
	nowMs: number;
}): {
	correct: string[];
	absentThisPass: Set<string>;
	/** Feed back as the next pass's `previousPassListedTerminals`. */
	listedThisPass: boolean;
} {
	const correct: string[] = [];
	const absentThisPass = new Set<string>();
	if (aliveIds.size === 0) {
		return { correct, absentThisPass, listedThisPass: false };
	}

	let activeRows = 0;
	const candidates: { id: string; touchedAt: number }[] = [];
	for (const [id, row] of rowById) {
		if (row.status !== "active") continue;
		activeRows += 1;
		if (!row.originWorkspaceId) continue;
		if (aliveIds.has(id)) continue;
		if (isLive(id)) continue;
		const touchedAt = Math.max(row.createdAt ?? 0, row.lastAttachedAt ?? 0);
		if (touchedAt > 0 && nowMs - touchedAt < STALE_ROW_MIN_AGE_MS) continue;
		if (!previousPassListedTerminals || !absentOnPreviousPass.has(id)) {
			absentThisPass.add(id);
			continue;
		}
		candidates.push({ id, touchedAt });
	}

	// Oldest first, so a capped pass spends its budget on the rows least likely
	// to be a live terminal the daemon merely failed to report, and so the choice
	// of WHICH rows to correct is deterministic rather than map-iteration order.
	candidates.sort((a, b) => a.touchedAt - b.touchedAt);
	const cap = staleRowCorrectionCap(activeRows);
	for (const candidate of candidates) {
		if (correct.length >= cap) {
			// Held, not dropped: it has already been confirmed absent twice, and
			// re-arming it as absent-this-pass keeps that standing for the next pass
			// rather than restarting its two-pass clock.
			absentThisPass.add(candidate.id);
			continue;
		}
		correct.push(candidate.id);
	}
	return { correct, absentThisPass, listedThisPass: true };
}

// Port scanning is best-effort: a port-manager error must not propagate to the
// caller — the reap pass (whose orphan cleanup must still run) or a warm-up sync.
function applyPortScanSync(
	liveSessions: { id: string; pid: number }[],
	rowById: Map<string, TerminalRow>,
): void {
	try {
		const plan = planPortScanSync({
			liveSessions,
			rowById,
			registeredTerminalIds: portManager.getRegisteredTerminalIds(),
			isLive: isLiveTerminalSession,
		});
		for (const entry of plan.register) {
			portManager.upsertSession(entry.terminalId, entry.workspaceId, entry.pid);
		}
		if (plan.register.length > 0) {
			console.log(
				`[host-service] port-scan sync: registered ${plan.register.length} unattached daemon session(s) for scanning`,
			);
		}
		for (const terminalId of plan.unregister) {
			portManager.unregisterSession(terminalId);
		}
	} catch (err) {
		console.warn("[host-service] port-scan sync failed:", err);
	}
}

async function runPortScanSync(db: HostDb) {
	const daemon = await getDaemonClient();
	const liveSessions = (await daemon.list()).filter((session) => session.alive);
	const rowById =
		liveSessions.length > 0
			? loadTerminalRowsById(db)
			: new Map<string, TerminalRow>();
	applyPortScanSync(liveSessions, rowById);
	return { liveSessions, rowById };
}

let inFlightPortScanSync: ReturnType<typeof runPortScanSync> | null = null;

/**
 * Re-register the port scanner against the daemon's live sessions. Extracted so
 * it can run on its own cadence — decoupled from the 5-minute orphan reap —
 * because restored dev-server ports must appear promptly after a host-service
 * restart. Returns the daemon's live sessions so the reap pass can reuse them
 * without a second `daemon.list()`.
 *
 * Coalesces concurrent callers onto one in-flight run: the warm-up timers and
 * the reap pass both call this, and a slow `daemon.list()` right after adoption
 * (exactly when the warm-up fires) could otherwise let a second sync observe a
 * transiently-empty list and unregister sessions the first just registered.
 */
function syncPortScans(db: HostDb): ReturnType<typeof runPortScanSync> {
	if (inFlightPortScanSync) return inFlightPortScanSync;
	inFlightPortScanSync = runPortScanSync(db).finally(() => {
		inFlightPortScanSync = null;
	});
	return inFlightPortScanSync;
}

/**
 * (REAPER-CORRECTION-CAP) What one reap pass has to remember about the pass
 * before it. A bare set was not enough: the two-pass rule rests on two
 * observations, and the set alone cannot say whether the older one was an empty
 * daemon listing (which is never evidence) or a real one.
 */
interface StaleRowPassState {
	absentOnPreviousPass: Set<string>;
	previousPassListedTerminals: boolean;
}

async function reapOrphanedSessions(
	db: HostDb,
	rowlessPendingSecondPass: Set<string>,
	staleRowState: StaleRowPassState,
	eventBus?: EventBus,
): Promise<ReapResult> {
	// Sync the port scanner before the empty-list short-circuit below so an idle
	// daemon still drops stale scans.
	const { liveSessions, rowById } = await syncPortScans(db);

	if (liveSessions.length === 0) {
		rowlessPendingSecondPass.clear();
		staleRowState.absentOnPreviousPass.clear();
		staleRowState.previousPassListedTerminals = false;
		return { reaped: 0, failed: 0, corrected: 0 };
	}

	const orphans: { id: string; rowless: boolean }[] = [];
	const stillRowless = new Set<string>();
	for (const session of liveSessions) {
		const row = rowById.get(session.id);
		if (!row) {
			if (rowlessPendingSecondPass.has(session.id)) {
				orphans.push({ id: session.id, rowless: true });
			} else {
				stillRowless.add(session.id);
			}
			continue;
		}
		if (shouldReapRow(row)) {
			orphans.push({ id: session.id, rowless: false });
		}
	}

	let reaped = 0;
	let failed = 0;
	for (const orphan of orphans) {
		try {
			const result = await disposeSessionAndWait(orphan.id, db, eventBus);
			if (result.daemonCloseSucceeded) {
				reaped += 1;
				continue;
			}
		} catch {
			// fall through to the failure path below
		}
		failed += 1;
		// A failed kill on a confirmed (second-pass) rowless orphan is kept
		// pending so the next pass retries it instead of restarting its
		// two-pass clock.
		if (orphan.rowless) stillRowless.add(orphan.id);
	}

	rowlessPendingSecondPass.clear();
	for (const id of stillRowless) rowlessPendingSecondPass.add(id);

	// (BRIDGE-LIVENESS) The other direction: rows the daemon has forgotten. This
	// only writes the row — there is no pty left to kill, which is exactly the
	// condition being recorded.
	const nowMs = Date.now();
	const { correct, absentThisPass, listedThisPass } = planStaleRowCorrection({
		aliveIds: new Set(liveSessions.map((session) => session.id)),
		rowById,
		absentOnPreviousPass: staleRowState.absentOnPreviousPass,
		previousPassListedTerminals: staleRowState.previousPassListedTerminals,
		isLive: isLiveTerminalSession,
		nowMs,
	});
	let corrected = 0;
	for (const id of correct) {
		// (DISPOSE-LIMBO) `rowById` was snapshotted BEFORE the awaited orphan
		// disposals above; a user attach in that window respawns a fresh PTY and
		// upserts the row `active` with a new `createdAt`. An unfenced id-only
		// update here marked that LIVE replacement disposed — hidden from every
		// list, then killed by the next reaper pass. So the flip is fenced on the
		// identity this pass actually observed, and only a proven flip counts or
		// broadcasts.
		const observed = rowById.get(id);
		if (observed?.createdAt == null) {
			// Cannot fence without the observed identity; leave the row for a
			// later pass rather than write blind.
			absentThisPass.add(id);
			continue;
		}
		try {
			const flipped = db
				.update(terminalSessions)
				.set({ status: "disposed", endedAt: nowMs })
				.where(
					and(
						eq(terminalSessions.id, id),
						eq(terminalSessions.status, "active"),
						eq(terminalSessions.createdAt, observed.createdAt),
					),
				)
				.returning({ originWorkspaceId: terminalSessions.originWorkspaceId })
				.get();
			if (!flipped) {
				// The row changed under us — a racing create/adopt replaced this
				// generation (or something else already disposed it). Whatever is
				// there now is not the row two passes condemned; do not re-arm it.
				console.warn(
					`[host-service] terminal reaper: stale row ${id} changed mid-pass; correction skipped`,
				);
				continue;
			}
			corrected += 1;
			// For a limbo terminal whose PTY genuinely died, the daemon never
			// re-lists it, so this flip is the ONLY event that ever touches the
			// row — without a broadcast the renderer keeps the dead pane's dots
			// (including a latched red) for the rest of the session.
			if (flipped.originWorkspaceId) {
				eventBus?.broadcastTerminalLifecycle({
					workspaceId: flipped.originWorkspaceId,
					terminalId: id,
					eventType: "exit",
					exitCode: 0,
					signal: 0,
					occurredAt: nowMs,
				});
			}
		} catch (err) {
			console.warn(
				`[host-service] terminal reaper: could not correct stale row ${id}:`,
				err,
			);
			// Keep it pending so the next pass retries rather than restarting the
			// two-pass clock on a row we have already confirmed twice.
			absentThisPass.add(id);
		}
	}
	staleRowState.absentOnPreviousPass.clear();
	for (const id of absentThisPass) staleRowState.absentOnPreviousPass.add(id);
	staleRowState.previousPassListedTerminals = listedThisPass;

	return { reaped, failed, corrected };
}

/**
 * `eventBus` is what lets a retried dispose still reach the renderer. The
 * terminal it is retrying has no in-memory session left — the first pass tore
 * that down before its close failed — so the daemon's own `onExit` can never
 * fire for it, and without a bus here the row flips `active -> disposed` with
 * nobody told. The pane's dots (including a red question latched at dispose
 * time) then survive for the rest of the renderer session. Optional so tests
 * and any embedder without a bus still get the reaping.
 */
export function startTerminalReaper(
	db: HostDb,
	eventBus?: EventBus,
): () => void {
	const rowlessPendingSecondPass = new Set<string>();
	const staleRowState: StaleRowPassState = {
		absentOnPreviousPass: new Set<string>(),
		// The FIRST pass has no previous observation at all, which is exactly the
		// state an empty listing leaves behind — so it starts false and the reverse
		// walk cannot correct anything until two real listings have been seen.
		previousPassListedTerminals: false,
	};
	let running = false;
	const run = () => {
		if (running) return;
		running = true;
		void reapOrphanedSessions(
			db,
			rowlessPendingSecondPass,
			staleRowState,
			eventBus,
		)
			.then((result) => {
				if (result.reaped > 0 || result.failed > 0 || result.corrected > 0) {
					console.log(
						`[host-service] terminal reaper: ${result.reaped} reaped, ${result.failed} failed, ${result.corrected} stale row(s) corrected`,
					);
				}
			})
			.catch((err) => {
				console.warn("[host-service] terminal reaper failed:", err);
			})
			.finally(() => {
				running = false;
			});
	};
	run();
	const interval = setInterval(run, REAP_INTERVAL_MS);
	interval.unref();

	// Runs only the port-scan sync, not the full reap, so the warm-up never
	// disturbs the reaper's two-pass rowless-orphan clock.
	const warmupTimers = PORT_SCAN_WARMUP_DELAYS_MS.map((delay) =>
		setTimeout(() => {
			void syncPortScans(db).catch((err) => {
				console.warn("[host-service] port-scan warm-up sync failed:", err);
			});
		}, delay),
	);
	for (const timer of warmupTimers) timer.unref();

	return () => {
		clearInterval(interval);
		for (const timer of warmupTimers) clearTimeout(timer);
	};
}
