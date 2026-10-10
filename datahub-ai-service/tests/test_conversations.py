import asyncio
import hashlib
import hmac
import json
import time
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from pydantic import SecretStr

from datahub_ai_service.app import create_app
from datahub_ai_service.auth import AuthenticatedUser
from datahub_ai_service.config import ServiceConfig
from datahub_ai_service.errors import AiError
from datahub_ai_service.metadata import DatasetInfo, Platform
from datahub_ai_service.models import (
    AgentAnswer,
    AskRequest,
    AskResponse,
    Conversation,
    ConversationList,
    DatasetContext,
    Message,
    SqlAction,
)
from datahub_ai_service.store import ConversationStore

USER = "urn:li:corpuser:user1"
OTHER_USER = "urn:li:corpuser:user2"
DATASET_A = "urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)"
DATASET_B = (
    "urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.customers,PROD)"
)
SECRET = "test-proxy-secret-" * 3


class TestMetadata:
    __test__ = False

    def __init__(self) -> None:
        self.denied: set[str] = set()

    async def authorize(self, user: AuthenticatedUser, urn: str) -> None:
        if urn in self.denied:
            raise AiError(403, "DATASET_ACCESS_DENIED", "Dataset access denied")

    async def resolve(self, user: AuthenticatedUser, urn: str) -> DatasetInfo:
        await self.authorize(user, urn)
        return DatasetInfo(
            urn=urn,
            name="events" if urn == DATASET_A else "customers",
            platform=Platform(name="postgres"),
        )


class TestResponder:
    __test__ = False

    def __init__(self) -> None:
        self.calls: list[list[Message]] = []
        self.fail = False
        self.wait = False
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def answer(
        self, messages: list[Message], dataset: DatasetInfo
    ) -> AgentAnswer:
        self.calls.append(messages)
        self.started.set()
        if self.wait:
            await self.release.wait()
        if self.fail:
            raise RuntimeError("private-provider-error")
        return AgentAnswer(
            answer="Here is a draft query.",
            title="Dataset analysis",
            sql_action=SqlAction(
                title="Preview", statement="SELECT 1", dialect="postgresql"
            ),
        )


@dataclass
class Api:
    client: httpx.AsyncClient
    config: ServiceConfig
    responder: TestResponder
    metadata: TestMetadata

    async def request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, object] | None = None,
        user: str = USER,
        signed: bool = True,
    ) -> httpx.Response:
        body = json.dumps(payload).encode() if payload is not None else b""
        timestamp = str(int(time.time()))
        authorization = "Bearer test-token"
        text = "\n".join(
            (
                timestamp,
                user,
                method,
                path,
                hashlib.sha256(body).hexdigest(),
                hashlib.sha256(authorization.encode()).hexdigest(),
            )
        )
        signature = (
            hmac.new(SECRET.encode(), text.encode(), hashlib.sha256).hexdigest()
            if signed
            else "forged"
        )
        return await self.client.request(
            method,
            path,
            content=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": authorization,
                "X-DataHub-AI-Actor": user,
                "X-DataHub-AI-Timestamp": timestamp,
                "X-DataHub-AI-Signature": signature,
            },
        )

    async def create(self, user: str = USER) -> Conversation:
        response = await self.request("POST", "/v1/conversations", user=user)
        assert response.status_code == 201
        return Conversation.model_validate(response.json())

    def question(
        self, conversation: Conversation, dataset: str = DATASET_A
    ) -> dict[str, object]:
        return {
            "context": {"datasetUrn": dataset, "userUrn": OTHER_USER},
            "question": "Explain this dataset",
            "conversationId": str(conversation.id),
            "requestId": str(uuid4()),
            "target": {"mode": "NEW_TAB"},
        }


@pytest_asyncio.fixture
async def api(tmp_path: Path) -> AsyncIterator[Api]:
    config = ServiceConfig(
        database_path=tmp_path / "history.sqlite", proxy_secret=SecretStr(SECRET)
    )
    responder, metadata = TestResponder(), TestMetadata()
    app = create_app(config, responder, metadata)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client,
    ):
        yield Api(client, config, responder, metadata)


async def test_history_survives_dataset_switch_and_service_restart(api: Api) -> None:
    conversation = await api.create()
    first = await api.request("POST", "/v1/ask", api.question(conversation))
    assert first.status_code == 200
    first_reply = AskResponse.model_validate(first.json())
    second = await api.request("POST", "/v1/ask", api.question(conversation, DATASET_B))
    assert second.status_code == 200
    assert [message.dataset_urn for message in api.responder.calls[1]] == [
        DATASET_A,
        DATASET_A,
        DATASET_B,
    ]
    reopened = ConversationStore(api.config.database_path).detail(USER, conversation.id)
    assert len(reopened.messages) == 4
    assert (
        reopened.conversation.title
        == first_reply.conversation.title
        == "Dataset analysis"
    )
    assert reopened.messages[1].sql_action is not None


async def test_authentication_and_ownership_are_enforced_for_all_operations(
    api: Api,
) -> None:
    conversation = await api.create()
    unsigned = await api.request("GET", "/v1/conversations", signed=False)
    assert unsigned.status_code == 401
    path = f"/v1/conversations/{conversation.id}"
    for method, payload in (
        ("GET", None),
        ("PATCH", {"title": "Other title"}),
        ("DELETE", None),
    ):
        response = await api.request(method, path, payload, user=OTHER_USER)
        assert response.status_code == 404
    forbidden_ask = await api.request(
        "POST", "/v1/ask", api.question(conversation), user=OTHER_USER
    )
    assert forbidden_ask.status_code == 404
    other_list = await api.request("GET", "/v1/conversations", user=OTHER_USER)
    assert ConversationList.model_validate(other_list.json()).conversations == []


