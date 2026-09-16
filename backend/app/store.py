import hashlib
import secrets
from datetime import datetime, timezone
from typing import Protocol
from uuid import uuid4

from bson import ObjectId
from pymongo import ASCENDING, DESCENDING, AsyncMongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError
from pymongo.server_api import ServerApi

from .config import Settings
from .models import ChatMessage, IncomingMessage, Member, MessagePage, Profile, Room, RoomSession


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class ChatStore(Protocol):
    async def initialize(self) -> None: ...
    async def close(self) -> None: ...
    async def ping(self) -> None: ...
    async def create_room(self, title: str, name: str) -> RoomSession: ...
    async def get_room(self, room_id: str) -> Room | None: ...
    async def room_by_code(self, code: str) -> Room | None: ...
    async def update_room(self, room_id: str, changes: dict) -> Room: ...
    async def add_member(self, room: Room, name: str) -> RoomSession: ...
    async def authenticate(self, room_id: str, token: str) -> Member | None: ...
    async def get_member(self, room_id: str, member_id: str) -> Member | None: ...
    async def list_members(self, room_id: str) -> list[Member]: ...
    async def update_member(self, room_id: str, member_id: str, changes: dict) -> None: ...
    async def delete_room(self, room_id: str) -> None: ...
    async def delete_messages(self, room_id: str, message_id: str | None = None) -> int: ...
    async def list_messages(
        self, room_id: str, before: str | None = None, limit: int = 50
    ) -> MessagePage: ...
    async def save_message(
        self, room_id: str, sender: Profile, message: IncomingMessage
    ) -> ChatMessage | None: ...


