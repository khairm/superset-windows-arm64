import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type BasicScenario, createBasicScenario } from "../helpers/scenarios";
import { seedTerminalSession } from "../helpers/seed";

describe("notifications.hook integration", () => {
	let scenario: BasicScenario;

	beforeEach(async () => {
		scenario = await createBasicScenario();
	});

	afterEach(async () => {
		await scenario?.dispose();
	});

	test("ignores unknown event types without authentication", async () => {
		const result =
			await scenario.host.unauthenticatedTrpc.notifications.hook.mutate({
				eventType: "garbage",
				terminalId: "terminal-1",
			});
		expect(result).toEqual({
			success: true,
			ignored: true,
			reason: "unmapped-event-type",
		});
	});

	test("ignores hook with missing terminalId", async () => {
		const result =
			await scenario.host.unauthenticatedTrpc.notifications.hook.mutate({
				eventType: "Stop",
			});
		expect(result).toEqual({
			success: true,
			ignored: true,
			reason: "no-terminal-id",
		});
	});

	test("ignores hook for unknown terminalId", async () => {
		const result =
			await scenario.host.unauthenticatedTrpc.notifications.hook.mutate({
				eventType: "Stop",
				terminalId: "no-such-terminal",
			});
		// (DISPOSE-LIMBO) Still a 200 — a non-2xx makes the bash hook fall
		// through to the legacy Electron path — but the body names the
		// invariant violation.
		expect(result).toEqual({
			success: true,
			ignored: true,
			reason: "unknown-terminal",
		});
	});

	test("broadcasts when terminal session resolves to a workspace", async () => {
		const { id: terminalId } = seedTerminalSession(scenario.host, {
			id: randomUUID(),
			originWorkspaceId: scenario.workspaceId,
		});

		const result =
			await scenario.host.unauthenticatedTrpc.notifications.hook.mutate({
				eventType: "Stop",
				terminalId,
			});
		expect(result).toEqual({ success: true, ignored: false });
	});
});
