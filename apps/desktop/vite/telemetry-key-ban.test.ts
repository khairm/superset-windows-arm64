import { describe, expect, test } from "bun:test";
import {
	assertNoTelemetryKeys,
	BANNED_TELEMETRY_KEYS,
} from "./telemetry-key-ban";

describe("(CLOUD-SEVERANCE-P1) telemetry key ban", () => {
	test("bans exactly the four telemetry inputs", () => {
		expect([...BANNED_TELEMETRY_KEYS]).toEqual([
			"NEXT_PUBLIC_POSTHOG_KEY",
			"SENTRY_DSN_DESKTOP",
			"SENTRY_DSN_HOST_SERVICE",
			"SENTRY_AUTH_TOKEN",
		]);
	});

	test("passes on an empty environment", () => {
		expect(() => assertNoTelemetryKeys({})).not.toThrow();
	});

	test("passes on an unrelated .env (ports, urls, workspace name keep working)", () => {
		expect(() =>
			assertNoTelemetryKeys({
				DESKTOP_VITE_PORT: "5873",
				NEXT_PUBLIC_API_URL: "http://localhost:5881",
				SUPERSET_WORKSPACE_NAME: "my-workspace",
				RELAY_URL: "https://relay.example",
			}),
		).not.toThrow();
	});

	test.each([...BANNED_TELEMETRY_KEYS])("throws and names %s", (key) => {
		expect(() => assertNoTelemetryKeys({ [key]: "some-value" })).toThrow(key);
	});

	test("throws with the severance marker so the failure is attributable", () => {
		expect(() =>
			assertNoTelemetryKeys({ NEXT_PUBLIC_POSTHOG_KEY: "phc_abc123" }),
		).toThrow(/CLOUD-SEVERANCE-P1/);
	});

	test("treats empty and whitespace-only values as absent, not as a violation", () => {
		expect(() =>
			assertNoTelemetryKeys({
				NEXT_PUBLIC_POSTHOG_KEY: "",
				SENTRY_DSN_DESKTOP: "   ",
				SENTRY_AUTH_TOKEN: undefined,
			}),
		).not.toThrow();
	});

	test("reports every offender at once, not just the first", () => {
		let message = "";
		try {
			assertNoTelemetryKeys({
				NEXT_PUBLIC_POSTHOG_KEY: "phc_x",
				SENTRY_AUTH_TOKEN: "t",
			});
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("NEXT_PUBLIC_POSTHOG_KEY");
		expect(message).toContain("SENTRY_AUTH_TOKEN");
	});

	test("does NOT mutate the environment it inspects (no silent masking)", () => {
		const environment: Record<string, string | undefined> = {
			NEXT_PUBLIC_POSTHOG_KEY: "phc_x",
		};
		expect(() => assertNoTelemetryKeys(environment)).toThrow();
		expect(environment.NEXT_PUBLIC_POSTHOG_KEY).toBe("phc_x");
	});
});
