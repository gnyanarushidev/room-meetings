import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pymongo import MongoClient

from app.config import Settings
from app.main import create_app
from app.store import MongoChatStore

from .test_chat import action, connection, create, headers, join, receive, send, url


@pytest.mark.skipif(not os.getenv("MONGODB_TEST_URI"), reason="Set MONGODB_TEST_URI for real MongoDB integration")
def test_mongodb_sessions_transcripts_and_moderation_survive_restart():
    settings = Settings(mongodb_uri=os.environ["MONGODB_TEST_URI"], mongodb_database=f"gather_test_{uuid4().hex}")
    message_id = uuid4()
    try:
        with TestClient(create_app(MongoChatStore(settings))) as client:
            host = create(client)
            guest = join(client, host)
            with connection(client, guest) as (socket, _):
                send(socket, "Persistent text", message_id)
                first = receive(socket, "message")["message"]
                send(socket, "Persistent text", message_id)
                assert receive(socket, "message")["message"]["id"] == first["id"]
                for index in range(54):
                    send(socket, f"Saved {index}")
                    receive(socket, "message")
            assert action(client, host, "end").status_code == 200

        with TestClient(create_app(MongoChatStore(settings))) as client:
            # The original private session works after a completely new application starts.
            with connection(client, guest) as (_, snapshot):
                assert snapshot["room"]["status"] == "ended"
                assert len(snapshot["messages"]) == 50 and snapshot["has_more"]
                cursor = snapshot["messages"][0]["id"]
                older = client.get(url(guest, f"/messages?before={cursor}"), headers=headers(guest)).json()
                assert len(older["messages"]) == 5
                assert older["messages"][0]["id"] == first["id"]
            assert client.delete(url(host, f'/messages/{first["id"]}'), headers=headers(host)).status_code == 200
            with MongoClient(settings.mongodb_uri) as mongo:
                db = mongo[settings.mongodb_database]
                assert db.meeting_members.count_documents({"token": {"$exists": True}}) == 0
                assert db.meeting_messages.find_one({"client_message_id": str(message_id)}).get("content") is None
            assert client.delete(url(host), headers=headers(host)).status_code == 200
            assert client.get(url(guest, "/messages"), headers=headers(guest)).status_code == 404
            with MongoClient(settings.mongodb_uri) as mongo:
                db = mongo[settings.mongodb_database]
                assert db.meetings.count_documents({}) == 0
                assert db.meeting_members.count_documents({}) == 0
                assert db.meeting_messages.count_documents({}) == 0
    finally:
        with MongoClient(settings.mongodb_uri) as mongo:
            mongo.drop_database(settings.mongodb_database)
