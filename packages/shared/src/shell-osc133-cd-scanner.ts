/**
 * OSC 133 C/D command-lifecycle scanner (FinalTerm semantic prompt standard).
 *
 * Companion to {@link ./shell-ready-scanner.ts}, which owns the `133;A`
 * (prompt-start) marker. This scanner detects the COMMAND boundaries:
 *
 *   - `\x1b]133;C\x07`         command start  (pre-exec)        -> command-start
 *   - `\x1b]133;D;<exit>\x07`  command end with exit code       -> command-end
 *   - `\x1b]133;D\x07`         command end, exit unknown        -> command-end (null)
 *   - `\x1b]133;A\x07`         prompt redraw while a command is
 *                              running (self-heal signal)       -> prompt-redraw
 *
 * "running" = saw `C`, not yet `D`. A later `A` (prompt redraw) while a command
 * is considered running lets the host synthesize a command-end (exit unknown),
 * so a missed `D` self-heals on the next prompt. Event-driven; no timers.
 *
 * Byte-oriented like the ready scanner: the markers are pure ASCII, so byte
 * matching is identical to char matching while keeping PTY output opaque bytes.
 * Matching bytes are HELD back from output and discarded on a full match; on a
 * mismatch, held bytes are flushed verbatim so nothing the user typed/saw is
 * dropped. Markers may span chunk boundaries — the state carries the partial.
 *
 * Terminators: BEL (0x07) OR ST (ESC `\` = 0x1b 0x5c). Both are accepted per
 * the spec (xterm emits BEL; some emitters use ST).
 *
 * Protocol ref: https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
 */

const ESC = 0x1b;
const BEL = 0x07;
const ST_TAIL = 0x5c; // backslash — second byte of the ST sequence (ESC \)

/** Common prefix shared by every 133 marker: `\x1b]133;`. */
const OSC_133_PREFIX = Uint8Array.from(
	[..."\x1b]133;"].map((c) => c.charCodeAt(0)),
);

/**
 * Phase of the byte-by-byte scan.
 * - "prefix":  matching `\x1b]133;` (matchPos tracks how many bytes matched)
 * - "kind":    prefix matched; reading the discriminator byte (A/C/D)
 * - "params":  inside a recognized marker body; collecting param bytes until a
 *              terminator (BEL or ST). On ESC we may be starting an ST.
 */
type ScanPhase = "prefix" | "kind" | "params";

export type Osc133CdEvent =
	| { kind: "command-start" }
	| { kind: "command-end"; exitCode: number | null }
	| { kind: "prompt-redraw" };

export interface Osc133CdScanState {
	phase: ScanPhase;
	/** How many bytes of OSC_133_PREFIX have matched so far (phase "prefix"). */
	matchPos: number;
	/** Bytes withheld from output while a candidate marker is in progress. */
	heldBytes: number[];
	/** The recognized discriminator for the current marker: "A" | "C" | "D". */
	kind: "A" | "C" | "D" | null;
	/** Param bytes collected after the discriminator (phase "params"). */
	paramBytes: number[];
	/** True once we saw an ESC inside params and are awaiting the ST tail. */
	sawEscInParams: boolean;
}

export interface Osc133CdScanResult {
	// Tight ArrayBuffer-backed shape: matches Buffer and what hono/ws
	// WSContext.send accepts, so callers don't need casts.
	output: Uint8Array<ArrayBuffer>;
	events: Osc133CdEvent[];
}

export function createOsc133CdScanState(): Osc133CdScanState {
	return {
		phase: "prefix",
		matchPos: 0,
		heldBytes: [],
		kind: null,
		paramBytes: [],
		sawEscInParams: false,
	};
}

/** Reset to the idle prefix-matching phase; clears any in-progress capture. */
function resetToPrefix(state: Osc133CdScanState): void {
	state.phase = "prefix";
	state.matchPos = 0;
	state.heldBytes.length = 0;
	state.kind = null;
	state.paramBytes.length = 0;
	state.sawEscInParams = false;
}

/** Parse the exit code out of a `D` marker's params (`D;<exit>` or `D`). */
function parseExitCode(paramBytes: number[]): number | null {
	// paramBytes is the text AFTER the "D" discriminator, e.g. ";0" or ";130"
	// or "" (bare D). Strip a single leading ';' then parse the leading integer.
	if (paramBytes.length === 0) return null;
	let s = String.fromCharCode(...paramBytes);
	if (s.startsWith(";")) s = s.slice(1);
	// FinalTerm D params can carry extra ';'-separated fields (e.g.
	// "D;<exit>;<aid>"); only the first field is the exit status.
	const firstField = s.split(";")[0] ?? "";
	if (firstField === "") return null;
	const n = Number.parseInt(firstField, 10);
	return Number.isFinite(n) ? n : null;
}

