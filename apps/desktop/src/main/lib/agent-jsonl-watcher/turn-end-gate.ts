/**
 * (WATCHER-BLUE-STOMP) Turn-end replay gate for the Claude JSONL watcher.
 *
 * The watcher emits turn-ends of its own — a user interrupt and a full API
 * abort — that BYPASS superset-notify.py. Two things have to be true before one
 * of those emits is allowed to fire: the line must really BE a turn-end, and the
 * turn it describes must have ended JUST NOW. This module owns both questions;
 * it is pure (no fs, no clock of its own) so it can be tested directly.
 *
 * ── 1. Is it really a turn-end? ──────────────────────────────────────────────
 *
 * The original predicate was a raw PHRASE match: any `"type":"user"` line
 * containing "Request interrupted by user". That matches Claude Code's synthetic
 * interrupt record — and it also matches every teammate message, review report,
 * summary and tool_result that merely QUOTES the phrase, which in this repo is
 * constant (the fork's own agent traffic discusses this exact string, and agents
 * routinely `cat` transcript lines into tool results).
 *
 * Measured 2026-08-06 over the local corpus, 10,695 transcripts:
 *
 *   phrase predicate matched                       1217 lines
 *     genuine synthetic interrupt records          1147
 *     FALSE POSITIVES (phrase quoted in content)     70
 *                                                   ├─ 57 tool_result blocks
 *                                                   └─ 13 long user messages
 *
 * That is not theoretical: in the live watcher debug log, 9 of the 10
 * `claude-interrupt-release` emits in the window were driven by false records —
 * false `Stop`s fired MID-TURN, clearing working-yellow/blue and ringing the
 * completion chime while the agent was still working. The freshness gate below
 * cannot help there, because each false line is genuinely new (unique uuid,
 * current timestamp); only an exact-shape check can.
 *
 * So a turn-end must match the EXACT synthetic record, not the phrase. The shape
 * is uniform across all 1147 genuine records and 21 Claude Code versions
 * (2.1.197 – 2.1.223):
 *
 *   {"type":"user","message":{"role":"user","content":[
 *      {"type":"text","text":"[Request interrupted by user]"}]},
 *    "uuid":"…","timestamp":"…","userType":"external", …}
 *
 *   - content is ALWAYS a single `text` block, NEVER a bare string (1147/1147);
 *     the 13 bare-string false positives were long human/teammate messages.
 *   - the text is exactly the bracketed sentinel: `[Request interrupted by user]`
 *     (952) or `[Request interrupted by user for tool use]` (195).
 *   - uuid and timestamp are always present (1147/1147).
 *
 * Fields deliberately NOT used to discriminate, because the data says they
 * cannot: `isSidechain` is true on 649 and false on 498 (subagent transcripts
 * get sentinels too); `isMeta` and `toolUseResult` are absent from every genuine
 * record; `interruptedMessageId` is present on only 336/1147 (it appears across
 * every version, so it tracks WHERE the interrupt landed, not the version) and
 * requiring it would drop two thirds of real interrupts.
 *
 * `[Request cancelled by user]` is accepted as a sentinel text for wording
 * compatibility even though the corpus contains zero of them in sentinel form
 * (all 42 occurrences of "cancelled by user" are quotes inside tool_results).
 * The exact-shape requirement is what removes the false-positive surface, so
 * keeping the third wording costs nothing.
 *
 * The API-abort predicate had the same latent defect: it substring-matched
 * `"isApiErrorMessage":true` plus a signature phrase on the RAW line. The corpus
 * holds 85 lines carrying the abort signature and NOT ONE is a real api-error
 * record — every one is a quote (log greps, FEATURES.md reads, this file's own
 * source). They escape the current predicate only because none of those quotes
 * happened to also carry the `isApiErrorMessage` substring; a single tool_result
 * that cats a real api-error transcript line would carry both. Since the abort
 * path is the DESTRUCTIVE one (it reaps subagent markers), it is parsed exactly
 * too: `isApiErrorMessage` must be a real top-level boolean on an `assistant`
 * record, and the signature must appear in the record's own extracted text.
 * Verified against all 1317 real api-error records in the corpus: every one is
 * `type:"assistant"` with a top-level `isApiErrorMessage:true` and a single text
 * block, so the parse never loses a genuine abort.
 *
 * ── 2. Did the turn end JUST NOW? ────────────────────────────────────────────
 *
 * Claude Code re-presents transcript content it has already written — a
 * compaction rewrite, a post-truncation re-read from offset 0, a first-seen file
 * the discover poll reads whole — so even a correctly-identified sentinel gets
 * re-matched long after the turn it describes. A replayed match used to emit a
 * bare `Stop`, and the renderer clears the background-running axis on every
 * non-`BackgroundRunning` agent event, so the replay wiped the blue the notify
 * hook had just restored (live 2026-08-06: compact-end `BackgroundRunning`, then
 * 763ms later the watcher re-parsed the compaction-rewritten transcript, matched
 * a HISTORICAL interrupt and greened the dot under a still-running background
 * shell). The same replay asserts a false turn-end mid-turn during an AUTO
 * compact, and on the abort path reaps markers belonging to a live later turn.
 *
 * The gate is therefore per-entry and layered:
 *
 *   1. uuid — an entry already judged never counts again, at ANY age. Exact, and
 *      the only layer that catches a rewrite replaying a match seconds old.
 *   2. age  — an entry stamped longer than TURN_END_MAX_AGE_MS ago is a replay.
 *      This is what covers a COLD watcher (empty uuid set) re-reading history.
 *
 * Failing the gate emits NOTHING — no Stop, no marker reap — so the dot keeps
 * whatever the notify hook last asserted. That is the safe direction: a lingering
 * yellow self-heals on the next hook event, a false green does not.
 */

