import { describe, expect, test } from "bun:test";

describe("text never reaches a terminal through the raw keystroke channel", () => {
	test("the shared agent writer sends through terminal.send", async () => {
		const source = await Bun.file(
			`${import.meta.dir}/useSendToTerminalAgent.ts`,
		).text();
		expect(source).toMatch(/terminal\s*\.\s*send\s*\.\s*useMutation\b/);
	});
});
