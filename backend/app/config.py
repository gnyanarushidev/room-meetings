from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_database: str = "gather_chat"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    room_capacity: int = Field(default=100, ge=2, le=500)
    create_limit_per_minute: int = Field(default=10, ge=1)
    join_limit_per_minute: int = Field(default=30, ge=1)
    message_limit_per_minute: int = Field(default=120, ge=1)

    model_config = SettingsConfigDict(
        # Local overrides work even when .env is absent. Process variables still win.
        env_file=(BACKEND_DIR / ".env", BACKEND_DIR / ".env.local"),

        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
