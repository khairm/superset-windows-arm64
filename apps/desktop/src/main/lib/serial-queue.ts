export interface SerialQueue {
	<T>(job: () => Promise<T>): Promise<T>;
	/** Settles once everything queued so far has, whether it threw or not. */
	drained(): Promise<void>;
}

export function createSerialQueue(): SerialQueue {
	let tail: Promise<void> = Promise.resolve();

	return Object.assign(
		<T>(job: () => Promise<T>): Promise<T> => {
			const next = tail.then(job);
			tail = next.then(
				() => undefined,
				() => undefined,
			);
			return next;
		},
		{ drained: (): Promise<void> => tail },
	);
}
