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

    # -------------------------------------------------------------------------
    # Vault Git sync
    # -------------------------------------------------------------------------
    # ``VAULT_GITHUB_*`` is kept for backwards compatibility.  New
    # installations should use the provider-neutral ``VAULT_GIT_*`` settings
    # below; this makes Bitbucket (and other Git hosts) configurable without
    # changing the vault implementation.
    VAULT_GIT_PROVIDER: str = "github"
    VAULT_GIT_URL: str = ""
    VAULT_GIT_BRANCH: str = ""
    # Supported values: "auto" | "http" | "ssh" | "none"
    VAULT_GIT_AUTH_METHOD: str = "auto"
    VAULT_GIT_HTTP_USERNAME: str = ""
    VAULT_GIT_HTTP_ACCESS_TOKEN: str = ""
    # Alias kept for deployments that prefer the shorter name.
    VAULT_GIT_HTTP_TOKEN: str = ""
    VAULT_GIT_SSH_KEY_PATH: str = ""
    # Inline keys are supported for secret managers that inject multiline
    # values. A mounted file via VAULT_GIT_SSH_KEY_PATH is preferred.
    VAULT_GIT_SSH_KEY: str = ""
    VAULT_GIT_SSH_KNOWN_HOSTS_PATH: str = ""

    # Legacy GitHub-only settings.
    VAULT_GITHUB_URL: str = ""
    VAULT_GITHUB_PAT: str = ""

    @property
    def vault_git_url(self) -> str:
        """Return the configured Git URL, including the legacy fallback."""
        return self.VAULT_GIT_URL or self.VAULT_GITHUB_URL

    # -------------------------------------------------------------------------
    # LLM provider selection
    # -------------------------------------------------------------------------
    # Supported values: "openrouter" | "gcp"
    LLM_PROVIDER: str = "openrouter"

    DEFAULT_MODEL: str = "anthropic/claude-sonnet-4-5"
    EMBEDDING_MODEL: str = "openai/text-embedding-3-small"

    # -------------------------------------------------------------------------
    # OpenRouter settings  (LLM_PROVIDER=openrouter)
    # -------------------------------------------------------------------------
    OPENROUTER_API_KEY: str = ""
    # Optional: pin upstream provider (e.g. "anthropic"), empty = let OpenRouter choose
    OPENROUTER_CHAT_PROVIDER: str = ""
    OPENROUTER_EMBEDDING_PROVIDER: str = ""

    # -------------------------------------------------------------------------
    # GCP / Google AI settings  (LLM_PROVIDER=gcp)
    # -------------------------------------------------------------------------
    GCP_API_KEY: str = ""
    # OpenAI-compatible base URL; default = Google AI (Gemini) compat endpoint
    GCP_ENDPOINT_URL: str = "https://generativelanguage.googleapis.com/v1beta/openai"

    @property
    def llm_api_key(self) -> str:
        """Return the API key of the active LLM provider."""
        if self.LLM_PROVIDER == "gcp":
            return self.GCP_API_KEY
        return self.OPENROUTER_API_KEY

    OTEL_ENABLED: bool = False
    OTEL_EXPORTER_OTLP_ENDPOINT: str = "http://jaeger:4317"

    model_config = SettingsConfigDict(
        env_file=[".env", "../.env"], env_file_encoding="utf-8", extra="ignore"
    )

settings = Settings()
