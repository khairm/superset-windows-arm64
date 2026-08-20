import { describe, expect, it } from "bun:test";
import type { DetectedPort } from "@superset/port-scanner";
import {
	clearCompanionTerminalGoneSink,
	setCompanionTerminalGoneSink,
} from "../companion/registry";
import type { HostDb } from "../db";
import { portManager } from "../ports/port-manager";
import type { WorkspaceFilesystemManager } from "../runtime/filesystem";
import { EventBus } from "./event-bus";
import type { GitWatcher } from "./git-watcher";

function createEventBus(): EventBus {
	return new EventBus({
		db: {} as unknown as HostDb,
		filesystem: {
			resolveWorkspaceRoot: () => "/tmp/missing-workspace",
		} as unknown as WorkspaceFilesystemManager,
		gitWatcher: {
			onChanged: () => () => {},
		} as unknown as GitWatcher,
	});
}

describe("EventBus port events", () => {
	it("broadcasts port changes from the shared port manager and removes listeners on close", () => {
		const eventBus = createEventBus();
		const sentMessages: string[] = [];
		const socket = {
			readyState: 1,
			send(data: string) {
				sentMessages.push(data);
			},
			close() {},
		};
		const port: DetectedPort = {
			port: 5173,
			pid: 123,
			processName: "vite",
			terminalId: "terminal-1",
			workspaceId: "workspace-1",
			detectedAt: 1_700_000_000_000,
			address: "127.0.0.1",
		};

		eventBus.handleOpen(socket);
		eventBus.start();
		eventBus.start();
		portManager.emit("port:add", port);

		expect(sentMessages).toHaveLength(1);
		const message = JSON.parse(sentMessages[0] ?? "{}");
		expect(message).toMatchObject({
			type: "port:changed",
			workspaceId: "workspace-1",
			eventType: "add",
			port,
			label: null,
		});
		expect(typeof message.occurredAt).toBe("number");

		portManager.emit("port:remove", port);
		expect(sentMessages).toHaveLength(2);
		expect(JSON.parse(sentMessages[1] ?? "{}")).toMatchObject({
			type: "port:changed",
			workspaceId: "workspace-1",
			eventType: "remove",
			port,
			label: null,
		});

		eventBus.close();
		portManager.emit("port:add", port);
		expect(sentMessages).toHaveLength(2);
	});
});

