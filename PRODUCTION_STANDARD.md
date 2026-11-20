# 培训视频生产标准

本文件是当前项目今后生成同类视频的操作入口。固定参数以代码为唯一来源；需要 Agent 判断的内容继续由现有 Training Video Skill 和本项目 `AGENTS.md` 约束，不在这里复制第二套实现。

文档按职责读取：`AGENTS.md` 保存项目边界，本文件保存生产入口，两个 Skill 保存操作方法，reference 按阶段读取，`MEMORY.md` 只保存长期决策与基线，`CONTEXT.md` 只定义术语。代码或当前明确规则与历史基线的视觉选择不同，不把历史特例提升为新片默认值。

## 已接受基线

- 用户接受的视频：`artifacts/recordly-sap-display-supplier-list-20260926-061920/final/training-video-improved-v3.mp4`
- SHA256：`F7BF93CFAED3B4A75850E711D8DADFAD4CEB44044D0DDAF2C240423B05D8438B`
- 实际生成链：`teaching-plan.json` + `tts-manifest-v4.json` + `final-v4.recordly.bak`，文件名中的 `v3` 不是实际工程版本。
- 完整来源清单、外部输入哈希、精确工程哈希和已知证据缺口：`baselines/accepted-display-supplier-list-20260926.json`
- 不可改写的恢复点：Git annotated tag `accepted-display-supplier-list-20260926-v1`。

满意视频、Raw Master、原始 segment、capture sidecar、20 个 v4 WAV、CosyVoice 参考音频/文本和外部 PPTX/手录参考片都属于输入或基线，不是普通缓存。

## 今后的唯一入口

开始前提供：PPTX 绝对路径、目标 DEV/QAS、输出 run 名；如果有人工参考片，再提供其绝对路径。登录只用于录制前建立 Session，不进入任何视频。

日常预检只确认本次输入/输出位置、DEV/QAS、当前 Recordly 入口和稳定的已登录 Fiori Home；Capture Start 后确认当前 session/WebContents 已 recording。已验收且未变化的能力不重复检查、安装或跑 fixture。相关实现、依赖或环境改变时只验证受影响部分；仅修后期时直接使用现有 run，不打开 SAP。

