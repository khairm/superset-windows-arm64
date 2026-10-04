import { describe, expect, it } from "bun:test";
import type { WorkspaceSnapshotPayload } from "@superset/workspace-client";
import {
	applyWorkspaceChangedEvent,
	type HostWorkspaceRow,
	type HostWorkspacesHostResult,
	isEventBusReopen,
	mergeHostWorkspaces,
	reuseUnchangedActivity,
	reuseUnchangedWorkspaceItems,
	toHostWorkspaceItem,
} from "./useHostWorkspaces.utils";

const HOST = { organizationId: "org-1", machineId: "machine-1" };
const TARGET = { ...HOST, hostUrl: "http://localhost:1", isLocal: true };

function activityOf(hostResults: HostWorkspacesHostResult[]) {
	return mergeHostWorkspaces({ hostResults }).activityById;
}

function makeSnapshot(
	overrides: Partial<WorkspaceSnapshotPayload> & { id: string },
): WorkspaceSnapshotPayload {
	return {
		projectId: "project-1",
		name: overrides.id,
		branch: overrides.id,
		type: "worktree",
		worktreePath: `/tmp/${overrides.id}`,
		taskId: null,
		createdByUserId: null,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		lastActivityAt: 1_700_000_050_000,
		tags: [],
		...overrides,
	};
}

describe("isEventBusReopen", () => {
	it("treats any open after the first as a reopen", () => {
		expect(isEventBusReopen(true, "open")).toBe(true);
	});

	it("does not treat the first open as a reopen", () => {
		expect(isEventBusReopen(false, "open")).toBe(false);
	});

	it("ignores transitions that do not land on open", () => {
		expect(isEventBusReopen(true, "reconnecting")).toBe(false);
		expect(isEventBusReopen(true, "closed")).toBe(false);
		expect(isEventBusReopen(true, "connecting")).toBe(false);
	});
});

describe("applyWorkspaceChangedEvent lastActivityAt", () => {
	it("carries the snapshot's lastActivityAt onto the cached row", () => {
		const rows = applyWorkspaceChangedEvent(
			undefined,
			{ eventType: "created", workspace: makeSnapshot({ id: "w1" }) },
			HOST,
			"w1",
			null,
		);
		expect(rows?.[0]?.lastActivityAt).toBe(1_700_000_050_000);
	});

	it("replaces a stale value on update", () => {
		const initial = applyWorkspaceChangedEvent(
			undefined,
			{ eventType: "created", workspace: makeSnapshot({ id: "w1" }) },
			HOST,
			"w1",
			null,
		);
		const updated = applyWorkspaceChangedEvent(
			initial,
			{
				eventType: "updated",
				workspace: makeSnapshot({
					id: "w1",
					lastActivityAt: 1_700_000_999_000,
				}),
			},
			HOST,
			"w1",
			null,
		);
		expect(updated?.[0]?.lastActivityAt).toBe(1_700_000_999_000);
	});

	it("normalizes an older host's event (no field) to null", () => {
		// Runtime shape from a host-service that predates the column.
		const legacy = makeSnapshot({ id: "w1" }) as unknown as Record<
			string,
			unknown
		>;
		delete legacy.lastActivityAt;
		const rows = applyWorkspaceChangedEvent(
			undefined,
			{
				eventType: "created",
				workspace: legacy as unknown as WorkspaceSnapshotPayload,
			},
			HOST,
			"w1",
			null,
		);
		expect(rows?.[0]?.lastActivityAt).toBeNull();
	});

	it("keeps the cached stamp when an older host's update omits the field", () => {
		const initial = applyWorkspaceChangedEvent(
			undefined,
			{ eventType: "created", workspace: makeSnapshot({ id: "w1" }) },
			HOST,
			"w1",
			null,
		);
		const legacy = makeSnapshot({ id: "w1" }) as unknown as Record<
			string,
			unknown
		>;
		delete legacy.lastActivityAt;
		const updated = applyWorkspaceChangedEvent(
			initial,
			{
				eventType: "updated",
				workspace: legacy as unknown as WorkspaceSnapshotPayload,
			},
			HOST,
			"w1",
			null,
		);
		expect(updated?.[0]?.lastActivityAt).toBe(1_700_000_050_000);
	});
});

