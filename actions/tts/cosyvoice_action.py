"""Project-owned, language-routed CosyVoice zero-shot adapter."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any


_WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
_COSYVOICE_ROOT = _WORKSPACE_ROOT / "CosyVoice-main"
_MODEL_DIR = _COSYVOICE_ROOT / "pretrained_models" / "Fun-CosyVoice3-0.5B"
_MATCHA_ROOT = _COSYVOICE_ROOT / "third_party" / "Matcha-TTS"
_REFERENCE_STEMS = {
    "zh": _COSYVOICE_ROOT / "asset" / "zero_shot_prompt_Mix",
    "mix": _COSYVOICE_ROOT / "asset" / "zero_shot_prompt_Mix",
    "en": _COSYVOICE_ROOT / "asset" / "zero_shot_prompt_Mix",
}
_SYSTEM_PROMPT = "You are a helpful assistant.<|endofprompt|>"
_DEFAULT_SPEED = 0.95
_DEFAULT_ENGLISH_SPEED = 1.0
_INTER_SENTENCE_SILENCE_SECONDS = 0.36
_TARGET_RMS = 0.08
_PRONUNCIATION_VERSION = 2
_LETTER_PRONUNCIATIONS = {
    "SAP": "S A P",
    "PO": "P O",
    "PR": "P R",
    "SES": "S E S",
    "GR": "G R",
    "IR": "I R",
}
_WORD_PRONUNCIATIONS = {
	"DISPLAY": "[D][IH0][S][P][L][EY1]",
	"LIST": "[L][IH1][S][T]",
	"SEARCH": "[S][ER1][CH]",
	"ADAPT": "[AH0][D][AE1][P][T]",
	"FILTERS": "[F][IH1][L][T][ER0][Z]",
	"PURCHASING": "[P][ER1][CH][AH0][S][IH0][NG]",
	"ORGANIZATION": "[AO2][R][G][AH0][N][AH0][Z][EY1][SH][AH0][N]",
	"GO": "[G][OW1]",
	"CONTACT": "[K][AA1][N][T][AE2][K][T]",
    "DETAILS": "[D][IY1][T][EY1][L][Z]",
	"PROFILE": "[P][R][OW1][F][AY2][L]",
	"SECTIONS": "[S][EH1][K][SH][AH0][N][Z]",
	"ARROWS": "[AE1][R][OW0][Z]",
	"SUPPLIER": "[S][AH0][P][L][AY1][ER0]",
}
_LETTER_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    + "|".join(sorted(map(re.escape, _LETTER_PRONUNCIATIONS), key=len, reverse=True))
    + r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_WORD_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    + "|".join(sorted(map(re.escape, _WORD_PRONUNCIATIONS), key=len, reverse=True))
    + r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_SENTENCE_PATTERN = re.compile(r".+?(?:[。！？!?]+|[.!?]+(?=\s|$)|$)", re.DOTALL)
_ABBREVIATION_DOT = "\ue000"

_MODEL: Any | None = None
_MODEL_LOCK = threading.Lock()
_INFERENCE_LOCK = threading.Lock()


def _get_model() -> Any:
    """Load the configured Fun-CosyVoice3 model once, on CPU."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL

    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL

        required_model_files = ("cosyvoice3.yaml", "llm.pt", "flow.pt", "hift.pt")
        missing_model_files = [
            name for name in required_model_files if not (_MODEL_DIR / name).is_file()
        ]
        if missing_model_files:
            raise FileNotFoundError(
                "CosyVoice model is incomplete. Missing: "
                + ", ".join(missing_model_files)
            )
        if not (_MATCHA_ROOT / "matcha" / "__init__.py").is_file():
            raise FileNotFoundError(
                "CosyVoice Matcha-TTS submodule is missing. Expected: "
                f"{_MATCHA_ROOT}"
            )

        for import_root in (_COSYVOICE_ROOT, _MATCHA_ROOT):
            import_path = str(import_root)
            if import_path not in sys.path:
                sys.path.insert(0, import_path)

        from cosyvoice.cli.cosyvoice import AutoModel

        previous_wetext = sys.modules.get("wetext", ...)
        if os.environ.get("COSYVOICE_ENABLE_WETEXT") != "1":
            sys.modules["wetext"] = None
        try:
            model = AutoModel(
                model_dir=str(_MODEL_DIR),
                load_trt=False,
                load_vllm=False,
                fp16=False,
            )
        finally:
            if previous_wetext is ...:
                sys.modules.pop("wetext", None)
            else:
                sys.modules["wetext"] = previous_wetext
        device = getattr(getattr(model, "model", None), "device", None)
        if getattr(device, "type", str(device)) != "cpu":
            raise RuntimeError(f"CosyVoice did not initialize on CPU: {device}")

        _MODEL = model
        return _MODEL


