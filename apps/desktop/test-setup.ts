/**
 * Global test setup for Bun tests
 *
 * This file mocks EXTERNAL dependencies only:
 * - Electron APIs (app, dialog, BrowserWindow, ipcMain)
 * - Browser globals (document, window)
 * - trpc-electron renderer requirements
 *
 * DO NOT mock internal code here - tests should use real implementations
 * or mock at the individual test level when necessary.
 */
import { beforeEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

process.env.NODE_ENV = "test";
process.env.SKIP_ENV_VALIDATION = "1";

const testTmpDir = join(tmpdir(), "superset-test");

// =============================================================================
// Browser Global Mocks (required for renderer code that touches DOM)
// =============================================================================

const mockStyleMap = new Map<string, string>();
const mockClassList = new Set<string>();

const mockHead = {
	appendChild: mock(() => {}),
	removeChild: mock(() => {}),
};

// biome-ignore lint/suspicious/noExplicitAny: Test setup requires extending globalThis
(globalThis as any).document = {
	addEventListener: mock(() => {}),
	removeEventListener: mock(() => {}),
	documentElement: {
		style: {
			setProperty: (key: string, value: string) => mockStyleMap.set(key, value),
			getPropertyValue: (key: string) => mockStyleMap.get(key) || "",
		},
		classList: {
			add: (className: string) => mockClassList.add(className),
			remove: (className: string) => mockClassList.delete(className),
			toggle: (className: string) => {
				mockClassList.has(className)
					? mockClassList.delete(className)
					: mockClassList.add(className);
			},
			contains: (className: string) => mockClassList.has(className),
		},
	},
	head: mockHead,
	getElementsByTagName: mock((tag: string) => {
		if (tag === "head") return [mockHead];
		return [];
	}),
	createElement: mock((_tag: string) => ({
		setAttribute: mock(() => {}),
		appendChild: mock(() => {}),
		textContent: "",
		type: "",
	})),
	createTextNode: mock((text: string) => ({
		textContent: text,
	})),
};

// zustand's persist middleware defaults to `window.localStorage`. The
// xterm-env-polyfill preload aliases `window` to globalThis, so that lookup
// resolves to `undefined` without throwing and persist crashes on the first
// setState. Provide an in-memory Storage so persisted stores work in tests.
const localStorageData = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
	get length() {
		return localStorageData.size;
	},
	clear: () => localStorageData.clear(),
	getItem: (key: string) => localStorageData.get(key) ?? null,
	key: (index: number) => [...localStorageData.keys()][index] ?? null,
	removeItem: (key: string) => {
		localStorageData.delete(key);
	},
	setItem: (key: string, value: string) => {
		localStorageData.set(key, value);
	},
};

beforeEach(() => {
	localStorageData.clear();
});

// Ensure window has addEventListener/removeEventListener for react-hotkeys-hook's IIFE
if (typeof globalThis.window !== "undefined") {
	const win = globalThis.window as Record<string, unknown>;
	if (!win.addEventListener) win.addEventListener = mock(() => {});
	if (!win.removeEventListener) win.removeEventListener = mock(() => {});
} else {
	// biome-ignore lint/suspicious/noExplicitAny: Test setup requires extending globalThis
	(globalThis as any).window = {
		addEventListener: mock(() => {}),
		removeEventListener: mock(() => {}),
	};
}

/**
 * A working in-memory `Storage`. Both web storages need one and neither can
 * use the real thing here: zustand's `persist` middleware resolves its storage
 * once at module load and writes on every `setState`, so a missing or
 * non-functional one throws on the first mutation of any persisted store.
 */
function createMockStorage(): Storage {
	const backing = new Map<string, string>();
	return {
		get length() {
			return backing.size;
		},
		clear: () => backing.clear(),
		getItem: (key: string) => backing.get(key) ?? null,
		key: (index: number) => Array.from(backing.keys())[index] ?? null,
		removeItem: (key: string) => {
			backing.delete(key);
		},
		setItem: (key: string, value: string) => {
			backing.set(key, String(value));
		},
	};
}

// localStorage: renderer stores persisted with zustand's `persist` middleware
// write to it on every setState, and zustand resolves the storage once at
// module load. Install a working mock unconditionally (some environments expose
// a present-but-nonfunctional `localStorage`, so a `typeof === "undefined"`
// guard is not enough) and before any store module is imported.
const mockLocalStorage = createMockStorage();
Object.defineProperty(globalThis, "localStorage", {
	value: mockLocalStorage,
	writable: true,
	configurable: true,
});

// sessionStorage: the v2-notification dot store persists to
// `window.sessionStorage` on purpose (it survives an in-place reload and dies
// with the app), and nothing here provided one — so zustand's persist
// middleware threw `storage.setItem is not a function` on the first setState
// and every test in that file failed for a reason that had nothing to do with
// what it was testing. Installed on BOTH `globalThis` and the `window` stub,
// because the store reads it through `window`.
const mockSessionStorage = createMockStorage();
Object.defineProperty(globalThis, "sessionStorage", {
	value: mockSessionStorage,
	writable: true,
	configurable: true,
});
if (typeof globalThis.window !== "undefined") {
	(globalThis.window as Record<string, unknown>).sessionStorage =
		mockSessionStorage;
	(globalThis.window as Record<string, unknown>).localStorage =
		mockLocalStorage;
}

// =============================================================================
// Electron Preload Mocks (exposed via contextBridge in real app)
// =============================================================================

// trpc-electron expects this global for renderer-side communication
// biome-ignore lint/suspicious/noExplicitAny: Test setup requires extending globalThis
(globalThis as any).electronTRPC = {
	sendMessage: () => {},
	onMessage: (_callback: (msg: unknown) => void) => {},
};

