import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class NameInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=2, max_length=24)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Names cannot contain control characters.")
        return value


class RoomCreate(NameInput):
    title: str = Field(default="A little get-together", min_length=2, max_length=60)


class RoomJoin(NameInput):
    code: str = Field(min_length=8, max_length=20)

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        code = re.sub(r"[\s-]", "", value).upper()
        if not re.fullmatch(r"[A-HJ-NP-Z2-9]{8}", code):
            raise ValueError("Enter a valid 8-character room code.")
        return code[:4] + "-" + code[4:]


class Profile(BaseModel):
    id: str
    name: str


class Member(Profile):
    muted: bool = False
    joined_at: datetime
    online: bool = False


class Room(BaseModel):
    id: str
    code: str
    title: str
    host_id: str
    locked: bool = False
    status: Literal["active", "ended", "deleted"] = "active"
    created_at: datetime
    ended_at: datetime | None = None


class RoomSession(BaseModel):
    token: str
    room: Room
    member: Member


class RoomState(BaseModel):
    room: Room
    members: list[Member]


class SessionState(RoomState):
    member: Member


class RoomAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["lock", "unlock", "end", "transfer"]
    member_id: UUID | None = None


class MemberAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["mute", "unmute", "remove"]


class ChatMessage(BaseModel):
    id: str
    room_id: str
    sender: Profile
    content: str
    kind: Literal["text", "code"] = "text"
    created_at: datetime
    client_message_id: UUID


class MessagePage(BaseModel):
    messages: list[ChatMessage]
    has_more: bool


class IncomingMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["message"]
    content: str = Field(min_length=1, max_length=20000)
    kind: Literal["text", "code"] = "text"
    client_message_id: UUID

    @field_validator("content")
    @classmethod
    def nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A message cannot be empty.")
        # Preserve indentation, line breaks, and trailing spaces in shared text/code.
        return value


class SocketSession(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["session"]
    token: str = Field(min_length=40, max_length=128)


class TypingEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["typing"]
    is_typing: bool
