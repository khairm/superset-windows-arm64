import { describe, expect, test } from "bun:test";
import type { OutboxEntry, TurnGroup } from "@superset/chat/core";
import {
	chatRows,
	groupActivity,
	groupPositions,
	lastReplyKeys,
} from "./chatRows";

const turn = (id: string, status: "running" | "completed") => ({
	id,
	status,
	startedAtMs: 1,
});

const user = (id: string, clientId: string) => ({
	id,
	kind: "user_message" as const,
	clientId,
	content: [{ type: "text" as const, text: "hi" }],
	startedAtMs: 1,
});

const outbox = (clientId: string): OutboxEntry => ({
	commandId: `c-${clientId}`,
	clientId,
	content: [{ type: "text", text: "hi" }],
	state: "inflight",
	attempts: 1,
	lastError: null,
});

describe("chatRows", () => {
	test("an echoed prompt replaces its outbox bubble under the same key", () => {
		const groups: TurnGroup[] = [
			{
				turn: turn("t1", "completed"),
				turnId: "t1",
				entries: [{ kind: "item", item: user("u1", "client-1") }],
			},
		];
		const rows = chatRows(groups, [outbox("client-1"), outbox("client-2")]);
		expect(rows.map((row) => [row.kind, row.key])).toEqual([
			["item", "client-1"],
			["outbox", "client-2"],
		]);
	});

	test("a running turn with nothing live ends with a working line", () => {
		const groups: TurnGroup[] = [
			{
				turn: turn("t1", "running"),
				turnId: "t1",
				entries: [{ kind: "item", item: user("u1", "client-1") }],
			},
		];
		expect(chatRows(groups, []).at(-1)?.kind).toBe("working");
	});
});

describe("groupPositions", () => {
	test("consecutive rows from one side join, and system rows break the run", () => {
		const groups: TurnGroup[] = [
			{
				turnId: "t1",
				turn: turn("t1", "completed"),
				entries: [
					{ kind: "item", item: user("u1", "c1") },
					{ kind: "item", item: user("u2", "c2") },
					{
						kind: "item",
						item: {
							id: "a1",
							kind: "agent_message",
							text: "a",
							startedAtMs: 1,
						},
					},
					{
						kind: "item",
						item: {
							id: "n1",
							kind: "notice",
							noticeKind: "info",
							text: "n",
							startedAtMs: 1,
						},
					},
					{
						kind: "item",
						item: {
							id: "a2",
							kind: "agent_message",
							text: "b",
							startedAtMs: 1,
						},
					},
				],
			} as unknown as TurnGroup,
		];
		expect(groupPositions(chatRows(groups, []))).toEqual([
			"first",
			"last",
			"single",
			"single",
			"single",
		]);
	});
});

describe("groupActivity", () => {
	test("each run of thoughts and tool calls becomes one row", () => {
		const reasoning = (id: string) => ({
			kind: "item" as const,
			key: id,
			item: { id, kind: "reasoning", startedAtMs: 1, completedAtMs: 2 },
		});
		const message = (id: string) => ({
			kind: "item" as const,
			key: id,
			item: { id, kind: "agent_message", text: "", startedAtMs: 1 },
		});
		const rows = [
			reasoning("r1"),
			{ kind: "tool_run" as const, key: "t1", items: [] },
			reasoning("r2"),
			message("m1"),
			reasoning("r3"),
			message("m2"),
		] as unknown as Parameters<typeof groupActivity>[0];
		expect(groupActivity(rows).map((row) => row.key)).toEqual([
			"activity:r1",
			"m1",
			"activity:r3",
			"m2",
		]);
	});
});

describe("lastReplyKeys", () => {
	test("the last reply of each agent turn, even with activity after it", () => {
		const rows = [
			{ kind: "item", key: "u1", item: { id: "u1", kind: "user_message" } },
			{ kind: "item", key: "a1", item: { id: "a1", kind: "agent_message" } },
			{ kind: "item", key: "a2", item: { id: "a2", kind: "agent_message" } },
			{ kind: "activity", key: "act", rows: [] },
			{ kind: "item", key: "u2", item: { id: "u2", kind: "user_message" } },
			{ kind: "item", key: "a3", item: { id: "a3", kind: "agent_message" } },
		] as unknown as Parameters<typeof lastReplyKeys>[0];
		expect([...lastReplyKeys(rows)]).toEqual(["a2", "a3"]);
	});
});
