import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import {
	type ComponentPropsWithoutRef,
	forwardRef,
	useEffect,
	useRef,
} from "react";
import { HiMiniMinus, HiMiniXMark } from "react-icons/hi2";
import { LuRotateCcw, LuUndo2 } from "react-icons/lu";
import type { DiffStats } from "renderer/hooks/host-service/useDiffStats";
import { HotkeyLabel } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type DisplayStatus,
	StatusIndicator,
} from "renderer/screens/main/components/StatusIndicator";
import { RenameInput } from "renderer/screens/main/components/WorkspaceSidebar/RenameInput";
import type {
	DashboardSidebarWorkspace,
	DashboardSidebarWorkspacePullRequest,
} from "../../../../types";
import { DashboardSidebarWorkspaceDiffStats } from "../DashboardSidebarWorkspaceDiffStats";
import { DashboardSidebarWorkspaceIcon } from "../DashboardSidebarWorkspaceIcon";

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
	onRestoreClick?: () => void;
	onClick?: () => void;
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
			onRestoreClick,
			onClick,
			onDoubleClick,
			onCloseWorkspaceClick,
			onRemoveFromSidebarClick,
			onRenameValueChange,
			onSubmitRename,
			onCancelRename,
			className,
			children,
			...props
		},
		ref,
	) => {
		const {
			accentColor = null,
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
		const showsStandaloneActiveStripe = accentColor == null;
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
					"relative w-full text-left text-sm",
					isActive && "bg-muted",
					onClick && (isActive ? "hover:bg-muted" : "hover:bg-muted/50"),
					// Subtle one-shot highlight when a snoozed thread auto-returns;
					// the flag self-clears after a few seconds and the ring fades out.
					// GREEN (snooze itself is amber) so "returned" reads differently.
					"transition-shadow duration-1000",
					workspace.justReturned && "ring-1 ring-inset ring-green-500/50",
					// Archived + Recycle Bin rows are visually dimmed vs active/snoozed.
					(sectionState === "archived" || sectionState === "deleted") &&
						"opacity-60",
					className,
				)}
				{...props}
			>
				{isActive && showsStandaloneActiveStripe && (
					<div
						className="absolute top-0 bottom-0 left-0 w-0.5 rounded-r"
						style={{ backgroundColor: "var(--color-foreground)" }}
					/>
				)}

				{/* biome-ignore lint/a11y/noStaticElementInteractions: Mirrors the legacy sidebar row UI, which includes nested action buttons. */}
				<div
					role={onClick ? "button" : undefined}
					tabIndex={onClick ? 0 : undefined}
					aria-disabled={isPending ? true : undefined}
					onClick={onClick}
					onKeyDown={(event) => {
						if (onClick && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							onClick();
						}
					}}
					onDoubleClick={onDoubleClick}
					className={cn(
						"group relative flex w-full items-center py-2 pr-2",
						isInSection ? "pl-7" : "pl-5",
						onClick && "cursor-pointer",
					)}
				>
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
										isActive ? "text-foreground" : "text-foreground/80",
									)}
								>
									{name || branch}
								</span>
								{snoozeRemaining && (
									<span className="ml-auto shrink-0 text-[10px] tabular-nums text-amber-500/80">
										{snoozeRemaining}
									</span>
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
								diffStats &&
								(diffStats.additions > 0 || diffStats.deletions > 0) && (
									<DashboardSidebarWorkspaceDiffStats
										additions={diffStats.additions}
										deletions={diffStats.deletions}
										isActive={isActive}
									/>
								)
							)}
							{!isPending && (
								<div className="hidden items-center justify-end gap-1.5 group-hover:flex">
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
									) : isMainWorkspace ? (
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
											<TooltipContent side="top" sideOffset={4}>
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
											<TooltipContent side="top" sideOffset={4}>
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
				{children}
			</div>
		);
	},
);
