"""
storage.py - временное хранилище файлов задач + авто-очистка по TTL.

WAV-файлы тяжёлые (~в 10 раз больше mp3 того же трека), поэтому их нельзя
хранить бесконечно - см. project_summary.md, раздел про архитектуру.
Здесь простой поток-таймер каждые CLEANUP_INTERVAL_SECONDS удаляет файлы
старше TTL_HOURS. Для продакшена лучше вынести в S3-совместимое хранилище
с собственным TTL/lifecycle-правилом, но для прототипа локальной папки
достаточно.
"""
import os
import time

STORAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage")
os.makedirs(STORAGE_DIR, exist_ok=True)

TTL_HOURS = 3
CLEANUP_INTERVAL_SECONDS = 15 * 60


def cleanup_once() -> int:
    """Удаляет файлы старше TTL_HOURS. Возвращает число удалённых файлов."""
    cutoff = time.time() - TTL_HOURS * 3600
    removed = 0
    for name in os.listdir(STORAGE_DIR):
        path = os.path.join(STORAGE_DIR, name)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.remove(path)
                removed += 1
        except OSError:
            pass
    return removed


def cleanup_loop() -> None:
    """Бесконечный цикл для фонового потока: чистит хранилище раз в TTL-интервал."""
    while True:
        cleanup_once()
        time.sleep(CLEANUP_INTERVAL_SECONDS)
