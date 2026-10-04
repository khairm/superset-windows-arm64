import { describe, expect, it } from "bun:test";
import type {
	DashboardSidebarProject,
	DashboardSidebarProjectChild,
} from "../../types";
import {
	makeProject,
	makeSection,
	makeWorkspace,
} from "../testProjectFixtures";
import {
	getWorkspaceActivityTime,
	type SidebarWorkspaceActivityById,
	sortDashboardSidebarProjectChildren,
	sortDashboardSidebarProjects,
	stabiliseSortedProjects,
} from "./sortDashboardSidebarProjects";

const at = (iso: string) => new Date(iso).getTime();

const activity = (
	entries: Array<[string, number | null]>,
): SidebarWorkspaceActivityById => new Map(entries);

const childIds = (children: DashboardSidebarProjectChild[]) =>
	children.map((c) => (c.type === "workspace" ? c.workspace.id : c.section.id));

describe("getWorkspaceActivityTime", () => {
	it("ranks by the activity stamp alone once the host has stamped it", () => {
		// A rename bumped updatedAt well past the last agent event; the agent
		// event still wins because housekeeping is not activity.
		const workspace = makeWorkspace({
			id: "w",
			name: "w",
			updatedAt: new Date("2026-08-01"),
		});
		expect(
			getWorkspaceActivityTime(workspace, activity([["w", at("2026-03-01")]])),
		).toBe(at("2026-03-01"));
	});

	it("falls back to updatedAt for rows from a host that predates the column", () => {
		const workspace = makeWorkspace({
			id: "w",
			name: "w",
			updatedAt: new Date("2026-05-01"),
		});
		expect(getWorkspaceActivityTime(workspace, activity([["w", null]]))).toBe(
			at("2026-05-01"),
		);
	});

	it("treats a NaN stamp like a missing one", () => {
		const workspace = makeWorkspace({
			id: "w",
			name: "w",
			updatedAt: new Date("2026-05-01"),
		});
		expect(
			getWorkspaceActivityTime(workspace, activity([["w", Number.NaN]])),
		).toBe(at("2026-05-01"));
	});

	it("falls back to updatedAt for an id the map does not know yet", () => {
		const workspace = makeWorkspace({
			id: "w",
			name: "w",
			updatedAt: new Date("2026-05-01"),
		});
		expect(getWorkspaceActivityTime(workspace, activity([]))).toBe(
			at("2026-05-01"),
		);
		expect(getWorkspaceActivityTime(workspace, null)).toBe(at("2026-05-01"));
	});
});

