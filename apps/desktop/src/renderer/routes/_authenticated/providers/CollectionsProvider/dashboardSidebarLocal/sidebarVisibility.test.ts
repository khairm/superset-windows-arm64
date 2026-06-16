import { describe, expect, it } from "bun:test";
import {
	getWorkspaceSidebarBucket,
	isWorkspaceArchived,
} from "./sidebarVisibility";

// (MASTER-ARCHIVE-ONLY) The bucket classifier is what makes a removed master
// card recoverable: archiveWorkspace stamps archivedAt on the main, and the
// main must then bucket as "archived" (shown under the project's Archived
// section, unarchive-able) rather than vanishing into "hidden". These pure-
// function assertions lock that contract so a future change can't silently
// regress a master card back to hard-hidden.
describe("getWorkspaceSidebarBucket — master cards archive, never hard-hide", () => {
	const NOW = 1_000_000;

	it("buckets a master card with archivedAt as 'archived' (recoverable)", () => {
		expect(
			getWorkspaceSidebarBucket(
				{ isHidden: true, archivedAt: NOW },
				NOW,
				"main",
			),
		).toBe("archived");
		expect(
			isWorkspaceArchived({ isHidden: true, archivedAt: NOW }, "main"),
		).toBe(true);
	});

	it("keeps a master card hidden WITHOUT archivedAt out of 'archived'", () => {
		// Legacy/pre-fix hidden mains + the whole-project removal path set isHidden
		// with no timestamp — they must stay "hidden" (resurrect on reopen), never
		// surface as archived.
		expect(getWorkspaceSidebarBucket({ isHidden: true }, NOW, "main")).toBe(
			"hidden",
		);
		expect(isWorkspaceArchived({ isHidden: true }, "main")).toBe(false);
	});

	it("still archives a removed non-main thread (isHidden, no timestamp)", () => {
		expect(getWorkspaceSidebarBucket({ isHidden: true }, NOW, "branch")).toBe(
			"archived",
		);
	});

	it("completed precedence still wins over archived", () => {
		expect(
			getWorkspaceSidebarBucket(
				{ isHidden: true, archivedAt: NOW, completedAt: NOW },
				NOW,
				"branch",
			),
		).toBe("completed");
	});
});
