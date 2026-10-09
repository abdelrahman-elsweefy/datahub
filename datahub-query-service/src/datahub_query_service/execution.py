import base64
import math
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Protocol
from uuid import UUID

from pydantic import JsonValue

from datahub_query_service.config import ConnectionConfig
from datahub_query_service.errors import QueryError
from datahub_query_service.models import QueryResult


class QueryAdapter(Protocol):
    async def execute(
        self, connection: ConnectionConfig, statement: str, query_id: str
    ) -> QueryResult: ...

    async def close(self) -> None: ...


def serialize_value(value: object, depth: int = 0) -> JsonValue:
    if depth > 20:
        raise QueryError(
            422, "RESULT_VALUE_UNSUPPORTED", "A result value is nested too deeply."
        )
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value if abs(value) <= 2**53 - 1 else str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, (Decimal, UUID, timedelta)):
        return str(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, (list, tuple)):
        return [serialize_value(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {
            str(key): serialize_value(item, depth + 1) for key, item in value.items()
        }
    raise QueryError(
        422,
        "RESULT_VALUE_UNSUPPORTED",
        "The query returned an unsupported data type. Cast it to text in your SQL.",
    )
