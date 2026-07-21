import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useNavigate } from "@tanstack/react-router";
import { TerminalSquare } from "lucide-react";
import { usePresetIcon } from "renderer/assets/app-icons/preset-icons";
import { navigateToV2Workspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import {
	getStatusTooltip,
	StatusIndicator,
} from "renderer/screens/main/components/StatusIndicator";
import type { DashboardSidebarWorkspaceTabChip as TabChip } from "../../hooks/useDashboardSidebarWorkspaceTabChips";

interface DashboardSidebarWorkspaceTabChipProps {
	workspaceId: string;
	tab: TabChip;
}

export function DashboardSidebarWorkspaceTabChip({
	workspaceId,
	tab,
}: DashboardSidebarWorkspaceTabChipProps) {
	const navigate = useNavigate();
	const iconUrl = usePresetIcon(tab.agentId ?? "");
	const statusLabel = tab.status
		? getStatusTooltip(tab.status)
		: "No active status";

	const handleClick = () => {
		void navigateToV2Workspace(workspaceId, navigate, {
			search: {
				tabId: tab.tabId,
				focusRequestId: crypto.randomUUID(),
			},
		});
	};

	return (
		<Tooltip delayDuration={500}>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={handleClick}
					className="flex h-[20px] min-w-0 items-center rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<span className="relative flex size-3 shrink-0 items-center justify-center">
						{iconUrl ? (
							<img src={iconUrl} alt="" className="size-3 object-contain" />
						) : (
							<TerminalSquare className="size-3" />
						)}
						{tab.status && (
							<StatusIndicator
								status={tab.status}
								className="absolute -top-0.5 -right-0.5"
							/>
						)}
					</span>
					<span className="ml-1 max-w-28 truncate">{tab.title}</span>
				</button>
			</TooltipTrigger>
			<TooltipContent side="top" sideOffset={6} showArrow={false}>
				<div className="space-y-1 text-xs">
					<div className="font-medium">{tab.title}</div>
					<div className="text-background/70">{statusLabel}</div>
					<div className="text-[10px] text-background/60">
						Click to open tab
					</div>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
