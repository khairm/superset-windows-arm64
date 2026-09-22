-- (MASTER-ALWAYS-ACTIVE) Upstream's desktop-v1.30.1 version of this migration
-- also rewrote every `type = 'main'` row to 'local' and renamed it to "local",
-- because upstream retired the main-workspace concept outright. This fork did
-- not: 'main' is the master row the sidebar, kanban and cleanup paths all
-- classify off, so rewriting it here would strand every existing install's
-- master and let the boot sweep mint an empty second row on the same checkout.
-- Only the index drop is taken.
DROP INDEX `workspaces_one_main_per_project`;
