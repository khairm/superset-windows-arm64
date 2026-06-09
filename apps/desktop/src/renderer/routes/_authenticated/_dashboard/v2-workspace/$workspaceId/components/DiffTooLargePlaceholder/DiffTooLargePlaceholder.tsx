import { Button } from "@superset/ui/button";
import { FileWarning } from "lucide-react";

/** (DIFF CAP) Above this many total changed lines (additions + deletions) the
 *  diff is NOT rendered — building a CodeViewItem per line holds the whole diff
 *  in renderer memory and OOMs the render process (the vendored-fork repo hit
 *  3.6M changed lines). Both the sidebar Changes tab and the main DiffPane gate
 *  on the cheap numstat total so the expensive per-file getDiff never fires. */
export const MAX_RENDERABLE_CHANGED_LINES = 100_000;

interface DiffTooLargePlaceholderProps {
	changedLines: number;
	fileCount: number;
	/** Opens the workspace's worktree in the user's external editor. */
	onOpenInEditor?: () => void;
}

export function DiffTooLargePlaceholder({
	changedLines,
	fileCount,
	onOpenInEditor,
}: DiffTooLargePlaceholderProps) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
			<FileWarning className="size-8 text-muted-foreground" />
			{/* Error/info text must be selectable so it can be copied (body sets
			    user-select: none) — see apps/desktop/AGENTS.md. */}
			<div className="max-w-xs cursor-text select-text space-y-1">
				<p className="font-medium text-foreground text-sm">
					Diff too large to render
				</p>
				<p className="text-muted-foreground text-xs">
					{changedLines.toLocaleString()} changed lines across{" "}
					{fileCount.toLocaleString()} files. Rendering this many lines would
					exhaust memory, so the diff isn't shown here.
				</p>
			</div>
			{onOpenInEditor ? (
				<Button variant="outline" size="sm" onClick={onOpenInEditor}>
					Open in editor
				</Button>
			) : null}
		</div>
	);
}
