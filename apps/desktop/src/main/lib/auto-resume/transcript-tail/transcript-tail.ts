// (AUTO-RESUME) Fire-time finality gate: is the failure at `offset` STILL the last
// meaningful record of the transcript? If the agent produced any newer user/assistant
// record (it self-recovered, the user took over, or our previous resume already landed),
// we must NOT type again. Uses a bounded async tail read (never a full-history scan — the
// AN cold-start trap) so it stays off the main thread and cheap.

import * as fs from "node:fs/promises";

// If more than this was appended after the failure, the turn has clearly moved on.
const MAX_TAIL_BYTES = 256 * 1024;

function lineIsMeaningfulProgress(line: string): boolean {
	if (!line) return false;
	// A new user turn (our resume, or a manual takeover) or fresh assistant output.
	if (line.includes('"type":"user"')) return true;
	if (
		line.includes('"type":"assistant"') &&
		!line.includes('"isApiErrorMessage":true')
	) {
		return true;
	}
	return false;
}

export interface LastApiError {
	offset: number; // byte offset of the error record line in the file
	error: string | null;
	apiErrorStatus: number | null;
	text: string;
	timestampMs: number;
}

interface ClaudeErrorRecord {
	timestamp?: string;
	error?: string | null;
	apiErrorStatus?: number | null;
	isApiErrorMessage?: boolean;
	message?: { content?: Array<{ type?: string; text?: string }> | string };
}

function firstText(message: ClaudeErrorRecord["message"]): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		for (const item of content) {
			if (item && item.type === "text" && typeof item.text === "string")
				return item.text;
		}
	}
	return "";
}

/**
 * Find the LAST isApiErrorMessage record in a transcript and return its parsed fields +
 * byte offset. Bounded tail read only. Returns null if none in the tail window.
 */
export async function readLastApiError(
	transcriptPath: string,
): Promise<LastApiError | null> {
	let handle: fs.FileHandle | undefined;
	try {
		const stat = await fs.stat(transcriptPath);
		const tailBytes = Math.min(stat.size, MAX_TAIL_BYTES);
		if (tailBytes <= 0) return null;
		const start = stat.size - tailBytes;
		handle = await fs.open(transcriptPath, "r");
		const buf = Buffer.alloc(tailBytes);
		await handle.read(buf, 0, tailBytes, start);
		const text = buf.toString("utf8");
		// Walk lines tracking byte offsets; remember the last error line.
		let best: LastApiError | null = null;
		let cursor = 0;
		for (const line of text.split("\n")) {
			const lineStart = start + cursor;
			cursor += Buffer.byteLength(line, "utf8") + 1; // +1 for the '\n'
			if (!line.includes('"isApiErrorMessage":true')) continue;
			try {
				const obj = JSON.parse(line) as ClaudeErrorRecord;
				if (obj.isApiErrorMessage !== true) continue;
				best = {
					offset: lineStart,
					error: obj.error ?? null,
					apiErrorStatus: obj.apiErrorStatus ?? null,
					text: firstText(obj.message),
					timestampMs: obj.timestamp ? Date.parse(obj.timestamp) : Date.now(),
				};
			} catch {
				// skip unparseable
			}
		}
		return best;
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * Returns true only when the scheduled failure record is still the terminal state of the
 * transcript (safe to send). Returns false on any progress, truncation, or read error
 * (fail-closed: when unsure, don't type).
 */
export async function isStillLastMeaningfulFailure(
	transcriptPath: string,
	offset: number,
): Promise<boolean> {
	let handle: fs.FileHandle | undefined;
	try {
		const stat = await fs.stat(transcriptPath);
		if (stat.size < offset) return false; // rotated/truncated — don't trust
		const tailBytes = stat.size - offset;
		if (tailBytes > MAX_TAIL_BYTES) return false; // lots appended => progressed
		if (tailBytes <= 0) return false; // the error line itself should be here

		handle = await fs.open(transcriptPath, "r");
		const buf = Buffer.alloc(tailBytes);
		await handle.read(buf, 0, tailBytes, offset);
		const lines = buf.toString("utf8").split("\n");
		// lines[0] is the failure record at `offset`; inspect everything after it.
		for (let i = 1; i < lines.length; i++) {
			if (lineIsMeaningfulProgress(lines[i].trim())) return false;
		}
		return true;
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => {});
	}
}