// =============================================================================
// Electron Module Mock (the actual electron package)
// =============================================================================

mock.module("electron", () => ({
	app: {
		getPath: mock(() => testTmpDir),
		getName: mock(() => "test-app"),
		getVersion: mock(() => "1.0.0"),
		getAppPath: mock(() => testTmpDir),
		isPackaged: false,
	},
	dialog: {
		showOpenDialog: mock(() =>
			Promise.resolve({ canceled: false, filePaths: [] }),
		),
		showSaveDialog: mock(() =>
			Promise.resolve({ canceled: false, filePath: "" }),
		),
		showMessageBox: mock(() => Promise.resolve({ response: 0 })),
	},
	BrowserWindow: mock(() => ({
		webContents: { send: mock() },
		loadURL: mock(),
		on: mock(),
	})),
	ipcMain: {
		handle: mock(),
		on: mock(),
	},
	shell: {
		openExternal: mock(() => Promise.resolve()),
		openPath: mock(() => Promise.resolve("")),
	},
	clipboard: {
		writeText: mock(),
		readText: mock(() => ""),
	},
	screen: {
		getPrimaryDisplay: mock(() => ({
			workAreaSize: { width: 1920, height: 1080 },
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
		})),
		getAllDisplays: mock(() => [
			{
				bounds: { x: 0, y: 0, width: 1920, height: 1080 },
				workAreaSize: { width: 1920, height: 1080 },
			},
		]),
	},
	Notification: mock(() => ({
		show: mock(),
		on: mock(),
	})),
	Menu: {
		buildFromTemplate: mock(() => ({})),
		setApplicationMenu: mock(),
	},
}));

// =============================================================================
// Analytics Mock (has Electron/API dependencies)
// =============================================================================

mock.module("main/lib/analytics", () => ({
	track: mock(() => {}),
	clearUserCache: mock(() => {}),
	shutdown: mock(() => Promise.resolve()),
	getPosthogClient: mock(() => null),
	getUserId: mock(() => null),
	setUserId: mock(() => {}),
}));

// =============================================================================
// @superset/local-db Schema Mock (drizzle-orm/sqlite-core not available in Bun tests)
// =============================================================================

const mockTable = (name: string) => ({ id: `${name}_id` });

const agentPresetOverrideSchema = z.object({
	id: z.string(),
	enabled: z.boolean().optional(),
	label: z.string().optional(),
	description: z.string().nullable().optional(),
	command: z.string().optional(),
	promptCommand: z.string().optional(),
	promptCommandSuffix: z.string().nullable().optional(),
	taskPromptTemplate: z.string().optional(),
	contextPromptTemplateSystem: z.string().optional(),
	contextPromptTemplateUser: z.string().optional(),
	model: z.string().optional(),
});

const agentPresetOverrideEnvelopeSchema = z.object({
	version: z.literal(1),
	presets: z.array(agentPresetOverrideSchema),
});

const agentCustomDefinitionSchema = z.object({
	id: z.string().regex(/^custom:/),
	kind: z.literal("terminal"),
	label: z.string(),
	description: z.string().optional(),
	command: z.string(),
	promptCommand: z.string().optional(),
	promptCommandSuffix: z.string().optional(),
	promptTransport: z.enum(["argv", "stdin"]).optional(),
	taskPromptTemplate: z.string(),
	contextPromptTemplateSystem: z.string().optional(),
	contextPromptTemplateUser: z.string().optional(),
	enabled: z.boolean().optional(),
});

const localDbMock = () => ({
	projects: mockTable("projects"),
	workspaces: mockTable("workspaces"),
	worktrees: mockTable("worktrees"),
	settings: mockTable("settings"),
	users: mockTable("users"),
	organizations: mockTable("organizations"),
	organizationMembers: mockTable("organization_members"),
	tasks: mockTable("tasks"),
	workspaceSections: mockTable("workspace_sections"),
	agentPresetOverrideSchema,
	agentPresetOverrideEnvelopeSchema,
	agentCustomDefinitionSchema,
	PROMPT_TRANSPORTS: ["argv", "stdin"],
	EXTERNAL_APPS: [],
	EXECUTION_MODES: [
		"split-pane",
		"new-tab",
		"new-tab-split-pane",
		"sequential",
	],
	BRANCH_PREFIX_MODES: ["none", "github", "author", "custom"],
	TERMINAL_LINK_BEHAVIORS: ["external-editor", "file-viewer"],
	FILE_OPEN_MODES: ["split-pane", "new-tab"],
});

// Mock both the package name and the resolved source path to handle
// bun's workspace package resolution in different versions.
mock.module("@superset/local-db", localDbMock);
mock.module("@superset/local-db/schema", localDbMock);

// =============================================================================
// Local DB Mock (better-sqlite3 not supported in Bun tests)
// =============================================================================

mock.module("main/lib/local-db", () => ({
	localDb: {
		select: mock(() => ({
			from: mock(() => ({
				where: mock(() => ({
					get: mock(() => null),
					all: mock(() => []),
				})),
				get: mock(() => null),
				all: mock(() => []),
			})),
		})),
		insert: mock(() => ({
			values: mock(() => ({
				returning: mock(() => ({
					get: mock(() => ({ id: "test-id" })),
				})),
				onConflictDoUpdate: mock(() => ({
					run: mock(),
				})),
				run: mock(),
			})),
		})),
		update: mock(() => ({
			set: mock(() => ({
				where: mock(() => ({
					run: mock(),
					returning: mock(() => ({
						get: mock(() => ({ id: "test-id" })),
					})),
				})),
			})),
		})),
		delete: mock(() => ({
			where: mock(() => ({
				run: mock(),
			})),
		})),
	},
}));
