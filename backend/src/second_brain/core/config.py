from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Shared credentials and provider settings for the managed wiki.

    Index endpoints and enablement are read by wiki.index_config without
    implicit localhost defaults; Git settings remain compatible with existing
    operator configuration.
    """

    MCP_API_KEY: str = ""

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

    model_config = SettingsConfigDict(
        env_file=[".env", "../.env"], env_file_encoding="utf-8", extra="ignore"
    )

settings = Settings()
