import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from datahub_query_service.auth import AuthenticatedUser
from datahub_query_service.config import ConnectionConfig, ServiceConfig
from datahub_query_service.errors import QueryError
from datahub_query_service.models import ConnectionList


class PlatformInstance(BaseModel):
    urn: str
    instance_id: str | None = Field(default=None, alias="instanceId")


class Platform(BaseModel):
    name: str


class DatasetMetadata(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: str
    platform: Platform
    platform_instance: PlatformInstance | None = Field(
        default=None, alias="dataPlatformInstance"
    )


class MetadataData(BaseModel):
    dataset: DatasetMetadata | None


class MetadataResponse(BaseModel):
    data: MetadataData | None = None
    errors: list[object] = Field(default_factory=list)


class ConnectionRegistry:
    def __init__(self, config: ServiceConfig, client: httpx.AsyncClient) -> None:
        self.config = config
        self.client = client

    async def list_for(
        self, user: AuthenticatedUser, dataset_urn: str | None
    ) -> ConnectionList:
        connections = [
            item for item in self.config.connections if item.permits(user.actor_urn)
        ]
        default = None
        if dataset_urn:
            default = await self.resolve_default(connections, user, dataset_urn)
        return ConnectionList(
            connections=[item.summary() for item in connections],
            defaultConnectionId=default,
            maxRows=self.config.max_rows,
        )

    async def resolve_default(
        self,
        connections: list[ConnectionConfig],
        user: AuthenticatedUser,
        dataset_urn: str,
    ) -> str | None:
        prefix = "urn:li:dataset:(urn:li:dataPlatform:"
        if not dataset_urn.startswith(prefix) or not dataset_urn.endswith(")"):
            raise QueryError(
                400, "INVALID_DATASET_URN", "The dataset identifier is invalid."
            )
        parts = dataset_urn[len(prefix) : -1].split(",")
        if len(parts) != 3:
            raise QueryError(
                400, "INVALID_DATASET_URN", "The dataset identifier is invalid."
            )
        platform_name, dataset_name, environment = parts
        headers = {"X-DataHub-Actor": user.actor_urn}
        if user.authorization:
            headers["Authorization"] = user.authorization
        try:
            response = await self.client.post(
                self.config.datahub_graphql_url,
                headers=headers,
                json={
                    "query": "query QueryConnectionDataset($urn: String!) { dataset(urn: $urn) { name platform { name } dataPlatformInstance { urn instanceId } } }",
                    "variables": {"urn": dataset_urn},
                },
            )
            response.raise_for_status()
            metadata = MetadataResponse.model_validate(response.json())
        except (httpx.HTTPError, ValueError, ValidationError):
            # Connection selection remains usable when metadata lookup is unavailable.
            return None
        if metadata.errors or metadata.data is None or metadata.data.dataset is None:
            return None
        exact = [item.id for item in connections if dataset_urn in item.dataset_urns]
        if exact:
            return exact[0] if len(exact) == 1 else None
        dataset = metadata.data.dataset
        instance = dataset.platform_instance.urn if dataset.platform_instance else None
        instance_id = (
            dataset.platform_instance.instance_id if dataset.platform_instance else None
        )
        if instance_id and dataset_name.startswith(instance_id + "."):
            dataset_name = dataset_name[len(instance_id) + 1 :]
        matches = [
            item.id
            for item in connections
            if item.platform == platform_name == dataset.platform.name
            and item.environment == environment
            and item.platform_instance_urn == instance
            and dataset_name.startswith(item.database + ".")
        ]
        return matches[0] if len(matches) == 1 else None