/** Exact text of Claude Code's synthetic turn-end user message. */
const TURN_END_SENTINEL_TEXTS: ReadonlySet<string> = new Set([
	"[Request interrupted by user]",
	"[Request interrupted by user for tool use]",
	"[Request cancelled by user]",
]);

/**
 * Signature of the API failure that ENDS a turn, as it appears in the api-error
 * record's own text. A bare api-error also covers TRANSIENT failures (overloaded
 * 529 etc.) that Claude auto-retries within the same turn, which must not reap
 * markers or green mid-turn.
 */
const API_ABORT_SIGNATURES = [
	"Stream idle timeout",
	"partial response received",
] as const;

/**
 * How old a genuine turn-end entry can be when the watcher reads it.
 *
 * Measured 2026-08-06 against the live watcher debug log: for every file the
 * watcher processed (1169 samples — 262 `claude-gated` + 907 `poll-grown`), the
 * age of the newest transcript entry at the moment the watcher read it was
 * p50 405ms, p99 1.7s, MAX 14.2s, with 100% under 15s and zero negative. That
 * delta is the whole end-to-end cost: Claude Code's write lag plus the watcher's
 * own detection lag (a dropped fs.watch event costs at most POLL_KNOWN_MS +
 * POLL_DEBOUNCE_MS; a newly discovered file POLL_DISCOVER_MS). The one genuine
 * interrupt sentinel that could be joined end-to-end in the same window landed
 * at 435ms, sitting on that distribution's median — a sentinel is an ordinary
 * entry as far as write lag goes.
 *
 * 120s is ~8.5x the worst observed. The bound does not need to be tight: what it
 * exists to reject is HOURS old (the same transcript still carries interrupt
 * lines 7h back), so the whole region between 15s and hours is empty and there
 * is nothing to gain by moving the line down into the measurement's tail.
 *
 * (The earlier basis for this constant — "0.399-0.653s, one genuine interrupt
 * batched 30.9s behind a 15 KB pending message" — was drawn from a corpus that
 * turned out to be almost entirely the phrase-match false positives described
 * above; the 30.9s outlier was an ordinary agent-review message. The numbers
 * here are re-measured over exact-sentinel and live-watcher data only.)
 *
 * Residual, accepted: a genuine interrupt whose transcript write flushes more
 * than the window later is suppressed. The mechanism is that the entry becomes
 * visible to the watcher only when Claude Code's NEXT write flushes, so a turn
 * that is interrupted and then sits idle for minutes before anything else is
 * written can surface stale. The dot then holds the notify hook's last assertion
 * (yellow) instead of going green, and self-heals on the next hook event: the
 * following UserPromptSubmit clears `.askq/_main` and asserts `Start`
 * (pane-map-hook.ts, `superset-notify.py`), and the turn after that emits a
 * hooked Stop. A lingering yellow that self-heals is the price for never firing
 * a false green, which does not.
 */
