import { describe, expect, it } from "bun:test";
import {
	type ActiveAgent,
	type KeepAwakeLogger,
	KeepAwakeManager,
	type PowerSaveBlockerLike,
} from "./keep-awake";

const silentLogger: KeepAwakeLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

interface FakeBlocker extends PowerSaveBlockerLike {
	refuse: boolean;
	sticky: boolean;
}

function fakeBlocker(): { api: FakeBlocker; calls: string[] } {
	const started = new Set<number>();
	const calls: string[] = [];
	let nextId = 1;
	const api: FakeBlocker = {
		refuse: false,
		sticky: false,
		start(type) {
			calls.push(`start:${type}`);
			const id = nextId++;
			if (!api.refuse) started.add(id);
			return id;
		},
		stop(id) {
			calls.push(`stop:${id}`);
			if (!api.sticky) started.delete(id);
		},
		isStarted(id) {
			return started.has(id);
		},
	};
	return { api, calls };
}

function agent(terminalId: string, lastEventType: string): ActiveAgent {
	return { terminalId, lastEventType };
}

describe("(KEEP-AWAKE) KeepAwakeManager", () => {
	it("acquires on the first active agent and holds prevent-app-suspension", () => {
		const blocker = fakeBlocker();
		const m = new KeepAwakeManager({
			powerSaveBlocker: blocker.api,
			logger: silentLogger,
		});

		expect(m.update([agent("t1", "Start")])).toBe("acquired");
		expect(blocker.calls).toEqual(["start:prevent-app-suspension"]);
		const state = m.getState();
		expect(state.held).toBe(true);
		expect(state.blockerType).toBe("prevent-app-suspension");
		expect(state.blockerId).not.toBeNull();
		expect(state.failure).toBeNull();
	});

	it("is idempotent while the same work continues", () => {
		const blocker = fakeBlocker();
		const m = new KeepAwakeManager({
			powerSaveBlocker: blocker.api,
			logger: silentLogger,
		});

		m.update([agent("t1", "Start")]);
		expect(m.update([agent("t1", "Start")])).toBe("unchanged");
		expect(m.update([agent("t1", "PermissionRequest")])).toBe("unchanged");
		expect(blocker.calls).toEqual(["start:prevent-app-suspension"]);
	});

	it("holds across a changing reason set without restarting the request", () => {
		const blocker = fakeBlocker();
		const m = new KeepAwakeManager({
			powerSaveBlocker: blocker.api,
			logger: silentLogger,
		});

		m.update([agent("t1", "Start")]);
		expect(m.update([agent("t2", "PermissionRequest")])).toBe("unchanged");
		expect(m.getState().held).toBe(true);
		expect(blocker.calls).toEqual(["start:prevent-app-suspension"]);
	});

	it("releases only when nothing is left", () => {
		const blocker = fakeBlocker();
		const m = new KeepAwakeManager({
			powerSaveBlocker: blocker.api,
			logger: silentLogger,
		});

		m.update([agent("t1", "Start"), agent("t2", "SubagentActive")]);
		expect(m.update([agent("t2", "SubagentActive")])).toBe("unchanged");
		expect(m.update([])).toBe("released");
		expect(m.getState().held).toBe(false);
		expect(m.getState().heldSinceMs).toBeNull();
		expect(blocker.calls).toEqual(["start:prevent-app-suspension", "stop:1"]);
	});

	it("re-acquires after a release", () => {
		const blocker = fakeBlocker();
		const m = new KeepAwakeManager({
			powerSaveBlocker: blocker.api,
			logger: silentLogger,
		});

		m.update([agent("t1", "Start")]);
		m.update([]);
		expect(m.update([agent("t1", "Start")])).toBe("acquired");
		expect(m.getState().held).toBe(true);
	});

	it("fails LOUD when the OS refuses the request", () => {
		const blocker = fakeBlocker();
		blocker.api.refuse = true;
		const errors: string[] = [];
		const m = new KeepAwakeManager({
			powerSaveBlocker: blocker.api,
			logger: { ...silentLogger, error: (message) => errors.push(message) },
		});

		m.update([agent("t1", "Start")]);
		const state = m.getState();
		expect(state.held).toBe(false);
		expect(state.blockerId).toBeNull();
		expect(state.failure).toContain("isStarted");
		expect(errors.at(-1)).toContain("refused the power request");
	});

	it("fails LOUD when stop does not clear the request", () => {
		const blocker = fakeBlocker();
		const m = new KeepAwakeManager({
			powerSaveBlocker: blocker.api,
			logger: silentLogger,
		});

		m.update([agent("t1", "Start")]);
		blocker.api.sticky = true;
		m.update([]);
		expect(m.getState().failure).toContain("did not clear the request");
	});

	it("dispose releases a held request and is safe when nothing is held", () => {
		const blocker = fakeBlocker();
		const m = new KeepAwakeManager({
			powerSaveBlocker: blocker.api,
			logger: silentLogger,
		});

		m.dispose();
		expect(blocker.calls).toEqual([]);
		m.update([agent("t1", "Start")]);
		m.dispose();
		expect(blocker.calls).toEqual(["start:prevent-app-suspension", "stop:1"]);
		expect(m.getState().held).toBe(false);
	});
});