def _required_text(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value.strip()


def _optional_text(value: str | None, name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be None or a non-empty string")
    return value.strip()


def _reference_path(value: str | os.PathLike[str]) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Reference audio not found: {path}")
    return path


def _contains_chinese(text: str) -> bool:
    return any("\u3400" <= character <= "\u9fff" for character in text)


def _contains_english(text: str) -> bool:
    return bool(re.search(r"[A-Za-z]", text))


def _split_sentences(text: str) -> list[str]:
    # Keep compact UI abbreviations such as "Purch. Organization" together.
    # This is structural rather than field-specific: a short Latin token followed
    # by another capitalized token is treated as one visible UI label.
    protected = re.sub(
        r"\b([A-Za-z]{1,8})\.(?=\s+[A-Z][A-Za-z])",
        rf"\1{_ABBREVIATION_DOT}",
        text,
    )
    sentences = [
        match.group(0).replace(_ABBREVIATION_DOT, ".").strip()
        for match in _SENTENCE_PATTERN.finditer(protected)
    ]
    return [sentence for sentence in sentences if sentence]


def _language_for_sentence(text: str) -> str:
    # A Chinese training sentence stays on the Chinese lecturer voice even
    # when it contains visible SAP/UI labels such as Search, Supplier, or Go.
    # Splitting those labels into an English segment creates audible seams and
    # makes short button names receive unnatural emphasis. Only a sentence
    # without any Chinese characters is routed to the English voice/speed.
    return "zh" if _contains_chinese(text) else "en"


def _pronunciation_text(display_text: str) -> str:
    expanded = _LETTER_PATTERN.sub(
        lambda match: _LETTER_PRONUNCIATIONS[match.group(0).upper()],
        display_text,
    )
    return _WORD_PATTERN.sub(
        lambda match: _WORD_PRONUNCIATIONS[match.group(0).upper()],
        expanded,
    )


def _applied_word_pronunciations(display_text: str) -> dict[str, str]:
    matched = {match.group(0).upper() for match in _WORD_PATTERN.finditer(display_text)}
    return {word: _WORD_PRONUNCIATIONS[word] for word in sorted(matched)}


def _default_reference(language: str) -> tuple[Path, str]:
    stem = _REFERENCE_STEMS[language]
    audio = _reference_path(stem.with_suffix(".wav"))
    path = stem.with_suffix(".txt")
    if not path.is_file() or not path.read_text(encoding="utf-8").strip():
        label = {
            "zh": "Chinese",
            "mix": "Chinese-English mixed",
            "en": "English",
        }[language]
        raise FileNotFoundError(
            f"{label} reference transcript is missing. Provide the exact spoken "
            f"text in {path}; it must match {audio}."
        )
    return audio, path.read_text(encoding="utf-8").strip()


@lru_cache(maxsize=8)
def _file_sha256(path_text: str) -> str:
    digest = hashlib.sha256()
    with Path(path_text).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tts_plan(
    text: str,
    reference_audio: str | os.PathLike[str] | None = None,
    reference_text: str | None = None,
    instruction: str | None = None,
    speed: float = _DEFAULT_SPEED,
    english_speed: float = _DEFAULT_ENGLISH_SPEED,
) -> dict[str, Any]:
    """Return the deterministic language/reference/pronunciation/cache plan."""
    display_text = _required_text(text, "text")
    normalized_reference_text = _optional_text(reference_text, "reference_text")
    normalized_instruction = _optional_text(instruction, "instruction")
    if normalized_instruction is not None:
        raise ValueError(
            "Paired zero-shot narration does not accept instruction mode; "
            "use the matched reference audio and transcript instead."
        )
    if reference_audio is not None or normalized_reference_text is not None:
        raise ValueError(
            "Custom reference overrides are disabled. All narration always uses "
            "asset/zero_shot_prompt_Mix.wav + .txt."
        )
    if not isinstance(speed, (int, float)) or speed <= 0:
        raise ValueError("speed must be a positive number")
    if not isinstance(english_speed, (int, float)) or english_speed <= 0:
        raise ValueError("english_speed must be a positive number")

    segments = []
    for sentence in _split_sentences(display_text):
        language = _language_for_sentence(sentence)
        audio_path, prompt_text = _default_reference(language)
        segment = {
            "displayText": sentence,
            "ttsText": _pronunciation_text(sentence),
            "language": language,
            "referenceAudio": str(audio_path),
            "referenceAudioSha256": _file_sha256(str(audio_path)),
            "referenceText": prompt_text,
        }
        if language == "en":
            segment["speed"] = float(english_speed)
        segments.append(segment)

    applied_word_pronunciations = _applied_word_pronunciations(display_text)
    cache_input = {
        "engine": "cosyvoice-zero-shot-routed-v3-slow-zh-led",
        "displayText": display_text,
        "segments": segments,
        "pronunciationVersion": _PRONUNCIATION_VERSION
        + int(bool(applied_word_pronunciations)),
        "pronunciations": {
            **_LETTER_PRONUNCIATIONS,
            **applied_word_pronunciations,
        },
        "speed": float(speed),
        "instruction": normalized_instruction,
        "interSentenceSilenceSeconds": _INTER_SENTENCE_SILENCE_SECONDS,
        "targetRms": _TARGET_RMS,
    }
    if any(segment["language"] == "en" for segment in segments):
        cache_input["englishSpeed"] = float(english_speed)
    cache_key = hashlib.sha256(
        json.dumps(cache_input, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return {
        **cache_input,
        "finalTtsText": " ".join(segment["ttsText"] for segment in segments),
        "cacheKey": cache_key,
    }


def _normalize_rms(waveform: Any) -> Any:
    import torch

    rms = torch.sqrt(torch.mean(waveform.float() ** 2)).item()
    if rms <= 1e-8:
        return waveform
    gain = max(0.5, min(2.0, _TARGET_RMS / rms))
    peak = waveform.abs().max().item()
    if peak * gain > 0.98:
        gain = 0.98 / peak
    return waveform * gain


def _save_wav_atomically(waveform: Any, sample_rate: int, output_path: Path) -> None:
    import torchaudio

    output_path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.stem}.",
        suffix=".wav",
        dir=str(output_path.parent),
    )
    os.close(file_descriptor)
    temporary_path = Path(temporary_name)
    try:
        torchaudio.save(
            str(temporary_path),
            waveform,
            sample_rate,
            encoding="PCM_S",
            bits_per_sample=16,
        )
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def tts_generate(
    text: str,
    output_path: str | os.PathLike[str],
    reference_audio: str | os.PathLike[str] | None = None,
    reference_text: str | None = None,
    instruction: str | None = None,
    speed: float = _DEFAULT_SPEED,
    english_speed: float = _DEFAULT_ENGLISH_SPEED,
) -> Path:
    """Generate paired zero-shot speech and return the resulting WAV path."""
    plan = tts_plan(
        text,
        reference_audio=reference_audio,
        reference_text=reference_text,
        instruction=instruction,
        speed=speed,
        english_speed=english_speed,
    )
    destination = Path(output_path).expanduser().resolve()
    if destination.suffix.lower() != ".wav":
        raise ValueError(f"output_path must end in .wav: {destination}")

    model = _get_model()
    import torch

    sentence_waveforms = []
    with _INFERENCE_LOCK:
        for segment in plan["segments"]:
            outputs = model.inference_zero_shot(
                segment["ttsText"],
                f"{_SYSTEM_PROMPT}{segment['referenceText']}",
                segment["referenceAudio"],
                stream=False,
                speed=segment.get("speed", speed),
            )
            chunks = [item["tts_speech"].detach().cpu() for item in outputs]
            if not chunks:
                raise RuntimeError("CosyVoice returned no audio chunks")
            sentence_waveforms.append(_normalize_rms(torch.cat(chunks, dim=1)))

    silence = torch.zeros(
        (1, round(int(model.sample_rate) * _INTER_SENTENCE_SILENCE_SECONDS)),
        dtype=sentence_waveforms[0].dtype,
    )
    joined = []
    for index, waveform in enumerate(sentence_waveforms):
        if index:
            joined.append(silence)
        joined.append(waveform)
    _save_wav_atomically(torch.cat(joined, dim=1), int(model.sample_rate), destination)
    return destination
