import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { getSidebarHeaderTabButtonClassName } from "renderer/screens/main/components/WorkspaceView/RightSidebar/headerTabStyles";
import type { SidebarTabDefinition } from "../../types";

interface SidebarHeaderProps {
	tabs: SidebarTabDefinition[];
	activeTab: string;
	onTabChange: (id: string) => void;
	compact?: boolean;
}

export function SidebarHeader({
	tabs,
	activeTab,
	onTabChange,
	compact,
}: SidebarHeaderProps) {
	const actions = tabs.find((t) => t.id === activeTab)?.actions;

	return (
		// Wrapping header: tab titles that don't fit flow onto another row
		// (each button keeps a full h-10 row height) instead of clipping, and
		// non-compact buttons flex-grow to share whatever width their row has.
		<div className="flex min-h-10 shrink-0 flex-wrap items-stretch border-b border-border">
			{tabs.map((tab) => {
				const isActive = activeTab === tab.id;
				const badge =
					typeof tab.badge === "number" && tab.badge > 0
						? formatBadgeCount(tab.badge)
						: null;
				const label = badge ? `${tab.label} (${badge})` : tab.label;
				const btn = (
					<button
						key={tab.id}
						type="button"
						onClick={() => onTabChange(tab.id)}
						aria-label={label}
						className={cn(
							getSidebarHeaderTabButtonClassName({
								isActive,
								compact,
								inverted: true,
							}),
							"relative h-10",
							!compact && "flex-1 justify-center",
						)}
					>
						{tab.icon && <tab.icon className="size-3" />}
						{!compact && tab.label}
						{badge && (
							<span
								aria-hidden="true"
								className={cn(
									"shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium leading-4 tabular-nums text-muted-foreground",
									isActive && "bg-background/80 text-foreground",
									compact &&
										"absolute right-1 top-1 min-w-3 px-1 text-[9px] leading-3",
								)}
							>
								{badge}
							</span>
						)}
					</button>
				);

				if (compact) {
					return (
						<Tooltip key={tab.id}>
							<TooltipTrigger asChild>{btn}</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								{label}
							</TooltipContent>
						</Tooltip>
					);
				}

				return btn;
			})}
			{actions && (
				<div className="ml-auto flex h-10 shrink-0 items-center gap-0.5 pr-2">
					{actions}
				</div>
			)}
		</div>
	);
}

function formatBadgeCount(count: number): string {
	return count > 99 ? "99+" : String(count);
}