async def test_retries_are_idempotent_and_failure_can_be_retried(api: Api) -> None:
    conversation = await api.create()
    request = api.question(conversation)
    api.responder.fail = True
    failed = await api.request("POST", "/v1/ask", request)
    assert failed.status_code == 503
    assert "private-provider-error" not in failed.text
    assert (
        ConversationStore(api.config.database_path)
        .detail(USER, conversation.id)
        .messages[0]
        .status
        == "failed"
    )
    api.responder.fail = False
    successful = await api.request("POST", "/v1/ask", request)
    repeated = await api.request("POST", "/v1/ask", request)
    assert successful.status_code == repeated.status_code == 200
    assert successful.json()["messageId"] == repeated.json()["messageId"]
    assert len(api.responder.calls) == 2
    assert (
        len(
            ConversationStore(api.config.database_path)
            .detail(USER, conversation.id)
            .messages
        )
        == 2
    )
    request["question"] = "A different question"
    assert (await api.request("POST", "/v1/ask", request)).status_code == 409


async def test_deletion_while_reply_is_pending_does_not_recreate_conversation(
    api: Api,
) -> None:
    conversation = await api.create()
    api.responder.wait = True
    pending = asyncio.create_task(
        api.request("POST", "/v1/ask", api.question(conversation))
    )
    await api.responder.started.wait()
    assert (
        await api.request("POST", "/v1/ask", api.question(conversation))
    ).status_code == 409
    assert (
        await api.request("DELETE", f"/v1/conversations/{conversation.id}")
    ).status_code == 204
    api.responder.release.set()
    assert (await pending).status_code == 404
    listed = await api.request("GET", "/v1/conversations")
    assert ConversationList.model_validate(listed.json()).conversations == []


async def test_revoked_dataset_access_blocks_history_and_later_model_context(
    api: Api,
) -> None:
    conversation = await api.create()
    assert (
        await api.request("POST", "/v1/ask", api.question(conversation))
    ).status_code == 200
    api.metadata.denied.add(DATASET_A)
    assert (
        await api.request("GET", f"/v1/conversations/{conversation.id}")
    ).status_code == 403
    assert (
        await api.request("POST", "/v1/ask", api.question(conversation, DATASET_B))
    ).status_code == 403
    assert len(api.responder.calls) == 1


async def test_rename_and_clear_are_user_scoped(api: Api) -> None:
    conversation = await api.create()
    other = await api.create(OTHER_USER)
    response = await api.request(
        "PATCH", f"/v1/conversations/{conversation.id}", {"title": "My analysis"}
    )
    assert response.status_code == 200
    assert (
        await api.request("POST", "/v1/ask", api.question(conversation))
    ).status_code == 200
    detail = ConversationStore(api.config.database_path).detail(USER, conversation.id)
    assert detail.conversation.title == "My analysis"
    assert (await api.request("DELETE", "/v1/conversations")).status_code == 204
    assert (
        await api.request("GET", f"/v1/conversations/{other.id}", user=OTHER_USER)
    ).status_code == 200


def test_pagination_context_budget_and_expired_turns(tmp_path: Path) -> None:
    store = ConversationStore(tmp_path / "history.sqlite")
    conversation = store.create(USER)
    for index in range(4):
        request = AskRequest(
            context=DatasetContext(dataset_urn=DATASET_A),
            question=f"Question {index}",
            conversation_id=conversation.id,
        )
        turn = store.begin_turn(USER, request, "events", 120)
        store.finish(USER, turn, AgentAnswer(answer="x" * 500))
    latest = store.detail(USER, conversation.id, limit=3)
    assert latest.next_before is not None
    previous = store.detail(USER, conversation.id, before=latest.next_before, limit=3)
    assert previous.messages[-1].sequence < latest.messages[0].sequence
    request = AskRequest(
        context=DatasetContext(dataset_urn=DATASET_B),
        question="New context",
        conversation_id=conversation.id,
    )
    expired = store.begin_turn(USER, request, "customers", -1)
    assert store.detail(USER, conversation.id).messages[-1].status == "failed"
    replacement = store.begin_turn(USER, request, "customers", 120)
    with pytest.raises(AiError):
        store.finish(USER, expired, AgentAnswer(answer="Old result"))
    context = store.context(USER, replacement, 1800)
    assert len(context) < 9
    assert context[-1].dataset_urn == DATASET_B
    store.finish(USER, replacement, AgentAnswer(answer="Current result"))


async def test_access_revocation_during_generation_discards_the_reply(api: Api) -> None:
    conversation = await api.create()
    api.responder.wait = True
    pending = asyncio.create_task(
        api.request("POST", "/v1/ask", api.question(conversation))
    )
    await api.responder.started.wait()
    api.metadata.denied.add(DATASET_A)
    api.responder.release.set()
    assert (await pending).status_code == 403
    messages = (
        ConversationStore(api.config.database_path)
        .detail(USER, conversation.id)
        .messages
    )
    assert len(messages) == 1
    assert messages[0].status == "failed"
