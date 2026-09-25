import { PortManager } from "@superset/port-scanner";
// (FORK-PORTS-OFF)
import { FORK_PORT_SCAN_DISABLED } from "@superset/shared/fork-disabled-features";
import { treeKillWithEscalation } from "./tree-kill.ts";

export const portManager = new PortManager({
	disabled: FORK_PORT_SCAN_DISABLED,
	killFn: treeKillWithEscalation,
});
