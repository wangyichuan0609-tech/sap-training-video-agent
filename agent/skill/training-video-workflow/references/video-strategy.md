# SAP Guided Walkthrough 视频策略

> 状态：`DESIGN_CONFIRMED=true`，`FUNCTION_COMPLETE=true`（Recordly-only 业务视频 Vertical Slice 已通过真实 SAP 验证）。本文件定义当前已生效的 A/B/C、Rough Cut、Narration、TTS 注入和 Release Gate 教学约束；执行时使用当前内部 SAP 入口和本次 run 的真实制品。

在完整 `capture/raw-master.mp4`、`capture/action-log.json`、`capture/recording-diagnostics.json` 和 `run.json` 交接后使用本策略。必须先完成教学判断和 Rough Cut，再起草 Narration Script、生成 CosyVoice 音频并进入 Final Cut。

Narration Script 起草后，按 [visual-director.md](visual-director.md) 决定每句话是否需要 Highlight、Cursor、保持已有高亮或使用现有 Zoom。不要把字段名关键词直接当作高亮指令。

输入动作使用 Raw Master 中的真实 Browser 输入。不得添加白色输入卡、合成逐字动画，也不得从 Narration、DOM 或历史数据猜测并覆盖输入值。

在不改变原有业务流程、操作顺序和真实结果的前提下，把录屏制作成由 SAP Consultant 带领新用户完成操作的 Guided Walkthrough。最高优先级始终是：

> Teach the user where to go, what to click, what to enter, and what happens next.

## 1. 教学目标

视频优先讲“怎么操作”，只补充完成操作所必需的业务含义。第一次使用 SAP 的学员看完后必须知道：

- 当前位于哪个 SAP 页面、App 或功能入口；
- 下一步点击哪里、搜索什么；
- 需要填写哪些关键字段；
- 关键字段大概代表什么；
- 页面为什么发生切换；
- 操作完成后应该看到什么结果。

不要为了显得专业而增加 SAP 背景、配置原理、Technical Definition 或与当前流程无关的理论。

## 2. Teaching Plan 前的操作判断

先理解完整录屏和真实业务结果，再按是否帮助新用户完成正确操作进行分类：

- **A — 必须引导：** 功能入口、关键点击、App 搜索、必填字段、需要用户判断的选择、页面切换和结果确认。
- **B — 简单展示：** 学员能够直接看懂、无需解释原因的标准操作，可使用简短旁白或只展示。
- **C — 剪掉或加速：** Loading、Spinner、Agent 探索、寻找按钮、失败尝试、重复输入、重复导航和无关画面直接删除；确实需要保留但无教学价值的系统等待最多加速到 `2.5x`。

只保留最终正确路径。剪辑不得改变业务顺序、遗漏必需动作、掩盖真实失败或伪造成功结果。

“只保留最终正确路径”不能变成只保留填写后的结果画面。对 Order Type、关键 Dropdown、Value Help 和关键 Input 等必需动作，成片必须依次让学员看到：

1. 目标字段或完整 control 已经可见；
2. 最后一次真实有效的输入或选择；
3. SAP 接受该值后的稳定可见结果。

删除探索、清空、失败和重复尝试时，不得把最后一次真实有效输入或选择一并剪掉。后续重新打开 Dropdown 箭头的 Click 不能冒充之前的选择动作；Scene 的 `actionIds` 和 Visual Beat 必须回指最终有效动作，而不是只保留事后状态。

每条视频都从已登录且稳定的 Fiori Home 开始，只包含后续业务操作。登录页面、凭据输入、登录错误和人工恢复过程不录制、不生成独立模块，也不在后期拼接。

本次运行若遇到登录异常、MFA、CAPTCHA 或需要人工判断，Agent 进入 `AWAITING_USER_INTERVENTION` 并暂停自动操作；若录制已经开始，先暂停或结束当前 segment。用户完成可见 Recordly SAP BrowserWindow 的受控人工接管后，Agent 重新读取页面并从安全位置继续，不保留人工排障画面，不重做已成功动作。

## 3. 每个 Scene 先回答“现在做什么”

每个 Scene 按以下顺序组织：

1. 用一句话说明当前操作目标；
2. 由 Visual Director 判断是否需要高亮或聚焦对应页面位置；
3. 执行真实 SAP Action；
4. 必要时用一句话解释关键字段；
5. 等待当前动作产生可见结果后再进入下一 Scene。

不要先讲一大段理论再开始操作。Scene 按完整的小操作目标划分，不按源 PPT 行号机械拆分，也不把每一个鼠标动作单独拆成 Scene。

