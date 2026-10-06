import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { i18n } from "@superset/i18n";
import { errorMessage } from "@superset/i18n/errors";
import { toast } from "@superset/ui/sonner";
import { workspaceTrpc } from "@superset/workspace-client";
import {
	defaultRangeExtractor,
	useVirtualizer,
	type VirtualItem,
} from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChangesSidebarFilePolicy } from "renderer/lib/clickPolicy";
import {
	type ChangesetFile,
	getChangesetFileKey,
} from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/useChangeset";
import { toRelativeWorkspacePath } from "shared/absolute-paths";
import type { FoldSignal } from "../../ChangesFileList";
import { useStagingMutations } from "../../hooks/useStagingMutations";
import { FileRow } from "../FileRow";
import { FileDiscardDialog } from "./components/FileDiscardDialog";
import { FolderHeader } from "./components/FolderHeader";

const ROOT_FOLDER_KEY = "";
const ROOT_FOLDER_LABEL = msg({
	message: "./",
});
// (WS-OPEN-RENDER) FolderHeader and FileRow render 24 px (`py-1` plus a 16 px
// `text-xs` line). An exact estimate means measuring never resizes a row, so
// the window doesn't re-render and mount more rows on open.
const ESTIMATED_ROW_HEIGHT = 24;
const NO_ITEMS: VirtualItem[] = [];
const OVERSCAN = 8;

interface ChangesFoldersViewProps {
	files: ChangesetFile[];
	/** False while the first open defers rows past the first paint. */
	rowsReady: boolean;
	workspaceId: string;
	worktreePath?: string;
	/** Absolute path of the diff pane's open file — highlights its row. */
	selectedFilePath?: string;
	/** Disambiguates a path present in several sections (staged + unstaged). */
	selectedChangeKey?: string;
	/** Bumped by the toolbar's expand-all / collapse-all buttons. */
	foldSignal: FoldSignal;
	onSelectFile?: (
		path: string,
		openInNewTab?: boolean,
		changeKey?: string,
	) => void;
	onOpenFile?: (absolutePath: string, openInNewTab?: boolean) => void;
	onOpenInEditor?: (path: string) => void;
}

interface FolderGroup {
	folderPath: string;
	files: ChangesetFile[];
}

type Row =
	| { kind: "folder"; key: string; group: FolderGroup; isOpen: boolean }
	| { kind: "file"; key: string; file: ChangesetFile };

/**
 * Render a flat list of changed files grouped by their immediate parent
 * folder (one level deep — v1's "grouped" mode, not the full tree).
 *
 * The folder-header and file rows are flattened into one list and windowed
 * with `@tanstack/react-virtual` against the shared changes scroll container
 * (`[data-changes-scroll-container]`), so large changesets stay responsive.
 * Each section mounts its own virtualizer and offsets into the shared scroller
 * via `scrollMargin` (the list's `offsetTop`), matching v1's
 * `FileListGroupedVirtualized`.
 *
 * Differences from v1's `FileListGrouped`:
 *  - Collapse state tracked as a *closed* set, so folders that newly appear
 *    in the changeset default to open (v1 tracked an *expanded* set keyed by
 *    folder path, so a folder that didn't exist on first render stayed
 *    collapsed when it appeared later).
 *  - Per-folder bulk Stage/Unstage/Discard intentionally not ported —
 *    section-level bulk actions already cover the common case, and the
 *    per-folder buttons crowd the header.
 */
