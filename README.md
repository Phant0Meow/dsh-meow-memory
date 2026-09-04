# meow-memory 🐱📝

| [中文](README.md) | [English](README.en.md) | [MIT License](LICENSE) |
| :---: | :---: | :---: |

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的跨会话记忆插件。


**核心理念**：每个工作区维护一份结构化记忆数据库（`.dsh-meow/memory.db`，基于 `node:sqlite`）。
静态记忆手册（数据总览 + 工具用法 + 写作准则）以固定 section 的形式放在 **system prompt** 里——
文本恒定，因此不会破坏 LLM provider 的 KV/上下文缓存。动态内容（soul/user 全量、设计原则、
记忆导引）作为**第一条用户消息的前缀**注入，且首轮只注入长期记忆、不做关键词命中；
从第二轮起每条用户消息做关键词命中（top-2）。模型按需用 `memory_search` /
`memory_project` 深入检索。每个窗口由自己的主 agent 在空闲时（"dream"）整理记忆
（本窗口建立 + 提取过的记忆），以窗口最后一次对话时间戳冻结其知识。

## ✨ 功能特性

- **七层记忆**（`soul` = AI 自身 / `user` = 用户基本信息与偏好 / `project` = 项目信息，
  含 `subcategory`（overview/structure/decisions/quotes/ops/todo）/ `fact` = 原子事实 /
  `lesson` = 教训与纠正 / `topic` = 进行中的讨论话题，带目标句 / `rules` = 设计原则与行为准则）。
  每层一张 SQLite 表，UUID 带时间前缀，id 顺序即创建顺序。
- **首轮注入（长期记忆块）**：第一条用户消息前注入固定格式
  `===== 长期记忆 =====` → `【关于你】`（soul 全量）→ `【关于user】`（user 全量）→
  `【设计原则】`（全局 rules 且 importance≥2，少而精的命令式准则）→ `【记忆导引】`
  （用法说明 + 「用户的所有 project」动态列表，供 `memory_project` 选用）。
  记忆作为独立 plugin snapshot 消息放在真实 user 消息之前，不改写用户 prompt。
  **首轮不跑关键词命中**（命中从第二轮起）。即使首条用户消息与插件通知消息同批到达
  （如 approval policy 变更通知），快照仍会紧贴插入到真实用户消息之前、命中绝不提前。
- **每消息关键词命中**：从第二条用户消息起，每条真实用户消息都检索
  fact/lesson/rules/topic（范围 = 全局 + 当前 project 锚定），top-2 命中以
  「可能相关的记忆，仅供参考：」前缀注入。命中基于**条目关键词**（LLM 提取或自动
  bigram）而非全文——全文匹配噪音大。打分 = 交集分 × idf × 覆盖率 × 艾宾浩斯衰减
  （按记忆时间戳）× importance 权重 × title 加成。
- **当前 project 锚定**：`memory_remember/search/update/project` 带 project 参数即锚定
  该会话的当前项目；未锚定时命中只搜全局（用户闲聊不误伤）。
- **缓存友好设计**：静态 `meow-memory:guide` section（order 130，紧随各 `tool:*` 说明之后）
  在 system prompt 中注册一次——文本恒定，KV 缓存友好。已见记忆（`injected` + `searched`）
  按会话记录（`.dsh-meow/sessions/<id>.json`）：注入绝不重复；`memory_search` 前 5 条按相关度
  无脑取（不排除已见/本 session 建立的记忆），其余从排名后续绕开已见补齐；收到会话压缩
  信号（`compaction/*`）时释放已见记录，允许压缩后被再次命中提取。
- **压缩后重注入**：会话被压缩（手动 `/compact` 或 token 压力自动触发）后，下一个用户
  消息轮自动重新注入长期记忆快照 + 本会话此前用 `memory_project` 查阅过的项目全景 +
  本会话自己写入/更新过的记忆原文（均按最新数据重新整理）——压缩甩掉的"记性"一个回合
  就补回来，AI 不会因为压缩突然失忆。
- **工具集**：`memory_remember`（写入，必填 content/project/keywords/importance 且缺失报错引导重填，
  自动去重合并，返回读回确认：关键词/项目归属）/
  `memory_search`（BM25 × 近期权重，支持 level/project/status/days 过滤，默认 top10 = 前 5 条
  最相关不排除已见 + 后 5 条绕开已见补齐，按记忆时间戳排序；返回检索元数据视图：
  归属 + 完整 id + 相对时间 + 关键词列表，不含原文）/
  `memory_project`（项目全景注入段落：**project 参数必填**——你要看哪个项目的信息？按子标签分组、未过时条目全给、每条带完整 id 与
  最后更新时间戳、todo 输出「已完成：」最近 5 条 +「To do list：」，末尾附记忆库与
  会话历史定位说明）/
  `memory_find_similar`（查重与冲突检测）/ `memory_read` / `memory_update`（含 status
  active/archived/stale、importance、goal、keywords 手动修正）/ `memory_dream`（手动触发；
  用户也可以直接在输入框敲 `/dream` 命令）。
