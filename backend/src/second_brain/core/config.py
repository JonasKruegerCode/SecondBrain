from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    PROJECT_NAME: str = "SecondBrain"
    MCP_API_KEY: str = ""
    MCP_PORT: int = 3000
    API_PORT: int = 8000

    REDIS_URL: str = "redis://localhost:6379/0"

    NEO4J_URI: str = "bolt://localhost:7687"
    NEO4J_USER: str = "neo4j"
    NEO4J_PASSWORD: str = "secretpassword"

    QDRANT_URL: str = "http://localhost:6333"

    VAULT_PATH: str = "/vault"
    VAULT_GITHUB_URL: str = ""
    VAULT_GITHUB_PAT: str = ""

    OPENROUTER_API_KEY: str = ""
    DEFAULT_MODEL: str = "anthropic/claude-sonnet-4-5"
    EMBEDDING_MODEL: str = "openai/text-embedding-3-small"

    OTEL_ENABLED: bool = False
    OTEL_EXPORTER_OTLP_ENDPOINT: str = "http://jaeger:4317"

    model_config = SettingsConfigDict(
        env_file=[".env", "../.env"], env_file_encoding="utf-8", extra="ignore"
    )

settings = Settings()
