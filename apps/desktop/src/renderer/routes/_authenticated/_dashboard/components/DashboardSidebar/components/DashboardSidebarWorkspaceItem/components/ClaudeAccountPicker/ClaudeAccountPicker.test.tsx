import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	ClaudeAccount,
	ClaudeAccountRoster,
	ClaudeScheduleView,
	ClaudeWorkspaceAccountState,
} from "renderer/hooks/host-service/useClaudeAccounts";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, fireEvent, render, within } = await import(
	"@testing-library/react"
);
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { ContextMenu, ContextMenuContent, ContextMenuTrigger } = await import(
	"@superset/ui/context-menu"
);
const { AccountRow, ClaudeAccountMenu } = await import("./ClaudeAccountPicker");

const NOW = Date.parse("2026-09-21T12:00:00Z");
const ACCOUNT: ClaudeAccount = Object.freeze({
	slug: "work",
	displayName: "Work",
	enabled: true,
	dead: false,
	deadReason: null,
	lastSuccess: new Date(NOW).toISOString(),
	fivePct: 12,
	sevenPct: 100,
	fablePct: 40,
	fiveResetsAt: "2026-09-21T14:00:00Z",
	sevenResetsAt: "2026-09-24T12:00:00Z",
});

const queryClients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
	cleanup();
	for (const client of queryClients.splice(0)) client.clear();
	mock.restore();
});
afterAll(async () => {
	if (!alreadyRegistered) await GlobalRegistrator.unregister();
});

async function menu(overrides: Partial<ClaudeAccount> = {}, isPending = false) {
	const onSelect = mock((_slug: string) => {});
	let view!: ReturnType<typeof render>;
	await act(async () => {
		view = render(
			<ContextMenu>
				<ContextMenuTrigger>Accounts</ContextMenuTrigger>
				<ContextMenuContent>
					<AccountRow
						account={{ ...ACCOUNT, ...overrides }}
						trayDefaultSlug="work"
						selectedSlug="work"
						isPending={isPending}
						now={NOW}
						onSelect={onSelect}
					/>
				</ContextMenuContent>
			</ContextMenu>,
		);
	});
	const ui = within(view.baseElement as HTMLElement);
	await act(async () => {
		fireEvent.contextMenu(ui.getByText("Accounts"));
	});
	const row = ui.getByRole("menuitem");
	return { row, ui: within(row), onSelect };
}

describe("exhausted account picker row", () => {
	test.each([
		100, 125,
	])("caps Fable at weekly usage %s without disabling selection", async (sevenPct) => {
		const { row, ui, onSelect } = await menu({ sevenPct });
		expect(row.textContent).toContain("fable:100%");
		const fable = ui.getAllByText("100%").at(-1);
		expect(fable?.classList.contains("text-red-500")).toBe(true);
		expect(row.hasAttribute("data-disabled")).toBe(false);
		await act(async () => {
			fireEvent.click(row);
		});
		expect(onSelect).toHaveBeenCalledWith("work");
	});

	test("dims only the identity and metric groups, leaving the weekly countdown bright", async () => {
		const { row, ui } = await menu();
		expect(row.classList.contains("opacity-50")).toBe(false);
		expect(ui.getByText("work").closest(".opacity-50")).not.toBeNull();
		expect(ui.getByText("tray default").closest(".opacity-50")).not.toBeNull();
		expect(row.querySelector("svg")?.closest(".opacity-50")).not.toBeNull();
		expect(ui.getByText("2h0m").closest(".opacity-50")).not.toBeNull();
		expect(ui.getByText("3d0h").closest(".opacity-50")).toBeNull();
		const metrics = ui.getByText("3d0h").closest("div");
		expect(metrics?.classList.contains("opacity-50")).toBe(false);
		for (const group of metrics?.querySelectorAll(".opacity-50") ?? []) {
			expect(group.classList.contains("inline-flex")).toBe(true);
			expect(group.classList.contains("items-center")).toBe(true);
			expect(group.classList.contains("gap-1")).toBe(true);
		}
	});

	test.each([
		{ sevenPct: 99.5 },
		{ sevenPct: 99.99 },
		{ sevenPct: null },
		{ sevenResetsAt: new Date(NOW - 1).toISOString() },
		{ sevenResetsAt: new Date(NOW).toISOString() },
	])("does not exhaust an account with %j", async (overrides) => {
		const { row } = await menu(overrides);
		expect(row.textContent).toContain("fable:40%");
		expect(row.querySelector(".opacity-50")).toBeNull();
	});

	test("caps Fable without a weekly reset stamp", async () => {
		const { row } = await menu({ sevenResetsAt: null });
		expect(row.textContent).toContain("fable:100%");
		expect(row.querySelector(".opacity-50")).not.toBeNull();
	});

	test("keeps absent Fable absent", async () => {
		const { row } = await menu({ fablePct: null });
		expect(row.textContent).toContain("fable:—");
		expect(row.querySelector(".opacity-50")).not.toBeNull();
	});

	test("does not dim for Fable exhaustion alone", async () => {
		const { row } = await menu({ sevenPct: 50, fablePct: 100 });
		expect(row.querySelector(".opacity-50")).toBeNull();
	});

	test.each([
		{ overrides: { dead: true }, pending: false },
		{ overrides: { enabled: false }, pending: false },
		{ overrides: {}, pending: true },
	])("retains existing disabled behavior for %j", async ({
		overrides,
		pending,
	}) => {
		const { row, onSelect } = await menu(overrides, pending);
		expect(row.hasAttribute("data-disabled")).toBe(true);
		expect(row.querySelector(".opacity-50")).toBeNull();
		await act(async () => {
			fireEvent.click(row);
		});
		expect(onSelect).not.toHaveBeenCalled();
	});
});

