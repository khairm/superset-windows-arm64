// (ANSWER-DESK-TOUCH-FENCE) Which pty writes count as input at the desk.
// Drives the real DaemonPty adapter against a stand-in daemon, so no pty-daemon,
// host DB or shell is involved. Runs under Node with the tsx loader, like the
// other terminal node-tests.

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import {
	forgetTerminal,
	lastCountedInputAt,
} from "../companion/terminal-input-fence.ts";
import type { DaemonClient } from "./DaemonClient/index.ts";
import { __makeDaemonPtyForTesting } from "./terminal.ts";

type DaemonPty = ReturnType<typeof __makeDaemonPtyForTesting>;

const terminalIds: string[] = [];

afterEach(() => {
	for (const terminalId of terminalIds.splice(0)) forgetTerminal(terminalId);
});

function standInPty(terminalId: string): {
	pty: DaemonPty;
	sent: string[];
} {
	terminalIds.push(terminalId);
	const sent: string[] = [];
	const daemon = {
		protocol: 3,
		input: (_id: string, data: Buffer) => {
			sent.push(data.toString("utf8"));
		},
		inputAcknowledged: async (_id: string, data: Buffer) => {
			sent.push(data.toString("utf8"));
		},
	} as unknown as DaemonClient;
	return { pty: __makeDaemonPtyForTesting(daemon, terminalId, 1), sent };
}

test("tool, missing and non-exempt renderer writes stamp; protocol, exempt renderer and acknowledged writes do not", async () => {
	const cases: {
		name: string;
		write: (pty: DaemonPty) => void | Promise<void>;
		stamps: boolean;
	}[] = [
		{ name: "write tool", write: (pty) => pty.write("ls\r", "tool"), stamps: true },
		{
			name: "writeOrThrow tool",
			write: (pty) => pty.writeOrThrow("ls\r", "tool"),
			stamps: true,
		},
		{
			name: "write without provenance",
			write: (pty) =>
				pty.write("ls\r", undefined as unknown as Parameters<DaemonPty["write"]>[1]),
			stamps: true,
		},
		{
			name: "writeOrThrow without provenance",
			write: (pty) =>
				pty.writeOrThrow(
					"ls\r",
					undefined as unknown as Parameters<DaemonPty["writeOrThrow"]>[1],
				),
			stamps: true,
		},
		{
			name: "write renderer key",
			write: (pty) => pty.write("\x1b[B", "renderer"),
			stamps: true,
		},
		{
			name: "writeOrThrow renderer key",
			write: (pty) => pty.writeOrThrow("\x1b[B", "renderer"),
			stamps: true,
		},
		{
			name: "write renderer reply",
			write: (pty) => pty.write("\x1b[12;40R\x1b[I", "renderer"),
			stamps: false,
		},
		{
			name: "write unmarked modified F3",
			write: (pty) => pty.write("\x1b[1;5R", "renderer"),
			stamps: false,
		},
		{
			name: "write human-marked modified F3",
			write: (pty) => pty.write("\x1b[1;5R", "renderer", { human: true }),
			stamps: true,
		},
		{
			name: "writeOrThrow renderer reply",
			write: (pty) => pty.writeOrThrow("\x1b[<35;4;2M", "renderer"),
			stamps: false,
		},
		{
			name: "write protocol",
			write: (pty) => pty.write("\x1b[3;1R", "protocol"),
			stamps: false,
		},
		{
			name: "writeOrThrow protocol",
			write: (pty) => pty.writeOrThrow("\x1b[O", "protocol"),
			stamps: false,
		},
		{
			name: "writeAcknowledged",
			write: (pty) => pty.writeAcknowledged("\x1b[49u", 5_000),
			stamps: false,
		},
	];

	for (const [index, { name, write, stamps }] of cases.entries()) {
		const terminalId = `provenance-${index}`;
		const { pty, sent } = standInPty(terminalId);
		await write(pty);
		assert.equal(sent.length, 1, `${name}: the bytes reach the daemon`);
		assert.equal(lastCountedInputAt(terminalId) !== null, stamps, name);
	}
});
