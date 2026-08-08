import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readOrphanTranscriptVerdict } from "./question-store";

// ---------------------------------------------------------------------------
// (PUSH-ARMED-ORPHAN)
//
// The reconstructed-entry check, three-way. `findToolResultInTranscript` reports
// `unreadable` for two facts with opposite consequences: a file that is there
// and says nothing useful ("cannot check" — the buzz stands), and a file that is
// not there at all ("this notification is inert" — the fence row is retired).
//
// The second is the stale-armed-fence class: a row survives a restart naming a
// transcript that no longer exists, nothing can ever corroborate it, and it is
// rebuilt and re-held on every restart until its 6-hour expiry. Retiring it is
// irreversible, so absence is CORROBORATED against the projects root before it
// counts — an unreachable `~/.claude` must read as "cannot tell", never as gone.
// ---------------------------------------------------------------------------

/** `<root>/projects/<slug>/<session>.jsonl`, the shape the derivation produces. */
async function transcriptTree(): Promise<{
	root: string;
	projects: string;
	transcriptPath: string;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-orphan-"));
	const projects = path.join(root, "projects");
	const slug = path.join(projects, "-C--Users-khair-Code-Projects-gone");
	await fs.mkdir(slug, { recursive: true });
	return { root, projects, transcriptPath: path.join(slug, "s-1.jsonl") };
}

function line(content: unknown[]): string {
	return `${JSON.stringify({ type: "assistant", message: { content } })}\n`;
}

const TOOL_USE_ID = "toolu_01ABC";

describe("(PUSH-ARMED-ORPHAN) readOrphanTranscriptVerdict", () => {
	it("resolved — the tool_result is in the transcript", async () => {
		const tree = await transcriptTree();
		await fs.writeFile(
			tree.transcriptPath,
			line([{ type: "tool_use", id: TOOL_USE_ID }]) +
				line([{ type: "tool_result", tool_use_id: TOOL_USE_ID }]),
		);
		expect(
			await readOrphanTranscriptVerdict({
				transcriptPath: tree.transcriptPath,
				toolUseId: TOOL_USE_ID,
			}),
		).toBe("resolved");
		await fs.rm(tree.root, { recursive: true, force: true });
	});

	it("unresolved — the call is there and its result is not", async () => {
		const tree = await transcriptTree();
		await fs.writeFile(
			tree.transcriptPath,
			line([{ type: "tool_use", id: TOOL_USE_ID }]),
		);
		expect(
			await readOrphanTranscriptVerdict({
				transcriptPath: tree.transcriptPath,
				toolUseId: TOOL_USE_ID,
			}),
		).toBe("unresolved");
		await fs.rm(tree.root, { recursive: true, force: true });
	});

	it("unresolved — a file that IS there but proves nothing is not gone", async () => {
		// Empty, and a transcript that never mentions the call: both are `unreadable`
		// to guard 1, and neither is evidence of absence.
		const tree = await transcriptTree();
		await fs.writeFile(tree.transcriptPath, "");
		expect(
			await readOrphanTranscriptVerdict({
				transcriptPath: tree.transcriptPath,
				toolUseId: TOOL_USE_ID,
			}),
		).toBe("unresolved");

		await fs.writeFile(
			tree.transcriptPath,
			line([{ type: "tool_use", id: "toolu_SOMETHINGELSE" }]),
		);
		expect(
			await readOrphanTranscriptVerdict({
				transcriptPath: tree.transcriptPath,
				toolUseId: TOOL_USE_ID,
			}),
		).toBe("unresolved");
		await fs.rm(tree.root, { recursive: true, force: true });
	});

	it("gone — the file is absent underneath a projects root that IS readable", async () => {
		const tree = await transcriptTree();
		expect(
			await readOrphanTranscriptVerdict({
				transcriptPath: tree.transcriptPath,
				toolUseId: TOOL_USE_ID,
			}),
		).toBe("gone");
		await fs.rm(tree.root, { recursive: true, force: true });
	});

	it("unresolved — a missing SLUG directory is out of scope, not proof", async () => {
		// The scope check, distinct from the transient one below. No slug directory
		// means Claude Code has no record of this worktree at all, which is equally
		// consistent with "the transcript was deleted" and with "the path we derived
		// was never the right one" — a renamed worktree, an edited host.db row, a
		// derivation that drifted. Only a file missing from a directory that DOES
		// exist is evidence about the file.
		const tree = await transcriptTree();
		await fs.rm(path.dirname(tree.transcriptPath), {
			recursive: true,
			force: true,
		});
		expect(
			await readOrphanTranscriptVerdict({
				transcriptPath: tree.transcriptPath,
				toolUseId: TOOL_USE_ID,
			}),
		).toBe("unresolved");
		await fs.rm(tree.root, { recursive: true, force: true });
	});

	it("unresolved — an unreachable projects root is 'cannot tell', never gone", async () => {
		// The transient this corroboration exists for: a roaming profile or an
		// unmounted volume ENOENTs the file too, and acting on that would throw away
		// a buzz for an agent that is still blocked.
		const tree = await transcriptTree();
		await fs.rm(tree.root, { recursive: true, force: true });
		expect(
			await readOrphanTranscriptVerdict({
				transcriptPath: tree.transcriptPath,
				toolUseId: TOOL_USE_ID,
			}),
		).toBe("unresolved");
	});
});
