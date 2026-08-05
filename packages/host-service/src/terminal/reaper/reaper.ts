import { eq } from "drizzle-orm";
import type { HostDb } from "../../db/index.ts";
import { terminalSessions } from "../../db/schema.ts";
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
 *  1. The daemon listed SOMETHING. An empty listing is the documented
 *     racy-adoption case (`PORT_SCAN_WARMUP_DELAYS_MS`) and is never evidence.
 *  2. The row is `active` and workspace-owned. Anything else is already the
 *     forward walk's business.
 *  3. The daemon does not list it AND this process holds no live session for
 *     it. Either alone is insufficient — an adopted session is absent from
 *     memory by design.
 *  4. It was absent on the PREVIOUS pass too. Five minutes apart, so a single
 *     partially-populated `daemon.list()` cannot condemn a live terminal.
 *  5. It is older than `STALE_ROW_MIN_AGE_MS`, so a session created seconds ago
 *     cannot lose a race with the listing that was taken before it existed.
 *
 * Being wrong here costs a LIVE terminal its place in the session dropdown and
 * in pane adoption (`listWorkspaceTerminalSessions` filters on `status`), which
 * is why the bar is five independent conditions and not one.
 */
export function planStaleRowCorrection({
	aliveIds,
	rowById,
	absentOnPreviousPass,
	isLive,
	nowMs,
}: {
	aliveIds: ReadonlySet<string>;
	rowById: Map<string, TerminalRow>;
	absentOnPreviousPass: ReadonlySet<string>;
	isLive: (terminalId: string) => boolean;
	nowMs: number;
}): { correct: string[]; absentThisPass: Set<string> } {
	const correct: string[] = [];
	const absentThisPass = new Set<string>();
	if (aliveIds.size === 0) return { correct, absentThisPass };

	for (const [id, row] of rowById) {
		if (row.status !== "active") continue;
		if (!row.originWorkspaceId) continue;
		if (aliveIds.has(id)) continue;
		if (isLive(id)) continue;
		const touchedAt = Math.max(row.createdAt ?? 0, row.lastAttachedAt ?? 0);
		if (touchedAt > 0 && nowMs - touchedAt < STALE_ROW_MIN_AGE_MS) continue;
		if (!absentOnPreviousPass.has(id)) {
			absentThisPass.add(id);
			continue;
		}
		correct.push(id);
	}
	return { correct, absentThisPass };
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

async function reapOrphanedSessions(
	db: HostDb,
	rowlessPendingSecondPass: Set<string>,
	staleRowsPendingSecondPass: Set<string>,
): Promise<ReapResult> {
	// Sync the port scanner before the empty-list short-circuit below so an idle
	// daemon still drops stale scans.
	const { liveSessions, rowById } = await syncPortScans(db);

	if (liveSessions.length === 0) {
		rowlessPendingSecondPass.clear();
		staleRowsPendingSecondPass.clear();
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
			const result = await disposeSessionAndWait(orphan.id, db);
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
	const { correct, absentThisPass } = planStaleRowCorrection({
		aliveIds: new Set(liveSessions.map((session) => session.id)),
		rowById,
		absentOnPreviousPass: staleRowsPendingSecondPass,
		isLive: isLiveTerminalSession,
		nowMs,
	});
	let corrected = 0;
	for (const id of correct) {
		try {
			db.update(terminalSessions)
				.set({ status: "disposed", endedAt: nowMs })
				.where(eq(terminalSessions.id, id))
				.run();
			corrected += 1;
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
	staleRowsPendingSecondPass.clear();
	for (const id of absentThisPass) staleRowsPendingSecondPass.add(id);

	return { reaped, failed, corrected };
}

export function startTerminalReaper(db: HostDb): () => void {
	const rowlessPendingSecondPass = new Set<string>();
	const staleRowsPendingSecondPass = new Set<string>();
	let running = false;
	const run = () => {
		if (running) return;
		running = true;
		void reapOrphanedSessions(
			db,
			rowlessPendingSecondPass,
			staleRowsPendingSecondPass,
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
