import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HostWorkerPool } from "../host-worker-pool.ts";
import { gitDirTask } from "./git-reads.ts";

const WORKER_ENTRY = path.resolve(import.meta.dirname, "..", "host-worker.ts");

const pools: HostWorkerPool[] = [];
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(pools.splice(0).map((pool) => pool.dispose()));
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-dir-task-"));
	dirs.push(dir);
	return dir;
}

test("(GIT-WATCH-ATTACH-TASK) gitDirTask resolves through the production pool", async () => {
	const pool = new HostWorkerPool({ scriptPathResolver: () => WORKER_ENTRY });
	pools.push(pool);
	const run = (worktreePath: string) =>
		pool.run(gitDirTask, { worktreePath }, { timeoutMs: 10_000 });

	const repo = tempDir();
	execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "pipe" });
	const nonRepo = tempDir();

	const { gitDir } = await run(repo);
	expect(pool.getMode()).toBe("worker");
	expect(gitDir && path.resolve(gitDir)).toBe(path.join(repo, ".git"));
	expect(await run(nonRepo)).toEqual({ gitDir: null });
	expect(await run(path.join(nonRepo, "missing"))).toEqual({ gitDir: null });
});