describe("EventBus fs:watch-file", () => {
	async function createFileWatchHarness(pruned: boolean) {
		const fs = await import("node:fs/promises");
		const os = await import("node:os");
		const path = await import("node:path");
		const root = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), "eb-watchfile-")),
		);
		const eventBus = new EventBus({
			db: {} as unknown as HostDb,
			filesystem: {
				resolveWorkspaceRoot: () => root,
				isPathPrunedFromWatch: () => pruned,
			} as unknown as WorkspaceFilesystemManager,
			gitWatcher: { onChanged: () => () => {} } as unknown as GitWatcher,
		});
		const sent: Array<{ type: string; events?: unknown[] }> = [];
		const socket = {
			readyState: 1,
			send(data: string) {
				sent.push(JSON.parse(data));
			},
			close() {},
		};
		eventBus.handleOpen(socket);
		return { root, eventBus, socket, sent, fs, path };
	}

	it("dedupes duplicate watch commands (one unwatch stops delivery)", async () => {
		const { root, eventBus, socket, sent, fs, path } =
			await createFileWatchHarness(true);
		const file = path.join(root, "buildout-file.js");
		await fs.writeFile(file, "v0");
		const watch = JSON.stringify({
			type: "fs:watch-file",
			workspaceId: "ws-1",
			absolutePath: file,
		});
		eventBus.handleMessage(socket, watch);
		// Duplicate watch must not install a second watcher.
		eventBus.handleMessage(socket, watch);
		await new Promise((r) => setTimeout(r, 250));

		// A single unwatch disposes the only watcher there should be. If the
		// duplicate had installed a second one, it would survive this and keep
		// delivering. Asserting silence is deterministic; asserting an exact
		// event count is not, because OS file watchers coalesce or double-fire
		// a single write differently per platform.
		eventBus.handleMessage(
			socket,
			JSON.stringify({
				type: "fs:unwatch-file",
				workspaceId: "ws-1",
				absolutePath: file,
			}),
		);
		sent.length = 0;

		await fs.writeFile(file, "v1");
		await new Promise((r) => setTimeout(r, 600));

		expect(sent.filter((m) => m.type === "fs:events")).toHaveLength(0);

		eventBus.handleClose(socket);
		await fs.rm(root, { recursive: true, force: true });
	}, 15_000);

	it("is a no-op for a covered path (the recursive watcher owns delivery)", async () => {
		const { root, eventBus, socket, sent, fs, path } =
			await createFileWatchHarness(false);
		const file = path.join(root, "src-file.ts");
		await fs.writeFile(file, "v0");
		eventBus.handleMessage(
			socket,
			JSON.stringify({
				type: "fs:watch-file",
				workspaceId: "ws-1",
				absolutePath: file,
			}),
		);
		await new Promise((r) => setTimeout(r, 250));

		await fs.writeFile(file, "v1");
		await new Promise((r) => setTimeout(r, 500));

		expect(sent.filter((m) => m.type === "fs:events")).toHaveLength(0);

		// Unwatch of the no-op entry must not throw or leak.
		eventBus.handleMessage(
			socket,
			JSON.stringify({
				type: "fs:unwatch-file",
				workspaceId: "ws-1",
				absolutePath: file,
			}),
		);
		eventBus.handleClose(socket);
		await fs.rm(root, { recursive: true, force: true });
	}, 15_000);

	it("rejects paths outside the workspace root", async () => {
		const { root, eventBus, socket, sent, fs } =
			await createFileWatchHarness(true);
		for (const bad of ["/etc/hosts", `${root}/../escape.txt`, "relative.txt"]) {
			eventBus.handleMessage(
				socket,
				JSON.stringify({
					type: "fs:watch-file",
					workspaceId: "ws-1",
					absolutePath: bad,
				}),
			);
		}
		const errors = sent.filter((m) => m.type === "error");
		expect(errors).toHaveLength(3);
		eventBus.handleClose(socket);
		await fs.rm(root, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// (ALERT-RETIRE-ON-EXIT) fork-only
// ---------------------------------------------------------------------------

/**
 * (ALERT-RETIRE-ON-EXIT) A confirmed PTY exit is the only signal that can take
 * a phone card down for a terminal whose agent never got to report its own
 * ending — a crash, a kill, a closed window. The bus is where it is observed,
 * so the bus is where it is reported.
 */
describe("(ALERT-RETIRE-ON-EXIT) terminal exits reach the companion registry", () => {
	function harness() {
		const eventBus = createEventBus();
		const gone: Array<{ hostTerminalId: string }> = [];
		const sink = (input: { hostTerminalId: string }) => {
			gone.push(input);
			return true;
		};
		setCompanionTerminalGoneSink(sink);
		return {
			eventBus,
			gone,
			release: () => {
				clearCompanionTerminalGoneSink(sink);
				eventBus.close();
			},
		};
	}

	it("records a confirmed exit", () => {
		const h = harness();
		h.eventBus.broadcastTerminalLifecycle({
			workspaceId: "workspace-1",
			terminalId: "terminal-1",
			eventType: "exit",
			exitCode: 0,
			signal: 0,
			confirmed: true,
			occurredAt: 1_700_000_000_000,
		});
		expect(h.gone).toEqual([{ hostTerminalId: "terminal-1" }]);
		h.release();
	});

	it("records an exit with no `confirmed` field — absent means confirmed", () => {
		const h = harness();
		h.eventBus.broadcastTerminalLifecycle({
			workspaceId: "workspace-1",
			terminalId: "terminal-1",
			eventType: "exit",
			exitCode: 1,
			signal: 0,
			occurredAt: 1_700_000_000_000,
		});
		expect(h.gone).toEqual([{ hostTerminalId: "terminal-1" }]);
		h.release();
	});

	it("IGNORES an unconfirmed exit — the process may still be running", () => {
		const h = harness();
		h.eventBus.broadcastTerminalLifecycle({
			workspaceId: "workspace-1",
			terminalId: "terminal-1",
			eventType: "exit",
			exitCode: 0,
			signal: 0,
			confirmed: false,
			occurredAt: 1_700_000_000_000,
		});
		expect(h.gone).toEqual([]);
		h.release();
	});

	it("ignores `created` — adoption is not a death", () => {
		const h = harness();
		h.eventBus.broadcastTerminalLifecycle({
			workspaceId: "workspace-1",
			terminalId: "terminal-1",
			eventType: "created",
			adopted: true,
			occurredAt: 1_700_000_000_000,
		});
		expect(h.gone).toEqual([]);
		h.release();
	});

	it("ignores command-start and command-end", () => {
		const h = harness();
		h.eventBus.broadcastTerminalLifecycle({
			workspaceId: "workspace-1",
			terminalId: "terminal-1",
			eventType: "command-start",
			occurredAt: 1_700_000_000_000,
		});
		h.eventBus.broadcastTerminalLifecycle({
			workspaceId: "workspace-1",
			terminalId: "terminal-1",
			eventType: "command-end",
			exitCode: 0,
			occurredAt: 1_700_000_000_001,
		});
		expect(h.gone).toEqual([]);
		h.release();
	});

	it("still broadcasts to clients when no companion sink is registered", () => {
		const eventBus = createEventBus();
		const sentMessages: string[] = [];
		eventBus.handleOpen({
			readyState: 1,
			send: (data: string) => sentMessages.push(data),
			close: () => {},
		});
		eventBus.broadcastTerminalLifecycle({
			workspaceId: "workspace-1",
			terminalId: "terminal-1",
			eventType: "exit",
			exitCode: 0,
			signal: 0,
			confirmed: true,
			occurredAt: 1_700_000_000_000,
		});
		expect(sentMessages).toHaveLength(1);
		expect(JSON.parse(sentMessages[0] ?? "{}")).toMatchObject({
			type: "terminal:lifecycle",
			eventType: "exit",
			terminalId: "terminal-1",
		});
		eventBus.close();
	});

	it("a sink that THROWS cannot fail the broadcast", () => {
		const eventBus = createEventBus();
		const sentMessages: string[] = [];
		eventBus.handleOpen({
			readyState: 1,
			send: (data: string) => sentMessages.push(data),
			close: () => {},
		});
		const sink = (): boolean => {
			throw new Error("the bridge is mid-teardown");
		};
		setCompanionTerminalGoneSink(sink);
		expect(() =>
			eventBus.broadcastTerminalLifecycle({
				workspaceId: "workspace-1",
				terminalId: "terminal-1",
				eventType: "exit",
				exitCode: 0,
				signal: 0,
				confirmed: true,
				occurredAt: 1_700_000_000_000,
			}),
		).not.toThrow();
		expect(sentMessages).toHaveLength(1);
		clearCompanionTerminalGoneSink(sink);
		eventBus.close();
	});
});
