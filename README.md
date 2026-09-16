# Gather — instant text meetings

Create a room, share its code, enter a name, and chat. **No signup, login, or accounts.**

Built with **React + TypeScript**, **FastAPI WebSockets**, and **MongoDB** using PyMongo's async driver. Mongoose is a Node.js library; PyMongo provides the database connection for this Python backend.

## What you can do

- Create a meeting and share its random 8-character room code or invitation link.
- Join by entering the code and a display name.
- Share messages, multiline text, and code snippets up to 20,000 characters, preserving formatting.
- See participants, their online status, and live typing indicators.
- Copy individual messages and export the full transcript as a text file.
- Refresh/reconnect without losing your identity, host role, or saved messages.
- Return to rooms from the **recent rooms** saved on your browser.

### Host controls

| Control | Effect |
| --- | --- |
| Lock/unlock entry | Stop or allow new participants; existing sessions can reconnect |
| Mute/unmute | Prevent a participant from sending while allowing them to read |
| Remove participant | Disconnect and revoke their room/transcript access |
| Delete message | Remove one message for everyone |
| Clear conversation | Remove all shared text/code for everyone |
| Transfer host | Give an online participant control; the previous host becomes a guest |
| End meeting | Stop joins and messaging; existing participants retain read-only access |
| Delete room permanently | After ending, remove its transcript and all participant access |

Ended meetings and their transcripts remain until the **current host** deletes them. Leaving a room or losing the connection does not end it or revoke ownership.

## Run locally

Requirements: **Node.js 20.19+**, **Python 3.11+**, and a **MongoDB Atlas connection**.

### Configure MongoDB Atlas

Use your existing Atlas settings in `backend/.env.local` or `backend/.env`. For a new setup, create `backend/.env.local` with your actual cluster credentials and database name:

```dotenv
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@YOUR-CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=gather
CORS_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173"]
```

Allow your development machine's public IP in Atlas **Network Access** and give the database user read/write access to your chosen database. URL-encode special characters in the username/password. See [DEPLOYMENT.md](DEPLOYMENT.md) for Atlas setup details.

The backend reads `backend/.env` first, then `backend/.env.local`. Values in `.env.local` override `.env`, and either file may be used on its own. Process environment variables take precedence over both files. Restart Uvicorn after changing connection settings.

### Start FastAPI

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --ws-max-size 131072
```

If you already have a `.venv` and `.env` or `.env.local`, use them and start Uvicorn. On Windows, activate with `.venv\Scripts\activate`.

If startup reports `ServerSelectionTimeoutError`, check the Atlas cluster status, connection string, database credentials, and Network Access settings. A reference to `localhost:27017` means the backend is still using its local default; verify `MONGODB_URI` in `backend/.env.local` or `backend/.env`, then stop the failed reloader with **Ctrl+C** and restart Uvicorn.

### Start React in another terminal

```bash
cd frontend
npm ci
npm run dev
```

Open **http://localhost:5173**. Create a room and open its invitation in another browser/incognito window to join as someone else.

- API docs: **http://localhost:8000/docs**
- Health check: **http://localhost:8000/api/health**

Vite proxies `/api` HTTP and WebSocket traffic to FastAPI. Optional frontend settings are in `frontend/.env.example`.

## Host it on the internet

**Yes: Vercel frontend + Render backend + MongoDB Atlas is supported.**

- `render.yaml` configures the FastAPI web service.
- `frontend/vercel.json` configures the React SPA, including direct invitation links.
- Vercel needs `VITE_API_URL=https://YOUR-API.onrender.com`.
- Render needs `MONGODB_URI`, `MONGODB_DATABASE`, and `CORS_ORIGINS=["https://YOUR-APP.vercel.app"]`.
- Live chat uses a direct **WSS** connection from the browser to Render.

Follow **[DEPLOYMENT.md](DEPLOYMENT.md)** for exact dashboard settings, Atlas network access, and deployment checks.

## Anonymous sessions and room lifecycle

