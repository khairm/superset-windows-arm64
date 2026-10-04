// Child of long-path.test.ts, run by the test runner: the real
// FsWatcherManager on the parcel backend with the host-service options.
// Prints `ready`, its events as JSON, then `survived` or `timeout`.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FsWatcherManager } from "../watch";
import { parcelWatchBackend } from "./parcel-backend";

const LONG_REL_LENGTH = 320;
const DEADLINE_MS = 20_000;

const root = process.argv[2];
if (!root) throw new Error("usage: long-path-manager.fixture.ts <root>");

setTimeout(() => {
	console.log("timeout");
	process.exit(2);
}, DEADLINE_MS);

const quietDirs = [
	["node_modules"],
	[".claude", "worktrees"],
	["a", "b", ".git"],
	["x", ".worktrees", "w"],
];
for (const dir of [...quietDirs, ["a", "b", "src"]]) {
	mkdirSync(path.join(root, ...dir), { recursive: true });
}

const writeLongFileAndDelete = (dir: string): void => {
	let current = dir;
	for (let i = 0; path.relative(root, current).length < LONG_REL_LENGTH; i++) {
		current = path.join(current, `segment-${i % 10}`);
	}
	const file = path.toNamespacedPath(path.join(current, "f.ts"));
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, "x");
	rmSync(file);
};

const events: Array<{ kind: string; absolutePath: string }> = [];
const waiters = new Map<string, () => void>();
const waitForEvent = (target: string) =>
	new Promise<void>((resolve) => waiters.set(target, resolve));

const manager = new FsWatcherManager({
	backend: parcelWatchBackend,
	useDefaultIgnores: false,
	listGitIgnoredDirs: async () => ["node_modules"],
	debounceMs: 20,
});
await manager.subscribe({ absolutePath: root }, (batch) => {
	for (const event of batch.events) {
		events.push({ kind: event.kind, absolutePath: event.absolutePath });
		waiters.get(event.absolutePath)?.();
	}
});

const readyFile = path.join(root, "ready.txt");
const ready = waitForEvent(readyFile);
writeFileSync(readyFile, "x");
await ready;
console.log("ready");

for (const dir of quietDirs) {
	writeFileSync(path.join(root, ...dir, "short.txt"), "x");
}
writeLongFileAndDelete(path.join(root, "a", "b", "src"));
writeLongFileAndDelete(path.join(root, "normal"));

const sentinel = path.join(root, "sentinel.txt");
const survived = waitForEvent(sentinel);
writeFileSync(sentinel, "x");
await survived;
console.log(`events ${JSON.stringify(events)}`);
console.log("survived");
process.exit(0);
