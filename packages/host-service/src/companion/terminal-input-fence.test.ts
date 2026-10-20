import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	forgetTerminal,
	isExemptRendererFrame,
	logFenceStamp,
} from "./terminal-input-fence";

describe("(ANSWER-DESK-TOUCH-FENCE) which renderer frames count as input", () => {
	it("exempts automatic replies, alone and in runs", () => {
		const replies = [
			"\x1b[I",
			"\x1b[O",
			"\x1b[12;40R",
			"\x1b[?12;40R",
			"\x1b[?62;22c",
			"\x1b[>0;276;0c",
			"\x1b[?2004;1$y",
			"\x1b[0n",
			"\x1b[?997;1n",
			"\x1b[?0u",
			"\x1b[8;45;110t",
			"\x1bP>|xterm.js(5.5.0)\x1b\\",
			"\x1bP1+r544e=787465726d\x1b\\",
			"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
			"\x1b]4;1;rgb:cd00/0000/0000\x07",
			"\x1b[<64;10;5M",
			"\x1b[<69;10;5M",
			"\x1b[<35;10;5M",
			"\x1b[<39;10;5M",
		];
		for (const reply of replies) {
			for (const humanMarked of [false, true]) {
				expect([reply, isExemptRendererFrame(reply, humanMarked)]).toEqual([
					reply,
					true,
				]);
			}
		}
		expect(isExemptRendererFrame(replies.join(""), false)).toBe(true);
		expect(isExemptRendererFrame("\x1b[1;5R", false)).toBe(true);
	});

	it("counts keys, pastes, clicks, drags, X10 mouse, unknown escapes and mixed frames", () => {
		const counted = [
			"a",
			"\r",
			"\x1b[B",
			"\x1b[49u",
			"\x1b[200~pasted\x1b[201~",
			"\x1b[<0;10;5M",
			"\x1b[<0;10;5m",
			"\x1b[<4;10;5M",
			"\x1b[<16;10;5m",
			"\x1b[<32;10;5M",
			"\x1b[<44;10;5M",
			"\x1b[M #!",
			"\x1b[Z",
			"\x1b[I1",
			"1\x1b[O",
		];
		for (const frame of counted) {
			expect([frame, isExemptRendererFrame(frame, false)]).toEqual([
				frame,
				false,
			]);
		}
		expect(isExemptRendererFrame("\x1b[1;5R", true)).toBe(false);
	});
});

describe("(ANSWER-DESK-TOUCH-FENCE) the fence stamp log", () => {
	const hostTerminalId = "fence-log-terminal";
	afterEach(() => forgetTerminal(hostTerminalId));

	it("logs length and the leading escape only, never typed or pasted text or CSI parameters, 20 lines a minute", () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			logFenceStamp(hostTerminalId, "secret", 0);
			logFenceStamp(hostTerminalId, "\x1b[200~secret\x1b[201~", 1);
			logFenceStamp(hostTerminalId, "\x1bs", 2);
			logFenceStamp(hostTerminalId, "\x1b[97;5u", 3);
			logFenceStamp(hostTerminalId, "\x1bP1234 5678", 4);
			logFenceStamp(hostTerminalId, "\x1bPassword", 5);
			logFenceStamp(hostTerminalId, "\x1b[secret", 6);
			for (let line = 7; line < 25; line += 1) {
				logFenceStamp(hostTerminalId, "\x1b[B", line);
			}
			logFenceStamp(hostTerminalId, "\x1b[A", 60_000);

			const lines = log.mock.calls.map((call) => String(call[0]));
			expect(lines.slice(0, 7)).toEqual([
				`[companion] fence stamp hostTerminalId=${hostTerminalId} length=6`,
				`[companion] fence stamp hostTerminalId=${hostTerminalId} length=18 leading=\\u001b[~`,
				`[companion] fence stamp hostTerminalId=${hostTerminalId} length=2 leading=\\u001b`,
				`[companion] fence stamp hostTerminalId=${hostTerminalId} length=7 leading=\\u001b[u`,
				`[companion] fence stamp hostTerminalId=${hostTerminalId} length=11 leading=\\u001bP`,
				`[companion] fence stamp hostTerminalId=${hostTerminalId} length=9 leading=\\u001bP`,
				`[companion] fence stamp hostTerminalId=${hostTerminalId} length=8 leading=\\u001b[`,
			]);
			expect(lines.slice(20)).toEqual([
				`[companion] fence stamp suppressed hostTerminalId=${hostTerminalId}`,
				`[companion] fence stamp hostTerminalId=${hostTerminalId} length=3 leading=\\u001b[`,
			]);
			for (const typed of ["secret", "1234", "5678", "assword"]) {
				expect(lines.filter((line) => line.includes(typed))).toEqual([]);
			}
		} finally {
			log.mockRestore();
		}
	});
});
