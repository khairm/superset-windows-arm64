import { Trans, useLingui } from "@lingui/react/macro";
import { FEATURE_FLAGS } from "@superset/shared/constants";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useMatchRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { useRef } from "react";
import { GoGitPullRequest } from "react-icons/go";
import {
	LuColumns3,
	LuFileText,
	LuLayers,
	LuPlus,
	LuPuzzle,
	LuSearch,
} from "react-icons/lu";
import {
	VscFolderOpened,
	VscGithubAlt,
	VscLayout,
	VscNewFolder,
} from "react-icons/vsc";
import { useFrameStackStore } from "renderer/commandPalette";
import { SidebarKbdHint } from "renderer/components/SidebarKbdHint";
import { ZoomStable } from "renderer/components/ZoomStable";
import { env } from "renderer/env.renderer";
import { useZoomFactor } from "renderer/hooks/useZoomFactor";
import { useHotkeyDisplay } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useFolderFirstImport } from "renderer/routes/_authenticated/_dashboard/components/AddRepositoryModals/hooks/useFolderFirstImport";
import { NavigationControls } from "renderer/routes/_authenticated/_dashboard/components/NavigationControls";
import { SidebarToggle } from "renderer/routes/_authenticated/_dashboard/components/SidebarToggle";
import { TopBarPortsDropdown } from "renderer/routes/_authenticated/_dashboard/components/TopBar/components/TopBarPortsDropdown";
import {
	pullRequestsSearchFromFilters,
	usePullRequestsFilterStore,
} from "renderer/routes/_authenticated/_dashboard/pull-requests/stores/pullRequestsFilterStore";
import { useHostWorkspaces } from "renderer/routes/_authenticated/providers/HostWorkspacesProvider";
import { STROKE_WIDTH_THICK } from "renderer/screens/main/components/WorkspaceSidebar/constants";
import {
	useOpenEmptyProjectModal,
	useOpenMultiFolderModal,
	useOpenNewProjectModal,
	useOpenTemplateGalleryModal,
} from "renderer/stores/add-repository-modal";
import { useOpenNewWorkspaceModal } from "renderer/stores/new-workspace-modal";

interface DashboardSidebarHeaderProps {
	isCollapsed?: boolean;
}

/**
 * (KANBAN-TOGGLE) Where the sidebar Kanban button returns to when it closes
 * the full-screen board. Session-only; module scope so it survives the
 * sidebar's collapse/expand remounts. Null = never opened via the button
 * this session → close falls back to the Workspaces list.
 */
let kanbanCloseTarget:
	| { kind: "workspace"; workspaceId: string }
	| { kind: "href"; href: string }
	| null = null;

