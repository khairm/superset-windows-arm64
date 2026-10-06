import { Trans, useLingui } from "@lingui/react/macro";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import {
	ChevronDown,
	ExternalLink,
	FileText,
	GitCompare,
	Minus,
	Plus,
	SquarePlus,
	Trash2,
	Undo2,
} from "lucide-react";
import { memo } from "react";
import {
	type ChangesSidebarFileIntent,
	type LinkTier,
	type ModifierEvent,
	modifierLabel,
} from "renderer/lib/clickPolicy";
import { FileIcon } from "renderer/lib/fileIcons";
import { StatusIndicator } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/StatusIndicator";
import {
	type ChangesetFile,
	getChangesetFileKey,
} from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/useChangeset";
import { toAbsoluteWorkspacePath } from "shared/absolute-paths";
import { useFileDrag } from "../../hooks/useFileDrag";
import { DiffStatText } from "../DiffStatText";
import { PathActionsMenuItems } from "../PathActionsMenuItems";
import { StageToggleButton } from "../StageToggleButton";

function splitPath(path: string): { dir: string; basename: string } {
	const lastSlash = path.lastIndexOf("/");
	if (lastSlash < 0) return { dir: "", basename: path };
	return {
		dir: `${path.slice(0, lastSlash)}/`,
		basename: path.slice(lastSlash + 1),
	};
}

interface FileRowProps {
	file: ChangesetFile;
	worktreePath?: string;
	/** Hide the directory prefix — used when the row sits under a folder group. */
	hideDir?: boolean;
	/** Highlight as the diff pane's currently open file. */
	isSelected?: boolean;
	getIntent: (event: ModifierEvent) => ChangesSidebarFileIntent | null;
	clickHint: string;
	diffNewTabTier: LinkTier | null;
	fileTier: LinkTier | null;
	externalTier: LinkTier | null;
	onSelect?: (path: string, openInNewTab?: boolean, changeKey?: string) => void;
	onOpenFile?: (absolutePath: string, openInNewTab?: boolean) => void;
	onOpenInEditor?: (path: string) => void;
	onStageFile: (file: ChangesetFile) => void;
	onUnstageFile: (file: ChangesetFile) => void;
	onRequestDiscard: (file: ChangesetFile) => void;
}

