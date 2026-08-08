import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROVEN_AGAINST } from "./keystrokes";
import { resolveProvenVersionStatus } from "./proven-version";

// ---------------------------------------------------------------------------
// (PROVEN-VERSION-DRIFT) The memoisation must not cache a failure.
//
// Every failure resolves to `installed: null`, which is indistinguishable from
// "no install found" — and a transient miss at bridge start is entirely possible,
// when the process is competing for disk with everything else coming up. Caching
// it would pin the bridge to "unknown version" for its whole lifetime, and
// unknown suppresses the drift warning, so the diagnostic would go quiet exactly
// when it might have had something to say.
//
// `SUPERSET_CLAUDE_CODE_PACKAGE_JSON` is the documented override these cases use
// to make the read miss and then hit.
// ---------------------------------------------------------------------------

const OVERRIDE = "SUPERSET_CLAUDE_CODE_PACKAGE_JSON";
const original = process.env[OVERRIDE];

afterEach(() => {
	if (original === undefined) {
		delete process.env[OVERRIDE];
	} else {
		process.env[OVERRIDE] = original;
	}
});

describe("(PROVEN-VERSION-DRIFT) transient read misses recover", () => {
	// ONE ordered case, because the memo is module-level: a second `it` would
	// inherit whatever the first cached, and asserting against that would be
	// asserting about test ordering rather than about the code.
	it("misses, then recovers, then retains", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proven-version-"));
		const target = path.join(dir, "package.json");
		process.env[OVERRIDE] = target;

		// 1. The file is not there yet: the read misses.
		const missed = await resolveProvenVersionStatus();
		expect(missed.installed).toBeNull();
		// Unknown is never reported as drift.
		expect(missed.mismatch).toBe(false);

		// 2. It becomes readable, as it would once startup contention clears. A
		//    cached failure would pin `installed: null` here forever.
		fs.writeFileSync(
			target,
			JSON.stringify({ name: "@anthropic-ai/claude-code", version: "9.9.9" }),
			"utf8",
		);
		const recovered = await resolveProvenVersionStatus();
		expect(recovered.installed).toBe("claude-code@9.9.9");
		expect(recovered.proven).toBe(PROVEN_AGAINST);
		// A version that is not the proven one IS drift, and is reported.
		expect(recovered.mismatch).toBe(true);

		// 3. The SUCCESS is retained: point the override somewhere unreadable and
		//    the answer must not change, or the memo is not doing its job.
		process.env[OVERRIDE] = path.join(dir, "gone.json");
		const retained = await resolveProvenVersionStatus();
		expect(retained.installed).toBe("claude-code@9.9.9");
	});
});
