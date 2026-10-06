import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useInitialOpenGate } from "./useInitialOpenGate";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
const { cleanup, renderHook, waitFor } = await import("@testing-library/react");
afterEach(cleanup);
afterAll(() => {
	if (!alreadyRegistered) GlobalRegistrator.unregister();
});

test("a gated open is closed on the first render and opens after the frame", async () => {
	const { result, rerender } = renderHook(
		({ gated }) => useInitialOpenGate("ws-a", gated),
		{ initialProps: { gated: true } },
	);
	expect(result.current).toBe(false);
	await waitFor(() => expect(result.current).toBe(true));
	rerender({ gated: true });
	expect(result.current).toBe(true);
});

test("content that arrives after an ungated first render is not gated", () => {
	const { result, rerender } = renderHook(
		({ gated }) => useInitialOpenGate("ws-a", gated),
		{ initialProps: { gated: false } },
	);
	expect(result.current).toBe(true);
	rerender({ gated: true });
	expect(result.current).toBe(true);
});

test("a different workspace takes its own decision", async () => {
	const { result, rerender } = renderHook(
		({ workspaceId, gated }) => useInitialOpenGate(workspaceId, gated),
		{ initialProps: { workspaceId: "ws-a", gated: false } },
	);
	expect(result.current).toBe(true);
	rerender({ workspaceId: "ws-b", gated: true });
	expect(result.current).toBe(false);
	await waitFor(() => expect(result.current).toBe(true));
});
