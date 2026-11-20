"""Production batch entrypoint for the project-owned CosyVoice action."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))


from actions.tts import tts_generate, tts_plan


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        temporary_path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _validate_items(value: Any, mode: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("Batch input must be a JSON array")
    items: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise ValueError(f"Batch item {index + 1} must be an object")
        item_id = raw.get("id")
        text = raw.get("text")
        if not isinstance(item_id, str) or not item_id.strip():
            raise ValueError(f"Batch item {index + 1} has no non-empty id")
        if item_id in seen_ids:
            raise ValueError(f"Duplicate batch id: {item_id}")
        seen_ids.add(item_id)
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Batch item {item_id} has no non-empty text")
        normalized = {"id": item_id, "text": text.strip()}
        speed = raw.get("speed")
        if speed is not None:
            if isinstance(speed, bool) or not isinstance(speed, (int, float)) or speed <= 0:
                raise ValueError(f"Batch item {item_id} has an invalid speed")
            normalized["speed"] = float(speed)
        if mode == "generate":
            output = raw.get("output")
            if not isinstance(output, str) or not output.strip():
                raise ValueError(f"Batch item {item_id} has no output WAV path")
            output_path = Path(output).expanduser().resolve()
            if output_path.suffix.lower() != ".wav":
                raise ValueError(f"Batch output must be WAV: {output_path}")
            normalized["output"] = str(output_path)
        items.append(normalized)
    return items


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Plan or generate one CosyVoice WAV per narration Scene."
    )
    parser.add_argument("--mode", choices=("plan", "generate"), required=True)
    parser.add_argument("--input", required=True, help="Batch JSON input path")
    parser.add_argument("--output", required=True, help="Batch result JSON path")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    items = _validate_items(_read_json(input_path), args.mode)

    results: list[dict[str, Any]] = []
    for item in items:
        speed_options = {"speed": item["speed"]} if "speed" in item else {}
        plan = tts_plan(item["text"], **speed_options)
        result: dict[str, Any] = {"id": item["id"], "plan": plan}
        if args.mode == "generate":
            generated = tts_generate(item["text"], item["output"], **speed_options)
            result["output"] = str(generated)
        results.append(result)
        print(f"{args.mode}: {item['id']}", flush=True)

    _write_json_atomic(output_path, results)


if __name__ == "__main__":
    main()
