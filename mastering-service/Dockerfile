# Деплой на Render: Render's родной Python-buildpack не даёт apt-доступа,
# а yt-dlp жёстко требует ffmpeg в системе (см. backend/extraction.py) -
# поэтому деплоим как Docker-сервис, а не как "Python service" из коробки.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY frontend/ frontend/

WORKDIR /app/backend

# Render передаёт порт через переменную окружения PORT - слушаем именно её,
# а не хардкодим 8000.
ENV PORT=8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
