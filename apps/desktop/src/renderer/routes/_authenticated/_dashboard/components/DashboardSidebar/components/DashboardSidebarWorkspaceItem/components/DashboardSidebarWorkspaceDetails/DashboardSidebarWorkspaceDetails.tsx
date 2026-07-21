import { OverflowFadeContainer } from "@superset/ui/overflow-fade-container";
import { cn } from "@superset/ui/utils";
import type { CSSProperties, MouseEvent } from "react";
import { LuRadioTower, LuX } from "react-icons/lu";
import { STROKE_WIDTH } from "renderer/screens/main/components/WorkspaceSidebar/constants";
import { useInlineWorkspacePortsEnabled } from "renderer/stores/inline-workspace-ports";
import { useWorkspaceAgentsRowEnabled } from "renderer/stores/workspace-agents-row";
import { useDashboardSidebarWorkspacePorts } from "../../../../providers/DashboardSidebarPortsProvider";
import { DashboardSidebarPortBadge } from "../../../DashboardSidebarPortsList/components/DashboardSidebarPortBadge";
import { useDashboardSidebarPortKill } from "../../../DashboardSidebarPortsList/hooks/useDashboardSidebarPortKill";
import { DashboardSidebarWorkspaceDetailsAction } from "./components/DashboardSidebarWorkspaceDetailsAction";
import { DashboardSidebarWorkspaceTabChip } from "./components/DashboardSidebarWorkspaceTabChip";
import { useDashboardSidebarWorkspaceTabChips } from "./hooks/useDashboardSidebarWorkspaceTabChips";

interface DashboardSidebarWorkspaceDetailsProps {
	workspaceId: string;
	isInSection?: boolean;
	/** Invoked when the strip itself (not one of its chips) is clicked. */
	onClick?: () => void;
}

/**
 * Wraps one element that unfolds when the strip is `details-expanded`: its
 * max-width, margin and opacity animate from zero, so the content slides out
 * of the cluster and retracts back into it (rather than fading in place).
 * `visibility` rides the transition so collapsed content isn't interactive.
 */
const UNFOLD_WRAPPER = cn(
	"invisible max-w-0 shrink-0 overflow-hidden opacity-0",
	"transition-[max-width,margin,opacity,visibility] duration-500 ease-out motion-reduce:transition-none",
	"details-expanded:visible details-expanded:ml-1.5 details-expanded:opacity-100 details-expanded:duration-200",
);

/** Cap the port-pill stagger so long lists don't drag the animation out. */
const MAX_STAGGERED_PORTS = 8;
const STAGGER_STEP_MS = 25;

export function DashboardSidebarWorkspaceDetails({
	workspaceId,
	isInSection = false,
	onClick,
}: DashboardSidebarWorkspaceDetailsProps) {
	const inlineWorkspacePortsEnabled = useInlineWorkspacePortsEnabled();
	const workspaceAgentsRowEnabled = useWorkspaceAgentsRowEnabled();
	const { isPending: isKillingPorts, killPorts } =
		useDashboardSidebarPortKill();

	const portGroup = useDashboardSidebarWorkspacePorts(workspaceId);
	const ports = inlineWorkspacePortsEnabled ? (portGroup?.ports ?? []) : [];
	const tabChips = useDashboardSidebarWorkspaceTabChips(
		workspaceId,
		workspaceAgentsRowEnabled,
	);
	const showTabChips = workspaceAgentsRowEnabled && tabChips.length >= 2;

	if (ports.length === 0 && !showTabChips) {
		return null;
	}

	const paddingClass = isInSection ? "pl-[58px]" : "pl-[50px]";
	const handleStripClick = (event: MouseEvent<HTMLElement>) => {
		if (!onClick) return;
		const target = event.target as HTMLElement;
		if (!event.currentTarget.contains(target)) return;
		if (target.closest("button, a, [role='button'], [role='menuitem']")) return;
		onClick();
	};

	return (
		<div>
			{/* (TAB-CHIPS) Every open tab gets one always-expanded chip in pane-layout
			    order. This wrapping row is separate from the port facepile animation so
			    long tab titles never force ports into horizontal scrolling. */}
			{showTabChips && (
				// biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: empty strip space mirrors the parent workspace row; chips remain native buttons
				<div
					className={cn(
						"flex flex-wrap items-center gap-1 pr-2 pb-1",
						paddingClass,
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
			)}

			{ports.length > 0 && (
				<OverflowFadeContainer
					observeChildren
					className={cn(
						"group/details flex h-[22px] items-center overflow-x-auto hide-scrollbar pr-2",
						paddingClass,
						onClick && "cursor-pointer",
					)}
					onMouseDown={(event) => event.stopPropagation()}
					onTouchStart={(event) => event.stopPropagation()}
					onClick={handleStripClick}
				>
					<span
						className={cn(
							"flex h-[18px] shrink-0 items-center gap-1 overflow-hidden rounded-full bg-muted/60",
							"text-[9px] font-medium tabular-nums text-muted-foreground",
							"max-w-14 px-1.5 opacity-100",
							"transition-[max-width,margin,padding,opacity] duration-500 ease-out motion-reduce:transition-none",
							"details-expanded:max-w-0 details-expanded:px-0 details-expanded:opacity-0 details-expanded:duration-200",
						)}
					>
						<LuRadioTower
							className="size-2.5 shrink-0"
							strokeWidth={STROKE_WIDTH}
						/>
						{ports.length}
					</span>

					{ports.map((port, index) => (
						<div
							key={`${port.hostId}:${port.terminalId}:${port.port}`}
							className={cn(
								UNFOLD_WRAPPER,
								"details-expanded:max-w-44 details-expanded:[transition-delay:var(--unfold-delay)]",
							)}
							style={
								{
									"--unfold-delay": `${Math.min(index, MAX_STAGGERED_PORTS) * STAGGER_STEP_MS}ms`,
								} as CSSProperties
							}
						>
							<DashboardSidebarPortBadge port={port} />
						</div>
					))}

					{ports.length > 1 && (
						<div className={cn(UNFOLD_WRAPPER, "details-expanded:max-w-8")}>
							<DashboardSidebarWorkspaceDetailsAction
								label="Close all ports"
								icon={<LuX className="size-3" strokeWidth={STROKE_WIDTH} />}
								busy={isKillingPorts}
								onClick={() => void killPorts(ports)}
							/>
						</div>
					)}
				</OverflowFadeContainer>
			)}
		</div>
	);
}
