import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

from datahub_query_service.config import (
    ConnectionConfig,
    ServiceConfig,
    SharedCredentialProvider,
)
from datahub_query_service.errors import QueryError
from datahub_query_service.postgres import PostgresAdapter
from datahub_query_service.validation import validate_query


@pytest.mark.integration
async def test_real_cursor_limits_read_only_and_pool_recovery(tmp_path: Path) -> None:
    url = os.environ.get("QUERY_SERVICE_TEST_DATABASE_URL")
    if not url:
        pytest.skip(
            "Set QUERY_SERVICE_TEST_DATABASE_URL to a disposable PostgreSQL database"
        )
    options = conninfo_to_dict(url)
    password = tmp_path / "password"
    password.write_text(str(options.get("password") or ""))
    connection = ConnectionConfig.model_validate(
        {
            "id": "test",
            "label": "Test",
            "host": options.get("host") or "localhost",
            "port": options.get("port") or 5432,
            "database": options.get("dbname") or "postgres",
            "username": options.get("user") or "postgres",
            "passwordFile": password,
            "sslmode": options.get("sslmode") or "disable",
        }
    )
    adapter = PostgresAdapter(
        ServiceConfig(maxRows=2, timeoutSeconds=1), SharedCredentialProvider()
    )
    try:
        result = await adapter.execute(
            connection,
            validate_query("SELECT n FROM generate_series(1, 4) AS n"),
            str(uuid4()),
        )
        assert result.rows == [{"n": 1}, {"n": 2}]
        assert result.truncated
        assert (
            await adapter.execute(
                connection, "SELECT 1 AS id WHERE FALSE", str(uuid4())
            )
        ).row_count == 0
        with pytest.raises(QueryError):
            await adapter.execute(connection, "SELECT 1 AS id, 2 AS id", str(uuid4()))
        assert (
            await adapter.execute(connection, "SELECT 1 AS id", str(uuid4()))
        ).rows == [{"id": 1}]
        pool = await adapter.pool_for(connection)
        async with pool.connection() as database:
            async with database.transaction():
                await database.execute("SET TRANSACTION READ ONLY")
                with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
                    await database.execute(
                        "CREATE TABLE query_service_write_probe (id integer)"
                    )
        with pytest.raises(QueryError) as timeout:
            await adapter.execute(connection, "SELECT pg_sleep(2)", str(uuid4()))
        assert timeout.value.code == "QUERY_TIMEOUT"
        assert (
            await adapter.execute(connection, "SELECT 2 AS id", str(uuid4()))
        ).rows == [{"id": 2}]
    finally:
        await adapter.close()
