import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";

import { SerializeAddon } from "@xterm/addon-serialize";
import { HeadlessTerminal } from "../../../../../../packages/host-service/src/terminal/headless-xterm";

mock.module("renderer/lib/trpc-client", () => ({
	electronTrpcClient: {
		keyboardLayout: {
			changes: { subscribe: () => {} },
		},
	},
}));

const { terminalRuntimeRegistry } = await import("./terminal-runtime-registry");
const runtimeModule = await import("./terminal-runtime");
const { terminalMeasurementsChanged, tryPersistRuntimeState } = runtimeModule;
const { createTransport } = await import("./terminal-ws-transport");

interface FakeStorageState {
	values: Map<string, string>;
	storage: Storage;
}

function createFakeStorage(): FakeStorageState {
	const values = new Map<string, string>();
	const storage = {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key: string) => values.get(key) ?? null,
		key: (index: number) => Array.from(values.keys())[index] ?? null,
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
	} as Storage;
	return { values, storage };
}

const originalLocalStorage = globalThis.localStorage;
let fakeStorage: FakeStorageState;

beforeEach(() => {
	fakeStorage = createFakeStorage();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: fakeStorage.storage,
	});
});

afterEach(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: originalLocalStorage,
	});
});

describe("terminalRuntimeRegistry eviction cleanup", () => {
	test("refits for every cell-measurement typography change", () => {
		const appearance = {
			theme: {},
			background: "#000",
			fontFamily: "monospace",
			fontSize: 14,
			lineHeight: 1,
			letterSpacing: 0,
			fontWeight: "normal" as const,
			ligatures: true,
			minimumContrastRatio: 1,
			cursorStyle: "block" as const,
			cursorBlink: true,
		};
		const runtime = {
			terminal: {
				options: {
					fontFamily: appearance.fontFamily,
					fontSize: appearance.fontSize,
					lineHeight: appearance.lineHeight,
					letterSpacing: appearance.letterSpacing,
					fontWeight: appearance.fontWeight,
				},
			},
			ligaturesEnabled: appearance.ligatures,
		} as Parameters<typeof terminalMeasurementsChanged>[0];

		expect(terminalMeasurementsChanged(runtime, appearance)).toBe(false);
		for (const change of [
			{ fontSize: 15.5 },
			{ lineHeight: 1.2 },
			{ letterSpacing: 0.5 },
			{ fontWeight: 500 },
			{ ligatures: false },
		]) {
			expect(
				terminalMeasurementsChanged(runtime, { ...appearance, ...change }),
			).toBe(true);
		}
	});

	test("updates active and parked runtime appearance overrides", () => {
		const entries = (
			terminalRuntimeRegistry as unknown as {
				entries: Map<string, unknown>;
			}
		).entries;
		const addedKeys: string[] = [];
		const setLigatures = mock(() => {});

		for (const [index, container] of [
			[0, {} as HTMLDivElement],
			[1, null],
		] as const) {
			const terminalId = `appearance-${index}`;
			const key = `${terminalId}\u0000${terminalId}`;
			addedKeys.push(key);
			entries.set(key, {
				terminalId,
				instanceId: terminalId,
				runtime: {
					container,
					wrapper: {
						style: { setProperty: mock(() => {}) },
					} as unknown as HTMLDivElement,
					terminal: {
						options: {
							fontFamily: "monospace",
							fontSize: 14,
							lineHeight: 1,
							letterSpacing: 0,
							fontWeight: "normal",
						},
						rows: 24,
						refresh: mock(() => {}),
					},
					ligaturesEnabled: true,
					_setLigaturesEnabled: setLigatures,
				},
				transport: {},
			});
		}

		try {
			terminalRuntimeRegistry.updateAllAppearances({
				theme: { background: "#000" },
				background: "#000",
				fontFamily: "monospace",
				fontSize: 15.5,
				lineHeight: 1.2,
				letterSpacing: 0.5,
				fontWeight: 500,
				ligatures: false,
				minimumContrastRatio: 4.5,
				cursorStyle: "bar",
				cursorBlink: false,
			});

			for (const key of addedKeys) {
				const entry = entries.get(key) as {
					runtime: {
						terminal: { options: Record<string, unknown> };
						ligaturesEnabled: boolean;
					};
				};
				expect(entry.runtime.terminal.options).toMatchObject({
					fontSize: 15.5,
					lineHeight: 1.2,
					letterSpacing: 0.5,
					fontWeight: 500,
					minimumContrastRatio: 4.5,
					cursorStyle: "bar",
					cursorBlink: false,
				});
				expect(entry.runtime.ligaturesEnabled).toBe(false);
			}
			expect(setLigatures).toHaveBeenCalledTimes(2);
		} finally {
			for (const key of addedKeys) entries.delete(key);
		}
	});

	test("keeps a runtime when dimensions fail to persist", () => {
		const terminalId = "dimensions-write-failure";
		const setItem = fakeStorage.storage.setItem.bind(fakeStorage.storage);
		fakeStorage.storage.setItem = (key: string, value: string) => {
			if (key === `terminal-dims:${terminalId}`) {
				throw new Error("dimensions write failed");
			}
			setItem(key, value);
		};
		const runtime = {
			terminalId,
			serializeAddon: { serialize: () => "serialized scrollback" },
			lastCols: 120,
			lastRows: 32,
		};

		expect(
			tryPersistRuntimeState(
				runtime as Parameters<typeof tryPersistRuntimeState>[0],
			),
		).toBe(false);
		expect(fakeStorage.values.get(`terminal-buffer:${terminalId}`)).toBe(
			"serialized scrollback",
		);
		expect(fakeStorage.values.has(`terminal-dims:${terminalId}`)).toBe(false);
	});

	test("release keeps runtimes on persist failure and warns once per terminal", () => {
		const terminalIds = ["release-failure-a", "release-failure-b"];
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		const entries = terminalIds.map((terminalId) => ({
			terminalId,
			instanceId: terminalId,
			runtime: {
				terminalId,
				serializeAddon: { serialize: () => "serialized scrollback" },
				lastCols: 120,
				lastRows: 32,
			},
			transport: {},
			linkManager: null,
			pendingLinkHandlers: null,
			disposeBufferChangeListener: null,
			lastUsedAt: 1,
		}));
		const registryInternals = terminalRuntimeRegistry as unknown as {
			entries: Map<string, (typeof entries)[number]>;
			entryKeysByTerminalId: Map<string, Set<string>>;
			persistFailureWarnedTerminalIds: Set<string>;
		};
		fakeStorage.storage.setItem = () => {
			throw new Error("storage unavailable");
		};

		for (const entry of entries) {
			const key = `${entry.terminalId}\u0000${entry.instanceId}`;
			registryInternals.entries.set(key, entry);
			registryInternals.entryKeysByTerminalId.set(
				entry.terminalId,
				new Set([key]),
			);
		}

		try {
			terminalRuntimeRegistry.release(terminalIds[0]);
			terminalRuntimeRegistry.release(terminalIds[0]);
			terminalRuntimeRegistry.release(terminalIds[1]);

			expect(terminalRuntimeRegistry.has(terminalIds[0])).toBe(true);
			expect(terminalRuntimeRegistry.has(terminalIds[1])).toBe(true);
			expect(warnSpy).toHaveBeenCalledTimes(2);
			expect(warnSpy.mock.calls.map((call) => call[0])).toEqual([
				`[terminal-registry] state persist failed for ${terminalIds[0]}; keeping runtime alive (localStorage quota?)`,
				`[terminal-registry] state persist failed for ${terminalIds[1]}; keeping runtime alive (localStorage quota?)`,
			]);
		} finally {
			for (const entry of entries) {
				const key = `${entry.terminalId}\u0000${entry.instanceId}`;
				registryInternals.entries.delete(key);
				registryInternals.entryKeysByTerminalId.delete(entry.terminalId);
				registryInternals.persistFailureWarnedTerminalIds.delete(
					entry.terminalId,
				);
			}
			warnSpy.mockRestore();
		}
	});

	test("release persists once before disposing a runtime", () => {
		const terminalId = "release-success";
		const entry = {
			terminalId,
			instanceId: terminalId,
			runtime: {
				terminalId,
				serializeAddon: { serialize: () => "serialized scrollback" },
				lastCols: 120,
				lastRows: 32,
				gate: { pending: 0 },
				terminal: { buffer: { active: { type: "normal" } } },
			},
			transport: {},
			linkManager: null,
			pendingLinkHandlers: null,
			disposeBufferChangeListener: null,
			lastUsedAt: 1,
		};
		const registryInternals = terminalRuntimeRegistry as unknown as {
			entries: Map<string, typeof entry>;
			entryKeysByTerminalId: Map<string, Set<string>>;
			persistFailureWarnedTerminalIds: Set<string>;
			disposeEntry: (
				disposedEntry: typeof entry,
				options: { persistedState?: "clear" | "preserve" },
			) => void;
		};
		const entryKey = `${terminalId}\u0000${terminalId}`;
		const disposeCalls: { persistedState?: "clear" | "preserve" }[] = [];
		registryInternals.entries.set(entryKey, entry);
		registryInternals.entryKeysByTerminalId.set(
			terminalId,
			new Set([entryKey]),
		);
		registryInternals.persistFailureWarnedTerminalIds.add(terminalId);
		registryInternals.disposeEntry = (_entry, options) => {
			disposeCalls.push(options);
		};

		try {
			terminalRuntimeRegistry.release(terminalId);

			expect(fakeStorage.values.get(`terminal-buffer:${terminalId}`)).toBe(
				"serialized scrollback",
			);
			expect(fakeStorage.values.get(`terminal-dims:${terminalId}`)).toBe(
				JSON.stringify({ cols: 120, rows: 32 }),
			);
			expect(disposeCalls).toEqual([{ persistedState: "preserve" }]);
			expect(
				registryInternals.persistFailureWarnedTerminalIds.has(terminalId),
			).toBe(false);
		} finally {
			delete (terminalRuntimeRegistry as unknown as { disposeEntry?: unknown })
				.disposeEntry;
			registryInternals.entries.delete(entryKey);
			registryInternals.entryKeysByTerminalId.delete(terminalId);
			registryInternals.persistFailureWarnedTerminalIds.delete(terminalId);
		}
	});

	test("release disposes with clear and never persists an ended session", () => {
		const terminalId = "release-session-ended";
		const serialize = mock(() => "dead session scrollback");
		const entry = {
			terminalId,
			instanceId: terminalId,
			runtime: {
				terminalId,
				serializeAddon: { serialize },
				lastCols: 120,
				lastRows: 32,
			},
			transport: { sessionEnded: true },
			linkManager: null,
			pendingLinkHandlers: null,
			disposeBufferChangeListener: null,
			lastUsedAt: 1,
		};
		const registryInternals = terminalRuntimeRegistry as unknown as {
			entries: Map<string, typeof entry>;
			entryKeysByTerminalId: Map<string, Set<string>>;
			disposeEntry: (
				disposedEntry: typeof entry,
				options: { persistedState?: "clear" | "preserve" },
			) => void;
		};
		const entryKey = `${terminalId}\u0000${terminalId}`;
		const disposeCalls: { persistedState?: "clear" | "preserve" }[] = [];
		registryInternals.entries.set(entryKey, entry);
		registryInternals.entryKeysByTerminalId.set(
			terminalId,
			new Set([entryKey]),
		);
		registryInternals.disposeEntry = (_entry, options) => {
			disposeCalls.push(options);
		};

		try {
			terminalRuntimeRegistry.release(terminalId);

			expect(serialize).not.toHaveBeenCalled();
			expect(fakeStorage.values.has(`terminal-buffer:${terminalId}`)).toBe(
				false,
			);
			expect(disposeCalls).toEqual([{ persistedState: "clear" }]);
		} finally {
			delete (terminalRuntimeRegistry as unknown as { disposeEntry?: unknown })
				.disposeEntry;
			registryInternals.entries.delete(entryKey);
			registryInternals.entryKeysByTerminalId.delete(terminalId);
		}
	});

	test("dispose clears persisted state even when eviction already removed the entry", () => {
		const terminalId = "evicted-terminal";
		fakeStorage.values.set(`terminal-buffer:${terminalId}`, "scrollback");
		fakeStorage.values.set(
			`terminal-dims:${terminalId}`,
			JSON.stringify({ cols: 120, rows: 32 }),
		);

		expect(terminalRuntimeRegistry.has(terminalId)).toBe(false);
		terminalRuntimeRegistry.dispose(terminalId);

		expect(fakeStorage.values.has(`terminal-buffer:${terminalId}`)).toBe(false);
		expect(fakeStorage.values.has(`terminal-dims:${terminalId}`)).toBe(false);
	});

	test("reschedules eviction when a parked terminal changes buffers", () => {
		let emitBufferChange: () => void = () => {
			throw new Error("buffer listener was not installed");
		};
		let listenerDisposed = false;
		const runtime = {
			container: {} as HTMLDivElement | null,
			terminal: {
				buffer: {
					onBufferChange: (listener: () => void) => {
						emitBufferChange = listener;
						return { dispose: () => (listenerDisposed = true) };
					},
				},
			},
		};
		const entry = {
			runtime,
			disposeBufferChangeListener: null as (() => void) | null,
		};
		const registryInternals = terminalRuntimeRegistry as unknown as {
			observeBufferChanges: (observedEntry: typeof entry) => void;
			pendingEviction: ReturnType<typeof setTimeout> | null;
		};

		if (registryInternals.pendingEviction !== null) {
			clearTimeout(registryInternals.pendingEviction);
			registryInternals.pendingEviction = null;
		}
		registryInternals.observeBufferChanges(entry);
		emitBufferChange();
		expect(registryInternals.pendingEviction).toBeNull();

		runtime.container = null;
		emitBufferChange();
		expect(registryInternals.pendingEviction).not.toBeNull();

		if (registryInternals.pendingEviction !== null) {
			clearTimeout(registryInternals.pendingEviction);
			registryInternals.pendingEviction = null;
		}
		entry.disposeBufferChangeListener?.();
		expect(listenerDisposed).toBe(true);
	});

	test("defers eviction while flushed output is still being parsed", () => {
		const terminalId = "parser-busy-terminal";
		let flushed = false;
		const gate = { pending: 1, queued: null as (() => void) | null };
		const entry = {
			terminalId,
			instanceId: terminalId,
			runtime: {
				container: null,
				gate,
				terminal: { buffer: { active: { type: "normal" } } },
			},
			transport: {
				_writeCoalescer: {
					flushSync: () => {
						flushed = true;
					},
				},
			},
			linkManager: null,
			pendingLinkHandlers: null,
			lastUsedAt: 1,
		};
		const registryInternals = terminalRuntimeRegistry as unknown as {
			entries: Map<string, typeof entry>;
			evictExcessParkedRuntimes: () => void;
		};
		const entryKey = `${terminalId}\u0000${terminalId}`;
		registryInternals.entries.set(entryKey, entry);

		try {
			registryInternals.evictExcessParkedRuntimes();

			expect(flushed).toBe(true);
			expect(gate.queued).not.toBeNull();
			expect(registryInternals.entries.has(entryKey)).toBe(true);
		} finally {
			registryInternals.entries.delete(entryKey);
		}
	});
});

