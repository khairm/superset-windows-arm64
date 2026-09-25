// (FORK-BROWSER-OFF) (FORK-CHAT-V3-OFF) (FORK-PAGE-WATCH-OFF) (FORK-PORTS-OFF)
// Re-enabling one of these needs more than flipping its const: the browser and
// chat callers were REMOVED from this fork (addBrowserTab, onAddBrowser,
// LocalChatSetting) and have to be restored from upstream first.
export const FORK_BROWSER_PANES_DISABLED: boolean = true;
export const FORK_CHAT_V3_DISABLED: boolean = true;
export const FORK_PAGE_WATCH_DISABLED: boolean = true;
export const FORK_PORT_SCAN_DISABLED: boolean = true;
