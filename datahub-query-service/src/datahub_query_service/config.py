import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from datahub_query_service.errors import QueryError
from datahub_query_service.models import ConnectionSummary


class ConnectionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    label: str = Field(min_length=1)
    platform: Literal["postgres"] = "postgres"
    host: str = Field(min_length=1)
    port: int = Field(default=5432, ge=1, le=65535)
    database: str = Field(min_length=1)
    username: str = Field(min_length=1)
    password_file: Path = Field(alias="passwordFile")
    sslmode: Literal["disable", "require", "verify-ca", "verify-full"] = "verify-full"
    sslrootcert: str | None = None
    default_schema: str = Field(default="public", alias="defaultSchema", min_length=1)
    allowed_user_urns: list[str] = Field(default_factory=list, alias="allowedUserUrns")
    allow_all_authenticated_users: bool = Field(
        default=False, alias="allowAllAuthenticatedUsers"
    )
    dataset_urns: list[str] = Field(default_factory=list, alias="datasetUrns")
    platform_instance_urn: str | None = Field(default=None, alias="platformInstanceUrn")
    environment: str = "PROD"

    def permits(self, actor: str) -> bool:
        return self.allow_all_authenticated_users or actor in self.allowed_user_urns

    def summary(self) -> ConnectionSummary:
        return ConnectionSummary(id=self.id, label=self.label, database=self.database)


class ServiceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    connections: list[ConnectionConfig] = Field(default_factory=list)
    max_rows: int = Field(default=100, alias="maxRows", ge=1, le=10000)
    max_result_bytes: int = Field(
        default=4 * 1024 * 1024, alias="maxResultBytes", ge=1024, le=16 * 1024 * 1024
    )
    timeout_seconds: int = Field(default=30, alias="timeoutSeconds", ge=1, le=120)
    max_concurrent_queries: int = Field(
        default=10, alias="maxConcurrentQueries", ge=1, le=100
    )
    pool_size: int = Field(default=4, alias="poolSize", ge=1, le=20)
    datahub_graphql_url: str = Field(
        default="http://datahub-gms:8080/api/graphql", alias="datahubGraphqlUrl"
    )
    proxy_secret: SecretStr = Field(default=SecretStr(""), exclude=True)

    @model_validator(mode="after")
    def unique_connection_ids(self) -> "ServiceConfig":
        if len({connection.id for connection in self.connections}) != len(
            self.connections
        ):
            raise ValueError("Connection IDs must be unique")
        return self

    @classmethod
    def load(cls) -> "ServiceConfig":
        path = os.environ.get(
            "DATAHUB_QUERY_SERVICE_CONFIG",
            "/etc/datahub-query-service/connections.json",
        )
        try:
            config = cls.model_validate_json(Path(path).read_text())
        except (OSError, ValueError):
            # Validation errors can contain submitted configuration, including secret paths.
            raise RuntimeError("Unable to load query service configuration") from None
        secret = os.environ.get("DATAHUB_QUERY_SERVICE_PROXY_SECRET", "")
        if len(secret) < 32:
            raise RuntimeError(
                "A query-service proxy secret of at least 32 characters is required"
            )
        config.proxy_secret = SecretStr(secret)
        return config

    def connection_for(self, connection_id: str, actor: str) -> ConnectionConfig:
        connection = next(
            (
                item
                for item in self.connections
                if item.id == connection_id and item.permits(actor)
            ),
            None,
        )
        if connection is None:
            raise QueryError(
                403,
                "CONNECTION_ACCESS_DENIED",
                "You do not have access to this connection.",
            )
        return connection


class SharedCredentialProvider:
    def password_for(self, connection: ConnectionConfig) -> SecretStr:
        try:
            password = connection.password_file.read_text().rstrip("\r\n")
        except OSError:
            raise QueryError(
                503, "CONNECTION_UNAVAILABLE", "The selected connection is unavailable."
            ) from None
        if not password:
            raise QueryError(
                503, "CONNECTION_UNAVAILABLE", "The selected connection is unavailable."
            )
        return SecretStr(password)
