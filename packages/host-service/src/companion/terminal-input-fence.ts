/**
 * (ANSWER-DESK-TOUCH-FENCE) When input last reached each terminal from anything
 * but the companion's own answer writer.
 *
 * The answer encoder assumes an untouched picker: caret on the first option,
 * nothing ticked, no screen change it did not cause. Input to that terminal
 * after the question was asked breaks the assumption, so `answer.ts` refuses
 * the answer (or stops it between frames) when this stamp is at or after the
 * question's `askedAtMs`.
 *
 * A leaf module with no imports, keyed by host.db `terminal_sessions.id`, so the
 * pty writer and the answer path share it without a dependency on each other.
 */

const lastCountedInputAtMs = new Map<string, number>();
const fenceStampLogWindows = new Map<
	string,
	{ startedAtMs: number; lines: number }
>();

export function stampInput(hostTerminalId: string, nowMs: number): void {
	if (!Number.isFinite(nowMs)) {
		throw new TypeError(
			`(ANSWER-DESK-TOUCH-FENCE) stampInput requires a finite epoch, got ${String(nowMs)}`,
		);
	}
	lastCountedInputAtMs.set(hostTerminalId, nowMs);
}

/** `Date.now()` at the last counted input, or null if none was ever counted. */
export function lastCountedInputAt(hostTerminalId: string): number | null {
	return lastCountedInputAtMs.get(hostTerminalId) ?? null;
}

export function forgetTerminal(hostTerminalId: string): void {
	lastCountedInputAtMs.delete(hostTerminalId);
	fenceStampLogWindows.delete(hostTerminalId);
}

/**
 * Replies a terminal emulator sends on its own, per Claude Code's reply grammar,
 * grouped by the byte after `ESC [`. None of them can move the picker. Sticky,
 * so each matches only at `lastIndex`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: DECRPM, with or without `?`
const DECRPM = /\x1b\[\??\d+;\d+\$y/y;
const PRIVATE_REPLIES: readonly RegExp[] = [
	// biome-ignore lint/suspicious/noControlCharactersInRegex: DECXCPR
	/\x1b\[\?\d+;\d+R/y,
	// biome-ignore lint/suspicious/noControlCharactersInRegex: DA1
	/\x1b\[\?[\d;]*c/y,
	DECRPM,
	// biome-ignore lint/suspicious/noControlCharactersInRegex: colour-scheme report (mode 2031)
	/\x1b\[\?997;\d+n/y,
	// biome-ignore lint/suspicious/noControlCharactersInRegex: kitty keyboard flags
	/\x1b\[\?\d+u/y,
];
// biome-ignore lint/suspicious/noControlCharactersInRegex: DA2
const SECONDARY_DEVICE_ATTRIBUTES = /\x1b\[>[\d;]*c/y;
const NUMERIC_REPLIES: readonly RegExp[] = [
	// biome-ignore lint/suspicious/noControlCharactersInRegex: CPR
	/\x1b\[\d+;\d+R/y,
	DECRPM,
	// biome-ignore lint/suspicious/noControlCharactersInRegex: DSR "terminal OK"
	/\x1b\[0n/y,
	// biome-ignore lint/suspicious/noControlCharactersInRegex: window reports
	/\x1b\[\d+(?:;\d+)*t/y,
];
// biome-ignore lint/suspicious/noControlCharactersInRegex: DCS (XTVERSION, XTGETTCAP, DECRPSS)
const DCS_REPLY = /\x1bP[^\x1b]*\x1b\\/y;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC, incl. colour replies
const OSC_REPLY = /\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/y;

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse report
const SGR_MOUSE = /\x1b\[<\d+;\d+;\d+[Mm]/y;

/**
 * xterm sends Shift/Ctrl/Alt+F3 as `\x1b[1;<m>R`, the shape of a CPR reply for a
 * cursor on row 1. Only the renderer's human tag tells the two apart.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: modified F3
const MODIFIED_F3 = /\x1b\[1;(?:[2-9]|1[0-6])R/y;

const SGR_WHEEL_BIT = 64;
const SGR_MOTION_BIT = 32;
const SGR_BUTTON_BITS = 3;
const ESC_CODE = 0x1b;

/** Wheel, or motion with no button held. Presses, releases and drags move the picker. */
function isWheelOrPureMotion(button: number): boolean {
	if ((button & SGR_WHEEL_BIT) !== 0) return true;
	return (
		(button & SGR_MOTION_BIT) !== 0 &&
		(button & SGR_BUTTON_BITS) === SGR_BUTTON_BITS
	);
}

function endOfMatch(
	pattern: RegExp,
	data: string,
	index: number,
): number | null {
	pattern.lastIndex = index;
	return pattern.test(data) ? pattern.lastIndex : null;
}

function endOfFirstMatch(
	patterns: readonly RegExp[],
	data: string,
	index: number,
): number | null {
	for (const pattern of patterns) {
		const end = endOfMatch(pattern, data, index);
		if (end !== null) return end;
	}
	return null;
}

