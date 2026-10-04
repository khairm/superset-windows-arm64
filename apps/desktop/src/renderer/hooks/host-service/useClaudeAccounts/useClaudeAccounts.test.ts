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

const FOLLOWING: ClaudeWorkspaceAccountState = {
	state: "following",
	slug: null,
	warning: null,
	autoSwitch: true,
	schedule: null,
};

describe("updateClaudeWorkspaceAccountStateCaches", () => {
	test("invalidates instead of inventing a missing workspace entry", () => {
		const queryClient = new QueryClient();
		const statesKey = claudeWorkspaceAccountStatesQueryKey(HOST_URL);
		const existing = { ...FOLLOWING, workspaceId: EXISTING_WORKSPACE_ID };
		queryClient.setQueryData<ClaudeWorkspaceAccountStates>(statesKey, [
			existing,
		]);

		updateClaudeWorkspaceAccountStateCaches(
			queryClient,
			HOST_URL,
			NEW_WORKSPACE_ID,
			(current) => ({ ...current, state: "pinned", slug: "work" }),
		);

		expect(
			queryClient.getQueryData<ClaudeWorkspaceAccountStates>(statesKey),
		).toEqual([existing]);
		expect(queryClient.getQueryState(statesKey)?.isInvalidated).toBe(true);
		expect(
			queryClient.getQueryData(
				claudeWorkspaceAccountStateQueryKey(HOST_URL, NEW_WORKSPACE_ID),
			),
		).toBeUndefined();
	});

	test("updates an existing entry in both caches without invalidating", () => {
		const queryClient = new QueryClient();
		const statesKey = claudeWorkspaceAccountStatesQueryKey(HOST_URL);
		const stateKey = claudeWorkspaceAccountStateQueryKey(
			HOST_URL,
			EXISTING_WORKSPACE_ID,
		);
		queryClient.setQueryData<ClaudeWorkspaceAccountStates>(statesKey, [
			{ ...FOLLOWING, workspaceId: EXISTING_WORKSPACE_ID },
		]);
		queryClient.setQueryData<ClaudeWorkspaceAccountState>(stateKey, FOLLOWING);

		const warning = {
			kind: "credential-health",
			message: "Sign in again",
		} as const;
		updateClaudeWorkspaceAccountStateCaches(
			queryClient,
			HOST_URL,
			EXISTING_WORKSPACE_ID,
			(current) => ({ ...current, warning }),
		);

		expect(
			queryClient.getQueryData<ClaudeWorkspaceAccountState>(stateKey),
		).toEqual({ ...FOLLOWING, warning });
		expect(
			queryClient.getQueryData<ClaudeWorkspaceAccountStates>(statesKey),
		).toEqual([{ ...FOLLOWING, warning, workspaceId: EXISTING_WORKSPACE_ID }]);
		expect(queryClient.getQueryState(statesKey)?.isInvalidated).toBe(false);
		expect(queryClient.getQueryState(stateKey)?.isInvalidated).toBe(false);
	});
});