- **记忆时间戳**（`updated_at` = 最后更新时间）：dream 封存或 `memory_update` 刷新时更新。
  展示的时间戳一律是 `updated_at`；search（工作视图）带相对时间戳，命中注入/memory_project
  （原文视图）带相对 + 绝对时间戳（如「2026-08-15 10:58 [2 天前]」）。
- **project 归属**：全局适用的信息 project 填 `"全局"`（与留空=未标记区分）；同时适用于
  多个项目时用英文逗号分隔（如 `"dsh, femwa"`）——检索/命中按"包含当前项目名 或 全局"判定。
- **按窗口 dream**：窗口空闲 ≥ `idleMinutes`（默认 **180 分钟 = 3 小时**）即进入允许
  触发状态（替代原夜间窗口），每个最后发言晚于上次 dream 的窗口由自己的主 agent
  整理——分轮处理（第 1 轮原子记忆 project/fact/lesson/rules/soul/user，第 2 轮 topic
  记忆，第 3 轮项目总结——本窗口涉及具体项目时追加：调 memory_project 复查并精简成
  新的项目长期记忆，被取代的旧条目归档），project 小标题分段，每条记忆附关键词行
  （AI 核查/重写关键词用），范围=本窗口
  建立 + 提取过（注入/检索/查阅 memory_read）的记忆，使用其完整会话上下文；
  长期稳定的 rules 不反复重审（`dream.rulesReviewDays` 默认 2 天内有更新才进清单，
  防"没话找话"式更新）。**峰时抑制**（按 `timeZone` 计算，默认
  北京时间）：`suppressWindows`（默认 09:00–12:00、14:00–18:00，API 峰谷电价峰时）
  及各自开始前 `suppressLeadMinutes`（默认 15）分钟内不触发，峰时结束后下一个检查
  周期自动触发；进行中的 dream 不打断。无 live agent 且超过 24h 的旧窗口、以及已归档
  的会话，均不处理。
- **`/dream` 命令**：不想等空闲触发？在输入框敲 `/dream` 立即手动唤起本窗口的记忆整理
  （与 `memory_dream` 工具同语义，不受峰时抑制）。dsh 命令平面执行、不发给模型，输入 `/`
  的补全菜单里直接可见；已有整理在进行中会明确提示，不会重复启动。
- **跳过梦境整理（client 端）**：某个窗口的记忆不想被自动整理？左侧边栏该会话行的「…」
  菜单里点一下**「跳过梦境整理记忆」**即可，再点**「取消跳过梦境整理记忆」**恢复。被跳过
  的窗口不再被空闲定时器自动 dream（`/dream` 与 `memory_dream` 手动触发不受影响），
  会话列表里显示**静音灰「月牙+斜杠」**图标、一眼可辨。跳过状态持久保存、重启不丢；
  双实例共享同一记忆库，状态天然一致。
- **反思**：单次任务内连续 ≥7 个工具 step 后，插件询问模型自上次整理以来是否有值得记忆的内容。
  最后工具是 `memory_*` 视为已主动记忆、不重复反思；被取消的轮次绝不触发。
- **注入折叠 UI（client 端）**：首轮长期记忆 / 每消息关键词命中的注入文本在前端
  折叠成「▸ 已注入记忆（长期记忆/关键词命中）」横条（与用户气泡同宽），点开可查看
  注入全文；用户 prompt 以气泡形式直接显示，消息流干净不被注入刷屏。纯文本消息才折叠
  （带附件的保持原样）。
- **反思轮折叠 UI（client 端）**：记忆反思/dream 轮的 prompt 与后续 think/tool call/汇报
  折叠成一条横条（默认折叠，显示「新增记忆 N 条」/「记忆梦境任务」），点击向下展开成
  卡片查看完整记录——卡片内 Think / tool call / 上下文注入均可点开查看细节。
- **会话列表 dream 图标（client 端）**：左侧会话列表中，"dream 整理过记忆且之后无新对话
  新信息"的会话行显示**淡黄色小月牙 🌙**；dream 轮进行中显示**白→金呼吸灯月牙**（替换 dsh
  的运行中蓝色动画，避免与正常工作混淆）；被**跳过梦境整理**的会话显示**静音灰「月牙+斜杠」**
  （取消跳过自动回落；优先级：呼吸灯 > 跳过 > 月牙）；有新活动即移除。图标放进 dsh 会话行的状态槽位
  （替换槽内内容，标题零位移）。数据走事件驱动无轮询：`/meow-memory/dream-events` SSE
  长连接——dream 开始推 `state:'dreaming'`、完成推 `state:'dreamed'`、有新活动推
  `state:'active'`、跳过翻转推 `state:'skip'/'unskip'`；client 挂载/断线重连时对
  `/meow-memory/dreamed-sessions` 与 `/meow-memory/skip-dreams` 全量对账一次。
  行定位零 dsh 改动：读 React 18 fiber（`__reactFiber$` 内部属性）拿会话行渲染 key =
  session id，不依赖标题匹配。
