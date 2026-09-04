import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	BeakerIcon,
	BellIcon,
	BookmarkIcon,
	ChartBarIcon,
	CpuIcon,
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
	title: MessageDescriptor;
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
		title: msg({
			message: "Appearance",
		}),
		path: "/settings/appearance",
		icon: PaletteIcon,
		keywords: ["theme", "color"],
	},
	{
		id: "behavior",
		title: msg({
			message: "Behavior",
		}),
		path: "/settings/behavior",
		icon: SlidersIcon,
	},
	{
		id: "models",
		title: msg({ message: "Models" }),
		path: "/settings/models",
		icon: CpuIcon,
		keywords: ["ai", "llm"],
	},
	{
		id: "terminal",
		title: msg({
			message: "Terminal",
		}),
		path: "/settings/terminal",
		icon: TerminalIcon,
		keywords: ["terminal scripts", "scripts", "presets", "commands"],
	},
	{
		id: "git",
		title: msg({ message: "Git" }),
		path: "/settings/git",
		icon: GitBranchIcon,
	},
	{
		id: "experimental",
		title: msg({
			message: "Experimental",
		}),
		path: "/settings/experimental",
		icon: BeakerIcon,
	},
	{
		id: "keyboard",
		title: msg({
			message: "Keyboard shortcuts",
		}),
		path: "/settings/keyboard",
		icon: KeyboardIcon,
		keywords: ["hotkeys", "shortcuts"],
	},
	{
		id: "links",
		title: msg({ message: "Links" }),
		path: "/settings/links",
		icon: BookmarkIcon,
	},
	{
		id: "permissions",
		title: msg({
			message: "Permissions",
		}),
		path: "/settings/permissions",
		icon: ShieldIcon,
	},
	{
		id: "projects",
		title: msg({
			message: "Projects",
		}),
		path: "/settings/projects",
		icon: FolderIcon,
	},
	{
		id: "ringtones",
		title: msg({
			message: "Ringtones",
		}),
		path: "/settings/ringtones",
		icon: BellIcon,
	},
	{
		id: "usage",
		title: msg({ message: "Usage" }),
		path: "/settings/usage",
		icon: ChartBarIcon,
		keywords: ["tokens", "cost", "quota", "cpu", "memory", "resources"],
	},
	{
		id: "agents",
		title: msg({ message: "Agents" }),
		path: "/settings/agents",
		icon: WrenchIcon,
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
