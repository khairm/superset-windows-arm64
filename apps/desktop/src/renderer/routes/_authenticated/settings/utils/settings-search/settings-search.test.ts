import { describe, expect, it } from "bun:test";
import {
	getVisibleItemsForSection,
	getVisibleMatchCountBySection,
	SETTING_ITEM_ID,
	type SettingsItem,
	searchSettings,
} from "./settings-search";

function getIds(items: SettingsItem[]): string[] {
	return items.map((item) => item.id);
}

describe("settings search - font settings", () => {
	it('searching "font" returns both APPEARANCE_EDITOR_FONT and APPEARANCE_TERMINAL_FONT', () => {
		const results = searchSettings("font");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT);
	});

	it('searching "terminal font" returns APPEARANCE_TERMINAL_FONT', () => {
		const results = searchSettings("terminal font");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT);
	});

	it('searching "editor" returns APPEARANCE_EDITOR_FONT', () => {
		const results = searchSettings("editor");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT);
	});

	it('searching "monospace" returns both font items', () => {
		const results = searchSettings("monospace");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT);
	});

	it('searching "Editor Font" is case-insensitive', () => {
		const results = searchSettings("Editor Font");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT);
	});

	it("normalizes whitespace between search terms", () => {
		const results = searchSettings("  terminal   font  ");
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT);
	});

	it("empty search returns all settings items", () => {
		const results = searchSettings("");
		expect(results.length).toBeGreaterThan(0);
		const ids = getIds(results);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT);
		expect(ids).toContain(SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT);
	});

	it("font items have correct section", () => {
		const results = searchSettings("font");
		const editorFont = results.find(
			(r) => r.id === SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT,
		);
		const terminalFont = results.find(
			(r) => r.id === SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT,
		);

		expect(editorFont?.section).toBe("appearance");
		expect(terminalFont?.section).toBe("appearance");
	});
});

describe("settings search - hosts", () => {
	it('searching "delete host" returns the host deletion setting', () => {
		const ids = getIds(searchSettings("delete host"));

		expect(ids).toContain(SETTING_ITEM_ID.HOST_DELETE);
	});
});

describe("settings search - usage in sidebar", () => {
	it('searching "sidebar" in Usage returns the usage-in-sidebar switch for v2 users', () => {
		const ids = getVisibleItemsForSection({
			section: "usage",
			searchQuery: "sidebar",
			isV2: true,
		});
		expect(ids).toContain(SETTING_ITEM_ID.USAGE_IN_SIDEBAR);
	});

	it("hides the usage-in-sidebar switch from v1 users", () => {
		const ids = getVisibleItemsForSection({
			section: "usage",
			searchQuery: "sidebar",
			isV2: false,
		});
		expect(ids).not.toContain(SETTING_ITEM_ID.USAGE_IN_SIDEBAR);
	});

	it('searching "shortcut" matches the usage-in-sidebar item', () => {
		const ids = getIds(searchSettings("shortcut"));
		expect(ids).toContain(SETTING_ITEM_ID.USAGE_IN_SIDEBAR);
	});

	it("lists the usage-in-sidebar switch in Usage without a search for v2 users", () => {
		const ids = getVisibleItemsForSection({
			section: "usage",
			searchQuery: "",
			isV2: true,
		});
		expect(ids).toContain(SETTING_ITEM_ID.USAGE_IN_SIDEBAR);
	});
});

describe("settings search - mobile rollout", () => {
	it("excludes mobile matches until the feature flag is enabled", () => {
		expect(
			getVisibleMatchCountBySection("iPhone", true, false).mobile,
		).toBeUndefined();
		expect(
			getVisibleMatchCountBySection("iPhone", true, false, true).mobile,
		).toBe(1);
		expect(
			getVisibleMatchCountBySection("iPhone", false, false, true).mobile,
		).toBe(1);
	});
});

// (FORK-PORTS-OFF) (FORK-CHAT-V3-OFF)
describe("settings search - disabled features", () => {
	it("does not advertise hidden settings in search or the Experimental section", () => {
		for (const [query, id] of [
			[
				"Ports in top bar dropdown",
				SETTING_ITEM_ID.EXPERIMENTAL_INLINE_WORKSPACE_PORTS,
			],
			["Local chat pane", SETTING_ITEM_ID.EXPERIMENTAL_LOCAL_CHAT],
		] as const) {
			expect(getIds(searchSettings(query))).not.toContain(id);
			for (const searchQuery of [query, ""]) {
				expect(
					getVisibleItemsForSection({
						section: "experimental",
						searchQuery,
						isV2: true,
					}),
				).not.toContain(id);
			}
		}
	});
});
