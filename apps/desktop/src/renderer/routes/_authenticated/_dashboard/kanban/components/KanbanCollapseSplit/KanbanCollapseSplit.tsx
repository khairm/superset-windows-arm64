import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LuChevronLeft } from "react-icons/lu";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { V2WorkspaceMount } from "renderer/routes/_authenticated/_dashboard/v2-workspace/components/V2WorkspaceMount";
import { ResizablePanel } from "renderer/screens/main/components/ResizablePanel";
import { KanbanBoard } from "../KanbanBoard";

interface KanbanCollapseSplitProps {
	workspaceId: string;
}

/**
 * When a bound card is clicked, the board collapses to a narrow left rail and
 * the branch's normal workspace centre opens on the right. The rail is the same
 * <KanbanBoard/> (so you can keep triaging / switch cards); the right side is
 * the shared <V2WorkspaceMount/> keyed by workspaceId so it remounts per card.
 */
export function KanbanCollapseSplit({ workspaceId }: KanbanCollapseSplitProps) {
	const navigate = useNavigate();
	const collections = useCollections();
	const [width, setWidth] = useState(360);
	const [resizing, setResizing] = useState(false);

	// If the selected branch is deleted while open, exit the split back to the
	// board instead of leaving a "workspace not found" pane mounted.
	const { data: workspaces = [], isReady } = useLiveQuery(
		(q) =>
			q
				.from({ w: collections.v2Workspaces })
				.where(({ w }) => eq(w.id, workspaceId)),
		[collections, workspaceId],
	);
	useEffect(() => {
		if (isReady && workspaces.length === 0) {
			navigate({ to: "/kanban", search: { cardId: undefined }, replace: true });
		}
	}, [isReady, workspaces.length, navigate]);

	return (
		<div className="flex h-full min-h-0 w-full min-w-0">
			<ResizablePanel
				width={width}
				onWidthChange={setWidth}
				isResizing={resizing}
				onResizingChange={setResizing}
				minWidth={260}
				maxWidth={560}
				handleSide="right"
				onDoubleClickHandle={() => setWidth(360)}
			>
				<div className="flex h-full min-h-0 flex-col border-r border-border">
					<div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
						<button
							type="button"
							onClick={() =>
								navigate({ to: "/kanban", search: { cardId: undefined } })
							}
							className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<LuChevronLeft className="size-3.5" /> Board
						</button>
					</div>
					<div className="min-h-0 flex-1 overflow-hidden">
						<KanbanBoard />
					</div>
				</div>
			</ResizablePanel>
			<div className="flex min-w-0 flex-1 flex-col">
				<V2WorkspaceMount key={workspaceId} workspaceId={workspaceId} />
			</div>
		</div>
	);
}