A/B/C 判断完成后，先生成只保留真实正确路径的 Recordly Rough Cut。Rough Cut 确定 Scene、`clipRegions`、必要的局部 speed、Auto Zoom/Highlight 候选和剪辑后的 Browser Action Timeline 映射，但不锁死最终时长。Narration Script 必须基于 Rough Cut 中实际保留的画面起草；拿到 CosyVoice 的真实 WAV 时长后，才在 Final Cut 中调整 Scene、Freeze、Caption、Highlight 和 Zoom。

当一个小目标包含多个必须逐一定位的控件时，按“当前目标可见并完成动作”拆成连续短 Scene。例如添加筛选字段，应依次展示打开 Adapt Filters、搜索字段、勾选字段、确认、字段回到筛选栏。不要用一段旁白提前覆盖尚未出现的目标。

连续维护多个相邻字段时同样采用“一次只讲当前字段”：当前 Narration 只说明当前字段，Cursor 只指向当前字段，真实输入和 SAP 接受后的可见结果完成后再进入下一字段。不得在第一个字段仍未完成时提前报出后续多个字段，也不得用一段旁白跨越多个尚未定位的 control。

## 4. 旁白必须跟随实际操作

旁白根据当前 `SAP Action` 生成，不复制源 PPT、页面文字或字幕。旁白必须说明当前操作，并与鼠标和页面状态同步。

推荐：

- “进入 Fiori Launchpad 后，在顶部搜索框输入 Manage Purchase Orders。”
- “打开 Manage Purchase Orders 后，我们开始创建采购订单。”

禁止在画面仍停留于上一步时提前讲下一步。鼠标到达目标、点击、页面加载完成后，才能开始描述新页面或下一动作。

旁白的价值是指导用户，不是充当 Screen Reader。按钮文字或页面文字已经清楚时，使用自然目标表达，例如“确认信息无误后，我们创建采购订单”，不要机械朗读“现在点击 Create 按钮”。关键入口和关键动作仍必须明确告诉新用户在哪里操作。

## 5. 需要定位的关键操作才使用 Visual Focus

当旁白提到按钮、字段、菜单、搜索框、Tab 或页面区域时，画面必须同步明确指向该对象，不能让学员自己在复杂页面中寻找。

纯业务背景、概念、结果或后续系统行为说明默认不高亮。即使旁白出现 SAP Field 名称，也必须先判断学员此刻是否需要在当前画面定位该 control。

可根据画面选择：

- 高亮框；
- 轻微 Zoom；
- Spotlight 或 Focus；
- Cursor hover 或有目的的 Cursor movement；
- Arrow；
- 局部遮罩，降低其他区域的视觉权重。

一个 Visual Focus 只服务当前讲解对象。旁白结束或动作完成后再转移焦点。效果应帮助定位，不作为装饰，也不要遮住字段值、按钮文字或操作结果。禁止生成阶段提示（Stage Prompt）：teaching-plan.json 中不得添加 stagePrompt 属性，画面左上角不得叠加阶段提示卡片；步骤与阶段由旁白自然引导。

## 6. 给新用户建立页面空间感

首次进入新的 App 或页面时，用一两句话说明当前在哪里，并指出完成本流程所需的主要区域。

例如：

- “现在我们已经进入 Manage Purchase Orders。”
- “左侧是搜索条件区域，下方是采购订单列表。”
- “这里可以看到采购订单的 Header 和 Item 信息。”

不介绍所有页面区域。相同页面后续再次出现时不重复完整说明。

复杂页面使用 Progressive Focus：先建立完整页面位置，再依次聚焦当前需要操作的区域，例如 Header、Supplier、Purchasing Organization、Item、Material、Quantity 和 Plant。当前不需要关注的区域可以降低视觉权重，但必须保留足够上下文，让学员知道字段位于页面哪里。

## 7. 关键字段只解释一句话

只解释会影响当前操作、用户判断或流程理解的关键字段，采用：

> 字段名称 + 它是干什么的

例如：

- “Supplier 用来指定本次采购对应的供应商。”
- “Purchasing Organization 表示这张采购订单由哪个采购组织负责。”
- “Plant 表示货物最终收货的工厂。”

如果用户需要做选择，可以说明当前值和场景关系，例如：“本场景使用 NB，因此这里选择 NB。”不要扩展介绍其他未使用的类型。

没有决策空间的标准动作只说明怎么做，不解释为什么。不要展开后台配置、完整字段定义或与当前流程无关的业务理论。

## 8. App 入口

视频从已登录且稳定的 Fiori Home 开始。任何登录页面、身份验证操作或凭据都不得进入 Narration、Caption、Teaching Plan、`run.json` 或视频。

从 Fiori Home 开始，必须教会新用户从顶部 Search 找到 App：

