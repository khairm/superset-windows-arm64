import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NOTIFY_SCRIPT_MARKER } from "./notify-hook";

const HOOK_TEMPLATES = [
	"notify-hook.template.sh",
	"cursor-hook.template.sh",
	"copilot-hook.template.sh",
	"gemini-hook.template.sh",
] as const;

function readTemplate(name: string): string {
	return readFileSync(path.join(import.meta.dir, "templates", name), "utf-8");
}

describe("getNotifyScriptContent", () => {
	it("bumps the notify hook marker when hook semantics change", () => {
		expect(NOTIFY_SCRIPT_MARKER).toBe("# Superset agent notification hook v3");
	});

	it("emits the v2 host-service payload with full agent identity", () => {
		const script = readTemplate("notify-hook.template.sh");

		// (HOOK-FORK-DIET) parse runs on bash builtins, not echo|grep|grep|tr.
		expect(script).toContain('json_field "session_id" "$INPUT"');
		expect(script).toContain('HOOK_SESSION_ID="$JSON_FIELD"');
		// notify resolves sessionId from resourceId, falling back to session_id.
		expect(script).toContain("RESOURCE_ID:-$HOOK_SESSION_ID}");
		expect(script).toContain(
			'json_escape "$SESSION_ID"; E_SESSION_ID="$JSON_ESCAPED"',
		);
		expect(script).toContain(
			'PAYLOAD="{\\"json\\":{\\"terminalId\\":\\"$E_TERMINAL_ID\\",\\"eventType\\":\\"$E_EVENT_TYPE\\",\\"agent\\":{\\"agentId\\":\\"$E_AGENT_ID\\",\\"sessionId\\":\\"$E_SESSION_ID\\"}}}"',
		);
		expect(script).toContain(
			"event=$EVENT_TYPE terminalId=$SUPERSET_TERMINAL_ID agentId=$SUPERSET_AGENT_ID hookSessionId=$HOOK_SESSION_ID resourceId=$RESOURCE_ID paneId=$SUPERSET_PANE_ID tabId=$SUPERSET_TAB_ID workspaceId=$SUPERSET_WORKSPACE_ID",
		);
		expect(script).toContain('V1_EVENT_TYPE="$EVENT_TYPE"');
		expect(script).toContain('V1_EVENT_TYPE="Stop"');
	});

	it("gives the v2 host-service hook enough time to deliver", () => {
		const script = readTemplate("notify-hook.template.sh");

		expect(script).toContain(
			'curl -sX POST "$SUPERSET_HOST_AGENT_HOOK_URL" \\\n    --connect-timeout 2 --max-time 5',
		);
	});

	it("falls back to the v1 Electron hook when v2 is unavailable", () => {
		const script = readTemplate("notify-hook.template.sh");

		expect(script).toContain(
			'if [ -n "$SUPERSET_HOST_AGENT_HOOK_URL" ] && [ -n "$SUPERSET_TERMINAL_ID" ]; then',
		);
		expect(script).toContain(
			'[ -z "$SUPERSET_TAB_ID" ] && [ -z "$SESSION_ID" ] && [ -z "$SUPERSET_TERMINAL_ID" ] && exit 0',
		);
		expect(script).toContain("/hook/complete");
		expect(script).toContain("terminalId=$SUPERSET_TERMINAL_ID");
		expect(script).toContain("SUPERSET_TAB_ID");
		expect(script).toContain("SUPERSET_PANE_ID");
	});
});

describe("per-agent hook scripts dispatch to v2", () => {
	// (HOOK-FORK-DIET) fork-free escaping pre-computes E_AGENT_ID, so the payload
	// shape is identical across hooks; the per-agent source var differs (below).
	const expectedV2Payload =
		'PAYLOAD="{\\"json\\":{\\"terminalId\\":\\"$E_TERMINAL_ID\\",\\"eventType\\":\\"$E_EVENT_TYPE\\",\\"agent\\":{\\"agentId\\":\\"$E_AGENT_ID\\",\\"sessionId\\":\\"$E_SESSION_ID\\"}}}"';

	for (const [template, agentIdVar] of [
		["cursor-hook.template.sh", "AGENT_ID"],
		["copilot-hook.template.sh", "SUPERSET_AGENT_ID"],
		["gemini-hook.template.sh", "SUPERSET_AGENT_ID"],
	] as const) {
		it(`${template} posts v2 first and falls back to v1`, () => {
			const script = readTemplate(template);
			expect(script).toContain(expectedV2Payload);
			// each hook escapes its agent-id source var into E_AGENT_ID: cursor
			// resolves the CLI/Composer fallback (AGENT_ID), others use SUPERSET_AGENT_ID.
			expect(script).toContain(
				`json_escape "$${agentIdVar}"; E_AGENT_ID="$JSON_ESCAPED"`,
			);
			// per-agent hooks key sessionId off the parsed session_id field.
			expect(script).toContain(
				'json_escape "$HOOK_SESSION_ID"; E_SESSION_ID="$JSON_ESCAPED"',
			);
			expect(script).toContain('curl -sX POST "$SUPERSET_HOST_AGENT_HOOK_URL"');
			expect(script).toContain(
				'if [ -n "$SUPERSET_HOST_AGENT_HOOK_URL" ] && [ -n "$SUPERSET_TERMINAL_ID" ]; then',
			);
			expect(script).toContain("/hook/complete");
			expect(script).toContain('V1_EVENT_TYPE="$EVENT_TYPE"');
			expect(script).toContain("eventType=$V1_EVENT_TYPE");
			expect(script).toContain("terminalId=$SUPERSET_TERMINAL_ID");
			expect(script).toContain("SUPERSET_TAB_ID");
			expect(script).toContain("SUPERSET_PANE_ID");
		});
	}
});

// (HOOK-FORK-DIET) Every agent lifecycle hook must parse + escape JSON with bash
// builtins. The old echo|grep|grep|tr + printf|sed pipelines forked ~30
// subprocesses per invocation; under the x64-emulated msys2 runtime on Windows
// ARM64 that fork volume corrupted the shared section (the `add_item errno 1`
// cascade that wedged every chat's hooks). Guard against any regression.
describe("fork-diet: hooks parse with bash builtins, not subprocess pipelines", () => {
	for (const template of HOOK_TEMPLATES) {
		it(`${template} uses fork-free builtins and carries the gate marker`, () => {
			const script = readTemplate(template);

			expect(script).toContain("(HOOK-FORK-DIET)");
			// stdin slurp via read, field extraction via bash regex, escape via ${//}.
			expect(script).toContain("IFS= read -r -d '' INPUT");
			expect(script).toContain("BASH_REMATCH");
			expect(script).toContain('JSON_ESCAPED="$s"');

			// No subprocess pipelines for parsing or escaping.
			expect(script).not.toContain("grep -oE");
			expect(script).not.toContain("$(cat)");
			expect(script).not.toContain("| sed -e");
		});
	}
});
