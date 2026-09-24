import { FORK_CHAT_V3_DISABLED } from "renderer/fork-disabled-features";
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

// (CLOUD-SEVERANCE-P2)
interface LocalChatState {
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

/** Single read path for the local chat pane switch. (FORK-CHAT-V3-OFF) */
export function useLocalChatEnabled(): boolean {
	return !FORK_CHAT_V3_DISABLED;
}
