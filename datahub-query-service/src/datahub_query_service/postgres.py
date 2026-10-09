import asyncio
import json
import time
from collections.abc import Sequence

import psycopg
from psycopg import sql
from psycopg_pool import AsyncConnectionPool, PoolTimeout
from pydantic import JsonValue

from datahub_query_service.config import (
    ConnectionConfig,
    ServiceConfig,
    SharedCredentialProvider,
)
from datahub_query_service.errors import QueryError
from datahub_query_service.execution import serialize_value
from datahub_query_service.models import QueryColumn, QueryResult


class PostgresAdapter:
    def __init__(
        self, config: ServiceConfig, credentials: SharedCredentialProvider
    ) -> None:
        self.config = config
        self.credentials = credentials
        self.pools: dict[
            str, AsyncConnectionPool[psycopg.AsyncConnection[tuple[object, ...]]]
        ] = {}
        self.pool_lock = asyncio.Lock()

    async def pool_for(
        self, connection: ConnectionConfig
    ) -> AsyncConnectionPool[psycopg.AsyncConnection[tuple[object, ...]]]:
        async with self.pool_lock:
            if connection.id not in self.pools:
                options: dict[str, str | int] = {
                    "host": connection.host,
                    "port": connection.port,
                    "dbname": connection.database,
                    "user": connection.username,
                    "password": self.credentials.password_for(
                        connection
                    ).get_secret_value(),
                    "sslmode": connection.sslmode,
                    "connect_timeout": 5,
                    "application_name": "datahub-query-service",
                }
                if connection.sslrootcert:
                    options["sslrootcert"] = connection.sslrootcert
                pool: AsyncConnectionPool[
                    psycopg.AsyncConnection[tuple[object, ...]]
                ] = AsyncConnectionPool(
                    kwargs=options,
                    min_size=0,
                    max_size=self.config.pool_size,
                    open=False,
                    timeout=5,
                )
                await pool.open()
                self.pools[connection.id] = pool
            return self.pools[connection.id]

    async def execute(
        self, connection: ConnectionConfig, statement: str, query_id: str
    ) -> QueryResult:
        started = time.monotonic()
        try:
            async with asyncio.timeout(self.config.timeout_seconds):
                pool = await self.pool_for(connection)
                async with pool.connection() as database:
                    async with database.transaction():
                        await database.execute("SET TRANSACTION READ ONLY")
                        await database.execute(
                            sql.SQL("SET LOCAL statement_timeout = {}").format(
                                sql.Literal(self.config.timeout_seconds * 1000)
                            )
                        )
                        await database.execute("SET LOCAL lock_timeout = '2s'")
                        # Trusted built-ins precede user schemas; transaction-local settings cannot leak into the pool.
                        await database.execute(
                            sql.SQL(
                                "SET LOCAL search_path = pg_catalog, {}, pg_temp"
                            ).format(sql.Identifier(connection.default_schema))
                        )
                        async with database.cursor(
                            name="query_" + query_id.replace("-", "")
                        ) as cursor:
                            await cursor.execute(statement)
                            columns = self.columns_for(cursor.description or [])
                            rows: list[dict[str, JsonValue]] = []
                            size = (
                                len(
                                    json.dumps(
                                        [column.model_dump() for column in columns]
                                    ).encode()
                                )
                                + 1024
                            )
                            truncated = False
                            if size > self.config.max_result_bytes:
                                raise QueryError(
                                    413,
                                    "RESULT_TOO_LARGE",
                                    "The result contains too many columns. Select fewer columns.",
                                )
                            # A server cursor avoids fetching the entire result into service memory.
                            for _ in range(self.config.max_rows + 1):
                                row = await cursor.fetchone()
                                if row is None:
                                    break
                                if len(rows) == self.config.max_rows:
                                    truncated = True
                                    break
                                values = {
                                    column.name: serialize_value(value)
                                    for column, value in zip(columns, row, strict=True)
                                }
                                size += (
                                    len(json.dumps(values, ensure_ascii=True).encode())
                                    + 1
                                )
                                if size > self.config.max_result_bytes:
                                    if not rows:
                                        raise QueryError(
                                            413,
                                            "RESULT_TOO_LARGE",
                                            "A result row exceeds the response limit. Select fewer or smaller columns.",
                                        )
                                    truncated = True
                                    break
                                rows.append(values)
                            return QueryResult(
                                columns=columns,
                                rows=rows,
                                rowCount=len(rows),
                                executionTimeMs=int(
                                    (time.monotonic() - started) * 1000
                                ),
                                truncated=truncated,
                                queryId=query_id,
                                connectionId=connection.id,
                            )
        except (TimeoutError, psycopg.errors.QueryCanceled):
            raise QueryError(
                504, "QUERY_TIMEOUT", "The query exceeded its time limit."
            ) from None
        except psycopg.errors.InsufficientPrivilege:
            raise QueryError(
                403,
                "DATABASE_ACCESS_DENIED",
                "The read-only account cannot access a table or function in this query.",
            ) from None
        except (PoolTimeout, psycopg.OperationalError):
            raise QueryError(
                503, "CONNECTION_UNAVAILABLE", "The selected connection is unavailable."
            ) from None
        except psycopg.Error:
            raise QueryError(
                400,
                "QUERY_EXECUTION_FAILED",
                "The database could not run this query. Check its SQL, table names and column names.",
            ) from None

    @staticmethod
    def columns_for(description: Sequence[psycopg.Column]) -> list[QueryColumn]:
        names = [column.name for column in description]
        if len(set(names)) != len(names):
            raise QueryError(
                400,
                "DUPLICATE_COLUMN_NAMES",
                "Give duplicate result columns distinct aliases using AS.",
            )
        columns = []
        for column in description:
            info = psycopg.postgres.types.get(column.type_code)
            columns.append(
                QueryColumn(
                    name=column.name, type=info.name if info else str(column.type_code)
                )
            )
        return columns

    async def close(self) -> None:
        await asyncio.gather(*(pool.close() for pool in self.pools.values()))
