"""
main.py - бэкенд прототипа онлайн-мастеринг сервиса "111C".

Поток:
  POST /api/jobs                   -> принимает ссылку на YouTube, создаёт задачу
  GET  /api/jobs/{job_id}          -> статус/прогресс задачи (для поллинга с фронта)
  GET  /api/jobs/{job_id}/download -> отдаёт готовый WAV (16 бит / 44100 Гц)

Обработка асинхронная (см. project_summary.md - "асинхронность обязательна"):
задача ставится в фон через BackgroundTasks, фронт поллит статус, а не ждёт
синхронного ответа. Для прототипа это словарь в памяти вместо настоящей
очереди задач (Celery/RQ + Redis) - см. README.md, что нужно поменять для продакшена.
"""
import os
import threading

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import extraction
import mastering_chain
import soundfile as sf
import pyloudnorm as pyln
import subscriptions

from jobs import Job, JobStatus, JobStore
from storage import STORAGE_DIR, cleanup_loop

app = FastAPI(title="111C Mastering Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs = JobStore()
entitlements = subscriptions.EntitlementStore()

# Простейшая защита от заливки очереди одним пользователем (см.
# project_summary.md - "Rate limiting - иначе один пользователь завалит
# очередь"). Для продакшена нужен настоящий rate limiter (например, на
# Redis), этого достаточно только для локального прототипа.
MAX_CONCURRENT_JOBS_PER_IP = 2
_active_by_ip: dict = {}
_active_lock = threading.Lock()


def _identify(request: Request) -> str:
    """
    Кто это. Родное iOS-приложение шлёт стабильный X-Device-Id (см.
    ios-app/README.md - генерируется и хранится в Keychain), это основной
    идентификатор для лимитов/подписки. Обычный браузер без обёртки такого
    заголовка не пришлёт - тогда падаем на IP, просто чтобы не сломаться
    (у него по умолчанию бесплатный тариф без возможности оформить Pro).
    """
    device_id = request.headers.get("X-Device-Id")
    if device_id:
        return device_id
    return f"ip:{request.client.host}" if request.client else "unknown"


class CreateJobRequest(BaseModel):
    youtube_url: str = Field(..., min_length=1, max_length=2000)


class VerifyTransactionRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    signed_transaction_info: str = Field(..., min_length=1)


@app.on_event("startup")
def _start_background_threads() -> None:
    threading.Thread(target=cleanup_loop, daemon=True).start()


def _run_job(job_id: str) -> None:
    job = jobs.get(job_id)
    if job is None:
        return

    client_ip = getattr(job, "_client_ip", "unknown")
    source_wav = None
    try:
        job.status = JobStatus.FETCHING_INFO
        info = extraction.get_video_info(job.youtube_url, max_duration_seconds=job.max_duration_seconds)
        job.title = info["title"]

        job.status = JobStatus.DOWNLOADING
        source_wav = extraction.download_audio(job.youtube_url, job.id)

        output_path = os.path.join(STORAGE_DIR, f"{job.id}_master.wav")

        stage_to_status = {
            "clean": JobStatus.ANALYZING,
            "analyze": JobStatus.ANALYZING,
            "iron": JobStatus.IRON,
            "enhancer": JobStatus.ENHANCER,
            "multiband": JobStatus.MULTIBAND,
            "limiter": JobStatus.LIMITER,
            "finalize": JobStatus.FINALIZING,
        }

        def on_stage(stage_name: str) -> None:
            job.status = stage_to_status.get(stage_name, job.status)

        mastering_chain.process_audio(
            input_path=source_wav,
            output_path=output_path,
            verbose=False,
            on_stage=on_stage,
        )

        audio, sr = sf.read(output_path)
        job.final_lufs = pyln.Meter(sr).integrated_loudness(audio)
        job.final_true_peak_db = mastering_chain.estimate_true_peak_db(audio)

        job.output_path = output_path
        job.status = JobStatus.DONE

    except extraction.ExtractionError as exc:
        job.status = JobStatus.ERROR
        job.error = str(exc)
    except Exception:
        job.status = JobStatus.ERROR
        job.error = "Внутренняя ошибка обработки. Попробуйте другое видео."
    finally:
        if source_wav and os.path.exists(source_wav):
            try:
                os.remove(source_wav)
            except OSError:
                pass
        with _active_lock:
            _active_by_ip[client_ip] = max(0, _active_by_ip.get(client_ip, 1) - 1)


@app.post("/api/jobs")
def create_job(payload: CreateJobRequest, background_tasks: BackgroundTasks, request: Request):
    url = payload.youtube_url.strip()
    if "youtube.com" not in url and "youtu.be" not in url:
        raise HTTPException(status_code=400, detail="Похоже, это не ссылка на YouTube")

    device_id = _identify(request)
    limits = entitlements.limits_for(device_id)
    if limits["used_today"] >= limits["daily_limit"]:
        detail = (
            f"Дневной лимит бесплатной версии исчерпан ({limits['daily_limit']} трек/день) - оформите Pro"
            if not limits["entitled"]
            else "Дневной лимит на сегодня исчерпан, возвращайтесь завтра"
        )
        raise HTTPException(status_code=402, detail=detail)

    client_ip = request.client.host if request.client else "unknown"
    with _active_lock:
        active = _active_by_ip.get(client_ip, 0)
        if active >= MAX_CONCURRENT_JOBS_PER_IP:
            raise HTTPException(
                status_code=429,
                detail=f"Не больше {MAX_CONCURRENT_JOBS_PER_IP} задач одновременно - дождитесь завершения",
            )
        _active_by_ip[client_ip] = active + 1

    job = jobs.create(url, device_id=device_id, max_duration_seconds=limits["max_duration_seconds"])
    job._client_ip = client_ip  # type: ignore[attr-defined]
    entitlements.record_usage(device_id)
    background_tasks.add_task(_run_job, job.id)
    return job.to_dict()


@app.post("/api/subscription/verify")
def verify_subscription(payload: VerifyTransactionRequest):
    """
    Вызывается из iOS-приложения сразу после успешной покупки в StoreKit 2:
    отправляет Transaction.jwsRepresentation сюда, бэкенд проверяет подпись
    Apple и, если она валидна, активирует Pro для этого device_id.
    """
    try:
        ent = subscriptions.verify_and_apply(entitlements, payload.device_id, payload.signed_transaction_info)
    except subscriptions.TransactionVerificationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        # certs/README.md ещё не выполнен - сервер не настроен, а не что пользователь ошибся.
        raise HTTPException(status_code=500, detail=str(exc))
    return {"entitled": True, "product_id": ent.product_id, "expires_at": ent.expires_at}


@app.get("/api/subscription/status")
def subscription_status(request: Request):
    return entitlements.limits_for(_identify(request))


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    return job.to_dict()


@app.get("/api/jobs/{job_id}/download")
def download_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    if job.status != JobStatus.DONE or not job.output_path or not os.path.exists(job.output_path):
        raise HTTPException(status_code=409, detail="Файл ещё не готов")

    filename = "".join(c for c in (job.title or "master") if c.isalnum() or c in " -_").strip() or "master"
    return FileResponse(
        job.output_path,
        media_type="audio/wav",
        filename=f"{filename}.wav",
    )


# Отдаём статический фронтенд из ../frontend по корневому пути.
_frontend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
if os.path.isdir(_frontend_dir):
    app.mount("/", StaticFiles(directory=_frontend_dir, html=True), name="frontend")
