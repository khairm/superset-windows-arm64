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
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
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

	const { data: projects = [] } = useLiveQuery(
		(q) => q.from({ p: collections.v2Projects }),
		[collections],
	);
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

	// Reset the chosen repo when the dialog (re)opens for a card.
	useEffect(() => {
		if (state) setProjectId("");
	}, [state?.queuedCardId]);
	// Seed the branch name from the queued card's title — re-run when the queued
	// row actually loads (its id flips from undefined), so the prefill isn't lost.
	useEffect(() => {
		if (state) setBranch(slugifyBranch(queuedCard?.title ?? ""));
	}, [state?.queuedCardId, queuedCard?.id]);

	const sortedProjects = useMemo(
		() => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
		[projects],
	);

	const handleConfirm = async () => {
		if (!state || !projectId || !isResolved || submitting) return;
		setSubmitting(true);
		try {
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
			// cards are v2 workspaces. submit() optimistically inserts the v2 row;
			// `completed` resolves with the real workspace id.
			const snapshotId = crypto.randomUUID();
			const { completed } = submit({
				hostId: machineId,
				snapshot: {
					id: snapshotId,
					projectId,
					name: queuedCard?.title?.trim() || branch.trim() || "New workspace",
					branch: branch.trim() || undefined,
					agents: [],
				},
			});
			const outcome = await completed;
			if (!outcome.ok) {
				toast.error(`Couldn't create the branch: ${outcome.error}`);
				return;
			}
			actions.completePromote(
				state.queuedCardId,
				outcome.workspaceId,
				state.targetColumnId,
			);
			onClose();
		} catch (err) {
			toast.error(
				`Couldn't create the branch: ${
					err instanceof Error ? err.message : "unknown error"
				}`,
			);
		} finally {
			setSubmitting(false);
		}
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
