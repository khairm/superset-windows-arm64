import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SidebarProjectSortMode } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal/schema";
import {
	createWorkspaceActivityStore,
	type WorkspaceActivityStore,
} from "renderer/routes/_authenticated/providers/HostWorkspacesProvider/utils/createWorkspaceActivityStore";
import type { DashboardSidebarProject } from "../../types";
import { makeProject, makeWorkspace } from "../../utils/testProjectFixtures";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const at = (iso: string) => new Date(iso).getTime();

let store: WorkspaceActivityStore = createWorkspaceActivityStore(new Map());

const realHostWorkspacesProvider = await import(
	"renderer/routes/_authenticated/providers/HostWorkspacesProvider"
);

/**
 * `HostWorkspacesProvider` cannot mount here, so the real store is injected
 * through the provider's hook. `mock.module` is process-global, so the real
 * exports are spread through and the install repeats in `beforeEach`.
 */
function installMocks(): void {
	mock.module(
		"renderer/routes/_authenticated/providers/HostWorkspacesProvider",
		() => ({
			...realHostWorkspacesProvider,
			useHostWorkspaceActivityStore: () => store,
		}),
	);
}
installMocks();

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { useSortedSidebarProjects } = await import("./useSortedSidebarProjects");

const first = makeWorkspace({ id: "w-first", name: "first" });
const second = makeWorkspace({ id: "w-second", name: "second" });
// Manual order is first, second; "Last active" ranks second above first.
const orderedGroups: DashboardSidebarProject[] = [
	makeProject({
		id: "p1",
		name: "Alpha",
		children: [
			{ type: "workspace", workspace: first },
			{ type: "workspace", workspace: second },
		],
	}),
];

const childIds = (projects: DashboardSidebarProject[]) =>
	(projects[0]?.children ?? []).map((child) =>
		child.type === "workspace" ? child.workspace.id : child.section.id,
	);

function renderSorted(sortMode: SidebarProjectSortMode) {
	let renders = 0;
	const hook = renderHook(() => {
		renders += 1;
		return useSortedSidebarProjects(orderedGroups, sortMode);
	});
	return { hook, renders: () => renders };
}

beforeEach(() => {
	installMocks();
	store = createWorkspaceActivityStore(
		new Map([
			["w-first", at("2026-02-01")],
			["w-second", at("2026-06-01")],
		]),
	);
});
afterEach(cleanup);
afterAll(async () => {
	if (!alreadyRegistered) await GlobalRegistrator.unregister();
});

describe("useSortedSidebarProjects", () => {
	test("an activity tick that keeps the order renders nothing", () => {
		const { hook, renders } = renderSorted("active");
		const before = hook.result.current;
		const rendersBefore = renders();
		expect(childIds(before)).toEqual(["w-second", "w-first"]);

		act(() => {
			store.set(
				new Map([
					["w-first", at("2026-02-01")],
					["w-second", at("2026-06-15")],
				]),
			);
		});

		expect(renders()).toBe(rendersBefore);
		expect(hook.result.current).toBe(before);
	});

	test("an activity tick that reorders renders exactly once", () => {
		const { hook, renders } = renderSorted("active");
		const rendersBefore = renders();

		act(() => {
			store.set(
				new Map([
					["w-first", at("2026-09-01")],
					["w-second", at("2026-06-01")],
				]),
			);
		});

		expect(renders()).toBe(rendersBefore + 1);
		expect(childIds(hook.result.current)).toEqual(["w-first", "w-second"]);
	});

	test("manual mode ignores activity ticks", () => {
		const { hook, renders } = renderSorted("manual");
		const rendersBefore = renders();
		expect(hook.result.current).toBe(orderedGroups);

		act(() => {
			store.set(
				new Map([
					["w-first", at("2026-01-01")],
					["w-second", at("2026-09-01")],
				]),
			);
		});

		expect(renders()).toBe(rendersBefore);
		expect(hook.result.current).toBe(orderedGroups);
	});
});
