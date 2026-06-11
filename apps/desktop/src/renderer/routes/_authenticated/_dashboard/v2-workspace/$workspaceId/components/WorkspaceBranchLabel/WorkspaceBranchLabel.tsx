import { Check, GitBranch } from "lucide-react";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";

interface WorkspaceBranchLabelProps {
	branch: string | null | undefined;
}

/**
 * (BRANCH-LABEL) Tab-bar chip naming the open workspace's branch. This is the
 * ONLY place a multi-repo container page can show its fanned-out branch name —
 * the container is not a git repo, so the git-coupled UI that normally
 * surfaces a branch is hidden there. Rendered for ANY workspace with a branch
 * (multi-repo containers and single-repo branch workspaces alike); plain
 * non-git workspaces have no branch and render nothing. Click copies the
 * branch name.
 */
export function WorkspaceBranchLabel({ branch }: WorkspaceBranchLabelProps) {
	const { copyToClipboard, copied } = useCopyToClipboard();
	if (!branch) return null;
	return (
		<button
			type="button"
			title={copied ? "Copied" : `${branch} — click to copy`}
			onClick={() => void copyToClipboard(branch)}
			className="mr-1 flex min-w-0 shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
		>
			{copied ? (
				<Check className="size-3.5 shrink-0" />
			) : (
				<GitBranch className="size-3.5 shrink-0" />
			)}
			<span className="max-w-[180px] truncate">{branch}</span>
		</button>
	);
}
