import { afterAll, beforeEach, expect, test } from "bun:test";
import { useV2WorkspacesFilterStore } from "../../stores/v2WorkspacesFilterStore";
import { filterStateFromSearch } from "./filterStateFromSearch";

function resetStore() {
	useV2WorkspacesFilterStore.setState(
		useV2WorkspacesFilterStore.getInitialState(),
		true,
	);
}

beforeEach(resetStore);
afterAll(resetStore);

test("(FORK-PRS-OFF) a restored ?pr= link leaves the PR filter empty", () => {
	useV2WorkspacesFilterStore.setState(
		filterStateFromSearch({ q: "fix", pr: "open", agent: "working" }),
	);

	const state = useV2WorkspacesFilterStore.getState();
	expect(state.prStateFilters).toEqual([]);
	expect(state.searchQuery).toBe("fix");
	expect(state.agentStatusFilters).toEqual(["working"]);
});