describe("terminal replacement history", () => {
	test("distinguishes session death from transport termination and bounds restored history", () => {
		const serialize = mock(() => "previous output");
		const previous = {
			transport: { sessionEnded: false, _terminated: true },
			runtime: { serializeAddon: { serialize } },
		};
		const replacement: { initialBuffer?: string } = {};
		const internals = terminalRuntimeRegistry as unknown as {
			getEntry: () => typeof previous;
			getOrCreateEntry: () => typeof replacement;
		};
		const getEntry = spyOn(internals, "getEntry").mockReturnValue(previous);
		const getOrCreate = spyOn(internals, "getOrCreateEntry").mockReturnValue(
			replacement,
		);
		try {
			expect(terminalRuntimeRegistry.isSessionEnded("old", "pane")).toBe(false);
			terminalRuntimeRegistry.prepareReplacement(
				"old",
				"pane",
				"New shell",
			)("new");
			expect(getOrCreate).not.toHaveBeenCalled();
			previous.transport.sessionEnded = true;
			expect(terminalRuntimeRegistry.isSessionEnded("old", "pane")).toBe(true);
			const apply = terminalRuntimeRegistry.prepareReplacement(
				"old",
				"pane",
				"New shell",
			);
			expect(getOrCreate).not.toHaveBeenCalled();
			getEntry.mockReturnValue(undefined as unknown as typeof previous);
			apply("new");
			expect(serialize).toHaveBeenCalledWith({
				scrollback: 1000,
				excludeAltBuffer: true,
				excludeModes: true,
			});
			expect(getOrCreate).toHaveBeenCalledWith("new", "pane");
			expect(replacement.initialBuffer).toBe(
				"previous output\r\n\x1b[0mNew shell\r\n",
			);
		} finally {
			getEntry.mockRestore();
			getOrCreate.mockRestore();
		}
	});
});

