import { z } from "zod";

export const TRAY_STATE_SCHEMA_VERSION = 1;
const DEFAULT_TRIGGER_PCT = 99;
const TRIGGER_CHOICES = new Set([80, 90, 95, 96, 97, 98, 99, 100]);

export const trayStateV1Schema = z
	.object({
		trigger_five_pct: z.number().int().optional(),
		trigger_seven_pct: z.number().int().optional(),
	})
	.passthrough();

export interface TrayTriggers {
	five: number;
	seven: number;
}

export function parseTrayTriggers(raw: unknown): TrayTriggers {
	const parsed = trayStateV1Schema.parse(raw);
	const five = parsed.trigger_five_pct ?? DEFAULT_TRIGGER_PCT;
	const seven = parsed.trigger_seven_pct ?? DEFAULT_TRIGGER_PCT;
	if (!TRIGGER_CHOICES.has(five) || !TRIGGER_CHOICES.has(seven)) {
		throw new Error(
			`Tray state v${TRAY_STATE_SCHEMA_VERSION} has unsupported trigger lines: ${five}/${seven}`,
		);
	}
	return { five, seven };
}
