import { PortManager } from "@superset/port-scanner";
import { treeKillWithEscalation } from "../tree-kill";

// (FORK-PORTS-OFF)
export const FORK_PORT_SCAN_DISABLED: boolean = true;

export const portManager = new PortManager({
	disabled: FORK_PORT_SCAN_DISABLED,
	killFn: treeKillWithEscalation,
});
