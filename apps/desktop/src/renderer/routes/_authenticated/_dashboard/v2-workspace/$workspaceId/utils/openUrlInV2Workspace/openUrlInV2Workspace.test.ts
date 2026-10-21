import { afterAll, describe, expect, mock, test } from "bun:test";

// Later files inherit the sonner mock; after this file it runs the real toast.
let faking = true;
afterAll(() => {
	faking = false;
});
function whileFaking<Args extends unknown[]>(
	fake: (...args: NoInfer<Args>) => unknown,
	real: (...args: Args) => unknown,
): (...args: Args) => unknown {
	return (...args) => (faking ? fake(...args) : real(...args));
}

const mutate = mock(async (_url: string) => ({}));
const showError = mock((_message: unknown) => {});
const realSonner = { ...(await import("@superset/ui/sonner")) };
const realToast = realSonner.toast;
mock.module("@superset/ui/sonner", () => ({
	...realSonner,
	toast: Object.assign(
		(...args: Parameters<typeof realToast>) => realToast(...args),
		realToast,
		{ error: whileFaking(showError, realToast.error) },
	),
}));
mock.module("renderer/lib/trpc-client", () => ({
	electronTrpcClient: { external: { openUrl: { mutate } } },
}));

const { openUrlInV2Workspace } = await import("./openUrlInV2Workspace");

describe("openUrlInV2Workspace (FORK-BROWSER-OFF)", () => {
	test("both pane targets route to the external URL handler", async () => {
		const store = {
			getState: () => {
				throw new Error("Browser pane was created");
			},
		} as never;
		openUrlInV2Workspace({
			store,
			target: "current-tab",
			url: "https://example.com/one",
		});
		openUrlInV2Workspace({
			store,
			target: "new-tab",
			url: "https://example.com/two",
		});
		expect(mutate).toHaveBeenCalledTimes(2);
		expect(mutate).toHaveBeenNthCalledWith(1, "https://example.com/one");
		expect(mutate).toHaveBeenNthCalledWith(2, "https://example.com/two");
	});

	test("reports external browser failures to the user", async () => {
		mutate.mockImplementationOnce(async () => {
			throw new Error("No browser handler");
		});
		const store = {
			getState: () => {
				throw new Error("Browser pane was created");
			},
		} as never;
		openUrlInV2Workspace({
			store,
			target: "new-tab",
			url: "https://example.com/fail",
		});
		await Promise.resolve();
		expect(showError).toHaveBeenCalledWith(
			"Failed to open URL in external browser",
		);
	});
});
