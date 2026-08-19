import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

/**
 * (CLOUD-SEVERANCE-P2) Opt-in switch for the LOCAL chat pane.
 *
 * Two chat stacks shipped upstream and only one of them survived severance.
 * The cloud pane talked to the Superset chat service and is gone. This one —
 * "chat-v3" in the pane registry — spawns the agent CLIs already installed on
 * this machine and keeps its sessions in local SQLite, so it is one of the very
 * few cloud-era surfaces that still genuinely works.
 *
 * It was dead for a different reason: upstream gated it on a PostHog feature
 * flag, and phase 1 killed PostHog, which pinned the flag false forever. This
 * store replaces that gate with something the user owns.
 *
 * DEFAULT OFF, deliberately. Nobody who has not gone looking for it should get
 * a new pane type appearing in their tab menu after an update.
 *
 * PERSISTENCE (see apps/desktop/AGENTS.md). A fixed-size singleton boolean
 * under one localStorage key — it cannot grow, it is not entity-keyed, and so
 * it needs no reconciliation or TTL. If the local chat pane is ever removed,
 * move `local-chat` to DEAD_KEYS in the same change that deletes the writer.
 * Modelled on `inline-workspace-ports.ts`, the other Experimental toggle that
 * lives out here rather than in the local-db settings table — adding a column
 * there is a schema change, and this fork does not make those unasked.
 */
interface LocalChatState {
	/** When false the `chat-v3` pane kind is never registered at all. */
	enabled: boolean;
	setEnabled: (enabled: boolean) => void;
}

export const useLocalChatStore = create<LocalChatState>()(
	devtools(
		persist(
			(set) => ({
				enabled: false,
				setEnabled: (enabled) => set({ enabled }),
			}),
			{ name: "local-chat" },
		),
		{ name: "LocalChatStore" },
	),
);

/** Single read path for the local chat pane switch. */
export function useLocalChatEnabled(): boolean {
	return useLocalChatStore((state) => state.enabled);
}