describe("sortDashboardSidebarProjects", () => {
	const older = makeProject({
		id: "p-older",
		name: "Older",
		createdAt: new Date("2026-01-01"),
		children: [
			{
				type: "workspace",
				workspace: makeWorkspace({ id: "w1", name: "busy" }),
			},
		],
	});
	const newer = makeProject({
		id: "p-newer",
		name: "Newer",
		createdAt: new Date("2026-04-01"),
		children: [
			{
				type: "workspace",
				workspace: makeWorkspace({ id: "w2", name: "idle" }),
			},
		],
	});
	const projectActivity = activity([
		["w1", at("2026-07-01")],
		["w2", at("2026-05-01")],
	]);

	it("returns the input untouched in manual mode", () => {
		const projects = [older, newer];
		expect(
			sortDashboardSidebarProjects(projects, "manual", projectActivity),
		).toBe(projects);
	});

	it("keeps the manual project order in created mode", () => {
		expect(
			sortDashboardSidebarProjects([older, newer], "created", null).map(
				(p) => p.id,
			),
		).toEqual(["p-older", "p-newer"]);
	});

	it("keeps the manual project order in active mode", () => {
		expect(
			sortDashboardSidebarProjects(
				[newer, older],
				"active",
				projectActivity,
			).map((p) => p.id),
		).toEqual(["p-newer", "p-older"]);
	});

	it("does not mutate the input array", () => {
		const projects = [newer, older];
		sortDashboardSidebarProjects(projects, "active", projectActivity);
		expect(projects.map((p) => p.id)).toEqual(["p-newer", "p-older"]);
	});

	it("keeps a project's identity when its children are already in order", () => {
		const [sorted] = sortDashboardSidebarProjects(
			[older],
			"active",
			projectActivity,
		);
		expect(sorted).toBe(older);
	});

	// Persisted caches can revive Date columns as ISO strings; sorting must
	// coerce them, never throw mid-render.
	it("sorts children whose timestamps are ISO strings at runtime", () => {
		const project = makeProject({
			id: "p1",
			name: "Alpha",
			children: [
				{
					type: "workspace",
					workspace: makeWorkspace({
						id: "w-date",
						name: "host-served",
						updatedAt: new Date("2026-05-01"),
					}),
				},
				{
					type: "workspace",
					workspace: makeWorkspace({
						id: "w-string",
						name: "cached",
						updatedAt: "2026-07-01T00:00:00.000Z" as unknown as Date,
					}),
				},
			],
		});
		const [sorted] = sortDashboardSidebarProjects(
			[project],
			"active",
			activity([]),
		);
		expect(childIds(sorted?.children ?? [])).toEqual(["w-string", "w-date"]);
	});

	it("does not throw for null or undefined timestamps", () => {
		const nullish = makeProject({
			id: "p-null",
			name: "Null",
			createdAt: null as unknown as Date,
			updatedAt: undefined as unknown as Date,
			children: [
				{
					type: "workspace",
					workspace: makeWorkspace({
						id: "w-null",
						name: "null",
						createdAt: null as unknown as Date,
						updatedAt: undefined as unknown as Date,
					}),
				},
			],
		});
		expect(() =>
			sortDashboardSidebarProjects(
				[nullish],
				"active",
				activity([["w-null", null]]),
			),
		).not.toThrow();
		expect(() =>
			sortDashboardSidebarProjects([nullish], "created", null),
		).not.toThrow();
	});
});

