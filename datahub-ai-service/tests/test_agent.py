from collections.abc import Sequence
from uuid import uuid4

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel, LanguageModelInput
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable

from datahub_ai_service.agent import DeepAgentResponder
from datahub_ai_service.metadata import DatasetInfo, Platform
from datahub_ai_service.models import Message


class StructuredModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return "test-structured-model"

    def bind_tools(
        self,
        tools: Sequence[object],
        *,
        tool_choice: str | None = None,
        **kwargs: object,
    ) -> Runnable[LanguageModelInput, AIMessage]:
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: object,
    ) -> ChatResult:
        reply = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "AgentAnswer",
                    "args": {
                        "answer": "Schema explanation",
                        "title": "Dataset review",
                        "sources": [],
                    },
                    "id": "structured-answer",
                    "type": "tool_call",
                }
            ],
        )
        return ChatResult(generations=[ChatGeneration(message=reply)])


async def test_actual_deep_agent_returns_validated_structured_output() -> None:
    dataset = DatasetInfo(
        urn="urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)",
        name="events",
        platform=Platform(name="postgres"),
    )
    message = Message(
        id=uuid4(),
        sequence=1,
        role="user",
        text="Explain this dataset",
        dataset_urn=dataset.urn,
        dataset_name=dataset.name,
        created_at="2026-01-01T00:00:00Z",
        request_id=uuid4(),
        status="pending",
    )
    agent = DeepAgentResponder(StructuredModel())
    first = await agent.answer([message], dataset)
    second = await agent.answer([message], dataset)
    assert first.answer == second.answer == "Schema explanation"
    assert first.title == "Dataset review"
