import { Badge } from "@superset/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { Fragment } from "react";
import { LuTriangleAlert } from "react-icons/lu";
import {
	type ClaudeAccountSidebarAccount,
	useClaudeAccountSidebarEntry,
} from "../../../../providers/ClaudeAccountSidebarProvider";
import {
	formatUsagePct,
	USAGE_PACE_CLASS,
	type UsagePaceLevel,
} from "../../../../utils/claudeUsagePace";

interface UsageSlot {
	key: string;
	pct: number;
	pace: UsagePaceLevel;
}

/** The percentages worth showing, in tray order: 5h, weekly, Fable. */
function usageSlots(account: ClaudeAccountSidebarAccount): UsageSlot[] {
	const slots: UsageSlot[] = [];
	if (account.fivePct !== null && account.fivePace !== null) {
		slots.push({ key: "five", pct: account.fivePct, pace: account.fivePace });
	}
	if (account.sevenPct !== null && account.sevenPace !== null) {
		slots.push({ key: "seven", pct: account.sevenPct, pace: account.sevenPace });
	}
	if (account.fablePct !== null && account.fablePace !== null) {
		slots.push({ key: "fable", pct: account.fablePct, pace: account.fablePace });
	}
	return slots;
}

function WarningIndicator({
	message,
	appearance,
}: {
	message: string;
	appearance: "dot" | "icon";
}) {
	const label = `Claude account warning: ${message}`;
	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				{appearance === "dot" ? (
					<span
						className="absolute right-0.5 top-0.5 size-2 rounded-full border border-background bg-amber-500"
						role="img"
						aria-label={label}
					/>
				) : (
					<span
						className="shrink-0 text-amber-500"
						role="img"
						aria-label={label}
					>
						<LuTriangleAlert className="size-3.5" />
					</span>
				)}
			</TooltipTrigger>
			<TooltipContent side="right" sideOffset={8}>
				<p className="text-xs font-medium">Claude account warning</p>
				<p className="max-w-64 text-xs text-muted-foreground">{message}</p>
			</TooltipContent>
		</Tooltip>
	);
}

export function ClaudeAccountIndicator({
	workspaceId,
	collapsed = false,
}: {
	workspaceId: string;
	collapsed?: boolean;
}) {
	const { state, account } = useClaudeAccountSidebarEntry(workspaceId);
	if (!state) return null;
	const warning = state.warning;

	if (collapsed) {
		return warning ? (
			<WarningIndicator message={warning.message} appearance="dot" />
		) : null;
	}

	const slots = account ? usageSlots(account) : [];

	return (
		<>
			{warning && (
				<WarningIndicator message={warning.message} appearance="icon" />
			)}
			{state.state === "pinned" && state.slug && (
				<Badge
					variant="outline"
					className="flex-col gap-0 rounded px-1 py-0 text-[9px] font-normal leading-none tabular-nums text-muted-foreground"
				>
					<span>{state.slug}</span>
					{slots.length > 0 && (
						<span className="flex gap-0.5">
							{slots.map((slot, index) => (
								<Fragment key={slot.key}>
									{index > 0 && <span>/</span>}
									<span className={USAGE_PACE_CLASS[slot.pace]}>
										{formatUsagePct(slot.pct)}
									</span>
								</Fragment>
							))}
						</span>
					)}
				</Badge>
			)}
		</>
	);
}
