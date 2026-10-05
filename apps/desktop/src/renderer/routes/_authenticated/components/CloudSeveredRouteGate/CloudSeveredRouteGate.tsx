import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Redirect } from "renderer/components/Redirect";
import {
	CLOUD_SEVERED_FALLBACK_ROUTE,
	isCloudSeveredRoute,
} from "renderer/lib/cloud-severed-routes";

const cloudSeveredRedirect = (
	<Redirect to={CLOUD_SEVERED_FALLBACK_ROUTE} replace />
);

/**
 * (CLOUD-SEVERANCE-P2) The one place a severed route is stopped. Every entry
 * point to them is gone, but a saved location or a deep link still arrives
 * here, as a render rather than a route load.
 *
 * (NAV-LOCAL-RENDER) A leaf, so a navigation re-renders only this and the
 * children keep their element identity. It reads the PENDING location, so a
 * severed route redirects before it commits.
 */
export function CloudSeveredRouteGate({ children }: { children: ReactNode }) {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	if (isCloudSeveredRoute(pathname)) return cloudSeveredRedirect;
	return children;
}
