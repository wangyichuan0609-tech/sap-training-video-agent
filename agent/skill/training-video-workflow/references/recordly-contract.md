# Recordly Browser Capture、工程与发布契约

> 状态：`DESIGN_CONFIRMED=true`，`FUNCTION_COMPLETE=true`（Recordly-only 业务视频 Vertical Slice 已通过真实 SAP 验证）。本文件记录当前内置 SAP Browser Capture、自动录制控制、session-scoped Raw Action Timeline、确定性工程编译和 Release Gate 的已验收边界；生产判断必须以当前内部入口和本次 run 制品为准，不得读取遗留扩展入口或历史 fixture 推断状态。

本契约覆盖从 Recordly 内置 SAP Electron/Chromium BrowserWindow 录制到最终 MP4 发布的边界。Recordly 的 WebContents/CDP bridge 负责 Browser Use，CDP 隔离环境采集器负责从同一 SAP `webContents` 自动采集真实 DOM event，Browser Capture Source 只接收同一 SAP `webContents` 的页面视频。Recordly 不接收 SAP Agent 的逐动作上报；它负责录制、Raw Action Timeline、后期工程、预览、导出与验证。外部 Chrome、GPT Extension、Capture Companion、开发者模式扩展和 `tabId/tabCapture` 不再属于生产 Workflow。

## 一次运行的固定边界

一个 PPTX 对应：

- 一次逻辑 SAP 操作；
- 一份 `run.json`；
- 一份权威 Recordly Raw Master；
- 一个最终 MP4。

已成功的 SAP 动作不得为了补画面、Cursor、Zoom、Highlight 或重新导出而重复执行。恢复产生的 segment 属于同一次逻辑运行，最终确定性合成为一份 Raw Master；原 segment 和恢复证据继续保留，但不得形成第二条生产链路。

## 登录与录制边界

登录仅用于建立录制前 Session，不属于培训媒体：

- 正常登录、Session 恢复、MFA、CAPTCHA、安全挑战和人工判断必须在 Capture Start 前完成；
- 首段从已登录且稳定的 Fiori Home 开始。恢复时使用前一段的安全位置和当前业务页的标题及可见控件文字，沿用同一 DEV/QAS 环境和 Client；
- 不生成、不维护、不读取、不验证、不复用，也不拼接独立登录教学资产；
- 登录页面、User、Password、Language、Log On、登录错误和人工排障过程不得进入 segment、Raw Master、Focused Preview 或最终 MP4；
- 现有历史登录资产不属于生产输入。

登录异常、MFA、CAPTCHA 或需要人工判断时仍使用受控人工接管：Agent 进入 `AWAITING_USER_INTERVENTION`，暂停所有自动浏览器操作；若录制已开始，先结束当前 segment，并确保该登录或排障区间不进入权威 Raw Master。用户完成后，Agent 重新读取真实页面，从已记录的安全位置继续。正常登录问题必须在正式录制前解决并到达 Fiori Home。

## Browser Capture Source

目标 Recordly 设计新增以 `webContents.id` 绑定的内置 Browser Capture Source：

```text
Recordly SAP BrowserWindow + persistent defaultSession
-> SAP webContents.id
-> WebContents media source + Recordly video-only recorder
-> Recordly Browser Capture Source
```

它必须满足：

- 只接收指定 SAP WebContents 的页面视频流；
- 不捕获桌面、窗口标题栏、其他 Recordly 窗口或其他应用；
- 不采集、推断或合成用户前台物理鼠标；
- 使用 Recordly 持久化 `session.defaultSession` 与正常 `userDataDir` 复用缓存和登录 Session；
- 目标 SAP BrowserWindow 由 Agent 独占。除 Agent 明确发起受控人工接管外，用户不得与 Agent 同时操作该页面；
- 视频与 Raw Action Timeline 留在 Recordly 进程内；外部 Agent 只通过受认证的控制路径启动/停止当前 capture，每个 run 绑定高熵 `sessionId`、唯一 `webContents.id` 和递增 event identity。

