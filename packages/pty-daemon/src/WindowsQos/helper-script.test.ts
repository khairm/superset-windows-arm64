import { describe, expect, test } from "bun:test";
import {
	QOS_HELPER_COMMAND,
	QOS_HELPER_CS,
	QOS_HELPER_CS_ENV,
	QOS_HELPER_LINE_KEYS,
	QOS_HELPER_PTYD_ENV,
} from "./helper-script.ts";
import { parseHelperLine } from "./WindowsQos.ts";

const SAMPLE_VALUES: Record<string, string> = {
	arch: "ARM64",
	ptydTagged: "1",
	tickMs: "22/42",
	op: "open",
};

function sampleLine(token: string, keys: readonly string[]): string {
	const pairs = keys.map((key) => `${key}=${SAMPLE_VALUES[key] ?? "7"}`);
	return [token, ...pairs].join(" ");
}

function matches(pattern: RegExp): string[] {
	return [...QOS_HELPER_CS.matchAll(pattern)].map((match) => match[1] ?? "");
}

describe("QoS helper C#", () => {
	test("has no empty catch", () => {
		expect(QOS_HELPER_CS).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
	});

	test("never names a job object or a kill", () => {
		for (const name of [
			"CreateJobObject",
			"AssignProcessToJobObject",
			"TerminateProcess",
		]) {
			expect(QOS_HELPER_CS).not.toContain(name);
		}
	});

	test("the -Command text and the C# env value fit in 32,767 characters", () => {
		expect(QOS_HELPER_COMMAND.length + QOS_HELPER_CS.length).toBeLessThan(
			32_767,
		);
	});

	test("emits only ready, stats and error lines, keyed as the parser expects", () => {
		const tokens = matches(/(?:Emit\(|return )"([a-z]+) /g);
		expect(new Set(tokens)).toEqual(new Set(Object.keys(QOS_HELPER_LINE_KEYS)));
		for (const [token, keys] of Object.entries(QOS_HELPER_LINE_KEYS)) {
			const emitter = `"${token} ${keys.map((key) => `${key}=`).join(`"[^;]+?" `)}`;
			expect(QOS_HELPER_CS).toMatch(new RegExp(emitter));
			expect(parseHelperLine(sampleLine(token, keys))).not.toBeNull();
		}
		expect(QOS_HELPER_CS).toContain('Emit("error " + e.Key + " count="');
		expect(QOS_HELPER_CS).toContain('"op=" + op + " code=" + code;');
		expect(
			parseHelperLine(sampleLine("warn", QOS_HELPER_LINE_KEYS.error)),
		).toBeNull();
	});

	test("the command and the C# read the shared env names", () => {
		expect(QOS_HELPER_CS).toContain(`"${QOS_HELPER_PTYD_ENV}"`);
		expect(QOS_HELPER_COMMAND).toContain(`$env:${QOS_HELPER_CS_ENV}`);
	});
});
