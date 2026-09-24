import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	setDefaultTimeout,
	spyOn,
	test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	setTimeout as delay,
	setImmediate as yieldToLoop,
} from "node:timers/promises";
import { NOTIFICATION_EVENTS } from "shared/constants";
import type { AgentLifecycleEvent } from "shared/notification-types";

// (WATCHER-ASYNC-IO)
const tempParent = path.resolve(import.meta.dir, "../../../../../../tmp");
await fs.promises.mkdir(tempParent, { recursive: true });
const home = await fs.promises.mkdtemp(path.join(tempParent, "watcher-test-"));
await import("./pane-map-hook");
const homedir = spyOn(os, "homedir").mockReturnValue(home);
const {
	startAgentJsonlWatcher,
	stopAgentJsonlWatcher,
	agentJsonlWatcherTesting: watcher,
} = await import("./agent-jsonl-watcher");
homedir.mockRestore();
const claude = watcher.sources[0];
const codex = watcher.sources[1];
const mappingDir = path.join(home, ".superset", "session-pane-map");
const casesDir = path.join(home, "cases");
let events: AgentLifecycleEvent[];
let errors: Array<{ sessionId: string }>;
let emitter: EventEmitter;

setDefaultTimeout(60_000);

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(condition: () => boolean) {
	const until = Date.now() + 10000;
	while (!condition()) {
		if (Date.now() > until) throw new Error("Watcher condition timed out");
		await delay(5);
	}
}

function start() {
	startAgentJsonlWatcher({
		notificationsEmitter: emitter,
		installPaneMapHook: () => {},
		onClaudeApiError: (event) => errors.push(event),
	});
}

const record = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const paddingRecords = (count: number) =>
	record({ padding: "x".repeat(1000) }).repeat(count);
const line = (type: string, cwd = "C:/work") =>
	record({ type: "event_msg", payload: { type }, cwd });
const apiError = (timestamp: number, cwd?: string) =>
	record({
		type: "assistant",
		isApiErrorMessage: true,
		timestamp: new Date(timestamp).toISOString(),
		cwd,
	});
const sessionPath = () => path.join(casesDir, `${randomUUID()}.jsonl`);

function stateOf(file: string) {
	const state = watcher.fileStates.get(file);
	if (!state) throw new Error(`Untracked transcript: ${file}`);
	return state;
}

beforeEach(async () => {
	events = [];
	errors = [];
	emitter = new EventEmitter();
	emitter.on(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, (event) =>
		events.push(event),
	);
	await fs.promises.mkdir(casesDir, { recursive: true });
	await fs.promises.mkdir(mappingDir, { recursive: true });
	for (const source of watcher.sources)
		await fs.promises.mkdir(source.logsDir, { recursive: true });
	start();
	await waitFor(() => watcher.seedComplete);
});

