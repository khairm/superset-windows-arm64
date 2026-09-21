import {
	afterAll,
	afterEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	ClaudeAccount,
	ClaudeAccountRoster,
} from "renderer/hooks/host-service/useClaudeAccounts";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const {
	claudeAccountCapabilityQueryKey,
	claudeAccountRosterQueryKey,
	claudeWorkspaceAccountStatesQueryKey,
} = await import("renderer/hooks/host-service/useClaudeAccounts");
const { ClaudeAccountSidebarProvider, useClaudeAccountSidebarEntry } =
	await import("./ClaudeAccountSidebarProvider");

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

function SidebarValue() {
	const entry = useClaudeAccountSidebarEntry("workspace");
	return <output>{JSON.stringify(entry.account)}</output>;
}

describe("sidebar account display mapping", () => {
	test.each([
		{ overrides: {}, fablePct: 100, fablePace: "red" },
		{ overrides: { sevenPct: 125 }, fablePct: 100, fablePace: "red" },
		{ overrides: { sevenPct: 99.5 }, fablePct: 40, fablePace: "green" },
		{ overrides: { sevenPct: null }, fablePct: 40, fablePace: "green" },
		{ overrides: { sevenResetsAt: null }, fablePct: 100, fablePace: "red" },
		{
			overrides: { sevenResetsAt: new Date(NOW - 1).toISOString() },
			fablePct: 40,
			fablePace: "green",
		},
		{ overrides: { fablePct: null }, fablePct: null, fablePace: null },
	])("maps display values without mutating the roster for %j", async ({
		overrides,
		fablePct,
		fablePace,
	}) => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClients.push(client);
		const hostUrl = "http://localhost:1234";
		const rawAccount = Object.freeze({ ...ACCOUNT, ...overrides });
		client.setQueryData(claudeAccountCapabilityQueryKey(hostUrl), {
			managed: true,
			configured: true,
		});
		client.setQueryData(claudeWorkspaceAccountStatesQueryKey(hostUrl), [
			{
				workspaceId: "workspace",
				state: "pinned",
				slug: "work",
				warning: null,
			},
		]);
		client.setQueryData(claudeAccountRosterQueryKey(hostUrl), {
			accounts: [rawAccount],
			trayDefaultSlug: "work",
		});
		let view!: ReturnType<typeof render>;
		await act(async () => {
			view = render(
				<QueryClientProvider client={client}>
					<ClaudeAccountSidebarProvider
						hostUrl={hostUrl}
						workspaceIds={["workspace"]}
						includeRoster
					>
						<SidebarValue />
					</ClaudeAccountSidebarProvider>
				</QueryClientProvider>,
			);
		});
		expect(
			JSON.parse(view.getByRole("status").textContent ?? "null"),
		).toMatchObject({
			fivePct: ACCOUNT.fivePct,
			sevenPct: rawAccount.sevenPct,
			fablePct,
			fablePace,
		});
		expect(
			client.getQueryData<ClaudeAccountRoster>(
				claudeAccountRosterQueryKey(hostUrl),
			),
		).toEqual({
			accounts: [{ ...ACCOUNT, ...overrides }],
			trayDefaultSlug: "work",
		});
	});
});
