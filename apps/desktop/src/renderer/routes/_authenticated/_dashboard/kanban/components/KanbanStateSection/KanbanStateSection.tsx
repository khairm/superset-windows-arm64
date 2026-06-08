import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import { LuChevronRight } from "react-icons/lu";
import type { ReactNode } from "react";

interface KanbanStateSectionProps {
	title: string;
	count: number;
	collapsed: boolean;
	onCollapsedChange: (collapsed: boolean) => void;
	children: ReactNode;
}

/**
 * A column's collapsible Snoozed / Archived section. Mirrors the sidebar's
 * DashboardSidebarStateSection (chevron + title + "(n)" count). Rendered only
 * when the section has content.
 */
export function KanbanStateSection({
	title,
	count,
	collapsed,
	onCollapsedChange,
	children,
}: KanbanStateSectionProps) {
	return (
		<Collapsible
			open={!collapsed}
			onOpenChange={(open) => onCollapsedChange(!open)}
			className="mt-1"
		>
			<CollapsibleTrigger className="group flex w-full items-center gap-1 rounded px-1 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent/30">
				<LuChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
				<span>{title}</span>
				<span className="tabular-nums">({count})</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="flex flex-col gap-1 pt-1">
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
}
