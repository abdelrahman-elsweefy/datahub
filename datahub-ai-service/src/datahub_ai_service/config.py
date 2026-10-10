import os
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, SecretStr
from pydantic.alias_generators import to_camel


class ServiceConfig(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid"
    )

    database_path: Path = Path("/var/lib/datahub-ai/conversations.sqlite")
    model: str = ""
    model_api_key_file: Path | None = None
    datahub_graphql_url: str = "http://datahub-gms:8080/api/graphql"
    timeout_seconds: int = Field(default=120, ge=1, le=180)
    max_context_characters: int = Field(default=64000, ge=16000, le=128000)
    max_concurrent_requests: int = Field(default=10, ge=1, le=50)
    proxy_secret: SecretStr = Field(default=SecretStr(""), exclude=True)

    @classmethod
    def load(cls) -> "ServiceConfig":
        path = os.environ.get(
            "DATAHUB_AI_SERVICE_CONFIG", "/etc/datahub-ai-service/config.json"
        )
        try:
            settings = cls.model_validate_json(Path(path).read_text())
        except (OSError, ValueError):
            raise RuntimeError("Unable to load AI service configuration") from None
        secret = os.environ.get("DATAHUB_AI_SERVICE_PROXY_SECRET", "")
        if len(secret) < 32:
            raise RuntimeError(
                "An AI proxy secret of at least 32 characters is required"
            )
        settings.proxy_secret = SecretStr(secret)
        return settings
