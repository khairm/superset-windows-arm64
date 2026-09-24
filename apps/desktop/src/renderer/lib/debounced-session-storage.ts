import type { PersistStorage, StorageValue } from "zustand/middleware";

const TRAILING_FLUSH_MS = 250;
const MAXIMUM_FLUSH_DELAY_MS = 1_000;

interface FlushLifecycle {
	window: {
		addEventListener(
			event: "pagehide" | "beforeunload",
			listener: () => void,
		): void;
	};
	document: {
		addEventListener(event: "visibilitychange", listener: () => void): void;
		readonly visibilityState: DocumentVisibilityState;
	};
}

// (NOTIF-STORE-DEBOUNCE) Writes newer than the last flush are lost if the
// renderer dies without a pagehide/beforeunload/hidden event, so the retained
// envelope is at most MAXIMUM_FLUSH_DELAY_MS behind the store.
export function createDebouncedSessionStorage<S>(
	getStorage: () => Storage,
	lifecycle: FlushLifecycle,
): PersistStorage<S> {
	const pending = new Map<string, StorageValue<S>>();
	let trailingTimer: ReturnType<typeof setTimeout> | undefined;
	let maximumTimer: ReturnType<typeof setTimeout> | undefined;

	function cancelTimers(): void {
		clearTimeout(trailingTimer);
		clearTimeout(maximumTimer);
		trailingTimer = undefined;
		maximumTimer = undefined;
	}

	function flush(): void {
		cancelTimers();
		for (const [name, value] of pending) {
			getStorage().setItem(name, JSON.stringify(value));
			pending.delete(name);
		}
	}

	lifecycle.window.addEventListener("pagehide", flush);
	lifecycle.window.addEventListener("beforeunload", flush);
	lifecycle.document.addEventListener("visibilitychange", () => {
		if (lifecycle.document.visibilityState === "hidden") flush();
	});

	return {
		getItem(name) {
			const value = pending.get(name);
			if (value !== undefined) return value;
			const stored = getStorage().getItem(name);
			return stored === null ? null : JSON.parse(stored);
		},
		setItem(name, value) {
			pending.set(name, value);
			clearTimeout(trailingTimer);
			trailingTimer = setTimeout(flush, TRAILING_FLUSH_MS);
			if (maximumTimer === undefined)
				maximumTimer = setTimeout(flush, MAXIMUM_FLUSH_DELAY_MS);
		},
		removeItem(name) {
			pending.delete(name);
			if (pending.size === 0) cancelTimers();
			getStorage().removeItem(name);
		},
	};
}
