# meow-memory 🐱📝

| [中文](README.md) | [English](README.en.md) | [Português (BR)](README.pt-br.md) | [MIT License](LICENSE) |
| :---: | :---: | :---: | :---: |

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的跨会话记忆插件。

当前版本 **0.31.0** ｜ 版本变更见 [CHANGELOG.md](CHANGELOG.md) ｜ 兼容 **dsh 0.1.5**

## ✨ 功能特性

- **七层记忆**：`soul`（AI 自身）/ `user`（用户信息与偏好）/ `project`（项目信息，含 `subcategory`）/ `fact`（原子事实）/ `lesson`（教训与纠正）/ `topic`（进行中的话题，带目标句）/ `rules`（设计原则与行为准则）。每层一张 SQLite 表，UUID 带时间前缀，id 顺序即创建顺序。
- **首轮注入（长期记忆块）**：第一条用户消息前注入 soul / user / 设计原则 / 记忆导引。记忆作为独立 plugin snapshot 消息放在真实 user 消息之前，**不改写用户 prompt**；**首轮不跑关键词命中**（命中从第二轮起）。
- **每消息关键词命中**：从第二条用户消息起，每条真实用户消息检索 fact/lesson/rules/topic（全局 + 当前 project 锚定），top-2 命中注入。命中基于**条目关键词**而非全文。
- **当前 project 锚定**：带 project 参数即锚定该会话的当前项目；未锚定时命中只搜全局（用户闲聊不误伤）。
- **缓存友好设计**：静态 `meow-memory:guide` section 在 system prompt 中注册一次——文本恒定，破坏不了 provider 的 KV 缓存。
- **压缩后重注入**：会话压缩后，下一轮自动重新注入长期记忆快照 + 本会话查阅过的项目全景 + 本会话写入过的记忆原文，AI 不会因为压缩突然失忆。
- **七层之上的三件事**：写入自动去重合并、按 `updated_at` 展示记忆时间戳、全局信息用全局标记（区别于留空）。
- **按窗口 dream**：窗口空闲 ≥3 小时即允许整理，由该窗口自己的主 agent 分三轮处理（原子记忆 / topic / 项目总结），**峰时抑制**（默认北京时间 09:00–12:00、14:00–18:00，API 峰谷电价峰时）不触发。也可敲 `/dream` 立刻手动整理。
- **反思**：单次任务内连续 ≥7 个工具 step 后，插件询问模型自上次整理以来是否有值得记忆的内容。最后工具是 `memory_*` 视为已主动记忆、不重复反思。
- **外部记忆库信任门**：工作区自带的 `.dsh-meow` 若非本机创建（如 clone 的外部仓库），默认暂停注入/检索/整理——首轮提示一次，`/meow-trust` 一键信任、即刻生效；本机创建与升级前打开过的工作区自动信任，正常使用零感知。
- **客户端 UI**：注入文本折叠成横条、反思/dream 轮折叠成一条可展开的卡片、会话列表显示 dream 状态图标（🌙 已整理 / 呼吸灯 进行中 / 灰月牙斜杠 已跳过）。
- **零运行时依赖**：`node:sqlite` + 自包含 esbuild 产物（`lib/index.js`）。**无原生模块。**

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

### PT-BR Fork

