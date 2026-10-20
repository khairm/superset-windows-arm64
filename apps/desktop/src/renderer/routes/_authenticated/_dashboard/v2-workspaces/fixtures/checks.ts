import { expect, test } from "bun:test";
import { Route, type V2WorkspacesSearch } from "../page";

test("(FORK-PRS-OFF) a ?pr= link never reaches the PR filter", () => {
	const validateSearch = Route.options.validateSearch as (
		search: Record<string, unknown>,
	) => V2WorkspacesSearch;

	const search = validateSearch({ pr: "open", q: "x" });

	expect(search.pr).toBeUndefined();
	expect(search.q).toBe("x");
});
