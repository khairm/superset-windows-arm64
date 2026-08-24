import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
	type ClaudeWorkspaceAccountState,
	type ClaudeWorkspaceAccountStates,
	claudeWorkspaceAccountStateQueryKey,
	claudeWorkspaceAccountStatesQueryKey,
	updateClaudeWorkspaceAccountStateCaches,
} from "./claudeAccountCache";

const HOST_URL = "http://localhost:1234";
const EXISTING_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NEW_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

describe("updateClaudeWorkspaceAccountStateCaches", () => {
	test("appends a new workspace to an existing host snapshot", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(claudeWorkspaceAccountStatesQueryKey(HOST_URL), [
			{
				workspaceId: EXISTING_WORKSPACE_ID,
				state: "following",
				slug: null,
				warning: null,
			},
		]);

		updateClaudeWorkspaceAccountStateCaches(
			queryClient,
			HOST_URL,
			NEW_WORKSPACE_ID,
			(current) => current,
			{ state: "pinned", slug: "work", warning: null },
		);

		expect(
			queryClient.getQueryData<ClaudeWorkspaceAccountStates>(
				claudeWorkspaceAccountStatesQueryKey(HOST_URL),
			),
		).toEqual([
			{
				workspaceId: EXISTING_WORKSPACE_ID,
				state: "following",
				slug: null,
				warning: null,
			},
			{
				workspaceId: NEW_WORKSPACE_ID,
				state: "pinned",
				slug: "work",
				warning: null,
			},
		]);
		expect(
			queryClient.getQueryData<ClaudeWorkspaceAccountState>(
				claudeWorkspaceAccountStateQueryKey(HOST_URL, NEW_WORKSPACE_ID),
			),
		).toEqual({ state: "pinned", slug: "work", warning: null });
	});

	test("reports a missing entry when no fallback state is available", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(
			claudeWorkspaceAccountStatesQueryKey(HOST_URL),
			[],
		);

		const found = updateClaudeWorkspaceAccountStateCaches(
			queryClient,
			HOST_URL,
			NEW_WORKSPACE_ID,
			(current) => ({
				...current,
				warning: { kind: "credential-health", message: "Sign in again" },
			}),
		);

		expect(found).toBe(false);
		expect(
			queryClient.getQueryData<ClaudeWorkspaceAccountStates>(
				claudeWorkspaceAccountStatesQueryKey(HOST_URL),
			),
		).toEqual([]);
	});
});
