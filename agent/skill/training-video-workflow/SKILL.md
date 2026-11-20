---
name: training-video-workflow
description: Turn one SAP procedure PPTX into one complete narrated training MP4 through the project’s design-confirmed Recordly Browser Capture, Fiori operator, teaching-edit, CosyVoice, and release-gate workflow. Use when the user asks to generate an SAP training video from one PPTX.
---

# Training Video Workflow

Coordinate one retained plan, one logical DEV/QAS SAP execution, one Raw Master, and one complete training MP4. Follow [AGENTS.md](../../../AGENTS.md) for boundaries and [PRODUCTION_STANDARD.md](../../../PRODUCTION_STANDARD.md) for commands and current production standards. Fixed parameters belong to production code.

## Runtime preflight

`DESIGN_CONFIRMED=true` and `FUNCTION_COMPLETE=true`: the Recordly-only vertical slice has passed real SAP acceptance. Reuse that evidence when the relevant implementation, dependencies, and runtime environment are unchanged; do not repeat capability discovery, installation, fixture runs, or the first-production acceptance gate for every video.

For a new capture, check only the current run's prerequisites: the supplied PPTX and output location, verified DEV/QAS, the canonical Recordly control entry, and the authenticated SAP BrowserWindow at stable Fiori Home. After Start, require `recording` and the current WebContents/session binding before business actions. A runtime failure blocks the affected stage; never substitute a legacy entry or another capture path.

When capture, control, telemetry, compilation, TTS, export, or their dependencies/environment change, validate the affected capability before using it. Do not repeat unrelated stages. An output-only repair starts from retained run inputs without opening SAP or starting capture. Every new preview/full MP4 still requires its own media validation and the applicable visual review.

Read references only when entering their phase:

- teaching decisions and narration: [video-strategy.md](references/video-strategy.md);
- visual emphasis: [visual-director.md](references/visual-director.md);
- coordinates, timing, and preview checks: [geometry-and-preview.md](references/geometry-and-preview.md);
- capture artifacts, recovery, project contracts, and publication: [recordly-contract.md](references/recordly-contract.md).

## 1. Parse and prepare

Use `fiori-pptx-operator` in the same Agent. Read the PPTX once, persist its executable steps in the run, and prepare the Recordly SAP BrowserWindow. The video request authorizes its stated DEV/QAS actions under that Skill.

Complete login before capture and confirm stable Fiori Home. For login anomalies, MFA, CAPTCHA, security challenges, or required human judgment, follow the controlled handoff in AGENTS: `AWAITING_USER_INTERVENTION`, suspend automation, stop an active segment, and resume only after the user finishes and the actual page is reread. Login and recovery footage never enter training media.

## 2. Capture and preserve

Use `recordly-sap-capture.mjs start`, wait for `recording`, execute the retained SAP plan through `recordly-sap-control.mjs`, then `stop` on success, blocker, or error and wait for completion. Enter Applications through upper-right Search. The isolated Browser DOM collector owns the current-session Raw Action Timeline; the Agent does not report individual actions or write an action log.

Preserve the Raw Master, Cursor, action log, diagnostics, and authoritative `run.json` under the artifact contract. A normal run has one segment; controlled recovery appends segments to the same logical run and preserves `safeRecoveryPoint`. Never repeat successful business actions. Inspect an ambiguous mutation result without changing SAP before selecting a recovery point.

## 3. Teaching plan and Rough Cut

Review the complete Raw Master and actual outcome, then apply video-strategy: define Business Goal, Learner Outcome, 3–5 Knowledge Points, and A/B/C treatment. Preserve business order and real outcomes while removing exploration, loading, failures, and redundant navigation.

Keep the final successful input/selection and its accepted visible state for every required field. A later dropdown-arrow click cannot replace the actual selection. When a real input is too fast to locate, use the captured stable pre-action frame for a short `preActionHoldMs`, keeping the real action at `1.0x`; never synthesize typing. Teach adjacent fields in separate Scenes, with Narration and Cursor addressing only the current field.

Use the run's action summary to locate the source evidence in the Raw Master and original event log. Compile Rough Cut before writing Narration, or reuse the existing Rough Cut when the capture and rough edit are unchanged. Each Scene serves one complete teaching objective and a visible result. Follow the command sequence in the production standard. `stagePrompt` is deprecated.

## 4. Narration, CosyVoice, and Final Cut

Write concise professional Chinese narration against Rough Cut, following video-strategy. Preserve official interface names, explain only necessary business meaning supported by the PPT, and start result narration only after the real result appears. B-class actions may remain silent.

Narration Script is the sole text source for CosyVoice and Caption. Reuse `actions/tts/cosyvoice_action.py` and the paired `zero_shot_prompt_Mix` reference; use AGENTS/production-code language and speed rules. Pronunciation preprocessing affects internal TTS text only. The existing cache signature covers reference content/text, final TTS text, language, speed, pronunciation mapping, and synthesis parameters.

Generate one WAV per narrated Scene, measure it with `ffprobe`, and hardlink/copy cached audio into the run. The manifest records cache key, reference evidence, SHA256, and measured duration. Final Cut checks the real WAV and its hash; it does not trust a hand-entered duration. Use `audioRegions` and unchanged Narration in `autoCaptions`; the first cut uses one cue per Scene ending at the actual audio end. New-video captions remain at the bottom. Do not use Whisper to rewrite them.

Apply visual-director and geometry-and-preview for shared DOM targets, selective Zoom/Highlight, source-to-timeline mapping, and the strict `captured-visible-result` exception. Default to the full SAP page; clear old targets at navigation. Keep existing production limits on waits, Freeze, and playback rate. User-requested slower dense-field narration remains a per-run choice under video-strategy, never a new global default.

## 5. Preview and publication

Choose the Scene IDs that must be viewed together to check this change. Render and watch the shortest continuous range covering them. Include the preceding interaction or following visible result when it is part of the risk. Extend through the final result when recovery, consecutive inputs or a timing change affect it. Use the source capture for output-only repairs.

The export command performs automated media validation. After actually viewing the same preview, record `--visual-review=passed` with the production-standard command. It reuses the prior media result only while the MP4, project, compiled contract, validation options, and validator are unchanged. Changed inputs or old evidence require automated validation again before review. Full export always validates the delivered MP4.

After the preview passes, export one complete H.264/AAC, 1920×1080, CFR 30 fps, source-quality MP4. The export command runs final `ffprobe`, full decode, A/V and timeline checks, and writes SHA256/settings evidence; do not run those same checks again manually for unchanged output. The first-production real-SAP gate remains the acceptance baseline; rerun its affected checks only when relevant capability changes invalidate it.

## Recovery and completion

Follow recordly-contract for failures and `manual-help`. Preserve source artifacts and rerun only the failed stage; a required uncompleted PPTX action blocks delivery. Capture completion is not workflow completion. Finish only with the complete validated MP4 or a required blocker, and report SAP completion, video completion, any human blocker, and the final MP4 path.
