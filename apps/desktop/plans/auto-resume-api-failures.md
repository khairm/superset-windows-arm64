# Auto-Resume on API failure — FINAL DESIGN v4 (review-hardened)

Status: APPROVED for implementation. Supersedes v1 (which 5× Codex xhigh + a 62-agent
epic-review BLOCKED). Scope: `apps/desktop` + `packages/host-service` + `packages/local-db`.
v2-only. Marker: dual-root `(AUTO-RESUME)` (main + renderer), same commit.

## 0. What changed from v1 (the 10 must-fixes, all folded in)
1. Fire-time safety gate (no blind text+Enter). 2. Codex = NOTIFY-ONLY (no validated signal). 3. tRPC observable transport, not webContents.send. 4. Durable scheduling in MAIN, not per-pane renderer. 5. Durability via MAIN registry, not seed re-emit. 6. Reset-in-past fires now. 7. Stable failureId + idempotent arming. 8. StopFailure-anchored detection (no mid-turn fire). 9. Thundering-herd controls. 10. Persisted cancel/takeover tombstone.

## 1. Detection (MAIN) — StopFailure-anchored

TRIGGER = the existing Claude **StopFailure** lifecycle (MAIN-side handler in
`pane-map-hook.ts:1236-1254`). StopFailure fires only at REAL turn end (after Claude's
own in-turn retries of transient 529s), which inherently solves "fire before final".
Hook the classifier ADDITIVELY there — do NOT disturb the existing reap / `emit('Stop')` /
truncatedReset ordering, and do NOT edit the embedded superset-notify.py Python string
(esbuild backtick trap).

On StopFailure for sessionId S:
1. `loadPaneMapping(S)` → `{terminalId, workspaceId}`. No mapping → skip + notify (never silent drop, never cwd fallback).
2. Bounded async reverse-tail read of S's transcript (NOT full history — respect the AN cold-start trap; yield like seedScanAllAsync; only this one mapped session).
3. Confirm the API-error record is the **last meaningful line** (no later assistant/user/tool_result/end_turn/interrupt). Else skip.
4. Classify (`api-failure-classifier`): **deny-list first, then allow-list**, precedence mirroring `tmp/scan_api_failures.py`: half_stop > rate_limit{transient > resume > other} > connection_drop > server_error > auth > invalid_request > other. Inspect only `message.content[0].text` + `error` + `apiErrorStatus`.
   - Resumable → register. Non-resumable (auth/policy/bad-image/model-unavailable/rate_limit_other) → notify-only, no register.
5. `failureId = sha1(sessionId + '\0' + transcriptPath + '\0' + byteOffsetOfErrorRecord)`. Arming an already-registered failureId is a **no-op** (idempotent).

## 2. Classification contract (validated against the real corpus)
Claude record: `isApiErrorMessage:true` + `error` + `apiErrorStatus` + `message.content[0].text` (always a list w/ text block — safe).

Resumable (allow-list):
- **rate_limit_resume**: `error=="rate_limit"` AND text matches `/resets /` → SCHEDULE at parsed reset +30s (+jitter).
- **rate_limit_transient** (398): text has `temporarily limiting`/`not your usage limit` → BACKOFF (stalls; not auto-retried by Claude — user-confirmed).
- **half_stop**: text ∈ {mid-response, partial response, idle timeout, may be incomplete} → BACKOFF.
- **server_error**: `error=="server_error"` OR status∈{500,502,503,529} → BACKOFF, but ONLY when StopFailure-anchored (turn truly ended; 529 is auto-retried in-turn).
- **connection_drop**: text ∈ {Unable to connect, ECONNRESET, ConnectionRefused, FailedToOpenSocket, socket connection was closed} → BACKOFF.

Non-resumable (notify-only, NEVER send): invalid_request, auth(401), model-policy/credits, rate_limit_other ("Fable currently unavailable").

Reset-time extraction (100% corpus): weekly `/resets ([A-Z][a-z]{2}\s+\d{1,2},\s*\d{1,2}(?::\d{2})?\s*[ap]m)\s*\(([^)]+)\)/i`; session `/resets (\d{1,2}(?::\d{2})?\s*[ap]m)\s*\(([^)]+)\)/i`. TZ inside parens.

