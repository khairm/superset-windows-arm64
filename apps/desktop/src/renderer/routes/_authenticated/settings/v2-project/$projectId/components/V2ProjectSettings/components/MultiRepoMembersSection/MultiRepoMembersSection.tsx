import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { LuFolderPlus, LuLoaderCircle, LuX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { getPathBaseName } from "shared/absolute-paths";

interface MultiRepoMembersSectionProps {
	projectId: string;
	hostUrl: string;
}

/**
 * (MULTI-REPO MEMBERS) Project Settings surface for a multi-repo project's
 * member list. Renders nothing for ordinary projects. Add is lazy — the new
 * repo is included in branch workspaces created from now on; remove
 * force-removes that repo's worktrees from every existing branch workspace
 * (confirmed via dialog — uncommitted work in those worktrees is lost).
 */
export function MultiRepoMembersSection({
	projectId,
	hostUrl,
}: MultiRepoMembersSectionProps) {
	const queryClient = useQueryClient();
	const selectDirectories = electronTrpc.window.selectDirectories.useMutation();
	const [working, setWorking] = useState(false);
	const [pendingRemove, setPendingRemove] = useState<string | null>(null);

	// Same key/options as useProjectGitState's probe so the kanban promote
	// dialog and this section share one cache entry (and one invalidation).
	const { data } = useQuery({
		queryKey: ["multi-repo-info", hostUrl, projectId],
		queryFn: () =>
			getHostServiceClientByUrl(hostUrl).project.getMultiRepoInfo.query({
				projectId,
			}),
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: ["multi-repo-info", hostUrl, projectId],
		});

	if (!data?.isMultiRepo) return null;
	const members = data.memberRepoPaths;
	const atMinimum = members.length <= 2;

	const handleAdd = async () => {
		try {
			const result = await selectDirectories.mutateAsync({
				title: "Select git repositories",
			});
			if (result.canceled || result.paths.length === 0) return;
			setWorking(true);
			const client = getHostServiceClientByUrl(hostUrl);
			let added = 0;
			// Sequential on purpose: each add validates against the member list
			// as left by the previous one (parallel mutations would race the
			// server's read-modify-write of the config file).
			for (const path of result.paths) {
				try {
					await client.project.addMultiRepoMember.mutate({
						projectId,
						repoPath: path,
					});
					added++;
				} catch (err) {
					toast.error(`Could not add ${path}`, {
						description: err instanceof Error ? err.message : String(err),
					});
				}
			}
			if (added > 0) {
				toast.success(
					added === 1 ? "Repository added" : `${added} repositories added`,
					{
						description:
							"Included in branch workspaces created from now on. Existing workspaces are unchanged.",
					},
				);
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setWorking(false);
			await invalidate();
		}
	};

	const handleRemove = async () => {
		if (!pendingRemove) return;
		setWorking(true);
		try {
			const client = getHostServiceClientByUrl(hostUrl);
			const result = await client.project.removeMultiRepoMember.mutate({
				projectId,
				repoPath: pendingRemove,
			});
			for (const warning of result.warnings) {
				toast.warning("Repository removed with issues", {
					description: warning,
				});
			}
			if (result.warnings.length === 0) {
				toast.success(`Removed ${getPathBaseName(pendingRemove)}`);
			}
		} catch (err) {
			toast.error("Could not remove repository", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setPendingRemove(null);
			setWorking(false);
			await invalidate();
		}
	};

	return (
		<section className="pt-4">
			<div className="mb-3">
				<h3 className="text-sm font-medium">Repositories</h3>
				<p className="mt-0.5 text-xs text-muted-foreground">
					Member repos of this multi-repo project. Added repos are included in
					new branch workspaces only; removing one force-removes its worktrees
					from existing branch workspaces.
				</p>
			</div>
			<div className="flex flex-col gap-1.5">
				<div className="flex flex-col gap-1">
					{members.map((path) => (
						<div
							key={path}
							className="flex items-center gap-1.5 rounded-md border px-2 py-1"
						>
							<span className="flex-1 truncate font-mono text-xs select-text cursor-text">
								{path}
							</span>
							{atMinimum ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<span>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="pointer-events-none size-5 shrink-0"
												disabled
												aria-label={`Remove ${path}`}
											>
												<LuX className="size-3" />
											</Button>
										</span>
									</TooltipTrigger>
									<TooltipContent side="left">
										A multi-repo project needs at least two repositories.
									</TooltipContent>
								</Tooltip>
							) : (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-5 shrink-0"
									onClick={() => setPendingRemove(path)}
									disabled={working}
									aria-label={`Remove ${path}`}
								>
									<LuX className="size-3" />
								</Button>
							)}
						</div>
					))}
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void handleAdd()}
					disabled={working || selectDirectories.isPending}
					className="justify-start self-start"
				>
					{working ? (
						<LuLoaderCircle className="size-4 animate-spin" />
					) : (
						<LuFolderPlus className="size-4" />
					)}
					Add repositories…
				</Button>
			</div>

			<AlertDialog
				open={pendingRemove !== null}
				onOpenChange={(open) => {
					if (!open && !working) setPendingRemove(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Remove "{pendingRemove ? getPathBaseName(pendingRemove) : ""}"?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This force-removes the repository's worktrees from{" "}
							<span className="font-medium text-foreground">
								every existing branch workspace
							</span>{" "}
							of this project — uncommitted changes inside those worktrees are
							lost. The repository itself and its branches are kept.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(e) => {
								e.preventDefault();
								void handleRemove();
							}}
							disabled={working}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{working ? "Removing…" : "Remove"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}
