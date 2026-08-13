import { describe, expect, it } from "bun:test";
import { isKanbanEligibleWorkspace } from "./isKanbanEligibleWorkspace";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("isKanbanEligibleWorkspace", () => {
	it("(SESSION-LIFECYCLE) excludes a session — a card is always project-bound", () => {
		expect(
			isKanbanEligibleWorkspace({ projectId: null }, new Set([PROJECT_ID])),
		).toBe(false);
	});

	it("excludes a session even when the sidebar has no projects at all", () => {
		expect(isKanbanEligibleWorkspace({ projectId: null }, new Set())).toBe(
			false,
		);
	});

	it("includes a branch whose project is in the sidebar", () => {
		expect(
			isKanbanEligibleWorkspace(
				{ projectId: PROJECT_ID },
				new Set([PROJECT_ID]),
			),
		).toBe(true);
	});

	it("excludes a branch whose project was removed from the sidebar", () => {
		expect(
			isKanbanEligibleWorkspace({ projectId: PROJECT_ID }, new Set()),
		).toBe(false);
	});
});
