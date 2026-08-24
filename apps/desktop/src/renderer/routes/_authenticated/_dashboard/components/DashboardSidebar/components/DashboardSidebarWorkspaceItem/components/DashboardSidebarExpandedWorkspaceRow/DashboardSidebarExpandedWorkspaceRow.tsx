import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import {
	type ComponentPropsWithoutRef,
	forwardRef,
	type KeyboardEventHandler,
	type MouseEventHandler,
	useEffect,
	useRef,
} from "react";
import { HiCheck, HiMiniMinus, HiMiniXMark } from "react-icons/hi2";
import { LuRotateCcw, LuUndo2 } from "react-icons/lu";
import type { DiffStats } from "renderer/hooks/host-service/useDiffStats";
import { HotkeyLabel } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { ProjectThumbnail } from "renderer/routes/_authenticated/components/ProjectThumbnail";
import {
	type DisplayStatus,
	StatusIndicator,
} from "renderer/screens/main/components/StatusIndicator";
import { RenameInput } from "renderer/screens/main/components/WorkspaceSidebar/RenameInput";
import type {
	DashboardSidebarWorkspace,
	DashboardSidebarWorkspacePullRequest,
} from "../../../../types";
import { ClaudeAccountIndicator } from "../ClaudeAccountIndicator";
import { DashboardSidebarWorkspaceDetails } from "../DashboardSidebarWorkspaceDetails/DashboardSidebarWorkspaceDetails";
import { DashboardSidebarWorkspaceDiffStats } from "../DashboardSidebarWorkspaceDiffStats";
import { DashboardSidebarWorkspaceIcon } from "../DashboardSidebarWorkspaceIcon";
import { DashboardSidebarWorkspaceChips } from "./components/DashboardSidebarWorkspaceChips";

const PR_STATE_LABEL: Record<
	DashboardSidebarWorkspacePullRequest["state"],
	string
> = {
	open: "Open",
	merged: "Merged",
	closed: "Closed",
	draft: "Draft",
	queued: "Queued",
};

interface DashboardSidebarExpandedWorkspaceRowProps
	extends ComponentPropsWithoutRef<"div"> {
	workspace: DashboardSidebarWorkspace;
	isActive: boolean;
	isRenaming: boolean;
	renameValue: string;
	shortcutLabel?: string;
	diffStats: DiffStats | null;
	workspaceStatus?: DisplayStatus | null;
	tabCount?: number;
	tabStatus?: DisplayStatus | null;
	isInSection?: boolean;
	isNonGit?: boolean;
	sectionState?: "snoozed" | "archived" | "deleted";
	isBulkSelectable?: boolean;
	isSelected?: boolean;
	/** Present when rendered in the Pinned section: shows the project avatar. */
	/** projectName is null for pinned project-less "session" workspaces. */
	pinnedContext?: { projectName: string | null; projectIconUrl: string | null };
	onRestoreClick?: () => void;
	onClick?: MouseEventHandler<HTMLDivElement>;
	onKeyboardActivate?: KeyboardEventHandler<HTMLDivElement>;
	onWorkspaceChipsClick?: MouseEventHandler<HTMLDivElement>;
	/**
	 * (TAB-CHIPS) Plain activation for the per-tab chip strip, whose click
	 * handler is event-less — modifier-click selection lives on the row itself.
	 */
	onDetailsStripClick?: () => void;
	onDoubleClick?: () => void;
	onCloseWorkspaceClick: () => void;
	onRemoveFromSidebarClick: () => void;
	onRenameValueChange: (value: string) => void;
	onSubmitRename: () => void;
	onCancelRename: () => void;
}

export const DashboardSidebarExpandedWorkspaceRow = forwardRef<
	HTMLDivElement,
	DashboardSidebarExpandedWorkspaceRowProps
