import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { TerminalModes } from "@superset/pty-daemon/terminal-modes";
import {
	getTerminalScreen,
	preserveSnapshotShellRendition,
	trackTerminalScreen,
} from "../../../../apps/desktop/src/renderer/lib/terminal/terminal-snapshot";
import { HeadlessTerminal } from "./headless-xterm";
import { createModeTracker } from "./terminal-mode-tracker";

const enc = new TextEncoder();
const dec = new TextDecoder();

function preambleString(tracker: ReturnType<typeof createModeTracker>): string {
	const bytes = tracker.buildPreamble();
	return bytes ? dec.decode(bytes) : "";
}

/**
 * The full sync emitted when every tracked mode is at its default. The
 * preamble asserts modes in both directions (the attaching xterm may hold
 * non-default state from a restored snapshot), so defaults are explicit
 * disables — except DECOM (`?6`, homes the cursor) and synchronized output
 * (`?2026h` would suspend rendering), which are asymmetric by design.
 */
const DEFAULT_SYNC =
	"\x1b[?1l\x1b[?7h\x1b[?25h\x1b[?45l\x1b[?66l\x1b[?1004l" +
	"\x1b[?2004l\x1b[?2026l\x1b[?2031l\x1b[4l\x1b[?1003l\x1b[?1006l\x1b[=0;1u";

