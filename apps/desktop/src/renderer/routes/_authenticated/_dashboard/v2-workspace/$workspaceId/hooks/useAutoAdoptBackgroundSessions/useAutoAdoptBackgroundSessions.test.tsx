import { expect, test } from "bun:test";

test("(MASTER-PLUS-LAUNCH) auto-adopt lifecycle refetch suite passes in its own process", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"test",
			`${import.meta.dir}/fixtures/lifecycle-refetch.tsx`,
		],
		env: { ...process.env, NODE_ENV: "test" },
	});
	expect(
		result.exitCode,
		result.stdout.toString() + result.stderr.toString(),
	).toBe(0);
});
