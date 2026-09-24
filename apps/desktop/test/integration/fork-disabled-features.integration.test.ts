import { describe, expect, test } from "bun:test";
import { createTestHost } from "../../../../packages/host-service/test/helpers/createTestHost";

describe("disabled host features (FORK-CHAT-V3-OFF) (FORK-PAGE-WATCH-OFF) (FORK-PORTS-OFF)", () => {
	test("chat and forwarding are absent while page-watch reads remain empty", async () => {
		const host = await createTestHost();
		const authorized = { headers: { authorization: `Bearer ${host.psk}` } };
		const pageId = "00000000-0000-4000-8000-000000000001";
		try {
			const chatSessions = await host.fetch(
				"http://host-service.test/chat-v3/trpc/sessions",
				authorized,
			);
			const portForwarding = await host.fetch(
				"http://host-service.test/fwd",
				authorized,
			);
			expect(chatSessions.status).toBe(404);
			expect(portForwarding.status).toBe(404);
			expect(
				await host.trpc.pageWatch.getAll.query({ workspaceId: "workspace" }),
			).toEqual([]);
			expect(
				await host.trpc.browser.list.query({ workspaceId: "workspace" }),
			).toEqual({ panes: [] });
			expect(await host.trpc.browser.importSources.query()).toEqual({
				sources: [],
			});
			await expect(
				host.trpc.browser.open.mutate({
					workspaceId: "workspace",
					url: "https://example.com",
				}),
			).rejects.toThrow("Browser panes are disabled");
			await expect(
				host.trpc.pageWatch.assign.mutate({
					pageId,
					slug: "report",
					title: "Report",
					workspaceId: "workspace",
					terminalId: "terminal",
					agentId: null,
				}),
			).rejects.toThrow("Page watching is disabled");
			await expect(
				host.trpc.pageWatch.unwatch.mutate({ pageId }),
			).rejects.toThrow("Page watching is disabled");
		} finally {
			await host.dispose();
		}
	});
});