describe("sortDashboardSidebarProjectChildren", () => {
	const localChild: DashboardSidebarProjectChild = {
		type: "workspace",
		workspace: makeWorkspace({
			id: "w-local",
			name: "local",
			type: "local",
		}),
	};
	const oldWorktree: DashboardSidebarProjectChild = {
		type: "workspace",
		workspace: makeWorkspace({
			id: "w-old",
			name: "old",
			createdAt: new Date("2026-06-01"),
		}),
	};
	const newWorktree: DashboardSidebarProjectChild = {
		type: "workspace",
		workspace: makeWorkspace({
			id: "w-new",
			name: "new",
			createdAt: new Date("2026-02-01"),
		}),
	};
	const section: DashboardSidebarProjectChild = {
		type: "section",
		section: makeSection({
			id: "s1",
			name: "Section",
			createdAt: new Date("2026-01-15"),
			workspaces: [
				makeWorkspace({ id: "w-s-old", name: "section-old" }),
				makeWorkspace({ id: "w-s-new", name: "section-new" }),
			],
		}),
	};
	const childActivity = activity([
		["w-local", at("2026-01-01")],
		["w-old", at("2026-02-01")],
		["w-new", at("2026-06-01")],
		["w-s-old", at("2026-03-01")],
		["w-s-new", at("2026-04-01")],
	]);

	it("returns children untouched in manual mode", () => {
		const children = [oldWorktree, newWorktree];
		expect(
			sortDashboardSidebarProjectChildren(children, "manual", childActivity),
		).toBe(children);
	});

	it("sorts a local workspace by activity like any other row", () => {
		const sorted = sortDashboardSidebarProjectChildren(
			[oldWorktree, newWorktree, localChild],
			"active",
			childActivity,
		);
		expect(childIds(sorted)).toEqual(["w-new", "w-old", "w-local"]);
	});

	it("sorts workspaces inside sections and ranks sections by newest member", () => {
		// Section activity (2026-04-01) beats w-old (02-01), loses to w-new (06-01).
		const sorted = sortDashboardSidebarProjectChildren(
			[section, oldWorktree, newWorktree],
			"active",
			childActivity,
		);
		expect(childIds(sorted)).toEqual(["w-new", "s1", "w-old"]);
		const sortedSection = sorted.find((c) => c.type === "section");
		expect(
			sortedSection?.type === "section"
				? sortedSection.section.workspaces.map((w) => w.id)
				: [],
		).toEqual(["w-s-new", "w-s-old"]);
	});

	it("ranks an empty section by its own createdAt in active mode", () => {
		const empty: DashboardSidebarProjectChild = {
			type: "section",
			section: makeSection({
				id: "s-empty",
				name: "Empty",
				createdAt: new Date("2026-03-01"),
			}),
		};
		const sorted = sortDashboardSidebarProjectChildren(
			[oldWorktree, empty, newWorktree],
			"active",
			childActivity,
		);
		expect(childIds(sorted)).toEqual(["w-new", "s-empty", "w-old"]);
	});

	it("uses createdAt for workspaces and the section's own createdAt in created mode", () => {
		// By createdAt: w-old (06-01) > w-new (02-01) > section (01-15).
		const sorted = sortDashboardSidebarProjectChildren(
			[section, oldWorktree, newWorktree],
			"created",
			null,
		);
		expect(childIds(sorted)).toEqual(["w-old", "w-new", "s1"]);
	});

	it("ignores the activity stamp in created mode", () => {
		const createdLate: DashboardSidebarProjectChild = {
			type: "workspace",
			workspace: makeWorkspace({
				id: "w-created-late",
				name: "late",
				createdAt: new Date("2026-06-01"),
			}),
		};
		const createdEarlyButActive: DashboardSidebarProjectChild = {
			type: "workspace",
			workspace: makeWorkspace({
				id: "w-created-early",
				name: "early",
				createdAt: new Date("2026-02-01"),
			}),
		};
		const sorted = sortDashboardSidebarProjectChildren(
			[createdEarlyButActive, createdLate],
			"created",
			activity([["w-created-early", at("2026-07-01")]]),
		);
		expect(childIds(sorted)).toEqual(["w-created-late", "w-created-early"]);
	});

	it("breaks timestamp ties by name, then id", () => {
		const tie = at("2026-05-01");
		const apple = makeWorkspace({ id: "w-a", name: "Apple" });
		const banana = makeWorkspace({ id: "w-b", name: "Banana" });
		const banana2 = makeWorkspace({ id: "w-b2", name: "Banana" });
		const sorted = sortDashboardSidebarProjectChildren(
			[banana2, banana, apple].map((workspace) => ({
				type: "workspace" as const,
				workspace,
			})),
			"active",
			activity([
				["w-a", tie],
				["w-b", tie],
				["w-b2", tie],
			]),
		);
		expect(childIds(sorted)).toEqual(["w-a", "w-b", "w-b2"]);
	});

	it("sinks garbage timestamps below dated rows and orders them by name", () => {
		const dated: DashboardSidebarProjectChild = {
			type: "workspace",
			workspace: makeWorkspace({
				id: "w-dated",
				name: "Zed",
				createdAt: new Date("2020-01-01"),
			}),
		};
		const garbage: DashboardSidebarProjectChild = {
			type: "workspace",
			workspace: makeWorkspace({
				id: "w-garbage",
				name: "Apple",
				createdAt: "not-a-date" as unknown as Date,
			}),
		};
		const alsoGarbage: DashboardSidebarProjectChild = {
			type: "workspace",
			workspace: makeWorkspace({
				id: "w-garbage-2",
				name: "Banana",
				createdAt: "also-not-a-date" as unknown as Date,
			}),
		};
		expect(
			childIds(
				sortDashboardSidebarProjectChildren(
					[alsoGarbage, dated, garbage],
					"created",
					null,
				),
			),
		).toEqual(["w-dated", "w-garbage", "w-garbage-2"]);
	});

	it("does not mutate the input children or sections", () => {
		const children = [section, oldWorktree, newWorktree];
		const sectionWorkspaceIds = section.section.workspaces.map((w) => w.id);
		sortDashboardSidebarProjectChildren(children, "active", childActivity);
		expect(childIds(children)).toEqual(["s1", "w-old", "w-new"]);
		expect(section.section.workspaces.map((w) => w.id)).toEqual(
			sectionWorkspaceIds,
		);
	});

	it("keeps array and section identity when already in order", () => {
		const orderedSection: DashboardSidebarProjectChild = {
			type: "section",
			section: makeSection({
				id: "s-ordered",
				name: "Ordered",
				workspaces: [
					makeWorkspace({ id: "w-a", name: "a" }),
					makeWorkspace({ id: "w-b", name: "b" }),
				],
			}),
		};
		const children = [newWorktree, orderedSection, oldWorktree, localChild];
		const sorted = sortDashboardSidebarProjectChildren(
			children,
			"active",
			new Map([
				...childActivity,
				["w-a", at("2026-05-01")],
				["w-b", at("2026-04-01")],
			]),
		);
		expect(sorted).toBe(children);
		expect(sorted[1]).toBe(orderedSection);
	});
});

