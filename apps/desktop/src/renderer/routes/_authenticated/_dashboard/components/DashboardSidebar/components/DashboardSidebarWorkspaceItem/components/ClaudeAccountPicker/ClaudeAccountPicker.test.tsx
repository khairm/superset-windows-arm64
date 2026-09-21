import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ClaudeAccount } from "renderer/hooks/host-service/useClaudeAccounts";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, fireEvent, render, within } = await import(
	"@testing-library/react"
);
const { ContextMenu, ContextMenuContent, ContextMenuTrigger } = await import(
	"@superset/ui/context-menu"
);
const { AccountRow } = await import("./ClaudeAccountPicker");

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

afterEach(() => {
	cleanup();
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
