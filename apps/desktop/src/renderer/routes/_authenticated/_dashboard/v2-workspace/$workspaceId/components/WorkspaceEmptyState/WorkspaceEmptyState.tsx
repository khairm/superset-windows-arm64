import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import type { IconType } from "react-icons";
import { BsTerminalPlus } from "react-icons/bs";
import { LuGitCompareArrows, LuSearch } from "react-icons/lu";
import { GitHubStarPill } from "renderer/components/GitHubStarPill";
import { useHotkeyDisplay } from "renderer/hotkeys";
import supersetEmptyStateWordmark from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/assets/superset-empty-state-wordmark.svg";
import { EmptyTabActionButton } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/components/EmptyTabActionButton";
import { useTheme } from "renderer/stores/theme";

// (CLOUD-SEVERANCE-P2)
interface WorkspaceEmptyStateProps {
	/** Optional so the fork's thin route shim can omit it; the tile is hidden
	 * when it is. */
	onOpenChanges?: (() => void) | undefined;
	onOpenQuickOpen: () => void;
	onOpenTerminal: () => void;
}

interface WorkspaceEmptyStateAction {
	display: string[];
	icon: IconType;
	id: string;
	label: string;
	onClick: () => void;
}

export function WorkspaceEmptyState({
	onOpenChanges,
	onOpenQuickOpen,
	onOpenTerminal,
}: WorkspaceEmptyStateProps) {
	const { t } = useLingui();
	const activeTheme = useTheme();
	const { keys: newGroupDisplay } = useHotkeyDisplay("NEW_GROUP");
	const { keys: quickOpenDisplay } = useHotkeyDisplay("QUICK_OPEN");
	const { keys: openChangesDisplay } = useHotkeyDisplay("OPEN_DIFF_VIEWER");

	const actions = useMemo<Array<WorkspaceEmptyStateAction>>(
		() => [
			{
				id: "terminal",
				label: t({
					message: "Open Terminal",
				}),
				display: newGroupDisplay,
				icon: BsTerminalPlus,
				onClick: onOpenTerminal,
			},
			// (FORK-BROWSER-OFF)
			...(onOpenChanges
				? [
						{
							id: "changes",
							label: t({
								message: "Open Changes",
							}),
							display: openChangesDisplay,
							icon: LuGitCompareArrows,
							onClick: onOpenChanges,
						},
					]
				: []),
			{
				id: "search-files",
				label: t({
					message: "Search Files",
				}),
				display: quickOpenDisplay,
				icon: LuSearch,
				onClick: onOpenQuickOpen,
			},
		],
		[
			newGroupDisplay,
			onOpenChanges,
			onOpenQuickOpen,
			onOpenTerminal,
			openChangesDisplay,
			quickOpenDisplay,
			t,
		],
	);

	return (
		<div className="flex h-full flex-1 items-center justify-center px-6 py-10">
			<div className="w-full max-w-xl">
				<div className="mb-7 flex items-center justify-center py-3">
					<img
						alt="Superset"
						className={`h-8 w-auto select-none ${
							activeTheme?.type === "dark"
								? "opacity-85"
								: "brightness-0 opacity-75"
						}`}
						draggable={false}
						src={supersetEmptyStateWordmark}
					/>
				</div>
				<div className="mx-auto grid w-full max-w-md gap-0.5">
					{actions.map((action) => (
						<EmptyTabActionButton
							key={action.id}
							display={action.display}
							icon={action.icon}
							label={action.label}
							onClick={action.onClick}
						/>
					))}
				</div>
				<GitHubStarPill className="mt-6" />
			</div>
		</div>
	);
}
