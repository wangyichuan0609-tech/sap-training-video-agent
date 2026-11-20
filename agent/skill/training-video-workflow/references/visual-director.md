# Visual Director

> 状态：`DESIGN_CONFIRMED=true`，`FUNCTION_COMPLETE=true`（Recordly-only 业务视频 Vertical Slice 已通过真实 SAP 验证）。本文件定义当前内置浏览器 telemetry、Cursor Renderer、Auto Zoom 和 Highlight 的视觉决策规则；不得再用遗留扩展入口或历史 fixture 覆盖本状态。

在 A/B/C 判断形成 Rough Cut、Narration Script 根据真实操作和结果起草后，用本规则逐句确定“是否需要视觉引导、指向哪个 DOM control、是否保持现有 target、是否保留 Zoom”。Visual Director 不改写 Narration，不操作 SAP，也不生成或猜测坐标。

坐标、剪辑后时间映射和 Preview 检查见 [geometry-and-preview.md](geometry-and-preview.md)；录制、telemetry 和发布边界见 [recordly-contract.md](recordly-contract.md)。

## 输入与输出

Visual Director 只使用：

- Rough Cut 中保留的真实 SAP action 和 visible result；
- `capture/action-log.json` 中的 Raw Timeline event id、source time 和 DOM target；
- 当前 capture session 从 Browser event 派生的 Cursor telemetry；
- 当前 Narration 句子和 Scene 教学目标。

对没有 DOM event target 的稳定非交互结果，Visual Director 只能消费 [geometry-and-preview.md](geometry-and-preview.md) 已按严格例外从当前 Raw Master 实测并标记为 `captured-visible-result` 的 source-space rectangle；Visual Director 自己仍不得生成、推断或猜测坐标。

每句 Narration 对应一个轻量判断：

```json
{
  "visualIntent": {
    "highlight": true,
    "targetId": "purchasing-organization",
    "cursor": true,
    "zoom": false,
    "behavior": "focus"
  }
}
```

无明确画面对象时：

```json
{
  "visualIntent": {
    "highlight": false,
    "cursor": false,
    "zoom": false,
    "behavior": "clear"
  }
}
```

`behavior` 只使用：

- `focus`：首次聚焦当前 target；
- `keep`：上一句仍在讲同一可见 control，保持当前 target，不重复移动或停留；
- `switch`：从上一 target 平滑切换到新 target；
- `clear`：当前无具体 UI 关注点，结束旧 target 和视觉效果。

## 教学判断

只有当学员需要在当前画面定位、操作或理解某个具体 control 时，才使用 Highlight 或 Cursor 引导。

- 明确入口、Button、Tab、Search、Dropdown 或 Value Help：可使用 `highlight=true`、`cursor=true`；
- Input Field：聚焦完整 Input control；只有正常 1080p 全页看不清且该字段具有教学价值时才保留一次 Zoom；
- 输入过程：始终保留 Raw Master 中的真实 Browser 输入，不生成白色输入卡或合成逐字动画；密码、Token 和其他凭据不进入录制、Telemetry 或 Teaching Plan；
- 必需 Input、Dropdown 或 Value Help：Visual Beat 锚定最后一次真实有效输入或选择事件的完整 control；后续无关的箭头 Click 不能作为之前选择动作的 target；
- 继续解释同一字段的业务含义：使用 `behavior=keep`，不重复 Cursor 移动、`1.0 s` 停留或 Zoom；
- 结果、后续系统行为、业务背景或概念说明：默认 `highlight=false`、`cursor=false`、`zoom=false`；
- SAP Field 名称只是判断线索，不是自动高亮触发词。
- 不使用阶段提示卡片：画面左上角不叠加白底蓝色条的阶段提示框（stagePrompt 已彻底停用），避免遮挡页面内容或产生多余干扰。

同一时刻只允许一个 target。一个 Zoom 只服务一个知识点；普通点击、重复点击和在 1080p 中已清晰可读的 control 不保留 Zoom。Highlight、Cursor 和 Zoom 是教学工具，不作装饰。

## 同一个 DOM target

Recordly 的 CDP 隔离环境采集器在 event 实际发生且 control 可见时解析完整可操作 DOM control；Recordly 将 Raw Timeline 中的同一个 target 交给 Cursor、Highlight 和 Zoom：

