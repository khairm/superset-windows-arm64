// (FORK-BROWSER-OFF) (FORK-CHAT-V3-OFF) (FORK-PAGE-WATCH-OFF) (FORK-PORTS-OFF)
// (FORK-PRS-OFF)
// Re-enabling browser panes or chat needs more than flipping its const: their
// callers were REMOVED from this fork (addBrowserTab, onAddBrowser,
// LocalChatSetting) and have to be restored from upstream first. Pull requests
// are flip-only: setting their const to false re-enables them.
export const FORK_BROWSER_PANES_DISABLED: boolean = true;
export const FORK_CHAT_V3_DISABLED: boolean = true;
export const FORK_PAGE_WATCH_DISABLED: boolean = true;
export const FORK_PORT_SCAN_DISABLED: boolean = true;
export const FORK_PULL_REQUESTS_DISABLED: boolean = true;