export const TURN_END_MAX_AGE_MS = 120_000;

/**
 * How far in the FUTURE an entry's timestamp may sit and still count as fresh.
 *
 * The age bound above is one-sided, and a backward clock step (an NTP correction
 * after sleep-resume) makes ALL history negative-age at once. On a whole-file
 * re-read with a cold uuid layer that turns a years-old interrupt into "fresh"
 * and emits exactly the Stop this gate exists to suppress.
 *
 * The transcript and the clock we compare it to are the same machine's, so in
 * normal operation the age is positive by the write lag: 0 of the 1169 live
 * samples above were negative at all. A negative age is therefore not jitter —
 * it means the clock moved — and 5s is well past any sub-second NTP slew while
 * still failing a step large enough to resurrect history. Beyond the tolerance
 * the verdict is `future-skew`, i.e. suppressed, which is the safe direction.
 *
 * NOTE for future maintenance: do NOT "improve" this by aging entries against
 * the file's mtime instead of their own timestamp. A compaction rewrite sets
 * mtime to NOW, so every replayed line in a rewritten transcript would look
 * fresh — that is precisely the bug this gate was built to fix.
 */
export const TURN_END_MAX_FUTURE_SKEW_MS = 5_000;

/**
 * Bounded FIFO of turn-end entry uuids already judged. Genuine turn-end entries
 * are rare (1147 across 10,695 transcripts spanning months), so the cap is far
 * above any realistic working set. Eviction is insertion-ordered; an evicted
 * uuid falls back to the age layer, which by then gives the same answer.
 */
const SEEN_TURN_END_UUID_CAP = 512;
const seenTurnEndUuids = new Set<string>();

export interface TranscriptRecord {
	readonly type?: unknown;
	readonly uuid?: unknown;
	readonly timestamp?: unknown;
	readonly isApiErrorMessage?: unknown;
	readonly message?: unknown;
}

export type TurnEndReason =
	| "fresh"
	| "replayed-uuid"
	| "stale"
	| "future-skew"
	| "undatable";

export interface TurnEndVerdict {
	readonly fresh: boolean;
	readonly reason: TurnEndReason;
	readonly ageMs: number | null;
	readonly uuid: string | null;
}

/**
 * Cheap substring prefilter so the hot path only pays for JSON.parse on lines
 * that could possibly be a turn-end. Deliberately loose — the exact predicates
 * below do the real work; this only exists to keep a full-file re-read from
 * parsing every line.
 */
export function mayBeTurnEndLine(line: string): boolean {
	return (
		line.includes("interrupted by user") ||
		line.includes("cancelled by user") ||
		line.includes('"isApiErrorMessage":true')
	);
}

export function parseTranscriptRecord(line: string): TranscriptRecord | null {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return null;
		return parsed as TranscriptRecord;
	} catch {
		return null;
	}
}

/**
 * The record's sole text payload, or null if it does not have exactly one.
 * Requiring exactly one text block is what rejects a tool_result or a long
 * message that merely quotes a sentinel: every genuine synthetic record in the
 * corpus carries a single text block and nothing else.
 */
