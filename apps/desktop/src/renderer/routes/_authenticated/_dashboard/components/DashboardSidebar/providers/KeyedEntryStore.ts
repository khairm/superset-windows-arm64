import { useCallback, useSyncExternalStore } from "react";

export class KeyedEntryStore<Entry> {
	private entries = new Map<string, Entry>();
	private lastAppliedEntries: ReadonlyMap<string, Entry> | null = null;
	private listeners = new Map<string, Set<() => void>>();
	private pendingChanged = new Set<string>();

	constructor(
		private readonly emptyEntry: Entry,
		private readonly entriesEqual: (left: Entry, right: Entry) => boolean,
	) {}

	get(key: string): Entry {
		return this.entries.get(key) ?? this.emptyEntry;
	}

	subscribe(key: string, listener: () => void): () => void {
		const listeners = this.listeners.get(key) ?? new Set<() => void>();
		listeners.add(listener);
		this.listeners.set(key, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(key);
		};
	}

	replaceEntries(next: ReadonlyMap<string, Entry>): void {
		if (next === this.entries || next === this.lastAppliedEntries) return;
		this.lastAppliedEntries = next;

		const stabilized = new Map<string, Entry>();
		for (const [key, candidate] of next) {
			if (this.entries.has(key)) {
				const previous = this.entries.get(key) as Entry;
				if (this.entriesEqual(previous, candidate)) {
					stabilized.set(key, previous);
					continue;
				}
			}
			stabilized.set(key, candidate);
			this.pendingChanged.add(key);
		}
		for (const key of this.entries.keys()) {
			if (!next.has(key)) this.pendingChanged.add(key);
		}
		this.entries = stabilized;
	}

	flushNotifications(): void {
		if (this.pendingChanged.size === 0) return;
		const changed = this.pendingChanged;
		this.pendingChanged = new Set();
		for (const key of changed) {
			for (const listener of this.listeners.get(key) ?? []) listener();
		}
	}
}

export function useKeyedEntry<Entry>(
	store: KeyedEntryStore<Entry>,
	key: string,
): Entry {
	return useSyncExternalStore(
		useCallback((listener) => store.subscribe(key, listener), [store, key]),
		useCallback(() => store.get(key), [store, key]),
	);
}
