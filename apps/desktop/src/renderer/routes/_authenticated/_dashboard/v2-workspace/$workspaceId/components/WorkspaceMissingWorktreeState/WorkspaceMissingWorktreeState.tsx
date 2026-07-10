import { Button } from "@superset/ui/button";
import { Link } from "@tanstack/react-router";
import {
	Archive,
	ArrowRight,
	FolderX,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useNavigateAwayFromWorkspace } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/hooks/useNavigateAwayFromWorkspace";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";

interface WorkspaceMissingWorktreeStateProps {
	workspaceId: string;
	worktreePath?: string;
	onRefresh: () => void;
	isRefreshing?: boolean;
}

export function WorkspaceMissingWorktreeState({
	workspaceId,
	worktreePath,
	onRefresh,
	isRefreshing = false,
}: WorkspaceMissingWorktreeStateProps) {
	const { deleteWorkspace, archiveWorkspace } = useDashboardSidebarState();
	const { navigateAwayFromWorkspace } = useNavigateAwayFromWorkspace();
	const { workspaces: hostWorkspaces } = useHostWorkspaces();
	const hostWorkspace = hostWorkspaces.find(
		(candidate) => candidate.id === workspaceId,
	);
	// (MASTER-ARCHIVE-ONLY) Mains are never deletable — this page used to show
	// the Delete button for a main whose folder vanished, and the click silently
	// no-op'd against deleteWorkspace's guard. Offer Archive instead. Unknown
	// type fails safe to archive-only (archive is always recoverable).
	const isArchiveOnly = hostWorkspace?.type !== "worktree";

	// (RECYCLE-BIN) Nothing gets destroyed here: move the thread to its project's
	// Recycle Bin (soft-delete) and navigate off the dead-worktree route. The real
	// git cleanup is reachable ONLY from in-bin "Delete permanently" / "Empty
	// Recycle Bin". (projectId resolves from the workspace record inside
	// deleteWorkspace; mains are refused there too.)
	const handleDelete = () => {
		navigateAwayFromWorkspace(workspaceId);
		deleteWorkspace(workspaceId);
	};

	const handleArchive = () => {
		navigateAwayFromWorkspace(workspaceId);
		archiveWorkspace(workspaceId, hostWorkspace?.projectId);
	};

	return (
		<div className="flex h-full w-full items-center justify-center p-6">
			<div className="flex w-full max-w-md flex-col items-start gap-5">
				<div className="grid size-10 place-items-center rounded-lg border border-destructive/20 bg-destructive/10">
					<FolderX
						className="size-[18px] text-destructive"
						strokeWidth={1.5}
						aria-hidden="true"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<h1 className="select-text cursor-text text-[15px] font-medium tracking-tight text-foreground">
						Worktree missing
					</h1>
					<p className="select-text cursor-text text-[13px] leading-relaxed text-muted-foreground">
						This workspace record still exists, but its worktree folder is no
						longer on this host. Terminals and file actions are unavailable.
					</p>
				</div>

				{worktreePath ? (
					<div className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5">
						<span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
							Path
						</span>
						<div className="min-w-0 flex-1 overflow-x-auto">
							<code
								className="inline-block min-w-max select-text cursor-text whitespace-nowrap font-mono text-[11px] text-muted-foreground"
								title={worktreePath}
							>
								{worktreePath}
							</code>
						</div>
					</div>
				) : null}

				<div className="flex flex-wrap items-center gap-2">
					{isArchiveOnly ? (
						<Button
							size="sm"
							variant="outline"
							className="h-7 gap-1.5 px-2.5 text-[13px]"
							onClick={handleArchive}
						>
							<Archive
								className="size-3.5"
								strokeWidth={2}
								aria-hidden="true"
							/>
							Archive workspace
						</Button>
					) : (
						<Button
							size="sm"
							variant="destructive"
							className="h-7 gap-1.5 px-2.5 text-[13px]"
							onClick={handleDelete}
						>
							<Trash2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
							Delete workspace
						</Button>
					)}
					<Button
						size="sm"
						variant="ghost"
						className="h-7 gap-1.5 px-2 text-[13px] font-medium"
						onClick={onRefresh}
						disabled={isRefreshing}
					>
						<RefreshCw
							className="size-3.5"
							strokeWidth={2}
							aria-hidden="true"
						/>
						Refresh
					</Button>
					<Button
						asChild
						size="sm"
						variant="ghost"
						className="h-7 gap-1.5 px-2 text-[13px] font-medium"
					>
						<Link to="/v2-workspaces">
							Browse workspaces
							<ArrowRight
								className="size-3.5"
								strokeWidth={2}
								aria-hidden="true"
							/>
						</Link>
					</Button>
				</div>
			</div>
		</div>
	);
}
