FROM python:3.11-slim
WORKDIR /app
COPY distiller/requirements.txt ./requirements.txt
# hy-memory rides a git+https pin — slim has no git
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && pip install --no-cache-dir -r requirements.txt \
    && apt-get purge -y git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY distiller/app.py distiller/engine.py ./
ENV DISTILLER_PORT=8100
EXPOSE 8100
USER 65534
CMD ["python", "app.py"]
