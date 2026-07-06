import { Button } from "@superset/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@superset/ui/hover-card";
import { toast } from "@superset/ui/sonner";
import { TableCell, TableRow } from "@superset/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CgLaptop } from "react-icons/cg";
import {
	LuArrowUpRight,
	LuCircleCheck,
	LuCircleDashed,
	LuCircleX,
	LuGitBranch,
	LuLaptop,
	LuMonitor,
	LuTrash2,
} from "react-icons/lu";
import { RiPushpinFill, RiPushpinLine } from "react-icons/ri";
import { GATED_FEATURES, usePaywall } from "renderer/components/Paywall";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { navigateToV2Workspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import { V2WorkspacePrHoverCardContent } from "renderer/routes/_authenticated/_dashboard/v2-workspaces/components/V2WorkspacePrHoverCardContent";
import type {
	AccessibleV2Workspace,
	V2WorkspaceHostType,
	V2WorkspacePrSummary,
} from "renderer/routes/_authenticated/_dashboard/v2-workspaces/hooks/useAccessibleV2Workspaces";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useDeletingWorkspaces } from "renderer/routes/_authenticated/providers/DeletingWorkspacesProvider";
import { PRIcon } from "renderer/screens/main/components/PRIcon/PRIcon";
import { getRelativeTime } from "renderer/screens/main/components/WorkspacesListView/utils";

interface V2WorkspaceRowProps {
	workspace: AccessibleV2Workspace;
	isCurrentRoute: boolean;
}

function hostIconFor(hostType: V2WorkspaceHostType) {
	return hostType === "local-device" ? LuLaptop : LuMonitor;
}

