import { expect, test } from "bun:test";

// Process-isolated: other suites mock modules page.tsx imports.
test("(FORK-PRS-OFF) a ?pr= link never reaches the PR filter", () => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "test", `${import.meta.dir}/fixtures/checks.ts`],
		env: { ...process.env, NODE_ENV: "test" },
	});
	expect(
		result.exitCode,
		result.stdout.toString() + result.stderr.toString(),
	).toBe(0);
});
