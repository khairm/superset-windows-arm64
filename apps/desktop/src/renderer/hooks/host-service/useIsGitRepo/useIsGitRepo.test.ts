import { expect, test } from "bun:test";

// Process-isolated: the fixture mocks the host event bus and client modules.
test("useIsGitRepo live: false holds no host git watch", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"test",
			`${import.meta.dir}/fixtures/live-option.tsx`,
		],
		env: { ...process.env, NODE_ENV: "test" },
	});
	expect(
		result.exitCode,
		result.stdout.toString() + result.stderr.toString(),
	).toBe(0);
});
