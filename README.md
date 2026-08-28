# ego-reaper

> **EN** — Userland GC for leaked [ego-lite](https://github.com/citrolabs/ego-lite) agent task spaces; a stopgap until upstream ships idle reclamation (citrolabs/ego-lite#270, PR #271). Rules: close agent-owned spaces whose creator pid (embedded in the space name) is dead; close spaces idle past a threshold, with activity inferred by hashing `recentTabTitles` between runs — `listTaskSpaces()` carries no timestamps; close oldest-first over a hard cap. Pid liveness is judged in stock Node **outside** the embedded runtime, which has been observed returning an empty `ps` with exit 0. It never touches `user` or `agentDelegatedToUser` spaces, re-verifies ownership right before each close (`completeTaskSpace(id, {keep:false})` would claim-and-close a user-owned space), never cold-starts the app, and puts a hard external timeout on every runtime call. Try `node ego-reaper.mjs --dry-run --verbose`; schedule with the bundled launchd plist.

ego-lite agent task space 的用户态 GC。上游(citrolabs/ego-lite)目前只有 app 侧 12 小时清理、无并发上限、`listTaskSpaces` 无时间戳(#270/#173,harness 侧修复挂在 PR #271 未合并);kill-heavy 的 agent 工作负载几小时就能攒下几十个死空间,每扇窗口即使在屏幕外也吃 WindowServer 合成(2026-08-28 事故:64 死空间,WindowServer 120%)。这个脚本从外部按规则收尸,上游落地后即可退役。

## 规则(只动 `ownership === "agent"`;`agentDelegatedToUser` 和 `user` 永不碰)

1. **dead-pid**:名字里嵌了创建者 pid(`…-<pid>` / `…-<pid>-<n>`)且 pid 已死 → 立即关。
2. **idle**:`recentTabTitles` 连续 `EGO_REAPER_IDLE_S`(默认 2h)没变 → 关。首次见到的空间只播种不收(与上游 PR #271 同款 first-sight 规则)。
3. **over-cap**:剩余 agent 空间 > `EGO_REAPER_MAX_SPACES`(默认 8)→ 从最久未活动的开始关,跳过活 pid 的 lane 和本轮新播种的。

pid 判活在**本地 stock Node** 做,绝不在 ego 嵌入运行时里做(那里 `ps` 出现过静默空表)。

## 安全设计

- app 没在跑 → 直接退出,绝不冷启动(冷启动会抢焦点,上游 #284)。
- 关闭前在 close 脚本里**逐个复核 ownership**——`completeTaskSpace(id, {keep:false})` 对 user-owned 空间会先 claim 再关,必须防 TOCTOU。
- 每次 `ego-browser` 调用有外部硬超时(默认 90s,runtime 会无限静默挂起,上游 #306/#307);LIST 超时则整轮放弃,绝不在猜测的状态上动手。
- 误报风险:固定名以数字结尾(如 `report-2024`)会被当成 pid;用 `EGO_REAPER_PROTECT` 正则保护。

## 用法

```bash
node ego-reaper.mjs --dry-run --verbose   # 只看计划,不动手
node ego-reaper.mjs                       # 真跑一轮
```

定时(launchd,每 10 分钟):

```bash
cp com.lucas.ego-reaper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.lucas.ego-reaper.plist
```

卸载:`launchctl unload ~/Library/LaunchAgents/com.lucas.ego-reaper.plist && rm ~/Library/LaunchAgents/com.lucas.ego-reaper.plist`

注意:plist 里的 node 路径钉在 fnm 的 v22.23.1 安装目录;换 node 版本后要同步改。

## 配置(env)

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

状态文件记录 `{firstSeen, lastChange, titlesHash}`,以 `id:name` 为键;空间消失后自动剪枝。
