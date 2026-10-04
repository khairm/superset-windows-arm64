import { formatDateTime } from "@superset/i18n/format";
import type { ClaudeScheduleTarget } from "renderer/hooks/host-service/useClaudeAccounts";

export function scheduleTargetLabel(target: ClaudeScheduleTarget): string {
	return target.kind === "default" ? "Default (tray)" : target.slug;
}

export function formatClock(time: Date | number): string {
	return formatDateTime(time, {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
}