冻结的控制语义为（CLI 入口固定为 `scripts/recordly-sap-capture.mjs`；`record-start`/`record-stop` 仅是概念名称，不是可调用的旧扩展命令）：

1. Agent 运行 `scripts/recordly-sap-capture.mjs start`；
2. Recordly 绑定当前可见 SAP `webContents.id` 并自动取得页面 media source；
3. 等待录制状态明确为 `recording`；
4. Recordly 内置 WebContents/CDP bridge 执行一次 SAP 计划；
5. 成功、阻塞或异常时运行 `scripts/recordly-sap-capture.mjs stop`；
6. 等待终态 `completed` 或 `failed`，再交接制品。

正常 run 不再有浏览器插件授权点击；Start/Stop 自动完成。登录、MFA、CAPTCHA 和安全挑战仍可触发受控人工接管。这些名称定义目标控制合同，只有代码和真实运行通过后才可声称接口可用。

## Raw Master 与运行制品

一次完成的运行至少交接：

```text
capture/raw-master.mp4
capture/raw-master.mp4.cursor.json
capture/action-log.json
capture/recording-diagnostics.json
run.json
```

- `capture/raw-master.mp4` 是本次 SAP 操作的权威录屏源；
- `*.cursor.json` 只保存当前 session 从 Browser Timeline 派生的 Cursor/Click telemetry；
- `action-log.json` 保存 Browser-originated Raw Action Timeline：event type、session-bound `sourceTimeMs`、target/text、稳定 selector 或 identity、DOMRect、Control Type、viewport、Cursor point 和 navigation 信息；Visible Result、Wait Condition、Actual Outcome 由后续 Training Agent 基于 PPT 和 Timeline 判断；
- `recording-diagnostics.json` 保存 Browser Capture、session、segment、错误和终态诊断，不包含凭据；
- `run.json` 保存一次逻辑运行的业务结果、制品引用、安全恢复点和状态。

Recordly 录制期间写入可恢复的 video-only `segment.webm.part`。Stop 后由 FFmpeg 规范化为 H.264、`yuv420p`、CFR 30 fps 的 `capture/raw-master.mp4`；验证通过后才清理临时文件，失败时保留 `.part` 与诊断。

Password、Token、登录凭据和其他敏感输入不得进入任何 sidecar、日志、Caption、Narration 或报告。业务 Input 值只有确有教学意义时才进入 Scene Metadata。

录制或 DOM 操作失败时禁止回退到 OS Mouse，也不得抢占用户前台。系统必须停止当前录制、保存已有制品和 `safeRecoveryPoint`；修复后从安全位置追加 segment，不重做已经成功的 SAP 动作。

## Operation evidence

新 run 在录制前将 `operation.completed` 置为 `false`，使用 `operation.planVersion: 2`。每个必要步骤在原 `operation.plan` 中保留一个对象。例如，保存动作可以记录为：

```json
{"id":"save","sourceSlide":5,"action":"Save","expectedResult":"SAP 显示新建单据号","status":"pending"}
```

有 PPT 字段值时，用 `inputs` 数组逐个记录 `field`、字符串 `value` 和 `kind`（`required` 或 `example`）。页码从 1 开始。步骤默认必需，PPT 明确可选的步骤可标 `required: false`。身份凭据和登录操作不进入计划。

执行时在原步骤填写 `status`（`pending/completed/skipped/blocked/uncertain`）及 `observation.visibleResult`。交接后将实际原片事件 ID 写入 `observation.eventIds`；仅能在结果画面确认时，使用合并后的 Raw Master 帧时间 `observation.sourceTimeMs`。两者可同时记录。发生写操作后结果不明，保留恢复点并只读核实。放行前检查每个必需步骤、事件或帧引用、整体完成标志和阻塞情况。旧字符串计划沿用其已记录的整体业务完成状态。

## Session-scoped Raw Action Timeline

