"""Application settings loaded from environment variables."""

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    app_env: str = Field(default="development", alias="APP_ENV")
    dev_mode: bool = Field(default=True, alias="DEV_MODE")
    # Comma-separated string in .env (e.g. http://localhost:5173,http://127.0.0.1:5173)
    cors_origins_raw: str = Field(
        default="http://localhost:5173,http://127.0.0.1:5173",
        alias="CORS_ORIGINS",
    )
    host: str = Field(default="0.0.0.0", alias="HOST")
    port: int = Field(default=8000, alias="PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    # Module 2 — Ollama (localhost only)
    ollama_base_url: str = Field(default="http://127.0.0.1:11434", alias="OLLAMA_BASE_URL")
    ollama_preferred_model: str = Field(default="qwen3:1.7b", alias="OLLAMA_PREFERRED_MODEL")
    ollama_fallback_model: str = Field(default="qwen3:0.6b", alias="OLLAMA_FALLBACK_MODEL")
    ollama_num_ctx: int = Field(default=2048, alias="OLLAMA_NUM_CTX")
    # ~3 spoken sentences; every extra token is CPU time before RA-ONE can speak
    ollama_max_output_tokens: int = Field(default=90, alias="OLLAMA_MAX_OUTPUT_TOKENS")
    # How long Ollama keeps the model in RAM after a reply; a cold reload costs ~1 minute
    ollama_keep_alive: str = Field(default="2h", alias="OLLAMA_KEEP_ALIVE")
    # Ask the LLM to classify unclear utterances before answering. Off: that second LLM
    # round-trip doubled reply time, and the answer call handles open-ended talk anyway.
    intent_use_llm: bool = Field(default=False, alias="INTENT_USE_LLM")
    ollama_num_thread: int = Field(default=4, alias="OLLAMA_NUM_THREAD")
    ollama_timeout_sec: float = Field(default=90.0, alias="OLLAMA_TIMEOUT_SEC")
    # Install Ollama silently (winget / official installer) and start it if missing — Windows only
    ollama_auto_install: bool = Field(default=True, alias="OLLAMA_AUTO_INSTALL")
    # Download the preferred model (qwen3:1.7b, ~1.4 GB) in the background when it is missing
    ollama_auto_pull: bool = Field(default=True, alias="OLLAMA_AUTO_PULL")
    # Weather / news / facts from the internet for questions the local model can't know
    web_lookup_enabled: bool = Field(default=True, alias="WEB_LOOKUP_ENABLED")

    @field_validator("cors_origins_raw", mode="before")
    @classmethod
    def coerce_origins(cls, value: object) -> str:
        if isinstance(value, (list, tuple)):
            return ",".join(str(v).strip() for v in value if str(v).strip())
        return str(value) if value is not None else ""

    @property
    def cors_origins(self) -> list[str]:
        return [part.strip() for part in self.cors_origins_raw.split(",") if part.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"

    @property
    def state_mutation_allowed(self) -> bool:
        """POST /api/assistant/state is development-only."""
        if self.is_production:
            return False
        return self.dev_mode


@lru_cache
def get_settings() -> Settings:
    return Settings()