export function DashboardSidebarHeader({
	isCollapsed = false,
}: DashboardSidebarHeaderProps) {
	const { t } = useLingui();
	const openModal = useOpenNewWorkspaceModal();
	const openEmptyProject = useOpenEmptyProjectModal();
	const openNewProject = useOpenNewProjectModal();
	const openTemplateGallery = useOpenTemplateGalleryModal();
	const openMultiFolder = useOpenMultiFolderModal();
	const navigate = useNavigate();
	const router = useRouter();
	const folderImport = useFolderFirstImport({
		onError: (message) => {
			toast.error(
				t({
					id: "dashboard.sidebar.header.importFailed",
					message: `Import failed: ${message}`,
				}),
			);
		},
		onMultipleProjects: ({ candidates }) => {
			toast.error(
				t({
					id: "dashboard.sidebar.header.importFailedTitle",
					message: "Import failed",
				}),
				{
					description: t({
						id: "dashboard.sidebar.header.importMultipleProjects",
						message: `Multiple projects use this repository (${candidates.length}). Choose the project in settings to set it up on this device.`,
					}),
					action: {
						label: t({
							id: "dashboard.sidebar.header.openProjects",
							message: "Open Projects",
						}),
						onClick: () => navigate({ to: "/settings/projects" }),
					},
				},
			);
		},
	});

	const handleImportFolder = async () => {
		const result = await folderImport.start();
		if (result) {
			toast.success(
				t({
					id: "dashboard.sidebar.header.projectReady",
					message: "Project ready — open it from the sidebar.",
				}),
			);
		}
	};

	const shortcutText = useHotkeyDisplay("NEW_WORKSPACE").text;
	const searchShortcutText = useHotkeyDisplay("OPEN_COMMAND_PALETTE").text;
	const openCommandPalette = useFrameStackStore((s) => s.setOpen);
	// The palette dialog dismisses on outside pointerdown before our click fires,
	// so a live-state toggle would always reopen it. Capture the state at
	// pointerdown to make clicking the button close an open palette.
	const paletteWasOpenRef = useRef(false);
	const handleSearchPointerDown = () => {
		paletteWasOpenRef.current = useFrameStackStore.getState().open;
	};
	const handleSearchClick = () => {
		openCommandPalette(!paletteWasOpenRef.current);
		paletteWasOpenRef.current = false;
	};
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	// Default to Mac while loading so we don't briefly cover the traffic lights.
	const isMac = platform === undefined || platform === "darwin";
	const zoomFactor = useZoomFactor();
	const matchRoute = useMatchRoute();
	const isWorkspacesListOpen = !!matchRoute({ to: "/v2-workspaces" });
	const v2WorkspaceMatch = matchRoute({
		to: "/v2-workspace/$workspaceId",
		fuzzy: true,
	});
	const onV2WorkspaceRoute = v2WorkspaceMatch !== false;
	// Pre-select the viewed workspace's project in the new-workspace modal.
	const { workspaces: hostWorkspaces } = useHostWorkspaces();
	const activeProjectId =
		v2WorkspaceMatch !== false
			? (hostWorkspaces.find(
					(workspace) => workspace.id === v2WorkspaceMatch.workspaceId,
				)?.projectId ?? undefined)
			: undefined;
	// (CLOUD-SEVERANCE-P2) The Tasks and Automations rows are gone, and with
	// them the failed-automation badge poll — it read `cloudTrpc.automation`
	// once a minute for a count that can no longer change.
	const isPullRequestsOpen = !!matchRoute({
		to: "/pull-requests",
		fuzzy: true,
	});
	const isKanbanOpen = !!matchRoute({ to: "/kanban", fuzzy: true });
	// (USAGE) Upstream moved the Usage page under Settings in v1.25.1, so the
	// rail button is gone with it — the page itself is still ours and still
	// reads the LOCAL host-service (`usage.history`, `usage.quota`).
	const isPluginsOpen = !!matchRoute({ to: "/plugins", fuzzy: true });
	const isPagesOpen = !!matchRoute({ to: "/pages", fuzzy: true });
	// `?? false`: the hook returns undefined until PostHog flags resolve.
	// Dev builds bypass the flag — the local dev account isn't in the
	// @superset.sh release condition.
	const isPluginsEnabled =
		(useFeatureFlagEnabled(FEATURE_FLAGS.PLUGINS) ?? false) ||
		env.NODE_ENV === "development";

	const {
		search: lastPullRequestsSearch,
		projectFilters: lastPullRequestsProjectFilters,
		authorFilter: lastPullRequestsAuthorFilter,
		reviewFilter: lastPullRequestsReviewFilter,
		includeClosed: lastPullRequestsIncludeClosed,
		mergedOnly: lastPullRequestsMergedOnly,
	} = usePullRequestsFilterStore();

	const handleWorkspacesClick = () => {
		navigate({ to: "/v2-workspaces" });
	};

	// (KANBAN) Ungated — this is the fork's local-only board, not the paywalled
	// upstream cloud Tasks feature.
	// (KANBAN-TOGGLE) The button is a toggle: anywhere → full-screen board;
	// part-screen split → full-screen board (closing then reopens that
	// workspace full size); full-screen board → close back to where you were.
	const handleKanbanClick = () => {
		const location = router.state.location;
		const onKanban = !!matchRoute({ to: "/kanban", fuzzy: true });
		if (!onKanban) {
			kanbanCloseTarget = { kind: "href", href: location.href };
			navigate({ to: "/kanban" });
			return;
		}
		const { cardId } = location.search as { cardId?: string };
		if (cardId) {
			kanbanCloseTarget = { kind: "workspace", workspaceId: cardId };
			navigate({ to: "/kanban", search: { cardId: undefined } });
			return;
		}
		const target = kanbanCloseTarget;
		kanbanCloseTarget = null;
		if (target?.kind === "workspace") {
			navigate({
				to: "/v2-workspace/$workspaceId",
				params: { workspaceId: target.workspaceId },
			});
			return;
		}
		if (target?.kind === "href") {
			router.history.push(target.href);
			return;
		}
		navigate({ to: "/v2-workspaces" });
	};

	const isPagesEnabled = useFeatureFlagEnabled(FEATURE_FLAGS.PAGES) ?? false;

	const handlePagesClick = () => {
		navigate({ to: "/pages" });
	};

	const handlePluginsClick = () => {
		navigate({ to: "/plugins" });
	};

	// (CLOUD-SEVERANCE-P2) Ungated. Pull requests come from GitHub through the
	// local host-service, so there is nothing here to sell — and the upgrade
	// dialog this used to raise is unmounted, which would have left the button
	// doing nothing at all.
	const handlePullRequestsClick = () => {
		navigate({
			to: "/pull-requests",
			search: pullRequestsSearchFromFilters({
				search: lastPullRequestsSearch,
				projectFilters: lastPullRequestsProjectFilters,
				authorFilter: lastPullRequestsAuthorFilter,
				reviewFilter: lastPullRequestsReviewFilter,
				includeClosed: lastPullRequestsIncludeClosed,
				mergedOnly: lastPullRequestsMergedOnly,
			}),
		});
	};

	if (isCollapsed) {
		return (
			<div className="flex flex-col">
				{/* On the v2 workspace route the TopBar is hidden and the pane tab
				    bar is the only top row, so the rail continues that bar across
				    its own width: same height, background, and bottom border as the
				    tab bar, doubling as traffic-light headroom and a drag region. */}
				{onV2WorkspaceRoute && (
					<div
						// w +1px: overlaps the container's border-r so the sidebar's
						// vertical border starts below the bar, not inside it. The fill
						// is the tab bar's bg-muted/45|35-over-background flattened to an
						// opaque color so it can paint over that border pixel.
						className="drag h-10 w-[calc(100%+1px)] shrink-0 bg-[color-mix(in_oklab,var(--muted)_45%,var(--background))] dark:bg-[color-mix(in_oklab,var(--muted)_35%,var(--background))]"
					/>
				)}
				{/* Mirrors the expanded header's nav container so the buttons keep
				    the same padding, order, and vertical rhythm when collapsed. */}
				<div className="flex flex-col items-center gap-1 px-2 pt-3 pb-2">
					<Tooltip delayDuration={300}>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() => openModal(activeProjectId)}
								className="flex size-7 items-center justify-center rounded-md bg-fill-hover/60 [.light_&]:bg-fill-hover text-muted-foreground transition-colors hover:bg-fill-selected [.light_&]:hover:bg-fill-selected"
							>
								<div className="flex size-5 items-center justify-center rounded bg-fill-selected">
									<LuPlus className="size-3" strokeWidth={STROKE_WIDTH_THICK} />
								</div>
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">
							<Trans id="dashboard.sidebar.header.newWorkspaceWithShortcut">
								New Workspace ({shortcutText})
							</Trans>
						</TooltipContent>
					</Tooltip>

					<Tooltip delayDuration={300}>
						<TooltipTrigger asChild>
							<button
								type="button"
								onPointerDown={handleSearchPointerDown}
								onClick={handleSearchClick}
								className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill-hover"
							>
								<LuSearch className="size-3.5" strokeWidth={1.5} />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">
							{searchShortcutText !== "Unassigned"
								? t({
										id: "dashboard.sidebar.header.searchWithShortcut",
										message: `Search (${searchShortcutText})`,
									})
								: t({
										id: "dashboard.sidebar.header.searchTooltip",
										message: "Search",
									})}
						</TooltipContent>
					</Tooltip>

					<Tooltip delayDuration={300}>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={handleWorkspacesClick}
								className={cn(
									"flex size-7 items-center justify-center rounded-md transition-colors",
									isWorkspacesListOpen
										? "bg-fill-selected text-muted-foreground"
										: "text-muted-foreground hover:bg-fill-hover",
								)}
							>
								<LuLayers className="size-3.5" strokeWidth={1.5} />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">
							<Trans id="dashboard.sidebar.header.workspacesTooltip">
								Workspaces
							</Trans>
						</TooltipContent>
					</Tooltip>

					<Tooltip delayDuration={300}>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={handlePullRequestsClick}
								aria-label={t({
									id: "dashboard.sidebar.header.pullRequestsRailAriaLabel",
									message: "Pull requests",
								})}
								aria-current={isPullRequestsOpen ? "page" : undefined}
								className={cn(
									"flex size-7 items-center justify-center rounded-md transition-colors",
									isPullRequestsOpen
										? "bg-fill-selected text-muted-foreground"
										: "text-muted-foreground hover:bg-fill-hover",
								)}
							>
								<GoGitPullRequest className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">
							<Trans id="dashboard.sidebar.header.pullRequestsTooltip">
								Pull requests
							</Trans>
						</TooltipContent>
					</Tooltip>

					<Tooltip delayDuration={300}>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={handleKanbanClick}
								aria-label={t({
									id: "dashboard.sidebar.header.kanbanRailAriaLabel",
									message: "Kanban",
								})}
								aria-current={isKanbanOpen ? "page" : undefined}
								className={cn(
									"flex size-7 items-center justify-center rounded-md transition-colors",
									isKanbanOpen
										? "bg-fill-selected text-muted-foreground"
										: "text-muted-foreground hover:bg-fill-hover",
								)}
							>
								<LuColumns3 className="size-3.5" strokeWidth={1.5} />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">
							<Trans id="dashboard.sidebar.header.kanbanTooltip">Kanban</Trans>
						</TooltipContent>
					</Tooltip>

					{isPagesEnabled && (
						<Tooltip delayDuration={300}>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={handlePagesClick}
									aria-label={t({
										id: "dashboard.sidebar.header.pagesRailAriaLabel",
										message: "Pages",
									})}
									aria-current={isPagesOpen ? "page" : undefined}
									className={cn(
										"flex size-7 items-center justify-center rounded-md transition-colors",
										isPagesOpen
											? "bg-fill-selected text-muted-foreground"
											: "text-muted-foreground hover:bg-fill-hover",
									)}
								>
									<LuFileText className="size-3.5" strokeWidth={1.5} />
								</button>
							</TooltipTrigger>
							<TooltipContent side="right">
								<Trans id="dashboard.sidebar.header.pagesTooltip">Pages</Trans>
							</TooltipContent>
						</Tooltip>
					)}

					{isPluginsEnabled && (
						<Tooltip delayDuration={300}>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={handlePluginsClick}
									aria-label={t({
										id: "dashboard.sidebar.header.pluginsRailAriaLabel",
										message: "Plugins",
									})}
									aria-current={isPluginsOpen ? "page" : undefined}
									className={cn(
										"flex size-7 items-center justify-center rounded-md transition-colors",
										isPluginsOpen
											? "bg-fill-selected text-muted-foreground"
											: "text-muted-foreground hover:bg-fill-hover",
									)}
								>
									<LuPuzzle className="size-3.5" strokeWidth={1.5} />
								</button>
							</TooltipTrigger>
							<TooltipContent side="right">
								<Trans id="dashboard.sidebar.header.pluginsTooltip">
									Plugins
								</Trans>
							</TooltipContent>
						</Tooltip>
					)}

					<DropdownMenu>
						<Tooltip delayDuration={700}>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										aria-label={t({
											id: "dashboard.sidebar.header.addProjectAriaLabel",
											message: "Add project",
										})}
										className="group/addrepo flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill-hover"
									>
										<VscNewFolder className="size-3.5 group-hover/addrepo:hidden" />
										<VscFolderOpened className="hidden size-3.5 group-hover/addrepo:block" />
									</button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent side="right">
								<Trans id="dashboard.sidebar.header.addProjectTooltip">
									Add project
								</Trans>
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent
							align="start"
							onCloseAutoFocus={(event) => event.preventDefault()}
						>
							<DropdownMenuItem onSelect={handleImportFolder}>
								<VscFolderOpened className="size-4" />
								<Trans id="dashboard.sidebar.header.openProject">
									Open project
								</Trans>
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => openNewProject()}>
								<VscGithubAlt className="size-4" />
								<Trans id="dashboard.sidebar.header.cloneFromUrl">
									Clone from URL
								</Trans>
							</DropdownMenuItem>
							{/* (MULTI-REPO WORKSPACE) group N git repos under one row */}
							<DropdownMenuItem onSelect={() => openMultiFolder()}>
								<VscFolderOpened className="size-4" />
								Open from multi-folder
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => openEmptyProject()}>
								<VscNewFolder className="size-4" />
								<Trans id="dashboard.sidebar.header.createNewProject">
									Create new project
								</Trans>
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => openTemplateGallery()}>
								<VscLayout className="size-4" />
								<Trans id="dashboard.sidebar.header.startFromTemplate">
									Start from a template
								</Trans>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
		);
	}

	return (
		<div
			className="flex flex-col gap-px px-2 pt-2 pb-2"
			// Pin the top inset so the traffic-light row stays a constant physical
			// distance from the window top under page zoom (see the row below).
			style={isMac ? { paddingTop: `${8 / zoomFactor}px` } : undefined}
		>
			{/* -mx-2 cancels the parent's px-2 so this row owns the 80px traffic-light
			    inset; inset and height are counter-scaled to a constant physical size
			    so the fixed macOS traffic lights stay aligned under page zoom. On Mac
			    the control clusters below use ZoomStable so the collapse/nav icons and
			    usage badge keep a constant physical size instead of scaling with page
			    zoom and overflowing this fixed-height row. It's Mac-only because the
			    pinned row height it matches is Mac-only; elsewhere the row height (h-8)
			    scales with zoom, so the controls should scale with it. */}
			<div
				// Window-drag regions live on the empty spacer + filler leaves, never
				// on this row: `no-drag` carve-outs under a `drag` ancestor are lost
				// inside zoomed wrappers like ZoomStable, deadening the controls.
				className="-mx-2 mb-3 flex h-8 items-center pr-3"
				style={isMac ? { height: `${32 / zoomFactor}px` } : undefined}
			>
				<div
					className="drag h-full shrink-0"
					style={{ width: isMac ? `${80 / zoomFactor}px` : "8px" }}
				/>
				<ZoomStable enabled={isMac} className="flex items-center gap-1">
					<SidebarToggle />
					<NavigationControls />
					{/* Lives here (persistent chrome) rather than the workspace tab
					    bar, which remounts on every navigation. */}
					<TopBarPortsDropdown align="start" />
				</ZoomStable>
				<div className="drag h-full min-w-0 flex-1" />
			</div>

			<button
				type="button"
				onClick={() => openModal(activeProjectId)}
				className="group flex h-7 w-full items-center gap-2 rounded-md bg-fill-hover/60 [.light_&]:bg-fill-hover px-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-fill-selected [.light_&]:hover:bg-fill-selected hover:text-foreground"
			>
				<div className="flex size-5 shrink-0 items-center justify-center rounded bg-fill-selected">
					<LuPlus className="size-3" strokeWidth={STROKE_WIDTH_THICK} />
				</div>
				<span className="flex-1 truncate text-left whitespace-nowrap">
					<Trans id="dashboard.sidebar.header.newWorkspace">
						New Workspace
					</Trans>
				</span>
				<SidebarKbdHint label={shortcutText} />
			</button>

			<button
				type="button"
				onPointerDown={handleSearchPointerDown}
				onClick={handleSearchClick}
				className="group flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-fill-hover hover:text-foreground"
			>
				<LuSearch
					className="size-4 shrink-0 text-muted-foreground"
					strokeWidth={1.5}
				/>
				<span className="flex-1 text-left">
					<Trans id="dashboard.sidebar.header.search">Search</Trans>
				</span>
				{searchShortcutText !== "Unassigned" && (
					<SidebarKbdHint label={searchShortcutText} />
				)}
			</button>

			<button
				type="button"
				onClick={handleWorkspacesClick}
				className={cn(
					"flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium transition-colors",
					isWorkspacesListOpen
						? "bg-fill-selected text-foreground"
						: "text-muted-foreground hover:bg-fill-hover hover:text-foreground",
				)}
			>
				<LuLayers
					className="size-4 shrink-0 text-muted-foreground"
					strokeWidth={1.5}
				/>
				<span className="flex-1 text-left">
					<Trans id="dashboard.sidebar.header.workspaces">Workspaces</Trans>
				</span>
			</button>

			<button
				type="button"
				onClick={handlePullRequestsClick}
				aria-label={t({
					id: "dashboard.sidebar.header.pullRequestsAriaLabel",
					message: "Pull requests",
				})}
				aria-current={isPullRequestsOpen ? "page" : undefined}
				className={cn(
					"flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium transition-colors",
					isPullRequestsOpen
						? "bg-fill-selected text-foreground"
						: "text-muted-foreground hover:bg-fill-hover hover:text-foreground",
				)}
			>
				<GoGitPullRequest className="size-4 shrink-0 text-muted-foreground" />
				<span className="flex-1 text-left">
					<Trans id="dashboard.sidebar.header.pullRequests">
						Pull requests
					</Trans>
				</span>
			</button>

			<button
				type="button"
				onClick={handleKanbanClick}
				aria-label={t({
					id: "dashboard.sidebar.header.kanbanAriaLabel",
					message: "Kanban",
				})}
				aria-current={isKanbanOpen ? "page" : undefined}
				className={cn(
					"flex w-full items-center gap-2 rounded-md px-2 py-1 text-[13px] font-medium transition-colors",
					isKanbanOpen
						? "bg-fill-selected text-foreground"
						: "text-muted-foreground hover:bg-fill-hover hover:text-foreground",
				)}
			>
				<LuColumns3
					className="size-3.5 shrink-0 text-muted-foreground"
					strokeWidth={1.5}
				/>
				<span className="flex-1 text-left">
					<Trans id="dashboard.sidebar.header.kanban">Kanban</Trans>
				</span>
			</button>

			{isPagesEnabled && (
				<button
					type="button"
					onClick={handlePagesClick}
					aria-label={t({
						id: "dashboard.sidebar.header.pagesAriaLabel",
						message: "Pages",
					})}
					aria-current={isPagesOpen ? "page" : undefined}
					className={cn(
						"flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium transition-colors",
						isPagesOpen
							? "bg-fill-selected text-foreground"
							: "text-muted-foreground hover:bg-fill-hover hover:text-foreground",
					)}
				>
					<LuFileText
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.5}
					/>
					<span className="flex-1 text-left">
						<Trans id="dashboard.sidebar.header.pages">Pages</Trans>
					</span>
				</button>
			)}

			{isPluginsEnabled && (
				<button
					type="button"
					onClick={handlePluginsClick}
					aria-label={t({
						id: "dashboard.sidebar.header.pluginsAriaLabel",
						message: "Plugins",
					})}
					aria-current={isPluginsOpen ? "page" : undefined}
					className={cn(
						"flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium transition-colors",
						isPluginsOpen
							? "bg-fill-selected text-foreground"
							: "text-muted-foreground hover:bg-fill-hover hover:text-foreground",
					)}
				>
					<LuPuzzle
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.5}
					/>
					<span className="flex-1 text-left">
						<Trans id="dashboard.sidebar.header.plugins">Plugins</Trans>
					</span>
				</button>
			)}
		</div>
	);
}
