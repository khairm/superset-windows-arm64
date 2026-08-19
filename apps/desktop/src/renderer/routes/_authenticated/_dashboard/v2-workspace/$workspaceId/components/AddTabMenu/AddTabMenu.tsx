import {
	DropdownMenuCheckboxItem,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@superset/ui/dropdown-menu";
import { BsTerminalPlus } from "react-icons/bs";
import { TbMessageCirclePlus, TbWorld } from "react-icons/tb";
import { HotkeyMenuShortcut } from "renderer/components/HotkeyMenuShortcut";

// (CLOUD-SEVERANCE-P2) The cloud "Chat" entry is gone with its pane. `onAddChat`
// is the LOCAL chat pane and is optional: the workspace only passes it when the
// user has switched local chat on in Experimental settings, so by default this
// menu offers exactly Terminal and Browser as it does today.
interface AddTabMenuProps {
	onAddTerminal: () => void;
	onAddChat?: (() => void) | undefined;
	onAddBrowser: () => void;
	showPresetsBar: boolean;
	onToggleShowPresetsBar: (enabled: boolean) => void;
}

export function AddTabMenu({
	onAddTerminal,
	onAddChat,
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
			{onAddChat && (
				<DropdownMenuItem className="gap-2" onClick={onAddChat}>
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