export const ChangesFoldersView = memo(function ChangesFoldersView({
	files,
	rowsReady,
	workspaceId,
	worktreePath,
	selectedFilePath,
	selectedChangeKey,
	foldSignal,
	onSelectFile,
	onOpenFile,
	onOpenInEditor,
}: ChangesFoldersViewProps) {
	const groups = useMemo(() => groupFilesByFolder(files), [files]);
	const selectedRelPath =
		selectedFilePath && worktreePath
			? toRelativeWorkspacePath(worktreePath, selectedFilePath)
			: selectedFilePath;
	const [closedFolders, setClosedFolders] = useState<Set<string>>(new Set());
	const { t } = useLingui();

	// (WS-OPEN-RENDER) One click policy, mutation set and discard dialog per
	// list: per-row copies cost a live query and three mutation observers per
	// row on every open.
	const filePolicy = useChangesSidebarFilePolicy();
	const diffNewTabTier = filePolicy.tierForIntent("diffNewTab");
	const fileTier = filePolicy.tierForIntent("file");
	const externalTier = filePolicy.tierForIntent("external");
	const { stageFile, unstageFile } = useStagingMutations(workspaceId);
	const [discardTarget, setDiscardTarget] = useState<ChangesetFile | null>(
		null,
	);
	const utils = workspaceTrpc.useUtils();
	const discardMutation = workspaceTrpc.git.discardChanges.useMutation({
		onSuccess: () => {
			void utils.git.getStatus.invalidate({ workspaceId });
			void utils.git.getDiff.invalidate({ workspaceId });
		},
		onError: (err) => {
			toast.error(
				t({
					message: "Couldn't discard changes",
				}),
				{
					description: errorMessage(err),
				},
			);
		},
	});

	const toggleFolder = useCallback((folderPath: string) => {
		setClosedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(folderPath)) next.delete(folderPath);
			else next.add(folderPath);
			return next;
		});
	}, []);

	// React to expand-all / collapse-all from the toolbar — but only on a new
	// signal, not when `groups` changes (which would re-apply the last action
	// and stomp any folder the user re-toggled in between).
	const lastFoldEpochRef = useRef(0);
	useEffect(() => {
		if (foldSignal.epoch === 0 || foldSignal.epoch === lastFoldEpochRef.current)
			return;
		lastFoldEpochRef.current = foldSignal.epoch;
		setClosedFolders(
			foldSignal.action === "collapse"
				? new Set(groups.map((g) => g.folderPath))
				: new Set(),
		);
	}, [foldSignal, groups]);

	// Flatten open groups into folder-header + file rows for the virtualizer.
	const rows = useMemo(() => {
		const next: Row[] = [];
		for (const group of groups) {
			const isOpen = !closedFolders.has(group.folderPath);
			next.push({
				kind: "folder",
				// `folderPath` ("" for the root group) is the unique per-group key.
				key: `folder:${group.folderPath || "__root__"}`,
				group,
				isOpen,
			});
			if (!isOpen) continue;
			for (const file of group.files) {
				next.push({
					kind: "file",
					key: `file:${getChangesetFileKey(file)}`,
					file,
				});
			}
		}
		return next;
	}, [groups, closedFolders]);

	const listRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () =>
			listRef.current?.closest(
				"[data-changes-scroll-container]",
			) as HTMLElement | null,
		estimateSize: () => ESTIMATED_ROW_HEIGHT,
		rangeExtractor: defaultRangeExtractor,
		overscan: OVERSCAN,
		// Offset this section's window by its position inside the shared scroller.
		scrollMargin: listRef.current?.offsetTop ?? 0,
		getItemKey: (index) => rows[index]?.key ?? index,
	});

	const virtualItems = rowsReady ? virtualizer.getVirtualItems() : NO_ITEMS;

	return (
		<div ref={listRef}>
			<div
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualItems.map((virtualRow) => {
					const row = rows[virtualRow.index];
					if (!row) return null;
					return (
						<div
							key={virtualRow.key}
							data-index={virtualRow.index}
							ref={virtualizer.measureElement}
							className="absolute left-0 w-full"
							style={{
								top: virtualRow.start - (virtualizer.options.scrollMargin ?? 0),
							}}
						>
							{row.kind === "folder" ? (
								<FolderHeader
									label={
										row.group.folderPath === ROOT_FOLDER_KEY
											? i18n._(ROOT_FOLDER_LABEL)
											: row.group.folderPath
									}
									fileCount={row.group.files.length}
									isOpen={row.isOpen}
									onToggle={() => toggleFolder(row.group.folderPath)}
								/>
							) : (
								<FileRow
									file={row.file}
									worktreePath={worktreePath}
									hideDir
									isSelected={
										row.file.path === selectedRelPath &&
										(selectedChangeKey == null ||
											getChangesetFileKey(row.file) === selectedChangeKey)
									}
									getIntent={filePolicy.getIntent}
									clickHint={filePolicy.hint}
									diffNewTabTier={diffNewTabTier}
									fileTier={fileTier}
									externalTier={externalTier}
									onSelect={onSelectFile}
									onOpenFile={onOpenFile}
									onOpenInEditor={onOpenInEditor}
									onStageFile={stageFile}
									onUnstageFile={unstageFile}
									onRequestDiscard={setDiscardTarget}
								/>
							)}
						</div>
					);
				})}
			</div>
			{discardTarget && (
				<FileDiscardDialog
					file={discardTarget}
					onCancel={() => setDiscardTarget(null)}
					onConfirm={() => {
						setDiscardTarget(null);
						discardMutation.mutate({
							workspaceId,
							filePath: discardTarget.path,
						});
					}}
				/>
			)}
		</div>
	);
});

function groupFilesByFolder(files: ChangesetFile[]): FolderGroup[] {
	const map = new Map<string, ChangesetFile[]>();
	for (const file of files) {
		const lastSlash = file.path.lastIndexOf("/");
		const folderPath =
			lastSlash >= 0 ? file.path.slice(0, lastSlash) : ROOT_FOLDER_KEY;
		const group = map.get(folderPath);
		if (group) group.push(file);
		else map.set(folderPath, [file]);
	}
	return Array.from(map.entries())
		.map(([folderPath, groupFiles]) => ({
			folderPath,
			files: groupFiles.sort((a, b) =>
				basenameOf(a.path).localeCompare(basenameOf(b.path)),
			),
		}))
		.sort((a, b) => {
			// Root-level files come first so they read like the top of a tree.
			if (a.folderPath === ROOT_FOLDER_KEY)
				return b.folderPath === ROOT_FOLDER_KEY ? 0 : -1;
			if (b.folderPath === ROOT_FOLDER_KEY) return 1;
			return a.folderPath.localeCompare(b.folderPath);
		});
}

function basenameOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? path : path.slice(i + 1);
}
