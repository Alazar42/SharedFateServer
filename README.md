# Shared Fate Dedicated Server

## Requirements
- Node.js 18+

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