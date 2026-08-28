"""
jobs.py - простое in-memory хранилище задач для прототипа.

В проде очередь задач должна быть настоящей (Celery/RQ + Redis - см.
project_summary.md, раздел про архитектуру), с воркерами, которые можно
масштабировать горизонтально, потому что DSP-обработка CPU-bound. Здесь,
для демонстрации потока и локального запуска, достаточно словаря в
памяти процесса + FastAPI BackgroundTasks.
"""
import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional


class JobStatus(str, Enum):
    QUEUED = "queued"
    FETCHING_INFO = "fetching_info"
    DOWNLOADING = "downloading"
    ANALYZING = "analyzing"
    IRON = "iron"
    ENHANCER = "enhancer"
    MULTIBAND = "multiband"
    LIMITER = "limiter"
    FINALIZING = "finalizing"
    DONE = "done"
    ERROR = "error"


# Порядковый индекс стадии в "channel strip" на фронте (0 = ещё не дошли,
# 1..4 = реальные стадии DSP-цепочки: Iron / Enhancer / Multiband / Limiter).
STAGE_INDEX = {
    JobStatus.QUEUED: 0,
    JobStatus.FETCHING_INFO: 0,
    JobStatus.DOWNLOADING: 0,
    JobStatus.ANALYZING: 0,
    JobStatus.IRON: 1,
    JobStatus.ENHANCER: 2,
    JobStatus.MULTIBAND: 3,
    JobStatus.LIMITER: 4,
    JobStatus.FINALIZING: 4,
    JobStatus.DONE: 4,
    JobStatus.ERROR: 0,
}

STATUS_LABELS = {
    JobStatus.QUEUED: "В очереди",
    JobStatus.FETCHING_INFO: "Проверяем видео",
    JobStatus.DOWNLOADING: "Извлекаем аудиодорожку",
    JobStatus.ANALYZING: "Анализируем сигнал",
    JobStatus.IRON: "True Iron - сатурация",
    JobStatus.ENHANCER: "bx_enhancer - EQ и компрессия",
    JobStatus.MULTIBAND: "Мультибэнд-компрессия",
    JobStatus.LIMITER: "Финальный лимитер",
    JobStatus.FINALIZING: "Нормализация громкости",
    JobStatus.DONE: "Готово",
    JobStatus.ERROR: "Ошибка",
}


@dataclass
class Job:
    id: str
    youtube_url: str
    status: JobStatus = JobStatus.QUEUED
    title: Optional[str] = None
    error: Optional[str] = None
    output_path: Optional[str] = None
    final_lufs: Optional[float] = None
    final_true_peak_db: Optional[float] = None
    device_id: Optional[str] = None
    max_duration_seconds: int = 600
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status.value,
            "status_label": STATUS_LABELS[self.status],
            "stage_index": STAGE_INDEX[self.status],
            "title": self.title,
            "error": self.error,
            "final_lufs": round(self.final_lufs, 1) if self.final_lufs is not None else None,
            "final_true_peak_db": round(self.final_true_peak_db, 2) if self.final_true_peak_db is not None else None,
            "ready": self.status == JobStatus.DONE,
        }


class JobStore:
    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self, youtube_url: str, device_id: Optional[str] = None,
               max_duration_seconds: int = 600) -> Job:
        job = Job(id=str(uuid.uuid4()), youtube_url=youtube_url,
                  device_id=device_id, max_duration_seconds=max_duration_seconds)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def all(self) -> List[Job]:
        with self._lock:
            return list(self._jobs.values())
