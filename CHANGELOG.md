# Changelog

## v0.23.0 (2026-08-30)

### 反思/梦境独立执行：fork 子代理委托（delegate.reflect / delegate.dream，默认关闭）

- **设置页「喵记忆」标签页**：DSH 设置页新增与「通用」「模型」平级的顶级分区（settings.section 契约，cachebilling 同款双半身）——全部 config 项图形化可改（基础/注入命中/反思/独立执行/dream/语言六组），字段级保存（settings.yaml user 层）+单项恢复默认+「默认/已覆盖」徽章；dream 峰时窗口用 "HH:MM-HH:MM" 逗号分隔文本编辑（解析校验红框提示）。层级语义：patch config=装配基线，设置页 user 层字段级覆盖（apply 时合并，dream/delegate 子对象浅合并防丢键）。保存后热重载/重启插件生效（config 在 apply 时解析，页面顶栏明示）。RPC 写入走 validateConfigUserLayer 字段级类型校验（编不过拒写）。
- **`delegate.reflect: true`**：反思轮不再拼接进主会话（steer 的 prompt/回应/工具调用全落主 log，折叠 UI 只是视觉隐藏）——改为起一个 **fork 子代理**（dsh `subagent_fork` 同源机制）：子代理播种主会话全部已完成 turn 的 log（user 消息、assistant 回应、工具调用与结果都在），在自己独立的 session 里执行记忆整理，**主会话 log 零写入**。子代理 `origin='subagent'`，本插件注入/反思/dream 链路对它天然跳过不自循环；同会话防重入（上一轮反思未结束不重复触发）；subagents 服务不可用自动回退 steer（功能降级而非消失）。反思触发条件、反思 prompt、记忆落库路径全部不变。
- **`delegate.dream: true`**：dream 各组同理换 fork 子代理执行——每组一个子代理（label `meow-memory dream N/M`），组完成的 done 回调链式推进下一组；DB 租约状态机（原子抢占/CAS 推进/过期补收尾）、峰时抑制、skip 豁免、手动 /dream 与 memory_dream 语义全部不变，只换执行体与驱动源（turn-stopping steer → done 回调）。某组失败（stopReason≠completed）立即按 aborted 收尾封存已写条目，不再推进。
- **`delegate.model`**：子代理模型路由。留空=跟随主会话（请求前缀与主会话请求同源，provider prompt cache 可命中）；`'provider/model'`（dsh route 格式）指定 provider+model，`'model'` 只换 model（provider 继承父）。主会话一个 session 一个 route，拼接方案下无法单轮换模型——fork 子代理是换模型的唯一路径（issue #7 的机制解）。**换模型强制 delegate**：model 一填 reflect/dream 自动强制开启——换模型的请求是独立流命不中主模型缓存链，占主会话上下文纯亏（猫猫拍板）。
- **主会话打点**（猫猫拍板）：delegate 模式下整理过程不进主 log，主模型对「整理发生过」无感——起子代理成功后向主会话 log append 一条极短插件标记消息（【记忆反思标记】/【记忆整理标记】，`session.append('user/message')` 纯 log 写入**不触发 LLM turn**；kind='plugin'+form='notice' → GUI 一行折叠通知、标题提取跳过）——主模型元认知知道此处整理过，后续整理以标记为界取增量。
- **子会话收尾**：子代理会话 `origin='subagent'`，GUI 会话列表天然过滤不显示（dsh-client-ui-workspace 列表谓词实证）；settle 后再写 `workspace.archiveSession(childId)` 持久化归档集合双保险（host 无删除 API，成果在 memory.db，log 文件留存无害）。某组失败（stopReason≠completed）立即按 aborted 收尾封存已写条目，不再推进。
- 实现形态：`src/delegate.ts` 封装 `startDelegateSubagent`（fire-and-forget、inFlight 防重入、done 回调在清账后触发防链式自挡）；dream.ts 以 `DreamLaunchFn` 抽象执行体（steer=默认，delegate 经 `setDreamDelegateEnv` 注入）；插件经 `ctx.get('subagents')` 防御式解析 host registry（spawn/fork 后端在 host composition 装配）；插件 fiber dispose 时 abort in-flight 子代理并清 delegate 环境。
- 测试：主套件 372 全绿（新增 parseModelSpec 3 项 + 设置页数据层 7 项：merge 字段级覆盖/子对象浅合并/undefined 直通/validate 拒写 + delegate 行为 16 项：fork 启动/模型覆盖/换模型强制 delegate/不 steer/in-flight 防重入/settle 后恢复/archive 双保险/主会话打点/服务缺失回退 steer/默认关闭不触碰 subagents + dream delegate 9 项：组链推进/收尾封存/失败中止收尾）。

