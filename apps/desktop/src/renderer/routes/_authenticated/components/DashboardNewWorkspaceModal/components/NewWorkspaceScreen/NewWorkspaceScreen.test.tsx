import { expect, test } from "bun:test";

// (MASTER-PLUS-LAUNCH) Process-isolated: the suite replaces ~40 modules process-wide.
test("new-workspace screen master mode suite passes", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"test",
			`${import.meta.dir}/fixtures/new-workspace-screen.tsx`,
		],
		env: { ...process.env, NODE_ENV: "test" },
	});
	expect(
		result.exitCode,
		result.stdout.toString() + result.stderr.toString(),
	).toBe(0);
});
