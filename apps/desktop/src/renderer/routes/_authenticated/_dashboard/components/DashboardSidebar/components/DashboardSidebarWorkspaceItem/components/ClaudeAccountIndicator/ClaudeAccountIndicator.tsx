import { Badge } from "@superset/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { LuTriangleAlert } from "react-icons/lu";
import { useClaudeAccountSidebarEntry } from "../../../../providers/ClaudeAccountSidebarProvider";

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

	return (
		<>
			{warning && (
				<WarningIndicator message={warning.message} appearance="icon" />
			)}
			{state.state === "pinned" && state.slug && (
				<Badge
					variant="outline"
					className="rounded px-1 py-0 text-[9px] font-normal leading-tight tabular-nums text-muted-foreground"
				>
					{state.slug}
					{account?.fivePct !== null && account?.fivePct !== undefined && (
						<span className="opacity-70">{account.fivePct}%</span>
					)}
				</Badge>
			)}
		</>
	);
}