// The whole point of the rework: the host's activity stamp is the signal,
// and metadata writes never masquerade as activity.
describe("the activity stamp in active mode", () => {
	it("ranks a freshly prompted workspace above one that was merely renamed", () => {
		const project = makeProject({
			id: "p1",
			name: "Alpha",
			children: [
				{
					type: "workspace",
					workspace: makeWorkspace({
						id: "w-renamed",
						name: "renamed-just-now",
						updatedAt: new Date("2026-08-01"),
					}),
				},
				{
					type: "workspace",
					workspace: makeWorkspace({
						id: "w-prompted",
						name: "prompted-recently",
						updatedAt: new Date("2026-01-01"),
					}),
				},
			],
		});
		const [sorted] = sortDashboardSidebarProjects(
			[project],
			"active",
			activity([
				["w-renamed", at("2026-02-01")],
				["w-prompted", at("2026-07-01")],
			]),
		);
		expect(childIds(sorted?.children ?? [])).toEqual([
			"w-prompted",
			"w-renamed",
		]);
	});

	it("ranks an old-host workspace (null stamp) by its updatedAt", () => {
		const project = makeProject({
			id: "p1",
			name: "Alpha",
			children: [
				{
					type: "workspace",
					workspace: makeWorkspace({
						id: "w-old-host",
						name: "old-host",
						updatedAt: new Date("2026-06-01"),
					}),
				},
				{
					type: "workspace",
					workspace: makeWorkspace({
						id: "w-new-host",
						name: "new-host",
						updatedAt: new Date("2026-08-01"),
					}),
				},
			],
		});
		const [sorted] = sortDashboardSidebarProjects(
			[project],
			"active",
			activity([
				["w-old-host", null],
				["w-new-host", at("2026-05-01")],
			]),
		);
		expect(childIds(sorted?.children ?? [])).toEqual([
			"w-old-host",
			"w-new-host",
		]);
	});

	// Activity ranks rows inside a project and stops there — a busy workspace
	// must not drag its project up past the one above it.
	it("does not bubble activity up to project ordering", () => {
		const idle = makeProject({
			id: "p-idle",
			name: "Idle",
			children: [
				{
					type: "workspace",
					workspace: makeWorkspace({ id: "w2", name: "two" }),
				},
			],
		});
		const busy = makeProject({
			id: "p-busy",
			name: "Busy",
			children: [
				{
					type: "workspace",
					workspace: makeWorkspace({ id: "w1", name: "one" }),
				},
			],
		});
		expect(
			sortDashboardSidebarProjects(
				[idle, busy],
				"active",
				activity([
					["w2", at("2026-05-01")],
					["w1", at("2026-07-01")],
				]),
			).map((p) => p.id),
		).toEqual(["p-idle", "p-busy"]);
	});

	it("bubbles activity inside a section up to the section's rank", () => {
		const section: DashboardSidebarProjectChild = {
			type: "section",
			section: makeSection({
				id: "s1",
				name: "Section",
				workspaces: [makeWorkspace({ id: "w-s", name: "sectioned" })],
			}),
		};
		const loose: DashboardSidebarProjectChild = {
			type: "workspace",
			workspace: makeWorkspace({ id: "w-loose", name: "loose" }),
		};
		const sorted = sortDashboardSidebarProjectChildren(
			[loose, section],
			"active",
			activity([
				["w-s", at("2026-07-01")],
				["w-loose", at("2026-05-01")],
			]),
		);
		expect(childIds(sorted)).toEqual(["s1", "w-loose"]);
	});
});