- **dream 防重复**：check 门（DB 原子 60s 检查节流）+ start 幂等抢占（`dream_pending`）+
  中断自愈（未收尾的 dream 自动补收尾）+ 孤儿收尾（跨实例/热重载后 turn 结束也能收尾）；
  插件注入轮的事件不刷新窗口活跃度——已 dream 的窗口不会反复被 dream。
- **零运行时依赖**：`node:sqlite`（Node ≥22.13 默认可用；22.5–22.12 需 `--experimental-sqlite`）+ 自包含 esbuild 产物（`lib/index.js`）。
  无原生模块。

## 📦 安装

### 一键安装（推荐）

```sh
dsh plugin --profile web add github:Phant0Meow/dsh-meow-memory
```

一条命令装完即生效：安装时自动编译（包内含 `prepare` 脚本），自动挂载，重启 `dsh web` 后新会话自动加载插件。

> pnpm ≥10 默认会阻止安装期的构建脚本：首次 `add` 可能失败并提示 `allowBuilds`，按提示把输出的键加进 profile 的 `pnpm-workspace.yaml` 后重跑即可。

### 卸载

```sh
dsh plugin --profile web remove meow-memory
```

### 手动安装（开发者，任意 DSH 安装，无需 npm）

1. 把本包复制（或软链）到 profile 的 `node_modules`：
   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/meow-memory ~/.dsh/profiles/web/node_modules/meow-memory
   ```
   （Windows：`New-Item -ItemType Junction ...` —— NTFS junction，无需管理员权限。）
2. 把 `meow-memory` 加进 profile `package.json` 的 `dsh.profile.bundles`（同上）。
3. 重启 `dsh web`。新会话自动加载插件。

## ⚙️ 配置

所有字段均可选（profile patch 或 `cordis.patch.yml`）。**也可以不手编文件**：DSH 设置页里有本插件的「喵记忆」标签页（与「通用」「模型」平级），下面这些项全部图形化可改、字段级保存、可单项恢复默认；保存后热重载/重启 meow-memory 插件生效。

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true          # 总开关
    projectDir: '.dsh-meow' # 记忆目录（相对工作区）
    promptLang: 'zh'       # ⚠️ 首次使用建议显式配置（见下方说明）
    hitTopK: 2             # 每条用户消息关键词命中的条目数上限（fact/lesson/rules/topic）
    reflect: true          # 连续 ≥reflectTurns 轮工具调用后自动反思
    reflectTurns: 7        # 触发反思所需的连续工具轮数
    dream:
      enabled: true
      idleMinutes: 180      # 窗口空闲 ≥180 分钟（3 小时）允许 dream
      suppressWindows:      # 峰时抑制时段（按下方 timeZone 计算，"HH:MM" 起止）
        - start: '09:00'    #   API 峰谷电价峰时
          end: '12:00'
        - start: '14:00'
          end: '18:00'
      suppressLeadMinutes: 15  # 每个峰时开始前 15 分钟也不触发
      checkMinutes: 15
      timeZone: 'Asia/Shanghai'  # 用户机器时钟为美区时间；抑制时段必须
                                 # 按此固定时区计算
      rulesReviewDays: 2    # updated_at 距今超该天数的稳定准则不进 dream 第 1 轮
                            # 清单（防反复整理不变化的条目）；0 = 不过滤
    delegate:
      reflect: false       # 反思轮交给独立 fork 子代理：继承主会话全部已完成轮次
                           # （含工具结果），在自己会话里跑、零写主会话上下文；
                           # false = 拼接进主会话（旧行为）
      dream: false         # dream 各组交给 fork 子代理：每组一个子代理，done 回调
                           # 链式推进，租约状态机/峰时抑制/skip 语义不变
      model: ''            # 子代理模型：留空 = 跟随主会话（请求前缀与主会话同源，
                           # 可命中 provider 缓存）；'provider/model' 指定 provider+model，
                           # 'model' 只换模型（provider 继承主会话）
```

### delegate：反思/梦境脱离主会话上下文（可选）

反思轮和 dream 各组默认拼接进主会话（steer）——prompt、模型回应、工具调用全部落在主会话 log 里（折叠 UI 只是视觉隐藏，模型上下文仍被占用）。`delegate.reflect` / `delegate.dream` 把执行体换成 **fork 子代理**：子代理播种主会话全部已完成轮次（看得见此前的一切，包括工具结果），在自己独立的会话里执行记忆整理，主会话 log 零写入——主对话的上下文占用与压缩节奏完全不受记忆整理影响。

