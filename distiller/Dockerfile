FROM python:3.11-slim
WORKDIR /app
COPY distiller/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY distiller/app.py distiller/engine.py ./
ENV DISTILLER_PORT=8100
EXPOSE 8100
USER 65534
CMD ["python", "app.py"]
