import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from bson import ObjectId
from fastapi.testclient import TestClient
from pymongo.errors import PyMongoError
from starlette.websockets import WebSocketDisconnect

from app.main import create_app
from app.models import ChatMessage, Member, MessagePage, Room, RoomSession
from app.store import token_hash


class MemoryStore:
    """Isolated test double. Production always uses MongoDB."""

    def __init__(self):
        self.rooms = {}
        self.members = {}
        self.messages = []
        self.deleted = set()
        self.fail_writes = False

    async def initialize(self):
        pass

    async def close(self):
        pass

    async def ping(self):
        pass

    async def create_room(self, title, name):
        code = ''.join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
        room = Room(id=str(uuid4()), code=code[:4] + "-" + code[4:], title=title,
                    host_id=str(uuid4()), created_at=datetime.now(timezone.utc))
        self.rooms[room.id] = room
        return self.insert_member(room, name, room.host_id)

    def insert_member(self, room, name, member_id):
        token = secrets.token_urlsafe(32)
        member = Member(id=member_id, name=name, joined_at=datetime.now(timezone.utc))
        self.members[member_id] = {"room_id": room.id, "hash": token_hash(token), "member": member, "revoked": False}
        return RoomSession(token=token, room=room, member=member)

    async def add_member(self, room, name):
        return self.insert_member(room, name, str(uuid4()))

    async def get_room(self, room_id):
        return self.rooms.get(room_id)

    async def room_by_code(self, code):
        return next((room for room in self.rooms.values() if room.code == code), None)

    async def update_room(self, room_id, changes):
        self.rooms[room_id] = self.rooms[room_id].model_copy(update=changes)
        return self.rooms[room_id]

    async def authenticate(self, room_id, token):
        return next((entry["member"] for entry in self.members.values()
                     if entry["room_id"] == room_id and entry["hash"] == token_hash(token) and not entry["revoked"]), None)

    async def get_member(self, room_id, member_id):
        entry = self.members.get(member_id)
        return entry["member"] if entry and entry["room_id"] == room_id and not entry["revoked"] else None

    async def list_members(self, room_id):
        return [entry["member"] for entry in self.members.values() if entry["room_id"] == room_id and not entry["revoked"]]

    async def update_member(self, room_id, member_id, changes):
        entry = self.members[member_id]
        assert entry["room_id"] == room_id
        entry["revoked"] = changes.get("revoked", entry["revoked"])
        entry["member"] = entry["member"].model_copy(update={key: value for key, value in changes.items() if key != "revoked"})

    async def delete_room(self, room_id):
        self.rooms.pop(room_id, None)
        self.members = {key: entry for key, entry in self.members.items() if entry["room_id"] != room_id}
        self.messages = [message for message in self.messages if message.room_id != room_id]

    async def list_messages(self, room_id, before=None, limit=50):
        items = [message for message in self.messages if message.room_id == room_id
                 and message.id not in self.deleted and (not before or message.id < before)]
        return MessagePage(messages=items[-limit:], has_more=len(items) > limit)

    async def delete_messages(self, room_id, message_id=None):
        ids = {message.id for message in self.messages if message.room_id == room_id and (not message_id or message.id == message_id)}
        self.deleted.update(ids)
        return len(ids)

    async def save_message(self, room_id, sender, message):
        if self.fail_writes:
            raise PyMongoError("Database unavailable")
        existing = next((item for item in self.messages if item.room_id == room_id
                         and item.sender.id == sender.id and item.client_message_id == message.client_message_id), None)
        if existing:
            return None if existing.id in self.deleted else existing
        saved = ChatMessage(id=str(ObjectId()), room_id=room_id, sender=sender, content=message.content,
                            kind=message.kind, client_message_id=message.client_message_id, created_at=datetime.now(timezone.utc))
        self.messages.append(saved)
        return saved


@pytest.fixture
def store():
    return MemoryStore()


@pytest.fixture
def client(store):
    with TestClient(create_app(store)) as client:
        yield client


def create(client, name="Alice", title="Team sync"):
    response = client.post("/api/rooms", json={"name": name, "title": title})
    assert response.status_code == 201, response.text
    return response.json()


def join(client, host, name="Bob"):
    response = client.post("/api/rooms/join", json={"code": host["room"]["code"].lower(), "name": name})
    assert response.status_code == 201, response.text
    return response.json()


def headers(session):
    return {"Authorization": "Bearer " + session["token"]}


def url(session, suffix=""):
    return f'/api/rooms/{session["room"]["id"]}{suffix}'


def receive(socket, event_type):
    for _ in range(100):
        event = socket.receive_json()
        if event["type"] == event_type:
            return event
    raise AssertionError(f"Did not receive {event_type}")


