import { createContext, useContext } from "react";
import type { WorkspaceActivityStore } from "./utils/createWorkspaceActivityStore";

export const HostWorkspaceActivityStoreContext =
	createContext<WorkspaceActivityStore | null>(null);

export function useHostWorkspaceActivityStore(): WorkspaceActivityStore {
	const store = useContext(HostWorkspaceActivityStoreContext);
	if (!store) {
		throw new Error(
			"useHostWorkspaceActivityStore must be used within HostWorkspacesProvider",
		);
	}
	return store;
}
