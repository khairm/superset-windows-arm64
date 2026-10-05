// (PRESENCE-SCREEN-LOCK) The session lock state for the renderer's away check.
// `null` is unknown and is never guessed as "not locked".
import log from "electron-log/main";

export type SystemIdleState = "active" | "idle" | "locked" | "unknown";

type ScreenLockEvent = "lock-screen" | "unlock-screen" | "resume";

export interface ScreenLockPowerMonitor {
	getSystemIdleState(idleThreshold: number): SystemIdleState;
	on(event: ScreenLockEvent, listener: () => void): unknown;
	removeListener(event: ScreenLockEvent, listener: () => void): unknown;
}

export interface ScreenLockDeps {
	powerMonitor: ScreenLockPowerMonitor;
	now?: () => number;
	startInterval?: (tick: () => void, ms: number) => () => void;
	logger?: {
		info(message: string): void;
		error(message: string, error: unknown): void;
	};
}

type ScreenLockListener = (locked: boolean | null) => void;

const REREAD_INTERVAL_MS = 15_000;
// The OS can still answer "active" for a moment after a lock event.
const EVENT_SETTLE_MS = 5_000;

let locked: boolean | null = null;
let lastEventAt = Number.NEGATIVE_INFINITY;
let failureLogged = false;
let running: { deps: Required<ScreenLockDeps>; detach: () => void } | null =
	null;
const listeners = new Set<ScreenLockListener>();

function startUnrefInterval(tick: () => void, ms: number): () => void {
	const timer = setInterval(tick, ms);
	timer.unref();
	return () => clearInterval(timer);
}

function apply(
	next: boolean,
	source: "event" | "reread",
	deps: Required<ScreenLockDeps>,
): void {
	if (locked === next) return;
	locked = next;
	deps.logger.info(`[screen-lock] ${next ? "locked" : "unlocked"} (${source})`);
	for (const listener of listeners) listener(next);
}

function reread(deps: Required<ScreenLockDeps>): void {
	if (deps.now() - lastEventAt < EVENT_SETTLE_MS) return;
	let state: SystemIdleState;
	try {
		state = deps.powerMonitor.getSystemIdleState(1);
	} catch (error) {
		if (failureLogged) return;
		failureLogged = true;
		deps.logger.error("[screen-lock] system idle state read failed", error);
		return;
	}
	if (failureLogged) {
		failureLogged = false;
		deps.logger.info("[screen-lock] system idle state read recovered");
	}
	if (state === "locked") apply(true, "reread", deps);
	else if (state === "active" || state === "idle") apply(false, "reread", deps);
}

export function startScreenLock(input: ScreenLockDeps): void {
	if (running) return;
	const deps: Required<ScreenLockDeps> = {
		powerMonitor: input.powerMonitor,
		now: input.now ?? Date.now,
		startInterval: input.startInterval ?? startUnrefInterval,
		logger: input.logger ?? log,
	};
	const { powerMonitor } = deps;
	const onEvent = (next: boolean) => {
		lastEventAt = deps.now();
		apply(next, "event", deps);
	};
	const onLock = () => onEvent(true);
	const onUnlock = () => onEvent(false);
	const onResume = () => reread(deps);
	powerMonitor.on("lock-screen", onLock);
	powerMonitor.on("unlock-screen", onUnlock);
	powerMonitor.on("resume", onResume);
	const stopInterval = deps.startInterval(
		() => reread(deps),
		REREAD_INTERVAL_MS,
	);
	running = {
		deps,
		detach: () => {
			powerMonitor.removeListener("lock-screen", onLock);
			powerMonitor.removeListener("unlock-screen", onUnlock);
			powerMonitor.removeListener("resume", onResume);
			stopInterval();
		},
	};
	reread(deps);
}

export function stopScreenLock(): void {
	if (!running) return;
	running.detach();
	running = null;
	locked = null;
	lastEventAt = Number.NEGATIVE_INFINITY;
	failureLogged = false;
}

/** Re-reads the OS, hands `listener` the current value, then every change. */
export function subscribeScreenLock(listener: ScreenLockListener): () => void {
	if (!running) {
		throw new Error("[screen-lock] subscribe before startScreenLock");
	}
	reread(running.deps);
	running.deps.logger.info("[screen-lock] subscriber attached");
	listeners.add(listener);
	listener(locked);
	return () => {
		listeners.delete(listener);
	};
}