@contextmanager
def connection(client, session):
    with client.websocket_connect(f'/api/ws/{session["room"]["id"]}', headers={"origin": "http://localhost:5173"}) as socket:
        socket.send_json({"type": "session", "token": session["token"]})
        snapshot = receive(socket, "snapshot")
        receive(socket, "state")
        yield socket, snapshot


def send(socket, content, message_id=None, kind="text"):
    socket.send_json({"type": "message", "content": content, "kind": kind,
                      "client_message_id": str(message_id or uuid4())})


def action(client, session, action, **extra):
    return client.post(url(session, "/actions"), headers=headers(session), json={"action": action, **extra})


def member_action(client, host, guest, action):
    return client.post(url(host, f'/members/{guest["member"]["id"]}/actions'), headers=headers(host), json={"action": action})


def test_code_sessions_are_private_and_scoped(client):
    host = create(client)
    guest = join(client, host)
    other = create(client, title="Different meeting")
    assert len(host["room"]["code"]) == 9
    assert host["room"]["host_id"] == host["member"]["id"]
    assert guest["member"]["id"] != host["member"]["id"]
    assert client.get("/api/rooms").status_code == 405
    assert client.get(url(host, "/messages")).status_code == 401
    assert client.get(url(other, "/messages"), headers=headers(guest)).status_code == 401
    response = client.get(url(host, "/session"), headers=headers(guest))
    assert response.status_code == 200
    assert host["token"] not in response.text and "token_hash" not in response.text
    assert client.post("/api/rooms", json={"name": " ", "title": "test"}).status_code == 422
    assert client.post("/api/rooms/join", json={"name": "Bob", "code": "bad"}).status_code == 422
    assert client.post("/api/rooms/join", json={"name": "Bob", "code": "ZZZZ-ZZZZ"}).status_code == 404


def test_live_text_code_typing_and_room_isolation(client):
    host = create(client)
    guest = join(client, host)
    other = create(client, "Carol", "Separate room")
    with connection(client, host) as (alice, _), connection(client, guest) as (bob, snapshot), connection(client, other) as (carol, _):
        assert sum(member["online"] for member in snapshot["members"]) == 2
        bob.send_json({"type": "typing", "is_typing": True})
        assert receive(alice, "typing")["user"]["name"] == "Bob"
        content = "    print('Hello')\n\n"
        send(bob, content, kind="code")
        sent = receive(bob, "message")
        assert receive(alice, "message") == sent
        assert sent["message"]["content"] == content
        assert sent["message"]["kind"] == "code"
        send(carol, "Private to the other room")
        assert receive(carol, "message")["message"]["content"] == "Private to the other room"


def test_guests_cannot_execute_host_actions_or_forge_identity(client):
    host = create(client)
    guest = join(client, host)
    for name in ["lock", "unlock", "end", "transfer"]:
        assert action(client, guest, name, member_id=guest["member"]["id"]).status_code == 403
    assert member_action(client, guest, host, "remove").status_code == 403
    assert client.delete(url(guest, "/messages"), headers=headers(guest)).status_code == 403
    assert client.delete(url(guest), headers=headers(guest)).status_code == 403
    with connection(client, guest) as (socket, _):
        socket.send_json({"type": "message", "content": "fake host", "sender": host["member"], "client_message_id": str(uuid4())})
        assert receive(socket, "error")
        send(socket, "Actually Bob")
        assert receive(socket, "message")["message"]["sender"]["id"] == guest["member"]["id"]


def test_lock_mute_remove_and_revoked_reconnect(client):
    host = create(client)
    guest = join(client, host)
    assert action(client, host, "lock").status_code == 200
    assert client.post("/api/rooms/join", json={"code": host["room"]["code"], "name": "New guest"}).status_code == 423
    with connection(client, guest) as (socket, _):  # Existing sessions can reconnect to locked rooms.
        assert member_action(client, host, guest, "mute").status_code == 200
        send(socket, "Should be blocked")
        assert "muted" in receive(socket, "error")["message"]
        assert member_action(client, host, guest, "unmute").status_code == 200
        send(socket, "Allowed again")
        receive(socket, "message")
        assert member_action(client, host, guest, "remove").status_code == 200
        assert "removed" in receive(socket, "access_revoked")["message"]
    assert client.get(url(guest, "/messages"), headers=headers(guest)).status_code == 401
    with pytest.raises(WebSocketDisconnect):
        with connection(client, guest):
            pass
    assert action(client, host, "unlock").status_code == 200
    assert join(client, host, "New guest")


