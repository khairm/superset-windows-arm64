import { createFileRoute, redirect } from "@tanstack/react-router";
import { DEFAULT_SETTINGS_ROUTE } from "renderer/lib/cloud-severed-routes";

export const Route = createFileRoute("/_authenticated/settings/")({
	beforeLoad: () => {
		// (CLOUD-SEVERANCE-P2) Appearance is the new front door: Account was the
		// upstream landing page and it is severed, so opening Settings would have
		// bounced straight back out to the workspace.
		throw redirect({ to: DEFAULT_SETTINGS_ROUTE, replace: true });
	},
});
