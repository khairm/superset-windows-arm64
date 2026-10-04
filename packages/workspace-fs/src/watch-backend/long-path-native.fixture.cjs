"use strict";
// Child of long-path.test.ts, run by the shipped Electron as node: one real
// @parcel/watcher subscription with the given ignore list, then a 320-char
// root-relative path. Prints `ready`, then `survived` or `timeout`.
const fs = require("node:fs");
const path = require("node:path");
const watcher = require("@parcel/watcher");

const LONG_REL_LENGTH = 320;
const DEADLINE_MS = 20_000;

const [root, ignoreJson] = process.argv.slice(2);
if (!root || !ignoreJson) {
	throw new Error("usage: long-path-native.fixture.cjs <root> <ignore-json>");
}
const ignore = JSON.parse(ignoreJson);

setTimeout(() => {
	process.stdout.write("timeout\n");
	process.exit(2);
}, DEADLINE_MS);

const waiters = new Map();
function waitForEvent(target) {
	return new Promise((resolve) => waiters.set(target, resolve));
}

function writeLongFileAndDelete(dir) {
	let current = dir;
	for (let i = 0; path.relative(root, current).length < LONG_REL_LENGTH; i++) {
		current = path.join(current, `segment-${i % 10}`);
	}
	const file = path.toNamespacedPath(path.join(current, "f.ts"));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "x");
	fs.rmSync(file);
}

async function main() {
	await watcher.subscribe(
		root,
		(error, events) => {
			if (error) process.stderr.write(`watcher error: ${error.message}\n`);
			for (const event of events) waiters.get(event.path)?.();
		},
		{ ignore },
	);
	const readyFile = path.join(root, "ready.txt");
	const ready = waitForEvent(readyFile);
	fs.writeFileSync(readyFile, "x");
	await ready;
	process.stdout.write("ready\n");

	writeLongFileAndDelete(path.join(root, "normal"));

	const sentinel = path.join(root, "sentinel.txt");
	const survived = waitForEvent(sentinel);
	fs.writeFileSync(sentinel, "x");
	await survived;
	process.stdout.write("survived\n");
	process.exit(0);
}

main().catch((error) => {
	process.stderr.write(`${error.stack}\n`);
	process.exit(1);
});
