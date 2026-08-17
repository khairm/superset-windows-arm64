import { describe, expect, test } from "bun:test";
import { trackCommandInvoked } from "./analytics";

/**
 * (CLOUD-SEVERANCE-P1) The point of these tests is that the function is INERT.
 * The api client is a throwing proxy: any property access on it fails, so the
 * test fails loudly if a future merge restores the captureEvent call.
 */
function explodingApiClient(): never {
	return new Proxy(
		{},
		{
			get(_target, property) {
				throw new Error(
					`trackCommandInvoked touched the api client (.${String(property)}) — the CLI must make no analytics call`,
				);
			},
		},
	) as never;
}

describe("trackCommandInvoked", () => {
	test("makes no call against the api client", () => {
		expect(() =>
			trackCommandInvoked({
				api: explodingApiClient(),
				commandPath: ["workspace", "create"],
				flags: ["--json"],
			}),
		).not.toThrow();
	});

	test("returns undefined synchronously (no promise left dangling)", () => {
		const result = trackCommandInvoked({
			api: explodingApiClient(),
			commandPath: ["ls"],
			flags: [],
		});
		expect(result).toBeUndefined();
	});
});
