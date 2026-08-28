# ego-reaper

**English** | [中文](#中文说明)

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

---

## 中文说明

[ego-lite](https://github.com/citrolabs/ego-lite) 泄漏 agent task space 的用户态 GC。

ego lite ≤ 0.4.7.x 只有 app 侧 12 小时清理、无并发上限;频繁 kill 的 agent 工作负载攒死空间的速度远快于此,而每扇空间窗口即使停在屏幕外也消耗 WindowServer 合成(上游:citrolabs/ego-lite#270、citrolabs/ego-lite#339)。本脚本通过公开的 `ego-browser` CLI 从外部定时收尸。

这是**临时方案**:上游正在设计浏览器原生的 lease/heartbeat 生命周期(citrolabs/ego-lite#271、citrolabs/ego-lite#341),落地即退役。

### 规则

只动 `ownership === "agent"` 的空间,`user` 和 `agentDelegatedToUser` 永不碰。

1. **dead-pid** — 空间名嵌有创建者 pid(`…-<pid>` / `…-<pid>-<n>`)且该 pid 已死 → 立即关。
2. **idle** — `recentTabTitles` 连续 `EGO_REAPER_IDLE_S`(默认 2 小时)未变 → 关。首次见到的空间只播种,绝不见面即关。
3. **over-cap** — 剩余 agent 空间超过 `EGO_REAPER_MAX_SPACES`(默认 8)→ 从最久未活动的关起,跳过活 pid 的 lane 和本轮新播种的。

注意:固定名以数字结尾(如 `report-2024`)会被当成 pid,用 `EGO_REAPER_PROTECT` 正则保护;idle 规则无法区分"崩溃的 agent"和"活着但页面静止的 agent",请按工作负载调 `EGO_REAPER_IDLE_S`。

### 安全设计

- 绝不冷启动:app 没在跑就直接退出(冷启动会抢焦点,citrolabs/ego-lite#284)。
- 关闭前在 close 脚本内逐个复核 ownership — `completeTaskSpace(id, {keep: false})` 对 user 空间会先 claim 再关。
- 每次 `ego-browser` 调用有外部硬超时(默认 90 秒;嵌入运行时会无限静默挂起,citrolabs/ego-lite#306);LIST 超时则整轮放弃,绝不在猜测的状态上动手。
- pid 判活在本地 stock Node 做,不在嵌入运行时里做(那里 `child_process` 会静默返回空进程表,citrolabs/ego-lite#338)。

### 用法

```bash
node ego-reaper.mjs --dry-run --verbose   # 只看计划,不动手
node ego-reaper.mjs                       # 真跑一轮
```

launchd 定时(每 10 分钟;ego lite 没在跑时脚本瞬间空转退出):

```bash
# 先改 plist 里的 node 路径和脚本路径。
cp com.ego-reaper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ego-reaper.plist
```

卸载:`launchctl unload ~/Library/LaunchAgents/com.ego-reaper.plist && rm ~/Library/LaunchAgents/com.ego-reaper.plist`

### 配置(env)

| 变量 | 默认 | 含义 |
|---|---|---|
| `EGO_REAPER_BIN` | `~/.local/bin/ego-browser` | ego-browser 二进制 |
| `EGO_REAPER_IDLE_S` | `7200` | 闲置阈值(秒) |
| `EGO_REAPER_MAX_SPACES` | `8` | agent 空间上限 |
| `EGO_REAPER_TIMEOUT_S` | `90` | 单次调用硬超时 |
| `EGO_REAPER_PROTECT` | (空) | 永不碰的名字正则 |
| `EGO_REAPER_PID_PATTERN` | `-(\d{2,6})(?:-\d+)?$` | 从名字提取 pid 的正则 |
| `EGO_REAPER_STATE_FILE` | `~/.local/share/ego-reaper/state.json` | 活动追踪状态 |
| `EGO_REAPER_LOG_FILE` | `~/.local/share/ego-reaper/reaper.log` | 日志 |

状态文件以 `id:name` 为键记录 `{firstSeen, lastChange, titlesHash}`,空间消失后自动剪枝。
