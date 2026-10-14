import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import { Switch } from "@superset/ui/switch";
import { useIsV2OnlyUser } from "renderer/hooks/useIsV2CloudEnabled";
import { HighlightText } from "renderer/routes/_authenticated/settings/components/HighlightText";
import { useSettingsSearchQuery } from "renderer/stores/settings-state";
import { useOpenV1ImportModal } from "renderer/stores/v1-import-modal";
import {
	useWorkspaceAgentsRowEnabled,
	useWorkspaceAgentsRowStore,
} from "renderer/stores/workspace-agents-row";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";
// (COMPANION-PAIRING-ENTRY) the seam that reaches the fork-only pairing surface.
import { CompanionPairingSetting } from "./components/CompanionPairingSetting";
import { WaitForSetupBeforeAgentSetting } from "./components/WaitForSetupBeforeAgentSetting";

interface ExperimentalSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

export function ExperimentalSettings({
	visibleItems,
}: ExperimentalSettingsProps) {
	const { t } = useLingui();
	const searchQuery = useSettingsSearchQuery();
	const showV1Migration = isItemVisible(
		SETTING_ITEM_ID.EXPERIMENTAL_V1_MIGRATION,
		visibleItems,
	);
	const showWorkspaceAgents = isItemVisible(
		SETTING_ITEM_ID.EXPERIMENTAL_WORKSPACE_AGENTS,
		visibleItems,
	);
	// (COMPANION-PAIRING-ENTRY)
	const showCompanionPairing = isItemVisible(
		SETTING_ITEM_ID.EXPERIMENTAL_COMPANION_PAIRING,
		visibleItems,
	);
	const showWaitForSetupBeforeAgent = isItemVisible(
		SETTING_ITEM_ID.EXPERIMENTAL_WAIT_FOR_SETUP_BEFORE_AGENT,
		visibleItems,
	);
	const isV2OnlyUser = useIsV2OnlyUser();
	const openV1ImportModal = useOpenV1ImportModal();
	const workspaceAgentsEnabled = useWorkspaceAgentsRowEnabled();
	const setWorkspaceAgentsEnabled = useWorkspaceAgentsRowStore(
		(state) => state.setEnabled,
	);

	return (
		<div className="p-6 max-w-4xl w-full mx-auto">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">
					<Trans>Experimental</Trans>
				</h2>
				<p className="text-sm text-muted-foreground mt-1">
					<Trans>Try early access features and previews.</Trans>
				</p>
			</div>

			<div className="space-y-6">
				{showV1Migration && !isV2OnlyUser && (
					<div className="flex items-center justify-between gap-6">
						<div className="min-w-0 flex-1 space-y-0.5">
							<Label className="text-sm font-medium">
								<HighlightText
									text={t({
										message: "Import from v1",
									})}
									query={searchQuery}
								/>
							</Label>
							<p className="text-xs text-muted-foreground">
								<HighlightText
									text={t({
										message:
											"Bring v1 projects, workspaces, and terminal scripts over to v2. Each item is imported individually and can be retried.",
									})}
									query={searchQuery}
								/>
							</p>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => openV1ImportModal()}
							className="shrink-0"
						>
							<Trans>Open importer</Trans>
						</Button>
					</div>
				)}
				{/* (FORK-PORTS-OFF) */}
				{showWorkspaceAgents && (
					<div className="flex items-center justify-between gap-6">
						<div className="min-w-0 flex-1 space-y-0.5">
							<Label htmlFor="workspace-agents" className="text-sm font-medium">
								<HighlightText
									text={t({
										message: "Workspace agents",
									})}
									query={searchQuery}
								/>
							</Label>
							<p className="text-xs text-muted-foreground">
								<HighlightText
									text={t({
										message:
											"Show running agents under each workspace in the sidebar, with their live status.",
									})}
									query={searchQuery}
								/>
							</p>
						</div>
						<Switch
							id="workspace-agents"
							checked={workspaceAgentsEnabled}
							onCheckedChange={setWorkspaceAgentsEnabled}
						/>
					</div>
				)}
				{showWaitForSetupBeforeAgent && <WaitForSetupBeforeAgentSetting />}
				{/* (COMPANION-PAIRING-ENTRY) */}
				{showCompanionPairing && <CompanionPairingSetting />}
				{/* (CLOUD-SEVERANCE-P2) (FORK-CHAT-V3-OFF) */}
			</div>
		</div>
	);
}
