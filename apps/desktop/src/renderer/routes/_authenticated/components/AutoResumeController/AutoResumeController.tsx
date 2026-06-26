// (AUTO-RESUME) App-level surface for the auto-resume subsystem. Subscribes to the
// AUTO_RESUME_STATE stream and shows coalesced toasts (stable per-session toast ids keep
// an account-wide rate-limit from spamming N toasts). Mounted in the authenticated layout
// alongside V2NotificationController (electronTrpc scope, no workspace provider needed).
import { toast } from "@superset/ui/sonner";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { NOTIFICATION_EVENTS } from "shared/constants";

function describeClass(failureClass?: string): string {
	switch (failureClass) {
		case "rate_limit_resume":
			return "a usage limit";
		case "rate_limit_transient":
			return "a temporary rate limit";
		case "server_error":
			return "a server error";
		case "connection_drop":
			return "a connection drop";
		case "half_stop":
			return "an interrupted response";
		case "auth":
			return "an auth error (run /login)";
		case "invalid_request":
			return "a request the API rejected";
		case "model_unavailable":
			return "an unavailable model";
		default:
			return "an API error";
	}
}

export function AutoResumeController(): null {
	electronTrpc.notifications.subscribe.useSubscription(undefined, {
		onData: (event) => {
			if (event.type !== NOTIFICATION_EVENTS.AUTO_RESUME_STATE) return;
			const d = event.data;
			if (!d) return;
			const id = d.sessionId ? `auto-resume-${d.sessionId}` : undefined;
			switch (d.kind) {
				case "armed": {
					const when = d.resumeAtMs
						? new Date(d.resumeAtMs).toLocaleTimeString()
						: null;
					toast("Auto-resume scheduled", {
						id,
						description: `Will retry after ${describeClass(d.failureClass)}${
							when ? ` · ${when}` : ""
						}. Click the terminal to take over.`,
					});
					break;
				}
				case "gaveUp":
					toast.warning("Auto-resume gave up", {
						id,
						description: "The chat is still stuck after retrying.",
					});
					break;
				case "notify":
					toast("A chat needs you", {
						id,
						description: `It hit ${describeClass(d.failureClass)} that won't auto-resume.`,
					});
					break;
				// sent / resolved / cancelled / skipped / disabled / rehandle: no toast
				default:
					break;
			}
		},
	});
	return null;
}
