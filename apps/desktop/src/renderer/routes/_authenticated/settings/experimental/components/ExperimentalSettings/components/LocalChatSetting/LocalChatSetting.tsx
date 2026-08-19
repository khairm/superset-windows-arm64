import { Label } from "@superset/ui/label";
import { Switch } from "@superset/ui/switch";
import { HighlightText } from "renderer/routes/_authenticated/settings/components/HighlightText";
import { useLocalChatEnabled, useLocalChatStore } from "renderer/stores/local-chat";
import { useSettingsSearchQuery } from "renderer/stores/settings-state";

/**
 * (CLOUD-SEVERANCE-P2) The switch for the local chat pane.
 *
 * Worth being precise in the copy, because "chat" in this app used to mean the
 * hosted Superset agent and that is exactly what severance removed. This one
 * runs the agent CLIs the user has already installed and keeps its transcripts
 * on this machine, so the description says so plainly rather than leaving the
 * user to wonder whether switching it on quietly reopens a line to the cloud.
 *
 * Self-contained (owns its store read and write) so it can be lifted out whole
 * if the pane is ever dropped — at which point `local-chat` goes to DEAD_KEYS.
 */
export function LocalChatSetting() {
	const searchQuery = useSettingsSearchQuery();
	const enabled = useLocalChatEnabled();
	const setEnabled = useLocalChatStore((state) => state.setEnabled);

	return (
		<div className="flex items-center justify-between gap-6">
			<div className="min-w-0 flex-1 space-y-0.5">
				<Label htmlFor="local-chat" className="text-sm font-medium">
					<HighlightText text="Local chat pane" query={searchQuery} />
				</Label>
				<p className="text-xs text-muted-foreground">
					<HighlightText
						text="Adds a Chat pane to the tab menu. It drives the agent CLIs already installed on this machine and keeps its sessions on this device — nothing is sent to Superset."
						query={searchQuery}
					/>
				</p>
			</div>
			<Switch id="local-chat" checked={enabled} onCheckedChange={setEnabled} />
		</div>
	);
}
