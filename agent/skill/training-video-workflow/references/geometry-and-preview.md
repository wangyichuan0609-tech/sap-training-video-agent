# Browser Capture 坐标、时间映射与预览门禁

> 状态：`DESIGN_CONFIRMED=true`，`FUNCTION_COMPLETE=true`（Recordly-only 业务视频 Vertical Slice 已通过真实 SAP 验证）。下述内容是当前内置 SAP Browser Capture、Raw Action Timeline 映射和预览门禁的实现/验收约束；不得再按遗留扩展入口判断当前状态。

仅在 Cursor、Click Effect、Highlight、Zoom、裁剪或剪辑后同步需要处理时使用。详细制品和发布边界见 [recordly-contract.md](recordly-contract.md)。

## 单一坐标链

每个交互 control 的 Raw Action Timeline event 和后续教学动作只能使用一条坐标链：

1. Recordly 的 CDP 隔离环境采集器在目标 SAP WebContents 的 viewport 中观察真实 DOM event，并读取完整 DOM control 的 `DOMRect`、target 和 Cursor point；Browser event 自带当前 capture session 的 source time；
2. Browser Capture Source 记录该 WebContents 页面流，并在 Raw Master source frame 中描述 viewport 对应的 `contentRect`；
3. target 从 viewport 映射到 Raw Master source frame 一次；
4. source media、Browser-derived Cursor、Click Effect、Highlight 和 Zoom 一起应用相同的画面适配与 Scene Zoom；
5. 最终输出统一适配到 `1920x1080`，不得再单独对 overlay 叠加 crop、缩放或黑边偏移。

viewport 到 source 的目标映射为：

```text
sourceX      = contentRect.x + viewportX      * contentRect.width  / viewport.width
sourceY      = contentRect.y + viewportY      * contentRect.height / viewport.height
sourceWidth  =                 viewportWidth  * contentRect.width  / viewport.width
sourceHeight =                 viewportHeight * contentRect.height / viewport.height
```

Raw Timeline 中的 normalized point 必须标明相对空间。若以 viewport 归一化，先还原到 viewport，再使用上式；不得把 normalized point 当作最终视频坐标。Browser event 无法绑定到当前 capture session 或没有可靠 DOM target 时，保留事件但下游不得猜测坐标或伪造 target。

## Target 合同

Raw Timeline 中每个 target 至少包含：

- 当前文档的 `sessionId`、event id 和稳定 target id/selector；
- control type 与 Target Name；
- `x`、`y`、`width`、`height`；
- `coordinateSpace` 和来源；
- source time 和页面/document 状态标识。

Wait Condition、Actual Outcome 和业务语义属于后续 Training Agent 的教学判断，不是 Browser Capture 层的采集字段。

目标规则：

- DOM target 使用 `coordinateSpace: "viewport"` 和 `source: "dom"`；
- Input 使用完整 UI5 control root，包括边框和附属 icon，不只保存内部 `<input>`；
- Button、Tab、Search、Dropdown 和 Value Help 使用当前旁白所指的完整可见 control；
- Cursor 使用矩形中的目标点，Highlight 使用完整矩形，Zoom 使用同一矩形中心，不保存三套互相独立的坐标；
- Highlight 只做小幅外扩，不遮住标签、按钮文字或字段值；
- 不从 Label 长度、Cursor 点、截图猜测或固定尺寸推导 DOMRect。

页面导航、滚动导致 control 失效或 document/page identity 改变时，立即结束旧 target、Highlight 和 Zoom。页面切换期间 Cursor 暂停；新页面满足 Wait Condition 后，读取新 DOMRect，再移动到新 target。旧 target 不得跨页面复用。

## Captured visible result 的受控例外

DOM-first 规则继续适用于所有可操作 control。只有同时满足以下条件，才允许为一个非交互可见结果建立 source-space rectangle：

- 结果已在本次 Raw Master 的稳定帧中真实出现；
- 用户明确要求局部结果 Zoom，且全页 1080p 下不易读清；
- 当前 run 的 Action Timeline 没有该结果的可靠 DOM target；
- rectangle 从本次 Raw Master 对应稳定 source frame 实测，而不是根据 Narration、预期位置、历史截图或参考视频猜测。

该目标使用 `coordinateSpace: "source"`、`source: "captured-visible-result"`，并由 Scene/Visual Beat 记录有效的 source-time 区间；它不得伪造或绑定不相关 Action ID，不得跨页面或跨 run 复用。source rectangle 只用于结果 Zoom 构图，不能驱动 Cursor、Click Effect、Highlight 或任何可操作 control。Zoom 必须在结果真实出现后开始，并使用与 source media 相同的适配链投影到最终 `1920x1080` 画面。

## Cursor 与 Input 时序

时序以 Browser Capture 的 source time 为基准，并绑定当前 `sessionId`：