describe("terminalRuntimeRegistry copy selection", () => {
	test("uses the same copy policy without treating selected spaces as no selection", () => {
		const entries = (
			terminalRuntimeRegistry as unknown as { entries: Map<string, unknown> }
		).entries;
		const terminalId = "copy-policy-test";
		const key = `${terminalId}\u0000${terminalId}`;
		let selection = "foo   \r\nbar\u3000  ";
		entries.set(key, {
			terminalId,
			instanceId: terminalId,
			runtime: {
				terminal: {
					getSelection: () => selection,
					getSelectionPosition: () => ({
						start: { x: 0, y: 0 },
						end: { x: 9, y: 1 },
					}),
					_core: { _selectionService: { _activeSelectionMode: 0 } },
					buffer: {
						active: {
							getLine: () => ({
								translateToString: () => "",
								isWrapped: false,
							}),
						},
					},
				},
			},
		});
		try {
			expect(terminalRuntimeRegistry.getSelection(terminalId, terminalId)).toBe(
				"foo\r\nbar\u3000",
			);
			selection = "   ";
			expect(terminalRuntimeRegistry.getSelection(terminalId, terminalId)).toBe(
				"   ",
			);
		} finally {
			entries.delete(key);
		}
		expect(terminalRuntimeRegistry.getSelection(terminalId, terminalId)).toBe(
			"",
		);
	});
});

