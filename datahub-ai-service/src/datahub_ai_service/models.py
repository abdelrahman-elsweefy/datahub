from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid"
    )


class DatasetContext(ApiModel):
    dataset_urn: str = Field(min_length=1, max_length=4096, pattern=r"^urn:li:dataset:")
    user_urn: str | None = Field(default=None, max_length=4096)


class NewTabTarget(ApiModel):
    mode: Literal["NEW_TAB"] = "NEW_TAB"


class AskRequest(ApiModel):
    context: DatasetContext
    question: str = Field(min_length=1, max_length=16000)
    conversation_id: UUID | None = None
    request_id: UUID = Field(default_factory=uuid4)
    target: NewTabTarget = Field(default_factory=NewTabTarget)


class SqlAction(ApiModel):
    type: Literal["CREATE_TAB"] = "CREATE_TAB"
    title: str = Field(min_length=1, max_length=120)
    statement: str = Field(min_length=1, max_length=32000)
    dialect: str = Field(min_length=1, max_length=80)


class Source(ApiModel):
    title: str = Field(min_length=1, max_length=200)
    url: str | None = Field(default=None, max_length=4096)


class AgentAnswer(ApiModel):
    answer: str = Field(min_length=1, max_length=20000)
    title: str | None = Field(default=None, min_length=1, max_length=120)
    sql_action: SqlAction | None = None
    sources: list[Source] = Field(default_factory=list, max_length=20)


class Conversation(ApiModel):
    id: UUID
    title: str
    created_at: str
    updated_at: str


class ConversationList(ApiModel):
    conversations: list[Conversation]
    next_offset: int | None = None


class RenameConversation(ApiModel):
    title: str = Field(min_length=1, max_length=120)


class Message(ApiModel):
    id: UUID
    sequence: int
    role: Literal["user", "assistant"]
    text: str
    dataset_urn: str
    dataset_name: str
    created_at: str
    request_id: UUID
    status: Literal["pending", "completed", "failed"]
    sql_action: SqlAction | None = None
    sources: list[Source] = Field(default_factory=list)


class ConversationDetail(ApiModel):
    conversation: Conversation
    messages: list[Message]
    next_before: int | None = None


class AskResponse(AgentAnswer):
    conversation_id: UUID
    message_id: UUID
    request_id: UUID
    user_message: Message
    assistant_message: Message
    conversation: Conversation
