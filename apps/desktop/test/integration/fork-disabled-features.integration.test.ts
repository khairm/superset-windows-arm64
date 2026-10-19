import { describe, expect, test } from "bun:test";
import { createTestHost } from "../../../../packages/host-service/test/helpers/createTestHost";
import {
	seedProject,
	seedPullRequest,
	seedWorkspace,
} from "../../../../packages/host-service/test/helpers/seed";

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

describe("disabled pull requests (FORK-PRS-OFF)", () => {
	test("a stored link reads empty and PR work refuses before it starts", async () => {
		const host = await createTestHost();
		const refused = {
			message: "Pull requests are disabled",
			data: { code: "PRECONDITION_FAILED" },
		};
		try {
			const { id: projectId } = seedProject(host, {
				repoPath: "/nonexistent/pr-off/project",
			});
			const { id: pullRequestId } = seedPullRequest(host, {
				projectId,
				prNumber: 42,
				headBranch: "feature/x",
			});
			const { id: workspaceId } = seedWorkspace(host, {
				projectId,
				worktreePath: "/nonexistent/pr-off/workspace",
				branch: "feature/x",
				pullRequestId,
			});

			expect(
				await host.trpc.pullRequests.getByWorkspaces.query({
					workspaceIds: [workspaceId],
				}),
			).toMatchObject({
				workspaces: [
					{ workspaceId, pullRequest: null, error: null, lastFetchedAt: null },
				],
			});
			expect(
				await host.trpc.git.getPullRequest.query({ workspaceId }),
			).toBeNull();
			expect(
				await host.trpc.workspaceCreation.searchPullRequests.query({
					projectId,
				}),
			).toEqual({
				pullRequests: [],
				totalCount: 0,
				hasNextPage: false,
				page: 1,
			});
			expect(
				await host.trpc.pullRequests.getLinkedWorkspace.query({
					projectId,
					prNumber: 42,
				}),
			).toEqual({ workspaceId: null });
			expect(
				await host.trpc.github.getPRStatus.query({
					owner: "octocat",
					repo: "hello",
					branch: "feature/x",
				}),
			).toBeNull();
			expect(
				await host.trpc.github.listPRs.query({
					owner: "octocat",
					repo: "hello",
				}),
			).toEqual([]);

			await expect(
				host.trpc.workspaces.create.mutate({ projectId, pr: 42 }),
			).rejects.toMatchObject(refused);
			await expect(
				host.trpc.pullRequests.getContent.query({ projectId, prNumber: 42 }),
			).rejects.toMatchObject(refused);
			await expect(
				host.trpc.git.getCheckJobLogs.query({
					workspaceId,
					detailsUrl: "https://github.com/octocat/hello/actions/runs/1/job/2",
				}),
			).rejects.toMatchObject(refused);
			await expect(
				host.trpc.github.getPR.query({
					owner: "octocat",
					repo: "hello",
					pullNumber: 42,
				}),
			).rejects.toMatchObject(refused);
		} finally {
			await host.dispose();
		}
	});
});
