import { describe, expect, mock, test } from "bun:test";
import {
	NOTIFY_DAEMON_STOP_DEADLINE_MS,
	type QuitCleanupDeps,
	runQuitCleanup,
	UPDATE_INSTALL_EXIT_GRACE_MS,
} from "./quit-sequence";

interface Harness {
	deps: QuitCleanupDeps;
	forceExit: ReturnType<typeof mock>;
	teardownTerminalHost: ReturnType<typeof mock>;
	disposeTerminalHostClient: ReturnType<typeof mock>;
	stopHostServices: ReturnType<typeof mock>;
	stopNotifyDaemon: ReturnType<typeof mock>;
	scheduled: Array<{ callback: () => void; delayMs: number }>;
	scheduledAt(delayMs: number): Array<{ callback: () => void }>;
}

function createHarness(overrides: Partial<QuitCleanupDeps> = {}): Harness {
	const forceExit = mock((_code: number) => {});
	const teardownTerminalHost = mock(async () => {});
	const disposeTerminalHostClient = mock(() => {});
	const stopHostServices = mock(() => {});
	const stopNotifyDaemon = mock(async () => {});
	const scheduled: Array<{ callback: () => void; delayMs: number }> = [];

	const deps: QuitCleanupDeps = {
		isDev: false,
		forceFullCleanup: false,
		isUpdateInstalling: false,
		stopHostServices,
		stopNotifyDaemon,
		teardownTerminalHost,
		disposeTerminalHostClient,
		shutdownPersistence: () => {},
		disposeTray: () => {},
		forceExit,
		scheduleTimer: (callback, delayMs) => {
			scheduled.push({ callback, delayMs });
		},
		logError: () => {},
		...overrides,
	};

	return {
		deps,
		forceExit,
		teardownTerminalHost,
		disposeTerminalHostClient,
		stopHostServices,
		stopNotifyDaemon,
		scheduled,
		scheduledAt: (delayMs) =>
			scheduled.filter((timer) => timer.delayMs === delayMs),
	};
}

describe("runQuitCleanup", () => {
	test("force-exits immediately on a normal quit", async () => {
		const h = createHarness();

		await runQuitCleanup(h.deps);

		expect(h.forceExit).toHaveBeenCalledWith(0);
		expect(h.scheduledAt(UPDATE_INSTALL_EXIT_GRACE_MS)).toHaveLength(0);
	});

	// Regression: #6048 — pressing "Update" closed the app without installing the
	// update and without relaunching. `quitAndInstall()` only starts the
	// Squirrel.Mac handoff; ShipIt is launched asynchronously and swaps the bundle
	// after the app terminates. Calling `app.exit(0)` from `before-quit` kills the
	// browser process out from under that handoff (and skips `will-quit`
	// entirely), so the user gets a closed app that is still on the old version.
	test("does not force-exit while an update install is in flight", async () => {
		const h = createHarness({ isUpdateInstalling: true });

		await runQuitCleanup(h.deps);

		expect(h.forceExit).not.toHaveBeenCalled();
	});

	test("arms a watchdog exit if Squirrel never terminates the app", async () => {
		const h = createHarness({ isUpdateInstalling: true });

		await runQuitCleanup(h.deps);

		expect(h.scheduledAt(UPDATE_INSTALL_EXIT_GRACE_MS)).toHaveLength(1);

		h.scheduledAt(UPDATE_INSTALL_EXIT_GRACE_MS)[0].callback();
		expect(h.forceExit).toHaveBeenCalledWith(0);
	});

	test("still runs cleanup before handing off to the updater", async () => {
		const h = createHarness({ isUpdateInstalling: true });

		await runQuitCleanup(h.deps);

		expect(h.stopHostServices).toHaveBeenCalled();
		// terminal-host owns the PTY subprocesses: detach, never tear down, so
		// sessions can be reattached after the update relaunch.
		expect(h.disposeTerminalHostClient).toHaveBeenCalled();
		expect(h.teardownTerminalHost).not.toHaveBeenCalled();
	});

	test("tears down the terminal host for a quit-completely", async () => {
		const h = createHarness({ forceFullCleanup: true });

		await runQuitCleanup(h.deps);

		expect(h.teardownTerminalHost).toHaveBeenCalled();
		expect(h.forceExit).toHaveBeenCalledWith(0);
	});

	test("force-exits even if cleanup throws", async () => {
		const h = createHarness({
			stopHostServices: () => {
				throw new Error("boom");
			},
		});

		await runQuitCleanup(h.deps);

		expect(h.forceExit).toHaveBeenCalledWith(0);
	});

	// (HOOK-HTTP-DAEMON) The restore rewrites every Claude profile on this
	// machine; one stuck fs op must not hold the quit open forever.
	test("gives up on a hook restore that never settles and quits anyway", async () => {
		const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
		const logError = mock((_message: string, _error: unknown) => {});
		const h = createHarness({
			forceFullCleanup: true,
			stopNotifyDaemon: () => new Promise<void>(() => {}),
			scheduleTimer: (callback, delayMs) => {
				scheduled.push({ callback, delayMs });
				if (delayMs === NOTIFY_DAEMON_STOP_DEADLINE_MS) callback();
			},
			logError,
		});

		await runQuitCleanup(h.deps);

		expect(
			scheduled.map((timer) => timer.delayMs).includes(
				NOTIFY_DAEMON_STOP_DEADLINE_MS,
			),
		).toBe(true);
		expect(logError).toHaveBeenCalled();
		expect(h.teardownTerminalHost).toHaveBeenCalled();
		expect(h.forceExit).toHaveBeenCalledWith(0);
	});
});
