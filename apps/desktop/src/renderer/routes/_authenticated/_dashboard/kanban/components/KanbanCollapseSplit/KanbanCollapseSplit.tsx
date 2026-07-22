import { cn } from "@superset/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	LuChevronLeft,
	LuPanelLeft,
	LuPanelLeftClose,
	LuPanelTop,
} from "react-icons/lu";
import { V2WorkspaceMount } from "renderer/routes/_authenticated/_dashboard/v2-workspace/components/V2WorkspaceMount";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { ResizablePanel } from "renderer/screens/main/components/ResizablePanel";
import {
	KANBAN_SPLIT_DEFAULT_HEIGHT,
	KANBAN_SPLIT_DEFAULT_WIDTH,
	KANBAN_SPLIT_MAX_HEIGHT,
	KANBAN_SPLIT_MAX_WIDTH,
	KANBAN_SPLIT_MIN_HEIGHT,
	KANBAN_SPLIT_MIN_WIDTH,
	useKanbanSplitLayout,
} from "../../stores/kanbanSplitLayout";
import { KanbanBoard } from "../KanbanBoard";

interface KanbanCollapseSplitProps {
	workspaceId: string;
}

/**
 * When a bound card is clicked, the board collapses to a strip and the
 * branch's normal workspace centre opens in the remaining space. Two
 * orientations (device-local preference, default TOP): a horizontal strip
 * across the top — workspace centre + right sidebar push down, the dashboard
 * left menu is untouched — or the original narrow left rail. The strip/rail
 * hosts the same <KanbanBoard/> (keep triaging / switch cards); the workspace
 * side is the shared <V2WorkspaceMount/> keyed by workspaceId.
 */
