import asyncio
import time
from collections import defaultdict, deque
from dataclasses import dataclass

from fastapi import HTTPException, WebSocket


@dataclass
class Connection:
    socket: WebSocket
    member_id: str


class RateLimiter:
    """Single-process sliding windows. Keys expire rather than growing indefinitely."""

    def __init__(self):
        self.windows: dict[str, deque] = {}

    def check(self, key: str, limit: int, seconds: int = 60) -> None:
        now = time.monotonic()
        for expired in [key for key, values in self.windows.items() if values[-1] <= now - 60]:
            del self.windows[expired]
        window = self.windows.setdefault(key, deque())
        while window and window[0] <= now - seconds:
            window.popleft()
        if len(window) >= limit:
            raise HTTPException(429, "Too many requests. Wait a moment and try again.")
        window.append(now)


class ConnectionManager:
    """Run exactly one worker/instance; room actions and message delivery share these locks."""

    def __init__(self):
        self.rooms: dict[str, list[Connection]] = defaultdict(list)
        self.locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def online_ids(self, room_id: str) -> set[str]:
        return {peer.member_id for peer in self.rooms[room_id]}

    def remove(self, room_id: str, socket: WebSocket) -> bool:
        before = len(self.rooms[room_id])
        self.rooms[room_id] = [peer for peer in self.rooms[room_id] if peer.socket is not socket]
        return before != len(self.rooms[room_id])

    async def broadcast(self, room_id: str, payload: dict, exclude: WebSocket | None = None) -> None:
        peers = [peer for peer in self.rooms[room_id] if peer.socket is not exclude]

        async def send(peer: Connection):
            await asyncio.wait_for(peer.socket.send_json(payload), timeout=5)

        results = await asyncio.gather(*(send(peer) for peer in peers), return_exceptions=True)
        for peer, result in zip(peers, results):
            if isinstance(result, BaseException):
                self.remove(room_id, peer.socket)

    async def evict(self, room_id: str, reason: str, member_id: str | None = None) -> None:
        peers = [peer for peer in self.rooms[room_id] if member_id is None or peer.member_id == member_id]
        for peer in peers:
            self.remove(room_id, peer.socket)
            try:
                await asyncio.wait_for(peer.socket.send_json({"type": "access_revoked", "message": reason}), 5)
                await asyncio.wait_for(peer.socket.close(code=4403, reason=reason), 5)
            except (Exception, asyncio.CancelledError):
                pass
