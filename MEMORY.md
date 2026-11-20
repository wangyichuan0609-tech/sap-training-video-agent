# Project Memory

本文件只保存长期决策、基线和未知项。项目边界见 [AGENTS.md](AGENTS.md)，生产命令见 [PRODUCTION_STANDARD.md](PRODUCTION_STANDARD.md)，术语见 [CONTEXT.md](CONTEXT.md)；执行方法按当前阶段读取两个 Skill 及其 reference，不在这里重复。

## 已确认基线

- `DESIGN_CONFIRMED=true`，`FUNCTION_COMPLETE=true`：Recordly-only 业务视频 Vertical Slice 已于 2026-09-22 通过真实 QAS 生产路径验收。
- 满意成片、精确工程、原始录屏、配音及来源由 [基线清单](baselines/accepted-display-supplier-list-20260926.json) 和 annotated tag `accepted-display-supplier-list-20260926-v1` 固定；清单中的历史视觉选择不覆盖当前生产规则。
- 保留两个 Skill 的职责：`fiori-pptx-operator` 理解 PPTX 并执行一次真实 SAP 操作，`training-video-workflow` 编排流程和后期。它们由同一 Agent 使用，不因名称相似而合并或删除。
- Agent/LLM 负责业务理解、教学重点、A/B/C 分类、Narration 和 Visual Intent；确定性采集、TTS、工程编译、时间映射、导出和验证由现有脚本完成。

## 已验证的取舍

- 坐标统一使用 Browser viewport、source frame 与画布间的变换；采购组织和 Go 必须定位完整控件。不能按 Label、鼠标点或旧截图估框，也不能把示例字段或坐标提升为通用默认值。
- 配音复用现有 CosyVoice adapter 和内容寻址缓存；仅重生成受影响句子。已确认的字母发音及 Supplier 音素映射由 adapter 维护，不另写一份映射，不接受逐词换音色、笑声或异常语气。
- Rough Cut 不要求 Narration/WAV/Caption；Final Cut 必须核对真实 WAV、SHA256 和 `ffprobe` 时长，不能信任手填 duration。现有 fixture 专门验证错误 manifest 时长不会进入工程。
- 2026-10-27：新视频字幕始终在底部，现有 STO 顶部字幕仅为历史特例，保留原成品和工程。精简以成片等价为准，不额外要求重新导出的文件逐字节一致；历史成品原文件不改。
- 已验收能力不在每次生产前重新验收；相关实现、依赖或运行环境改变时只验证受影响部分。新增录制能力仍按 fixture → QAS 只读 → 真实 PPTX 路径验证，不重做已成功的业务操作。

## 未知项与维护

- 没有可靠的历史 LLM 调用次数、各阶段耗时或金额成本记录，不能补造旧基线。
- 基线的来源缺口和外部输入位置以基线清单及生产标准为准，不复制第二份列表。
- 冗余按是否影响生产和成片判断。已结束 run 未采用的历史片段、登录测试、校验副本和可再生成缓存可清理；进行中或待恢复 run 的失败制品、正式输入和精确基线继续保留。
- 只有真实运行验证通过才更新完成状态。设计文档、空目录或脚本存在不代表验收。
- 仅在长期决策、能力或基线变化时更新本文件；不创建重复的 Notes、Summary、Progress 或 History 文档。CONTEXT 仅作词汇表。