describe("applyWorkspaceChangedEvent tags", () => {
	it("keeps only the viewer's own and creator-less tags", () => {
		const rows = applyWorkspaceChangedEvent(
			undefined,
			{
				eventType: "created",
				workspace: makeSnapshot({
					id: "w1",
					tags: ["legacy", "mine", "theirs"],
					tagAssignments: [
						{ tag: "theirs", createdByUserId: "user-b" },
						{ tag: "mine", createdByUserId: "user-a" },
						{ tag: "legacy", createdByUserId: null },
					],
				}),
			},
			HOST,
			"w1",
			"user-a",
		);
		expect(rows?.[0]?.tags).toEqual(["legacy", "mine"]);
	});

	it("shows nobody's tags while the session is unresolved", () => {
		const initial = applyWorkspaceChangedEvent(
			undefined,
			{
				eventType: "created",
				workspace: makeSnapshot({
					id: "w1",
					tags: ["theirs"],
					tagAssignments: [{ tag: "theirs", createdByUserId: "user-b" }],
				}),
			},
			HOST,
			"w1",
			null,
		);
		expect(initial?.[0]?.tags).toEqual([]);
		const cached = initial?.map((row) => ({ ...row, tags: ["cached"] }));
		const updated = applyWorkspaceChangedEvent(
			cached,
			{
				eventType: "updated",
				workspace: makeSnapshot({
					id: "w1",
					tags: ["theirs"],
					tagAssignments: [{ tag: "theirs", createdByUserId: "user-b" }],
				}),
			},
			HOST,
			"w1",
			null,
		);
		expect(updated?.[0]?.tags).toEqual(["cached"]);
	});

	it("falls back to the union from a host that predates tag creators", () => {
		const rows = applyWorkspaceChangedEvent(
			undefined,
			{
				eventType: "created",
				workspace: makeSnapshot({ id: "w1", tags: ["shared"] }),
			},
			HOST,
			"w1",
			"user-a",
		);
		expect(rows?.[0]?.tags).toEqual(["shared"]);
	});
});

describe("toHostWorkspaceItem", () => {
	const [row] =
		applyWorkspaceChangedEvent(
			undefined,
			{ eventType: "created", workspace: makeSnapshot({ id: "w1" }) },
			HOST,
			"w1",
			null,
		) ?? [];
	if (!row) throw new Error("expected a row");

	it("does not carry the activity stamp", () => {
		expect(
			Object.hasOwn(toHostWorkspaceItem(row, true), "lastActivityAt"),
		).toBe(false);
	});

	it("is what mergeHostWorkspaces produces", () => {
		const { lastActivityAt: _omitted, ...cachedBeforeColumn } = row;
		const [item] = mergeHostWorkspaces({
			hostResults: [
				{ target: TARGET, rows: [cachedBeforeColumn], reachable: false },
			],
		}).items;
		expect(item).toEqual(toHostWorkspaceItem(cachedBeforeColumn, false));
		expect(item).toMatchObject({
			id: "w1",
			archivedAt: null,
			archiveReason: null,
			hostReachable: false,
		});
	});
});

describe("mergeHostWorkspaces activity", () => {
	const [row] =
		applyWorkspaceChangedEvent(
			undefined,
			{ eventType: "created", workspace: makeSnapshot({ id: "w1" }) },
			HOST,
			"w1",
			null,
		) ?? [];
	if (!row) throw new Error("expected a row");

	it("keeps a served stamp", () => {
		const activity = activityOf([
			{ target: TARGET, rows: [row], reachable: true },
		]);
		expect(activity.get("w1")).toBe(1_700_000_050_000);
	});

	it("normalizes a row cached before the column existed to null", () => {
		const { lastActivityAt: _omitted, ...cachedBeforeColumn } = row;
		const activity = activityOf([
			{ target: TARGET, rows: [cachedBeforeColumn], reachable: true },
		]);
		expect(activity.has("w1")).toBe(true);
		expect(activity.get("w1")).toBeNull();
	});

	it("keeps the first-seen row for an id", () => {
		const activity = activityOf([
			{ target: TARGET, rows: [row], reachable: true },
			{
				target: { ...TARGET, machineId: "machine-2" },
				rows: [{ ...row, lastActivityAt: 1 }],
				reachable: true,
			},
		]);
		expect(activity.get("w1")).toBe(1_700_000_050_000);
	});
});

