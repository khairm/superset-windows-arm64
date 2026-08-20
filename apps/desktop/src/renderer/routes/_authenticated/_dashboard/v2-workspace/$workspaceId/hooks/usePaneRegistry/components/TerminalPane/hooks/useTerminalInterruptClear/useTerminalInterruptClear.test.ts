/**
 * (MANUAL-DISMISS) What an interrupt is allowed to clear.
 *
 * Ctrl+C / Escape kills the foreground turn and Claude Code fires no Stop hook
 * for it, so the yellow would stay latched forever. But an interrupt is an
 * AUTOMATIC path — Escape is a key people press constantly — and it is not the
 * user saying they have answered a question. The red has to survive it.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { useV2NotificationStore } from "renderer/stores/v2-notifications";
import { resetV2NotificationStoreForTest } from "renderer/stores/v2-notifications/resetForTest";
import { clearInterruptedTerminalAxes } from "./useTerminalInterruptClear";

const WORKSPACE = "workspace-1";
const TERMINAL = "terminal-1";
const source = { type: "terminal", id: TERMINAL } as const;

describe("(MANUAL-DISMISS) clearInterruptedTerminalAxes", () => {
	beforeEach(() => {
		resetV2NotificationStoreForTest();
	});

	it("clears working, review and the background blue", () => {
		const store = useV2NotificationStore.getState();
		store.applySourceAxes(
			source,
			WORKSPACE,
			{ set: ["working", "review"], clear: [] },
			1_000,
		);
		store.setTerminalBackgroundRunning(TERMINAL, WORKSPACE, 1_000);

		clearInterruptedTerminalAxes({
			terminalId: TERMINAL,
			workspaceId: WORKSPACE,
		});

		const state = useV2NotificationStore.getState();
		expect(state.sources[`terminal:${TERMINAL}`]).toBeUndefined();
		expect(state.backgroundRunningTerminals[TERMINAL]).toBeUndefined();
	});

	it("leaves a live permission red exactly where it was", () => {
		const store = useV2NotificationStore.getState();
		store.applySourceAxes(
			source,
			WORKSPACE,
			{ set: ["permission", "working"], clear: [] },
			1_000,
		);

		clearInterruptedTerminalAxes({
			terminalId: TERMINAL,
			workspaceId: WORKSPACE,
		});

		const entry =
			useV2NotificationStore.getState().sources[`terminal:${TERMINAL}`];
		expect(entry?.status).toBe("permission");
		expect(entry?.axes.permission).toBe(1_000);
		expect(entry?.axes.working).toBeUndefined();
		// The entry's instant is HOST-clock evidence the resync fences replayed
		// rows against; a local `Date.now()` stamp here would make the next
		// snapshot look older than it is and skip the row.
		expect(entry?.occurredAt).toBe(1_000);
	});

	it("does not touch the outstanding ready record", () => {
		const store = useV2NotificationStore.getState();
		store.applySourceAxes(
			source,
			WORKSPACE,
			{ set: ["review"], clear: [] },
			1_000,
		);
		expect(useV2NotificationStore.getState().outstandingReadyAt[TERMINAL]).toBe(
			1_000,
		);

		clearInterruptedTerminalAxes({
			terminalId: TERMINAL,
			workspaceId: WORKSPACE,
		});

		expect(useV2NotificationStore.getState().outstandingReadyAt[TERMINAL]).toBe(
			1_000,
		);
	});
});