export function KanbanCollapseSplit({ workspaceId }: KanbanCollapseSplitProps) {
	const navigate = useNavigate();
	const {
		orientation,
		topHeight,
		railWidth,
		setOrientation,
		setTopHeight,
		setRailWidth,
	} = useKanbanSplitLayout();
	const [resizing, setResizing] = useState(false);

	// If the selected branch is deleted while open, exit the split back to the
	// board instead of leaving a "workspace not found" pane mounted.
	// (KANBAN HOST SOURCE) Resolved against the host-served lists; only a READY
	// merge with the row absent counts as deleted — a transiently-unanswered
	// host must not bounce the user out of the split.
	const { workspaces: hostWorkspaces, isReady } = useHostWorkspaces();
	const workspaceExists = hostWorkspaces.some((w) => w.id === workspaceId);
	useEffect(() => {
		if (isReady && !workspaceExists) {
			navigate({ to: "/kanban", search: { cardId: undefined }, replace: true });
		}
	}, [isReady, workspaceExists, navigate]);

	const boardHeader = (
		<div className="flex shrink-0 items-center justify-end gap-1.5 border-b border-border px-2 py-1.5">
			<button
				type="button"
				title={
					orientation === "top"
						? "Move the board to a left rail"
						: "Move the board to a top bar"
				}
				onClick={() => setOrientation(orientation === "top" ? "left" : "top")}
				className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				{orientation === "top" ? (
					<LuPanelLeft className="size-3.5" />
				) : (
					<LuPanelTop className="size-3.5" />
				)}
			</button>
			<button
				type="button"
				title="Hide the board and open this workspace full size"
				onClick={() =>
					navigate({
						to: "/v2-workspace/$workspaceId",
						params: { workspaceId },
					})
				}
				className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<LuPanelLeftClose className="size-3.5" /> Hide board
			</button>
		</div>
	);

	const workspacePane = (
		<V2WorkspaceMount
			key={workspaceId}
			workspaceId={workspaceId}
			tabBarTrailingExtra={
				<button
					type="button"
					title="Close this workspace and return to the board"
					onClick={() =>
						navigate({ to: "/kanban", search: { cardId: undefined } })
					}
					className="mr-1 flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<LuChevronLeft className="size-3.5" /> Board
				</button>
			}
		/>
	);

	if (orientation === "top") {
		return (
			<div className="flex h-full min-h-0 w-full min-w-0 flex-col">
				<div
					className="relative flex shrink-0 flex-col border-b border-border"
					style={{ height: topHeight }}
				>
					{boardHeader}
					{/* MUST be a flex COLUMN: KanbanBoard's column row is `flex-1
					    min-h-0` (DndContext renders no DOM wrapper), so without a
					    flex parent the columns get auto height — cards overflow the
					    strip clipped and unreachable instead of scrolling. */}
					<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
						<KanbanBoard />
					</div>
					<VerticalResizeHandle
						height={topHeight}
						minHeight={KANBAN_SPLIT_MIN_HEIGHT}
						maxHeight={KANBAN_SPLIT_MAX_HEIGHT}
						isResizing={resizing}
						onResizingChange={setResizing}
						onHeightChange={setTopHeight}
						onDoubleClick={() => setTopHeight(KANBAN_SPLIT_DEFAULT_HEIGHT)}
					/>
				</div>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					{workspacePane}
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 w-full min-w-0">
			<ResizablePanel
				width={railWidth}
				onWidthChange={setRailWidth}
				isResizing={resizing}
				onResizingChange={setResizing}
				minWidth={KANBAN_SPLIT_MIN_WIDTH}
				maxWidth={KANBAN_SPLIT_MAX_WIDTH}
				handleSide="right"
				onDoubleClickHandle={() => setRailWidth(KANBAN_SPLIT_DEFAULT_WIDTH)}
			>
				<div className="flex h-full min-h-0 flex-col border-r border-border">
					{boardHeader}
					{/* MUST be a flex COLUMN: KanbanBoard's column row is `flex-1
					    min-h-0` (DndContext renders no DOM wrapper), so without a
					    flex parent the columns get auto height — cards overflow the
					    strip clipped and unreachable instead of scrolling. */}
					<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
						<KanbanBoard />
					</div>
				</div>
			</ResizablePanel>
			<div className="flex min-w-0 flex-1 flex-col">{workspacePane}</div>
		</div>
	);
}

interface VerticalResizeHandleProps {
	height: number;
	minHeight: number;
	maxHeight: number;
	isResizing: boolean;
	onResizingChange: (resizing: boolean) => void;
	onHeightChange: (height: number) => void;
	onDoubleClick?: () => void;
}

/**
 * Bottom-edge drag handle for the top-bar strip — the vertical twin of
 * <ResizablePanel/>'s side handle (rAF-coalesced, body cursor while dragging).
 * Local to the fork's collapse-split; the shared panel is width-only.
 */
function VerticalResizeHandle({
	height,
	minHeight,
	maxHeight,
	isResizing,
	onResizingChange,
	onHeightChange,
	onDoubleClick,
}: VerticalResizeHandleProps) {
	const startYRef = useRef(0);
	const startHeightRef = useRef(0);
	const pendingRef = useRef<number | null>(null);
	const rafRef = useRef<number | null>(null);

	const flushPending = useCallback(() => {
		const pending = pendingRef.current;
		pendingRef.current = null;
		if (pending === null) return;
		onHeightChange(pending);
	}, [onHeightChange]);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			startYRef.current = e.clientY;
			startHeightRef.current = height;
			onResizingChange(true);
		},
		[height, onResizingChange],
	);

	useEffect(() => {
		if (!isResizing) return;
		const handleMouseMove = (e: MouseEvent) => {
			const next = Math.max(
				minHeight,
				Math.min(
					maxHeight,
					startHeightRef.current + (e.clientY - startYRef.current),
				),
			);
			pendingRef.current = next;
			if (rafRef.current !== null) return;
			rafRef.current = requestAnimationFrame(() => {
				rafRef.current = null;
				flushPending();
			});
		};
		const handleMouseUp = () => {
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
			flushPending();
			onResizingChange(false);
		};
		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		document.body.style.userSelect = "none";
		document.body.style.cursor = "row-resize";
		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
			pendingRef.current = null;
		};
	}, [isResizing, minHeight, maxHeight, flushPending, onResizingChange]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: interactive resize handle, same pattern as ResizablePanel
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-valuenow={height}
			aria-valuemin={minHeight}
			aria-valuemax={maxHeight}
			tabIndex={0}
			onMouseDown={handleMouseDown}
			onDoubleClick={onDoubleClick}
			className={cn(
				"absolute -bottom-2 left-0 z-10 h-5 w-full cursor-row-resize",
				"after:absolute after:left-0 after:h-1 after:w-full after:transition-colors after:top-2",
				"hover:after:bg-border focus:outline-none focus:after:bg-border",
				isResizing && "after:bg-border",
			)}
		/>
	);
}
