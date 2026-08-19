import {
	DropdownMenuCheckboxItem,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@superset/ui/dropdown-menu";
import { BsTerminalPlus } from "react-icons/bs";
import { TbMessageCirclePlus, TbWorld } from "react-icons/tb";
import { HotkeyMenuShortcut } from "renderer/components/HotkeyMenuShortcut";

// (CLOUD-SEVERANCE-P2) The cloud "Chat" entry is gone with its pane — v1.23.0
// removed it upstream too. `onAddChatV3` is the LOCAL chat pane and stays
// optional, but the condition behind it changed: upstream passes it on a
// PostHog flag, this fork passes it only when the user has switched local chat
// on in Experimental settings. Default off, so this menu offers exactly
// Terminal and Browser until they do.
interface AddTabMenuProps {
	onAddTerminal: () => void;
	onAddChatV3?: (() => void) | undefined;
	onAddBrowser: () => void;
	showPresetsBar: boolean;
	onToggleShowPresetsBar: (enabled: boolean) => void;
}

export function AddTabMenu({
	onAddTerminal,
	onAddChatV3,
	onAddBrowser,
	showPresetsBar,
	onToggleShowPresetsBar,
}: AddTabMenuProps) {
	return (
		<>
			<DropdownMenuItem className="gap-2" onClick={onAddTerminal}>
				<BsTerminalPlus className="size-4" />
				<span>Terminal</span>
				<HotkeyMenuShortcut hotkeyId="NEW_GROUP" />
			</DropdownMenuItem>
			{onAddChatV3 && (
				<DropdownMenuItem className="gap-2" onClick={onAddChatV3}>
					<TbMessageCirclePlus className="size-4" />
					<span>Chat</span>
				</DropdownMenuItem>
			)}
			<DropdownMenuItem className="gap-2" onClick={onAddBrowser}>
				<TbWorld className="size-4" />
				<span>Browser</span>
				<HotkeyMenuShortcut hotkeyId="NEW_BROWSER" />
			</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuCheckboxItem
				checked={showPresetsBar}
				onCheckedChange={(checked) => onToggleShowPresetsBar(checked === true)}
				onSelect={(event) => event.preventDefault()}
			>
				Show Preset Bar
			</DropdownMenuCheckboxItem>
		</>
	);
}
