import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
	spyOn,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { snoozeTicker } from "renderer/lib/shared-ticker";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { useSnoozeWake } = await import("./useSnoozeWake");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

type Row = { snoozeUntil?: number | null };

function mountWake(rows: readonly Row[]) {
	let renders = 0;
	const view = renderHook(
		({ rows }: { rows: readonly Row[] }) => {
			renders += 1;
			return useSnoozeWake(rows);
		},
		{ initialProps: { rows } },
	);
	return { view, renders: () => renders };
}

describe("useSnoozeWake", () => {
	let now: ReturnType<typeof spyOn>;

	beforeEach(() => {
		jest.useFakeTimers();
		now = spyOn(Date, "now").mockReturnValue(NOW);
	});

	afterEach(() => {
		cleanup();
		mock.restore();
		jest.useRealTimers();
	});

	afterAll(async () => {
		if (!alreadyRegistered) await GlobalRegistrator.unregister();
	});

	function tick(at: number) {
		now.mockReturnValue(at);
		act(() => {
			jest.advanceTimersByTime(60_000);
		});
	}

	it("does not render on ticks while every deadline is ahead", () => {
		const { view, renders } = mountWake([{ snoozeUntil: NOW + 3 * HOUR }]);
		const before = renders();
		for (let i = 1; i <= 10; i++) tick(NOW + i * 60_000);
		expect(renders()).toBe(before);
		expect(view.result.current).toBe(0);
	});

	it("renders once and bumps the epoch on the tick after a deadline", () => {
		const { view, renders } = mountWake([{ snoozeUntil: NOW + 30_000 }]);
		tick(NOW + 20_000);
		const before = renders();
		expect(view.result.current).toBe(0);

		tick(NOW + 90_000);
		expect(renders()).toBe(before + 1);
		expect(view.result.current).toBe(1);
	});

	it("keeps its ticker subscription when rows change but stay timed", () => {
		const subscribe = spyOn(snoozeTicker, "subscribe");
		const { view } = mountWake([{ snoozeUntil: NOW + HOUR }]);
		const calls = subscribe.mock.calls.length;
		expect(calls).toBeGreaterThan(0);

		view.rerender({
			rows: [{ snoozeUntil: NOW + HOUR }, { snoozeUntil: NOW + 2 * HOUR }],
		});
		expect(subscribe.mock.calls.length).toBe(calls);
		expect(jest.getTimerCount()).toBe(1);
	});

	it("keeps the shared interval's phase when rows change but stay timed", () => {
		const { view, renders } = mountWake([{ snoozeUntil: NOW + HOUR }]);
		now.mockReturnValue(NOW + 30_000);
		act(() => {
			jest.advanceTimersByTime(30_000);
		});

		view.rerender({ rows: [{ snoozeUntil: NOW + 45_000 }] });
		const before = renders();
		now.mockReturnValue(NOW + 60_000);
		act(() => {
			jest.advanceTimersByTime(30_000);
		});
		expect(renders()).toBe(before + 1);
		expect(view.result.current).toBe(1);
	});

	it("subscribes nothing for launch-only snoozes", () => {
		const subscribe = spyOn(snoozeTicker, "subscribe");
		mountWake([{ snoozeUntil: null }, {}]);
		expect(subscribe).not.toHaveBeenCalled();
		expect(jest.getTimerCount()).toBe(0);
	});
});