### 压缩重注入第三块：本会话写过的记忆原文回放

- **写痕迹 `written`**：`memory_remember`（新建/合并两条路径）与 `memory_update`（实际落库才记，空 patch 无字段变化不算写）成功后把条目 id 记入 `sessions/<id>.json` 新字段 `written`（去重 + 重复移末尾最近优先，上限 `MAX_REINJECT_WRITTEN`=20；子代理代写按既有归属语义记入父窗口文件）。`releaseSeen` 照旧保留 `written`（它正是重注入数据源，同 `projectsQueried`）。
- **重注入第三块**：`buildReinjection` 在快照与项目全景之后追加【本会话写过的记忆】段——数据源 = `written` ∪ db 层 `source_session`=本会话 的条目（双保险，覆盖插件热更新前旧代码写入的条目）；按当前库最新数据解析原文（不缓存旧文本）；只回放 status=active（archived/stale 内容已失效不回放）；排除快照正文与项目全景已展示的 id（防同块重复展示）；超出上限保留最近写入的。回放的 id 记入 injected——合并更新过的他窗条目不再被关键词命中重复注入。
- **dream 第一轮清单补口**：清单范围并入 `written`——此前"经 memory_project 全景看到条目后 update 它"不落任何痕迹（全景刻意不标记），该条目漏出 dream 复查范围；现在本会话写工具落库过的条目必进清单。
- **文案外置**：`inject.reinjectIntro` 改为覆盖三块的通用表述（zh/en 同步）；新增 `inject.writtenSection`/`inject.writtenIntro`。
- 新增测试：written 记账（remember 新建/合并、update 落库与未找到/空 patch 不记）、LRU 上限、releaseSeen 保留、第三块回放（active 过滤/归档跳过/快照与全景去重/按库最新数据/db-only 并集）、apply 级注入与 injected 重记账。

- 打点气泡（`client-delegate-notice.ts`）：识别 delegate 打点节点（`memory.kind='reflect-marker'/'dream-marker'/'reflect-done-marker'` 元数据优先 + 【记忆反思标记】文本兜底，与折叠轮/注入互斥）→ 隐藏原生低调 notice 行 → 原位插折叠横条同款胶囊气泡。dream 气泡状态化：「进行中…」⇄「已完成 ✓」（dreamed 才翻已完成，状态未知默认进行中），状态源 = dreamed-sessions 对账 + 增量信号；reflect 气泡按「触发→完成打点」交替配对（in-flight 防重入保证序列，最后一条 reflect 系打点且 30min 保鲜窗内=进行中）。`/dream` 命令 feedback 去掉「处理中」死文字改指向状态气泡。
- prompt 正负平衡改造（zh/en 同步）：反思与 dream prompt 强调记忆正负平衡——被表扬的也记（不只教训）、被纠正的记 `corrected`、踩坑记、干了漂亮的事也记；防止记忆库全是教训让模型畏手畏脚。
- dream 触发链 resume 修复：进程重启后 `liveAgents` 清空，agent-missing 窗口经 `agentsSvc.resume({ resumeSessionId })`（factory.resume，与 GUI 打开会话同路径）恢复后再 dream——挂着的老窗口不因重启丢 dream 资格。首版取 `factory.resume` 恒 undefined → 全部 agent-missing 窗口静默跳过（真机踩坑：重启后自动 dream 从未真正恢复），按 dsh-agent 源码实证修正。

