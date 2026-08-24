# Changelog

## v0.15.0 (2026-08-24)

### /dream 用户命令：输入框手动唤起记忆整理
- 新增斜杠命令 `/dream`（dsh 命令平面 `commands.register`，**dsh 本体零改动、零客户端改动**）：在任意主会话输入框敲 `/dream` 即手动唤起本窗口 dream——逐轮回顾本窗口建立/提取过的记忆并封存。命令经 host 命令平面执行，不会发给模型；斜杠菜单自动列出（`commands.list` + `commands/change` 自动刷新）。
- 语义与手动 `memory_dream` 工具完全一致：直接启动、不受峰时抑制、不吃空闲检查；复用同一套租约防重复机制（已有任务进行中 → 明确报错不重复启动）。
- 结果反馈：启动成功 → success「🧠 dream 已安排」；子代理会话 / 无工作区 / 无会话 id / 租约占用 → error 文案说明原因。
- 注册健壮性：commands 服务是可选服务且可能晚于插件就绪（fiber 并发启动竞态）→ 立即尝试 + 1s×20 次重试；注册挂 `ctx.effect`，热重载/卸载自动注销防 duplicate。
- 新增 12 条测试（定义形状 / 成功路径 steer+租约 / 占用拒绝 / 空窗口 topic 轮照常触发 / 子代理与缺参守卫 / commands 服务接线），245 全绿。

## v0.14.0 (2026-08-23)

### 折叠 UI 异常快照防护（GitHub issue #2）
- 外部用户报告：`turnOf()` 无保护读 `node.location.kind`，节点缺 `location` 时抛 "Cannot read properties of undefined (reading 'kind')"，而 `computeFoldGroups()` 挂在每次快照渲染的 `useMemo` 里，异常会炸掉整个会话视图。修复：`turnOf()` 对 `location` 与 `location.turn` 均做缺失防护——缺失时与 `unresolved` 同路径降级为「不折叠、保持可见」，绝不抛错；展开卡片的 `enhanceClone()` 同步加防护（assistant 缺 `blocks` 按空数组、tool-call 缺 `root` 跳过增强）。
- 新增回归测试：无 `location` 的 context 节点排在正常节点之前，不抛异常且不影响后续组识别。

### 注入折叠假气泡对齐本体 + 复制按钮/时钟
- 首轮/命中注入折叠的用户 prompt 假气泡此前 token 用错（`--dsw-alias-bubble-user-bg`），颜色圆角字号与本体不一致且无操作按钮。重构为对齐 dsh 本体 `UserStyleBubble`（同 token `--dsw-specific-bubble`、22px 圆角、10px 16px padding、16px/24px 字号、`min(525px,82%)` 宽），主题切换自动跟随。
- 自绘复制按钮（SVG 同本体 IconCopyOutline16 path）：clipboard 写**用户 prompt 原文**（本体按钮的文本闭包含注入前缀，无法复用），失败回退 execCommand；成功后图标切对勾 1s。
- hover 显隐时间标签：`formatInjectionClock` 对齐本体 formatMessageClock 规则（同天 HH:mm / 今年 M月D日 HH:mm / 跨年加年份）。

### 热重载 style 堆积修复
- CSS 常驻 style 在热重载 dispose 时不被删除，多代规则堆积后旧代规则（如假气泡时代 `[data-meow-injection-prompt] > div` 背景）以同等特异性命中新 DOM——注入操作行灰底根因。现在 client 与 dream-icon 注入前先移除本插件旧 style 标签，任意时刻只有一份最新规则。

### 测试夹具脱敏
- test.mjs / smoke.mjs 记忆内容夹具中的真实邮箱替换为 example.com 占位。

## v0.13.0 (2026-08-23)

### dream 触发规则改版（用户拍板）
- **夜间窗口废弃**：不再要求 00:00–07:00 才触发；改为**窗口空闲 ≥ 3 小时**（`idleMinutes` 默认 180）即进入允许触发状态。
- **峰时抑制**：新增 `suppressWindows`（默认 `09:00-12:00`、`14:00-18:00`，API 峰谷电价峰时，按 `timeZone` 计算）与 `suppressLeadMinutes`（默认 15）——峰时及其开始前 15 分钟内不触发 dream，峰时结束后下一个检查周期自动触发；进行中的 dream 不打断，只挡新启动。
- 新增 `minutesInTimeZone` / `isDreamSuppressed`（分钟级时区换算，支持跨午夜时段）。
- 删除死配置 `minIntervalHours`；`windowStart`/`windowEnd` 移除（夜间窗口概念废弃）。
- 手动 `memory_dream` 不受峰时抑制（用户主动触发，成本自担）。
- 文案同步：MEMORY_GUIDE / 工具描述 / 启动日志 / README 双语。
- 顺带修：v0.13.0 改版时旧夜间时代的「全局 lastActivity 门」没被移除，任意窗口活跃会挡死所有窗口的 dream——已删除，空闲判定完全回到窗口级 `last_event_time`。

