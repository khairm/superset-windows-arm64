import { afterEach, describe, expect, test } from "bun:test";
import { planNativeWatch } from "./parcel-backend";
import { createWrapper } from "./test-helpers";

const originalPlatform = process.platform;
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
});

function optionsOn(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform });
	return planNativeWatch({
		rootPath: "/repo",
		ignore: ["**/node_modules/**"],
		generation: 1,
	}).nativeOptions;
}

describe("planNativeWatch", () => {
	test("other platforms pass no backend", () => {
		expect(optionsOn("darwin")).toStrictEqual({
			ignore: ["**/node_modules/**"],
		});
	});

	test("win32 pins the windows backend, and parcel's unsubscribe hands native the same one", async () => {
		const options = optionsOn("win32");
		expect(options).toStrictEqual({
			ignore: ["node_modules"],
			backend: "windows",
		});
		const seen: Array<[string, unknown]> = [];
		const wrapper = createWrapper({
			subscribe: (_dir, _fn, opts) => seen.push(["subscribe", opts.backend]),
			unsubscribe: (_dir, _fn, opts) =>
				seen.push(["unsubscribe", opts.backend]),
		});
		const subscription = await wrapper.subscribe("/repo", () => {}, options);
		await subscription.unsubscribe();
		expect(seen).toEqual([
			["subscribe", "windows"],
			["unsubscribe", "windows"],
		]);
	});
});