- 不同 target 之间的 Cursor 移动为 `300–500 ms`；
- 到达新 target 后默认停留 `1.0 s`，随后 Click；
- 同一 Control 上的连续操作沿用当前 target，不再次增加 `1.0 s` 停留；
- Input Field 首次到达后停留、Focus，并只生成一次 Zoom；
- 输入字符期间可保留当前构图，但不逐字符重算 target、不重复 Zoom；
- Click 后等待真实 UI 反馈；Dropdown、Value Help 和页面导航的等待由 Wait Condition 决定。

这套 Cursor 停留是后处理的教学节奏，不允许通过让真实 SAP 无意义等待、重复点击或重做操作来制造。

## 剪辑后的时间映射

Raw Master 上的 action、Cursor、Click、target 和 diagnostics 都使用 source time。Rough Cut 生成 `clipRegions`、必要的局部 speed 和 Freeze 后，必须由同一个 source-to-timeline 映射投影：

- Cursor move/click/mouseup；
- Click Effect；
- target 有效区间；
- Highlight 和 Zoom；
- Scene 的真实画面区间。

被 C 类剪掉的 source 区间，其 Raw Timeline 派生的 Cursor 和视觉效果也必须被删除。加速或 Freeze 不得让 Cursor 漂移到错误 control，也不得让旧 Highlight 延伸到页面切换之后。Caption 使用 Final Cut 的 timeline time；其结束时间来自真实 CosyVoice 音频，不从 source time 或文字长度猜测。

若最后一个有效教学动作之后、Scene/clip 边界之前出现极短时间的大空间 Cursor 突跳，只在 Final Cut timeline 上为该尾部增加 `cursor=false`/Click Effect visibility mask；不得改写 Raw Timeline、source 坐标或伪造新的停靠点。页面切换、Loading、结果展示和不承载有效 target 的 Freeze 也必须隐藏 Cursor；只有 Freeze 仍在讲解同一有效 target 时才能保持现有效果。

## Focused Preview

完整导出前，选择能覆盖本次风险的最短连续范围，例如“字段选择 -> Input Focus/输入 -> 执行 -> 结果出现”。局部文案或 Zoom 修复核对受影响的画面和衔接；跨段恢复、连续输入或后续结果的时序受影响时，把相应结果 Scene 一并纳入。使用与全片一致的 Raw Master、Cursor、效果、Caption 和 TTS，以 `1.0x` 连续实看。

检查：

- Cursor 是否落在正确 DOM control，移动是否平滑；
- 新 target 是否停留 `1.0 s` 后再 Click，同一 Control 是否没有重复停留；
- Input 是否只 Zoom 一次，输入期间是否保持稳定；
- Highlight 是否覆盖完整 UI5 control 且不挡文字；
- Cursor、Highlight 和 Zoom 是否始终共用同一 target；
- 页面切换后旧 target、Highlight 和 Zoom 是否立即清除；
- Rough Cut、局部 speed 或 Freeze 后的 Cursor/Click/Zoom 是否仍与画面同步；
- Caption 是否等于 Narration Script，并在真实 TTS 音频结束时撤场；
- 结果旁白是否只在真实结果出现后开始。
- 动作结束到下一 Scene 的 Cursor 是否没有尾部突跳，无 target 的页面切换、结果展示或 Freeze 是否没有 Cursor；
- 底部成功消息是否只在真实结果出现后使用一次 `1.5x` Zoom，退出时是否回到稳定全页；
- `captured-visible-result` 的 source rectangle 是否在整个 Zoom 区间持续对齐真实结果；
- 新视频 Caption 是否全片保持底部，同时关键结果仍可读清；历史 STO 的顶部字幕不作为新片模板。

只有视觉和时间同步都明确通过，才能进入完整导出；结果不明确时暂停发布，不重做 SAP 操作。

## 第一条生产视频的完整 Release Gate

在真实 SAP 中覆盖 Button、Input、Dropdown、Value Help、Tab、页面导航和结果页面，同时让用户在前台持续移动和点击物理鼠标。必须确认：

1. 只有目标 SAP `webContents.id` 的页面画面进入 Raw Master；
2. 用户物理鼠标没有进入 Cursor sidecar 或成片；
3. 只有当前 `sessionId` 的 Browser Action Timeline 被接受；
4. Input 不重复 Zoom，普通点击不会造成过度 Zoom；
5. Highlight 与完整 control 对齐；
6. 页面切换后旧效果全部清除；
7. Rough Cut 后 source-to-timeline 映射仍正确；
8. 最终 `1920x1080` 画面不存在重复偏移、错误 crop 或 overlay 漂移。

该 Gate 失败时继续修改并重新验证 Recordly 功能；不得将设计确认或局部 Preview 误报为功能完成。
