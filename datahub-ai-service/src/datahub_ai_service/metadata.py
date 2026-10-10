from typing import Protocol

import httpx
from pydantic import BaseModel, Field

from datahub_ai_service.auth import AuthenticatedUser
from datahub_ai_service.errors import AiError


class FieldInfo(BaseModel):
    fieldPath: str
    nativeDataType: str | None = None
    description: str | None = None


class SchemaInfo(BaseModel):
    fields: list[FieldInfo] = Field(default_factory=list)


class DatasetProperties(BaseModel):
    description: str | None = None


class Platform(BaseModel):
    name: str


class DatasetInfo(BaseModel):
    urn: str
    name: str
    platform: Platform
    properties: DatasetProperties | None = None
    schemaMetadata: SchemaInfo | None = None

    def context_json(self) -> str:
        summary = self.model_copy(deep=True)
        if summary.properties and summary.properties.description:
            summary.properties.description = summary.properties.description[:2000]
        if summary.schemaMetadata:
            summary.schemaMetadata.fields = summary.schemaMetadata.fields[:100]
            for field in summary.schemaMetadata.fields:
                if field.description:
                    field.description = field.description[:200]
        return summary.model_dump_json()[:12000]


class Privileges(BaseModel):
    privileges: list[str] = Field(default_factory=list)


class GraphqlData(BaseModel):
    getGrantedPrivileges: Privileges | None = None
    dataset: DatasetInfo | None = None


class GraphqlResponse(BaseModel):
    data: GraphqlData | None = None
    errors: list[object] = Field(default_factory=list)


class DatasetAccess(Protocol):
    async def authorize(self, user: AuthenticatedUser, urn: str) -> None: ...
    async def resolve(self, user: AuthenticatedUser, urn: str) -> DatasetInfo: ...


class DataHubMetadata:
    def __init__(self, url: str, client: httpx.AsyncClient) -> None:
        self.url = url
        self.client = client

    async def query(
        self, user: AuthenticatedUser, query: str, variables: dict[str, object]
    ) -> GraphqlData:
        try:
            response = await self.client.post(
                self.url,
                headers={
                    "Authorization": user.authorization,
                    "X-DataHub-Actor": user.actor_urn,
                },
                json={"query": query, "variables": variables},
            )
            if response.status_code in (401, 403):
                raise AiError(
                    403,
                    "DATASET_ACCESS_DENIED",
                    "You do not have access to this dataset.",
                )
            response.raise_for_status()
            if len(response.content) > 1024 * 1024:
                raise AiError(
                    503,
                    "METADATA_UNAVAILABLE",
                    "Dataset metadata exceeds the assistant's context limit.",
                )
            payload = GraphqlResponse.model_validate(response.json())
        except (httpx.HTTPError, ValueError):
            raise AiError(
                503,
                "METADATA_UNAVAILABLE",
                "Dataset metadata is temporarily unavailable.",
            ) from None
        if payload.errors or payload.data is None:
            raise AiError(
                403, "DATASET_ACCESS_DENIED", "You do not have access to this dataset."
            )
        return payload.data

    async def authorize(self, user: AuthenticatedUser, urn: str) -> None:
        result = await self.query(
            user,
            (
                "query AskAiPrivileges($input: GetGrantedPrivilegesInput!) { "
                "getGrantedPrivileges(input: $input) { privileges } }"
            ),
            {
                "input": {
                    "actorUrn": user.actor_urn,
                    "resourceSpec": {"resourceType": "DATASET", "resourceUrn": urn},
                }
            },
        )
        if (
            result.getGrantedPrivileges is None
            or "VIEW_ENTITY_PAGE" not in result.getGrantedPrivileges.privileges
        ):
            raise AiError(
                403, "DATASET_ACCESS_DENIED", "You do not have access to this dataset."
            )

    async def resolve(self, user: AuthenticatedUser, urn: str) -> DatasetInfo:
        await self.authorize(user, urn)
        result = await self.query(
            user,
            (
                "query AskAiDataset($urn: String!) { dataset(urn: $urn) { urn "
                "name platform { name } properties { description "
                "} schemaMetadata "
                "{ fields { fieldPath nativeDataType description } } } }"
            ),
            {"urn": urn},
        )
        if result.dataset is None:
            raise AiError(404, "DATASET_NOT_FOUND", "This dataset is unavailable.")
        return result.dataset
