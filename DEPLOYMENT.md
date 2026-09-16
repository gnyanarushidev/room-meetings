# Deploy Gather: Vercel + Render + MongoDB Atlas

Yes, this application works with this setup:

```text
Browser → Vercel       React frontend over HTTPS
Browser → Render       FastAPI requests over HTTPS + live chat over WSS
Render  → MongoDB Atlas   Rooms, membership/session hashes, and messages
```

The frontend connects **directly to Render** for API and WebSocket traffic. Vercel serves the React build. `frontend/vercel.json` enables invitation and room links to work on refresh.

## 1. Put the project in a Git repository

Push this project to a GitHub/GitLab repository that Render and Vercel can access. Keep the `backend` and `frontend` directories together. `.env`, `.venv`, and `node_modules` are already ignored.

## 2. Create the MongoDB Atlas database

1. Create an Atlas project and cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. Under **Database Access**, create a database user with read/write access to `gather_meetings`.
3. Choose **Connect → Drivers → Python** and copy your connection string.
4. Replace the username/password placeholders. URL-encode special characters in credentials.

Example format:

```dotenv
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@YOUR-CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=gather_meetings
```

Configure **Network Access** to allow your Render service's outbound IP ranges. Find them in the Render service dashboard under **Connect → Outbound**. Add your development machine's IP separately if you also connect locally. Atlas must be reachable before FastAPI can finish startup.

## 3. Deploy FastAPI to Render

### Blueprint setup

Choose **New → Blueprint**, connect the repository, and use the root `render.yaml`. Enter the prompted values for `MONGODB_URI` and `CORS_ORIGINS`.

### Manual setup

Alternatively, create a **Web Service** with:

| Setting | Value |
| --- | --- |
| Language/runtime | Python |
| Root directory | `backend` |
| Build command | `pip install -r requirements.txt` |
| Health check | `/api/health` |
| Instance count | **1** |

Start command:

```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1 --ws-max-size 131072 --ws-ping-interval 20 --ws-ping-timeout 20 --proxy-headers --forwarded-allow-ips '*'
```

Set these Render environment variables:

```dotenv
PYTHON_VERSION=3.12.13
MONGODB_URI=mongodb+srv://YOUR-DATABASE-USER:YOUR-PASSWORD@YOUR-CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=gather_meetings
CORS_ORIGINS=["https://your-app.vercel.app"]
ROOM_CAPACITY=100
```

`CORS_ORIGINS` must be a **JSON array** containing exact frontend origins, with no trailing slash or path. If you do not yet have your Vercel URL, use `[]` temporarily, deploy the backend, then update the value in step 5.

After deployment, check:

```text
https://YOUR-API.onrender.com/api/health
```

Expected response:

```json
{"status":"ok","database":"connected"}
```

API documentation is available at `https://YOUR-API.onrender.com/docs`.

**Use one worker and one Render instance.** Live broadcasts, per-room serialization, presence, and rate limits currently live in one process. Increasing workers or replicas requires a shared coordination/broadcast layer first. Deployments can briefly interrupt chat; saved sessions and history recover from MongoDB when clients reconnect.

## 4. Deploy React to Vercel

Import the same repository as a Vercel project:

| Setting | Value |
| --- | --- |
| Root directory | `frontend` |
| Framework preset | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |
| Install command | `npm ci` |
| Node.js | 22.x or a supported version ≥20.19 |

Add this environment variable before building:

```dotenv
VITE_API_URL=https://YOUR-API.onrender.com
```

Use the **HTTPS base URL**, without `/api`. The application automatically uses `wss://YOUR-API.onrender.com/api/ws/...` for chat. Rebuild/redeploy Vercel after changing this variable because Vite embeds it into the frontend build.

The MongoDB URI belongs **only on Render**. The browser never connects directly to MongoDB.

## 5. Connect the final frontend origin

Once Vercel gives you a URL, update Render:

```dotenv
CORS_ORIGINS=["https://your-app.vercel.app"]
```

For a custom domain plus local development:

```dotenv
CORS_ORIGINS=["https://chat.example.com","https://your-app.vercel.app","http://localhost:5173","http://127.0.0.1:5173"]
```

Redeploy/restart Render after changing environment variables. Add individual Vercel preview origins if you want to test preview deployments; an unlisted preview URL cannot open room WebSockets.

## 6. Check a real internet meeting

1. Open the Vercel app, enter a name, and create a room.
2. Copy its invitation link and open it on another device or in incognito.
3. Enter another name and join. Send text and a code snippet.
4. Test host controls: lock entry, mute/unmute, remove, and transfer ownership.
5. Refresh a participant's page; their session and messages should return.
6. End a meeting; existing participants can read/export the transcript and new joins are blocked.
7. Permanently delete the room as its current host; remaining participants lose access.

## Free-tier behaviour

Render supports public WebSockets, including FastAPI. Its free web services can spin down after 15 minutes without inbound traffic and take about a minute to wake. The client shows connection progress and automatically reconnects; MongoDB keeps the rooms and membership data. For consistently available meetings, use an always-on paid Render instance. Atlas and Vercel plans also have their own usage limits.

## Troubleshooting

- **Frontend cannot reach the server:** verify `VITE_API_URL`, open Render's `/api/health`, and allow time for a sleeping service to wake.
- **CORS or WebSocket origin rejected:** add the exact Vercel/custom origin to `CORS_ORIGINS`. HTTPS pages must use `wss://`, which is derived automatically from the HTTPS API URL.
- **MongoDB startup timeout:** check the URI, Atlas database credentials, and Atlas Network Access for Render's outbound ranges.
- **Invitation links show a 404:** ensure Vercel's root directory is `frontend` so it reads `vercel.json`.
- **Messages reach only some participants:** check for multiple backend workers/instances. This release requires one of each.
- **Host access missing on another browser:** there are no accounts. The private room session is saved on the browser that created/joined the room. An invitation grants guest entry, not host ownership.

### Platform references

- [Render WebSockets](https://render.com/docs/websocket)
- [Render free service behaviour](https://render.com/docs/free)
- [Vite and SPA routing on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