function makeListRow(
	id: string,
	overrides: Partial<HostWorkspaceRow> = {},
): HostWorkspaceRow {
	return {
		id,
		organizationId: HOST.organizationId,
		projectId: "project-1",
		hostId: HOST.machineId,
		name: id,
		branch: id,
		type: "worktree",
		createdByUserId: null,
		taskId: null,
		createdAt: new Date(1_700_000_000_000),
		updatedAt: new Date(1_700_000_000_000),
		tags: ["alpha", "beta"],
		worktreePath: `/tmp/${id}`,
		worktreeExists: true,
		projectName: "Project",
		lastActivityAt: 1_700_000_050_000,
		archivedAt: null,
		archiveReason: null,
		...overrides,
	};
}

function mergeRows(rows: HostWorkspaceRow[]) {
	return mergeHostWorkspaces({
		hostResults: [{ target: TARGET, rows, reachable: true }],
	}).items;
}

function collectRows(rows: HostWorkspaceRow[]) {
	return activityOf([{ target: TARGET, rows, reachable: true }]);
}

describe("reuseUnchangedWorkspaceItems", () => {
	const ids = ["w1", "w2", "w3"];

	it("returns the previous array for a refetch with equal values", () => {
		const prev = reuseUnchangedWorkspaceItems(
			[],
			mergeRows(ids.map((id) => makeListRow(id))),
		);
		const refetched = mergeRows(ids.map((id) => makeListRow(id)));
		expect(refetched[0]?.createdAt).not.toBe(prev[0]?.createdAt);
		expect(refetched[0]?.tags).not.toBe(prev[0]?.tags);
		expect(reuseUnchangedWorkspaceItems(prev, refetched)).toBe(prev);
	});

	it("keeps the items for an activity-only change and moves only that id's activity", () => {
		const before = ids.map((id) => makeListRow(id));
		const after = ids.map((id) =>
			makeListRow(id, id === "w2" ? { lastActivityAt: 1_700_000_999_000 } : {}),
		);
		const prevItems = reuseUnchangedWorkspaceItems([], mergeRows(before));
		expect(reuseUnchangedWorkspaceItems(prevItems, mergeRows(after))).toBe(
			prevItems,
		);

		const prevActivity = collectRows(before);
		const nextActivity = reuseUnchangedActivity(
			prevActivity,
			collectRows(after),
		);
		expect(nextActivity).not.toBe(prevActivity);
		const changed = ids.filter(
			(id) => prevActivity.get(id) !== nextActivity.get(id),
		);
		expect(changed).toEqual(["w2"]);
		expect(reuseUnchangedActivity(prevActivity, collectRows(before))).toBe(
			prevActivity,
		);
	});

	it("replaces only the renamed item", () => {
		const prev = reuseUnchangedWorkspaceItems(
			[],
			mergeRows(ids.map((id) => makeListRow(id))),
		);
		const next = reuseUnchangedWorkspaceItems(
			prev,
			mergeRows(
				ids.map((id) =>
					makeListRow(id, id === "w2" ? { name: "renamed" } : {}),
				),
			),
		);
		expect(next).not.toBe(prev);
		expect(next[0]).toBe(prev[0]);
		expect(next[1]).not.toBe(prev[1]);
		expect(next[1]?.name).toBe("renamed");
		expect(next[2]).toBe(prev[2]);
	});

	it("reuses a list-shaped item for the event-shaped row of the same data", () => {
		const [eventRow] =
			applyWorkspaceChangedEvent(
				undefined,
				{
					eventType: "updated",
					workspace: makeSnapshot({ id: "w1", tags: ["alpha", "beta"] }),
				},
				HOST,
				"w1",
				null,
			) ?? [];
		if (!eventRow) throw new Error("expected a row");
		const listItem = toHostWorkspaceItem(
			makeListRow("w1", { worktreePath: "/tmp/w1" }),
			true,
		);
		const eventItem = toHostWorkspaceItem(eventRow, true);
		expect(eventItem).toEqual(listItem);
		const prev = [listItem];
		expect(reuseUnchangedWorkspaceItems(prev, [eventItem])).toBe(prev);
	});
});
