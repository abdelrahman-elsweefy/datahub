import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, cast
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from datahub_ai_service.agent import (
    DeepAgentResponder,
    Responder,
    UnconfiguredResponder,
)
from datahub_ai_service.auth import AuthenticatedUser, authenticate
from datahub_ai_service.config import ServiceConfig
from datahub_ai_service.errors import AiError
from datahub_ai_service.metadata import DataHubMetadata, DatasetAccess
from datahub_ai_service.models import (
    AskRequest,
    AskResponse,
    Conversation,
    ConversationDetail,
    ConversationList,
    RenameConversation,
)
from datahub_ai_service.store import ConversationStore


@dataclass
class Runtime:
    config: ServiceConfig
    store: ConversationStore
    metadata: DatasetAccess
    responder: Responder
    capacity: asyncio.Semaphore


def runtime_for(request: Request) -> Runtime:
    return cast(Runtime, request.app.state.runtime)


async def current_user(request: Request) -> AuthenticatedUser:
    return await authenticate(
        request, runtime_for(request).config.proxy_secret.get_secret_value()
    )


def create_app(
    config: ServiceConfig | None = None,
    responder: Responder | None = None,
    metadata: DatasetAccess | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        settings = config or ServiceConfig.load()
        async with httpx.AsyncClient(timeout=10) as client:
            model = responder or (
                DeepAgentResponder.from_config(settings)
                if settings.model
                else UnconfiguredResponder()
            )
            app.state.runtime = Runtime(
                settings,
                ConversationStore(settings.database_path),
                metadata or DataHubMetadata(settings.datahub_graphql_url, client),
                model,
                asyncio.Semaphore(settings.max_concurrent_requests),
            )
            yield

    app = FastAPI(
        title="DataHub Ask AI",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.middleware("http")
    async def limit_requests(
        request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if request.method in ("POST", "PATCH"):
            body = await request.body()
            if len(body) > 70000:
                return JSONResponse(
                    status_code=413,
                    content={
                        "code": "REQUEST_TOO_LARGE",
                        "message": "The request exceeds the assistant's size limit.",
                    },
                    headers={"Cache-Control": "no-store"},
                )
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(AiError)
    async def handle_error(request: Request, error: AiError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status,
            content={"code": error.code, "message": error.message},
        )

    @app.exception_handler(RequestValidationError)
    async def handle_invalid_request(
        request: Request, error: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=400,
            content={
                "code": "INVALID_REQUEST",
                "message": "Submit a valid assistant request.",
            },
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/ready")
    async def ready(request: Request) -> JSONResponse:
        configured = not isinstance(
            runtime_for(request).responder, UnconfiguredResponder
        )
        return JSONResponse(
            status_code=200 if configured else 503,
            content={"status": "ready" if configured else "model_unconfigured"},
        )

    @app.get("/v1/conversations", response_model=ConversationList)
    def conversations(
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
        offset: Annotated[int, Query(ge=0, le=100000)] = 0,
    ) -> ConversationList:
        return runtime_for(request).store.list_conversations(user.actor_urn, offset)

    @app.post("/v1/conversations", response_model=Conversation, status_code=201)
    def create_conversation(
        request: Request, user: Annotated[AuthenticatedUser, Depends(current_user)]
    ) -> Conversation:
        return runtime_for(request).store.create(user.actor_urn)

    @app.get("/v1/conversations/{conversation_id}", response_model=ConversationDetail)
    async def conversation(
        conversation_id: UUID,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
        before: Annotated[int | None, Query(ge=1)] = None,
    ) -> ConversationDetail:
        runtime = runtime_for(request)
        detail = await asyncio.to_thread(
            runtime.store.detail, user.actor_urn, conversation_id, before
        )
        for urn in {message.dataset_urn for message in detail.messages}:
            await runtime.metadata.authorize(user, urn)
        return detail

    @app.patch("/v1/conversations/{conversation_id}", response_model=Conversation)
    def rename(
        conversation_id: UUID,
        body: RenameConversation,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
    ) -> Conversation:
        return runtime_for(request).store.rename(
            user.actor_urn, conversation_id, body.title
        )

    @app.delete("/v1/conversations/{conversation_id}", status_code=204)
    def delete(
        conversation_id: UUID,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
    ) -> Response:
        runtime_for(request).store.delete(user.actor_urn, conversation_id)
        return Response(status_code=204)

    @app.delete("/v1/conversations", status_code=204)
    def clear(
        request: Request, user: Annotated[AuthenticatedUser, Depends(current_user)]
    ) -> Response:
        runtime_for(request).store.clear(user.actor_urn)
        return Response(status_code=204)

    @app.post("/v1/ask", response_model=AskResponse)
    async def ask(
        body: AskRequest,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(current_user)],
    ) -> AskResponse:
        runtime = runtime_for(request)
        if not body.question.strip():
            raise AiError(400, "INVALID_REQUEST", "Enter a question.")
        if body.conversation_id is not None:
            await asyncio.to_thread(
                runtime.store.detail, user.actor_urn, body.conversation_id
            )
        dataset = await runtime.metadata.resolve(user, body.context.dataset_urn)
        if runtime.capacity.locked():
            raise AiError(429, "AI_BUSY", "The assistant is busy. Try again shortly.")
        async with runtime.capacity:
            turn = await asyncio.to_thread(
                runtime.store.begin_turn,
                user.actor_urn,
                body,
                dataset.name,
                runtime.config.timeout_seconds + 30,
            )
            try:
                if turn.replay is not None:
                    await runtime.metadata.authorize(
                        user, turn.replay.assistant_message.dataset_urn
                    )
                    return turn.replay
                async with asyncio.timeout(runtime.config.timeout_seconds):
                    messages = await asyncio.to_thread(
                        runtime.store.context,
                        user.actor_urn,
                        turn,
                        runtime.config.max_context_characters - 12000,
                    )
                    for urn in {message.dataset_urn for message in messages} - {
                        dataset.urn
                    }:
                        await runtime.metadata.authorize(user, urn)
                    answer = await runtime.responder.answer(messages, dataset)
                    for urn in {message.dataset_urn for message in messages}:
                        await runtime.metadata.authorize(user, urn)
                    return await asyncio.to_thread(
                        runtime.store.finish, user.actor_urn, turn, answer
                    )
            except (Exception, asyncio.CancelledError) as error:
                await asyncio.shield(
                    asyncio.to_thread(runtime.store.fail, user.actor_urn, turn)
                )
                if isinstance(error, (AiError, asyncio.CancelledError)):
                    raise
                logging.getLogger("datahub.ai").warning(
                    "AI request failed request_id=%s error_type=%s",
                    body.request_id,
                    type(error).__name__,
                )
                if isinstance(error, (TimeoutError, ValidationError)):
                    raise AiError(
                        502,
                        "AI_RESPONSE_FAILED",
                        "The assistant could not complete this reply. Try again.",
                    ) from None
                raise AiError(
                    503,
                    "AI_UNAVAILABLE",
                    "The assistant is temporarily unavailable. Try again.",
                ) from None

    return app