There is no account system. On create/join, FastAPI issues a cryptographically random, room-scoped session token. The browser keeps the token; MongoDB stores its SHA-256 hash. HTTP uses an Authorization header and WebSockets receive the token in their first frame, never in the URL. Host permissions come from MongoDB, not from a name or a client-supplied role.

- Room codes are invitations, not host credentials. Rooms have no public directory.
- Clearing browser site data loses its saved access. An invitation alone cannot recover host ownership.
- Removing a participant revokes that session. With no accounts, a person can obtain a new anonymous session if they still have the code and entry is open. Lock entry to prevent fresh joins.
- Locking does not interrupt existing members or stop their reconnections.
- Ended-room WebSockets remain read-only so transcript deletions and access changes still update immediately.
- Deleted-message text is erased. Small deduplication receipts remain until room deletion so retries cannot resurrect removed messages.
- Deleted rooms first become inaccessible; if database cleanup is interrupted, the next backend startup finishes removing their records.
- Meeting data uses `meetings`, `meeting_members`, and `meeting_messages`. Legacy public-channel collections from the earlier version are preserved and no longer exposed by the API.

Run **one backend worker and one server instance**. Room coordination, connection routing, and rate limits currently use in-process state. Multiple instances need a shared coordination/broadcast layer before horizontal scaling.

Defaults: 100 admitted participants per room (including offline members), 10 creates/minute per IP, 30 joins/minute per IP, and 120 messages/minute per participant. These are configurable through `backend/.env.example`.

## API overview

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/health` | Public health check |
| POST | `/api/rooms` | Create with `name`, optional `title`; returns host session |
| POST | `/api/rooms/join` | Join with `name`, `code`; returns guest session |
| GET | `/api/rooms/{id}/session` | Room member; current state and participant list |
| GET | `/api/rooms/{id}/messages` | Room member; paginated with `before`, `limit` |
| POST | `/api/rooms/{id}/actions` | Host; `lock`, `unlock`, `end`, or `transfer` |
| POST | `/api/rooms/{id}/members/{member_id}/actions` | Host; `mute`, `unmute`, or `remove` |
| DELETE | `/api/rooms/{id}/messages/{message_id}` | Host; delete one message |
| DELETE | `/api/rooms/{id}/messages` | Host; clear messages |
| DELETE | `/api/rooms/{id}` | Host; delete an ended room |
| WebSocket | `/api/ws/{id}` | First frame: `{"type":"session","token":"…"}` |

After the initial `snapshot`, the socket receives live state/message/moderation events. Send a message as:

```json
{
  "type": "message",
  "content": "Hello, everyone!",
  "kind": "text",
  "client_message_id": "6f20145c-2430-4f91-b213-fd4680e625b9"
}
```

Use `kind: "code"` for code blocks. Reuse the message UUID when retrying a send. Messages are broadcast only after they are saved.

## Checks

Backend:

```bash
cd backend
source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q
ruff check app tests
```

To include real MongoDB integration, set `MONGODB_TEST_URI` to a development Atlas connection string whose database user can create and remove test databases, then run:

```bash
python -m pytest -q
```

The integration test is skipped when `MONGODB_TEST_URI` is unset. When enabled, it uses a uniquely named database and removes it afterward. Tests cover private/scoped sessions, room isolation, host permissions, moderation, ownership transfer, ended-room access, pagination, safe retries, and restart persistence.

Frontend:

```bash
cd frontend
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests require the backend, MongoDB, and frontend to be running. They create meeting data, so use a development database. To target a different frontend, set `E2E_BASE_URL=http://localhost:5173`.

## Project layout

```text
backend/app/          FastAPI models, MongoDB store, room/session endpoints, live events
backend/tests/        API/WebSocket tests and real MongoDB integration
frontend/src/
  components/         Landing page, meeting view, composer, dialogs, copy controls
  hooks/useChat.ts    Sessions, WebSocket events, reconnection, and message history
  storage.ts          Browser-held room sessions
  api.ts              HTTP client and WS/WSS URL handling
frontend/tests/       Multi-browser and mobile end-to-end flows
render.yaml           Render backend blueprint
frontend/vercel.json  Vercel frontend configuration
DEPLOYMENT.md         Internet deployment guide
```
