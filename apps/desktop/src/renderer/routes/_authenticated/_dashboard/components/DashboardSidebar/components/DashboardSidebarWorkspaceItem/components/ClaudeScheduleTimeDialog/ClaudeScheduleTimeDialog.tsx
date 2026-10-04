import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { useState } from "react";
import {
	type ClaudeScheduleTarget,
	useScheduleClaudeSwitch,
} from "renderer/hooks/host-service/useClaudeAccounts";
import { useWorkspaceHostUrl } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { useNow } from "renderer/hooks/useNow";
import {
	formatClock,
	scheduleTargetLabel,
} from "../../utils/claudeScheduleFormat";
import { type ClockTime, nextOccurrence } from "./utils/nextOccurrence";

const CLOCK_TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;
const PREFILL_LEAD_MS = 60 * 60_000;

function parseClockTime(text: string): ClockTime | null {
	const match = CLOCK_TIME_PATTERN.exec(text.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	return hours <= 23 && minutes <= 59 ? { hours, minutes } : null;
}

function toClockInput(date: Date): string {
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

// (CLAUDE-ACCOUNT-SCHEDULE)
export function ClaudeScheduleTimeDialog({
	workspaceId,
	target,
	onClose,
}: {
	workspaceId: string;
	target: ClaudeScheduleTarget;
	onClose: () => void;
}) {
	const hostUrl = useWorkspaceHostUrl(workspaceId);
	const scheduleSwitch = useScheduleClaudeSwitch(hostUrl, workspaceId, {
		inlineErrors: true,
	});
	const [text, setText] = useState(() =>
		toClockInput(new Date(Date.now() + PREFILL_LEAD_MS)),
	);
	const now = useNow(1000);
	const time = parseClockTime(text);
	const occurrence = time === null ? null : nextOccurrence(time, now);

	const submit = () => {
		if (time === null || scheduleSwitch.isPending) return;
		const fireAt = nextOccurrence(time, new Date()).at.getTime();
		scheduleSwitch.mutate({ target, fireAt }, { onSuccess: onClose });
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
				<DialogHeader>
					<DialogTitle>{`Schedule switch to ${scheduleTargetLabel(target)}`}</DialogTitle>
				</DialogHeader>
				<form
					className="space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<Input
						autoFocus
						value={text}
						placeholder="HH:MM"
						aria-label="Time (HH:MM)"
						aria-invalid={time === null}
						onChange={(event) => setText(event.target.value)}
					/>
					{occurrence === null ? (
						<p className="text-sm text-destructive">
							Enter a time as HH:MM, for example 09:30
						</p>
					) : (
						<p className="text-sm text-muted-foreground">
							{`Fires ${occurrence.day} at ${formatClock(occurrence.at)}`}
						</p>
					)}
					{scheduleSwitch.error && (
						<p className="text-sm text-destructive">
							{scheduleSwitch.error.message}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={time === null || scheduleSwitch.isPending}
						>
							Schedule
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