export function V2WorkspaceRow({
	workspace,
	isCurrentRoute,
}: V2WorkspaceRowProps) {
	const navigate = useNavigate();
	const { gateFeature } = usePaywall();
	const {
		ensureWorkspaceInSidebar,
		hideWorkspaceInSidebar,
		archiveWorkspace,
		deleteWorkspace,
		unarchiveWorkspace,
	} = useDashboardSidebarState();
	const { copyToClipboard } = useCopyToClipboard();
	const isMainWorkspace = workspace.type === "main";
	const { isDeleting } = useDeletingWorkspaces();
	const deleting = isDeleting(workspace.id);

	const HostIcon = hostIconFor(workspace.hostType);

	const treatAsOffline =
		!workspace.hostIsOnline && workspace.hostType !== "local-device";

	const handleOpen = useCallback(() => {
		const open = () => navigateToV2Workspace(workspace.id, navigate);
		if (workspace.hostType === "local-device") {
			open();
			return;
		}
		gateFeature(GATED_FEATURES.REMOTE_WORKSPACES, open);
	}, [gateFeature, navigate, workspace.hostType, workspace.id]);

	const addToSidebar = useCallback(() => {
		const add = () => {
			// An archived thread is already in the sidebar's data — restore it
			// instead of re-inserting (ensureWorkspaceInSidebar no-ops on it).
			if (workspace.isArchived) {
				unarchiveWorkspace(workspace.id);
			} else {
				ensureWorkspaceInSidebar(workspace.id, workspace.projectId);
			}
		};
		if (workspace.hostType === "local-device") {
			add();
			return;
		}
		gateFeature(GATED_FEATURES.REMOTE_WORKSPACES, add);
	}, [
		ensureWorkspaceInSidebar,
		unarchiveWorkspace,
		gateFeature,
		workspace.hostType,
		workspace.id,
		workspace.isArchived,
		workspace.projectId,
	]);

	const removeFromSidebar = useCallback(() => {
		if (isCurrentRoute) return;
		// Unpin directly (synchronous optimistic write) rather than routing
		// through the intent store + RemoveFromSidebarMount effect, which adds
		// an extra render cycle of latency. The list view is never a workspace
		// route, so there's no active workspace to navigate away from.
		if (isMainWorkspace) {
			// (MASTER-ARCHIVE-ONLY) Master / non-git master cards ARCHIVE
			// (recoverable under the project's Archived section) — they can
			// never be hard-removed/hidden.
			archiveWorkspace(workspace.id, workspace.projectId);
		} else {
			// Always hide (keep the row with isHidden) rather than delete: the
			// auto-add-local-workspaces hook treats a missing v2WorkspaceLocalState
			// row as never-seen and would re-pin it. The tombstone row preserves the
			// unpin intent.
			hideWorkspaceInSidebar(workspace.id, workspace.projectId);
		}
	}, [
		isCurrentRoute,
		isMainWorkspace,
		archiveWorkspace,
		hideWorkspaceInSidebar,
		workspace.id,
		workspace.projectId,
	]);

	const handleCopyBranchName = useCallback(async () => {
		try {
			await copyToClipboard(workspace.branch);
			toast.success("Branch name copied");
		} catch (error) {
			toast.error(
				`Failed to copy branch name: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}, [copyToClipboard, workspace.branch]);

	// (RECYCLE-BIN) The list-row trash is a SILENT soft-delete now — it moves the
	// thread to its project's Recycle Bin (deletedAt + isHidden) instead of opening
	// the destroy dialog. The real git destroy is reachable ONLY from in-bin
	// "Delete permanently" / "Empty Recycle Bin". Mains never reach here (the button
	// only renders for non-main rows; deleteWorkspace no-ops a main anyway).
	const handleDelete = useCallback(() => {
		deleteWorkspace(workspace.id, workspace.projectId);
	}, [deleteWorkspace, workspace.id, workspace.projectId]);

	const handleDeleteClick = useCallback(
		(event: React.MouseEvent) => {
			event.stopPropagation();
			handleDelete();
		},
		[handleDelete],
	);

	const creatorLabel = workspace.isCreatedByCurrentUser
		? "you"
		: (workspace.createdByName ?? "unknown");

	const timeLabel = getRelativeTime(workspace.createdAt.getTime(), {
		format: "compact",
	});

	const handleRowKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTableRowElement>) => {
			if (event.target !== event.currentTarget) return;
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				handleOpen();
			}
		},
		[handleOpen],
	);

	const hostCell = (
		<span
			className={cn(
				"flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
				treatAsOffline && "text-muted-foreground/60",
			)}
			title={workspace.hostName}
		>
			<HostIcon className="size-3 shrink-0" />
			<span className="min-w-0 truncate">{workspace.hostName}</span>
			{treatAsOffline ? (
				<span
					aria-hidden
					className="inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
				/>
			) : null}
		</span>
	);

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<TableRow
						aria-current={isCurrentRoute ? "page" : undefined}
						aria-busy={deleting}
						tabIndex={deleting ? -1 : 0}
						onClick={handleOpen}
						onKeyDown={handleRowKeyDown}
						className={cn(
							"group/row border-border/50 text-sm outline-none",
							"cursor-pointer transition-colors",
							"focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
							isCurrentRoute
								? "bg-muted hover:bg-muted focus-visible:bg-muted"
								: "hover:bg-accent/50 focus-visible:bg-accent/50",
							deleting && "pointer-events-none opacity-50",
						)}
					>
						<TableCell className="py-1.5 pl-6">
							<div className="flex items-center justify-center">
								{workspace.isCompleted ? (
									// (KANBAN COMPLETED) no pin affordance: the thread is completed
									// on the kanban board and deliberately has NO sidebar surface.
									// Pinning here would half-uncomplete it (sidebar visible, card
									// still in Completed) — restoring is board-only (drag out).
									<Tooltip delayDuration={300}>
										<TooltipTrigger asChild>
											<LuCircleCheck
												className="size-4 shrink-0 text-emerald-500/80"
												aria-label="Completed"
											/>
										</TooltipTrigger>
										<TooltipContent side="right">
											Completed on the kanban board — drag its card out of
											Completed to restore it to the sidebar
										</TooltipContent>
									</Tooltip>
								) : workspace.isInSidebar ? (
									<Tooltip delayDuration={300}>
										<TooltipTrigger asChild>
											<Button
												size="icon"
												variant="ghost"
												onClick={(event) => {
													event.stopPropagation();
													removeFromSidebar();
												}}
												aria-disabled={isCurrentRoute}
												aria-pressed
												aria-label="Unpin from sidebar"
												className={cn(
													"size-7 text-foreground hover:bg-transparent hover:text-muted-foreground dark:hover:bg-transparent",
													isCurrentRoute && "cursor-not-allowed opacity-50",
												)}
											>
												<RiPushpinFill className="size-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent side="right">
											{isCurrentRoute
												? "Can't unpin the current workspace"
												: "Unpin from sidebar"}
										</TooltipContent>
									</Tooltip>
								) : (
									<Tooltip delayDuration={300}>
										<TooltipTrigger asChild>
											<Button
												size="icon"
												variant="ghost"
												onClick={(event) => {
													event.stopPropagation();
													addToSidebar();
												}}
												aria-pressed={false}
												aria-label="Pin to sidebar"
												className="size-7 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
											>
												<RiPushpinLine className="size-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent side="right">Pin to sidebar</TooltipContent>
									</Tooltip>
								)}
							</div>
						</TableCell>

						<TableCell className="py-1.5">
							<span className="flex min-w-0 items-center gap-2">
								{isMainWorkspace ? (
									<Tooltip delayDuration={300}>
										<TooltipTrigger asChild>
											<CgLaptop
												className="size-3.5 shrink-0 text-muted-foreground"
												aria-label="Main workspace"
											/>
										</TooltipTrigger>
										<TooltipContent side="top">Main workspace</TooltipContent>
									</Tooltip>
								) : null}
								<span
									className="min-w-0 truncate font-medium text-foreground"
									title={workspace.name}
								>
									{workspace.name}
								</span>
								{workspace.pr ? (
									<WorkspacePrPill pr={workspace.pr} branch={workspace.branch} />
								) : null}
							</span>
						</TableCell>

						<TableCell className="hidden py-1.5 md:table-cell">
							{treatAsOffline ? (
								<Tooltip delayDuration={300}>
									<TooltipTrigger asChild>{hostCell}</TooltipTrigger>
									<TooltipContent side="top">Host is offline</TooltipContent>
								</Tooltip>
							) : (
								hostCell
							)}
						</TableCell>

						<TableCell className="hidden py-1.5 lg:table-cell">
							<span
								className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
								title={workspace.branch}
							>
								<LuGitBranch className="size-3 shrink-0" />
								<span className="min-w-0 truncate font-mono text-[11px]">
									{workspace.branch}
								</span>
							</span>
						</TableCell>

						<TableCell
							className="hidden truncate py-1.5 text-xs tabular-nums text-muted-foreground xl:table-cell"
							title={`Created ${workspace.createdAt.toLocaleString()} by ${creatorLabel}`}
						>
							{timeLabel} · {creatorLabel}
						</TableCell>

						<TableCell className="py-1.5 pr-6">
							<div className="flex items-center justify-center">
								{deleting ? (
									<AsciiSpinner />
								) : !isMainWorkspace ? (
									<Button
										size="icon"
										variant="ghost"
										onClick={handleDeleteClick}
										aria-label="Delete workspace"
										className="size-7 text-muted-foreground opacity-0 transition-opacity hover:bg-transparent hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100 dark:hover:bg-transparent"
									>
										<LuTrash2 className="size-3.5" />
									</Button>
								) : null}
							</div>
						</TableCell>
					</TableRow>
				</ContextMenuTrigger>
				<ContextMenuContent
					onCloseAutoFocus={(event) => event.preventDefault()}
				>
					<ContextMenuItem onSelect={handleOpen}>
						<LuArrowUpRight className="size-4" />
						Open
					</ContextMenuItem>
					<ContextMenuItem onSelect={handleCopyBranchName}>
						<LuGitBranch className="size-4" />
						Copy Branch Name
					</ContextMenuItem>
					<ContextMenuSeparator />
					{workspace.isInSidebar ? (
						<ContextMenuItem
							onSelect={removeFromSidebar}
							disabled={isCurrentRoute}
						>
							<RiPushpinLine className="size-4" />
							Unpin from Sidebar
						</ContextMenuItem>
					) : (
						<ContextMenuItem onSelect={addToSidebar}>
							<RiPushpinFill className="size-4" />
							Pin to Sidebar
						</ContextMenuItem>
					)}
					{!isMainWorkspace ? (
						<>
							<ContextMenuSeparator />
							{/* (RECYCLE-BIN) Silent soft-delete to the project's Recycle Bin —
							    not a destroy dialog. */}
							<ContextMenuItem
								onSelect={handleDelete}
								className="text-destructive focus:text-destructive"
							>
								<LuTrash2 className="size-4 text-destructive" />
								Delete
							</ContextMenuItem>
						</>
					) : null}
				</ContextMenuContent>
			</ContextMenu>
		</>
	);
}

interface WorkspacePrPillProps {
	pr: V2WorkspacePrSummary;
	branch: string;
}

function WorkspacePrPill({ pr, branch }: WorkspacePrPillProps) {
	return (
		<HoverCard openDelay={200} closeDelay={120}>
			<HoverCardTrigger asChild>
				<a
					href={pr.url}
					target="_blank"
					rel="noreferrer"
					onClick={(event) => event.stopPropagation()}
					className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<PRIcon state={pr.state} className="size-3" />
					<span className="tabular-nums">#{pr.prNumber}</span>
					<ChecksDot status={pr.checksStatus} />
				</a>
			</HoverCardTrigger>
			<HoverCardContent
				side="top"
				align="start"
				className="w-80 p-3"
				onClick={(event) => event.stopPropagation()}
			>
				<V2WorkspacePrHoverCardContent pr={pr} branch={branch} />
			</HoverCardContent>
		</HoverCard>
	);
}

interface ChecksDotProps {
	status: V2WorkspacePrSummary["checksStatus"];
}

function ChecksDot({ status }: ChecksDotProps) {
	if (status === "none") return null;
	if (status === "pending") {
		return <LuCircleDashed className="size-3 text-amber-500" />;
	}
	if (status === "success") {
		return <LuCircleCheck className="size-3 text-emerald-500" />;
	}
	return <LuCircleX className="size-3 text-red-500" />;
}

const ASCII_SPINNER_FRAMES = ["◰", "◳", "◲", "◱"];
const ASCII_SPINNER_INTERVAL_MS = 120;

function AsciiSpinner() {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const id = setInterval(() => {
			setFrame((prev) => (prev + 1) % ASCII_SPINNER_FRAMES.length);
		}, ASCII_SPINNER_INTERVAL_MS);
		return () => clearInterval(id);
	}, []);

	return (
		<output
			aria-label="Deleting workspace"
			className="select-none font-mono text-base leading-none tabular-nums text-muted-foreground"
		>
			{ASCII_SPINNER_FRAMES[frame]}
		</output>
	);
}
