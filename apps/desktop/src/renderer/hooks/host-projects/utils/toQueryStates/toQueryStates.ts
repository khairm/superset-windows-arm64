import type { UseQueryResult } from "@tanstack/react-query";

export function toQueryStates<T>(results: UseQueryResult<T>[]) {
	return results.map((result) => ({
		data: result.data,
		isSuccess: result.isSuccess,
		isError: result.isError,
	}));
}
