import os

from app.config import Settings


def test_local_env_without_base_file_and_override_precedence(tmp_path, monkeypatch):
    for key in list(os.environ):
        if key.lower() in {"mongodb_uri", "mongodb_database"}:
            monkeypatch.delenv(key)

    # Use the production loader's file order, in an isolated directory.
    env_files = tuple(tmp_path / path.name for path in Settings.model_config["env_file"])
    local = tmp_path / ".env.local"
    local.write_text(
        "MONGODB_URI=mongodb+srv://example.mongodb.net\nMONGODB_DATABASE=local_override\n",
        encoding="utf-8",
    )
    settings = Settings(_env_file=env_files)
    assert settings.mongodb_database == "local_override"
    assert settings.mongodb_uri == "mongodb+srv://example.mongodb.net"

    (tmp_path / ".env").write_text("MONGODB_DATABASE=base_database\n", encoding="utf-8")
    assert Settings(_env_file=env_files).mongodb_database == "local_override"

    monkeypatch.setenv("MONGODB_DATABASE", "deployment_database")
    assert Settings(_env_file=env_files).mongodb_database == "deployment_database"
