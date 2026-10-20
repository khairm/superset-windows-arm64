/**
 * Question items for the answer-path suites. NOT a test file: nothing here
 * asserts, and the name keeps it out of bun's `*.test.ts` glob.
 */

import type { QuestionItem } from "./types";

function options(count: number): QuestionItem["options"] {
	return Array.from({ length: count }, (_, index) => ({
		index,
		label: String.fromCharCode(65 + index),
		description: `Option ${String.fromCharCode(65 + index)}`,
	}));
}

export function singleItem(index: number, optionCount = 3): QuestionItem {
	return {
		index,
		header: `Q${index + 1}`,
		question: `Choose experiment Q${index + 1}?`,
		multiSelect: false,
		options: options(optionCount),
		freeTextOption: { index: optionCount, label: "Type something." },
	};
}

export function multiItem(index: number, optionCount = 3): QuestionItem {
	return {
		...singleItem(index, optionCount),
		multiSelect: true,
		freeTextOption: { index: optionCount, label: "Type something" },
	};
}
