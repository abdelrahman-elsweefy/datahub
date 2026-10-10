FROM python:3.11-slim
WORKDIR /app
COPY datahub-ai-service/pyproject.toml ./pyproject.toml
COPY datahub-ai-service/src ./src
RUN pip install --no-cache-dir . \
    && useradd --create-home --uid 1000 datahub \
    && mkdir -p /var/lib/datahub-ai \
    && chown datahub:datahub /var/lib/datahub-ai
USER datahub
EXPOSE 8091
CMD ["uvicorn", "datahub_ai_service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8091"]