>(
	(
		{
			workspace,
			isActive,
			isRenaming,
			renameValue,
			shortcutLabel,
			diffStats,
			workspaceStatus = null,
			tabCount = 0,
			tabStatus = null,
			isInSection = false,
			isNonGit = false,
			sectionState,
			isBulkSelectable = false,
			isSelected = false,
			pinnedContext,
			onRestoreClick,
			onClick,
			onKeyboardActivate,
			onWorkspaceChipsClick,
			onDetailsStripClick,
			onDoubleClick,
			onCloseWorkspaceClick,
			onRemoveFromSidebarClick,
			onRenameValueChange,
			onSubmitRename,
			onCancelRename,
			className,
			...props
		},
		ref,
	) => {
		const {
			hostType,
			hostIsOnline,
			name,
			branch,
			pullRequest,
			pendingTransaction,
		} = workspace;
		const isPending = pendingTransaction?.type === "insert";
		// Precomputed in the data hook from the live tick (so it counts down).
		const snoozeRemaining =
			sectionState === "snoozed" ? (workspace.snoozeRemainingLabel ?? "") : "";
		const localRef = useRef<HTMLDivElement>(null);
		const openUrl = electronTrpc.external.openUrl.useMutation();

		useEffect(() => {
			if (isActive) {
				localRef.current?.scrollIntoView({
					block: "nearest",
					behavior: "smooth",
				});
			}
		}, [isActive]);

		const creationStatusText = isPending ? "Creating…" : null;
		// (RECYCLE-BIN) The restore button's label/tooltip per section: snoozed →
		// Unsnooze, archived → Unarchive, deleted (Recycle Bin) → Restore.
		const restoreActionLabel =
			sectionState === "snoozed"
				? "Unsnooze"
				: sectionState === "deleted"
					? "Restore"
					: "Unarchive";
		const isMainWorkspace = workspace.type === "main";
		// No hover action button on the local main workspace: a stray click on the
		// minus would remove the project's anchor row. Removal stays available via
		// the context menu.
		const isLocalMainWorkspace = isMainWorkspace && hostType === "local-device";
		const workspaceKindTitle = isMainWorkspace
			? "Main workspace"
			: "Worktree workspace";
		const workspaceKindDescription = isMainWorkspace
			? "Uses the repository checkout on this host"
			: "Isolated copy for parallel development";

		return (
			<div
				ref={(node) => {
					localRef.current = node;
					if (typeof ref === "function") ref(node);
					else if (ref) ref.current = node;
				}}
				className={cn(
					"relative mx-2 rounded-md text-left text-sm",
					// Upstream's hover/selected colours stay snappy; the returned-ring
					// below needs its own slow fade, so both live in one transition.
					"[transition:color_150ms,background-color_150ms,box-shadow_1000ms]",
					isActive && "bg-fill-selected",
					isSelected && "bg-fill-selected",
					onClick &&
						(isSelected
							? "hover:bg-fill-selected"
							: isActive
								? "hover:bg-fill-selected"
								: "hover:bg-fill-hover"),
					// Subtle one-shot highlight when a snoozed thread auto-returns;
					// the flag self-clears after a few seconds and the ring fades out.
					// GREEN (snooze itself is amber) so "returned" reads differently.
					workspace.justReturned && "ring-1 ring-inset ring-green-500/50",
					// Archived + Recycle Bin rows are visually dimmed vs active/snoozed.
					(sectionState === "archived" || sectionState === "deleted") &&
						"opacity-60",
					className,
				)}
				data-selected={isSelected || undefined}
				{...props}
			>
				{/* biome-ignore lint/a11y/useSemanticElements: The row contains nested action buttons, so it cannot be a native button. */}
				<div
					role="button"
					tabIndex={0}
					aria-disabled={isPending ? true : undefined}
					aria-pressed={isBulkSelectable ? isSelected : undefined}
					onClick={onClick}
					onKeyDown={(event) => {
						if (onClick && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							event.stopPropagation();
							onKeyboardActivate?.(event);
						}
					}}
					onDoubleClick={onDoubleClick}
					className={cn(
						"group relative flex w-full items-center py-1.5 pr-2",
						isInSection ? "pl-8" : "pl-3",
						onClick && "cursor-pointer",
					)}
				>
					{isSelected ? (
						<span className="mr-2.5 flex size-5 shrink-0 items-center justify-center text-foreground">
							<HiCheck className="size-3.5" />
						</span>
					) : (
						<Tooltip delayDuration={500}>
							<TooltipTrigger asChild>
								{pullRequest ? (
									<button
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											openUrl.mutate(pullRequest.url);
										}}
										onKeyDown={(event) => {
											if (event.key === "Enter" || event.key === " ") {
												event.stopPropagation();
											}
										}}
										aria-label={`Open pull request #${pullRequest.number}`}
										className="relative mr-2.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-foreground/10"
									>
										<DashboardSidebarWorkspaceIcon
											hostType={hostType}
											workspaceType={workspace.type}
											hostIsOnline={hostIsOnline}
											isActive={isActive}
											variant="expanded"
											workspaceStatus={workspaceStatus}
											isCreatePending={isPending}
											pullRequestState={pullRequest.state}
											isNonGit={isNonGit}
										/>
									</button>
								) : (
									<div className="relative mr-2.5 flex size-5 shrink-0 items-center justify-center">
										<DashboardSidebarWorkspaceIcon
											hostType={hostType}
											workspaceType={workspace.type}
											hostIsOnline={hostIsOnline}
											isActive={isActive}
											variant="expanded"
											workspaceStatus={workspaceStatus}
											isCreatePending={isPending}
											pullRequestState={null}
											isNonGit={isNonGit}
										/>
									</div>
								)}
							</TooltipTrigger>
							<TooltipContent side="right" sideOffset={8}>
								{pullRequest ? (
									<>
										<p className="text-xs font-medium">
											PR #{pullRequest.number} —{" "}
											{PR_STATE_LABEL[pullRequest.state]}
										</p>
										<p className="text-xs text-muted-foreground">
											Click to open on GitHub
										</p>
									</>
								) : (
									<>
										<p className="text-xs font-medium">
											{isMainWorkspace
												? workspaceKindTitle
												: hostType === "local-device"
													? "Local workspace"
													: hostType === "remote-device"
														? hostIsOnline === false
															? "Remote workspace — device offline"
															: "Remote workspace"
														: "Cloud workspace"}
										</p>
										<p className="text-xs text-muted-foreground">
											{isMainWorkspace
												? workspaceKindDescription
												: hostType === "local-device"
													? "Running on this device"
													: hostType === "remote-device"
														? hostIsOnline === false
															? "The associated device isn't reachable right now"
															: "Running on a paired device"
														: "Hosted in the cloud"}
										</p>
									</>
								)}
							</TooltipContent>
						</Tooltip>
					)}

					{pinnedContext && (
						<Tooltip delayDuration={500}>
							<TooltipTrigger asChild>
								<div className="mr-1.5 flex shrink-0 items-center">
									<ProjectThumbnail
										projectName={pinnedContext.projectName ?? "Session"}
										iconUrl={pinnedContext.projectIconUrl}
										className="size-3.5 text-[8px]"
									/>
								</div>
							</TooltipTrigger>
							<TooltipContent side="right" sideOffset={8}>
								{pinnedContext.projectName ?? "Session"}
							</TooltipContent>
						</Tooltip>
					)}

					<div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5">
						{isRenaming ? (
							<RenameInput
								value={renameValue}
								onChange={onRenameValueChange}
								onSubmit={onSubmitRename}
								onCancel={onCancelRename}
								className={cn(
									"h-5 w-full -ml-1 border-none bg-transparent px-1 py-0 text-[13px] leading-tight outline-none",
								)}
							/>
						) : (
							<div className="flex min-w-0 items-center gap-1.5">
								<span
									className={cn(
										"truncate text-[13px] leading-tight transition-colors",
										isActive || isSelected
											? "text-foreground"
											: "text-foreground/80",
									)}
								>
									{name || branch}
									{isSelected && <span className="sr-only">, selected</span>}
								</span>
								{snoozeRemaining && (
									<span className="ml-auto shrink-0 text-[10px] tabular-nums text-amber-500/80">
										{snoozeRemaining}
									</span>
								)}
								{hostType === "local-device" && (
									<ClaudeAccountIndicator workspaceId={workspace.id} />
								)}
								{/* (TAB-CHIPS) A zero/one-tab workspace keeps one folded
								    inline dot; multi-tab workspaces move every dot to its chip. */}
								{tabCount <= 1 && tabStatus && (
									<StatusIndicator status={tabStatus} />
								)}
							</div>
						)}

						<div className="col-start-2 row-start-1 grid h-5 shrink-0 items-center justify-items-end [&>*]:col-start-1 [&>*]:row-start-1">
							{creationStatusText ? (
								<span className="text-[11px] text-muted-foreground">
									{creationStatusText}
								</span>
							) : (
								isActive &&
								diffStats &&
								(diffStats.additions > 0 || diffStats.deletions > 0) && (
									<DashboardSidebarWorkspaceDiffStats
										additions={diffStats.additions}
										deletions={diffStats.deletions}
										isActive={isActive}
									/>
								)
							)}
							{!isPending && !isSelected && (
								<div className="hidden items-center justify-end gap-1.5 group-hover:flex group-focus-within:flex">
									{shortcutLabel && (
										<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
											{shortcutLabel}
										</span>
									)}
									{sectionState ? (
										<Tooltip delayDuration={300}>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={(event) => {
														event.stopPropagation();
														onRestoreClick?.();
													}}
													onKeyDown={(event) => {
														if (
															event.key === "Enter" ||
															event.key === " " ||
															event.key === "Spacebar"
														) {
															event.stopPropagation();
														}
													}}
													className="flex items-center justify-center text-muted-foreground hover:text-foreground"
													aria-label={restoreActionLabel}
												>
													{sectionState === "deleted" ? (
														<LuRotateCcw className="size-3.5" />
													) : (
														<LuUndo2 className="size-3.5" />
													)}
												</button>
											</TooltipTrigger>
											<TooltipContent side="top" sideOffset={4}>
												<HotkeyLabel label={restoreActionLabel} />
											</TooltipContent>
										</Tooltip>
									) : isLocalMainWorkspace ? null : isMainWorkspace ? (
										<Tooltip delayDuration={300}>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={(event) => {
														event.stopPropagation();
														onRemoveFromSidebarClick();
													}}
													onKeyDown={(event) => {
														if (
															event.key === "Enter" ||
															event.key === " " ||
															event.key === "Spacebar"
														) {
															event.stopPropagation();
														}
													}}
													className="flex items-center justify-center text-muted-foreground hover:text-foreground"
													aria-label="Remove from sidebar"
												>
													<HiMiniMinus className="size-3.5" />
												</button>
											</TooltipTrigger>
											<TooltipContent side="top">
												<HotkeyLabel label="Remove from sidebar" />
											</TooltipContent>
										</Tooltip>
									) : (
										<Tooltip delayDuration={300}>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={(event) => {
														event.stopPropagation();
														onCloseWorkspaceClick();
													}}
													onKeyDown={(event) => {
														if (
															event.key === "Enter" ||
															event.key === " " ||
															event.key === "Spacebar"
														) {
															event.stopPropagation();
														}
													}}
													className="flex items-center justify-center text-muted-foreground hover:text-foreground"
													aria-label="Close workspace"
												>
													<HiMiniXMark className="size-3.5" />
												</button>
											</TooltipTrigger>
											<TooltipContent side="top">
												<HotkeyLabel
													label="Close workspace"
													id={isActive ? "CLOSE_WORKSPACE" : undefined}
												/>
											</TooltipContent>
										</Tooltip>
									)}
								</div>
							)}
						</div>
					</div>
				</div>
				{!isPending && (
					<>
						{/* (TAB-CHIPS) Every open tab gets one always-expanded chip in
						    pane-layout order, on its own wrapping row above the upstream
						    agents/ports chips so long tab titles never squeeze them. */}
						<DashboardSidebarWorkspaceDetails
							workspaceId={workspace.id}
							isInSection={isInSection}
							onClick={onDetailsStripClick}
						/>
						<DashboardSidebarWorkspaceChips
							workspaceId={workspace.id}
							isInSection={isInSection}
							onClick={onWorkspaceChipsClick}
						/>
					</>
				)}
			</div>
		);
	},
);