`delegate.model` 同时解决"整理想换个模型"的需求（主会话一个会话一个模型路由，拼接方案下无法单轮换模型）。配置决策矩阵：

- **跟随主模型 + delegate**：子代理请求前缀与主会话请求同源，可命中 provider 侧 prompt 缓存，同时零占用主会话上下文；
- **换模型**：`delegate.model` 一填，`reflect`/`dream` 自动强制开启——换模型的请求是独立流，命不中主模型的缓存链，此时占主会话上下文纯亏。

delegate 模式的三个配套行为：①子代理会话 `origin='subagent'`，GUI 会话列表天然不显示，结束后再写入持久化归档集合双保险；②主会话 log 里补一条极短的「【记忆反思标记】/【记忆整理标记】」插件消息（不触发模型调用）——主模型知道此处整理过记忆，后续整理以标记为界取增量；③子代理任务失败自动按中止收尾，已写条目照常封存。

### promptLang：prompt 与检索语言（重要）

`promptLang` 决定两件事：①注入/反思/dream 文案的语言；②工具描述的语言。它同时影响模型写记忆条目用的语言——关键词按条目语言提取，**以你说话的语言为准**。

**因此首次使用时请显式配置它**：`promptLang: 'zh'`（默认）或 `'en'`（内置英文语言包）。如果你的对话语言和界面语言不一致（比如界面英文、说话中文），**以你说话的语言为准**。

检索侧说明：BM25 分词自 v0.20.0 起语言无关（类别路由），条目与查询语言不一致不再"杀检索"；`en` 模式额外启用英语归一化（停用词过滤 + Porter 词干还原），屈折变化不影响命中（`tokenizers` 能命中存为 `tokenizer` 的条目）。

自定义 / 社区语言包：prompt 文案是数据文件（`src/prompts/`），一门语言一个子目录，改文件即生效、无需改代码——详见 [`src/prompts/README.md`](src/prompts/README.md)（含贡献指南与 `npm run check-lang` 自查）。实例级自定义：`<home>/.dsh-meow/prompts/<lang>/` 下放同名槽位文件即可覆盖（可只覆盖部分）。

## 🧠 工作原理

```
第一条用户消息（首轮）         第二条起的每条消息                空闲≥3h 且非峰时
┌────────────────────┐        ┌────────────────────┐        ┌──────────────────────┐
│ ===== 长期记忆 ===== │        │ 可能相关的记忆，仅供  │        │ 按窗口 dream：        │
│ 【关于你】(soul)     │        │ 参考：keywords 命中   │        │ 三轮（含项目总结）      │
│ 【关于user】         │        │ top-2（全局+当前     │        │ 七层+提取过的，       │
│ 【设计原则】(rules)   │        │ project 锚定）      │        │ updated_at 以 T 封存  │
│ 【记忆导引】          │        └────────────────────┘        └──────────────────────┘
└────────────────────┘        已见 id 按会话记录
独立 plugin snapshot        (sessions/<id>.json)
↓ 原样 user prompt          压缩信号 → 释放已见
 每会话只注入一次，
 首轮不做命中
```

## 🛠 开发

```sh
npm install
npm run build          # esbuild 打包 → lib/index.js（自包含）
npm run test           # 228 项逻辑测试：db / bm25 / migrate / inject / reflect / dream / tools / apply
```

`@deepseek-ai/*` 包位于 dsh-meow pnpm workspace 中，不在本包的 `node_modules` 里。
在 Windows 上，`npm run link-workspace`（或 `scripts/link-workspace.ps1`）创建 workspace
包的 junction 镜像，使 esbuild 能解析它们；`build.mjs` 通过 `nodePaths` 引用。
这些链接仅构建期需要。

## 🙏 致谢

感谢每一位贡献者让 meow-memory 越来越好：

- **[daveycodez](https://github.com/daveycodez)** — 英文语言包与英文分词（[PR #6](https://github.com/Phant0Meow/dsh-meow-memory/pull/6)，v0.22.0 发布）
- **[chenmzh](https://github.com/chenmzh)** — 记忆注入改为独立 plugin snapshot 消息，根治会话标题污染（[PR #10](https://github.com/Phant0Meow/dsh-meow-memory/pull/10)）
- **[cuddly-guacamole](https://github.com/cuddly-guacamole)** — dsh 0.1.2-alpha.4 双版本 Session events 兼容（[PR #11](https://github.com/Phant0Meow/dsh-meow-memory/pull/11)）

## 📄 License

MIT —— 见 [LICENSE](LICENSE)。
