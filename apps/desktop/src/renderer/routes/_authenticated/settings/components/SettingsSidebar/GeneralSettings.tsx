import { cn } from "@superset/ui/utils";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import {
	HiOutlineBeaker,
	HiOutlineBell,
	HiOutlineCommandLine,
	HiOutlineCpuChip,
	HiOutlineFolder,
	HiOutlineLink,
	HiOutlinePaintBrush,
	HiOutlineShieldCheck,
	HiOutlineSparkles,
} from "react-icons/hi2";
import { LuBrain, LuGitBranch, LuKeyboard } from "react-icons/lu";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { SettingsSection } from "renderer/stores/settings-state";
import { getAllowedSectionsForVariant } from "../../utils/settings-search";

interface GeneralSettingsProps {
	matchCounts: Partial<Record<SettingsSection, number>> | null;
}

type SettingsRoute =
	| "/settings/appearance"
	| "/settings/ringtones"
	| "/settings/keyboard"
	| "/settings/behavior"
	| "/settings/git"
	| "/settings/agents"
	| "/settings/terminal"
	| "/settings/links"
	| "/settings/models"
	| "/settings/experimental"
	| "/settings/permissions"
	| "/settings/projects";

interface SectionItem {
	id: SettingsRoute;
	section: SettingsSection;
	label: string;
	icon: React.ReactNode;
	macOnly?: boolean;
}

interface SectionGroup {
	label: string;
	items: SectionItem[];
}

const SECTION_GROUPS: SectionGroup[] = [
	{
		label: "Personal",
		items: [
			{
				id: "/settings/appearance",
				section: "appearance",
				label: "Appearance",
				icon: <HiOutlinePaintBrush className="h-4 w-4" />,
			},
			{
				id: "/settings/ringtones",
				section: "ringtones",
				label: "Notifications",
				icon: <HiOutlineBell className="h-4 w-4" />,
			},
		],
	},
	{
		label: "Editor & Workflow",
		items: [
			{
				id: "/settings/behavior",
				section: "behavior",
				label: "General",
				icon: <HiOutlineSparkles className="h-4 w-4" />,
			},
			{
				id: "/settings/keyboard",
				section: "keyboard",
				label: "Keyboard",
				icon: <LuKeyboard className="h-4 w-4" />,
			},
			{
				id: "/settings/git",
				section: "git",
				label: "Git & Worktrees",
				icon: <LuGitBranch className="h-4 w-4" />,
			},
			{
				id: "/settings/agents",
				section: "agents",
				label: "Agents",
				icon: <HiOutlineCpuChip className="h-4 w-4" />,
			},
			{
				id: "/settings/terminal",
				section: "terminal",
				label: "Terminal",
				icon: <HiOutlineCommandLine className="h-4 w-4" />,
			},
			{
				id: "/settings/links",
				section: "links",
				label: "Links",
				icon: <HiOutlineLink className="h-4 w-4" />,
			},
			{
				id: "/settings/models",
				section: "models",
				label: "Models",
				icon: <LuBrain className="h-4 w-4" />,
			},
		],
	},
	{
		// (CLOUD-SEVERANCE-P2) What is left of the old "Organization" group is
		// projects, which are local. Members, teams, hosts, integrations, billing
		// and API keys all lived on the cloud API; `getAllowedSectionsForVariant`
		// would drop these rows anyway, but leaving dead entries in the table would
		// invite the next merge to re-link them.
		label: "Projects",
		items: [
			{
				id: "/settings/projects",
				section: "project",
				label: "Projects",
				icon: <HiOutlineFolder className="h-4 w-4" />,
			},
		],
	},
	{
		label: "System",
		items: [
			{
				id: "/settings/permissions",
				section: "permissions",
				label: "Permissions",
				icon: <HiOutlineShieldCheck className="h-4 w-4" />,
				macOnly: true,
			},
			{
				id: "/settings/experimental",
				section: "experimental",
				label: "Experimental",
				icon: <HiOutlineBeaker className="h-4 w-4" />,
			},
		],
	},
];

export function GeneralSettings({ matchCounts }: GeneralSettingsProps) {
	const matchRoute = useMatchRoute();
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	const isMac = platform === "darwin";
	const isV2CloudEnabled = useIsV2CloudEnabled();
	const allowedSections = useMemo(
		() => getAllowedSectionsForVariant(isV2CloudEnabled),
		[isV2CloudEnabled],
	);

	return (
		<>
			{SECTION_GROUPS.map((group, groupIndex) => {
				const platformItems = group.items.filter(
					(item) =>
						(!item.macOnly || isMac) && allowedSections.has(item.section),
				);
				const filteredItems = matchCounts
					? platformItems.filter((item) => (matchCounts[item.section] ?? 0) > 0)
					: platformItems;

				if (filteredItems.length === 0) return null;

				return (
					<div key={group.label} className={cn(groupIndex > 0 && "mt-4")}>
						<h2 className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-[0.1em] px-3 mb-1">
							{group.label}
						</h2>
						<nav className="flex flex-col">
							{filteredItems.map((section) => {
								const isActive = !!matchRoute({
									to: section.id,
									fuzzy: true,
								});
								const count = matchCounts?.[section.section];

								return (
									<Link
										key={section.id}
										to={section.id}
										className={cn(
											"flex items-center gap-3 px-3 py-1.5 text-sm rounded-md transition-colors text-left",
											isActive
												? "bg-accent text-accent-foreground"
												: "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
										)}
									>
										{section.icon}
										<span className="flex-1">{section.label}</span>
										{count !== undefined && count > 0 && (
											<span className="text-xs text-muted-foreground bg-accent/50 px-1.5 py-0.5 rounded">
												{count}
											</span>
										)}
									</Link>
								);
							})}
						</nav>
					</div>
				);
			})}
		</>
	);
}