### 前端连接池修复：dream-events SSE → 全页共享轮询（2026-09-05）

- **根因**：dream-icon / dream-skip / delegate-notice 三个客户端管理器各自开一条 `EventSource('/meow-memory/dream-events')`——单页 3 条 HTTP/1.1 长连接，加上 DSH 官方 events.mux/events.host 两条 ws，同源浏览器每域 6 连接池被占满：同源第二个标签页与刷新被饿死（「第二个窗口打不开 / 刷新打不开 / 越来越卡」，3080/3081 皆然）。
- **药方**：三管理器的 EventSource 全部移除，新增共享模块 `client-dream-events.ts`——全页一个 60s 轮询（dreamed-sessions + skip-dreams 各一次 GET）对上轮快照做 diff，产出与旧 SSE 'dream' 帧同语义的增量事件（dreamed/dreaming/active + skip/unskip）；首轮静默建基线（存量状态不作为增量重放）。各管理器挂载时的 refresh() 全量对账保留，首屏即时性不变；订阅归零自动停表。
- **取舍**：状态翻转延迟从实时变为 ≤60s（dream 本为小时级低频信号，UI 无感）；host `/meow-memory/dream-events` SSE 路由保留（向后兼容，现无客户端连接）。单页长连接 5 → 2。

## v0.22.0 (2026-08-30)

### English language pack + English tokenizer（首个社区语言包，PR #6 by @daveycodez）

- **内置 `en` 语言包**：9 个槽位全部英译（system-guide / reflect / dream-header / dream-atomic / dream-topic / dream-project-summary / welcome-guide / labels / tools），`promptLang: 'en'` 即用。阈值按英文习惯换算：fact/lesson ≤30 words、topic ≤180 words（zh 为 60/300 字）；关键词指南补充英文特有建议——词典原形入库（分词器已做词干还原，单复数各占一个槽位是浪费）、不要用停用词当关键词。
- **英语分词归一化**（en 模式产出后追加；v0.20.0 类别路由主干语言无关，不回退）：①停用词过滤——英语功能词每条记忆都有，会稀释命中链路覆盖率分母，撇号切分残留的 s/t/ll 碎片一并丢弃；②Porter (1980) 词干还原（零依赖移植，论文 77 个规范用例全过）——caches/caching/cached 归并同一词干，query 写复数、条目存单数也能命中（`tokenizers` 命中 `tokenizer`）；含数字 token（2024/sha256）跳过还原。关键词仍原样存库，只在匹配时归一。
- **全局标记语言感知（英文包真 blocker 修复）**：`全局` 不只是文案，代码拿它当语义哨兵比对（projectList/projectCovers/projectLabel/命中链路/锚定）。英文包让模型写 `"global"` 时，旧代码会造出一个叫 global 的假项目——全局 rules 不再注入、项目列表凭空多项。现在 `db.ts` 提供 `GLOBAL_PROJECT_CANON`（真值永远认，老库条目跨语言切换不失效）+ `globalProjectMarker()`（labels.md `project.global`，按语言缓存——检索热路径逐行读文件要 ~7ms/200 条）+ `isGlobalProject()`（容忍大小写与首尾空白，双认真值与当前语言写法）；inject/tools 全部「全局」字面量判断收敛到这一个入口，dream 走 projectList 天然语言感知。
- **17 个框架词外置 labels.md**：相对时间（time.*）、memory_project 段落标题（project.section.* / 已完成 / To do list / 【项目：X】）、memory_remember 四必填报错（remember.error.*，project 报错带 `{global}` 插值——原硬编码会叫英文模型填「全局」）。zh 值逐字节不变（测试断言），段落构造落位在 v0.21.0 共用的 `buildProjectSectionText`，memory_project 与压缩重注入零分叉。
- **README 修正**：promptLang 段落仍是 v0.19.0 旧描述（"分词器语言 / en=英文整词分词"），按 v0.20.0 类别路由现状改写——分词语言无关、语言不一致不再杀检索；`en` 模式额外启用英语归一化。
- 测试：主套件 317 + client 45 全绿；新增 global marker 6 项 / en 分词 10 项 / Porter 19 规范用例 / 屈折端到端检索 / zh 框架词逐字节断言。`check-lang -- en` 绿（顺带抓出 PR 未见的 v0.21.0 键 `inject.reinjectSection`/`inject.reinjectIntro` 并补齐——缺键会让英文压缩重注入 throw）。