1. 高亮顶部搜索框；
2. 旁白说明需要搜索的 App 名称；
3. 输入准确的 App 名称；
4. 从搜索结果打开 App；
5. App 加载完成后再说明已进入哪个页面。

重点是让学员知道以后从哪里进入该功能，不展开介绍 App 的产品背景。

准确的 App 名称只在这段 Search 入口教学中说一次。输入和打开结果仍完整展示，但后续“打开结果”和“页面已进入”的旁白使用自然指代，除非同名歧义会影响正确操作；不要连续重复朗读 App 名称。

## 9. 页面切换和 Wait Condition

明显页面切换必须有短暂停顿和原因说明，不能画面突然跳转而旁白连续运行。

推荐节奏：

> “打开采购订单后，我们进入订单详情页面。”

等待页面完成切换，再说：

> “这里可以看到采购订单的 Header 和 Item 信息。”

每个 Scene 必须定义可观察的 `Wait Condition`。只有满足条件后才能进入下一 Scene，例如：

- 目标 App 标题已经显示；
- 目标字段或按钮已经可见；
- 输入值已经被 SAP 接受；
- 新页面的关键区域已经加载；
- 保存后的真实成功消息或结果状态已经出现。

不要用固定旁白时长代替 SAP 页面就绪判断，也不要在结果尚不明确时继续讲成功。重要动作或结果达到稳定可见状态后，在成片时间线上保留恰好 1 秒再切到下一 Scene；该停留由后期工程复用稳定帧完成，不在 SAP 执行阶段增加等待。

## 10. 节奏和 Cursor

SAP 培训视频需要给学员看清搜索、点击、字段填写、页面切换、保存和提交等关键动作，但不保留无教学价值的加载空白。

Cursor 是教学工具，移动必须明确、有目的：

- 不同 target 之间平稳移动 `300–500 ms`；
- 到达新 target 后默认停留 `1.0 s`，再 Click；
- 同一 Control 上的连续操作不重复停留；
- Input 到达后停留、Focus，只使用一次 Zoom，输入字符期间不重复 Zoom；
- 点击后等待可见反馈；
- 不快速乱动、来回寻找或无意义停留。

Cursor 只来自当前录制 session 的 Browser Action Timeline。用户前台物理鼠标不得进入 sidecar 或成片；Recordly 必须禁用物理鼠标采样、全局 `uiohook` 和 Native Cursor Monitor。页面切换期间暂停 Cursor 并清除旧 target，满足新页面 Wait Condition 后再移动到新 target。

录制中的探索、试错、失败重试和重复操作必须从最终视频中剪掉，只保留真实且最终正确的操作路径。Loading 和 Spinner 直接删除；必须保留的系统等待最多 `2.5x`，关键动作本身不能快到学员看不清。

开场默认控制在 3–5 秒，结尾只保留一句完成说明。直接切换或短过渡优先；同一区域连续操作保持同一构图。stable Freeze 最多增加 `2 s`；仍不足时缩短 Narration。不要为了缩短片长整体加速旁白，也不要用长时间冻结画面迁就冗长讲稿。

真实输入可能只持续一两百毫秒。此时使用输入前、来自同一 Raw Master 的稳定画面增加短 `preActionHoldMs`，让学员先看清目标；真实输入本身保持 `1.0x`，输入后继续保留 SAP 接受值的稳定结果。需要时只对完整 Input control 使用一次教学 Zoom。不得慢放真实键入、生成逐字动画、添加输入卡，或制造停顿和错误。

中文和中英混合 Narration 默认 `ttsSpeed: 0.95`。当用户明确要求连续字段讲解放慢时，先按字段拆 Scene，再只对这些密集字段 Scene 使用 `ttsSpeed: 0.90`；这不是全片或后续视频的新默认值。较慢旁白超出源动作时长时，优先使用有教学意义的输入前稳定停顿或保留真实结果画面，并继续遵守 `2 s` Freeze 上限；不得依赖无意义长 Freeze。

## 11. 编号和普通数据

不要朗读 Purchase Order Number、PR Number、Supplier Number、Material Number、Document ID、GUID、系统自动生成编号、长串金额或代码。

系统显示采购订单编号时，旁白说：

> “采购订单已经成功创建，系统会自动生成对应的采购订单编号。”

编号对当前培训不重要时只保留在画面中。如果下一步需要使用，可以提示“记住刚刚生成的采购订单号”，但仍不朗读完整号码。

当采购组织、工厂、公司代码等较短的标识型业务输入确实需要讲出时，应逐位朗读。字幕保留界面中的原值，使用 Scene 的 `ttsText` 只调整内部发音。不要把年份、金额、数量等真实数字机械改成逐位读法。

