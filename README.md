# Shared Fate Dedicated Server

## Requirements
- Node.js 18+
- Docker (optional, for container deployment)

## Install
```bash
cd Server
npm install
```

## Run
```bash
cd Server
npm start
```

The server listens on:
- HTTP health: `http://127.0.0.1:8080/health`
- WebSocket: `ws://127.0.0.1:8080/ws`

The Godot client is configured to connect to localhost by default.

## Docker
Build and run locally:

```bash
cd Server
npm run docker:build
npm run docker:run
```

Or with raw Docker commands:

```bash
cd Server
docker build -t shared-fate-server .
docker run --rm -p 8080:8080 shared-fate-server
```

## Deploy on Render (Docker)
1. Push this repository to GitHub.
2. In Render, create a **Web Service** from that repo.
3. Set **Root Directory** to `Server`.
4. Set **Environment** to `Docker`.
5. Render will build from `Server/Dockerfile` and expose the container on `PORT`.
6. Use Render URL for clients, e.g. `wss://<your-service>.onrender.com/ws`.

For deployed clients, set `Data.WS_SERVER_URL` to your Render WebSocket URL.