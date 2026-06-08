import { cn } from "@superset/ui/utils";
import { CgLaptop } from "react-icons/cg";
import {
	LuFolder,
	LuGitMerge,
	LuGitPullRequest,
	LuGitPullRequestClosed,
	LuGitPullRequestDraft,
} from "react-icons/lu";
import { RxDot } from "react-icons/rx";
import { TbCloud, TbCloudOff } from "react-icons/tb";
import { AsciiSpinner } from "renderer/screens/main/components/AsciiSpinner";
import {
	type DisplayStatus,
	StatusIndicator,
} from "renderer/screens/main/components/StatusIndicator";
import type {
	DashboardSidebarWorkspaceHostType,
	DashboardSidebarWorkspacePullRequest,
	DashboardSidebarWorkspaceType,
} from "../../../../types";

interface DashboardSidebarWorkspaceIconProps {
	hostType: DashboardSidebarWorkspaceHostType;
	workspaceType: DashboardSidebarWorkspaceType;
	hostIsOnline: boolean | null;
	isActive: boolean;
	variant: "collapsed" | "expanded";
	workspaceStatus?: DisplayStatus | null;
	isCreatePending: boolean;
	pullRequestState?: DashboardSidebarWorkspacePullRequest["state"] | null;
	// (NON-GIT WORKSPACE) folder isn't a git repo — resolved by useIsGitRepo in
	// the parent item and threaded down so this leaf stays hook-free.
	isNonGit?: boolean;
}

const OVERLAY_POSITION = {
	collapsed: "top-1 right-1",
	expanded: "-top-0.5 -right-0.5",
} as const;

const PR_ICON_BY_STATE = {
	open: LuGitPullRequest,
	merged: LuGitMerge,
	closed: LuGitPullRequestClosed,
	draft: LuGitPullRequestDraft,
} as const;

const PR_COLOR_BY_STATE = {
	open: "text-emerald-500",
	merged: "text-purple-500",
	closed: "text-destructive",
	draft: "text-muted-foreground",
} as const;

export function DashboardSidebarWorkspaceIcon({
	hostType,
	workspaceType,
	hostIsOnline,
	isActive,
	variant,
	workspaceStatus = null,
	isCreatePending,
	pullRequestState = null,
	isNonGit = false,
}: DashboardSidebarWorkspaceIconProps) {
	const overlayPosition = OVERLAY_POSITION[variant];
	const iconColor = isActive ? "text-foreground" : "text-muted-foreground";
	// The overlay slot is shared: a real status badge wins; the non-git glyph
	// only fills it when there's no status to show.
	const overlayStatus =
		workspaceStatus && workspaceStatus !== "working" ? workspaceStatus : null;
	const isRemoteDeviceOffline =
		hostType === "remote-device" && hostIsOnline === false;

	const renderPrimaryIcon = () => {
		if (pullRequestState) {
			const PrIcon = PR_ICON_BY_STATE[pullRequestState];
			return (
				<PrIcon
					className={cn("size-3.5", PR_COLOR_BY_STATE[pullRequestState])}
					strokeWidth={1.75}
				/>
			);
		}

		if (hostType === "local-device") {
			if (workspaceType === "main") {
				return (
					<CgLaptop className={cn("size-4 transition-colors", iconColor)} />
				);
			}

			return <RxDot className={cn("size-4 transition-colors", iconColor)} />;
		}

		if (isRemoteDeviceOffline) {
			return (
				<TbCloudOff
					className={cn("size-4 transition-colors", iconColor, "opacity-60")}
					strokeWidth={1.75}
				/>
			);
		}

		return (
			<TbCloud
				className={cn("size-4 transition-colors", iconColor)}
				strokeWidth={1.75}
			/>
		);
	};

	return (
		<>
			{isCreatePending || workspaceStatus === "working" ? (
				<AsciiSpinner className="text-base" />
			) : (
				renderPrimaryIcon()
			)}
			{overlayStatus ? (
				<span className={cn("absolute", overlayPosition)}>
					<StatusIndicator status={overlayStatus} />
				</span>
			) : (
				isNonGit && (
					<span
						className={cn("absolute", overlayPosition)}
						title="Not a git repository"
					>
						<LuFolder
							className="size-2.5 text-muted-foreground/70"
							strokeWidth={2}
						/>
					</span>
				)
			)}
		</>
	);
}
