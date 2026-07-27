import { cn } from "@superset/ui/utils";
import type { MouseEvent } from "react";
import { useWorkspaceAgentsRowEnabled } from "renderer/stores/workspace-agents-row";
import { DashboardSidebarWorkspaceTabChip } from "./components/DashboardSidebarWorkspaceTabChip";
import { useDashboardSidebarWorkspaceTabChips } from "./hooks/useDashboardSidebarWorkspaceTabChips";

interface DashboardSidebarWorkspaceDetailsProps {
	workspaceId: string;
	isInSection?: boolean;
	/** Invoked when the strip itself (not one of its chips) is clicked. */
	onClick?: () => void;
}

/**
 * (TAB-CHIPS) Per-tab chip row beneath a workspace row, left-aligned with the
 * title. Ports and running-agent facepiles live in the upstream
 * `DashboardSidebarWorkspaceChips` strip that renders directly below this one;
 * this row owns only the per-tab chips, so long tab titles wrap on their own
 * line instead of competing with the chips strip for horizontal space.
 */
export function DashboardSidebarWorkspaceDetails({
	workspaceId,
	isInSection = false,
	onClick,
}: DashboardSidebarWorkspaceDetailsProps) {
	const workspaceAgentsRowEnabled = useWorkspaceAgentsRowEnabled();

	const tabChips = useDashboardSidebarWorkspaceTabChips(
		workspaceId,
		workspaceAgentsRowEnabled,
	);
	const showTabChips = workspaceAgentsRowEnabled && tabChips.length >= 2;

	if (!showTabChips) {
		return null;
	}

	const handleStripClick = (event: MouseEvent<HTMLElement>) => {
		if (!onClick) return;
		const target = event.target as HTMLElement;
		if (!event.currentTarget.contains(target)) return;
		if (target.closest("button, a, [role='button'], [role='menuitem']")) return;
		onClick();
	};

	return (
		// Stop pointer/touch starts from bubbling to the sortable workspace item's
		// drag listeners, so pressing a chip isn't captured as a reorder gesture.
		// biome-ignore lint/a11y/noStaticElementInteractions: clicks on the strip's empty area mirror the row click; chips are real buttons
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation lives on the workspace row button; the strip click is a pointer convenience
		<div
			className={cn(
				"flex flex-wrap items-center gap-1 pr-2 pb-1",
				// Matches the padding of the upstream chips strip below it.
				isInSection ? "pl-[50px]" : "pl-[42px]",
				onClick && "cursor-pointer",
			)}
			onMouseDown={(event) => event.stopPropagation()}
			onTouchStart={(event) => event.stopPropagation()}
			onClick={handleStripClick}
		>
			{tabChips.map((tab) => (
				<DashboardSidebarWorkspaceTabChip
					key={tab.tabId}
					workspaceId={workspaceId}
					tab={tab}
				/>
			))}
		</div>
	);
}