describe("createModeTracker", () => {
	test("default state emits the full both-directions sync", () => {
		const t = createModeTracker(120, 32);
		expect(preambleString(t)).toBe(DEFAULT_SYNC);
		t.dispose();
	});

	test("kitty keyboard push survives many KB of unrelated output", () => {
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b[>7u"));

		// 200 KB of filler — well past the host-service FIFO's 64 KiB cap.
		// Tracker state is independent of the FIFO so flags should hold.
		const filler = "x".repeat(2048);
		for (let i = 0; i < 100; i += 1) {
			t.feed(enc.encode(filler));
		}

		expect(preambleString(t)).toContain("\x1b[=7;1u");
		t.dispose();
	});

	test("preamble disarms kitty after explicit pop", () => {
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b[>7u"));
		expect(preambleString(t)).toContain("\x1b[=7;1u");

		t.feed(enc.encode("\x1b[<u"));
		expect(preambleString(t)).toContain("\x1b[=0;1u");
		expect(preambleString(t)).not.toContain("\x1b[=7;1u");
		t.dispose();
	});

	test("preamble disarms kitty after explicit set-to-zero", () => {
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b[>7u"));
		t.feed(enc.encode("\x1b[=0;1u"));
		expect(preambleString(t)).toContain("\x1b[=0;1u");
		expect(preambleString(t)).not.toContain("\x1b[=7;1u");
		t.dispose();
	});

	test("bracketed paste mode is asserted in both directions", () => {
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b[?2004h"));
		expect(preambleString(t)).toContain("\x1b[?2004h");
		t.feed(enc.encode("\x1b[?2004l"));
		// Explicit disable, not silence: the attaching xterm may still be
		// armed from before a reattach gap.
		expect(preambleString(t)).toContain("\x1b[?2004l");
		t.dispose();
	});

	test("focus reporting and mouse tracking are captured", () => {
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b[?1004h\x1b[?1002h"));
		const preamble = preambleString(t);
		expect(preamble).toContain("\x1b[?1004h");
		expect(preamble).toContain("\x1b[?1002h");
		expect(preamble).not.toContain("\x1b[?1004l");
		expect(preamble).not.toContain("\x1b[?1003l");
		t.dispose();
	});

	test("SGR mouse encoding is asserted in both directions", () => {
		// A rebuilt renderer (persisted SerializeAddon snapshots don't capture
		// ?1006) falls back to legacy X10 reports for a live TUI without this —
		// and the full-fidelity wheel handler refuses to synthesize non-SGR
		// reports.
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b[?1002h\x1b[?1006h"));
		expect(preambleString(t)).toContain("\x1b[?1006h");
		t.feed(enc.encode("\x1b[?1006l"));
		expect(preambleString(t)).toContain("\x1b[?1006l");
		t.dispose();
	});

	test("mouse tracking off is an explicit disarm", () => {
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b[?1002h"));
		t.feed(enc.encode("\x1b[?1002l"));
		expect(preambleString(t)).toContain("\x1b[?1003l");
		t.dispose();
	});

	test("multi-mode preamble lists DEC modes before kitty", () => {
		// Order matters: a peer applying the preamble should see DEC modes
		// settle before the kitty Set, so a kitty-aware program reading back
		// state via `\x1b[?u` query gets a consistent answer.
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b[?2004h\x1b[?1004h\x1b[>7u"));
		const p = preambleString(t);
		expect(p.indexOf("\x1b[?2004h")).toBeGreaterThanOrEqual(0);
		expect(p.indexOf("\x1b[?1004h")).toBeGreaterThanOrEqual(0);
		expect(p.indexOf("\x1b[=7;1u")).toBeGreaterThan(p.indexOf("\x1b[?2004h"));
		t.dispose();
	});

	test("cursor visibility is asserted in both directions", () => {
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b[?25l"));
		expect(preambleString(t)).toContain("\x1b[?25l");
		// A show must be re-asserted too: the attaching xterm may hold a
		// hidden cursor from a restored snapshot or an earlier preamble.
		t.feed(enc.encode("\x1b[?25h"));
		const p = preambleString(t);
		expect(p).toContain("\x1b[?25h");
		expect(p).not.toContain("\x1b[?25l");
		t.dispose();
	});

	test("preamble is a fixpoint: applying it to a fresh peer reproduces it", () => {
		// The property the resync depends on: after a peer consumes the
		// preamble, its mode state equals the tracker's — so a second
		// preamble built from the peer is byte-identical.
		const source = createModeTracker(120, 32);
		source.feed(
			enc.encode("\x1b[?2004h\x1b[?1004h\x1b[?1002h\x1b[?25l\x1b[?1h\x1b[>7u"),
		);
		const peer = createModeTracker(120, 32);
		const preamble = source.buildPreamble();
		if (!preamble) throw new Error("expected a preamble");
		peer.feed(preamble);
		expect(preambleString(peer)).toBe(dec.decode(preamble));
		source.dispose();
		peer.dispose();
	});

	test("default-state preamble does not move the peer's cursor", () => {
		// Guards the DECOM exception: `?6h`/`?6l` home the cursor, so the
		// preamble must never emit `?6l` for a default-state program. A
		// regression here teleports the cursor of every idle terminal on
		// every silent reconnect.
		const source = createModeTracker(120, 32);
		const peer = createModeTracker(120, 32);
		peer.feed(enc.encode("line one\r\nab"));
		const before = peer.cursorPosition();
		expect(before).toEqual({ x: 2, y: 1 });
		const preamble = source.buildPreamble();
		if (!preamble) throw new Error("expected a preamble");
		peer.feed(preamble);
		expect(peer.cursorPosition()).toEqual(before);
		source.dispose();
		peer.dispose();
	});

	test("resize is idempotent and doesn't reset mode state", () => {
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b[>7u"));
		t.resize(80, 24);
		t.resize(80, 24);
		t.resize(160, 50);
		expect(preambleString(t)).toContain("\x1b[=7;1u");
		t.dispose();
	});

	test("escape sequences split across feeds are still parsed", () => {
		const t = createModeTracker(120, 32);
		t.feed(enc.encode("\x1b["));
		t.feed(enc.encode(">7"));
		t.feed(enc.encode("u"));
		expect(preambleString(t)).toContain("\x1b[=7;1u");
		t.dispose();
	});
});

describe("host-side leaked-input-mode reclaim", () => {
	const MARKER = "\x1b]777;superset-shell-ready\x07";
	const flush = () => new Promise<void>((r) => queueMicrotask(r));

	function makeTracker() {
		const disarms: string[] = [];
		const t = createModeTracker(120, 32, {
			onLeakedInputModeDisarm(bytes) {
				disarms.push(dec.decode(bytes));
				// Mirror terminal.ts: deliverOutput feeds the disarm back in.
				t.feed(bytes);
			},
		});
		return { t, disarms };
	}

	test("disarms a dead TUI's modes at the reclaiming shell's prompt", async () => {
		const { t, disarms } = makeTracker();
		t.feed(enc.encode(MARKER)); // session's first prompt
		t.feed(enc.encode("\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[>7u")); // TUI arms
		t.feed(enc.encode(MARKER)); // shell reprompts after an unclean kill
		await flush();
		const out = disarms.join("");
		expect(out).toContain("\x1b[?1003l");
		expect(out).toContain("\x1b[?1004l");
		expect(out).toContain("\x1b[=0;1u");
		// The fed-back disarm converges the tracker: the next attach preamble
		// no longer re-arms fresh renderers.
		const preamble = preambleString(t);
		expect(preamble).toContain("\x1b[?1003l");
		expect(preamble).toContain("\x1b[=0;1u");
		t.dispose();
	});

	test("leaves modes armed before the first marker alone (shell-owned)", async () => {
		const { t, disarms } = makeTracker();
		t.feed(enc.encode("\x1b[?1003h")); // armed before any prompt marker
		t.feed(enc.encode(MARKER));
		await flush();
		expect(disarms).toHaveLength(0);
		t.dispose();
	});

	test("does not disarm modes a TUI restored on clean exit", async () => {
		const { t, disarms } = makeTracker();
		t.feed(enc.encode(MARKER));
		t.feed(enc.encode("\x1b[?1003h\x1b[>7u"));
		t.feed(enc.encode("\x1b[?1003l\x1b[<u")); // clean restore
		t.feed(enc.encode(MARKER));
		await flush();
		expect(disarms).toHaveLength(0);
		t.dispose();
	});

	test("a TUI re-arming right after the marker keeps its modes", async () => {
		const { t, disarms } = makeTracker();
		t.feed(enc.encode(MARKER));
		t.feed(enc.encode("\x1b[?1003h"));
		// Marker and re-arm land in the same chunk (fg after ^Z): the deferred
		// flush must see the re-arm and stand down.
		t.feed(enc.encode(`${MARKER}\x1b[?1003h`));
		await flush();
		expect(disarms).toHaveLength(0);
		t.dispose();
	});

	test("ignores urxvt-style OSC 777 payloads", async () => {
		const { t, disarms } = makeTracker();
		t.feed(enc.encode(MARKER));
		t.feed(enc.encode("\x1b[?1003h"));
		t.feed(enc.encode("\x1b]777;notify;title;body\x07"));
		await flush();
		expect(disarms).toHaveLength(0);
		t.dispose();
	});

	test("no callback wiring means no reclaim side effects", async () => {
		const t = createModeTracker(120, 32);
		t.feed(enc.encode(MARKER));
		t.feed(enc.encode("\x1b[?1003h"));
		t.feed(enc.encode(MARKER));
		await flush();
		// Tracker still reports the armed state untouched.
		expect(preambleString(t)).toContain("\x1b[?1003h");
		t.dispose();
	});
});

describe("snapshot behind an alt screen", () => {
	// Why the handoff reads the retained PTY stream instead of this snapshot:
	// the alternate screen keeps no scrollback, so whatever a TUI has already
	// drawn over is unrecoverable from the emulator, however high maxLines is.
	test("cannot see output the alt screen drew over", () => {
		const t = createModeTracker(80, 4);
		t.feed(enc.encode("before-alt-screen\r\n"));
		t.feed(enc.encode("\x1b[?1049h")); // enter alt screen, as a TUI does
		for (let i = 1; i <= 40; i += 1) t.feed(enc.encode(`frame-line-${i}\r\n`));

		const text = t.snapshot(800).text;
		expect(text).not.toContain("before-alt-screen");
		expect(text).not.toContain("frame-line-1\n");
		expect(text).toContain("frame-line-40");
		expect(text.split("\n").length).toBeLessThanOrEqual(4);
		t.dispose();
	});

	test("keeps scrollback while the program stays on the normal screen", () => {
		const t = createModeTracker(80, 4);
		for (let i = 1; i <= 40; i += 1) t.feed(enc.encode(`line-${i}\r\n`));

		const text = t.snapshot(800).text;
		expect(text).toContain("line-1\n");
		expect(text).toContain("line-40");
		t.dispose();
	});
});

// (ALT-SNAPSHOT-RESTORE)
describe("serialized alternate-screen reanchor", () => {
	const { SerializeAddon } = createRequire(
		new URL("../../../../apps/desktop/package.json", import.meta.url),
	)(
		"@xterm/addon-serialize",
	) as typeof import("../../../../apps/desktop/node_modules/@xterm/addon-serialize");
	const write = (term: HeadlessTerminal, bytes: string | Uint8Array) =>
		new Promise<void>((resolve) => term.write(bytes, resolve));
	const text = (term: HeadlessTerminal) => {
		const buffer = term.buffer.active;
		return Array.from(
			{ length: buffer.length },
			(_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
		).join("\n");
	};
	const initial =
		"\x1b[32;1mSHELL HISTORY\r\n$ tui\x1b[?1049h\x1b[31;3m\x1b[11;21HOLD TUI";
	const cursor = (term: HeadlessTerminal) => ({
		x: term.buffer.active.cursorX,
		y: term.buffer.active.cursorY,
	});
	const cells = (term: HeadlessTerminal) => {
		const buffer = term.buffer.active;
		return Array.from({ length: buffer.length }, (_, y) =>
			Array.from({ length: term.cols }, (_, x) => {
				const cell = buffer.getLine(y)!.getCell(x)!;
				return cell.getChars()
					? [
							cell.getChars(),
							cell.getFgColor(),
							cell.getBgColor(),
							cell.isBold(),
							cell.isItalic(),
						]
					: null;
			}),
		);
	};

	for (const cols of [80, 60]) {
		for (const exited of [false, true]) {
			test(`restored snapshot at ${cols} columns reconciles a ${exited ? "finished" : "live"} TUI`, async () => {
				const host = createModeTracker(80, 24);
				const original = new HeadlessTerminal({
					cols: 80,
					rows: 24,
					allowProposedApi: true,
				});
				const serializer = new SerializeAddon();
				original.loadAddon(serializer);
				preserveSnapshotShellRendition(serializer);
				await write(original, initial);
				host.feed(enc.encode(initial));
				const snapshot = serializer.serialize();
				original.dispose();
				const reference = new HeadlessTerminal({
					cols: 80,
					rows: 24,
					allowProposedApi: true,
				});
				await write(reference, initial);
				if (exited) {
					host.feed(enc.encode("\x1b[?1049l"));
					await write(reference, "\x1b[?1049l");
				}
				const restored = new HeadlessTerminal({
					cols: 80,
					rows: 24,
					allowProposedApi: true,
				});
				try {
					await write(restored, snapshot);
					restored.resize(cols, 24);
					host.resize(cols, 24);
					reference.resize(cols, 24);
					expect(restored.buffer.active.type).toBe("alternate");
					const preamble = host.buildPreamble("alternate-1049");
					if (!preamble) throw new Error("Missing reanchor preamble");
					await write(restored, preamble);
					expect(restored.buffer.active.type).toBe(
						exited ? "normal" : "alternate",
					);
					if (exited) {
						expect(cursor(restored)).toEqual(host.cursorPosition());
						expect(cursor(restored)).toEqual({ x: 5, y: 1 });
						await write(restored, "NEXT SHELL OUTPUT");
						await write(reference, "NEXT SHELL OUTPUT");
						expect(cursor(restored)).toEqual(cursor(reference));
						expect(cells(restored)).toEqual(cells(reference));
						expect(text(restored)).toContain("SHELL HISTORY");
						expect(text(restored)).not.toContain("OLD TUI");
						const output = Array.from(
							{ length: 30 },
							(_, i) => `\r\nSHELL LINE ${i}`,
						).join("");
						await write(restored, output);
						expect(restored.buffer.normal.baseY).toBeGreaterThan(0);
						expect(text(restored)).toContain("SHELL LINE 0");
						expect(text(restored)).toContain("SHELL LINE 29");
					} else {
						expect(text(restored)).toContain("OLD TUI");
						const repaint = "\x1b[2J\x1b[HFULL REDRAW";
						host.feed(enc.encode(repaint));
						await write(restored, repaint);
						expect(text(restored).trimEnd()).toBe(host.snapshot().text);
					}
				} finally {
					restored.dispose();
					reference.dispose();
					host.dispose();
				}
			});
		}
	}

	test("normal-screen reanchor preserves current and saved cursor and rendition", async () => {
		const host = createModeTracker(80, 24);
		const restored = new HeadlessTerminal({
			cols: 80,
			rows: 24,
			allowProposedApi: true,
		});
		const reference = new HeadlessTerminal({
			cols: 80,
			rows: 24,
			allowProposedApi: true,
		});
		try {
			const shell = "\x1b[35mhistory\x1b7\r\n\x1b[32;1m$ typing";
			await write(restored, shell);
			await write(reference, shell);
			const preamble = host.buildPreamble("normal");
			if (!preamble) throw new Error("Missing reanchor preamble");
			await write(restored, preamble);
			expect(cursor(restored)).toEqual(cursor(reference));
			for (const output of ["NEXT", "\x1b8SAVED"]) {
				await write(restored, output);
				await write(reference, output);
				expect(cursor(restored)).toEqual(cursor(reference));
				expect(cells(restored)).toEqual(cells(reference));
			}
		} finally {
			restored.dispose();
			reference.dispose();
			host.dispose();
		}
	});

	for (const mode of [47, 1047, 1049]) {
		for (const fromSnapshot of [false, true]) {
			test(`${fromSnapshot ? "restored" : "live"} DEC${mode} reanchor preserves cursor and rendition`, async () => {
				const host = createModeTracker(80, 24);
				let viewer = new HeadlessTerminal({
					cols: 80,
					rows: 24,
					allowProposedApi: true,
				});
				const reference = new HeadlessTerminal({
					cols: 80,
					rows: 24,
					allowProposedApi: true,
				});
				try {
					const serializer = new SerializeAddon();
					viewer.loadAddon(serializer);
					preserveSnapshotShellRendition(serializer);
					const entry = `\x1b[35mSAVED\x1b7

\x1b[32;1m$ tui\x1b[?${mode}h\x1b[31;3m\x1b[11;21HOLD TUI`;
					host.feed(enc.encode(entry));
					await write(viewer, entry);
					await write(reference, entry);
					if (fromSnapshot) {
						const snapshot = serializer.serialize();
						viewer.dispose();
						viewer = new HeadlessTerminal({
							cols: 80,
							rows: 24,
							allowProposedApi: true,
						});
						trackTerminalScreen(viewer);
						await write(viewer, snapshot);
					}
					host.feed(enc.encode(`\x1b[?${mode}l`));
					await write(reference, `\x1b[?${mode}l`);
					host.resize(60, 24);
					viewer.resize(60, 24);
					reference.resize(60, 24);
					const preamble = host.buildPreamble(getTerminalScreen(viewer));
					if (!preamble) throw new Error("Missing reanchor preamble");
					await write(viewer, preamble);
					for (const output of ["NEXT", "\x1b8SAVED"]) {
						await write(viewer, output);
						await write(reference, output);
						expect(cursor(viewer)).toEqual(cursor(reference));
						expect(cells(viewer)).toEqual(cells(reference));
					}
				} finally {
					viewer.dispose();
					reference.dispose();
					host.dispose();
				}
			});
		}
	}

	test("daemon mode checkpoint, not the partial mirror, decides the screen", () => {
		const daemon = new TerminalModes();
		daemon.feed(enc.encode("\x1b[?1049h"));
		const host = createModeTracker(80, 24);
		try {
			host.restoreModes(daemon.snapshot());
			expect(dec.decode(host.buildPreamble("alternate-1049")!)).not.toContain(
				"\x1b[?1049l",
			);
			daemon.feed(enc.encode("\x1b[?1049l"));
			host.restoreModes(daemon.snapshot());
			expect(dec.decode(host.buildPreamble("alternate-1049")!)).toStartWith(
				"\x1b[?1049l",
			);
			expect(dec.decode(host.buildPreamble()!)).not.toContain("\x1b[?1049l");
		} finally {
			host.dispose();
		}
	});
});
