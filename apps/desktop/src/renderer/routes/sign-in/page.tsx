/**
 * (CLOUD-SEVERANCE-P2) The sign-in screen is gone.
 *
 * The route itself stays registered — it is generated into the route tree, and
 * older windows, saved locations and stray `/sign-in` navigations still resolve
 * here — but there is nothing to sign into: no Google, no GitHub, no dev
 * email/password against `api.superset.sh`. Anyone who lands here is sent
 * straight to their workspace, which is where they were going anyway.
 */

import { createFileRoute } from "@tanstack/react-router";
import { Redirect } from "renderer/components/Redirect";

export const Route = createFileRoute("/sign-in/")({
	component: SignInPage,
});

function SignInPage() {
	return <Redirect to="/workspace" replace />;
}
