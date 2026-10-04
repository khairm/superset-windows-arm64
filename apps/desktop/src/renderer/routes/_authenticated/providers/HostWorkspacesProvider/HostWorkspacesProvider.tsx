import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useState,
} from "react";
import {
	type UseHostWorkspacesResult,
	useHostWorkspacesSourceWithActivity,
} from "renderer/hooks/host-workspaces/useHostWorkspaces";
import { HostWorkspaceActivityStoreContext } from "./hostWorkspaceActivityStoreContext";
import { createWorkspaceActivityStore } from "./utils/createWorkspaceActivityStore";

const HostWorkspacesContext = createContext<UseHostWorkspacesResult | null>(
	null,
);

/**
 * Runs the per-host workspace fan-out once (queries, event subscriptions,
 * IndexedDB snapshots) and shares the merged result — consumers must not
 * call the source hook unscoped or every call site would duplicate the
 * fan-out; single-host scoped calls are fine (they share query keys).
 *
 * (ACTIVITY-SPLIT) Agent activity travels in a separate store whose context
 * value never changes, so an activity tick re-renders no workspace consumer.
 */
export function HostWorkspacesProvider({ children }: { children: ReactNode }) {
	const { result, activityById } = useHostWorkspacesSourceWithActivity();
	const [activityStore] = useState(() =>
		createWorkspaceActivityStore(activityById),
	);
	useLayoutEffect(() => {
		activityStore.set(activityById);
	}, [activityStore, activityById]);
	return (
		<HostWorkspaceActivityStoreContext.Provider value={activityStore}>
			<HostWorkspacesContext.Provider value={result}>
				{children}
			</HostWorkspacesContext.Provider>
		</HostWorkspaceActivityStoreContext.Provider>
	);
}

/**
 * The workspace read path: every known host's workspaces, merged — the
 * local host serves live even offline; a remote host contributes nothing
 * until it answers.
 */
export function useHostWorkspaces(): UseHostWorkspacesResult {
	const value = useContext(HostWorkspacesContext);
	if (!value) {
		throw new Error(
			"useHostWorkspaces must be used within HostWorkspacesProvider",
		);
	}
	return value;
}