### dream 整理 prompt 增强（2026-08-22）
- **第三轮「项目总结」**：dream 从两轮变三轮——原子记忆 → topic → 项目总结；第三轮仅当本窗口涉及具体项目时追加，要求 AI 逐个调 `memory_project` 复查并把啰嗦冗杂的项目描述总结成精简条目（其他窗口首先看到的项目长期记忆），被取代的旧条目归档（未完成 todo/独特教训保留不强折）。
- 新增三条整理规则：被推翻/被改掉/被证明无效的设计和信息 → 归档（stale 只表示「完结」，留库误导）；importance 防虚标（工作进展 1 最多 2，很严重才 3）；原子轮首加「逐条检查过时/误导记忆，优先归档」义务。
- ATOMIC_GUIDE 12→13 条、TOPIC_GUIDE 10→11 条。

### 反思轮折叠 UI 修复：复制/点赞行不再被误藏
- 反思 prompt 经 `agent/turn-stopping` steer 注入，dsh 契约是**延续同一个 turn**——正常轮与反思轮共用唯一的 turn-tail footer（AI 回答下方复制/点赞/耗时整行）。折叠范围过滤此前只排除 user/steering，把这行也藏掉了。现在 `computeFoldGroups` 排除 `turn-tail` 节点，操作行保持可见（显示在折叠横条下方）。

## v0.12.0 (2026-08-19)

### memory_search 结果构成改版（用户拍板）
- **5+5 分段**：默认 top 10 = 前 5 条按相关度**无脑取**（不排除任何记忆，包括已注入/已检索/本 session 建立的）+ 后 5 条从排名第 6 名起逐个往下、**绕开已见**（injected+searched）的记忆补齐——保证最相关的不被"已在上下文里"排除，同时保留新信息。
- 旧规则「已注入/已检索过的不检索」「不检索本 session 建立的记忆」从 `memory_search` 移除（命中注入链路不变，仍去重）；k<5 时全部盲取，k>10 时前 5 盲取、其余绕开已见补齐。
- 工具描述 / MEMORY_GUIDE / README 双语同步。
- 顺带修：检索命中"未标记（project=null）"条目时输出校验报 `project must be a string` → 输出改 `''`（与 memory_read 一致，`projectLabel('')`=未标记）。

### memory_project 必填文案强化（用户反馈 AI 常漏传 project）
- MEMORY_GUIDE 该段改为「你要看哪个项目的信息？必须提供项目名称作为参数。」；工具 description 加必填行；首轮导引加「记得带上项目名，不能空参」；README 双语同步。

### 会话列表"已 dream"小月牙图标（用户拍板）
- 左侧会话列表中，dream 整理过记忆且之后无新对话新信息的会话行最左侧显示 10px 静态小月牙（与 dsh 状态点同尺寸/同配色体系，无动画）。**dsh 本体零改动**。
- 数据**事件驱动无轮询**：host 新增 `/meow-memory/dream-events` SSE 长连接（dream 完成推 `dreamed:true`、会话有新活动推 `dreamed:false`）+ `/meow-memory/dreamed-sessions` 全量快照（client 挂载/断线重连时对账一次）；dream 完成判定 = windows 表 `last_dream_time` 非空且之后无活动。
- 行定位读 React 18 fiber（`__reactFiber$` 内部属性，DevTools 同款机制）拿行渲染 key = session id——精确匹配，不依赖标题；找不到 fiber 静默降级。
- 双实例限制：SSE 只在当前实例广播，跨实例的 dream 完成靠断线重连/挂载对账补齐。
- 测试：`collectDreamStates`（test.mjs，dreamed/dreaming 双态）+ `readSessionId`/`applyDreamIcons`（新 tests/client-dream-icon.mjs，14 断言）。
- 三态与视觉定稿（用户反馈迭代）：①图标改**淡黄色**，dream 进行中显示**白→金呼吸灯动画**（替换 dsh 运行中蓝色动画，避免混淆），完成后停留淡黄；②图标放进 dsh 会话行的**状态槽位**（替换槽内内容，标题零位移）；③SSE 协议扩展为 `state: dreaming/dreamed/active`，快照返回 `{ sessionIds, dreamingIds }`（活跃租约 = dream 进行中）；④路由注册挂 `ctx.effect`（热重载自动注销）+ apply 错误落盘日志。
- **webServer 启动竞态修复**（3080 重启后实测）：fiber 并发启动时 webServer 服务可能晚于插件就绪 → 路由未注册、SPA fallback 接管（工具正常但数据路由缺失）。路由注册改为立即尝试 + 每 1s 重试（最多 20 次），dispose 清理定时器。

