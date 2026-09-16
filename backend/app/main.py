import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from uuid import UUID

from anyio import CancelScope
from bson import ObjectId
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from pymongo.errors import PyMongoError

from .config import get_settings
from .models import (
    IncomingMessage,
    MemberAction,
    MessagePage,
    Profile,
    RoomAction,
    RoomCreate,
    RoomJoin,
    RoomSession,
    RoomState,
    SessionState,
    SocketSession,
    TypingEvent,
)
from .realtime import Connection, ConnectionManager, RateLimiter
from .store import ChatStore, MongoChatStore

logger = logging.getLogger("gather")


def bearer(request: Request) -> str:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not 40 <= len(token) <= 128:
        raise HTTPException(401, "A valid room session is required.")
    return token


async def authorize(db: ChatStore, room_id: str, token: str, host: bool = False):
    room = await db.get_room(room_id)
    if room is None or room.status == "deleted":
        raise HTTPException(404, "This room has been deleted or does not exist.")
    member = await db.authenticate(room_id, token)
    if member is None:
        raise HTTPException(401, "Your room session is no longer valid. You may have been removed.")
    if host and room.host_id != member.id:
        raise HTTPException(403, "Only the host can do that.")
    return room, member


def create_app(store: ChatStore | None = None) -> FastAPI:
    settings = get_settings()
    manager = ConnectionManager()
    limiter = RateLimiter()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = store if store is not None else MongoChatStore(settings)
        try:
            await app.state.store.initialize()
            yield
        finally:
            await app.state.store.close()

    app = FastAPI(title="Gather Meeting API", version="2.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type", "Authorization"],
    )

    @app.middleware("http")
    async def private_responses(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(PyMongoError)
    async def database_error(request: Request, exc: PyMongoError):
        logger.error("MongoDB request failed", exc_info=exc)
        return JSONResponse(status_code=503, content={"detail": "The database is unavailable. Please try again."})

    async def state(db: ChatStore, room) -> RoomState:
        members = await db.list_members(room.id)
        online = manager.online_ids(room.id)
        return RoomState(room=room, members=[member.model_copy(update={"online": member.id in online}) for member in members])

    async def publish(db: ChatStore, room) -> RoomState:
        current = await state(db, room)
        await manager.broadcast(room.id, {"type": "state", **current.model_dump(mode="json")})
        return current

    def limit_request(request: Request, kind: str, limit: int):
        ip = request.client.host if request.client else "unknown"
        limiter.check(f"{kind}:{ip}", limit)

    @app.get("/api/health")
    async def health(request: Request):
        await request.app.state.store.ping()
        return {"status": "ok", "database": "connected"}

    @app.post("/api/rooms", response_model=RoomSession, status_code=201)
    async def create_room(data: RoomCreate, request: Request):
        limit_request(request, "create", settings.create_limit_per_minute)
        return await request.app.state.store.create_room(data.title, data.name)

    @app.post("/api/rooms/join", response_model=RoomSession, status_code=201)
    async def join_room(data: RoomJoin, request: Request):
        limit_request(request, "join", settings.join_limit_per_minute)
        db = request.app.state.store
        found = await db.room_by_code(data.code)
        if found is None:
            raise HTTPException(404, "No room matches that code. Check it and try again.")
        async with manager.locks[found.id]:
            room = await db.get_room(found.id)
            if room is None or room.status != "active":
                raise HTTPException(410, "This meeting has ended. New participants cannot join.")
            if room.locked:
                raise HTTPException(423, "The host has locked this room. Ask them to unlock it.")
            if len(await db.list_members(room.id)) >= settings.room_capacity:
                raise HTTPException(409, "This room has reached its participant limit.")
            session = await db.add_member(room, data.name)
            await publish(db, room)
            return session

    @app.get("/api/rooms/{room_id}/session", response_model=SessionState)
    async def get_session(room_id: UUID, request: Request):
        key = str(room_id)
        async with manager.locks[key]:
            room, member = await authorize(request.app.state.store, key, bearer(request))
            current = await state(request.app.state.store, room)
            return SessionState(member=member, **current.model_dump())

    @app.get("/api/rooms/{room_id}/messages", response_model=MessagePage)
    async def messages(room_id: UUID, request: Request, before: str | None = None,
                       limit: int = Query(default=50, ge=1, le=100)):
        key = str(room_id)
        async with manager.locks[key]:
            await authorize(request.app.state.store, key, bearer(request))
            if before is not None and not ObjectId.is_valid(before):
                raise HTTPException(422, "Invalid message cursor.")
            return await request.app.state.store.list_messages(key, before, limit)

    @app.post("/api/rooms/{room_id}/actions", response_model=RoomState)
    async def room_action(room_id: UUID, data: RoomAction, request: Request):
        key, db = str(room_id), request.app.state.store
        async with manager.locks[key]:
            room, _ = await authorize(db, key, bearer(request), host=True)
            if room.status != "active":
                raise HTTPException(409, "This meeting has already ended.")
            if data.action == "transfer":
                target = await db.get_member(key, str(data.member_id)) if data.member_id else None
                if target is None or target.id == room.host_id or target.id not in manager.online_ids(key):
                    raise HTTPException(409, "Choose another participant who is online.")
                await db.update_member(key, target.id, {"muted": False})
                room = await db.update_room(key, {"host_id": target.id})
            elif data.action == "end":
                room = await db.update_room(key, {"status": "ended", "locked": True,
                                                  "ended_at": datetime.now(timezone.utc)})
            else:
                room = await db.update_room(key, {"locked": data.action == "lock"})
            return await publish(db, room)

    @app.post("/api/rooms/{room_id}/members/{member_id}/actions", response_model=RoomState)
    async def member_action(room_id: UUID, member_id: UUID, data: MemberAction, request: Request):
        key, target_id, db = str(room_id), str(member_id), request.app.state.store
        async with manager.locks[key]:
            room, _ = await authorize(db, key, bearer(request), host=True)
            target = await db.get_member(key, target_id)
            if target is None:
                raise HTTPException(404, "Participant not found.")
            if target_id == room.host_id:
                raise HTTPException(409, "Transfer the host role before changing your own access.")
            if data.action == "remove":
                await db.update_member(key, target_id, {"revoked": True})
                await manager.evict(key, "The host removed you from this room.", target_id)
            else:
                if room.status != "active":
                    raise HTTPException(409, "This meeting has already ended.")
                await db.update_member(key, target_id, {"muted": data.action == "mute"})
            return await publish(db, room)

    @app.delete("/api/rooms/{room_id}/messages")
    async def clear_messages(room_id: UUID, request: Request):
        key, db = str(room_id), request.app.state.store
        async with manager.locks[key]:
            await authorize(db, key, bearer(request), host=True)
            await db.delete_messages(key)
            await manager.broadcast(key, {"type": "messages_cleared"})
            return {"status": "cleared"}

    @app.delete("/api/rooms/{room_id}/messages/{message_id}")
    async def delete_message(room_id: UUID, message_id: str, request: Request):
        key, db = str(room_id), request.app.state.store
        async with manager.locks[key]:
            await authorize(db, key, bearer(request), host=True)
            if not ObjectId.is_valid(message_id):
                raise HTTPException(422, "Invalid message ID.")
            await db.delete_messages(key, message_id)
            await manager.broadcast(key, {"type": "message_deleted", "message_id": message_id})
            return {"status": "deleted"}

    @app.delete("/api/rooms/{room_id}")
    async def delete_room(room_id: UUID, request: Request):
        key, db = str(room_id), request.app.state.store
        async with manager.locks[key]:
            room, _ = await authorize(db, key, bearer(request), host=True)
            if room.status != "ended":
                raise HTTPException(409, "End the meeting before deleting its transcript.")
            await db.delete_room(key)
            await manager.evict(key, "The host permanently deleted this room and its transcript.")
            return {"status": "deleted"}

    @app.websocket("/api/ws/{room_id}")
    async def chat(socket: WebSocket, room_id: UUID):
        key, db = str(room_id), socket.app.state.store
        origin = socket.headers.get("origin")
        if origin is not None and origin not in settings.cors_origins:
            await socket.close(code=1008, reason="Origin not allowed.")
            return
        await socket.accept()
        token = ""
        last_typing = 0.0
        try:
            # Send secrets in the first frame, never in URLs or access logs.
            raw = await asyncio.wait_for(socket.receive_text(), timeout=10)
            if len(raw) > 512:
                raise ValueError("Invalid session frame.")
            token = SocketSession.model_validate_json(raw).token
            async with manager.locks[key]:
                room, member = await authorize(db, key, token)
                manager.rooms[key].append(Connection(socket, member.id))
                current = await state(db, room)
                page = await db.list_messages(key)
                await socket.send_json({"type": "snapshot", "member": member.model_dump(mode="json"),
                                        **current.model_dump(mode="json"), **page.model_dump(mode="json")})
                await publish(db, room)

            while True:
                try:
                    raw = await socket.receive_text()
                    if len(raw) > 100000:
                        raise ValueError("Message too large.")
                    payload = json.loads(raw)
                    if not isinstance(payload, dict):
                        raise TypeError("Expected an object.")
                    # Every write rechecks membership, mute status, and room state under the
                    # same lock as host actions. A stale socket cannot bypass moderation.
                    async with manager.locks[key]:
                        room, member = await authorize(db, key, token)
                        if payload.get("type") == "ping":
                            await socket.send_json({"type": "pong"})
                            continue
                        if room.status != "active":
                            raise HTTPException(409, "This meeting has ended. The transcript is read-only.")
                        if member.muted:
                            raise HTTPException(403, "The host has muted you. You can still read messages.")
                        if payload.get("type") == "typing":
                            event = TypingEvent.model_validate(payload)
                            now = time.monotonic()
                            if now - last_typing >= 0.5:
                                last_typing = now
                                await manager.broadcast(key, {"type": "typing", "user": {"id": member.id, "name": member.name},
                                                               "is_typing": event.is_typing}, exclude=socket)
                            continue
                        message = IncomingMessage.model_validate(payload)
                        limiter.check(f"message:{member.id}", settings.message_limit_per_minute)
                        saved = await db.save_message(key, Profile(id=member.id, name=member.name), message)
                        if saved is not None:
                            await manager.broadcast(key, {"type": "message", "message": saved.model_dump(mode="json")})
                        else:
                            await socket.send_json({"type": "message_ack", "client_message_id": str(message.client_message_id)})
                except (ValidationError, ValueError, TypeError, KeyError):
                    await socket.send_json({"type": "error", "message": "Send valid text or code between 1 and 20,000 characters."})
                except HTTPException as exc:
                    if exc.status_code in (401, 404):
                        await socket.close(code=4403, reason="Your room access is no longer available.")
                        return
                    await socket.send_json({"type": "error", "message": exc.detail})
                except PyMongoError:
                    logger.exception("Message could not be saved")
                    await socket.send_json({"type": "error", "message": "Your message could not be saved. Please retry."})
        except WebSocketDisconnect:
            pass
        except (ValidationError, ValueError, asyncio.TimeoutError, HTTPException) as exc:
            reason = exc.detail if isinstance(exc, HTTPException) else "A valid room session is required."
            await socket.close(code=4401, reason=reason)
        except PyMongoError:
            await socket.close(code=1011, reason="Database unavailable. Please reconnect.")
        finally:
            with CancelScope(shield=True):
                async with manager.locks[key]:
                    if manager.remove(key, socket):
                        try:
                            room = await db.get_room(key)
                            if room is not None and room.status != "deleted":
                                await publish(db, room)
                        except PyMongoError:
                            logger.exception("Presence cleanup could not reach the database")

    return app


app = create_app()
