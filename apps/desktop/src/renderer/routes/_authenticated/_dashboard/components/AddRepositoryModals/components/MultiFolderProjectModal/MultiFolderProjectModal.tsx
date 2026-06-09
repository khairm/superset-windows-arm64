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
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { LuFolderPlus, LuLoaderCircle, LuX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { showHostServiceUnavailableToast } from "renderer/lib/host-service-unavailable";
import { useFinalizeProjectSetup } from "renderer/react-query/projects";
import { getPathBaseName } from "shared/absolute-paths";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";

interface MultiFolderProjectModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSuccess?: (result: { projectId: string }) => void;
	onError?: (message: string) => void;
}

/**
 * (MULTI-REPO WORKSPACE) "Open from multi-folder": pick N folders (each must
 * be a git repo — validated on add via project.probePath), name the group,
 * and create a multi-repo project. Its "+" then fans the same branch name out
 * as a worktree in every member repo.
 */
export function MultiFolderProjectModal({
	open,
	onOpenChange,
	onSuccess,
	onError,
}: MultiFolderProjectModalProps) {
	const hostService = useLocalHostService();
	const { activeHostUrl } = hostService;
	const finalizeSetup = useFinalizeProjectSetup();
	const selectDirectories = electronTrpc.window.selectDirectories.useMutation();

	const [name, setName] = useState("");
	const [repoPaths, setRepoPaths] = useState<string[]>([]);
	const [working, setWorking] = useState(false);

	const reset = () => {
		setName("");
		setRepoPaths([]);
		setWorking(false);
	};

	const handleOpenChange = (next: boolean) => {
		if (!next && working) return;
		if (!next) reset();
		onOpenChange(next);
	};

	const handleAddFolders = async () => {
		if (!activeHostUrl) {
			showHostServiceUnavailableToast(hostService, {
				action: "validate the selected folders",
			});
			return;
		}
		try {
			const result = await selectDirectories.mutateAsync({
				title: "Select git repositories",
			});
			if (result.canceled || result.paths.length === 0) return;

			const client = getHostServiceClientByUrl(activeHostUrl);
			const additions: string[] = [];
			// Probes are independent host round-trips — run them in parallel,
			// then apply the order-dependent dedup over the resolved results.
			const probes = await Promise.all(
				result.paths.map(async (path) => ({
					path,
					probe: await client.project.probePath.query({ repoPath: path }),
				})),
			);
			for (const { path, probe } of probes) {
				// Register the canonical repo ROOT — a picked subfolder of a repo
				// would otherwise masquerade as a repo of its own. (isGitRepo is
				// derived from gitRoot server-side; one check suffices.)
				if (!probe.gitRoot) {
					toast.error(`Not a git repository: ${path}`, {
						description:
							"Every member of a multi-repo workspace must be a git repo.",
					});
					continue;
				}
				const root = probe.gitRoot;
				if (repoPaths.includes(root) || additions.includes(root)) continue;
				// Case-insensitive: Windows paths collide regardless of case.
				const base = getPathBaseName(root);
				const clash = [...repoPaths, ...additions].find(
					(existing) =>
						getPathBaseName(existing).toLowerCase() === base.toLowerCase(),
				);
				if (clash) {
					toast.error(`Two repositories share the folder name "${base}"`, {
						description: `${clash} is already selected. Member folder names become the per-repo subfolders of each workspace.`,
					});
					continue;
				}
				additions.push(root);
			}
			if (additions.length > 0) {
				setRepoPaths((prev) => [...prev, ...additions]);
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	};

	const handleCreate = async () => {
		const trimmedName = name.trim();
		if (!trimmedName) {
			toast.error("Please enter a workspace name");
			return;
		}
		if (repoPaths.length < 2) {
			toast.error("Select at least two git repositories");
			return;
		}
		if (!activeHostUrl) {
			showHostServiceUnavailableToast(hostService, {
				action: "create the multi-repo workspace",
			});
			return;
		}

		setWorking(true);
		try {
			const client = getHostServiceClientByUrl(activeHostUrl);
			const result = await client.project.create.mutate({
				name: trimmedName,
				mode: { kind: "multiRepo", memberRepoPaths: repoPaths },
			});
			finalizeSetup(activeHostUrl, result);
			onSuccess?.({ projectId: result.projectId });
			reset();
			onOpenChange(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			toast.error("Could not create multi-repo workspace", {
				description: message,
			});
			onError?.(message);
		} finally {
			setWorking(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange} modal>
			<DialogContent className="max-w-[480px]">
				<DialogHeader>
					<DialogTitle>Open from multi-folder</DialogTitle>
					<DialogDescription className="sr-only">
						Group multiple git repositories into one multi-repo workspace.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="multi-repo-name" className="text-xs">
							Name
						</Label>
						<Input
							id="multi-repo-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="my-stack"
							disabled={working}
							autoFocus
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label className="text-xs">
							Git repositories ({repoPaths.length})
						</Label>
						{repoPaths.length > 0 && (
							<div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
								{repoPaths.map((path) => (
									<div
										key={path}
										className="flex items-center gap-1.5 rounded-md border px-2 py-1"
									>
										<span className="flex-1 truncate font-mono text-xs select-text cursor-text">
											{path}
										</span>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-5 shrink-0"
											onClick={() =>
												setRepoPaths((prev) =>
													prev.filter((existing) => existing !== path),
												)
											}
											disabled={working}
											aria-label={`Remove ${path}`}
										>
											<LuX className="size-3" />
										</Button>
									</div>
								))}
							</div>
						)}
						<Button
							type="button"
							variant="outline"
							onClick={() => void handleAddFolders()}
							disabled={working || selectDirectories.isPending}
							className="justify-start"
						>
							<LuFolderPlus className="size-4" />
							Add repositories…
						</Button>
					</div>
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => handleOpenChange(false)}
						disabled={working}
					>
						Cancel
					</Button>
					<Button onClick={() => void handleCreate()} disabled={working}>
						{working ? (
							<>
								<LuLoaderCircle className="size-4 animate-spin" />
								Creating…
							</>
						) : (
							"Create"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