## v0.11.0 (2026-08-19)

### dream 两轮制改版
- dream 由「按 project 逐轮」改为**固定两轮**：第 1 轮 = 原子记忆（project/fact/lesson/rules/soul/user），第 2 轮 = topic 记忆；所有 project 混排、`【project：xxx】` 小标题分段、无项目段收尾；空轮跳过。
- 记忆范围 = **本窗口建立的 ∪ 本窗口提取过的**（sessions 文件 injected+searched），不再只整理本窗口自己的。
- 条目展示绝对时间戳（最后更新时间）+ **关键词行**（AI 核查/重写关键词用）。
- 原子轮判断清单 1-12（过时 / 完成 / 琐碎 / bug 修复后 lesson 失效 / 矛盾 / importance / 拆分 / 关键词 / project 标签 / 抽象泛化 / 首轮注入核查 / 项目全景范围）；topic 轮介绍段 + 更新指导 1-9（拆分 / 合并 / 交叉重写）。

### 显示面定稿
- 全链路展示**完整 id**（36 位）；`memory_search` = 检索元数据视图（归属 + 完整 id + 相对时间 + 「关于：关键词」）；命中注入 / `memory_project` = 原文视图（归属 + 完整 id + 绝对/相对时间 + 全文）。
- **project 归属约定**：全局信息填 `"全局"`（与留空=未标记区分）；多项目用英文逗号分隔；检索/命中按「包含当前项目名 或 全局」判定；项目列表自动展开。
- `memory_search` 的 project/status 支持逗号多选（OR 语义）；importance 不设硬上限（软引导 1-4）。

### 反思与记忆手册
- 反思 prompt 终稿：【一】新记忆（project 列表 / 纠正 / 偏好）、【二】更新判断（过时 / 错误 / 完成 / 关键词不准反推）、【三】通用要求；topic 归 dream 轮处理。
- `MEMORY_GUIDE`（system prompt）重写：记忆数据总览 + 工具用法 + 写作准则（content / keywords / importance / status / project）。

### 工具行为
- `memory_remember` **四必填**（content/project/keywords/importance），缺失逐个报错并引导重填；title 参数从工具 schema 移除（db 列保留，后续删除）。
- `memory_update`：project 传空字符串 = 清空归属（未标记）；keywords 空数组 = 不更新（防误清空）；importance 不设上限。
- 修 bug：`RankedHit` 缺 `updated_at` 字段 → search 按记忆时间戳重排从未生效。

## v0.10.0 (2026-08-18)
- dream 租约（owner/progress/advance/recover）；prompt 状态语义定稿（stale=done，archived=delete）。

## v0.9.0 (2026-08-16)
- 注入折叠 UI；dream 防重复闭环（check 门/原子抢占/中断自愈/孤儿收尾）；windowIndex 持久化；fork 会话注入修复；bundles 装配。

## v0.8.x (2026-08-16)
- v0.8.0：记忆关键词改 LLM 提取；命中打分公式（交集 × idf × 覆盖率 × 艾宾浩斯 × importance × title 加成）。
- v0.8.1：发布流程规范化（Release + tgz 附件）+ README 双语同步。

## v0.7.0 (2026-08-16)
- `dream_at` 改名 `updated_at`（记忆时间戳 = 最后更新时间，列合并迁移）。

## v0.6.x (2026-08-16)
- v0.6.0：rules 层（设计原则/行为准则）；当前 project 锚定；每消息关键词命中。
- v0.6.1：project 锚定（sessions 文件 currentProject）。
- v0.6.2：每消息命中链路（非首轮专属）。
- v0.6.3：命中改 keywords 制（匹配条目关键词而非全文）。
- v0.6.4：首轮注入新格式 + dream idle 持久化判定。
- v0.6.5：命中条目时间信息。

## v0.5.x (2026-08-16)
- v0.5.0：导引 topic 带归属；反思/dream 规则带 project 参数。
- v0.5.1：压缩信号释放 seen（允许压缩后再次命中）。

## v0.4.x (2026-08-16)
- v0.4.0：`memory_project` 工具（项目全景段落）。
- v0.4.1：导引动态项目列表（`listProjectNames`）。

## v0.3.x (2026-08-16)
- v0.3.0：反思/dream 轮 UI 折叠（纯 client 插件）。
- v0.3.1：折叠改向下展开大卡片。

## v0.2.0 (2026-08-16)
- 记忆手册进 system prompt（order 130，KV 缓存友好）；README 双语。

## v0.1.0 (2026-08-15)
- 首版发布：七层 SQLite 记忆、首轮注入、夜间 dream。
