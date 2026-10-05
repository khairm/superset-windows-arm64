import {
	type ParsedLocation,
	type RegisteredRouter,
	type RouterState,
	useRouterState,
} from "@tanstack/react-router";

// (NAV-LOCAL-RENDER) Primitive route reads that mirror router.matchRoute, so a
// navigation re-renders only the components whose answer changed.

type MatchableState = Pick<
	RouterState,
	"isLoading" | "location" | "resolvedLocation"
>;

type Primitive = string | number | boolean | null | undefined;

export function matchLocation(state: MatchableState): ParsedLocation {
	return state.isLoading
		? (state.resolvedLocation ?? state.location)
		: state.location;
}

function paramAfter(
	path: string,
	segment: string,
	fuzzy: boolean,
): string | null {
	const parts = path.split("/");
	if (parts[1]?.toLowerCase() !== segment) return null;
	const raw = parts[2];
	if (!raw) return null;
	if (!fuzzy && parts.length !== 3) return null;
	return decodeURIComponent(raw);
}

export function v2WorkspaceIdOf(
	path: string,
	{ fuzzy }: { fuzzy: boolean },
): string | null {
	return paramAfter(path, "v2-workspace", fuzzy);
}

export function v1WorkspaceIdOf(path: string): string | null {
	return paramAfter(path, "workspace", true);
}

export function isUnder(path: string, base: string): boolean {
	const p = path.toLowerCase();
	return p === base || p.startsWith(`${base}/`);
}

export function isExactly(path: string, base: string): boolean {
	return path.toLowerCase() === base;
}

export function useActiveRoute<T extends Primitive>(
	select: (
		matched: ParsedLocation,
		state: RouterState<RegisteredRouter["routeTree"]>,
	) => T,
): T {
	return useRouterState<RegisteredRouter, Primitive, false>({
		select: (state) => select(matchLocation(state), state),
	}) as T;
}