const FOLLOWING_STATE: ClaudeWorkspaceAccountState = {
	state: "following",
	slug: null,
	warning: null,
	autoSwitch: true,
	schedule: null,
};
const PENDING_SCHEDULE: ClaudeScheduleView = {
	status: "pending",
	scheduleId: "33333333-3333-4333-8333-333333333333",
	target: { kind: "account", slug: "work" },
	fireAt: NOW + 60 * 60_000,
};

async function accountMenu({
	state,
	roster,
	configured,
}: {
	state: ClaudeWorkspaceAccountState;
	roster: ClaudeAccountRoster | undefined;
	configured: boolean;
}) {
	const client = new QueryClient();
	queryClients.push(client);
	let view!: ReturnType<typeof render>;
	await act(async () => {
		view = render(
			<QueryClientProvider client={client}>
				<ContextMenu>
					<ContextMenuTrigger>Workspace</ContextMenuTrigger>
					<ContextMenuContent>
						<ClaudeAccountMenu
							hostUrl="http://localhost:1234"
							workspaceId="11111111-1111-4111-8111-111111111111"
							state={state}
							roster={roster}
							configured={configured}
							exited={false}
							onRequestCustomTime={() => {}}
						/>
					</ContextMenuContent>
				</ContextMenu>
			</QueryClientProvider>,
		);
	});
	const ui = within(view.baseElement as HTMLElement);
	await act(async () => {
		fireEvent.contextMenu(ui.getByText("Workspace"));
	});
	await openSubmenu(ui, "Account");
	return ui;
}

async function openSubmenu(ui: ReturnType<typeof within>, name: string) {
	await act(async () => {
		fireEvent.click(ui.getByRole("menuitem", { name }));
	});
}

describe("account menu controls", () => {
	test("greys Auto-switch, the Default target and an unknown reset while Following", async () => {
		const ui = await accountMenu({
			state: FOLLOWING_STATE,
			roster: {
				accounts: [{ ...ACCOUNT, fiveResetsAt: null }],
				trayDefaultSlug: "work",
			},
			configured: true,
		});

		expect(
			ui
				.getByRole("menuitemcheckbox", { name: "Auto-switch" })
				.hasAttribute("data-disabled"),
		).toBe(true);
		await openSubmenu(ui, "Schedule switch");
		expect(
			ui
				.getByRole("menuitem", { name: "Default (tray)" })
				.hasAttribute("data-disabled"),
		).toBe(true);
		await openSubmenu(ui, "work");
		expect(
			ui
				.getByRole("menuitem", { name: "At its 5h reset (unknown)" })
				.hasAttribute("data-disabled"),
		).toBe(true);
	});

	test.each([
		{ configured: true, unavailable: "Accounts unavailable" },
		{ configured: false, unavailable: "Account credentials unavailable" },
	])("shows the schedule and Cancel without a roster for %j", async ({
		configured,
		unavailable,
	}) => {
		const ui = await accountMenu({
			state: {
				...FOLLOWING_STATE,
				state: "pinned",
				slug: "work",
				schedule: PENDING_SCHEDULE,
			},
			roster: undefined,
			configured,
		});

		expect(ui.getByText(unavailable)).toBeTruthy();
		expect(ui.getByText(/^Scheduled: work at /)).toBeTruthy();
		const cancel = ui.getByRole("menuitem", {
			name: "Cancel scheduled switch",
		});
		expect(cancel.hasAttribute("data-disabled")).toBe(false);
		expect(
			ui
				.getByRole("menuitem", { name: "Schedule switch" })
				.hasAttribute("data-disabled"),
		).toBe(true);
	});
});
