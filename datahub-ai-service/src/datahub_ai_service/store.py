import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from datahub_ai_service.errors import AiError
from datahub_ai_service.models import (
    AgentAnswer,
    AskRequest,
    AskResponse,
    Conversation,
    ConversationDetail,
    ConversationList,
    Message,
)


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True)
class Turn:
    conversation_id: UUID
    user_message: Message
    lease_id: str | None = None
    replay: AskResponse | None = None


class ConversationStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    title_generated INTEGER NOT NULL DEFAULT 0,
                    pending_id TEXT, pending_until REAL
                );
                CREATE INDEX IF NOT EXISTS conversation_owner_updated
                    ON conversations(owner, updated_at DESC, id DESC);
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL
                        REFERENCES conversations(id) ON DELETE CASCADE,
                    owner TEXT NOT NULL, request_id TEXT NOT NULL,
                    role TEXT NOT NULL, sequence INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    UNIQUE(owner, request_id, role),
                    UNIQUE(conversation_id, sequence)
                );
            """)

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.connection() as db:
            # Serialize short mutations across workers; never hold this transaction
            # during an AI call.
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise

    def require_conversation(
        self, db: sqlite3.Connection, owner: str, conversation_id: UUID
    ) -> Conversation:
        row = db.execute(
            "SELECT id, title, created_at, updated_at FROM "
            "conversations WHERE id=? AND owner=?",
            (str(conversation_id), owner),
        ).fetchone()
        if row is None:
            raise AiError(
                404, "CONVERSATION_NOT_FOUND", "This conversation is unavailable."
            )
        return Conversation.model_validate(dict(row))

    def insert_conversation(self, db: sqlite3.Connection, owner: str) -> Conversation:
        now = timestamp()
        conversation = Conversation(
            id=uuid4(), title="New conversation", created_at=now, updated_at=now
        )
        db.execute(
            (
                "INSERT INTO conversations(id, owner, title, created_at, "
                "updated_at) VALUES (?, ?, ?, ?, ?)"
            ),
            (str(conversation.id), owner, conversation.title, now, now),
        )
        return conversation

    def create(self, owner: str) -> Conversation:
        with self.transaction() as db:
            return self.insert_conversation(db, owner)

    def list_conversations(
        self, owner: str, offset: int = 0, limit: int = 50
    ) -> ConversationList:
        with self.connection() as db:
            rows = db.execute(
                (
                    "SELECT id, title, created_at, updated_at FROM conversations "
                    "WHERE owner=? ORDER BY updated_at DESC, id DESC "
                    "LIMIT ? OFFSET ?"
                ),
                (owner, limit + 1, offset),
            ).fetchall()
        return ConversationList(
            conversations=[
                Conversation.model_validate(dict(row)) for row in rows[:limit]
            ],
            next_offset=offset + limit if len(rows) > limit else None,
        )

    def expire_pending(self, db: sqlite3.Connection, conversation_id: UUID) -> None:
        lease = db.execute(
            "SELECT pending_id, pending_until FROM conversations WHERE id=?",
            (str(conversation_id),),
        ).fetchone()
        if lease["pending_id"] is None or lease["pending_until"] > time.time():
            return
        row = db.execute(
            "SELECT id, payload FROM messages WHERE conversation_id=? "
            "AND role='user' ORDER BY sequence DESC LIMIT 1",
            (str(conversation_id),),
        ).fetchone()
        if row is not None:
            stale = Message.model_validate_json(row["payload"])
            if stale.status == "pending":
                stale.status = "failed"
                db.execute(
                    "UPDATE messages SET payload=? WHERE id=?",
                    (stale.model_dump_json(by_alias=True), row["id"]),
                )
        db.execute(
            "UPDATE conversations SET pending_id=NULL, pending_until=NULL WHERE id=?",
            (str(conversation_id),),
        )

    def detail(
        self,
        owner: str,
        conversation_id: UUID,
        before: int | None = None,
        limit: int = 100,
    ) -> ConversationDetail:
        with self.transaction() as db:
            conversation = self.require_conversation(db, owner, conversation_id)
            self.expire_pending(db, conversation_id)
            rows = db.execute(
                (
                    "SELECT payload FROM messages WHERE conversation_id=? AND "
                    "sequence<? ORDER BY sequence DESC LIMIT ?"
                ),
                (
                    str(conversation_id),
                    before if before is not None else 2147483647,
                    limit + 1,
                ),
            ).fetchall()
            messages = [
                Message.model_validate_json(row["payload"])
                for row in reversed(rows[:limit])
            ]
        return ConversationDetail(
            conversation=conversation,
            messages=messages,
            next_before=messages[0].sequence if len(rows) > limit else None,
        )

    def rename(self, owner: str, conversation_id: UUID, title: str) -> Conversation:
        title = title.strip()
        if not title:
            raise AiError(400, "INVALID_TITLE", "Enter a conversation title.")
        with self.transaction() as db:
            self.require_conversation(db, owner, conversation_id)
            db.execute(
                "UPDATE conversations SET title=?, "
                "title_generated=1, updated_at=? WHERE id=?",
                (title, timestamp(), str(conversation_id)),
            )
            return self.require_conversation(db, owner, conversation_id)

    def delete(self, owner: str, conversation_id: UUID) -> None:
        with self.transaction() as db:
            self.require_conversation(db, owner, conversation_id)
            db.execute("DELETE FROM conversations WHERE id=?", (str(conversation_id),))

    def clear(self, owner: str) -> None:
        with self.transaction() as db:
            db.execute("DELETE FROM conversations WHERE owner=?", (owner,))

    def write_message(
        self,
        db: sqlite3.Connection,
        owner: str,
        conversation_id: UUID,
        message: Message,
    ) -> None:
        db.execute(
            (
                "INSERT INTO messages(id, conversation_id, owner, request_id, "
                "role, sequence, payload) VALUES (?, ?, ?, ?, ?, ?, ?)"
            ),
            (
                str(message.id),
                str(conversation_id),
                owner,
                str(message.request_id),
                message.role,
                message.sequence,
                message.model_dump_json(by_alias=True),
            ),
        )

    def response(
        self,
        conversation: Conversation,
        user_message: Message,
        assistant_message: Message,
    ) -> AskResponse:
        return AskResponse(
            answer=assistant_message.text,
            sql_action=assistant_message.sql_action,
            sources=assistant_message.sources,
            conversation_id=conversation.id,
            message_id=assistant_message.id,
            request_id=user_message.request_id,
            conversation=conversation,
            user_message=user_message,
            assistant_message=assistant_message,
        )

    def begin_turn(
        self, owner: str, request: AskRequest, dataset_name: str, lease_seconds: int
    ) -> Turn:
        with self.transaction() as db:
            existing = db.execute(
                (
                    "SELECT conversation_id, payload FROM messages "
                    "WHERE owner=? AND "
                    "request_id=? AND role='user'"
                ),
                (owner, str(request.request_id)),
            ).fetchone()
            user_message = (
                Message.model_validate_json(existing["payload"])
                if existing is not None
                else None
            )
            if user_message is not None:
                conversation_id = UUID(existing["conversation_id"])
                if (
                    user_message.text != request.question.strip()
                    or user_message.dataset_urn != request.context.dataset_urn
                    or (
                        request.conversation_id is not None
                        and request.conversation_id != conversation_id
                    )
                ):
                    raise AiError(
                        409,
                        "REQUEST_CONFLICT",
                        "Use a new request ID for a different message.",
                    )
                conversation = self.require_conversation(db, owner, conversation_id)
                if user_message.status == "completed":
                    reply = db.execute(
                        (
                            "SELECT payload FROM messages WHERE owner=? AND "
                            "request_id=? AND role='assistant'"
                        ),
                        (owner, str(request.request_id)),
                    ).fetchone()
                    return Turn(
                        conversation_id=conversation_id,
                        user_message=user_message,
                        replay=self.response(
                            conversation,
                            user_message,
                            Message.model_validate_json(reply["payload"]),
                        ),
                    )
            elif request.conversation_id is not None:
                conversation = self.require_conversation(
                    db, owner, request.conversation_id
                )
            else:
                conversation = self.insert_conversation(db, owner)
            lease = db.execute(
                "SELECT pending_id, pending_until FROM conversations WHERE id=?",
                (str(conversation.id),),
            ).fetchone()
            if lease["pending_id"] is not None and lease["pending_until"] > time.time():
                raise AiError(
                    409,
                    "CONVERSATION_BUSY",
                    "Wait for the current reply before sending another message.",
                )
            self.expire_pending(db, conversation.id)
            if user_message is not None:
                latest = db.execute(
                    "SELECT MAX(sequence) FROM messages WHERE conversation_id=?",
                    (str(conversation.id),),
                ).fetchone()[0]
                if latest != user_message.sequence:
                    raise AiError(
                        409,
                        "REQUEST_SUPERSEDED",
                        "Send a new message to continue this conversation.",
                    )
            lease_id = str(uuid4())
            now = timestamp()
            db.execute(
                "UPDATE conversations SET pending_id=?, "
                "pending_until=?, updated_at=? WHERE id=?",
                (lease_id, time.time() + lease_seconds, now, str(conversation.id)),
            )
            if user_message is None:
                sequence = db.execute(
                    "SELECT COALESCE(MAX(sequence), 0) + 1 FROM "
                    "messages WHERE conversation_id=?",
                    (str(conversation.id),),
                ).fetchone()[0]
                user_message = Message(
                    id=uuid4(),
                    sequence=sequence,
                    role="user",
                    text=request.question.strip(),
                    dataset_urn=request.context.dataset_urn,
                    dataset_name=dataset_name,
                    created_at=now,
                    request_id=request.request_id,
                    status="pending",
                )
                self.write_message(db, owner, conversation.id, user_message)
                db.execute(
                    (
                        "UPDATE conversations SET title=? WHERE id=? AND "
                        "title_generated=0 AND title='New conversation'"
                    ),
                    (" ".join(user_message.text.split())[:80], str(conversation.id)),
                )
            else:
                user_message.status = "pending"
                db.execute(
                    "UPDATE messages SET payload=? WHERE id=?",
                    (user_message.model_dump_json(by_alias=True), str(user_message.id)),
                )
            return Turn(
                conversation_id=conversation.id,
                user_message=user_message,
                lease_id=lease_id,
            )

    def context(self, owner: str, turn: Turn, max_characters: int) -> list[Message]:
        with self.connection() as db:
            self.require_conversation(db, owner, turn.conversation_id)
            rows = db.execute(
                (
                    "SELECT payload FROM messages WHERE "
                    "conversation_id=? ORDER BY sequence DESC LIMIT "
                    "200"
                ),
                (str(turn.conversation_id),),
            ).fetchall()
        messages = [
            Message.model_validate_json(row["payload"]) for row in reversed(rows)
        ]
        completed = [message for message in messages if message.status == "completed"]
        groups: list[list[Message]] = []
        for message in completed:
            if message.role == "user":
                groups.append([message])
            elif groups:
                groups[-1].append(message)
        budget = (
            max_characters
            - len(turn.user_message.text)
            - len(turn.user_message.dataset_urn)
            - 512
        )
        selected: list[list[Message]] = []
        for group in reversed(groups):
            size = sum(len(message.model_dump_json()) for message in group)
            if len(group) != 2:
                continue
            if size > budget:
                break
            selected.insert(0, group)
            budget -= size
        return [message for group in selected for message in group] + [
            turn.user_message
        ]

    def finish(self, owner: str, turn: Turn, answer: AgentAnswer) -> AskResponse:
        with self.transaction() as db:
            self.require_conversation(db, owner, turn.conversation_id)
            row = db.execute(
                "SELECT pending_id FROM conversations WHERE id=?",
                (str(turn.conversation_id),),
            ).fetchone()
            if row["pending_id"] != turn.lease_id:
                raise AiError(409, "REQUEST_EXPIRED", "This reply is no longer active.")
            user_message = turn.user_message.model_copy(update={"status": "completed"})
            db.execute(
                "UPDATE messages SET payload=? WHERE id=?",
                (user_message.model_dump_json(by_alias=True), str(user_message.id)),
            )
            sequence = db.execute(
                "SELECT MAX(sequence) + 1 FROM messages WHERE conversation_id=?",
                (str(turn.conversation_id),),
            ).fetchone()[0]
            assistant = Message(
                id=uuid4(),
                sequence=sequence,
                role="assistant",
                text=answer.answer,
                dataset_urn=user_message.dataset_urn,
                dataset_name=user_message.dataset_name,
                created_at=timestamp(),
                request_id=user_message.request_id,
                status="completed",
                sql_action=answer.sql_action,
                sources=answer.sources,
            )
            self.write_message(db, owner, turn.conversation_id, assistant)
            if answer.title:
                db.execute(
                    (
                        "UPDATE conversations SET title=?, "
                        "title_generated=1 WHERE id=? AND "
                        "title_generated=0"
                    ),
                    (answer.title, str(turn.conversation_id)),
                )
            db.execute(
                "UPDATE conversations SET pending_id=NULL, "
                "pending_until=NULL, updated_at=? WHERE id=?",
                (timestamp(), str(turn.conversation_id)),
            )
            return self.response(
                self.require_conversation(db, owner, turn.conversation_id),
                user_message,
                assistant,
            )

    def fail(self, owner: str, turn: Turn) -> None:
        with self.transaction() as db:
            row = db.execute(
                "SELECT pending_id FROM conversations WHERE id=? AND owner=?",
                (str(turn.conversation_id), owner),
            ).fetchone()
            if row is None or row["pending_id"] != turn.lease_id:
                return
            failed = turn.user_message.model_copy(update={"status": "failed"})
            db.execute(
                "UPDATE messages SET payload=? WHERE id=?",
                (failed.model_dump_json(by_alias=True), str(failed.id)),
            )
            db.execute(
                "UPDATE conversations SET pending_id=NULL, "
                "pending_until=NULL WHERE id=?",
                (str(turn.conversation_id),),
            )
