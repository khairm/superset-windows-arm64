import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useSettingsStore } from "renderer/stores/settings-state";

// (NAV-LOCAL-RENDER) A leaf, so tracking the route does not re-render the
// provider stack above every page.
export function OriginRouteTracker() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const setOriginRoute = useSettingsStore((s) => s.setOriginRoute);

	useEffect(() => {
		if (!pathname.startsWith("/settings")) {
			setOriginRoute(pathname);
		}
	}, [pathname, setOriginRoute]);

	return null;
}
