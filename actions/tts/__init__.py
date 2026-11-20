"""Stable TTS actions exposed to the training-video workflow."""

from .cosyvoice_action import tts_generate, tts_plan

__all__ = ["tts_generate", "tts_plan"]
