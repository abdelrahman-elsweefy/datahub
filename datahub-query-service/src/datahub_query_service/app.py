import asyncio
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, cast
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, Query, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from datahub_query_service.auth import AuthenticatedUser, authenticate
from datahub_query_service.config import ServiceConfig, SharedCredentialProvider
from datahub_query_service.connections import ConnectionRegistry
from datahub_query_service.errors import QueryError
from datahub_query_service.execution import QueryAdapter
from datahub_query_service.models import ConnectionList, QueryRequest, QueryResult
from datahub_query_service.postgres import PostgresAdapter
from datahub_query_service.validation import validate_query


@dataclass
class Runtime:
    config: ServiceConfig
    adapter: QueryAdapter
    registry: ConnectionRegistry
    semaphore: asyncio.Semaphore


def runtime_for(request: Request) -> Runtime:
    return cast(Runtime, request.app.state.runtime)


async def current_user(request: Request) -> AuthenticatedUser:
    return await authenticate(
        request, runtime_for(request).config.proxy_secret.get_secret_value()
    )


def create_app(
    config: ServiceConfig | None = None,
    adapter: QueryAdapter | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        settings = config or ServiceConfig.load()
        executor = adapter or PostgresAdapter(settings, SharedCredentialProvider())
        client = http_client or httpx.AsyncClient(timeout=5)
        audit = logging.getLogger("datahub.query.audit")
        audit.setLevel(logging.INFO)
        if not audit.handlers:
            audit.addHandler(logging.StreamHandler())
        audit.propagate = False
        app.state.runtime = Runtime(
            config=settings,
            adapter=executor,
            registry=ConnectionRegistry(settings, client),
            semaphore=asyncio.Semaphore(settings.max_concurrent_queries),
        )
        try:
            yield
        finally:
            await executor.close()
            if http_client is None:
                await client.aclose()

    app = FastAPI(
        title="DataHub Query Service",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.middleware("http")
    async def limit_requests(
        request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if request.method == "POST":
            try:
                length = int(request.headers.get("content-length", "-1"))
            except ValueError:
                length = -1
            if length < 0 or length > 70000:
                return JSONResponse(
                    status_code=413,
                    content={
                        "code": "REQUEST_TOO_LARGE",
                        "message": "The query request exceeds the request limit.",
                    },
                )
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(QueryError)
    async def handle_query_error(request: Request, error: QueryError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status,
            content={"code": error.code, "message": error.message},
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/ready")
    async def ready(request: Request) -> JSONResponse:
        connections = runtime_for(request).config.connections
        usable = bool(connections) and all(
            item.password_file.is_file() for item in connections
        )
        return JSONResponse(
            status_code=200 if usable else 503,
            content={"status": "ready" if usable else "unconfigured"},
        )

    @app.get("/v1/connections", response_model=ConnectionList)
    async def connections(
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
        dataset_urn: Annotated[
            str | None, Query(alias="datasetUrn", max_length=4096)
        ] = None,
    ) -> ConnectionList:
        return await runtime_for(request).registry.list_for(user, dataset_urn)

    @app.post("/v1/query", response_model=QueryResult)
    async def query(
        body: QueryRequest,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
    ) -> QueryResult:
        runtime = runtime_for(request)
        query_id = str(uuid4())
        started = time.monotonic()
        outcome = "failed"
        row_count = 0
        try:
            connection = runtime.config.connection_for(
                body.connection_id, user.actor_urn
            )
            statement = validate_query(body.sql)
            if runtime.semaphore.locked():
                raise QueryError(
                    429,
                    "QUERY_CAPACITY_REACHED",
                    "The query service is busy. Try again shortly.",
                )
            async with runtime.semaphore:
                result = await runtime.adapter.execute(connection, statement, query_id)
            outcome = "succeeded"
            row_count = result.row_count
            return result
        finally:
            logging.getLogger("datahub.query.audit").info(
                "query_id=%s actor=%s connection=%s outcome=%s duration_ms=%s rows=%s",
                query_id,
                user.actor_urn,
                body.connection_id,
                outcome,
                int((time.monotonic() - started) * 1000),
                row_count,
            )

    return app
