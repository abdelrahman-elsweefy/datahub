from pydantic import BaseModel, ConfigDict, Field, JsonValue


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class QueryRequest(ApiModel):
    connection_id: str = Field(alias="connectionId", pattern=r"^[A-Za-z0-9_-]{1,128}$")
    dataset_urn: str | None = Field(default=None, alias="datasetUrn", max_length=4096)
    sql: str = Field(min_length=1, max_length=65536)


class ConnectionSummary(ApiModel):
    id: str
    label: str
    platform: str = "postgres"
    database: str


class ConnectionList(ApiModel):
    connections: list[ConnectionSummary]
    default_connection_id: str | None = Field(default=None, alias="defaultConnectionId")
    max_rows: int = Field(alias="maxRows")


class QueryColumn(ApiModel):
    name: str
    type: str


class QueryResult(ApiModel):
    columns: list[QueryColumn]
    rows: list[dict[str, JsonValue]]
    row_count: int = Field(alias="rowCount")
    execution_time_ms: int = Field(alias="executionTimeMs")
    truncated: bool
    query_id: str = Field(alias="queryId")
    connection_id: str = Field(alias="connectionId")
