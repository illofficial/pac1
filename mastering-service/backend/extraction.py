"""
extraction.py - извлечение аудиодорожки из YouTube-видео через yt-dlp.

ВАЖНО (юридический нюанс, см. project_summary.md): скачивание аудио с
YouTube нарушает условия использования площадки, даже если файл дальше
обрабатывается и меняется. Это не блокирует техническую реализацию
прототипа, но перед публичным запуском стоит либо ограничиться
собственным/лицензированным контентом, либо проконсультироваться с юристом.

Требует установленного в системе ffmpeg (yt-dlp использует его как
постпроцессор для конвертации в WAV) - см. README.md.
"""
import os

import yt_dlp

from storage import STORAGE_DIR

MAX_DURATION_SECONDS = 10 * 60


class ExtractionError(Exception):
    """Ошибка получения аудио с YouTube: плохая ссылка, лимит длины,
    гео-блок, приватное/удалённое видео и т.п. Сообщение уже готово
    для показа пользователю как есть."""


def get_video_info(url: str, max_duration_seconds: int = MAX_DURATION_SECONDS) -> dict:
    """Быстрый запрос метаданных без скачивания - в первую очередь чтобы
    проверить лимит длины ДО того, как тратить время на загрузку.
    max_duration_seconds передаётся снаружи, потому что лимит зависит от
    того, есть ли у пользователя активная подписка (см. subscriptions.py)."""
    ydl_opts = {"quiet": True, "skip_download": True, "noplaylist": True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        raise ExtractionError("Не удалось получить информацию о видео - проверьте ссылку") from exc

    duration = info.get("duration") or 0
    if duration > max_duration_seconds:
        raise ExtractionError(
            f"Видео длится {duration // 60} мин {duration % 60} сек - "
            f"лимит {max_duration_seconds // 60} мин на вашем тарифе"
        )
    return {"title": info.get("title") or "audio", "duration": duration}


def download_audio(url: str, job_id: str) -> str:
    """
    Извлекает аудиодорожку и конвертирует в WAV (постпроцессор yt-dlp,
    через ffmpeg). Возвращает путь к исходному WAV-файлу - тому, который
    затем пойдёт в mastering_chain.process_audio.
    """
    output_template = os.path.join(STORAGE_DIR, f"{job_id}_source.%(ext)s")
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": output_template,
        "noplaylist": True,
        "quiet": True,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "wav",
            "preferredquality": "0",
        }],
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except Exception as exc:
        raise ExtractionError("Не удалось извлечь аудио из видео") from exc

    wav_path = os.path.join(STORAGE_DIR, f"{job_id}_source.wav")
    if not os.path.exists(wav_path):
        raise ExtractionError("Аудиодорожка не была извлечена")
    return wav_path
