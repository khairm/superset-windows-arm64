import { describe, expect, test } from "bun:test";
import * as gitTaskModule from "./git.ts";
import { gitTasks } from "./git.ts";
import * as gitReadTaskModule from "./git-reads.ts";
import { gitReadTasks } from "./git-reads.ts";

function isWorkerTaskDefinition(
	value: unknown,
): value is { type: string; handler: unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string" &&
		typeof (value as { handler?: unknown }).handler === "function"
	);
}

const registries: Array<
	[string, Record<string, unknown>, ReadonlyArray<{ type: string }>]
> = [
	["gitTasks", gitTaskModule, gitTasks],
	["gitReadTasks", gitReadTaskModule, gitReadTasks],
];

describe.each(registries)("%s registry", (_name, module, registeredTasks) => {
	test("registers every exported worker task", () => {
		const exported = Object.entries(module)
			.filter(([, value]) => isWorkerTaskDefinition(value))
			.map(([name, value]) => ({
				name,
				type: (value as { type: string }).type,
			}));

		expect(exported.length).toBeGreaterThan(0);

		const registered = new Set(registeredTasks.map((task) => task.type));
		const missing = exported.filter((task) => !registered.has(task.type));

		expect(missing.map((task) => `${task.name} (${task.type})`)).toEqual([]);
	});

	test("has no duplicate task types", () => {
		const types = registeredTasks.map((task) => task.type);
		expect(types).toEqual([...new Set(types)]);
	});
});