## v0.21.0 (2026-08-29)

### 压缩重注入：/compact 之后一个回合补回记性

- **压缩成功自动重注入**：会话压缩生命周期走到 `compaction/end` 且无 error（= 表层已被替换，`/compact` 手动压缩与 token 压力自动压缩同覆盖）时，给 `sessions/<id>.json` 置 `reinjectPending` 待办——下一个含真实用户消息的请求注入「长期记忆快照 + 本会话此前查阅过的项目全景」，随后清待办。重注入轮等同新首轮：不跑命中链路，命中从下一轮起。压缩失败的 `end`（带 error，表层未变）不打标记。
- **项目查阅留痕**：`memory_project` 每次成功调用把项目名记入 `sessions/<id>.json` 新字段 `projectsQueried`（'全局' 不记——全局层走快照；多项目参数按逗号拆开记；去重 + 最近优先，上限 `MAX_REINJECT_PROJECTS`=8 个）。重注入时按**当前库最新数据**重新构造项目全景（空项目跳过），不是缓存旧文本。
- **快照 id 重新记账**：重注入的 soul/user/全局 rules 条目 id 重新记入 injected——压缩后内容重新进入上下文，去重语义随之恢复；`releaseSeen` 照旧清 injected/searched，但保留 `projectsQueried`/`reinjectPending`（它们正是重注入的数据源）。
- **工具轮不消耗待办**：pending 置位期间的工具轮/纯插件消息轮不注入也不清标记，等下一个真实用户消息轮；子代理照旧不参与。无可注入内容（库空且项目全空）时仍清待办，防每轮空转。
- **注入格式**：长期记忆快照（与首轮同格式，顶格 `===== 长期记忆 =====`）+ `【会话已压缩】` 说明段 + 各项目全景段 + 结束标记 + `本轮用户prompt：`；快照条目与项目全景段落构造共用同一实现（`buildProjectSectionText` 从 tools.ts 迁入 inject.ts，memory_project 工具与重注入零分叉）。
- **工程**：sessions 文件 5 处散写收敛为统一 `writeSeenFile`（新增字段只改一处，防漏写）；新增模块级 + apply 级测试（查阅留痕/全局过滤/多项目拆分/LRU 上限/end 成功置待办/end 失败不打标/重注入内容与命中链路让位/待办清理/工具轮与子代理边界）。

## v0.20.0（未单独发版，随 v0.21.0 同发）

### tokenize 重设计：类别路由、语言无关

- 旧版 zh=汉字 bigram、其他语言=ASCII 整词、其余字符全丢（非 zh 模式中文 0 token 检索不到）。新版按字符类别路由、语言无关：①CJK 类（\p{Script=Han}+平假名+片假名+々+ー）连续段相邻 bigram 常开，不随 promptLang 关闭，汉字假名交界不断 run；②`\p{L}\p{N}` 整词+小写（café/привет/한국어）；③NFKC 归一化（全角ＢＭ２５→bm25）；④`Array.from` 按 code point 迭代（surrogate pair 不切半，Ext B~I 汉字入 bigram）；⑤标点/符号/emoji 丢弃（防 IDF 污染）。promptLang 不再影响分词，只管文案语言；README/welcome-guide 的"语言不一致杀检索"警告已改写。stemming 仍是语言包扩展点。

## v0.19.0 (2026-08-28)

