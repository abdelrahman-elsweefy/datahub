FROM python:3.11-slim

WORKDIR /app
COPY datahub-query-service/pyproject.toml ./pyproject.toml
COPY datahub-query-service/src ./src
RUN pip install --no-cache-dir . && useradd --uid 10001 --create-home query-service
COPY datahub-query-service/connections.example.json /etc/datahub-query-service/connections.json
USER query-service
EXPOSE 9004
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:9004/health', timeout=2)"
CMD ["uvicorn", "datahub_query_service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "9004", "--no-access-log", "--log-level", "info"]