// (WS-OPEN-RENDER) Policy, mutations and the discard dialog live in the list,
// so a row mounts no live query or mutation observer of its own.
export const FileRow = memo(function FileRow({
	file,
	worktreePath,
	hideDir,
	isSelected,
	getIntent,
	clickHint,
	diffNewTabTier,
	fileTier,
	externalTier,
	onSelect,
	onOpenFile,
	onOpenInEditor,
	onStageFile,
	onUnstageFile,
	onRequestDiscard,
}: FileRowProps) {
	const { t } = useLingui();
	const { dir: fullDir, basename } = splitPath(file.path);
	const dir = hideDir ? "" : fullDir;
	const oldBasename =
		file.oldPath && (file.status === "renamed" || file.status === "copied")
			? splitPath(file.oldPath).basename
			: null;
	const absolutePath = worktreePath
		? toAbsoluteWorkspacePath(worktreePath, file.path)
		: undefined;
	const changeKey = getChangesetFileKey(file);
	const canStage = file.source.kind === "unstaged";
	const canUnstage = file.source.kind === "staged";
	const canDiscard = canStage;
	const isDeleteAction = file.status === "untracked" || file.status === "added";
	const fileDrag = useFileDrag({ absolutePath });

	const rowButton = (
		<div className="group relative">
			<button
				type="button"
				className={cn(
					"flex w-full items-center gap-1.5 py-1 pr-3 pl-3 text-left text-xs hover:bg-accent/50",
					isSelected && "bg-accent/70",
				)}
				{...fileDrag}
				onClick={(e) => {
					const intent = getIntent(e);
					if (intent === "external") onOpenInEditor?.(file.path);
					else if (intent === "file" && absolutePath)
						onOpenFile?.(absolutePath, false);
					else if (intent === "diffNewTab")
						onSelect?.(file.path, true, changeKey);
					else if (intent === "diff") onSelect?.(file.path, false, changeKey);
				}}
			>
				<FileIcon fileName={basename} className="size-3.5 shrink-0" />
				<span className="flex min-w-0 flex-1 items-baseline overflow-hidden">
					{dir && <span className="truncate text-muted-foreground">{dir}</span>}
					{oldBasename && (
						<span className="truncate text-muted-foreground">
							{oldBasename}
							<span className="px-1">→</span>
						</span>
					)}
					<span className="min-w-[120px] truncate font-medium text-foreground">
						{basename}
					</span>
				</span>
				<span className="ml-auto flex shrink-0 items-center gap-1.5 group-hover:invisible group-has-[[data-state=open]]:invisible">
					{((file.additions ?? 0) > 0 || (file.deletions ?? 0) > 0) && (
						<span className="text-[10px] text-muted-foreground">
							<DiffStatText
								additions={file.additions}
								deletions={file.deletions}
							/>
						</span>
					)}
					<StatusIndicator status={file.status} />
				</span>
			</button>
			<div className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100">
				{canDiscard && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={t({
									message: "Discard changes",
								})}
								className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
								onClick={(e) => {
									e.stopPropagation();
									onRequestDiscard(file);
								}}
							>
								<Undo2 className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="top">
							<Trans>Discard changes</Trans>
						</TooltipContent>
					</Tooltip>
				)}
				{canStage && (
					<StageToggleButton action="stage" onClick={() => onStageFile(file)} />
				)}
				{canUnstage && (
					<StageToggleButton
						action="unstage"
						onClick={() => onUnstageFile(file)}
					/>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label={t({
								message: "More actions",
							})}
							className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
							onClick={(e) => e.stopPropagation()}
						>
							<ChevronDown className="size-3.5" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-64">
						<DropdownMenuItem
							onSelect={() => onSelect?.(file.path, false, changeKey)}
						>
							<GitCompare />
							<Trans>Open Diff</Trans>
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => onSelect?.(file.path, true, changeKey)}
						>
							<SquarePlus />
							<Trans>Open Diff in New Tab</Trans>
							{diffNewTabTier && (
								<DropdownMenuShortcut>
									{modifierLabel(diffNewTabTier)}
								</DropdownMenuShortcut>
							)}
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => absolutePath && onOpenFile?.(absolutePath)}
							disabled={!onOpenFile || !absolutePath}
						>
							<FileText />
							<Trans>Open File</Trans>
							{fileTier && (
								<DropdownMenuShortcut>
									{modifierLabel(fileTier)}
								</DropdownMenuShortcut>
							)}
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => absolutePath && onOpenFile?.(absolutePath, true)}
							disabled={!onOpenFile || !absolutePath}
						>
							<SquarePlus />
							<Trans>Open File in New Tab</Trans>
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => onOpenInEditor?.(file.path)}
							disabled={!onOpenInEditor}
						>
							<ExternalLink />
							<Trans>Open in Editor</Trans>
							{externalTier && (
								<DropdownMenuShortcut>
									{modifierLabel(externalTier)}
								</DropdownMenuShortcut>
							)}
						</DropdownMenuItem>
						{canStage && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={() => onStageFile(file)}>
									<Plus />
									<Trans>Stage file</Trans>
								</DropdownMenuItem>
							</>
						)}
						{canUnstage && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={() => onUnstageFile(file)}>
									<Minus />
									<Trans>Unstage file</Trans>
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);

	return (
		<ContextMenu>
			<Tooltip delayDuration={500}>
				<ContextMenuTrigger asChild>
					<TooltipTrigger asChild>{rowButton}</TooltipTrigger>
				</ContextMenuTrigger>
				<TooltipContent side="right">{clickHint}</TooltipContent>
			</Tooltip>
			<ContextMenuContent className="w-64">
				<ContextMenuItem
					onSelect={() => onSelect?.(file.path, false, changeKey)}
				>
					<GitCompare />
					<Trans>Open Diff</Trans>
				</ContextMenuItem>
				<ContextMenuItem
					onSelect={() => onSelect?.(file.path, true, changeKey)}
				>
					<SquarePlus />
					<Trans>Open Diff in New Tab</Trans>
					{diffNewTabTier && (
						<ContextMenuShortcut>
							{modifierLabel(diffNewTabTier)}
						</ContextMenuShortcut>
					)}
				</ContextMenuItem>
				<ContextMenuItem
					onSelect={() => absolutePath && onOpenFile?.(absolutePath)}
					disabled={!onOpenFile || !absolutePath}
				>
					<FileText />
					<Trans>Open File</Trans>
					{fileTier && (
						<ContextMenuShortcut>{modifierLabel(fileTier)}</ContextMenuShortcut>
					)}
				</ContextMenuItem>
				<ContextMenuItem
					onSelect={() => absolutePath && onOpenFile?.(absolutePath, true)}
					disabled={!onOpenFile || !absolutePath}
				>
					<SquarePlus />
					<Trans>Open File in New Tab</Trans>
				</ContextMenuItem>
				<ContextMenuItem
					onSelect={() => onOpenInEditor?.(file.path)}
					disabled={!onOpenInEditor}
				>
					<ExternalLink />
					<Trans>Open in Editor</Trans>
					{externalTier && (
						<ContextMenuShortcut>
							{modifierLabel(externalTier)}
						</ContextMenuShortcut>
					)}
				</ContextMenuItem>
				{absolutePath && (
					<>
						<ContextMenuSeparator />
						<PathActionsMenuItems
							absolutePath={absolutePath}
							relativePath={file.path}
						/>
					</>
				)}
				{(canStage || canUnstage) && <ContextMenuSeparator />}
				{canStage && (
					<ContextMenuItem onSelect={() => onStageFile(file)}>
						<Plus />
						<Trans>Stage file</Trans>
					</ContextMenuItem>
				)}
				{canUnstage && (
					<ContextMenuItem onSelect={() => onUnstageFile(file)}>
						<Minus />
						<Trans>Unstage file</Trans>
					</ContextMenuItem>
				)}
				{canDiscard && (
					<ContextMenuItem
						variant="destructive"
						onSelect={() => onRequestDiscard(file)}
					>
						{isDeleteAction ? <Trash2 /> : <Undo2 />}
						{isDeleteAction
							? t({ message: "Delete" })
							: t({
									message: "Discard changes",
								})}
					</ContextMenuItem>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);
});