Recordly 的 CDP 隔离环境采集器从同一 SAP WebContents 观察真实 Focus、Input、Click、Key、Change、Navigation、Tab switch、DOMRect、Control Type、viewport 与 DPR，生成当前 capture session 的 Raw Action Timeline。SAP Agent 不提交 action-start/action-complete，也不写 action log；Recordly 不在这一层判断 Visible Result、Wait Condition、Zoom、Highlight 或 Narration。

每个 Timeline event 绑定：

- `sessionId` 与 capture-session-monotonic `sourceTimeMs`；
- event type、event identity、navigation 信息和非敏感 target/text；
- 稳定 selector 或 target identity；
- 真实 DOM control 的 control type、DOM rectangle 和 viewport；
- cursor point、normalized target point 和 cursor type。

后续 Training Agent 读取 PPTX、Raw Action Timeline 和真实画面结果，决定保留的 Scene、Visible Result、Zoom、Highlight 和 Narration。

Recordly 的 internal-browser telemetry mode 必须：

- 只接受当前录制 `sessionId` 的事件，拒绝迟到事件和其他 session 的事件；
- 禁用物理鼠标采样；
- 禁用全局 `uiohook`；
- 禁用 Native Cursor Monitor；
- 只用 Browser Action Timeline 驱动 Recordly 自身 Cursor Renderer、Click Effect、平滑和 Auto Zoom；
- 在剪辑后通过明确的 source-time 到 timeline-time 映射保持 Cursor、Click、Zoom 和 Highlight 同步。

Cursor 节奏固定为：

- 不同目标之间平滑移动 `300–500 ms`；
- 到达新目标后默认停留 `1.0 s`，再产生 Click 和 Click Effect；
- 同一 Control 上的连续操作不重复停留 `1.0 s`；
- Input Field 到达后停留 `1.0 s` 并 Focus，只触发一次 Zoom；输入字符期间不逐字符 Click 或重复 Zoom；
- 页面切换期间 Cursor 暂停并清除旧 target；新页面满足 Wait Condition 后，才向新 target 移动；
- Dropdown、Value Help 等点击后按真实反馈继续等待，不用表演性停顿替代 Wait Condition。

## 教学与工程编译顺序

顺序固定为：

```text
完整 Raw Master + action/diagnostics
-> Business Goal / Learner Outcome / 3–5 Knowledge Points
-> A/B/C 教学判断
-> Recordly Rough Cut
-> Narration Script
-> CosyVoice TTS
-> Recordly Final Cut
-> Focused Preview + Release Gate
-> Final Export + Media Validation
```

Rough Cut 根据 A/B/C 判断生成：

- `clipRegions`：只保留真实正确路径；对每个必需业务字段，必须保留最后一次成功的真实 Browser Input/选择及 SAP 接受后的可见状态，不能只留下填写结果；
- `speed`：只压缩必须保留但无教学价值的等待；
- `zoomRegions`：Auto Zoom 候选；
- `annotationRegions`：Highlight 候选；
- Browser Action Timeline 派生 Cursor telemetry 的剪辑后时间映射；
- 以“一个完整教学目标 + 一个可见结果”为单位的 Scene。

Rough Cut 之后才起草 Narration Script。Narration 是 CosyVoice 和 Caption 的唯一文本源。CosyVoice 使用 Workspace 级 content-addressed cache；每个 run 保存 WAV、cache key、reference 证据、SHA256 与 `ffprobe` 时长。真实 WAV 时长写入 Final Cut 后，再调整 Scene、Freeze Frame、Caption 结束时间、Highlight 和保留的 Zoom。stable Freeze 最多 `2 s`，必要等待最多 `2.5x`；更长时缩短 Narration，Loading、探索、失败和重复路径直接删除。最终视频永久排除登录画面与登录片段拼接；整片默认播放率为 `1.0`。

必需真实输入过快、学员来不及定位字段时，Teaching Plan 使用紧邻输入前的真实稳定源帧同时声明 `preActionStableSourceTimeMs` 与最小必要的 `preActionHoldMs`，最长 `2 s`。该 Hold 只帮助动作前定位；不得覆盖、替代、重演或减速真实输入，真实输入仍保持 `1.0x`。

