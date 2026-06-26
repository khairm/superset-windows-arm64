// (AUTO-RESUME) Global on/off toggle, persisted as a small JSON file (no DB migration).
// Default ON for Claude auto-send; Codex auto-send defaults OFF (notify-only) because no
// validated standalone Codex usage-limit signal exists yet.
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTO_RESUME_DIR } from "../registry/registry";

const CONFIG_PATH = path.join(AUTO_RESUME_DIR, "config.json");

export interface AutoResumeConfig {
	enabled: boolean;
	codexAutoSend: boolean;
}

const DEFAULTS: AutoResumeConfig = { enabled: true, codexAutoSend: false };

export function readConfig(): AutoResumeConfig {
	try {
		const raw = fs.readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<AutoResumeConfig>;
		return {
			enabled: parsed.enabled ?? DEFAULTS.enabled,
			codexAutoSend: parsed.codexAutoSend ?? DEFAULTS.codexAutoSend,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export function writeConfig(next: Partial<AutoResumeConfig>): AutoResumeConfig {
	const merged = { ...readConfig(), ...next };
	// Fail LOUD: if we can't persist, the toggle would silently lie (UI says off, the
	// file still says on, the next scheduler tick reads on). Surface it to the caller so
	// the tRPC mutation rejects and the optimistic UI reverts.
	fs.mkdirSync(AUTO_RESUME_DIR, { recursive: true, mode: 0o700 });
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged), { mode: 0o600 });
	return merged;
}
