import { expect, test } from "bun:test";

test("(BINDINGS-COALESCE) bindings suite passes in its own process", () => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "test", `${import.meta.dir}/fixtures/coalesce.tsx`],
		env: { ...process.env, NODE_ENV: "test" },
	});
	expect(
		result.exitCode,
		result.stdout.toString() + result.stderr.toString(),
	).toBe(0);
});