想要巴西葡语打包版本的仓库：[coutogilson](https://github.com/coutogilson) 的 fork：

```sh
dsh plugin --profile web add github:coutogilson/dsh-meow-memory
```

### 手动安装（开发者，任意 DSH 安装，无需 npm）

1. 把本包复制（或软链）到 profile 的 `node_modules`：

   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/meow-memory ~/.dsh/profiles/web/node_modules/meow-memory
   ```

   （Windows：`New-Item -ItemType Junction ...` —— NTFS junction，无需管理员权限。）

2. 把 `meow-memory` 加进 profile `package.json` 的 `dsh.profile.bundles`。

3. 重启 `dsh web`。新会话自动加载插件。

## 🔌 兼容性

支持 **dsh 0.1.5**（含最新的 `0.1.5-rc.1`），同时向下兼容旧版本——升级 dsh 不需要改本插件，也不需要改任何配置。

插件不写死版本号，而是运行时探测宿主能力，因此新旧版走各自正确的分支。已实测两代：`0.1.5-rc.1` 上首次注入、记忆工具调用、客户端渲染全部正常；`0.1.1-rc.2` 上行为与历史版本完全一致。

## ⚙️ 配置

所有字段均可选（profile patch 或 `cordis.patch.yml`）。**也可以不手编文件**：DSH 设置页里有本插件的「喵记忆」标签页（与「通用」「模型」平级），下面这些项全部图形化可改、字段级保存、可单项恢复默认（恢复默认 = 回到插件出厂默认，不受 patch 基线影响）；保存后热重载/重启 meow-memory 插件生效。

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true          # 总开关
    projectDir: '.dsh-meow' # 记忆目录（相对工作区）
    promptLang: 'zh'       # ⚠️ 首次使用建议显式配置（见下方说明）
    hitTopK: 2             # 每条用户消息关键词命中的条目数上限
    dream:
      enabled: true
      idleMinutes: 180     # 窗口空闲 ≥180 分钟（3 小时）允许 dream
```

**完整字段、类型与默认值见 [docs/配置参考.md](docs/配置参考.md)**，含 `titleMax` / `autoMigrate` / `homeDir` / `disabledWorkspaces` / `backup` / `delegate` 等全部配置项。

> ⚠️ **`promptLang` 首次使用建议显式配置。** 它决定注入/反思/dream 文案与工具描述的语言，同时影响模型写记忆条目用的语言——关键词按条目语言提取。内置 `zh` / `en` / `pt-br` 三套语言包。配置值就是 `src/prompts/` 的子目录名，**逐字匹配**：填一个不存在的名字（例如 `pt`）不会报错，而是静默落回中文包。详见 [docs/配置参考.md](docs/配置参考.md)。

### 界面语言

插件界面文案跟随 DSH 的「设置 → 通用 → 语言」（内置中文 / English / Português (Brasil)），与 `promptLang` 是两层、互不影响。详见 [docs/配置参考.md](docs/配置参考.md)。

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

### 工具

| 工具 | 用途 |
|---|---|
| `memory_remember` | 写入一条记忆（必填 content/project/keywords/importance，自动去重合并） |
| `memory_search` | 关键词检索（BM25 × 近期权重，支持 level/project/status/days 过滤） |
| `memory_project` | 取回某项目的完整注入段落（**project 参数必填**） |
| `memory_find_similar` | 查重与冲突检测 |
| `memory_read` | 按 id 读取单条完整元数据 |
| `memory_update` | 修正 status / importance / goal / keywords |
| `memory_dream` | 手动触发本窗口的记忆整理 |
| `memory_home` | 查看 / 切换全局数据目录 |

另有 `/dream` 命令：在输入框敲 `/dream` 立即手动唤起本窗口的记忆整理，不受峰时抑制。

**参数、返回与副作用见 [docs/工具参考.md](docs/工具参考.md)**（含 `memory_project` 的项目锚定副作用与 `memory_home` 的三个预设目录标记）。

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

## 📚 文档

| 想了解 | 看这里 |
| --- | --- |
| 七个工具的参数、返回与副作用 | [docs/工具参考.md](docs/工具参考.md) |
| 全部配置项、类型与默认值 | [docs/配置参考.md](docs/配置参考.md) |
| 为什么这样设计（缓存、命中、dream、踩过的坑） | [docs/设计说明.md](docs/设计说明.md) |
| 装不上、检索不准、报错怎么读 | [docs/常见问题.md](docs/常见问题.md) |
| 版本变更历史 | [CHANGELOG.md](CHANGELOG.md) |
| 加界面语言 | [src/i18n/README.md](src/i18n/README.md) |
| 加 prompt 语言包 | [src/prompts/README.md](src/prompts/README.md) |

## 🙏 致谢

感谢每一位贡献者让 meow-memory 越来越好：

- **[daveycodez](https://github.com/daveycodez)** — 英文语言包与英文分词（[PR #6](https://github.com/Phant0Meow/dsh-meow-memory/pull/6)，v0.22.0 发布）
- **[chenmzh](https://github.com/chenmzh)** — 记忆注入改为独立 plugin snapshot 消息，根治会话标题污染（[PR #10](https://github.com/Phant0Meow/dsh-meow-memory/pull/10)）
- **[cuddly-guacamole](https://github.com/cuddly-guacamole)** — dsh 0.1.2-alpha.4 双版本 Session events 兼容（[PR #11](https://github.com/Phant0Meow/dsh-meow-memory/pull/11)）
- **[coutogilson](https://github.com/coutogilson)** — 巴西葡语 prompt 语言包（`src/prompts/pt-br/`）与跟随 DSH 语言设置的界面文案层

## 📄 License

MIT —— 见 [LICENSE](LICENSE)。