```json
{
  "target": {
    "id": "purchasing-organization",
    "controlType": "Input",
    "x": 620,
    "y": 248,
    "width": 312,
    "height": 48,
    "coordinateSpace": "viewport",
    "source": "dom",
    "sessionId": "current-recording-session",
    "eventId": "event-07"
  }
}
```

- Cursor 使用 target 内的标准化目标点；
- Highlight 使用完整矩形；
- Zoom 使用同一矩形中心；
- 三者不得保存互不一致的坐标或分别猜测位置。

SAP Fiori 应优先解析完整 control root：Input 包括边框和附属 icon；Button、Tab、Search、Dropdown 使用完整可见 control；Value Help 在讲字段时使用完整字段，只在明确讲 icon 时使用 icon target。不得从 Label 文本长度、Cursor 点或固定宽高估算矩形。

如果交互 control 没有可靠的完整 DOM target，设置 `highlight=false`、`zoom=false`，保留不依赖猜测坐标的教学内容。宁可不框，也不要框错；不得为了补 target 重做 SAP 操作。

唯一例外是已稳定显示的非交互可见结果：用户明确需要局部结果 Zoom、当前 run 的 Action Timeline 没有该结果 target，且 [geometry-and-preview.md](geometry-and-preview.md) 已从本次 Raw Master 稳定帧实测 source-space rectangle 时，才可用该 rectangle 构图。不得拿不相关 Action ID 冒充结果 target；该例外只允许 `zoom=true`，必须保持 `cursor=false`、`highlight=false`，并通过 Focused Preview 连续实看。

## Cursor 与 Zoom 节奏

Cursor 只来自当前 `sessionId` 的 Browser Action Timeline。Recordly 必须禁用物理鼠标、全局 `uiohook` 和 Native Cursor Monitor；用户在前台移动或点击自己的鼠标不得改变 visualIntent 或成片 Cursor。

- 不同 target 之间平滑移动 `300–500 ms`；
- 到达新 target 后默认停留 `1.0 s`，再 Click；
- 同一 Control 上的连续操作使用 `keep`，不重复停留；
- Input 到达后停留、Focus，只允许一次 Zoom；输入字符期间不重复 Zoom；
- Dropdown、Value Help 等操作在 Click 后等待真实反馈，不用额外 Cursor 动作填充等待；
- 页面切换期间 Cursor 暂停，旧 target 立即 `clear`；新页面满足 Wait Condition 后才读取并切换到新 target。

完成动作后如果 sidecar 在极短时间内出现无教学意义的大空间 Cursor 突跳，应在 Teaching Plan/Final Cut 中从最后一个有效动作结束到 Scene 边界设置 `cursor=false` 或 `behavior=clear`。页面切换、结果展示，以及没有继续讲解有效 target 的 Freeze 同样隐藏 Cursor 和 Click Effect。先做当前工程的剪辑层可见性修复，不为单个视频改写 Raw Timeline 或贸然改变全局 Cursor Renderer。

Visual Director 可以决定删除无教学价值的 Auto Zoom 候选，但不得制造不存在的 action、改变业务顺序或用视觉效果掩盖失败。

## 底部结果与 Caption 避让

真实 SAP 底部 Status/Success Message 是当前 Scene 的 Actual Outcome、在 1080p 全页下难以读清，并且已经稳定出现时，可保留一次 `1.5x` Zoom 指出结果及 Document Number 的显示位置。Zoom 只能在真实结果出现后开始，知识点结束后回到全屏；Narration 说明编号位置，不朗读动态编号。

新视频 Caption 全片固定靠近底部，不生成 `captionPlacement: "top"`，不按 Scene 上下切换。Focused Preview 必须检查字幕与关键结果都能读清。历史 STO 工程中的顶部字幕仅为历史特例，保留原成品及工程，不据此改变新片规则。

## Narration、Caption 与画面同步

- 只在 target 已经可见时开始对应 Highlight；
- 结果 Narration 只能在真实结果出现后开始；
- Narration 仍在解释同一 control 时可以保持 Highlight，但 target 离屏或页面切换时必须提前结束；
- Caption 文本必须来自 Narration Script，并在真实 CosyVoice 音频结束时撤场；
- 视觉效果不应遮挡字段值、按钮文字、结果或当前 Caption safe region。

最终 visualIntent 必须在 Focused Preview 和第一条生产视频的完整 Release Gate 中验证。设计判断完成不等于 Renderer、Browser Capture 或 telemetry 功能完成。