describe("stabiliseSortedProjects", () => {
	const sectionOld = makeWorkspace({ id: "w-s-old", name: "section-old" });
	const sectionNew = makeWorkspace({ id: "w-s-new", name: "section-new" });
	const looseOld = makeWorkspace({ id: "w-loose-old", name: "loose-old" });
	const looseNew = makeWorkspace({ id: "w-loose-new", name: "loose-new" });
	const untouchedWorkspace = makeWorkspace({ id: "w-quiet", name: "quiet" });
	const leaves = [
		sectionOld,
		sectionNew,
		looseOld,
		looseNew,
		untouchedWorkspace,
	];

	// Manual order puts every older row first, so "Last active" copies the
	// section and the children array of the busy project.
	const busy = makeProject({
		id: "p-busy",
		name: "Busy",
		children: [
			{
				type: "section",
				section: makeSection({
					id: "s1",
					name: "Section",
					workspaces: [sectionOld, sectionNew],
				}),
			},
			{ type: "workspace", workspace: looseOld },
			{ type: "workspace", workspace: looseNew },
		],
	});
	const quiet = makeProject({
		id: "p-quiet",
		name: "Quiet",
		children: [{ type: "workspace", workspace: untouchedWorkspace }],
	});
	const orderedGroups = [busy, quiet];

	const baseActivity: Array<[string, number]> = [
		["w-s-old", at("2026-03-01")],
		["w-s-new", at("2026-04-01")],
		["w-loose-old", at("2026-02-01")],
		["w-loose-new", at("2026-06-01")],
		["w-quiet", at("2026-01-01")],
	];

	const sortAndStabilise = (
		prev: DashboardSidebarProject[],
		entries: Array<[string, number]>,
	) =>
		stabiliseSortedProjects(
			prev,
			sortDashboardSidebarProjects(orderedGroups, "active", activity(entries)),
		);

	const collectLeaves = (projects: DashboardSidebarProject[]) =>
		projects.flatMap((project) =>
			project.children.flatMap((child) =>
				child.type === "workspace"
					? [child.workspace]
					: child.section.workspaces,
			),
		);

	it("returns the previous tree when a timestamp change keeps the order", () => {
		const prev = sortAndStabilise([], baseActivity);
		expect(prev[0]).not.toBe(busy);
		const next = sortAndStabilise(
			prev,
			baseActivity.map(([id, time]): [string, number] =>
				id === "w-loose-new" ? [id, at("2026-06-15")] : [id, time],
			),
		);
		expect(next).toBe(prev);
	});

	it("reuses untouched projects and never copies a leaf on a reorder", () => {
		const prev = sortAndStabilise([], baseActivity);
		const next = sortAndStabilise(
			prev,
			baseActivity.map(([id, time]): [string, number] =>
				id === "w-loose-old" ? [id, at("2026-09-01")] : [id, time],
			),
		);
		expect(next).not.toBe(prev);
		expect(childIds(next[0]?.children ?? [])).toEqual([
			"w-loose-old",
			"w-loose-new",
			"s1",
		]);
		expect(next[1]).toBe(prev[1]);
		expect(next[1]).toBe(quiet);
		const nextLeaves = collectLeaves(next);
		expect(nextLeaves).toHaveLength(leaves.length);
		for (const leaf of nextLeaves) {
			expect(leaves.some((original) => original === leaf)).toBe(true);
		}
	});

	it("keeps an unchanged section when a loose row moves past it", () => {
		const prev = sortAndStabilise([], baseActivity);
		expect(childIds(prev[0]?.children ?? [])).toEqual([
			"w-loose-new",
			"s1",
			"w-loose-old",
		]);
		const next = sortAndStabilise(
			prev,
			baseActivity.map(([id, time]): [string, number] =>
				id === "w-loose-old" ? [id, at("2026-05-01")] : [id, time],
			),
		);
		expect(childIds(next[0]?.children ?? [])).toEqual([
			"w-loose-new",
			"w-loose-old",
			"s1",
		]);
		const sectionOf = (projects: DashboardSidebarProject[]) =>
			projects[0]?.children.find((child) => child.type === "section");
		expect(sectionOf(prev)).toBeDefined();
		expect(sectionOf(prev)).not.toBe(busy.children[0]);
		expect(sectionOf(next)).toBe(sectionOf(prev));
		expect(next[1]).toBe(prev[1]);
	});
});