afterEach(async () => {
	stopAgentJsonlWatcher();
	mock.restore();
	await yieldToLoop();
	for (const dir of [
		casesDir,
		mappingDir,
		...watcher.sources.map((source) => source.logsDir),
	]) {
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
});

afterAll(async () => {
	await fs.promises.rm(home, { recursive: true, force: true });
});

describe("async transcript watcher", () => {
	test("seed, watch and poll share one reader and one trailing pass", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(file, line("task_complete"));
		const entered = deferred();
		const release = deferred();
		const open = fs.promises.open.bind(fs.promises);
		let opens = 0;
		const openSpy = spyOn(fs.promises, "open").mockImplementation(
			async (...args) => {
				const fh = await open(...args);
				if (args[0] === file && ++opens === 1) {
					entered.resolve();
					await release.promise;
				}
				return fh;
			},
		);
		const seed = watcher.seedFileAsync(file, codex);
		await entered.promise;
		await fs.promises.appendFile(file, line("request_user_input"));
		const first = watcher.processFile(file, codex, false);
		expect(watcher.processFile(file, codex, false)).toBe(first);
		await watcher.pollKnownFilesForGrowth();
		release.resolve();
		await Promise.all([seed, first]);
		openSpy.mockRestore();
		expect(opens).toBe(2);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
		]);
		expect(watcher.fileStates.get(file)?.offset).toBe(
			(await fs.promises.stat(file)).size,
		);
	});

	test.each([
		false,
		true,
	])("Codex seed preserves an append during stat with startup pending=%s", async (startupPending) => {
		const file = sessionPath();
		const timestamped = (type: string, timestamp: number) =>
			record({
				type: "event_msg",
				payload: { type },
				timestamp: new Date(timestamp).toISOString(),
			});
		await fs.promises.writeFile(
			file,
			record({ type: "session_meta", payload: { cwd: "C:/work" } }) +
				timestamped("task_complete", Date.now() - 10000) +
				line("task_started"),
		);
		const walkEntered = deferred();
		const walkRelease = deferred();
		if (startupPending) {
			stopAgentJsonlWatcher();
			await delay(5);
			const readdir = fs.promises.readdir.bind(fs.promises);
			spyOn(fs.promises, "readdir").mockImplementation(async (...args) => {
				if (args[0] === claude.logsDir) {
					walkEntered.resolve();
					await walkRelease.promise;
				}
				return readdir(...args);
			});
			start();
			await walkEntered.promise;
		}
		const statEntered = deferred();
		const statRelease = deferred();
		const stat = fs.promises.stat.bind(fs.promises);
		let held = false;
		spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
			if (!held && args[0] === file) {
				held = true;
				statEntered.resolve();
				await statRelease.promise;
			}
			return stat(...args);
		});
		const seed = watcher.seedFileAsync(file, codex);
		await statEntered.promise;
		await fs.promises.appendFile(
			file,
			timestamped("request_user_input", Date.now() + 1),
		);
		const changed = watcher.processFile(file, codex, false);
		statRelease.resolve();
		await Promise.all([seed, changed]);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
		]);
		expect(events[0].cwd).toBe("C:/work");
		expect(watcher.fileStates.get(file)?.offset).toBe((await stat(file)).size);
		walkRelease.resolve();
		if (startupPending) await waitFor(() => watcher.seedComplete);
	});

	test("real watch catches an append after seed", async () => {
		const file = path.join(codex.logsDir, `${randomUUID()}.jsonl`);
		await fs.promises.writeFile(file, line("task_complete"));
		await watcher.seedFileAsync(file, codex);
		await fs.promises.appendFile(file, line("request_user_input"));
		await waitFor(() =>
			events.some((event) => event.eventType === "PermissionRequest"),
		);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
		]);
	});

	test("short reads and split UTF-8 retain complete records", async () => {
		const file = sessionPath();
		const cwd = "C:/work/日本/é";
		const data = line("task_started", cwd) + line("request_user_input", cwd);
		await fs.promises.writeFile(file, data);
		const open = fs.promises.open.bind(fs.promises);
		const lengths: number[] = [];
		spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			const fh = await open(...args);
			const read = fh.read.bind(fh);
			fh.read = (async (
				buffer: Buffer,
				offset: number,
				length: number,
				position: number,
			) => {
				lengths.push(length);
				return read(buffer, offset, Math.min(length, 1), position);
			}) as typeof fh.read;
			return fh;
		});
		await watcher.processFile(file, codex, false);
		expect(events.map((event) => event.eventType)).toEqual([
			"Start",
			"PermissionRequest",
		]);
		expect(events.every((event) => event.cwd === cwd)).toBe(true);
		expect(watcher.fileStates.get(file)?.offset).toBe(Buffer.byteLength(data));
		expect(Math.max(...lengths)).toBeLessThanOrEqual(64 * 1024);
	});

	test("an incomplete UTF-8 record survives separate append passes", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(file, line("task_started"));
		await watcher.seedFileAsync(file, codex);
		const bytes = Buffer.from(line("request_user_input", "C:/日本"));
		const split = bytes.indexOf(Buffer.from("日")) + 1;
		await fs.promises.appendFile(file, bytes.subarray(0, split));
		await watcher.processFile(file, codex, false);
		expect(events).toHaveLength(0);
		expect(Buffer.concat(stateOf(file).leftover)).toEqual(
			bytes.subarray(0, split),
		);
		await fs.promises.appendFile(file, bytes.subarray(split));
		await watcher.processFile(file, codex, false);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
		]);
		expect(watcher.fileStates.get(file)?.leftover.length).toBe(0);
	});

	test("zero-byte EOF commits only bytes actually read", async () => {
		const file = sessionPath();
		const first = line("task_started");
		const last = line("request_user_input");
		await fs.promises.writeFile(file, first + last);
		const open = fs.promises.open.bind(fs.promises);
		const openSpy = spyOn(fs.promises, "open").mockImplementation(
			async (...args) => {
				const fh = await open(...args);
				const read = fh.read.bind(fh);
				fh.read = (async (
					buffer: Buffer,
					offset: number,
					length: number,
					position: number,
				) => {
					if (position >= Buffer.byteLength(first))
						return { bytesRead: 0, buffer };
					return read(
						buffer,
						offset,
						Math.min(length, Buffer.byteLength(first)),
						position,
					);
				}) as typeof fh.read;
				return fh;
			},
		);
		await watcher.processFile(file, codex, false);
		expect(watcher.fileStates.get(file)?.offset).toBe(Buffer.byteLength(first));
		openSpy.mockRestore();
		await watcher.processFile(file, codex, false);
		expect(events.map((event) => event.eventType)).toEqual([
			"Start",
			"PermissionRequest",
		]);
	});

	test("poll detects truncation without a watch event", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(file, line("task_started") + " ".repeat(1000));
		await watcher.seedFileAsync(file, codex);
		await fs.promises.writeFile(file, line("request_user_input"));
		await watcher.pollKnownFilesForGrowth();
		await waitFor(() => events.length === 1);
		expect(events[0].eventType).toBe("PermissionRequest");
		expect(watcher.fileStates.get(file)?.leftover.length).toBe(0);
	});

	test("delete removes known state and recreate reads the new transcript", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(file, line("task_started"));
		await watcher.seedFileAsync(file, codex);
		await fs.promises.unlink(file);
		await watcher.pollKnownFilesForGrowth();
		expect(watcher.fileStates.has(file)).toBe(false);
		await fs.promises.writeFile(file, line("request_user_input"));
		await watcher.processFile(file, codex, false);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
		]);
	});

	test("same-size file replacement resets the offset", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(file, line("task_started"));
		await watcher.seedFileAsync(file, codex);
		const replacement = `${file}.new`;
		await fs.promises.writeFile(replacement, line("turn_aborted"));
		await fs.promises.rename(replacement, file);
		await watcher.pollKnownFilesForGrowth();
		await waitFor(() => events.length === 1);
		expect(events[0].eventType).toBe("Stop");
		expect(watcher.fileStates.get(file)?.offset).toBe(
			Buffer.byteLength(line("turn_aborted")),
		);
	});

	test("poll is single-flight with at most 32 stats and cold files wait 60 seconds", async () => {
		const files = await Promise.all(
			Array.from({ length: 70 }, async () => {
				const file = sessionPath();
				await fs.promises.writeFile(file, line("task_started"));
				await watcher.seedFileAsync(file, codex);
				return file;
			}),
		);
		const stat = fs.promises.stat.bind(fs.promises);
		let active = 0;
		let peak = 0;
		const statSpy = spyOn(fs.promises, "stat").mockImplementation((async (
			...args: Parameters<typeof fs.promises.stat>
		) => {
			active++;
			peak = Math.max(peak, active);
			await yieldToLoop();
			try {
				return await stat(...args);
			} finally {
				active--;
			}
		}) as typeof fs.promises.stat);
		const first = watcher.pollKnownFilesForGrowth();
		expect(watcher.pollKnownFilesForGrowth()).toBe(first);
		await first;
		expect(peak).toBeLessThanOrEqual(32);
		expect(peak).toBeGreaterThan(1);
		statSpy.mockRestore();
		const old = new Date(Date.now() - 2 * 86400000);
		for (const file of files) await fs.promises.utimes(file, old, old);
		await watcher.pollKnownFilesForGrowth();
		const coldStats = spyOn(fs.promises, "stat");
		await watcher.pollKnownFilesForGrowth();
		expect(coldStats).not.toHaveBeenCalled();
		coldStats.mockRestore();
		const file = files[0];
		await fs.promises.appendFile(file, line("request_user_input"));
		stateOf(file).nextPollAt = 0;
		await watcher.pollKnownFilesForGrowth();
		expect(watcher.fileStates.get(file)?.nextPollAt).toBe(0);
		await waitFor(() => events.length === 1);
	});

	test("late mappings, replacement and deletion invalidate the bounded cache", async () => {
		const id = randomUUID();
		const file = path.join(mappingDir, `${id}.json`);
		expect(await watcher.loadPaneMapping(id)).toBeUndefined();
		await fs.promises.writeFile(file, JSON.stringify({ terminalId: "first" }));
		expect((await watcher.loadPaneMapping(id))?.terminalId).toBe("first");
		const reads = spyOn(fs.promises, "readFile");
		await watcher.loadPaneMapping(id);
		expect(reads).not.toHaveBeenCalled();
		reads.mockRestore();
		await fs.promises.writeFile(
			`${file}.new`,
			JSON.stringify({ terminalId: "other" }),
		);
		await fs.promises.rename(`${file}.new`, file);
		expect((await watcher.loadPaneMapping(id))?.terminalId).toBe("other");
		await fs.promises.unlink(file);
		expect(await watcher.loadPaneMapping(id)).toBeUndefined();
		expect(watcher.mappingCache.size).toBe(0);
		for (let i = 0; i < 515; i++) {
			const key = randomUUID();
			await fs.promises.writeFile(path.join(mappingDir, `${key}.json`), "{}");
			await watcher.loadPaneMapping(key);
		}
		expect(watcher.mappingCache.size).toBe(512);
	});

	test("invalid mapping fails loudly without consuming transcript bytes", async () => {
		const file = sessionPath();
		const id = path.basename(file, ".jsonl");
		await fs.promises.writeFile(file, line("request_user_input"));
		await fs.promises.writeFile(
			path.join(mappingDir, `${id}.json`),
			'{"terminalId":42}',
		);
		await expect(watcher.processFile(file, codex, false)).rejects.toThrow(
			"Invalid terminalId",
		);
		expect(watcher.fileStates.get(file)?.offset).toBe(0);
		expect(events).toHaveLength(0);
	});

	// (WATCHER-ASYNC-IO)
	test.each([
		"EBUSY",
		"invalid JSON",
	])("subagent retries a parent mapping failure without losing buffered bytes: %s", async (failure) => {
		const parent = sessionPath();
		const parentId = path.basename(parent, ".jsonl");
		await fs.promises.writeFile(parent, record({ cwd: "C:/parent" }));
		await watcher.seedFileAsync(parent, claude);
		const dir = path.join(casesDir, parentId, "subagents");
		await fs.promises.mkdir(dir, { recursive: true });
		const file = path.join(dir, "agent-retry.jsonl");
		await fs.promises.writeFile(file, "");
		await watcher.seedFileAsync(file, claude);
		const fragment = '{"type":"assistant","text":"';
		await fs.promises.appendFile(file, fragment);
		await watcher.processFile(file, claude, false);
		const state = stateOf(file);
		const offset = state.offset;
		expect(Buffer.concat(state.leftover).toString()).toBe(fragment);
		const mappingFile = path.join(mappingDir, `${parentId}.json`);
		await fs.promises.writeFile(
			mappingFile,
			failure === "invalid JSON" ? "{" : "{}",
		);
		const readFile = fs.promises.readFile.bind(fs.promises);
		let locked = failure === "EBUSY";
		spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
			if (locked && args[0] === mappingFile)
				throw Object.assign(new Error("locked parent mapping"), {
					code: "EBUSY",
				});
			return readFile(...args);
		});
		await fs.promises.appendFile(file, 'working"}\n{"type":"thinking"');
		await expect(watcher.processFile(file, claude, false)).rejects.toThrow();
		expect(state.offset).toBe(offset);
		expect(Buffer.concat(state.leftover).toString()).toBe(fragment);
		expect(events).toHaveLength(0);
		locked = false;
		await fs.promises.writeFile(
			mappingFile,
			JSON.stringify({ terminalId: "parent-terminal" }),
		);
		await watcher.pollKnownFilesForGrowth();
		await waitFor(() => events.length === 1 && state.inFlight === null);
		expect(events[0]).toMatchObject({
			eventType: "SubagentActive",
			sessionId: parentId,
			cwd: "C:/parent",
			terminalId: "parent-terminal",
		});
		expect(state.offset).toBe((await fs.promises.stat(file)).size);
		expect(Buffer.concat(state.leftover).toString()).toBe('{"type":"thinking"');
		await watcher.processFile(file, claude, false);
		expect(events).toHaveLength(1);
	});

	test.each([
		{ seed: true, active: true },
		{ seed: false, active: true },
		{ seed: true, active: false },
		{ seed: false, active: false },
	])("first subagent stat preserves live activity without replaying history: %j", async ({
		seed,
		active,
	}) => {
		const parent = sessionPath();
		const parentId = path.basename(parent, ".jsonl");
		await fs.promises.writeFile(parent, record({ cwd: "C:/parent" }));
		await watcher.seedFileAsync(parent, claude);
		const dir = path.join(
			casesDir,
			parentId,
			"subagents",
			"workflows",
			"wf_test",
		);
		await fs.promises.mkdir(dir, { recursive: true });
		const file = path.join(dir, "agent-first-stat.jsonl");
		const oldActivity = record({
			type: "assistant",
			timestamp: new Date(Date.now() - 60000).toISOString(),
			text: "x".repeat(1000),
		});
		await fs.promises.writeFile(file, oldActivity.repeat(400));
		const entered = deferred();
		const release = deferred();
		const stat = fs.promises.stat.bind(fs.promises);
		let held = false;
		spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
			if (args[0] === file && !held) {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return stat(...args);
		});
		const open = fs.promises.open.bind(fs.promises);
		let bytesRead = 0;
		spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			const fh = await open(...args);
			if (args[0] === file) {
				const read = fh.read.bind(fh);
				fh.read = (async (
					buffer: Buffer,
					offset: number,
					length: number,
					position: number,
				) => {
					expect(length).toBeLessThanOrEqual(64 * 1024);
					const result = await read(buffer, offset, length, position);
					bytesRead += result.bytesRead;
					return result;
				}) as typeof fh.read;
			}
			return fh;
		});
		const first = seed
			? watcher.seedFileAsync(file, claude)
			: watcher.processFile(file, claude, false);
		await entered.promise;
		await fs.promises.appendFile(
			file,
			record({
				type: active ? "assistant" : "user",
				timestamp: new Date(Date.now() + 1).toISOString(),
			}),
		);
		const trailing = watcher.processFile(file, claude, false);
		release.resolve();
		await Promise.all([first, trailing]);
		expect(events.map((event) => event.eventType)).toEqual(
			active ? ["SubagentActive"] : [],
		);
		if (active)
			expect(events[0]).toMatchObject({
				sessionId: parentId,
				cwd: "C:/parent",
			});
		expect(bytesRead).toBe(256 * 1024 + 1);
		expect(watcher.fileStates.get(file)?.offset).toBe((await stat(file)).size);
		await watcher.processFile(file, claude, false);
		expect(events).toHaveLength(active ? 1 : 0);
	});

	// (WATCHER-ASYNC-IO)
	test.each([
		{ active: true },
		{ active: false },
	])("a first subagent read keeps activity that arrived while it queued: %j", async ({
		active,
	}) => {
		const parent = sessionPath();
		const parentId = path.basename(parent, ".jsonl");
		await fs.promises.writeFile(parent, record({ cwd: "C:/parent" }));
		await watcher.seedFileAsync(parent, claude);
		const dir = path.join(casesDir, parentId, "subagents");
		await fs.promises.mkdir(dir, { recursive: true });
		const file = path.join(dir, "agent-queued.jsonl");
		await fs.promises.writeFile(
			file,
			record({
				type: "assistant",
				timestamp: new Date(Date.now() - 60000).toISOString(),
				text: "x".repeat(1000),
			}).repeat(400),
		);
		const blockers: string[] = [];
		for (let i = 0; i < 4; i++) {
			const blocker = sessionPath();
			await fs.promises.writeFile(blocker, record({ cwd: "C:/work" }));
			blockers.push(blocker);
		}
		const release = deferred();
		const open = fs.promises.open.bind(fs.promises);
		let holding = 0;
		spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			if (blockers.includes(args[0] as string)) {
				holding++;
				await release.promise;
			}
			return open(...args);
		});
		const occupied = blockers.map((blocker) =>
			watcher.processFile(blocker, codex, false),
		);
		await waitFor(() => holding === 4);
		const seed = watcher.seedFileAsync(file, claude);
		await fs.promises.appendFile(
			file,
			record({
				type: active ? "assistant" : "user",
				timestamp: new Date().toISOString(),
			}),
		);
		const trailing = watcher.processFile(file, claude, false);
		release.resolve();
		await Promise.all([...occupied, seed, trailing]);
		expect(events.map((event) => event.eventType)).toEqual(
			active ? ["SubagentActive"] : [],
		);
		if (active)
			expect(events[0]).toMatchObject({
				sessionId: parentId,
				cwd: "C:/parent",
			});
		expect(stateOf(file).offset).toBe((await fs.promises.stat(file)).size);
		await watcher.processFile(file, claude, false);
		expect(events).toHaveLength(active ? 1 : 0);
	});

	test("stop and restart ignore a pending reader and close its handle", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(file, line("request_user_input"));
		const entered = deferred();
		const release = deferred();
		const open = fs.promises.open.bind(fs.promises);
		let closes = 0;
		const openSpy = spyOn(fs.promises, "open").mockImplementation(
			async (...args) => {
				const fh = await open(...args);
				const close = fh.close.bind(fh);
				fh.close = async () => {
					closes++;
					await close();
				};
				entered.resolve();
				await release.promise;
				return fh;
			},
		);
		const oldRead = watcher.processFile(file, codex, false);
		await entered.promise;
		stopAgentJsonlWatcher();
		openSpy.mockRestore();
		start();
		await waitFor(() => watcher.seedComplete);
		await watcher.seedFileAsync(file, codex);
		const owned = watcher.fileStates.get(file);
		release.resolve();
		await oldRead;
		expect(closes).toBe(1);
		expect(watcher.fileStates.get(file)).toBe(owned);
		expect(events).toHaveLength(0);
		await fs.promises.appendFile(file, line("task_started"));
		await watcher.processFile(file, codex, false);
		expect(events.map((event) => event.eventType)).toEqual(["Start"]);
	});

	test("a pending seed cannot overwrite replacement ownership", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(file, line("task_complete"));
		const entered = deferred();
		const release = deferred();
		const open = fs.promises.open.bind(fs.promises);
		const openSpy = spyOn(fs.promises, "open").mockImplementation(
			async (...args) => {
				const fh = await open(...args);
				entered.resolve();
				await release.promise;
				return fh;
			},
		);
		const seed = watcher.seedFileAsync(file, codex);
		await entered.promise;
		watcher.fileStates.delete(file);
		openSpy.mockRestore();
		await watcher.processFile(file, codex, false);
		const owned = watcher.fileStates.get(file);
		release.resolve();
		await seed;
		expect(watcher.fileStates.get(file)).toBe(owned);
		expect(events.map((event) => event.eventType)).toEqual(["Stop"]);
	});

	test("stopping a pending seed scan never re-arms discovery", async () => {
		stopAgentJsonlWatcher();
		const entered = deferred();
		const release = deferred();
		const readdir = fs.promises.readdir.bind(fs.promises);
		let held = false;
		spyOn(fs.promises, "readdir").mockImplementation((async (
			dir: fs.PathLike,
			options: { withFileTypes: true },
		) => {
			const entries = await readdir(dir, options);
			if (!held && dir === claude.logsDir) {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return entries;
		}) as typeof fs.promises.readdir);
		start();
		await entered.promise;
		stopAgentJsonlWatcher();
		release.resolve();
		await yieldToLoop();
		await yieldToLoop();
		expect(watcher.seedComplete).toBe(false);
		expect(watcher.discoverTimerArmed).toBe(false);
		expect(watcher.fileStates.size).toBe(0);
	});

	test("startup fence survives a failed read, unknown cwd and eventual advance", async () => {
		stopAgentJsonlWatcher();
		const file = sessionPath();
		const oldTimestamp = Date.now() - 10000;
		await fs.promises.writeFile(
			file,
			`${"x".repeat(300000)}\n${apiError(oldTimestamp).repeat(1600)}`,
		);
		await delay(5);
		const entered = deferred();
		const release = deferred();
		const readdir = fs.promises.readdir.bind(fs.promises);
		const walkSpy = spyOn(fs.promises, "readdir").mockImplementation((async (
			dir: fs.PathLike,
			options: { withFileTypes: true },
		) => {
			if (dir === claude.logsDir) {
				entered.resolve();
				await release.promise;
			}
			return readdir(dir, options);
		}) as typeof fs.promises.readdir);
		start();
		await entered.promise;
		await fs.promises.appendFile(file, apiError(Date.now() + 1));
		const openSpy = spyOn(fs.promises, "open").mockRejectedValueOnce(
			Object.assign(new Error("locked"), { code: "EBUSY" }),
		);
		await expect(watcher.processFile(file, claude, false)).rejects.toThrow(
			"locked",
		);
		openSpy.mockRestore();
		const state = stateOf(file);
		const fence = state.preStartFenceMs;
		const offset = state.offset;
		expect(fence).not.toBeNull();
		expect(offset).toBeGreaterThan(0);
		await watcher.processFile(file, claude, false);
		expect(state.preStartFenceMs).toBe(fence);
		expect(state.offset).toBe(offset);
		expect(errors).toHaveLength(0);
		await fs.promises.appendFile(file, record({ cwd: "C:/work" }));
		await watcher.processFile(file, claude, false);
		expect(state.preStartFenceMs).toBeNull();
		expect(state.offset).toBe((await fs.promises.stat(file)).size);
		expect(errors).toHaveLength(1);
		await fs.promises.appendFile(file, apiError(oldTimestamp));
		await watcher.processFile(file, claude, false);
		expect(errors).toHaveLength(2);
		release.resolve();
		await waitFor(() => watcher.seedComplete);
		walkSpy.mockRestore();
	});

	test("complete records are emitted and released before the next read", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(file, line("task_complete"));
		await watcher.seedFileAsync(file, codex);
		const startOffset = stateOf(file).offset;
		await fs.promises.appendFile(
			file,
			line("request_user_input") + paddingRecords(500) + line("task_complete"),
		);
		const open = fs.promises.open.bind(fs.promises);
		let checkedBeforeEof = false;
		spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			const fh = await open(...args);
			const read = fh.read.bind(fh);
			fh.read = (async (
				buffer: Buffer,
				offset: number,
				length: number,
				position: number,
			) => {
				if (position > startOffset) {
					checkedBeforeEof = true;
					expect(events.map((event) => event.eventType)).toEqual([
						"PermissionRequest",
					]);
					expect(watcher.fileStates.get(file)?.offset).toBe(position);
					expect(length).toBeLessThanOrEqual(64 * 1024);
				}
				return read(buffer, offset, length, position);
			}) as typeof fh.read;
			return fh;
		});
		await watcher.processFile(file, codex, false);
		expect(checkedBeforeEof).toBe(true);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
			"Stop",
		]);
	});

	test("a late cwd replays discarded batches without losing their events", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(
			file,
			record({ type: "event_msg", payload: { type: "request_user_input" } }) +
				paddingRecords(300) +
				line("task_complete"),
		);
		await watcher.processFile(file, codex, false);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
			"Stop",
		]);
		expect(watcher.fileStates.get(file)?.offset).toBe(
			(await fs.promises.stat(file)).size,
		);
	});

	test("a failed later read retains only the committed partial record", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(file, line("task_complete"));
		await watcher.seedFileAsync(file, codex);
		const startOffset = stateOf(file).offset;
		const append =
			line("request_user_input") +
			record({ padding: "x".repeat(150000) }) +
			line("task_complete");
		await fs.promises.appendFile(file, append);
		const open = fs.promises.open.bind(fs.promises);
		const reads = spyOn(fs.promises, "open").mockImplementation(
			async (...args) => {
				const fh = await open(...args);
				const read = fh.read.bind(fh);
				fh.read = (async (
					buffer: Buffer,
					offset: number,
					length: number,
					position: number,
				) => {
					if (position >= startOffset + 2 * 64 * 1024)
						throw Object.assign(new Error("locked read"), { code: "EBUSY" });
					return read(buffer, offset, length, position);
				}) as typeof fh.read;
				return fh;
			},
		);
		await expect(watcher.processFile(file, codex, false)).rejects.toThrow(
			"locked read",
		);
		const state = stateOf(file);
		expect(state.offset).toBe(startOffset + 2 * 64 * 1024);
		expect(Buffer.concat(state.leftover)).toEqual(
			Buffer.from(append).subarray(
				Buffer.byteLength(line("request_user_input")),
				2 * 64 * 1024,
			),
		);
		reads.mockRestore();
		await watcher.processFile(file, codex, false);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
			"Stop",
		]);
		expect(state.leftover).toHaveLength(0);
	});

	test("bounded read steps yield during a large append", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(
			file,
			record({ cwd: "C:/work" }) +
				paddingRecords(300) +
				line("request_user_input"),
		);
		const open = fs.promises.open.bind(fs.promises);
		let maxRead = 0;
		let reads = 0;
		spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			const fh = await open(...args);
			const read = fh.read.bind(fh);
			fh.read = (async (
				buffer: Buffer,
				offset: number,
				length: number,
				position: number,
			) => {
				maxRead = Math.max(maxRead, length);
				reads++;
				return read(buffer, offset, length, position);
			}) as typeof fh.read;
			return fh;
		});
		await watcher.processFile(file, codex, false);
		expect(reads).toBeGreaterThan(4);
		expect(maxRead).toBeLessThanOrEqual(64 * 1024);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
		]);
	});

	test("a locked seed header is reported without blocking later appends", async () => {
		const file = sessionPath();
		const history = line("task_complete");
		await fs.promises.writeFile(file, history);
		const logged = spyOn(console, "error").mockImplementation(() => {});
		const open = spyOn(fs.promises, "open").mockRejectedValueOnce(
			Object.assign(new Error("locked header"), { code: "EBUSY" }),
		);
		await watcher.seedFileAsync(file, codex);
		open.mockRestore();
		expect(logged).toHaveBeenCalledTimes(1);
		expect(watcher.fileStates.get(file)?.offset).toBe(
			Buffer.byteLength(history),
		);
		await fs.promises.appendFile(file, line("request_user_input"));
		await watcher.processFile(file, codex, false);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
		]);
	});

	test("a denied stat does not starve later polling batches", async () => {
		const files: string[] = [];
		for (let i = 0; i < 40; i++) {
			const file = sessionPath();
			await fs.promises.writeFile(file, line("task_complete"));
			await watcher.seedFileAsync(file, codex);
			files.push(file);
		}
		await fs.promises.appendFile(files[39], line("request_user_input"));
		const stat = fs.promises.stat.bind(fs.promises);
		spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
			if (args[0] === files[0])
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			return stat(...args);
		});
		await expect(watcher.pollKnownFilesForGrowth()).rejects.toThrow(
			"Transcript stat sweep failed",
		);
		await waitFor(() => events.length === 1);
		expect(events[0].eventType).toBe("PermissionRequest");
	});

	test("truncation replay guard survives a mapping failure", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(
			file,
			record({ cwd: "C:/work", padding: "x".repeat(300000) }),
		);
		await watcher.seedFileAsync(file, claude);
		await fs.promises.writeFile(
			file,
			apiError(Date.now(), "C:/work").repeat(1600),
		);
		const id = path.basename(file, ".jsonl");
		await fs.promises.writeFile(path.join(mappingDir, `${id}.json`), "{");
		await expect(watcher.processFile(file, claude, false)).rejects.toThrow();
		expect(watcher.fileStates.get(file)?.replayReset).toBe(true);
		await fs.promises.writeFile(path.join(mappingDir, `${id}.json`), "{}");
		await watcher.processFile(file, claude, false);
		expect(errors).toHaveLength(0);
		expect(watcher.fileStates.get(file)?.replayReset).toBe(false);
	});

	// (WATCHER-ASYNC-IO)
	test("an empty truncation releases the replay guard for the next live append", async () => {
		const file = sessionPath();
		await fs.promises.writeFile(
			file,
			record({ cwd: "C:/work" }) + apiError(Date.now() - 60000, "C:/work"),
		);
		await watcher.seedFileAsync(file, claude);
		await fs.promises.writeFile(file, "");
		await watcher.processFile(file, claude, false);
		const state = stateOf(file);
		expect(state.offset).toBe(0);
		expect(state.replayReset).toBe(false);
		expect(state.preStartFenceMs).toBeNull();
		expect(errors).toHaveLength(0);
		await fs.promises.appendFile(file, apiError(Date.now(), "C:/work"));
		await watcher.processFile(file, claude, false);
		expect(errors).toEqual([
			{
				sessionId: path.basename(file, ".jsonl"),
				cwd: "C:/work",
				terminalId: undefined,
				workspaceId: undefined,
				transcriptPath: file,
			},
		]);
	});

	test("seed retries a failed directory without replaying history", async () => {
		stopAgentJsonlWatcher();
		const file = path.join(codex.logsDir, `${randomUUID()}.jsonl`);
		await fs.promises.writeFile(file, line("request_user_input"));
		await delay(5);
		const readdir = fs.promises.readdir.bind(fs.promises);
		let failed = false;
		spyOn(fs.promises, "readdir").mockImplementation(async (...args) => {
			if (!failed && args[0] === codex.logsDir) {
				failed = true;
				throw Object.assign(new Error("busy"), { code: "EBUSY" });
			}
			return readdir(...args);
		});
		const logged = spyOn(console, "error").mockImplementation(() => {});
		start();
		await waitFor(() => logged.mock.calls.length > 0);
		expect(watcher.seedComplete).toBe(false);
		await waitFor(() => watcher.seedComplete);
		expect(watcher.discoverTimerArmed).toBe(true);
		expect(watcher.fileStates.has(file)).toBe(true);
		expect(events).toHaveLength(0);
	});

	test("Codex idle transition retries a transient mapping failure", async () => {
		const file = sessionPath();
		const id = path.basename(file, ".jsonl");
		await fs.promises.writeFile(file, line("task_started"));
		await watcher.processFile(file, codex, false);
		await fs.promises.writeFile(path.join(mappingDir, `${id}.json`), "{");
		const logged = spyOn(console, "error").mockImplementation(() => {});
		const realSetTimeout = globalThis.setTimeout;
		let retry:
			| { fire: () => void; timer: ReturnType<typeof setTimeout> }
			| undefined;
		spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			delayMs?: number,
		) => {
			if (delayMs === 2500) {
				const timer = realSetTimeout(() => {}, 45000);
				retry = { fire: callback, timer };
				return timer;
			}
			return realSetTimeout(callback, delayMs);
		}) as typeof setTimeout);
		watcher.scheduleIdleTimer(id, "C:/work", undefined, 1);
		await waitFor(() => retry !== undefined);
		expect(logged).toHaveBeenCalledTimes(1);
		expect(events.map((event) => event.eventType)).toEqual(["Start"]);
		await fs.promises.writeFile(path.join(mappingDir, `${id}.json`), "{}");
		if (!retry) throw new Error("Missing idle retry");
		clearTimeout(retry.timer);
		retry.fire();
		await waitFor(() => events.length === 2);
		expect(events.map((event) => event.eventType)).toEqual(["Start", "Stop"]);
	});

	test("transcript readers share four slots across files", async () => {
		const files: string[] = [];
		for (let i = 0; i < 12; i++) {
			const file = sessionPath();
			await fs.promises.writeFile(file, line("request_user_input"));
			files.push(file);
		}
		const release = deferred();
		const open = fs.promises.open.bind(fs.promises);
		let active = 0;
		let peak = 0;
		spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			const fh = await open(...args);
			active++;
			peak = Math.max(peak, active);
			const close = fh.close.bind(fh);
			fh.close = async () => {
				await close();
				active--;
			};
			await release.promise;
			return fh;
		});
		const reads = files.map((file) => watcher.processFile(file, codex, false));
		await waitFor(() => active === 4);
		release.resolve();
		await Promise.all(reads);
		expect(peak).toBe(4);
		expect(events).toHaveLength(12);
	});

	test("Claude seed observes an append received before stat completes", async () => {
		stopAgentJsonlWatcher();
		const file = sessionPath();
		await fs.promises.writeFile(file, apiError(Date.now() - 10000, "C:/work"));
		await delay(5);
		const walkEntered = deferred();
		const walkRelease = deferred();
		const readdir = fs.promises.readdir.bind(fs.promises);
		spyOn(fs.promises, "readdir").mockImplementation(async (...args) => {
			if (args[0] === claude.logsDir) {
				walkEntered.resolve();
				await walkRelease.promise;
			}
			return readdir(...args);
		});
		start();
		await walkEntered.promise;
		const statEntered = deferred();
		const statRelease = deferred();
		const stat = fs.promises.stat.bind(fs.promises);
		let held = false;
		spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
			if (!held && args[0] === file) {
				held = true;
				statEntered.resolve();
				await statRelease.promise;
			}
			return stat(...args);
		});
		const seed = watcher.seedFileAsync(file, claude);
		await statEntered.promise;
		await fs.promises.appendFile(file, apiError(Date.now() + 1, "C:/work"));
		const changed = watcher.processFile(file, claude, false);
		statRelease.resolve();
		await Promise.all([seed, changed]);
		expect(errors).toHaveLength(1);
		walkRelease.resolve();
		await waitFor(() => watcher.seedComplete);
	});

	test("a large unfinished record is assembled once instead of on every read", async () => {
		const file = sessionPath();
		const data =
			record({ cwd: "C:/work", padding: "x".repeat(2 * 1024 * 1024) }) +
			line("request_user_input");
		await fs.promises.writeFile(file, data);
		const concat = Buffer.concat.bind(Buffer);
		let copied = 0;
		spyOn(Buffer, "concat").mockImplementation((buffers, length) => {
			copied +=
				length ?? buffers.reduce((sum, buffer) => sum + buffer.length, 0);
			return concat(buffers, length);
		});
		await watcher.processFile(file, codex, false);
		expect(copied).toBeLessThan(Buffer.byteLength(data) * 2);
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
		]);
	});

	test("a failed Claude discovery still visits Codex", async () => {
		const file = path.join(codex.logsDir, `${randomUUID()}.jsonl`);
		await fs.promises.writeFile(file, line("request_user_input"));
		const readdir = fs.promises.readdir.bind(fs.promises);
		const reads = spyOn(fs.promises, "readdir").mockImplementation(
			async (...args) => {
				if (args[0] === claude.logsDir)
					throw Object.assign(new Error("denied"), { code: "EACCES" });
				return readdir(...args);
			},
		);
		await expect(watcher.discoverNewFilesAsync()).rejects.toThrow(
			"Transcript discovery failed",
		);
		expect(reads.mock.calls.some(([dir]) => dir === codex.logsDir)).toBe(true);
		expect(watcher.fileStates.has(file)).toBe(true);
		await stateOf(file).inFlight;
		expect(events.map((event) => event.eventType)).toEqual([
			"PermissionRequest",
		]);
	});
});
