import { describe, expect, it } from "bun:test";
import { commandPathOf } from "./plugin";

describe("commandPathOf", () => {
	it("splits Windows and POSIX separators into the command path", () => {
		expect(commandPathOf("workspaces\\list\\command.ts")).toEqual([
			"workspaces",
			"list",
		]);
		expect(commandPathOf("workspaces/list/command.ts")).toEqual([
			"workspaces",
			"list",
		]);
	});
});
