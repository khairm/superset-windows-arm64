import {
	BeakerIcon,
	BellIcon,
	BookmarkIcon,
	CpuIcon,
	FileTextIcon,
	FolderIcon,
	GitBranchIcon,
	KeyboardIcon,
	type LucideIcon,
	PaletteIcon,
	ShieldIcon,
	SlidersIcon,
	TerminalIcon,
	WrenchIcon,
} from "lucide-react";
import type { Command } from "../../core/types";

interface SettingsTab {
	id: string;
	title: string;
	path: string;
	icon: LucideIcon;
	keywords?: string[];
}

// (CLOUD-SEVERANCE-P2) Account, Integrations, Organization, Teams, Hosts,
// Billing, API keys and Security are absent on purpose — those pages have no
// data source left, and the palette is the one place a user can reach a
// settings page without seeing it in the sidebar first.
const TABS: SettingsTab[] = [
	{
		id: "appearance",
		title: "Appearance",
		path: "/settings/appearance",
		icon: PaletteIcon,
		keywords: ["theme", "color"],
	},
	{
		id: "behavior",
		title: "Behavior",
		path: "/settings/behavior",
		icon: SlidersIcon,
	},
	{
		id: "models",
		title: "Models",
		path: "/settings/models",
		icon: CpuIcon,
		keywords: ["ai", "llm"],
	},
	{
		id: "terminal",
		title: "Terminal",
		path: "/settings/terminal",
		icon: TerminalIcon,
	},
	{ id: "git", title: "Git", path: "/settings/git", icon: GitBranchIcon },
	{
		id: "experimental",
		title: "Experimental",
		path: "/settings/experimental",
		icon: BeakerIcon,
	},
	{
		id: "keyboard",
		title: "Keyboard shortcuts",
		path: "/settings/keyboard",
		icon: KeyboardIcon,
		keywords: ["hotkeys", "shortcuts"],
	},
	{ id: "links", title: "Links", path: "/settings/links", icon: BookmarkIcon },
	{
		id: "permissions",
		title: "Permissions",
		path: "/settings/permissions",
		icon: ShieldIcon,
	},
	{
		id: "projects",
		title: "Projects",
		path: "/settings/projects",
		icon: FolderIcon,
	},
	{
		id: "ringtones",
		title: "Ringtones",
		path: "/settings/ringtones",
		icon: BellIcon,
	},
	{ id: "agents", title: "Agents", path: "/settings/agents", icon: WrenchIcon },
	{
		id: "presets",
		title: "Presets",
		path: "/settings/presets",
		icon: FileTextIcon,
	},
];

function tabToCommand(tab: SettingsTab): Command {
	return {
		id: `settings.${tab.id}`,
		title: tab.title,
		section: "navigation",
		icon: tab.icon,
		keywords: tab.keywords,
		run: (ctx) => ctx.navigate(tab.path),
	};
}

export const settingsTabCommands = TABS.map(tabToCommand);