/** Emit the event for a completed marker and reset to prefix-matching. */
function finishMarker(state: Osc133CdScanState, events: Osc133CdEvent[]): void {
	if (state.kind === "C") {
		events.push({ kind: "command-start" });
	} else if (state.kind === "D") {
		events.push({ kind: "command-end", exitCode: parseExitCode(state.paramBytes) });
	} else if (state.kind === "A") {
		events.push({ kind: "prompt-redraw" });
	}
	resetToPrefix(state);
}

/**
 * Scan a chunk of PTY output for OSC 133 C/D (and A-while-running) markers.
 *
 * Returns the chunk with recognized markers stripped, plus any lifecycle events
 * detected in order. Held bytes for an in-progress (partial) marker are carried
 * in `state` across calls and emitted to `output` only if the candidate later
 * turns out NOT to be a marker.
 */
export function scanForOsc133Cd(
	state: Osc133CdScanState,
	data: Uint8Array,
): Osc133CdScanResult {
	const out: number[] = [];
	const events: Osc133CdEvent[] = [];

	for (let i = 0; i < data.length; i++) {
		const b = data[i] as number;

		if (state.phase === "prefix") {
			if (b === OSC_133_PREFIX[state.matchPos]) {
				state.heldBytes.push(b);
				state.matchPos++;
				if (state.matchPos === OSC_133_PREFIX.length) {
					state.phase = "kind";
				}
			} else {
				// Mismatch: flush everything we held, then re-seed on the current
				// byte (it may itself start a fresh prefix, e.g. a back-to-back ESC).
				for (const h of state.heldBytes) out.push(h);
				state.heldBytes.length = 0;
				state.matchPos = 0;
				if (b === OSC_133_PREFIX[0]) {
					state.heldBytes.push(b);
					state.matchPos = 1;
				} else {
					out.push(b);
				}
			}
			continue;
		}

		if (state.phase === "kind") {
			if (b === 0x41 /* A */ || b === 0x43 /* C */ || b === 0x44 /* D */) {
				state.kind = b === 0x41 ? "A" : b === 0x43 ? "C" : "D";
				state.heldBytes.push(b);
				state.phase = "params";
			} else if (b === BEL) {
				// `\x1b]133;\x07` with no discriminator — not a marker we handle.
				// Flush held bytes (incl. this BEL) and resume prefix matching.
				for (const h of state.heldBytes) out.push(h);
				out.push(b);
				resetToPrefix(state);
			} else {
				// Some other OSC 133 subcommand (e.g. `133;P`) or noise. Flush the
				// held prefix and re-process this byte as a potential new prefix.
				for (const h of state.heldBytes) out.push(h);
				resetToPrefix(state);
				if (b === OSC_133_PREFIX[0]) {
					state.heldBytes.push(b);
					state.matchPos = 1;
				} else {
					out.push(b);
				}
			}
			continue;
		}

		// phase === "params": collecting body bytes until a terminator.
		if (state.sawEscInParams) {
			// We are one byte past an ESC inside params; this byte decides whether
			// it was an ST terminator (ESC \) or just an ESC inside the body.
			if (b === ST_TAIL) {
				state.heldBytes.push(b);
				finishMarker(state, events);
			} else {
				// Not ST — the ESC was body content; keep both bytes as params.
				state.paramBytes.push(ESC);
				state.heldBytes.push(ESC);
				state.sawEscInParams = false;
				// Re-process the current byte in the (now non-ESC) params context.
				if (b === BEL) {
					state.heldBytes.push(b);
					finishMarker(state, events);
				} else {
					state.paramBytes.push(b);
					state.heldBytes.push(b);
				}
			}
			continue;
		}

		if (b === BEL) {
			state.heldBytes.push(b);
			finishMarker(state, events);
		} else if (b === ESC) {
			// Possible ST terminator; defer until the next byte.
			state.heldBytes.push(b);
			state.sawEscInParams = true;
		} else {
			state.paramBytes.push(b);
			state.heldBytes.push(b);
		}
	}

	return { output: Uint8Array.from(out), events };
}
