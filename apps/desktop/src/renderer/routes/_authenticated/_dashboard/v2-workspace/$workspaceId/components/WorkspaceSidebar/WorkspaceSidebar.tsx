import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useRef, useState } from "react";
import { LuClipboardList, LuFile, LuGitCompareArrows } from "react-icons/lu";
import { useIsGitRepo } from "renderer/hooks/host-service/useIsGitRepo";
import { useWorkspaceGitStatus } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/providers/WorkspaceGitStatusProvider";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useSettings } from "renderer/stores/settings";
import type { CommentPaneData, DiffFocusSide } from "../../types";
import { CardTab } from "./components/CardTab";
import { FilesTab } from "./components/FilesTab";
import { PRActionHeader } from "./components/PRActionHeader";
import { SidebarHeader } from "./components/SidebarHeader";
import { useChangesTab } from "./hooks/useChangesTab";
import { type OpenChatFn, usePRFlowDispatch } from "./hooks/usePRFlowDispatch";
import { usePRFlowState } from "./hooks/usePRFlowState";
import { useReviewTab } from "./hooks/useReviewTab";
import type { SidebarTabDefinition } from "./types";

// Gates the "Create PR" button only — the chat-driven create flow doesn't
// exist in v2 yet. The PR status group (link + merge dropdown for an open PR)
// always renders so users can see PR state and merge once a PR exists.
const CREATE_PR_BUTTON_ENABLED = false;

type SidebarTabId = "changes" | "files" | "review" | "card";

const VALID_TAB_IDS: readonly SidebarTabId[] = [
	"changes",
	"files",
	"review",
	"card",
];

function isSidebarTabId(tab: string): tab is SidebarTabId {
	return (VALID_TAB_IDS as readonly string[]).includes(tab);
}

export interface PendingReveal {
	path: string;
	isDirectory: boolean;
}

interface WorkspaceSidebarProps {
	onSelectFile: (absolutePath: string, openInNewTab?: boolean) => void;
	onSelectDiffFile?: (
		path: string,
		openInNewTab?: boolean,
		line?: number,
		side?: DiffFocusSide,
		changeKey?: string,
	) => void;
	onOpenComment?: (comment: CommentPaneData) => void;
	onOpenChat?: OpenChatFn;
	onSearch?: () => void;
	selectedFilePath?: string;
	pendingReveal?: PendingReveal | null;
	workspaceId: string;
}

export function WorkspaceSidebar({
	onSelectFile,
	onSelectDiffFile,
	onOpenComment,
	onOpenChat,
	onSearch,
	selectedFilePath,
	pendingReveal,
	workspaceId,
}: WorkspaceSidebarProps) {
	const gitStatus = useWorkspaceGitStatus();
	// (NON-GIT WORKSPACE) A non-git folder has no Changes/Review/PR — only the
	// Files tab (plus terminal + agents, which live outside this sidebar). Stays
	// true until the query positively resolves non-git so a real repo never
	// flicker-drops its git tabs on mount.
	const isGitRepo = useIsGitRepo(workspaceId);
	const collections = useCollections();
	const { data: [localState] = [] } = useLiveQuery(
		(query) =>
			query
				.from({ localState: collections.v2WorkspaceLocalState })
				.where(({ localState }) => eq(localState.workspaceId, workspaceId)),
		[collections, workspaceId],
	);
	const activeTab: SidebarTabId =
		localState && isSidebarTabId(localState.sidebarState.activeTab)
			? localState.sidebarState.activeTab
			: "changes";

	function setActiveTab(tab: string) {
		if (!isSidebarTabId(tab)) return;
		if (!collections.v2WorkspaceLocalState.get(workspaceId)) return;
		collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
			draft.sidebarState.activeTab = tab;
		});
	}

	const containerRef = useRef<HTMLDivElement>(null);
	const [compact, setCompact] = useState(false);
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => {
			if (!entry) return;
			const width = entry.contentRect.width;
			// Hysteresis: expand back to labels only once we're clearly past
			// the breakpoint, so the labels don't jitter on the edge.
			setCompact((prev) => (prev ? width < 280 : width < 260));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const changesTabDef = useChangesTab({
		workspaceId,
		selectedFilePath,
		onSelectFile: onSelectDiffFile
			? (path, openInNewTab, changeKey) =>
					onSelectDiffFile(path, openInNewTab, undefined, undefined, changeKey)
			: undefined,
		onOpenFile: onSelectFile,
	});
	const changesTab: SidebarTabDefinition = {
		...changesTabDef,
		icon: LuGitCompareArrows,
	};

	const reviewTab = useReviewTab({
		workspaceId,
		onOpenComment,
		onOpenInDiff: onSelectDiffFile
			? (path, line, openInNewTab, side) => {
					// Force annotations on so the user lands on the comment, not an empty line.
					useSettings.getState().update("showDiffComments", true);
					onSelectDiffFile(path, openInNewTab ?? false, line, side);
				}
			: undefined,
	});

	const { flowState, onRetry } = usePRFlowState(workspaceId);
	const dispatch = usePRFlowDispatch({
		onOpenChat: onOpenChat ?? (() => {}),
	});

	const filesTab: SidebarTabDefinition = {
		id: "files",
		label: "Files",
		icon: LuFile,
		content: (
			<FilesTab
				onSelectFile={onSelectFile}
				selectedFilePath={selectedFilePath}
				pendingReveal={pendingReveal}
				workspaceId={workspaceId}
				gitStatus={gitStatus.data}
				onSearch={onSearch}
			/>
		),
	};

	// (KANBAN) The "Card" tab edits this branch's board task details. Always
	// available (every branch mirrors to a card), even for non-git folders.
	const cardTab: SidebarTabDefinition = {
		id: "card",
		label: "Card",
		icon: LuClipboardList,
		content: <CardTab workspaceId={workspaceId} />,
	};

	// (NON-GIT WORKSPACE) Drop the Changes + Review tabs (and the PR header
	// below) for a non-git folder — keep only Files. Terminal + agents live
	// outside this sidebar and are unaffected. The Card tab stays in both.
	const tabs: SidebarTabDefinition[] = isGitRepo
		? [filesTab, changesTab, reviewTab, cardTab]
		: [filesTab, cardTab];
	// The persisted activeTab may be a git tab ("changes"/"review") that no
	// longer exists for a non-git folder; fall back to Files so content renders.
	const activeTabDef = tabs.find((t) => t.id === activeTab) ?? filesTab;

	return (
		<div
			ref={containerRef}
			className="isolate flex h-full w-full min-h-0 flex-col overflow-hidden bg-background"
		>
			{isGitRepo && (
				<PRActionHeader
					workspaceId={workspaceId}
					state={flowState}
					dispatch={dispatch}
					onRetry={onRetry}
					createPREnabled={CREATE_PR_BUTTON_ENABLED}
				/>
			)}
			<SidebarHeader
				tabs={tabs}
				activeTab={activeTabDef.id}
				onTabChange={setActiveTab}
				compact={compact}
			/>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				{activeTabDef?.content}
			</div>
		</div>
	);
}
