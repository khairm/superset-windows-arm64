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

**Trigger lines**:
The tray-owned usage thresholds meaning "about to run out". One machine-wide definition, tuned only in the tray.
