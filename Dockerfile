# Берем за основу официальный образ Python
FROM python:3.11-slim

# Устанавливаем ffmpeg через системный менеджер пакетов
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Устанавливаем yt-dlp
RUN pip install --upgrade yt-dlp

# Копируем код вашего приложения (если нужно)
WORKDIR /app
COPY . /app

# Команда для запуска (пример)
CMD ["python", "your_app.py"]
