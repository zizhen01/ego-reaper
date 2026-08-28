# ego-reaper

Userland GC for leaked [ego-lite](https://github.com/citrolabs/ego-lite) agent task spaces.

ego lite ≤ 0.4.7.x reclaims agent task spaces only through a 12-hour app-side sweep, with no concurrency cap; a kill-heavy agent workload leaks dead spaces far faster than that, and every space window costs WindowServer compositing even when parked offscreen (upstream: citrolabs/ego-lite#270, citrolabs/ego-lite#339). This script closes leaked spaces from the outside, on a schedule, through the public `ego-browser` CLI.

It is a **stopgap**. Upstream is designing a browser-native lease/heartbeat lifecycle (citrolabs/ego-lite#271, citrolabs/ego-lite#341); this tool retires the day that ships.

## Rules

Only spaces with `ownership === "agent"` are ever touched — `user` and `agentDelegatedToUser` never are.

1. **dead-pid** — the space name embeds its creator pid (`…-<pid>` / `…-<pid>-<n>`) and that pid is dead → close now.
2. **idle** — `recentTabTitles` unchanged for `EGO_REAPER_IDLE_S` (default 2 h) → close. A space seen for the first time is only seeded, never closed on sight.
3. **over-cap** — more than `EGO_REAPER_MAX_SPACES` (default 8) agent spaces remain → close oldest-by-activity first, skipping live-pid lanes and freshly seeded spaces.

Caveats: a fixed space name that ends in digits (e.g. `report-2024`) parses as a pid — shield such names with `EGO_REAPER_PROTECT`. And the idle rule cannot distinguish a crashed agent from a live one parked on a static page; tune `EGO_REAPER_IDLE_S` to your workload.

## Safety posture

- Never cold-starts the app: if ego lite isn't running, exit 0 (a cold start would steal focus, citrolabs/ego-lite#284).
- Ownership is re-verified inside the close script right before each close — `completeTaskSpace(id, {keep: false})` would claim-and-close a user-owned space.
- Every `ego-browser` call runs under an external hard timeout (default 90 s; the embedded runtime can hang silently forever, citrolabs/ego-lite#306). A timed-out list aborts the whole cycle — never act on guessed state.
- pid liveness is judged in stock Node, outside the embedded runtime (whose `child_process` can silently return an empty process table, citrolabs/ego-lite#338).

## Usage

```bash
node ego-reaper.mjs --dry-run --verbose   # plan only, touch nothing
node ego-reaper.mjs                       # one real pass
```

Schedule with launchd (every 10 minutes; the script no-ops instantly when ego lite isn't running):

```bash
# First edit the node path and script path inside the plist.
cp com.ego-reaper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ego-reaper.plist
```

Uninstall: `launchctl unload ~/Library/LaunchAgents/com.ego-reaper.plist && rm ~/Library/LaunchAgents/com.ego-reaper.plist`

## Config (env)

| Variable | Default | Meaning |
|---|---|---|
| `EGO_REAPER_BIN` | `~/.local/bin/ego-browser` | ego-browser binary |
| `EGO_REAPER_IDLE_S` | `7200` | idle threshold (seconds) |
| `EGO_REAPER_MAX_SPACES` | `8` | agent-space cap |
| `EGO_REAPER_TIMEOUT_S` | `90` | per-invocation hard timeout |
| `EGO_REAPER_PROTECT` | (none) | regex of names never to touch |
| `EGO_REAPER_PID_PATTERN` | `-(\d{2,6})(?:-\d+)?$` | regex extracting the pid from a name |
| `EGO_REAPER_STATE_FILE` | `~/.local/share/ego-reaper/state.json` | activity-tracking state |
| `EGO_REAPER_LOG_FILE` | `~/.local/share/ego-reaper/reaper.log` | log |

State records `{firstSeen, lastChange, titlesHash}` keyed by `id:name`; entries for vanished spaces are pruned automatically.
