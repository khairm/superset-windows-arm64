# Superset account switching

Per-workspace Claude account selection: each workspace bills its Claude sessions to a chosen account, hot-swappable while sessions run. The Pi (usage-display add-on in the home-assistant repo) owns all account credentials; the tray owns the machine default.

## Language

**Account**:
One Claude subscription identity, named by its slug (e.g. `msk`, `px`). Its credential lineage lives on the Pi and only the Pi may rotate it.
_Avoid_: profile, login, user

**Machine default**:
The account the tray has written into the shared global credentials file. Everything not managed by Superset uses it.
_Avoid_: global account, system account

**Workspace account state**:
Either Following (the workspace tracks the machine default live) or Pinned (fixed to one chosen account until changed or auto-fallback fires).
_Avoid_: override, binding

**Workspace profile folder**:
The Claude config folder every workspace owns from creation. Its credentials file decides which account all of that workspace's tabs bill to; its transcripts are the workspace's conversation history.
_Avoid_: config dir, tab folder

**Hotswap**:
Changing a workspace's account by rewriting its profile folder's credentials in place. Running sessions pick it up on their next request; nothing restarts.
_Avoid_: switch-and-restart

**Sentinel refresh token**:
The placeholder written in place of a real refresh token so no PC-side process can rotate (and kill) a Pi-owned lineage. Same value the tray uses.

**Keep-fresh**:
The background renewal that keeps every workspace profile folder's access token valid before it expires.

**Auto-fallback**:
A pinned workspace whose account crosses the trigger lines flips to Following, permanently (no re-pin when the account's window resets).

**Card exit**:
Marking a workspace Completed, Archived, Snoozed or deleted to the Recycle Bin. All four mean the user is done with the thread for now, so all four close its tabs, dispose its terminals and release its account back to Following. The worktree and branch survive; the runtime does not. Snooze is the temporary one, but its account release is still permanent: the thread comes back Following and re-pinning is a manual choice.
_Avoid_: hide, dismiss, close (those are display-only, and this is not)

**Runtime retirement**:
The host-side half of a card exit: kill the workspace's terminal sessions and release its pinned account. Requested by the desktop, done by the host that owns the workspace.

**Pending host cleanup**:
A card exit whose retirement the owning host has not yet confirmed — the owner was off, or a terminal would not die. Recorded on the workspace's own row so it survives an app restart, retried when the owner becomes reachable again, and cleared by that owner's confirmation or by proof that the workspace is gone. A host that does not own the workspace answering "not mine" never clears it. Un-exiting the card cancels it.
_Avoid_: dirty, unsynced

**Trigger lines**:
The tray-owned usage thresholds meaning "about to run out". One machine-wide definition, tuned only in the tray.

**Pace colour**:
How a percentage is coloured: by how its remaining budget compares to the time left in its window, not by the number alone. The tray, the round display and the app share the same bands.
_Avoid_: usage colour, threshold colour