字段值本身没有教学意义时只展示输入动作，不逐项念出数字。

## 12. 自然的培训语言

语气应像 SAP Consultant 坐在用户旁边进行现场指导：专业、清楚、自然、直接。

推荐：

- “接下来填写供应商。”
- “这里选择对应的采购组织。”
- “然后进入 Item 信息。”
- “确认数量和工厂后，我们可以继续。”
- “最后检查信息，然后保存。”

避免“步骤三”“步骤四”等脚本式朗读，除非原培训材料明确要求保留 Step 编号。不要增加传统课程套话、产品宣传或泛化 SAP 理论。

普通业务词优先使用自然中文，例如“供应商”“字段”“分区”。保留学员需要在界面上辨认的 Application、Button、Field Label 和 Tab 名称。关键字段首次出现时只补一句本任务中的作用。示例输入值可以说明，但应提示实际操作使用自己的业务条件；不要朗读结果条数、供应商编号或其他无教学价值的数据。

只描述画面真实显示的信息。快速视图只出现导航链接时，就说明它提供导航链接；不要泛称它能确认未显示的名称或业务属性。

## 13. Scene 数据要求

每个 Teaching Plan Scene 至少包含：

- `Objective`：这一小段用户需要完成什么；
- `SAP Action`：录屏中的实际系统操作；
- `Visual Focus`：当前需要高亮、聚焦或指向的位置；
- `visualIntent`：是否 Highlight、是否移动 Cursor、是否保持同一 target、是否使用现有 Zoom；
- `target`：Browser 从真实 DOM control 得到的唯一矩形，供 Cursor、Highlight 和 Zoom 共用；
- `Narration`：根据 SAP Action 重新组织的讲师旁白；
- `Wait Condition`：进入下一 Scene 前必须出现的可见状态。

Scene 的 action、target 和结果必须能回指 `capture/action-log.json` 中的真实 Timeline event id；Cursor、Highlight 和 Zoom 共用 Browser 提供的同一 DOM target。不得根据 Narration 猜坐标，页面切换后不得沿用旧 target。

`Narration` 必须与 `SAP Action`、`Visual Focus` 和 `Wait Condition` 一致，不得复制源 PPT 作为旁白，也不得描述录屏中没有发生的动作或结果。

`Narration Script` 仍是 CosyVoice TTS 和 Caption 的唯一文本源。Caption 只允许按真实语音 timing 做换行和分段，不得另行改写造成字幕与语音割裂。

## 14. 最终检查

生成最终视频前逐项检查：

1. 第一次使用 SAP 的用户能否知道功能从哪里打开？
2. 旁白是否与 Cursor、点击和页面状态同步？
3. 讲到按钮或字段时，画面是否明确指向该对象？
4. 纯背景、概念或结果说明是否避免了机械高亮？
5. 是否存在单纯朗读页面文字或源 PPT 的内容？
6. 是否朗读了无意义的系统编号或数据？
7. 是否加入了当前操作不需要的 SAP 理论？
8. 是否剪掉了 Agent 探索、等待、失败和重复操作？
9. 关键字段是否只有简短、必要的一句话解释？
10. 页面切换是否有清楚的原因、停顿和 Wait Condition？
11. 学员是否能够看清每个关键操作并知道下一步发生什么？
12. 整体是否像 SAP Consultant 在现场指导，而不是 AI 播放录像并念字幕？
13. A/B/C 是否先于 Rough Cut，Narration 是否只描述 Rough Cut 中保留的真实画面？
14. 用户物理鼠标是否完全没有进入 telemetry 或成片？
15. Input 是否只 Zoom 一次，页面切换后旧 target 是否清除？
16. 视频是否从已登录的 Fiori Home 开始，并且完全没有登录画面或登录片段拼接？
17. 每个必需字段是否展示了目标、最后一次真实有效输入/选择和 SAP 接受后的结果，而不是只展示已填状态？
18. 多字段维护是否逐字段讲解，Narration 和 Cursor 是否只服务当前字段？
19. 动作结束、页面切换、结果展示或无 target Freeze 中是否已经隐藏无教学意义的 Cursor 尾部运动？
20. Output-only 修复的 Focused Preview 是否覆盖改动和受它影响的可见结果，并复用原始 SAP 录制？

任一项不满足时，调整 Teaching Plan、Narration、Visual Focus 或剪辑后重新检查。完成设计判断不等于功能完成；只有 Focused Preview、真实 SAP Auto Zoom/Highlight Release Gate、最终 `1920x1080` 30 fps MP4、`ffprobe` 和完整 FFmpeg decode 全部通过，才允许发布。
