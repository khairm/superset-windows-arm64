import { expect, test } from "bun:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import { HeadlessTerminal } from "../../../../../../packages/host-service/src/terminal/headless-xterm";
import {
	getTerminalScreen,
	preserveSnapshotShellRendition,
	trackTerminalScreen,
} from "./terminal-snapshot";

// (ALT-SNAPSHOT-RESTORE)
const write = (term: HeadlessTerminal, data: string) =>
	new Promise<void>((resolve) => term.write(data, resolve));

const makeTerminal = () =>
	new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });

test("snapshot preserves both shell and TUI rendition without changing the source", async () => {
	const source = makeTerminal();
	const restored = makeTerminal();
	try {
		const addon = new SerializeAddon();
		source.loadAddon(addon);
		preserveSnapshotShellRendition(addon);
		await write(
			source,
			"\x1b[32;1mSHELL\r\n$ tui\x1b[?1049h\x1b[31;3m\x1b[11;21HTUI",
		);
		await write(restored, addon.serialize());
		for (const term of [source, restored]) {
			await write(term, "X");
			const tui = term.buffer.active.getLine(10)!.getCell(23)!;
			expect(tui.getChars()).toBe("X");
			expect(tui.getFgColor()).toBe(1);
			expect(tui.isItalic()).toBeTruthy();
			await write(term, "\x1b[?1049lX");
			expect(term.buffer.active.cursorX).toBe(6);
			expect(term.buffer.active.cursorY).toBe(1);
			const shell = term.buffer.active.getLine(1)!.getCell(5)!;
			expect(shell.getChars()).toBe("X");
			expect(shell.getFgColor()).toBe(2);
			expect(shell.isBold()).toBeTruthy();
			expect(shell.isItalic()).toBeFalsy();
		}
	} finally {
		source.dispose();
		restored.dispose();
	}
});

test("serialization failure restores the source's current rendition", async () => {
	const source = makeTerminal();
	try {
		const addon = new SerializeAddon();
		source.loadAddon(addon);
		const internals = addon as unknown as {
			_serializeBufferByScrollback: () => string;
		};
		internals._serializeBufferByScrollback = () => {
			throw new Error("serialization failed");
		};
		preserveSnapshotShellRendition(addon);
		await write(source, "\x1b[32mSHELL\x1b[?1049h\x1b[31;3m\x1b[HTUI");
		expect(() => addon.serialize()).toThrow("serialization failed");
		await write(source, "X");
		const cell = source.buffer.active.getLine(0)!.getCell(3)!;
		expect(cell.getChars()).toBe("X");
		expect(cell.getFgColor()).toBe(1);
		expect(cell.isItalic()).toBeTruthy();
	} finally {
		source.dispose();
	}
});

test("tracks the live entry mode and clears it after exit", async () => {
	const term = makeTerminal();
	try {
		term.write("SHELL\x1b[?1049hTUI");
		trackTerminalScreen(term);
		await write(term, "");
		expect(getTerminalScreen(term)).toBe("alternate-1049");
		await write(term, "\x1b[?1049l");
		expect(getTerminalScreen(term)).toBe("normal");
		await write(term, "\x1b[?47h");
		expect(getTerminalScreen(term)).toBe("alternate");
	} finally {
		term.dispose();
	}
});

test("normal screens and DEC1047 keep their entry semantics", async () => {
	const term = makeTerminal();
	try {
		trackTerminalScreen(term);
		await write(term, "");
		expect(getTerminalScreen(term)).toBe("normal");
		await write(term, "\x1b[?1047h");
		expect(getTerminalScreen(term)).toBe("alternate");
	} finally {
		term.dispose();
	}
});

for (const mode of [47, 1047, 1049]) {
	for (const rendition of ["\x1b[0m", "\x1b[31;3m"]) {
		test(`DEC${mode} snapshot preserves default and styled TUI attributes (${JSON.stringify(rendition)})`, async () => {
			const source = makeTerminal();
			const restored = makeTerminal();
			try {
				const addon = new SerializeAddon();
				source.loadAddon(addon);
				preserveSnapshotShellRendition(addon);
				trackTerminalScreen(restored);
				await write(
					source,
					`\x1b[35mSAVED\x1b7

\x1b[32;1m$ tui\x1b[?${mode}h${rendition}\x1b[11;21HTUI`,
				);
				await write(restored, addon.serialize());
				expect(getTerminalScreen(restored)).toBe(
					mode === 1049 ? "alternate-1049" : "alternate",
				);
				const state = (term: HeadlessTerminal) => ({
					x: term.buffer.active.cursorX,
					y: term.buffer.active.cursorY,
					lines: Array.from({ length: term.rows }, (_, y) =>
						Array.from({ length: term.cols }, (_, x) => {
							const cell = term.buffer.active.getLine(y)!.getCell(x)!;
							return cell.getChars()
								? [
										cell.getChars(),
										cell.getFgColor(),
										cell.isBold(),
										cell.isItalic(),
									]
								: null;
						}),
					),
				});
				for (const output of ["X", `\x1b[?${mode}lX`, "\x1b8Y"]) {
					await write(source, output);
					await write(restored, output);
					expect(state(restored)).toEqual(state(source));
				}
			} finally {
				source.dispose();
				restored.dispose();
			}
		});
	}
}

test("a nested alternate entry keeps the first entry mode", async () => {
	const term = makeTerminal();
	try {
		trackTerminalScreen(term);
		await write(term, "\x1b[?1049h");
		expect(getTerminalScreen(term)).toBe("alternate-1049");
		await write(term, "\x1b[?47h");
		expect(getTerminalScreen(term)).toBe("alternate-1049");
		await write(term, "\x1b[?1049l");
		expect(getTerminalScreen(term)).toBe("normal");
		await write(term, "\x1b[?47h\x1b[?1049h");
		expect(getTerminalScreen(term)).toBe("alternate");
	} finally {
		term.dispose();
	}
});

test("the first alternate parameter of one sequence wins", async () => {
	const term = makeTerminal();
	try {
		trackTerminalScreen(term);
		await write(term, "\x1b[?1049;47h");
		expect(getTerminalScreen(term)).toBe("alternate-1049");
	} finally {
		term.dispose();
	}
});

test("a nested DEC47 entry still snapshots as a DEC1049 entry", async () => {
	const source = makeTerminal();
	const restored = makeTerminal();
	try {
		const addon = new SerializeAddon();
		source.loadAddon(addon);
		preserveSnapshotShellRendition(addon);
		trackTerminalScreen(restored);
		await write(
			source,
			"\x1b[32;1mSHELL\r\n$ tui\x1b[?1049h\x1b[?47h\x1b[31;3m\x1b[11;21HTUI",
		);
		await write(restored, addon.serialize());
		expect(getTerminalScreen(restored)).toBe("alternate-1049");
		await write(restored, "\x1b[?1049lX");
		expect(restored.buffer.active.cursorX).toBe(6);
		expect(restored.buffer.active.cursorY).toBe(1);
		const shell = restored.buffer.active.getLine(1)!.getCell(5)!;
		expect(shell.getChars()).toBe("X");
		expect(shell.getFgColor()).toBe(2);
		expect(shell.isBold()).toBeTruthy();
		expect(shell.isItalic()).toBeFalsy();
	} finally {
		source.dispose();
		restored.dispose();
	}
});