交互 control 的 Cursor、Highlight 和 Zoom 必须共用 Browser 提供的同一 DOM target。页面切换后旧 target 立即失效。无法可靠定位完整 control 时宁可省略 Highlight 或 Zoom，也不得猜固定坐标；不得因此重复 SAP 操作。没有 DOM event target 的稳定非交互结果，只能按 [geometry-and-preview.md](geometry-and-preview.md) 的 `captured-visible-result` 严格例外使用实测 source rectangle，并且只能用于结果 Zoom。

## Output-only 修复

用户指出的是剪辑、Narration、Cursor、Zoom、Highlight 或 Caption 问题时，复用同一份 Raw Master、Action Timeline、Cursor sidecar、Teaching Plan 和已验证的 CosyVoice cache/manifest；只有 Narration 实际变化的 Scene 才重新合成对应 TTS。不得重新登录、重新操作 SAP、重新创建业务对象、调用 Capture Start、追加 segment 或重做已经成功的业务动作。

修复后只重编受影响的下游工程，预览范围按下节选择。连续实看通过后完成 Full Export 和最终媒体验证。

## Focused Preview 与 Auto Zoom/Highlight Release Gate

完整导出前，选出需要一起核实的动作和可见结果对应的 Scene。编译器保留这些 Scene 之间的最短连续范围；若改动影响片尾结果，把结果 Scene 也列入。例如：

```text
选择字段 -> 输入值 -> 执行 -> 出现结果
```

Focused Preview 必须检查 Cursor、Click Effect、Zoom、Highlight、Caption、TTS、Freeze、页面状态和 Narration 的同步。

第一条生产视频发布前，必须用真实 SAP 操作完成 Auto Zoom/Highlight Release Gate。已验收能力在实现、依赖和环境未变化时复用既有证据；相关能力改变时只重验受影响项，不把首次验收当成每次视频的前置操作。首次覆盖：

- Button Click；
- Input Focus 和输入；
- Dropdown；
- Value Help；
- Tab 切换；
- 页面导航；
- 结果页面；
- 用户在前台持续移动和点击自己的物理鼠标；
- Rough Cut 后 Cursor/Zoom/Highlight 的时间映射。

门禁必须证明：用户前台鼠标完全没有进入 sidecar；Cursor 落在正确 Control；Input 只 Zoom 一次；Auto Zoom 不过度；Highlight 覆盖完整 UI5 Control；页面切换后旧效果清除；剪辑后所有效果仍同步。失败时继续修正 Recordly 设计或实现，不发布生产视频，也不切换其他生产链。

## 最终导出与发布

最终只做一次完整成品编码，目标为：

- H.264 video；
- AAC audio；
- `1920x1080`；
- `30 fps`；
- MP4；
- source quality。

随后必须执行 `ffprobe`、完整 FFmpeg decode、视频流和音频流检查、Caption/TTS/画面同步检查，并记录最终文件 SHA256 与设置 sidecar。只有 Browser Capture、session telemetry、Rough Cut、TTS 注入、Focused Preview、Auto Zoom/Highlight Release Gate、完整导出和最终媒体验证全部通过，才能发布完整 MP4。不得发布 Partial Video。

这些媒体验证由 Export 自动执行。Focused Preview 的视觉登记仅在 MP4、工程、编译合同、验证选项和验证器均未变化时复用先前结果；绑定不一致或旧证据缺少绑定时先重新自动验证。新导出的媒体必须完整检查，已验证且未变化的成品无需再次手动解码；复用不会跳过实际连续观看或最终发布门禁。

Recordly 是唯一生产实现。缺失能力必须在 Recordly 内置 SAP 浏览器、内置 DOM collector、确定性编译脚本或现有 CosyVoice adapter 中完成；不维护第二条录制、剪辑或渲染链路，也不切回 Chrome 插件路径。