// (ALT-SNAPSHOT-RESTORE)
describe("parked-runtime persistence and the alternate-screen exemption", () => {
	type Runtime = import("./terminal-runtime").TerminalRuntime;
	type Entry = {
		terminalId: string;
		instanceId: string;
		runtime: Runtime;
		transport: import("./terminal-ws-transport").TerminalTransport;
		lastUsedAt: number;
	};
	const internals = terminalRuntimeRegistry as unknown as {
		entries: Map<string, Entry>;
		entryKeysByTerminalId: Map<string, Set<string>>;
		parkedRuntimeCap: number;
		pendingEviction: ReturnType<typeof setTimeout> | null;
		persistFailureWarnedTerminalIds: Set<string>;
		evictExcessParkedRuntimes(): void;
	};
	let previousCap: number;
	const ownedIds = new Set<string>();

	beforeEach(() => {
		previousCap = internals.parkedRuntimeCap;
		internals.parkedRuntimeCap = 1;
	});

	afterEach(() => {
		for (const terminalId of ownedIds) {
			terminalRuntimeRegistry.dispose(terminalId);
			internals.persistFailureWarnedTerminalIds.delete(terminalId);
		}
		ownedIds.clear();
		internals.parkedRuntimeCap = previousCap;
		if (internals.pendingEviction !== null) {
			clearTimeout(internals.pendingEviction);
			internals.pendingEviction = null;
		}
	});

	function addEntry(
		terminalId: string,
		lastUsedAt: number,
		bufferType = "normal",
		instanceId = terminalId,
	) {
		ownedIds.add(terminalId);
		const runtime = {
			terminalId,
			container: null,
			gate: { pending: 0, queued: null },
			lastCols: 120,
			lastRows: 32,
			serializeAddon: { serialize: mock(() => `snapshot:${instanceId}`) },
			wrapper: { remove: mock(() => {}) },
			terminal: {
				options: {},
				cols: 120,
				rows: 32,
				buffer: {
					active: { type: bufferType },
					onBufferChange: () => ({ dispose() {} }),
				},
				dispose: mock(() => {}),
			},
		} as unknown as Runtime;
		const transport = createTransport();
		transport.seqAnchor = { epoch: "epoch", seq: 42 };
		const entry = { terminalId, instanceId, runtime, transport, lastUsedAt };
		const key = `${terminalId}\u0000${instanceId}`;
		internals.entries.set(key, entry);
		const keys =
			internals.entryKeysByTerminalId.get(terminalId) ?? new Set<string>();
		keys.add(key);
		internals.entryKeysByTerminalId.set(terminalId, keys);
		fakeStorage.values.set(
			`terminal-seq:${terminalId}`,
			JSON.stringify(transport.seqAnchor),
		);
		return entry;
	}

	const setBufferType = (entry: Entry, type: string) => {
		(entry.runtime.terminal.buffer.active as unknown as { type: string }).type =
			type;
	};

	test("never evicts parked alternate-screen runtimes", () => {
		const oldest = addEntry("alt-oldest", 1, "alternate");
		const newest = addEntry("alt-newest", 2, "alternate");
		internals.evictExcessParkedRuntimes();
		expect(terminalRuntimeRegistry.has("alt-oldest")).toBe(true);
		expect(terminalRuntimeRegistry.has("alt-newest")).toBe(true);
		expect(oldest.runtime.terminal.dispose).not.toHaveBeenCalled();
		expect(newest.runtime.terminal.dispose).not.toHaveBeenCalled();
		expect(oldest.runtime.serializeAddon.serialize).not.toHaveBeenCalled();
		expect(fakeStorage.values.get("terminal-seq:alt-oldest")).toBe(
			JSON.stringify(oldest.transport.seqAnchor),
		);
	});

	test("an exempt TUI does not shield a parked normal buffer", () => {
		const normal = addEntry("normal-oldest", 1);
		addEntry("alt-newest", 2, "alternate");
		internals.evictExcessParkedRuntimes();
		expect(terminalRuntimeRegistry.has("normal-oldest")).toBe(false);
		expect(terminalRuntimeRegistry.has("alt-newest")).toBe(true);
		expect(fakeStorage.values.get("terminal-seq:normal-oldest")).toBe(
			JSON.stringify(normal.transport.seqAnchor),
		);
		expect(fakeStorage.values.get("terminal-buffer:normal-oldest")).toBe(
			"snapshot:normal-oldest",
		);
		expect(fakeStorage.values.get("terminal-dims:normal-oldest")).toBe(
			JSON.stringify({ cols: 120, rows: 32 }),
		);
	});

	test("a parked TUI becomes evictable once it returns to its shell", () => {
		const parked = addEntry("alt-returns", 1, "alternate");
		addEntry("alt-keeps", 2, "alternate");
		internals.evictExcessParkedRuntimes();
		expect(terminalRuntimeRegistry.has("alt-returns")).toBe(true);
		setBufferType(parked, "normal");
		internals.evictExcessParkedRuntimes();
		expect(terminalRuntimeRegistry.has("alt-returns")).toBe(false);
		expect(terminalRuntimeRegistry.has("alt-keeps")).toBe(true);
		expect(fakeStorage.values.get("terminal-seq:alt-returns")).toBe(
			JSON.stringify(parked.transport.seqAnchor),
		);
	});

	test("a released alternate screen persists its snapshot without an exact anchor", () => {
		const entry = addEntry("alt-release", 1, "alternate");
		terminalRuntimeRegistry.release(entry.terminalId, entry.instanceId);
		expect(fakeStorage.values.get("terminal-buffer:alt-release")).toBe(
			"snapshot:alt-release",
		);
		expect(fakeStorage.values.get("terminal-dims:alt-release")).toBe(
			JSON.stringify({ cols: 120, rows: 32 }),
		);
		expect(fakeStorage.values.has("terminal-seq:alt-release")).toBe(false);
	});

	for (const failedPrefix of ["terminal-buffer:", "terminal-dims:"]) {
		test(`keeps the parked runtime when ${failedPrefix} cannot be saved`, () => {
			const entry = addEntry("storage-failure", 1);
			const sibling = addEntry(entry.terminalId, 2, "normal", "newer-viewer");
			sibling.runtime.container = {} as HTMLDivElement;
			sibling.transport.seqAnchor = { epoch: "epoch", seq: 100 };
			fakeStorage.values.set(
				`terminal-seq:${entry.terminalId}`,
				JSON.stringify(sibling.transport.seqAnchor),
			);
			fakeStorage.values.set(
				`terminal-buffer:${entry.terminalId}`,
				"newer snapshot",
			);
			fakeStorage.values.set(
				`terminal-dims:${entry.terminalId}`,
				JSON.stringify({ cols: 80, rows: 24 }),
			);
			addEntry("storage-newest", 3);
			const setItem = fakeStorage.storage.setItem;
			fakeStorage.storage.setItem = (key, value) => {
				if (key.startsWith(failedPrefix)) throw new Error("Storage full");
				setItem(key, value);
			};
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			try {
				internals.evictExcessParkedRuntimes();
				internals.evictExcessParkedRuntimes();
				expect(terminalRuntimeRegistry.has(entry.terminalId)).toBe(true);
				expect(entry.runtime.terminal.dispose).not.toHaveBeenCalled();
				expect(fakeStorage.values.has(`terminal-seq:${entry.terminalId}`)).toBe(
					false,
				);
				expect(sibling.transport.seqAnchor).toEqual({
					epoch: "epoch",
					seq: 100,
				});
				expect(warn).toHaveBeenCalledTimes(1);
			} finally {
				warn.mockRestore();
			}
		});
	}

	test("keeps the parked runtime when anchor invalidation fails", () => {
		const entry = addEntry("anchor-failure", 1);
		const sibling = addEntry(entry.terminalId, 2, "normal", "newer-viewer");
		sibling.runtime.container = {} as HTMLDivElement;
		sibling.transport.seqAnchor = { epoch: "epoch", seq: 100 };
		const savedAnchor = JSON.stringify(sibling.transport.seqAnchor);
		const savedDims = JSON.stringify({ cols: 80, rows: 24 });
		fakeStorage.values.set(`terminal-seq:${entry.terminalId}`, savedAnchor);
		fakeStorage.values.set(
			`terminal-buffer:${entry.terminalId}`,
			"newer snapshot",
		);
		fakeStorage.values.set(`terminal-dims:${entry.terminalId}`, savedDims);
		addEntry("anchor-newest", 3);
		const removeItem = fakeStorage.storage.removeItem;
		fakeStorage.storage.removeItem = (key) => {
			if (key === "terminal-seq:anchor-failure") {
				throw new Error("Storage unavailable");
			}
			removeItem(key);
		};
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			internals.evictExcessParkedRuntimes();
			internals.evictExcessParkedRuntimes();
			expect(entry.runtime.serializeAddon.serialize).not.toHaveBeenCalled();
			expect(fakeStorage.values.get("terminal-buffer:anchor-failure")).toBe(
				"newer snapshot",
			);
			expect(fakeStorage.values.get("terminal-dims:anchor-failure")).toBe(
				savedDims,
			);
			expect(fakeStorage.values.get("terminal-seq:anchor-failure")).toBe(
				savedAnchor,
			);
			expect(sibling.transport.seqAnchor).toEqual({ epoch: "epoch", seq: 100 });
			expect(terminalRuntimeRegistry.has(entry.terminalId)).toBe(true);
			expect(entry.runtime.terminal.dispose).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledTimes(1);
			fakeStorage.storage.removeItem = removeItem;
			internals.evictExcessParkedRuntimes();
			expect(
				terminalRuntimeRegistry.hasInstance(entry.terminalId, entry.instanceId),
			).toBe(false);
			expect(
				terminalRuntimeRegistry.hasInstance(
					entry.terminalId,
					sibling.instanceId,
				),
			).toBe(true);
			expect(fakeStorage.values.get("terminal-buffer:anchor-failure")).toBe(
				"snapshot:anchor-failure",
			);
			expect(fakeStorage.values.get("terminal-seq:anchor-failure")).toBe(
				JSON.stringify(entry.transport.seqAnchor),
			);
		} finally {
			fakeStorage.storage.removeItem = removeItem;
			warn.mockRestore();
		}
	});

	for (const screen of ["normal", "alternate"]) {
		test(`detach preserves the newer viewer's snapshot when ${screen} anchor invalidation fails`, () => {
			internals.parkedRuntimeCap = 0;
			const entry = addEntry(`detach-${screen}-failure`, 1, screen);
			entry.runtime.container = {} as HTMLDivElement;
			const sibling = addEntry(entry.terminalId, 2, screen, "newer-viewer");
			sibling.runtime.container = {} as HTMLDivElement;
			sibling.transport.seqAnchor = { epoch: "epoch", seq: 100 };
			const savedAnchor = JSON.stringify(sibling.transport.seqAnchor);
			const savedDims = JSON.stringify({ cols: 80, rows: 24 });
			fakeStorage.values.set(`terminal-seq:${entry.terminalId}`, savedAnchor);
			fakeStorage.values.set(
				`terminal-buffer:${entry.terminalId}`,
				"newer snapshot",
			);
			fakeStorage.values.set(`terminal-dims:${entry.terminalId}`, savedDims);
			const { setItem, removeItem } = fakeStorage.storage;
			fakeStorage.storage.setItem = (key, value) => {
				if (key === `terminal-seq:${entry.terminalId}`)
					throw new Error("Storage unavailable");
				setItem(key, value);
			};
			fakeStorage.storage.removeItem = (key) => {
				if (key === `terminal-seq:${entry.terminalId}`)
					throw new Error("Storage unavailable");
				removeItem(key);
			};
			const descriptor = Object.getOwnPropertyDescriptor(
				document,
				"getElementById",
			);
			const appendChild = mock(() => {});
			Object.defineProperty(document, "getElementById", {
				configurable: true,
				value: () => ({ appendChild }),
			});
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			try {
				terminalRuntimeRegistry.detach(entry.terminalId);
				expect(appendChild).toHaveBeenCalledWith(entry.runtime.wrapper);
				expect(entry.runtime.container).toBeNull();
				internals.evictExcessParkedRuntimes();
				expect(entry.runtime.serializeAddon.serialize).not.toHaveBeenCalled();
				expect(
					fakeStorage.values.get(`terminal-buffer:${entry.terminalId}`),
				).toBe("newer snapshot");
				expect(fakeStorage.values.get(`terminal-seq:${entry.terminalId}`)).toBe(
					savedAnchor,
				);
				expect(
					fakeStorage.values.get(`terminal-dims:${entry.terminalId}`),
				).toBe(savedDims);
				expect(
					terminalRuntimeRegistry.hasInstance(
						entry.terminalId,
						entry.instanceId,
					),
				).toBe(true);
				expect(entry.runtime.terminal.dispose).not.toHaveBeenCalled();
				expect(warn).toHaveBeenCalledTimes(1);
				fakeStorage.storage.removeItem = removeItem;
				fakeStorage.storage.setItem = setItem;
				terminalRuntimeRegistry.release(entry.terminalId, entry.instanceId);
				expect(
					terminalRuntimeRegistry.hasInstance(
						entry.terminalId,
						entry.instanceId,
					),
				).toBe(false);
				expect(
					terminalRuntimeRegistry.hasInstance(
						entry.terminalId,
						sibling.instanceId,
					),
				).toBe(true);
				expect(
					fakeStorage.values.get(`terminal-buffer:${entry.terminalId}`),
				).toBe(`snapshot:${entry.instanceId}`);
				expect(fakeStorage.values.get(`terminal-seq:${entry.terminalId}`)).toBe(
					screen === "alternate"
						? undefined
						: JSON.stringify(entry.transport.seqAnchor),
				);
			} finally {
				fakeStorage.storage.removeItem = removeItem;
				fakeStorage.storage.setItem = setItem;
				if (descriptor)
					Object.defineProperty(document, "getElementById", descriptor);
				else Reflect.deleteProperty(document, "getElementById");
				warn.mockRestore();
			}
		});
	}

	test("waits for parser completion before serializing", () => {
		const entry = addEntry("busy", 1);
		addEntry("busy-newest", 2);
		entry.runtime.gate.pending = 1;
		internals.evictExcessParkedRuntimes();
		expect(entry.runtime.serializeAddon.serialize).not.toHaveBeenCalled();
		expect(entry.runtime.gate.queued).not.toBeNull();
		entry.runtime.gate.pending = 0;
		entry.runtime.gate.queued?.();
		internals.evictExcessParkedRuntimes();
		expect(entry.runtime.serializeAddon.serialize).toHaveBeenCalledTimes(1);
		expect(terminalRuntimeRegistry.has(entry.terminalId)).toBe(false);
	});

	test("evicts one viewer without disposing or changing the anchor of an attached sibling", () => {
		const parked = addEntry("viewers", 1, "normal", "parked");
		const attached = addEntry("viewers", 2, "normal", "attached");
		attached.runtime.container = {} as HTMLDivElement;
		addEntry("other", 3);
		internals.evictExcessParkedRuntimes();
		expect(terminalRuntimeRegistry.hasInstance("viewers", "parked")).toBe(
			false,
		);
		expect(terminalRuntimeRegistry.hasInstance("viewers", "attached")).toBe(
			true,
		);
		expect(parked.runtime.terminal.dispose).toHaveBeenCalledTimes(1);
		expect(attached.runtime.terminal.dispose).not.toHaveBeenCalled();
		expect(attached.transport.seqAnchor).toEqual({ epoch: "epoch", seq: 42 });
		expect(fakeStorage.values.get("terminal-seq:viewers")).toBe(
			JSON.stringify(parked.transport.seqAnchor),
		);
	});

	test("clears snapshots and anchors when the parked session has ended", () => {
		const entry = addEntry("ended", 1);
		addEntry("ended-newest", 2);
		entry.transport.sessionEnded = true;
		fakeStorage.values.set("terminal-buffer:ended", "old snapshot");
		internals.evictExcessParkedRuntimes();
		expect(entry.runtime.serializeAddon.serialize).not.toHaveBeenCalled();
		expect(fakeStorage.values.has("terminal-buffer:ended")).toBe(false);
		expect(fakeStorage.values.has("terminal-seq:ended")).toBe(false);
		expect(terminalRuntimeRegistry.has(entry.terminalId)).toBe(false);
	});

	for (const [cols, rows] of [
		[120, 32],
		[90, 24],
	]) {
		test(`remounts a released alternate snapshot at ${cols}x${rows} without an exact anchor`, async () => {
			const old = addEntry("alt-remount", 1, "alternate");
			const original = new HeadlessTerminal({
				cols: 120,
				rows: 32,
				allowProposedApi: true,
			});
			const serializer = new SerializeAddon();
			original.loadAddon(serializer);
			await new Promise<void>((resolve) =>
				original.write(
					"SHELL HISTORY\r\n$ tui\x1b[?1049h\x1b[HOLD TUI",
					resolve,
				),
			);
			old.runtime.terminal = original as unknown as Runtime["terminal"];
			old.runtime.serializeAddon = serializer;
			const dispose = spyOn(original, "dispose");
			terminalRuntimeRegistry.release("alt-remount", "alt-remount");
			expect(dispose).toHaveBeenCalledTimes(1);
			dispose.mockRestore();
			const snapshot = fakeStorage.values.get("terminal-buffer:alt-remount");
			if (!snapshot) throw new Error("Missing serialized snapshot");
			const restored = new HeadlessTerminal({
				cols: 120,
				rows: 32,
				allowProposedApi: true,
			});
			await new Promise<void>((resolve) => restored.write(snapshot, resolve));
			const restoredSerializer = new SerializeAddon();
			restored.loadAddon(restoredSerializer);
			const runtime = {
				...old.runtime,
				initialContent: "restored" as const,
				terminal: restored as unknown as Runtime["terminal"],
				serializeAddon: restoredSerializer,
			};
			const create = spyOn(runtimeModule, "createRuntime").mockReturnValue(
				runtime,
			);
			const attach = spyOn(
				runtimeModule,
				"attachToContainer",
			).mockImplementation((r, container, onResize) => {
				r.container = container;
				r.terminal.resize(cols, rows);
				onResize?.();
			});
			try {
				terminalRuntimeRegistry.mount(
					"alt-remount",
					{} as HTMLDivElement,
					{} as Parameters<typeof terminalRuntimeRegistry.mount>[2],
				);
				const rebuilt = internals.entries.get("alt-remount\u0000alt-remount");
				expect(create).toHaveBeenCalledTimes(1);
				expect(attach).toHaveBeenCalledTimes(1);
				expect(rebuilt?.transport.seqAnchor).toBeNull();
				expect(rebuilt?.transport._xtermHadContent).toBe(true);
				expect(fakeStorage.values.get("terminal-buffer:alt-remount")).toBe(
					snapshot,
				);
				expect(restored.cols).toBe(cols);
				expect(restored.rows).toBe(rows);
				expect(restored.buffer.active.type).toBe("alternate");
				expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe(
					"OLD TUI",
				);
				expect(restored.buffer.normal.getLine(0)?.translateToString(true)).toBe(
					"SHELL HISTORY",
				);
			} finally {
				create.mockRestore();
				attach.mockRestore();
			}
		});
	}
});