class MongoChatStore:
    def __init__(self, settings: Settings):
        self.client = AsyncMongoClient(
            settings.mongodb_uri, serverSelectionTimeoutMS=5000,
            connectTimeoutMS=5000, tz_aware=True, server_api=ServerApi("1"),
        )
        self.db = self.client[settings.mongodb_database]
        # Separate collections preserve data from the earlier public-channel application.
        self.rooms = self.db.meetings
        self.members = self.db.meeting_members
        self.messages = self.db.meeting_messages

    async def initialize(self) -> None:
        await self.ping()
        await self.rooms.create_index("code", unique=True)
        await self.members.create_index([("room_id", ASCENDING), ("token_hash", ASCENDING)], unique=True)
        await self.messages.create_index([("room_id", ASCENDING), ("_id", DESCENDING)])
        await self.messages.create_index(
            [("room_id", ASCENDING), ("sender.id", ASCENDING), ("client_message_id", ASCENDING)],
            unique=True,
        )
        # Finish a deletion interrupted by a database outage or process restart.
        async for room in self.rooms.find({"status": "deleted"}):
            await self.delete_room(room["_id"])

    async def close(self) -> None:
        await self.client.close()

    async def ping(self) -> None:
        await self.client.admin.command("ping")

    @staticmethod
    def room_model(doc: dict) -> Room:
        return Room(id=doc["_id"], **{key: value for key, value in doc.items() if key != "_id"})

    @staticmethod
    def member_model(doc: dict) -> Member:
        # Explicit allowlist: never serialize session hashes or revocation metadata.
        return Member(id=doc["_id"], name=doc["name"], muted=doc["muted"], joined_at=doc["joined_at"])

    @staticmethod
    def message_model(doc: dict) -> ChatMessage:
        return ChatMessage(id=str(doc["_id"]), **{key: value for key, value in doc.items() if key != "_id"})

    async def create_room(self, title: str, name: str) -> RoomSession:
        member_id = str(uuid4())
        while True:
            raw = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
            room = Room(id=str(uuid4()), code=raw[:4] + "-" + raw[4:], title=title,
                        host_id=member_id, created_at=datetime.now(timezone.utc))
            try:
                await self.rooms.insert_one({"_id": room.id, **room.model_dump(exclude={"id"})})
                break
            except DuplicateKeyError:
                continue
        try:
            return await self._insert_member(room, name, member_id)
        except Exception:
            await self.delete_room(room.id)
            raise

    async def _insert_member(self, room: Room, name: str, member_id: str) -> RoomSession:
        token = secrets.token_urlsafe(32)
        member = Member(id=member_id, name=name, joined_at=datetime.now(timezone.utc))
        await self.members.insert_one({
            "_id": member.id, "room_id": room.id, "token_hash": token_hash(token), "revoked": False,
            **member.model_dump(exclude={"id", "online"}),
        })
        return RoomSession(token=token, room=room, member=member)

    async def add_member(self, room: Room, name: str) -> RoomSession:
        return await self._insert_member(room, name, str(uuid4()))

    async def get_room(self, room_id: str) -> Room | None:
        doc = await self.rooms.find_one({"_id": room_id})
        return self.room_model(doc) if doc else None

    async def room_by_code(self, code: str) -> Room | None:
        doc = await self.rooms.find_one({"code": code, "status": {"$ne": "deleted"}})
        return self.room_model(doc) if doc else None

    async def update_room(self, room_id: str, changes: dict) -> Room:
        doc = await self.rooms.find_one_and_update(
            {"_id": room_id}, {"$set": changes}, return_document=ReturnDocument.AFTER,
        )
        return self.room_model(doc)

    async def authenticate(self, room_id: str, token: str) -> Member | None:
        doc = await self.members.find_one({
            "room_id": room_id, "token_hash": token_hash(token), "revoked": False,
        })
        return self.member_model(doc) if doc else None

    async def get_member(self, room_id: str, member_id: str) -> Member | None:
        doc = await self.members.find_one({"_id": member_id, "room_id": room_id, "revoked": False})
        return self.member_model(doc) if doc else None

    async def list_members(self, room_id: str) -> list[Member]:
        return [self.member_model(doc) async for doc in
                self.members.find({"room_id": room_id, "revoked": False}).sort("joined_at", ASCENDING)]

    async def update_member(self, room_id: str, member_id: str, changes: dict) -> None:
        await self.members.update_one({"_id": member_id, "room_id": room_id}, {"$set": changes})

    async def delete_room(self, room_id: str) -> None:
        # Block access first. A restart retries cleanup if subsequent writes fail.
        await self.rooms.update_one({"_id": room_id}, {"$set": {"status": "deleted"}})
        await self.messages.delete_many({"room_id": room_id})
        await self.members.delete_many({"room_id": room_id})
        await self.rooms.delete_one({"_id": room_id})

    async def delete_messages(self, room_id: str, message_id: str | None = None) -> int:
        query: dict = {"room_id": room_id, "deleted": {"$ne": True}}
        if message_id:
            query["_id"] = ObjectId(message_id)
        # Keep only deduplication receipts: a retried send must not resurrect deleted content.
        result = await self.messages.update_many(query, {"$set": {"deleted": True}, "$unset": {"content": ""}})
        return result.modified_count

    async def list_messages(
        self, room_id: str, before: str | None = None, limit: int = 50
    ) -> MessagePage:
        query: dict = {"room_id": room_id, "deleted": {"$ne": True}}
        if before:
            query["_id"] = {"$lt": ObjectId(before)}
        docs = await self.messages.find(query).sort("_id", DESCENDING).limit(limit + 1).to_list(limit + 1)
        return MessagePage(messages=[self.message_model(doc) for doc in reversed(docs[:limit])],
                           has_more=len(docs) > limit)

    async def save_message(
        self, room_id: str, sender: Profile, message: IncomingMessage
    ) -> ChatMessage | None:
        doc = {
            "_id": ObjectId(), "room_id": room_id, "sender": sender.model_dump(),
            "content": message.content, "kind": message.kind,
            "created_at": datetime.now(timezone.utc),
            "client_message_id": str(message.client_message_id), "deleted": False,
        }
        try:
            await self.messages.insert_one(doc)
        except DuplicateKeyError:
            doc = await self.messages.find_one({"room_id": room_id, "sender.id": sender.id,
                                               "client_message_id": str(message.client_message_id)})
        return None if doc.get("deleted") else self.message_model(doc)
