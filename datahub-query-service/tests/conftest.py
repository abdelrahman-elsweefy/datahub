import hashlib
import hmac
import time
from pathlib import Path

import pytest
from pydantic import SecretStr

from datahub_query_service.config import ConnectionConfig, ServiceConfig
from datahub_query_service.models import QueryColumn, QueryResult

PROXY_SECRET = "test-proxy-secret-with-at-least-32-characters"
ACTOR = "urn:li:corpuser:user1"


def signed_headers(
    method: str,
    path: str,
    body: bytes = b"",
    actor: str = ACTOR,
    timestamp: int | None = None,
) -> dict[str, str]:
    stamp = str(timestamp if timestamp is not None else int(time.time()))
    authorization = "Bearer test-token"
    payload = "\n".join(
        (
            stamp,
            actor,
            method,
            path,
            hashlib.sha256(body).hexdigest(),
            hashlib.sha256(authorization.encode()).hexdigest(),
        )
    )
    return {
        "X-DataHub-Query-Actor": actor,
        "X-DataHub-Query-Timestamp": stamp,
        "X-DataHub-Query-Signature": hmac.new(
            PROXY_SECRET.encode(), payload.encode(), hashlib.sha256
        ).hexdigest(),
        "Authorization": authorization,
        "Content-Type": "application/json",
    }


@pytest.fixture
def config(tmp_path: Path) -> ServiceConfig:
    password = tmp_path / "password"
    password.write_text("test-password\n")
    return ServiceConfig(
        connections=[
            ConnectionConfig(
                id="analytics",
                label="Analytics",
                host="localhost",
                database="my_db",
                username="reader",
                passwordFile=password,
                sslmode="disable",
                allowedUserUrns=[ACTOR],
            ),
            ConnectionConfig(
                id="reporting",
                label="Reporting",
                host="localhost",
                database="other_db",
                username="reader",
                passwordFile=password,
                sslmode="disable",
                allowedUserUrns=[ACTOR],
            ),
            ConnectionConfig(
                id="restricted",
                label="Restricted",
                host="localhost",
                database="private_db",
                username="reader",
                passwordFile=password,
                sslmode="disable",
            ),
        ],
        proxy_secret=SecretStr(PROXY_SECRET),
    )


class RecordingAdapter:
    def __init__(self) -> None:
        self.executions: list[str] = []

    async def execute(
        self, connection: ConnectionConfig, statement: str, query_id: str
    ) -> QueryResult:
        self.executions.append(connection.id)
        return QueryResult(
            columns=[QueryColumn(name="id", type="int4")],
            rows=[{"id": 1}],
            rowCount=1,
            executionTimeMs=1,
            truncated=False,
            queryId=query_id,
            connectionId=connection.id,
        )

    async def close(self) -> None:
        pass