function endOfSgrWheelOrMotion(data: string, index: number): number | null {
	const end = endOfMatch(SGR_MOUSE, data, index);
	if (end === null) return null;
	const buttonStart = index + 3;
	const button = Number(
		data.slice(buttonStart, data.indexOf(";", buttonStart)),
	);
	return isWheelOrPureMotion(button) ? end : null;
}

function matchReplyAt(
	data: string,
	index: number,
	human: boolean,
): number | null {
	if (data.charCodeAt(index) !== ESC_CODE) return null;
	const introducer = data.charAt(index + 1);
	if (introducer === "P") return endOfMatch(DCS_REPLY, data, index);
	if (introducer === "]") return endOfMatch(OSC_REPLY, data, index);
	if (introducer !== "[") return null;
	const lead = data.charAt(index + 2);
	if (lead === "<") return endOfSgrWheelOrMotion(data, index);
	if (lead === "I" || lead === "O") return index + 3;
	if (lead === "?") return endOfFirstMatch(PRIVATE_REPLIES, data, index);
	if (lead === ">") return endOfMatch(SECONDARY_DEVICE_ATTRIBUTES, data, index);
	if (lead < "0" || lead > "9") return null;
	if (human && endOfMatch(MODIFIED_F3, data, index) !== null) {
		return null;
	}
	return endOfFirstMatch(NUMERIC_REPLIES, data, index);
}

/**
 * True only when the WHOLE renderer frame is a run of one or more automatic
 * replies. Keys, pastes, mouse presses, releases and drags, X10 mouse, unknown
 * escapes, a modified F3 the renderer marked human, and any frame mixing a
 * reply with anything else are counted input.
 */
export function isExemptRendererFrame(
	data: string,
	human: boolean,
): boolean {
	if (data.length === 0) return false;
	let index = 0;
	while (index < data.length) {
		const next = matchReplyAt(data, index, human);
		if (next === null) return false;
		index = next;
	}
	return true;
}

const FENCE_STAMP_LOG_WINDOW_MS = 60_000;
const FENCE_STAMP_LOG_LINES_PER_WINDOW = 20;
const FENCE_STAMP_LOG_MAX_CHARS = 32;
const ESC = "\x1b";
/** DCS, OSC, SS3, SOS, PM, APC: what follows the introducer may be a key or text. */
const BARE_INTRODUCERS = new Set(["P", "]", "O", "X", "^", "_"]);
const CSI_PRIVATE_MARKERS = new Set(["?", ">", "<", "="]);

function codeInRange(data: string, index: number, low: number, high: number) {
	const code = data.charCodeAt(index);
	return code >= low && code <= high;
}

/**
 * The frame's leading escape sequence and nothing after it, or null when the
 * frame does not start with ESC. A CSI keeps only its private marker and, when a
 * parameter or intermediate byte came first, its final byte: parameters can
 * carry a typed character's codepoint (kitty CSI-u), and a bare final can be a
 * typed letter after Alt+[. Every other sequence stops at its introducer, and
 * an Alt+key is ESC alone.
 */
function leadingEscapeSequence(data: string): string | null {
	if (!data.startsWith(ESC)) return null;
	const introducer = data.charAt(1);
	if (introducer !== "[") {
		return BARE_INTRODUCERS.has(introducer) ? data.slice(0, 2) : ESC;
	}
	let end = 2;
	while (end < data.length && codeInRange(data, end, 0x20, 0x3f)) end += 1;
	const final =
		end > 2 && codeInRange(data, end, 0x40, 0x7e) ? data.charAt(end) : "";
	const marker = CSI_PRIVATE_MARKERS.has(data.charAt(2)) ? data.charAt(2) : "";
	return `${ESC}[${marker}${final}`;
}

/**
 * (ANSWER-DESK-TOUCH-FENCE) One line per counted renderer frame that no human
 * tag marked, so the smoke can check the exempt list against real traffic. It
 * never logs typed or pasted text: only the length and the leading escape
 * sequence without its CSI parameters. At most 20 lines per terminal per
 * minute, then one "suppressed".
 */
export function logFenceStamp(
	hostTerminalId: string,
	data: string,
	nowMs: number,
): void {
	let window = fenceStampLogWindows.get(hostTerminalId);
	if (
		window === undefined ||
		nowMs - window.startedAtMs >= FENCE_STAMP_LOG_WINDOW_MS
	) {
		window = { startedAtMs: nowMs, lines: 0 };
		fenceStampLogWindows.set(hostTerminalId, window);
	}
	window.lines += 1;
	if (window.lines > FENCE_STAMP_LOG_LINES_PER_WINDOW) {
		if (window.lines === FENCE_STAMP_LOG_LINES_PER_WINDOW + 1) {
			console.log(
				`[companion] fence stamp suppressed hostTerminalId=${hostTerminalId}`,
			);
		}
		return;
	}
	const leading = leadingEscapeSequence(data);
	const leadingField =
		leading === null
			? ""
			: ` leading=${JSON.stringify(leading).slice(1, -1).slice(0, FENCE_STAMP_LOG_MAX_CHARS)}`;
	console.log(
		`[companion] fence stamp hostTerminalId=${hostTerminalId} length=${data.length}${leadingField}`,
	);
}
