import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useInitialOpenGate } from "./useInitialOpenGate";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
const { act, cleanup, renderHook } = await import(
	"@testing-library/react/pure"
);

const real = {
	setTimeout: window.setTimeout,
	clearTimeout: window.clearTimeout,
	requestAnimationFrame: window.requestAnimationFrame,
	cancelAnimationFrame: window.cancelAnimationFrame,
};
let now = 0;
let nextId = 1;
let timers = new Map<number, { at: number; run: () => void }>();
let frames = new Map<number, FrameRequestCallback>();
let cleared: number[] = [];
let cancelled: number[] = [];

beforeEach(() => {
	now = 0;
	timers = new Map();
	frames = new Map();
	cleared = [];
	cancelled = [];
	window.setTimeout = ((run: () => void, ms = 0) => {
		const id = nextId++;
		timers.set(id, { at: now + ms, run });
		return id;
	}) as typeof window.setTimeout;
	window.clearTimeout = ((id: number) => {
		cleared.push(id);
		timers.delete(id);
	}) as typeof window.clearTimeout;
	window.requestAnimationFrame = (callback) => {
		const id = nextId++;
		frames.set(id, callback);
		return id;
	};
	window.cancelAnimationFrame = (id) => {
		cancelled.push(id);
		frames.delete(id);
	};
});

afterEach(() => {
	cleanup();
	Object.assign(window, real);
});

afterAll(() => {
	if (!alreadyRegistered) GlobalRegistrator.unregister();
});

function runFrames() {
	const due = [...frames.values()];
	frames.clear();
	for (const callback of due) callback(now);
}

function advance(ms: number) {
	now += ms;
	const due = [...timers.entries()]
		.filter(([, timer]) => timer.at <= now)
		.sort((a, b) => a[1].at - b[1].at);
	for (const [id, timer] of due) {
		timers.delete(id);
		timer.run();
	}
}

test("a gated open stays closed through the frame and opens on the task after it", () => {
	const { result } = renderHook(() => useInitialOpenGate("ws-a", true));
	expect(result.current).toBe(false);
	act(runFrames);
	expect(result.current).toBe(false);
	act(() => advance(0));
	expect(result.current).toBe(true);
});

test("the fallback opens the gate when no frame comes", () => {
	const { result } = renderHook(() => useInitialOpenGate("ws-a", true));
	act(() => advance(999));
	expect(result.current).toBe(false);
	act(() => advance(1));
	expect(result.current).toBe(true);
});

test("unmount cancels the frame, the after-paint task and the fallback", () => {
	const { unmount } = renderHook(() => useInitialOpenGate("ws-a", true));
	const [frame] = frames.keys();
	act(runFrames);
	const pending = [...timers.keys()];
	expect(pending).toHaveLength(2);
	unmount();
	expect(cancelled).toContain(frame);
	expect(cleared).toEqual(expect.arrayContaining(pending));
	expect(timers.size).toBe(0);
});
