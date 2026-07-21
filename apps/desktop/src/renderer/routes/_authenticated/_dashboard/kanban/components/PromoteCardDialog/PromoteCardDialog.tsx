import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useState } from "react";
import { useHostProjects } from "renderer/hooks/host-projects/useHostProjects";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import type { DashboardSidebarProjectRow } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useWorkspaceCreates } from "renderer/stores/workspace-creates";
import type { UseKanbanActionsResult } from "../../hooks/useKanbanActions";
import { useProjectGitState } from "../../hooks/useProjectGitState";

interface PromoteState {
	queuedCardId: string;
	targetColumnId: string;
}

interface PromoteCardDialogProps {
	state: PromoteState | null;
	actions: UseKanbanActionsResult;
	onClose: () => void;
}

function slugifyBranch(title: string): string {
	return title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

/**
 * Drag a Queued card out of column 1 → bind it to a branch. Git repos create a
 * new branch (name + branch). A non-git / multi-repo project has only its main
 * workspace (already a card), so selecting one MERGES the task into that main
 * card instead of creating a branch.
 */
export function PromoteCardDialog({
	state,
	actions,
	onClose,
}: PromoteCardDialogProps) {
	const collections = useCollections();
	const { submit } = useWorkspaceCreates();
	const { machineId } = useLocalHostService();
	const [projectId, setProjectId] = useState("");
	const [branch, setBranch] = useState("");
	const [submitting, setSubmitting] = useState(false);

	// Only projects PRESENT IN THE SIDEBAR (v2SidebarProjects ⋈ host projects —
	// the exact source the left bar renders from). A project removed from the
	// sidebar must not resurface as a promote target. Projects are fully local
	// now: identity comes from the host fan-out (useHostProjects), keyed by
	// projectKey which equals a sidebar row's projectId. Upstream retired the
	// `v2Projects` Electric collection.
	const { data: sidebarProjectRows = [] } = useLiveQuery(
		(q) => q.from({ sp: collections.v2SidebarProjects }),
		[collections],
	);
	const { projects: hostProjects } = useHostProjects();
	const projects = useMemo(() => {
		const nameByKey = new Map(hostProjects.map((p) => [p.projectKey, p.name]));
		const seen = new Set<string>();
		const result: { id: string; name: string }[] = [];
		for (const sp of sidebarProjectRows as DashboardSidebarProjectRow[]) {
			if (seen.has(sp.projectId)) continue;
			const name = nameByKey.get(sp.projectId);
			if (name == null) continue;
			seen.add(sp.projectId);
			result.push({ id: sp.projectId, name });
		}
		return result;
	}, [sidebarProjectRows, hostProjects]);
	const { data: [queuedCard] = [] } = useLiveQuery(
		(q) =>
			q
				.from({ c: collections.v2KanbanCards })
				.where(({ c }) => eq(c.id, state?.queuedCardId ?? "")),
		[collections, state?.queuedCardId],
	);

	const { mainWorkspaceId, isResolved, isGitRepo } = useProjectGitState(
		projectId,
		machineId,
	);
	// Only treat as non-git once git-ness is RESOLVED — useIsGitRepo/this hook
	// default to git while loading, so a fast submit must be blocked (see Confirm
	// disabled on !isResolved) to avoid wrongly branch-creating a non-git folder.
	const isNonGit = isResolved && !isGitRepo;

	// Reset the chosen repo (and the spent submit guard) when the dialog
	// (re)opens for a card.
	const openQueuedCardId = state?.queuedCardId ?? null;
	useEffect(() => {
		if (openQueuedCardId) {
			setProjectId("");
			setSubmitting(false);
		}
	}, [openQueuedCardId]);
	// Seed the branch name from the queued card's title — keyed to the loaded
	// row's title so the prefill isn't lost when the row arrives a tick late
	// (the title can't change while the modal dialog is open).
	const queuedTitle = queuedCard?.title ?? "";
	useEffect(() => {
		if (openQueuedCardId) setBranch(slugifyBranch(queuedTitle));
	}, [openQueuedCardId, queuedTitle]);

	const sortedProjects = useMemo(
		() => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
		[projects],
	);

	const handleConfirm = () => {
		if (!state || !projectId || !isResolved || submitting) return;
		if (isNonGit && mainWorkspaceId) {
			// Non-git repo: its single main workspace is already a card — merge.
			actions.completePromote(
				state.queuedCardId,
				mainWorkspaceId,
				state.targetColumnId,
			);
			onClose();
			return;
		}
		// v2 create: the host-service path (NOT the v1 workspaces.create) — board
		// cards are v2 workspaces. Submit, bind the card to the OPTIMISTIC
		// workspace id, and close — exactly like the sidebar flow, which never
		// blocks on `completed` (it resolves only after the sync round-trip;
		// awaiting it here left the dialog stuck on "Creating…", the queued card
		// in place, and the mirror's auto-created card beside it).
		setSubmitting(true);
		const snapshot = collections.v2KanbanCards.get(state.queuedCardId);
		const { workspaceId, completed } = submit({
			hostId: machineId,
			snapshot: {
				id: crypto.randomUUID(),
				projectId,
				name: queuedCard?.title?.trim() || branch.trim() || "New workspace",
				branch: branch.trim() || undefined,
				agents: [],
			},
		});
		actions.completePromote(
			state.queuedCardId,
			workspaceId,
			state.targetColumnId,
		);
		onClose();
		// Background continuation: fail loud + restore the queued card, or re-key
		// the bound card when the host persisted a different workspace id.
		void completed.then((outcome) => {
			if (!outcome.ok) {
				toast.error(`Couldn't create the branch: ${outcome.error}`);
				if (snapshot) actions.restoreQueuedCard(snapshot, workspaceId);
				return;
			}
			if (outcome.workspaceId !== workspaceId) {
				actions.rebindPromotedCard(workspaceId, outcome.workspaceId);
			}
		});
	};

	return (
		<Dialog
			open={state != null}
			onOpenChange={(open) => {
				if (!open && !submitting) onClose();
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Move to a branch</DialogTitle>
					<DialogDescription>
						This task needs a branch once it leaves Queued. Pick a repo to
						create one (or attach to a non-git folder's workspace).
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-1">
					<div className="flex flex-col gap-1.5">
						<Label className="text-xs">Repo</Label>
						<Select value={projectId} onValueChange={setProjectId}>
							<SelectTrigger>
								<SelectValue placeholder="Select a repo" />
							</SelectTrigger>
							<SelectContent>
								{sortedProjects.map((p) => (
									<SelectItem key={p.id} value={p.id}>
										{p.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{isNonGit ? (
						<p className="select-text text-xs text-muted-foreground">
							This is a non-git folder — the task will attach to its existing
							workspace (no branch is created).
						</p>
					) : (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="kanban-promote-branch" className="text-xs">
								Branch name
							</Label>
							<Input
								id="kanban-promote-branch"
								value={branch}
								onChange={(e) => setBranch(e.target.value)}
								placeholder="my-feature"
							/>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={submitting}>
						Cancel
					</Button>
					<Button
						onClick={handleConfirm}
						disabled={!projectId || !isResolved || submitting}
					>
						{submitting
							? "Creating…"
							: !isResolved
								? "Checking…"
								: isNonGit
									? "Attach"
									: "Create branch"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