1. 按 Fiori Skill 从 PPTX 提取一次真实操作，录制前把步骤写到本次 `run.json` 的 `operation.plan`。来源页、示例或必填值、成功条件及结果证据使用[步骤字段约定](agent/skill/training-video-workflow/references/recordly-contract.md#operation-evidence)。新 run 的 `environment` 保存已核实的 `system`（DEV/QAS）、三位 `client` 和 `origin`（SAP HTTPS 协议、主机及端口）。从已确认的目标 URL 取 origin，省去登录参数和凭据。
2. 如第一页适合作封面，使用 `scripts/build-training-cover.mjs` 只移除日期、项目名等非教学元数据，并用 `--require` 保护标题和稳定品牌。运行时通过 `--runtime-node-modules` 指向 Codex workspace dependencies 中的 Node modules。封面输出固定为 1920×1080 PNG。
3. 在已登录并稳定到达 Fiori Home 后，使用以下唯一录制/控制入口：

   ```powershell
   node .\scripts\recordly-sap-capture.mjs start --output=<run>\capture\segment.webm
   node .\scripts\recordly-sap-control.mjs state|find|click|type|press|scroll|wait ...
   node .\scripts\recordly-sap-capture.mjs stop
   ```

   Start 返回 `recording` 后再执行业务操作。`verifiedStart` 给出本次核实的系统、Client、origin 和开录页面类型。

   中断后追加录制时，`run.json` 顶层的 `safeRecoveryPoint` 应与上一段最后确认的业务位置一致。在 `capture.recoveryPage` 填写业务页标题 `title` 和同一页面可识别当前进度的控件文字 `visibleText`。Recordly 会核对上一段的真实事件记录和当前业务页，再从已确认的位置继续。

4. 用下面的只读命令获取操作计划、分组事件、原事件编号和源时间；据此定位原片，核对页面结果。将每个完成步骤的观察写回 `run.json`。查看完整 Raw Master 后编写 `<run>\recordly\teaching-plan.json`（教学目标、Scene、剪辑范围和视觉重点），编译 Rough Cut 后再写旁白。已有录屏和粗剪决策都未变时复用已有粗剪。

   ```powershell
   node .\scripts\operation-evidence.mjs <run>
   node .\scripts\build-recordly-project.mjs <run> --mode=rough --plan=<plan> --output=<rough.recordly>
   ```

5. 初次配音、旁白或声音配置变化时生成 TTS 清单。仅改 Zoom、裁切等画面时，直接把已有清单交给 Final Cut；编译器核对每个有声 Scene 的旁白、语速、参考配对、发音和现有 WAV。由 Agent 选出本次要一起核实的关键动作和结果 Scene，`--risk-scenes` 自动选取覆盖它们的最短连续范围。

   ```powershell
   node .\scripts\generate-recordly-tts.mjs <run> --plan=<run>\recordly\teaching-plan.json --output=<run>\recordly\tts-manifest.json
   node .\scripts\build-recordly-project.mjs <run> --mode=final --plan=<plan> --tts-manifest=<tts-manifest> --output=<full.recordly>
   node .\scripts\build-recordly-project.mjs <run> --mode=final --plan=<plan> --tts-manifest=<tts-manifest> --risk-scenes=<风险动作与受影响结果的Scene编号列表> --output=<focused.recordly>
   node .\scripts\recordly-control.mjs export --project=<focused.recordly> --output=<focused-preview.mp4> --contract=<focused-contract> --phase=focused
   node .\scripts\validate-final-video.mjs --input=<focused-preview.mp4> --project=<focused.recordly> --contract=<focused-contract> --gate=focused --visual-review=passed
   node .\scripts\recordly-control.mjs export --project=<full.recordly> --output=<final.mp4> --contract=<full-contract> --phase=full --focused-contract=<focused-contract> --run-json=<run>\run.json
   ```

   `--visual-review=passed` 只能在实际查看 Focused Preview 后使用。Export 已完成自动媒体验证；登记视觉结果时，只核对同一 MP4、工程、编译合同及验证条件，复用原结果，不再次完整解码。任何绑定变化或缺少复用证据时，先不带 `--visual-review` 重新验证，再查看并登记。每份新导出的 MP4 仍须完整验证，Full Export 已自动执行最终检查，无需额外重复调用。导出在临时副本上运行，源 `.recordly` 的 SHA 必须保持不变。

   正式发布读取编译合同绑定的 `run.json`。业务结果须已确认，必需步骤须有证据。重点预览与全片使用相同 run、教学计划和原片，并对照已审场景的配音、操作和光标。

## 可复用标准

- 架构：只用 Recordly 内置 SAP `BrowserWindow`、唯一 `webContents` 和 Browser-originated DOM telemetry；不使用外部 Chrome、Playwright、桌面录屏、OS Mouse 或登录片段。
- 内容：保留真实成功路径和业务顺序；删除探索、失败尝试、重复导航，压缩无教学价值的等待。开头一句说明课程目标；阶段提示（stagePrompt）已废弃，画面上不得叠加任何阶段提示卡片，teaching-plan.json 中禁止生成 stagePrompt。
- Narration：中文专业培训口吻，简洁且以操作为主；一个句子一个知识点。普通 Search/Go/Tab 只需短提示，必要链路动作必须讲清。PPT 没有提供的业务解释不得自行补写。
- TTS：CosyVoice 是唯一 Provider；所有句子使用成对的 `zero_shot_prompt_Mix.wav/.txt`。中文和中英混合默认 `0.95`，完整英文 `1.0`；Caption 与实际送入 CosyVoice 的 Narration 同源。
- 时间：全片 `1.0×`；非教学等待加速上限 `2.5×`；稳定画面 Freeze 上限 `2000 ms`；无教学静止展示上限 `700 ms`。这些固定值由 `scripts/build-recordly-project.mjs` 维护。
- Zoom：默认全屏；仅在 1080p 下知识点确实看不清时使用 `1.5×`，进入/退出各 `550 ms`。普通点击、Loading、Spinner 不 Zoom；同一 Control 连续操作只保留一次；知识点切换和片尾回到全屏。
- Highlight：不自动添加蓝色教学框。只有 DOM 几何可靠且确实提升教学时才可添加；满意基线没有蓝框。Recordly 的 `annotationRegions` 还承载封面等必要图片，但阶段提示卡片已彻底移除。
- Cursor：只取 Browser telemetry；默认尺寸 `1.25`，平滑移动、无 sway、无 motion blur，点击使用轻量 ripple/bounce。真实输入直接来自 Raw Master，不生成模拟输入卡。
- Caption：新视频全片固定靠近底边，不生成 `captionPlacement: "top"`；小字号、低遮挡、最多两行，Cue 在 `ffprobe` 实测 WAV 结束时结束，不用 Whisper 改写。历史 STO 成片的顶部字幕仅为历史特例，保留其原文件和工程。
- 封面：优先复用 PPT 第一页视觉；保留课程标题和稳定品牌，移除日期、项目名等非教学信息。
- 发布：Focused Preview 实看通过后，最终视频必须为 H.264/AAC、1920×1080、CFR 30 fps、source quality，并通过 `ffprobe`、完整 FFmpeg decode、A/V timing 和 Timeline Gate。

## 仅属于本次演示

Supplier Profile 默认讲实际点击、滚动和右箭头切换；业务含义只在 PPT 明确给出时进入 Narration。

以下内容只属于 Display Supplier List 基线，不能作为新视频默认输入：Application 名、Purchasing Organization `2430`、Supplier `1024`、391 条结果、20 句具体 Narration、Scene 源时间、DOM 坐标/尺寸、封面成图和 Focused Scene 列表。它们的权威位置是本次 run 的 `teaching-plan.json`、capture sidecar 和 v4 contract。

## 历史清理记录

以下是已经完成的清理与验证记录，不是每次生产要重跑的清单。

| 证据 | 动作 | 验证 |
| --- | --- | --- |
| 三个生产 CLI 均优先解析 `recordly/node_modules/electron`；旧 installer 无独立调用 | 删除旧 `recordly-installer`，取消其 ignore | Electron `v43.1.0`、SAP capture status、页面 fixture、实际 export |
| npm/package-lock 是唯一安装链；旧 pnpm lock 和单文件 TTS CLI 无调用 | 删除 `pnpm-lock.yaml`、`test_cosyvoice_tts.py` | pipeline fixture、TTS cache-hit、生产 batch adapter |
| v2/v3/无版本工程、失败登录残片、孤立 sidecar 和旧 WAV 不被 v4 contract/manifest 引用 | 删除这些派生物 | 逐一校验 20 个保留 WAV 哈希；保留 Raw Master 和满意 MP4 |
| Export 曾让 Recordly Autosave 改写源工程 | Export 改为临时项目副本 | 同一工程连续导出两次，源 SHA 不变、无 `.bak`、视频哈希一致 |

冗余按用户确认的标准判断：删除后不影响正式生产和视频效果即可清理。已结束 run 中未采用的历史片段（包括失败 `.part`）、历史登录测试、校验副本、分析截图和上游演示资料不作为生产输入保留。进行中或待恢复 run 的失败制品仍按恢复规则保留；正式 Raw Master、采用的 segment、精确基线工程、Teaching Plan、配音、最终视频和运行依赖必须保留。

后续精简以成片等价验收：画面、画质、配音、字幕、节奏和同步保持一致，不额外要求重新导出的文件逐字节相同。历史成品原文件不改；媒体哈希仍用于确认视觉复核的是同一个已验证文件，不能以效果相同为由复用另一文件的验证。

## 尚未闭合的证据边界

- 原满意版预导出的 `run.json` 字节只留下 SHA，最终验证曾原位更新该文件；这不影响 Raw Master、Teaching Plan、WAV 或精确 Recordly 工程的复现。
- 完整英文 `1.0` 已由代码和 plan 验证，但满意片没有纯英文 Scene。
- 外部 PPTX 和手录参考片由本地路径及 SHA 保护，没有复制进 Git。
- 当前仓库没有 remote；Git tag/LFS 恢复能力只覆盖本地仓库及其所在本机环境。