### prompt 文案外置 + 语言开关（海外用户 issue 驱动）
- **prompt 文案全部外置为数据文件**：`src/prompts/zh/` 9 个槽位（system-guide / reflect / dream-header / dream-atomic / dream-topic / dream-project-summary / welcome-guide / labels 23 键 / tools 43 键），运行时读取——改文案 = 改文件，下一轮反思/dream 即生效，无需改代码；新增 `prompt-loader`（逐槽位三级 fallback：实例覆盖 `homedir/.dsh-meow/prompts/<lang>/` → 内置语言包 → 内置 zh；占位符填充用 replaceAll 函数形式防 `$` 序列陷阱）。
- **新增 config `promptLang`**（默认 zh；README 强调首次使用必须显式配置——记忆条目语言必须与 BM25 分词器一致，否则检索命中率崩）；传递链路归零：`setPromptLang` 进程级设一次，全部调用点签名零改动。
- **BM25 分词语言分支**：zh = 汉字相邻 bigram（原逻辑不变），其他语言 = ASCII 整词基线——词形归一化/stemming 留给语言包贡献者（`src/prompts/README.md` 有扩展点指引）。
- **首次欢迎引导**：promptLang 未配置时，插件生效后第一条真实用户消息注入 `welcome-guide` 设置任务——AI 只依据用户消息判断语言（防呆：明确禁止以 system prompt/工具描述/文件语言为依据，不确定必须问用户）→ 改 patch → 热重载 → 告知用户；记账走 sessions accessed 伪 id `__welcomeGuide__`（不被压缩释放清除，每会话至多一次），显式配置后永久短路。
- **贡献者基建**：`npm run check-lang -- <lang>`（槽位/键集合/占位符与 zh 真源对齐自查）+ `src/prompts/README.md` 英文贡献指南（含语言包贡献流程与 tokenize 扩展点）。
- 打包：npm files 白名单新增 `lib/prompts/**`。

## v0.18.0 (2026-08-26)

### 会话列表「跳过」图标：月牙+斜杠（用户拍板）
- 左侧会话列表状态槽位新增第三态：被「跳过梦境整理记忆」的会话显示**静音灰「月牙+斜杠」**——macOS 勿扰图标同款：实心月牙被斜杠穿过并留缝（SVG mask 挖缝，单色下依然可读；每次生成随机 mask id，会话列表多图标并存互不污染）。取消跳过后自动回落回原淡黄小月牙。
- 三态优先级：**呼吸灯（dream 进行中）> 跳过 > 已整理月牙**——进行中的 dream 不打断是既有语义，跳过只压过"已整理"的停驻月亮。
- 数据零 host 改动：dream 图标管理器自己 GET `/meow-memory/skip-dreams` 对账 + 消费既有 SSE 的 `skip`/`unskip` 事件（此前这两个事件对它是"未知状态"会误删月亮，现改为独立分支处理）；新增 `mergeIconStates` 纯函数合并两路状态。
- 「…」菜单里跳过项的小图标随状态翻转：菜单项是动作按钮，图标画「点击后将变成的状态」——「跳过梦境整理记忆」配月牙+斜杠（点下去就静音）、「取消跳过」配实心月牙（点下去就恢复），与标签动词呼应（首版画当前状态被用户实测纠正）。
- **注入时灵时不灵根因修复（用户实测驱动）**：行选择器原来用 `[class$="_sessionRow"]` 结尾匹配——dsh 行类按 clsx 顺序拼接（`sessionRow, selected, menuOpen…`），当前选中会话常驻 `_selected` 尾随类，结尾匹配必然失配 → 对选中会话点「…」永远捕获不到 session id、注入被跳过。改为子串匹配 `[class*=`；注入身份升级为确定性锚点：菜单打开期间 dsh Rows 给行挂 `menuOpen` 类，直接读该行 fiber key 得 id（pointerdown 时间窗降级为兜底）；自愈从「仅标记过的菜单」扩展为「凡有菜单开着就收敛」（防抖），迟挂载/模板晚到/项被冲掉统一覆盖；portal 容器复用时发现绑定别会话的残留注入项即拆掉重注。dream 图标行扫描选择器同款修复（选中行不再暂时丢月亮）。
- 新增测试：mergeIconStates 三态优先级 ×4 + skipped 图标放置/翻转/内联/移除 ×4 + SVG mask 唯一性 ×1 + 菜单图标方向 ×3 + 选择器语义/menuOpen 锚点/注入幂等与防串味 ×13。