def test_transfer_immediately_changes_host_permissions(client):
    host = create(client)
    guest = join(client, host)
    assert action(client, host, "transfer", member_id=guest["member"]["id"]).status_code == 409
    with connection(client, guest):
        assert member_action(client, host, guest, "mute").status_code == 200
        result = action(client, host, "transfer", member_id=guest["member"]["id"])
        assert result.status_code == 200
        assert result.json()["room"]["host_id"] == guest["member"]["id"]
        assert next(member for member in result.json()["members"] if member["id"] == guest["member"]["id"])["muted"] is False
        assert action(client, host, "end").status_code == 403
        assert action(client, guest, "lock").status_code == 200


def test_end_keeps_private_transcript_until_host_deletes(client, store):
    host = create(client)
    guest = join(client, host)
    with connection(client, guest) as (socket, _):
        send(socket, "Keep this transcript")
        receive(socket, "message")
        assert client.delete(url(host), headers=headers(host)).status_code == 409
        assert action(client, host, "end").status_code == 200
        assert receive(socket, "state")["room"]["status"] == "ended"
        send(socket, "Too late")
        assert "read-only" in receive(socket, "error")["message"]
    assert client.post("/api/rooms/join", json={"code": host["room"]["code"], "name": "Late guest"}).status_code == 410
    with connection(client, guest) as (socket, snapshot):
        assert snapshot["room"]["status"] == "ended"
        assert snapshot["messages"][0]["content"] == "Keep this transcript"
        assert client.get(url(guest, "/messages"), headers=headers(guest)).status_code == 200
        assert client.delete(url(host), headers=headers(host)).status_code == 200
        assert "deleted" in receive(socket, "access_revoked")["message"]
    assert client.get(url(guest, "/messages"), headers=headers(guest)).status_code == 404
    assert not store.messages and not store.members and not store.rooms


def test_pagination_deletion_and_duplicate_safe_retries(client):
    host = create(client)
    message_id = uuid4()
    with connection(client, host) as (socket, _):
        send(socket, "first", message_id)
        first = receive(socket, "message")["message"]
        send(socket, "first", message_id)
        assert receive(socket, "message")["message"]["id"] == first["id"]
        for index in range(54):
            send(socket, f"Message {index}")
            receive(socket, "message")
        page = client.get(url(host, "/messages"), headers=headers(host)).json()
        assert len(page["messages"]) == 50 and page["has_more"]
        older = client.get(url(host, f'/messages?before={page["messages"][0]["id"]}'), headers=headers(host)).json()
        assert len(older["messages"]) == 5 and not older["has_more"]
        assert client.delete(url(host, f'/messages/{first["id"]}'), headers=headers(host)).status_code == 200
        receive(socket, "message_deleted")
        send(socket, "first", message_id)
        assert receive(socket, "message_ack")["client_message_id"] == str(message_id)
        assert client.delete(url(host, "/messages"), headers=headers(host)).status_code == 200
        receive(socket, "messages_cleared")
    assert client.get(url(host, "/messages"), headers=headers(host)).json()["messages"] == []
    assert client.get(url(host, "/messages?before=bad"), headers=headers(host)).status_code == 422


def test_bad_payloads_and_database_failure_never_broadcast(client, store):
    host = create(client)
    guest = join(client, host)
    with connection(client, host) as (alice, _), connection(client, guest) as (bob, _):
        for raw in ["not json", "[]", '{"type":"unknown"}']:
            bob.send_text(raw)
            receive(bob, "error")
        for content in ["  ", "x" * 20001]:
            send(bob, content)
            receive(bob, "error")
        store.fail_writes = True
        send(bob, "Not saved")
        receive(bob, "error")
        store.fail_writes = False
        send(bob, "Really saved")
        assert receive(alice, "message")["message"]["content"] == "Really saved"


def test_websocket_requires_origin_and_private_session(client):
    host = create(client)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f'/api/ws/{host["room"]["id"]}', headers={"origin": "https://untrusted.example"}):
            pass
    for token in ["bad", secrets.token_urlsafe(32)]:
        with pytest.raises(WebSocketDisconnect):
            with connection(client, {**host, "token": token}):
                pass


def test_create_rate_limit(client):
    for _ in range(10):
        create(client)
    assert client.post("/api/rooms", json={"name": "Alice", "title": "Too many"}).status_code == 429


def test_cross_origin_authorized_actions_and_private_response_headers(client):
    host = create(client)
    origin = "http://localhost:5173"
    for method in ["GET", "POST", "DELETE"]:
        response = client.options(url(host), headers={
            "Origin": origin, "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization,content-type",
        })
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == origin
    response = client.get(url(host, "/session"), headers={**headers(host), "Origin": origin})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["cache-control"] == "no-store"
