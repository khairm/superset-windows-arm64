import { useWorkspace } from "renderer/routes/_authenticated/_dashboard/v2-workspace/providers/WorkspaceProvider";
import {
	getStatusTooltip,
	StatusIndicator,
} from "renderer/screens/main/components/StatusIndicator";
import {
	useV2SourcesDisplayStatus,
	type V2NotificationSourceInput,
} from "renderer/stores/v2-notifications";

interface V2NotificationStatusIndicatorProps {
	sources: Iterable<V2NotificationSourceInput>;
	className?: string;
}

export function V2NotificationStatusIndicator({
	sources,
	className,
}: V2NotificationStatusIndicatorProps) {
	const { workspace } = useWorkspace();
	// (AY/BA) Display status, not raw agent status — the tab / pane-header dot
	// must also show the shell-running / background-running blue the workspace
	// rollup shows (same precedence merge).
	const status = useV2SourcesDisplayStatus(workspace.id, sources);
	if (!status) return null;
	return (
		<span title={getStatusTooltip(status)}>
			<StatusIndicator status={status} className={className} />
		</span>
	);
}