## 3. Time math (`reset-time` helper) — must unit-test
`parseResetToEpochMs(timeStr, ianaTz, anchorMs)`:
- Resolve wall-clock → epoch via `Intl.DateTimeFormat` offset **at the target instant** (iterate once if the offset at `now` differs from the offset at the candidate).
- 12am→00:00, 12pm→12:00, "1am"/no-minutes→01:00.
- Session (no date): next occurrence of that wall time **≥ anchorMs**.
- Weekly (Mon D): set year=anchor year, roll +1yr only if already past anchor.
- **If computed ≤ now (within 60s grace) → fire NOW** (don't roll forward — the away-overnight case).
- DST: London spring-gap → advance to next valid instant; fall-overlap → pick earlier.
- **Sanity cap**: target > anchor + 8 days → reject as stale parse → fall back to backoff.

## 4. Durable registry + scheduler (MAIN)
Persist `~/.superset/auto-resume/registry.json` — map failureId → entry:
`{failureId, agent:'claude', sessionId, terminalId, workspaceId, transcriptPath, offset, class, mode:'schedule'|'backoff', resumeAtMs, sentCount, rescheduleCount, state:'armed'|'sent'|'cancelled'|'gaveUp', createdAt, lastSendAt}`.
- **No multi-day setTimeout.** A single periodic re-check loop (every 30s; precedent store.ts:1008) compares `Date.now()` to each armed entry's `resumeAtMs` and fires due ones.
- **Startup reconcile**: load registry; drop cancelled/gaveUp; overdue armed → fire now (subject to gates); future → keep. Never re-scan transcripts beyond the bounded tail for entries that need re-confirmation.
- **Backoff**: `delayMs = 60_000 * 3 ** sentCount` (sentCount 0..4 ⇒ 60/180/540/1620/4860s). After 5 sends → `gaveUp` + notify.
- **Rate-limit reschedule** (smart re-handle): on a fresh failure for a session with an armed/sent entry, if new class is rate-limit-with-time → set new resumeAtMs, `rescheduleCount++` (cap N=3); else server/stop → treat as next backoff step. Combined hard ceiling: **max 5 sends OR 24h wall-clock per failure-chain**, then gaveUp.

## 5. Fire-time gates (MAIN, before each send)
ALL must pass or skip (and for non-recoverable, gaveUp+notify):
(a) toggle `autoResumeEnabled` on; (b) entry not cancelled/tombstoned; (c) re-tail transcript: scheduled error STILL the last meaningful record; (d) live derived status (watcher lifecycleStates) is NOT permission(red)/working(yellow); (e) thundering-herd: global concurrent-send cap K=2, per-terminal jitter ±0–120s already in resumeAtMs, circuit breaker (if the last cohort send re-failed same class, hold the cohort behind one probe), rolling-hour global send cap.
Then call host-service preflight send.

## 6. Send (NEW host-service tRPC) — authoritative preflight
`terminal.writeInputIfIdle({ workspaceId, terminalId, expectedAgentSessionId, data, failureId })`:
- session exists + `!exited` + **`!commandRunning`** (OSC 133 C/D, already tracked) + `TerminalAgentStore.get(terminalId).agentSessionId === expectedAgentSessionId` (agent still the foreground process, not a bare shell, not a new session).
- Pass → `writeInputToSession(data + EOL)`; return `{sent:true}`.
- Fail → `{sent:false, reason}`. MAIN treats reason as skip (retry next tick within budget) or stop+notify (dead/binding-mismatch).
Message: `resume from exactly where everything was left`.

## 7. Cancel / takeover (renderer → MAIN)
Renderer publishes TRUSTED per-terminal user activity ONLY: `keydown`, `pointerdown`, `wheel`, `paste`, `drop`, xterm `onData`/`onKey`. **Exclude** xterm `onScroll` (output-driven) and the auto-resume writeInput echo. Debounced; only forwarded for terminals the renderer learns are armed (MAIN→renderer armed-set via the tRPC subscription).
- Forward → electron tRPC `autoResume.cancel({ sessionId })` → MAIN sets entry `state:'cancelled'` (persisted tombstone; survives reload/restart so reconcile honors it).
- Any manual/composer `writeInput` to that terminal also cancels.
- Toggle off → cancel ALL armed entries.

## 8. Transport (tRPC observable, NOT webContents.send)
Add an `API_FAILURE` (notify-only surfacing) + `AUTO_RESUME_STATE` (armed/sent/gaveUp + countdown) variant on the existing `notifications.subscribe` union (dot listeners ignore unknown variants → DOT-AXES untouched), emitted from the watcher's existing emitter. MAIN attaches terminalId+workspaceId via loadPaneMapping (mirroring `emit()`). Renderer is a thin consumer for the badge/toast + activity forwarding; it does NOT schedule.

## 9. Codex = NOTIFY-ONLY (v1)
No validated standalone-terminal usage-limit signal exists (corpus: only `<subagent_notification>` inside multi-agent PARENT turns that run on to task_complete; `TurnAbortReason` enum = interrupted/replaced/review_ended, no failure reason). So:
- Structural detector (ready, gated off auto-send): a rollout `response_item` with `payload.type=='message'` && `role=='user'` whose `input_text` parses a `<subagent_notification>` with `status.errored` containing the usage-limit phrase. Time regex covers BOTH `1:08 PM` AND dated `May 31st, 2026 12:58 AM`; tz = machine-local (documented caveat).
- **Regression test**: assert 0 matches over the 2,897 false-positive code lines.
- On detect → NOTIFY only ("Codex chat hit a usage limit — open to resume"). Auto-send behind `codexAutoSend` flag (default false). NEVER trigger on turn_aborted. Never use the codex-companion job (no terminal, Claude-session-keyed, no failed field).

## 10. Settings (local-db — DB is source of truth)
Add `autoResumeEnabled` (default true) + `codexAutoSend` (default false) to the local-db settings table; tRPC get/set; Settings UI toggle(s). MAIN reads via the settings accessor; subscribes to changes (toggle off cancels all).

## 11. Visibility
Per-terminal standing badge "auto-resume armed @ <time> · Cancel" + per-terminal opt-out (exclude a terminal doing destructive work while feature stays on). Coalesced toasts ("N scheduled / N resumed / N gave up") for account-wide failures. Optional short pre-send countdown-with-Cancel on the first send.

## 12. Files
NEW (main): `lib/agent-jsonl-watcher/api-failure-classifier/{index,api-failure-classifier,reset-time,*.test}.ts`; `lib/auto-resume/{index,registry,scheduler,gates,*.test}.ts`.
EDIT (main): `pane-map-hook.ts` (StopFailure → classify+register, additive); watcher emitter wiring; `autoResume` electron tRPC router (cancel, armed-set subscription, toggle get/set passthrough).
NEW/EDIT (host-service): `terminal.writeInputIfIdle` mutation + preflight using session.commandRunning + TerminalAgentStore.
EDIT (renderer): terminal pane — trusted-activity publisher; a small AutoResume controller at `_authenticated` level consuming the subscription for badge/toast (NOT scheduling); Settings UI toggle.
EDIT (local-db): settings schema fields + defaults.
EDIT: `FEATURES.md` dual-root `(AUTO-RESUME)` markers + code-comment tokens in both main & renderer files.

## 13. Tests (build has NO type/test gate → local verify mandatory)
classifier (every real template + precedence + boundary records: rate_limit+non-429, server_error+half_stop text); reset-time epoch (12am/12pm/no-min, DST spring-gap+fall-overlap, session next-occurrence, weekly rollover, past→fire-now, >8d→reject); backoff 60/180/540/1620/4860 + 5-cap + 24h ceiling; reschedule cap N=3; Codex 0-false-positive over the 2897 corpus + both time forms; cancel tombstone survives reload. Then scoped `bunx biome check <files>` + scoped typecheck + `bun test`.

## 14. Rollout
Commit to `main` w/ dual marker → re-review (5× Codex xhigh + /code-review max) → /simplify → full gh ARM64 build → Release `desktop-v<version>` → notify user (no auto-install).
