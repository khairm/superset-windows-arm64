import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
} from "bun:test";
import { createDebouncedSessionStorage } from "./debounced-session-storage";

// (NOTIF-STORE-DEBOUNCE)
function fixture() {
	const values = new Map<string, string>();
	const storage: Storage = {
		get length() {
			return values.size;
		},
		key: (index) => [...values.keys()][index] ?? null,
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		removeItem: mock((key: string) => {
			values.delete(key);
		}),
		setItem: mock((key: string, value: string) => {
			values.set(key, value);
		}),
	};
	const windowEvents = new Map<string, () => void>();
	const documentEvents = new Map<string, () => void>();
	const document = {
		visibilityState: "visible" as DocumentVisibilityState,
		addEventListener: (event: string, callback: () => void): void => {
			documentEvents.set(event, callback);
		},
	};
	const adapter = createDebouncedSessionStorage<{ count: number }>(
		() => storage,
		{
			window: {
				addEventListener: (event: string, callback: () => void): void => {
					windowEvents.set(event, callback);
				},
			},
			document,
		},
	);
	function emit(event: string): void {
		const listener =
			event === "visibilitychange"
				? documentEvents.get(event)
				: windowEvents.get(event);
		if (!listener) throw new Error(`Missing listener for ${event}`);
		listener();
	}
	return { adapter, storage, values, document, emit };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("debounced session storage", () => {
	it("hydrates synchronously and reads pending envelopes without serializing", () => {
		const { adapter, values, storage } = fixture();
		values.set("dots", JSON.stringify({ state: { count: 1 }, version: 3 }));
		expect(adapter.getItem("dots")).toEqual({
			state: { count: 1 },
			version: 3,
		});
		const toJSON = mock(() => ({ count: 4 }));
		const envelope = { state: { count: 2, toJSON }, version: 3 };
		adapter.setItem("dots", envelope);
		expect(adapter.getItem("dots")).toBe(envelope);
		expect(toJSON).not.toHaveBeenCalled();
		jest.advanceTimersByTime(249);
		expect(storage.setItem).not.toHaveBeenCalled();
		jest.advanceTimersByTime(1);
		expect(toJSON).toHaveBeenCalledTimes(1);
		expect(adapter.getItem("dots")).toEqual({
			state: { count: 4 },
			version: 3,
		});
	});

	it("coalesces to the latest envelope at the trailing edge", () => {
		const { adapter, storage } = fixture();
		adapter.setItem("dots", { state: { count: 1 } });
		jest.advanceTimersByTime(200);
		adapter.setItem("dots", { state: { count: 2 } });
		jest.advanceTimersByTime(249);
		expect(storage.setItem).not.toHaveBeenCalled();
		jest.advanceTimersByTime(1);
		expect(storage.setItem).toHaveBeenCalledTimes(1);
		expect(adapter.getItem("dots")).toEqual({ state: { count: 2 } });
		jest.advanceTimersByTime(1_000);
		expect(storage.setItem).toHaveBeenCalledTimes(1);
	});

	it("flushes continuous writes at one second and starts a fresh bound", () => {
		const { adapter, storage } = fixture();
		for (let count = 0; count < 5; count++) {
			adapter.setItem("dots", { state: { count } });
			jest.advanceTimersByTime(200);
		}
		expect(storage.setItem).toHaveBeenCalledTimes(1);
		expect(adapter.getItem("dots")).toEqual({ state: { count: 4 } });
		adapter.setItem("dots", { state: { count: 5 } });
		jest.advanceTimersByTime(250);
		expect(storage.setItem).toHaveBeenCalledTimes(2);
	});

	it.each([
		"pagehide",
		"beforeunload",
		"visibilitychange",
	])("flushes synchronously on %s", (event) => {
		const { adapter, storage, document, emit } = fixture();
		adapter.setItem("dots", { state: { count: 1 } });
		if (event === "visibilitychange") {
			emit(event);
			expect(storage.setItem).not.toHaveBeenCalled();
			document.visibilityState = "hidden";
			emit(event);
		} else emit(event);
		expect(storage.setItem).toHaveBeenCalledTimes(1);
		jest.advanceTimersByTime(1_000);
		expect(storage.setItem).toHaveBeenCalledTimes(1);
	});

	it("removes pending and durable data without resurrecting it", () => {
		const { adapter, values, storage } = fixture();
		values.set("dots", JSON.stringify({ state: { count: 1 } }));
		adapter.setItem("dots", { state: { count: 2 } });
		adapter.removeItem("dots");
		expect(adapter.getItem("dots")).toBeNull();
		jest.advanceTimersByTime(1_000);
		expect(storage.setItem).not.toHaveBeenCalled();
	});

	it("removing one key preserves the other pending key", () => {
		const { adapter, storage } = fixture();
		adapter.setItem("dots", { state: { count: 1 } });
		adapter.setItem("other", { state: { count: 2 } });
		adapter.removeItem("dots");
		jest.advanceTimersByTime(250);
		expect(storage.setItem).toHaveBeenCalledTimes(1);
		expect(adapter.getItem("dots")).toBeNull();
		expect(adapter.getItem("other")).toEqual({ state: { count: 2 } });
	});

	it("throws write failures and retains the pending envelope for retry", () => {
		const { adapter, storage, emit } = fixture();
		const value = { state: { count: 1 } };
		adapter.setItem("dots", value);
		storage.setItem = mock(() => {
			throw new Error("quota exceeded");
		});
		expect(() => emit("pagehide")).toThrow("quota exceeded");
		expect(adapter.getItem("dots")).toBe(value);
		storage.setItem = mock(() => {});
		emit("pagehide");
		expect(storage.setItem).toHaveBeenCalledTimes(1);
	});

	it("surfaces timer write failures without dropping the pending value", () => {
		const { adapter, storage } = fixture();
		const value = { state: { count: 1 } };
		adapter.setItem("dots", value);
		storage.setItem = mock(() => {
			throw new Error("write failed");
		});
		expect(() => jest.advanceTimersByTime(250)).toThrow("write failed");
		expect(adapter.getItem("dots")).toBe(value);
	});

	it("surfaces serialization failures at flush", () => {
		const { adapter, emit } = fixture();
		const value = {
			state: {
				count: 1,
				toJSON() {
					throw new Error("serialize failed");
				},
			},
		};
		adapter.setItem("dots", value);
		expect(() => emit("beforeunload")).toThrow("serialize failed");
		expect(adapter.getItem("dots")).toBe(value);
	});

	it("does not hide malformed stored JSON", () => {
		const { adapter, values } = fixture();
		values.set("dots", "invalid");
		expect(() => adapter.getItem("dots")).toThrow();
	});
});
