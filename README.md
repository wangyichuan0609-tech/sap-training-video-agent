# SAP Training Video Agent

Turn an SAP training PPTX into a narrated, captioned training video. An AI coding agent
(Codex, Claude Code, ...) reads the procedure from the PPTX, performs it once in SAP Fiori
inside a screen recorder, and deterministic scripts build the final MP4.

根据 SAP 培训 PPTX，由 Agent 在 SAP Fiori 中执行一次真实操作并录屏，再自动生成带字幕和配音的培训视频。

```text
Training PPTX
→ Agent extracts one real SAP procedure (skill: fiori-pptx-operator)
→ Recorder opens a built-in SAP browser window and captures the run (DEV/QAS only)
→ Agent reviews the raw capture and writes a teaching plan and narration
→ CosyVoice generates the voice-over
→ Scripts compile the project (captions, highlights, cursor, zoom) and export the MP4
→ Validation of the final video
```

## Repository layout

| Path | Content |
|---|---|
| `AGENTS.md` | Project rules and workflow for the agent (Chinese) |
| `PRODUCTION_STANDARD.md` | Production entry points and commands (Chinese) |
| `MEMORY.md`, `CONTEXT.md` | Long-term decisions and glossary |
| `agent/skill/` | Two agent skills: `fiori-pptx-operator`, `training-video-workflow` |
| `scripts/` | Capture, control, TTS, project build, cover and validation scripts (Node.js) |
| `actions/tts/` | CosyVoice adapter (Python) |
| `recordly/` | Modified fork of [Recordly](https://github.com/webadderallorg/Recordly) with a built-in SAP browser capture/control bridge |
| `baselines/` | Manifest of an accepted reference video (the media itself is not published) |
| `fixtures/` | Offline browser-capture fixture |

## What is not in this repository

- **Recordings, audio and screenshots** of real SAP systems (`artifacts/`), and the source PPTX files.
- **Credentials.** Put your own connection details in a local `SAP Login Info.txt` (git-ignored); see `agent/skill/fiori-pptx-operator/SKILL.md` for the format.
- **The certificate pin.** `recordly/electron/certificatePolicy.ts` contains a placeholder hostname and an all-zero SHA-256. Replace both with your own SAP QAS host and certificate.
- **CosyVoice.** Clone [FunAudioLLM/CosyVoice](https://github.com/FunAudioLLM/CosyVoice) into `CosyVoice-main/`, download its pretrained models, and create the `.venv-cosyvoice` virtual environment (`cosyvoice-build-constraints.txt` pins the build dependency).
- **Build output.** Run `npm install` and the build in `recordly/` to produce `dist/` and `dist-electron/`.

Documents mention a baseline tag and run folders that only exist in the original private workspace.

## Requirements

Windows, Node.js, Python 3 (for CosyVoice), ffmpeg/ffprobe, and access to an SAP S/4HANA
DEV or QAS system with Fiori Launchpad. The workflow refuses production systems by design.

## Tests

```powershell
node --test "scripts/tests/*.test.mjs"
```

Two TTS tests need the CosyVoice checkout and a reference voice sample at
`CosyVoice-main/asset/zero_shot_prompt_Mix.wav` (provide your own); the others run offline.

## License

- Everything outside `recordly/` is released under the [MIT License](LICENSE).
- `recordly/` is a modified fork of Recordly by webadderall and stays under the
  **GNU AGPL v3**; see [`recordly/LICENSE.md`](recordly/LICENSE.md). The Recordly name and
  branding belong to the Recordly project. This repository is not affiliated with or endorsed by it.
- SAP and SAP Fiori are trademarks of SAP SE. This project is not affiliated with SAP.