function soleTextBlock(message: unknown): string | null {
	if (typeof message !== "object" || message === null) return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length !== 1) return null;
	const block: unknown = content[0];
	if (typeof block !== "object" || block === null) return null;
	const { type, text } = block as { type?: unknown; text?: unknown };
	if (type !== "text" || typeof text !== "string") return null;
	return text;
}

function messageRole(message: unknown): string | null {
	if (typeof message !== "object" || message === null) return null;
	const role = (message as { role?: unknown }).role;
	return typeof role === "string" ? role : null;
}

/** Claude Code's synthetic "the user interrupted this turn" user record. */
export function isSyntheticInterruptRecord(rec: TranscriptRecord): boolean {
	if (rec.type !== "user") return false;
	if (messageRole(rec.message) !== "user") return false;
	const text = soleTextBlock(rec.message);
	return text !== null && TURN_END_SENTINEL_TEXTS.has(text.trim());
}

/**
 * (API-ABORT-RELEASE) The synthetic assistant record for an API failure that
 * ENDED the turn. `isApiErrorMessage` is set by Claude Code itself and never by
 * the model, so a real top-level `true` on an `assistant` record is already
 * proof the line is not a quote; the signature is then matched against that
 * record's own text rather than the raw line.
 */
export function isSyntheticApiAbortRecord(rec: TranscriptRecord): boolean {
	if (rec.isApiErrorMessage !== true) return false;
	if (rec.type !== "assistant") return false;
	if (messageRole(rec.message) !== "assistant") return false;
	const text = soleTextBlock(rec.message);
	if (text === null) return false;
	return API_ABORT_SIGNATURES.some((sig) => text.includes(sig));
}

function rememberTurnEndUuid(uuid: string): void {
	seenTurnEndUuids.add(uuid);
	while (seenTurnEndUuids.size > SEEN_TURN_END_UUID_CAP) {
		const oldest = seenTurnEndUuids.values().next();
		if (oldest.done) break;
		seenTurnEndUuids.delete(oldest.value);
	}
}

/**
 * Judge one matched turn-end record, and RECORD it: judging is what marks the
 * entry seen, so a later re-presentation is `replayed-uuid` whatever its age.
 * Never throws. An entry that cannot be dated or identified is NOT fresh — we
 * cannot prove a turn ended just now, and suppressing is the safe direction; it
 * is reported as "undatable" so the case stays findable in the debug log.
 */
export function judgeTurnEndRecord(
	rec: TranscriptRecord,
	nowMs: number,
): TurnEndVerdict {
	const uuid =
		typeof rec.uuid === "string" && rec.uuid.length > 0 ? rec.uuid : null;
	let ageMs: number | null = null;
	if (typeof rec.timestamp === "string") {
		const t = Date.parse(rec.timestamp);
		if (Number.isFinite(t)) ageMs = nowMs - t;
	}
	if (uuid !== null && seenTurnEndUuids.has(uuid))
		return { fresh: false, reason: "replayed-uuid", ageMs, uuid };
	if (uuid !== null) rememberTurnEndUuid(uuid);
	if (ageMs === null) return { fresh: false, reason: "undatable", ageMs, uuid };
	if (ageMs < -TURN_END_MAX_FUTURE_SKEW_MS)
		return { fresh: false, reason: "future-skew", ageMs, uuid };
	if (ageMs > TURN_END_MAX_AGE_MS)
		return { fresh: false, reason: "stale", ageMs, uuid };
	return { fresh: true, reason: "fresh", ageMs, uuid };
}

/**
 * Drop the uuid layer. Called when the watcher stops: a restart re-seeds every
 * existing transcript to EOF, so no history is replayed through the empty layer,
 * and anything re-read afterwards is old enough for the age layer to catch.
 */
export function resetTurnEndGate(): void {
	seenTurnEndUuids.clear();
}