## v0.17.0 (2026-08-25)

### dream 第一轮清单增强：查阅留痕 + rules 防 churn（隔壁窗口实测驱动）

- **`memory_read` 查阅留痕**：此前 dream 第一轮清单 = 本窗口建立 ∪ 注入 ∪ 检索，AI 用 `memory_read` 读过的条目不留痕——prompt 里「顺便检查历史记录中所有你看到的记忆」是无清单的空指令（外部实测发现）。现在 seen 文件新增第三种痕迹 `accessed`：`memory_read` 读过的条目自动进入第一轮清单。`memory_project` 全景**不标记**（第三轮项目总结专门复查它）。
- **「顺便检查」空指令改写**：第一轮 prompt 明确告知"【本组记忆】即本窗口建立/注入/检索/查阅过的全部条目，范围到此为止"，不再要求凭回忆检查清单之外的内容。
- **rules 防 churn**：`updated_at` 距今超过 `dream.rulesReviewDays`（默认 **2** 天，0=关闭）的稳定准则不再进第一轮清单——长期准则每轮重审是低价值劳动，且易诱发无意义 update（刷新 updated_at 污染艾宾浩斯命中权重与记忆时间戳）。安全性：全局高 importance rules 每会话首轮都在注入，真矛盾会被当场 update、updated_at 刷新后自动回到审查队列。
- **压缩释放语义细化**：收到压缩信号时照旧清空 injected/searched（允许重新命中），但**保留 accessed**——它只服务 dream 扫尾范围、没有去重功能，清掉纯丢信息。
- **菜单注入健壮性修复（实测发现）**：React portal 菜单容器常驻复用——首次打开能注入、关掉重开就丢（`addedNodes` 里不再出现 `[role="menu"]` 本体）。改为时间窗内 addedNodes 快路径 + `document` 级全局兜底扫描双通道，幂等锚点换成"子项存在性"、成功注入才打容器标记。
- 新增 7 条测试（accessed 进清单/集合精确性/rules 过滤三态/释放保留 ×5 + seen 合并/释放语义 ×2），host 257 全绿。

## v0.16.0 (2026-08-25)

### 会话菜单「跳过梦境整理记忆」toggle
- 左侧边栏任意会话行的「…」菜单（重命名/建立分支/归档）里追加一项：未跳过显示**「跳过梦境整理记忆」**，点一下原地翻转为**「取消跳过梦境整理记忆」**（菜单不关，再点恢复）。被跳过的窗口不再被空闲定时器自动 dream——适合"这个窗口的记忆我自己心里有数，不用整理"的场景。
- 语义边界：只挡**自动**触发；`/dream` 命令与 `memory_dream` 工具手动触发不受限；进行中的 dream 不打断；崩溃残留租约的正常补收尾也不受影响（防僵尸租约堵死后续手动触发）。
- 持久化：memory.db 新增 `dream_skip` 表（按会话 id），跨重启生效；3080/3081 双实例共享同一 memory.db，跳过状态天然双端一致。
- 客户端注入（零 dsh 改动）：pointerdown 捕获阶段经 fiber 记录目标会话 → 只认该次点击后 1.5s 内新挂载的 portal 菜单 → cloneNode 克隆兄弟菜单项像素级对齐 + 月牙图标；点击 capture 截停不进 React 委托，不会误触原生三项也不会关菜单。菜单被 React 重渲染冲掉时自动补插（幂等）。
- 数据同步：GET/POST `/meow-memory/skip-dreams`（全量对账 + toggle）；切换经既有 SSE 通道推 `skip`/`unskip`，同实例多标签页即时同步；跨实例浏览器标签靠重连对账补齐。
- 已知限制：键盘 ↑↓ 导航只走原生三项，不含本项（鼠标优先功能）。
- 新增 14 条测试（skip 表读写往返/幂等 ×5 + client 文案翻转/目标捕获/fiber 空防护/叶子替换 ×9），host 250 全绿。

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
