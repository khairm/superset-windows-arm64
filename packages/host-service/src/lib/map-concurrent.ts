export async function mapConcurrent<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error(
			`Concurrency limit must be a positive integer, got ${limit}`,
		);
	}
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (next < items.length) {
				const item = items[next] as T;
				next += 1;
				await fn(item);
			}
		},
	);
	const outcomes = await Promise.allSettled(workers);
	const failed = outcomes.find(
		(outcome): outcome is PromiseRejectedResult =>
			outcome.status === "rejected",
	);
	if (failed) throw failed.reason;
}
