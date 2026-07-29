import { router } from "../index";
import { acpSessionsRouter } from "./acp-sessions";
import { agentsRouter } from "./agents";
import { attachmentsRouter } from "./attachments";
import { authRouter } from "./auth";
import { chatRouter } from "./chat";
import { cloudRouter } from "./cloud";
// (COMPANION-ROUTER-MOUNT) fork-only: the desktop-side pairing + panic surface.
// This token is registered in FEATURES.md against THIS file, not against the
// companion/ directory — a marker satisfied only by fork-only files cannot
// notice when a merge drops the seam that reaches them. Without this mount the
// pairing window and the panic switch are unreachable code.
import { companionRouter } from "./companion";
import { configRouter } from "./config";
import { filesystemRouter } from "./filesystem";
import { gitRouter } from "./git";
import { githubRouter } from "./github";
import { healthRouter } from "./health";
import { hostRouter } from "./host";
import { issuesRouter } from "./issues";
import { notificationsRouter } from "./notifications";
import { portsRouter } from "./ports";
import { projectRouter } from "./project";
import { pullRequestsRouter } from "./pull-requests";
import { settingsRouter } from "./settings";
import { terminalRouter } from "./terminal";
import { terminalAgentsRouter } from "./terminal-agents";
import { workspaceRouter } from "./workspace";
import { workspaceCleanupRouter } from "./workspace-cleanup";
import { workspaceCreationRouter } from "./workspace-creation";
import { workspacesRouter } from "./workspaces";

export const appRouter = router({
	acpSessions: acpSessionsRouter,
	agents: agentsRouter,
	attachments: attachmentsRouter,
	auth: authRouter,
	health: healthRouter,
	host: hostRouter,
	chat: chatRouter,
	// (COMPANION-ROUTER-MOUNT) fork-only.
	companion: companionRouter,
	config: configRouter,
	filesystem: filesystemRouter,
	git: gitRouter,
	github: githubRouter,
	cloud: cloudRouter,
	issues: issuesRouter,
	notifications: notificationsRouter,
	pullRequests: pullRequestsRouter,
	project: projectRouter,
	ports: portsRouter,
	settings: settingsRouter,
	terminal: terminalRouter,
	terminalAgents: terminalAgentsRouter,
	workspace: workspaceRouter,
	workspaces: workspacesRouter,
	workspaceCleanup: workspaceCleanupRouter,
	workspaceCreation: workspaceCreationRouter,
});

export type AppRouter = typeof appRouter;
