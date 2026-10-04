import { createSharedTicker } from "./createSharedTicker";

export const spinnerTicker = createSharedTicker(80);
export const redPingTicker = createSharedTicker(30_000);
export const snoozeTicker = createSharedTicker(60_000);
