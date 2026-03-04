const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTP_HOST = process.env.HOST || '0.0.0.0';
const MAX_ROOM_PLAYERS = 4;
const STATE_UPDATE_INTERVAL_MS = 50;
const MAX_WORLD_COORDINATE = 100000;
const MAX_VELOCITY = 5000;

const INITIAL_X = -332;
const INITIAL_Y = 291;

const SINGLE_ROLES = ['MOVE', 'JUMP', 'ATTACK', 'SPECIAL'];

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map();
const clients = new Map();
let nextPlayerId = 1;

function createInitialState() {
  return {
    x: INITIAL_X,
    y: INITIAL_Y,
    vx: 0,
    vy: 0,
    facing: 1,
    moveDirection: 0,
    jumpRequested: false,
    tickCounter: 0
  };
}

function createRoom(roomCode) {
  const room = {
    code: roomCode,
    players: new Map(),
    hostId: 0,
    started: false,
    state: createInitialState(),
    tickTimer: null
  };

  rooms.set(roomCode, room);
  return room;
}

function destroyRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) {
    return;
  }

  if (room.tickTimer) {
    clearInterval(room.tickTimer);
  }

  rooms.delete(roomCode);
}

function safeSend(socket, payload) {
  if (!socket || socket.readyState !== socket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function broadcast(room, payload) {
  for (const player of room.players.values()) {
    safeSend(player.socket, payload);
  }
}

function serializePlayers(room) {
  return Array.from(room.players.values())
    .sort((a, b) => a.id - b.id)
    .map((player) => ({
      id: player.id,
      name: player.name,
      ready: !!player.ready,
      role: player.role || '',
      isHost: player.id === room.hostId
    }));
}

function roomStatePayload(room) {
  return {
    type: 'room_state',
    roomCode: room.code,
    players: serializePlayers(room)
  };
}

function broadcastRoomState(room) {
  broadcast(room, roomStatePayload(room));
}

function normalizeName(name, fallbackPlayerId) {
  const trimmed = String(name || '').trim();
  if (trimmed.length === 0) {
    return `Player${fallbackPlayerId}`;
  }

  return trimmed.slice(0, 24);
}

function makeRoomCode() {
  let roomCode = '';
  do {
    roomCode = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(roomCode));
  return roomCode;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function assignRoles(room) {
  const readyPlayers = Array.from(room.players.values()).filter((p) => p.ready);
  const playerCount = readyPlayers.length;
  if (playerCount < 2) {
    return false;
  }

  const shuffledPlayers = shuffle([...readyPlayers]);

  if (playerCount === 2) {
    const splitRoles = shuffle([...SINGLE_ROLES]);
    const roles = [
      `${splitRoles[0]}+${splitRoles[1]}`,
      `${splitRoles[2]}+${splitRoles[3]}`
    ];
    shuffle(roles);
    shuffledPlayers[0].role = roles[0];
    shuffledPlayers[1].role = roles[1];
  } else if (playerCount === 3) {
    const singles = shuffle(['MOVE', 'JUMP']);
    const roles = shuffle([singles[0], singles[1], 'ATTACK+SPECIAL']);
    for (let i = 0; i < 3; i += 1) {
      shuffledPlayers[i].role = roles[i];
    }
  } else {
    const roles = shuffle([...SINGLE_ROLES]);
    for (let i = 0; i < Math.min(4, shuffledPlayers.length); i += 1) {
      shuffledPlayers[i].role = roles[i];
    }
  }

  room.started = true;
  room.state = createInitialState();
  return true;
}

function hasRole(player, roleName) {
  if (!player || !player.role) {
    return false;
  }

  return String(player.role).split('+').includes(roleName);
}

function clampFiniteNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, numeric));
}

function startGameIfAllReady(room) {
  if (room.players.size < 2) {
    return;
  }

  for (const player of room.players.values()) {
    if (!player.ready) {
      return;
    }
  }

  const started = assignRoles(room);
  if (!started) {
    return;
  }

  const playersPayload = serializePlayers(room);
  for (const player of room.players.values()) {
    safeSend(player.socket, {
      type: 'game_starting',
      roomCode: room.code,
      role: player.role,
      players: playersPayload,
      initialState: {
        position: { x: room.state.x, y: room.state.y },
        velocity: { x: room.state.vx, y: room.state.vy }
      }
    });
  }
}

function removeClientFromRoom(socket) {
  const session = clients.get(socket);
  if (!session || !session.roomCode) {
    return;
  }

  const room = rooms.get(session.roomCode);
  if (!room) {
    clients.set(socket, { ...session, roomCode: '', playerId: 0 });
    return;
  }

  const leavingPlayer = room.players.get(session.playerId);
  room.players.delete(session.playerId);
  clients.set(socket, { ...session, roomCode: '', playerId: 0 });

  if (room.players.size === 0) {
    destroyRoom(room.code);
    return;
  }

  if (room.hostId === session.playerId) {
    const nextHost = Array.from(room.players.values()).sort((a, b) => a.id - b.id)[0];
    room.hostId = nextHost.id;
  }

  if (room.started) {
    room.started = false;
    room.state = createInitialState();
    for (const player of room.players.values()) {
      player.ready = false;
      player.role = '';
    }
  }

  if (leavingPlayer) {
    console.log(`[Server] Player ${leavingPlayer.id} left room ${room.code}`);
  }

  broadcastRoomState(room);
}

function handleCreateRoom(socket, payload) {
  removeClientFromRoom(socket);

  const session = clients.get(socket);
  const roomCode = makeRoomCode();
  const room = createRoom(roomCode);
  const playerId = nextPlayerId;
  nextPlayerId += 1;

  const player = {
    id: playerId,
    name: normalizeName(payload.name, playerId),
    ready: false,
    role: '',
    lastStateAt: 0,
    socket
  };

  room.players.set(playerId, player);
  room.hostId = playerId;

  clients.set(socket, {
    ...session,
    roomCode,
    playerId
  });

  safeSend(socket, {
    type: 'room_created',
    roomCode,
    playerId,
    players: serializePlayers(room)
  });

  broadcastRoomState(room);
  console.log(`[Server] Room ${roomCode} created by ${playerId}`);
}

function handleJoinRoom(socket, payload) {
  removeClientFromRoom(socket);

  const roomCode = String(payload.roomCode || '').trim();
  if (!roomCode) {
    safeSend(socket, { type: 'error', message: 'Room code is required' });
    return;
  }

  const room = rooms.get(roomCode);
  if (!room) {
    safeSend(socket, { type: 'error', message: 'Room not found' });
    return;
  }

  if (room.started) {
    safeSend(socket, { type: 'error', message: 'Match already started' });
    return;
  }

  if (room.players.size >= MAX_ROOM_PLAYERS) {
    safeSend(socket, { type: 'error', message: 'Room is full' });
    return;
  }

  const session = clients.get(socket);
  const playerId = nextPlayerId;
  nextPlayerId += 1;

  room.players.set(playerId, {
    id: playerId,
    name: normalizeName(payload.name, playerId),
    ready: false,
    role: '',
    lastStateAt: 0,
    socket
  });

  clients.set(socket, {
    ...session,
    roomCode,
    playerId
  });

  safeSend(socket, {
    type: 'room_joined',
    roomCode,
    playerId,
    players: serializePlayers(room)
  });

  broadcastRoomState(room);
  console.log(`[Server] Player ${playerId} joined room ${roomCode}`);
}

function handleToggleReady(socket) {
  const session = clients.get(socket);
  if (!session || !session.roomCode) {
    safeSend(socket, { type: 'error', message: 'Not in a room' });
    return;
  }

  const room = rooms.get(session.roomCode);
  if (!room) {
    safeSend(socket, { type: 'error', message: 'Room no longer exists' });
    return;
  }

  const player = room.players.get(session.playerId);
  if (!player) {
    safeSend(socket, { type: 'error', message: 'Player not found in room' });
    return;
  }

  if (room.players.size < 2) {
    safeSend(socket, { type: 'error', message: 'Need at least 2 players to ready' });
    return;
  }

  player.ready = !player.ready;
  if (!player.ready) {
    player.role = '';
  }

  broadcastRoomState(room);
  startGameIfAllReady(room);
}

function handleAction(socket, payload) {
  const session = clients.get(socket);
  if (!session || !session.roomCode) {
    return;
  }

  const room = rooms.get(session.roomCode);
  if (!room || !room.started) {
    return;
  }

  const player = room.players.get(session.playerId);
  if (!player) {
    return;
  }

  const action = String(payload.action || '');
  if (action === 'move') {
    if (!hasRole(player, 'MOVE')) {
      return;
    }

    const direction = Number(payload.direction || 0);
    const normalizedDirection = Math.max(-1, Math.min(1, direction));
    broadcast(room, {
      type: 'action_applied',
      action,
      direction: normalizedDirection,
      actorId: player.id
    });
    return;
  }

  if (action === 'jump') {
    if (!hasRole(player, 'JUMP')) {
      return;
    }
    broadcast(room, {
      type: 'action_applied',
      action,
      actorId: player.id
    });
    return;
  }

  if (action === 'attack') {
    if (!hasRole(player, 'ATTACK')) {
      return;
    }
    broadcast(room, {
      type: 'action_applied',
      action,
      actorId: player.id
    });
    return;
  }

  if (action === 'special') {
    if (!hasRole(player, 'SPECIAL')) {
      return;
    }
    broadcast(room, {
      type: 'action_applied',
      action,
      actorId: player.id
    });
  }
}

function handleStateUpdate(socket, payload) {
  const session = clients.get(socket);
  if (!session || !session.roomCode) {
    return;
  }

  const room = rooms.get(session.roomCode);
  if (!room || !room.started) {
    return;
  }

  const player = room.players.get(session.playerId);
  if (!player || !hasRole(player, 'MOVE')) {
    return;
  }

  const now = Date.now();
  if (now - (player.lastStateAt || 0) < STATE_UPDATE_INTERVAL_MS) {
    return;
  }

  const positionPayload = payload && typeof payload.position === 'object' ? payload.position : null;
  const velocityPayload = payload && typeof payload.velocity === 'object' ? payload.velocity : null;
  if (!positionPayload || !velocityPayload) {
    return;
  }

  const x = clampFiniteNumber(positionPayload.x, -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE, room.state.x);
  const y = clampFiniteNumber(positionPayload.y, -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE, room.state.y);
  const vx = clampFiniteNumber(velocityPayload.x, -MAX_VELOCITY, MAX_VELOCITY, room.state.vx);
  const vy = clampFiniteNumber(velocityPayload.y, -MAX_VELOCITY, MAX_VELOCITY, room.state.vy);

  room.state.x = x;
  room.state.y = y;
  room.state.vx = vx;
  room.state.vy = vy;
  player.lastStateAt = now;

  broadcast(room, {
    type: 'player_state',
    position: { x, y },
    velocity: { x: vx, y: vy },
    actorId: player.id,
    serverTime: now
  });
}

function handleMessage(socket, payload) {
  const type = String(payload?.type || '');
  switch (type) {
    case 'create_room':
      handleCreateRoom(socket, payload);
      break;
    case 'join_room':
      handleJoinRoom(socket, payload);
      break;
    case 'toggle_ready':
      handleToggleReady(socket);
      break;
    case 'leave_room':
      removeClientFromRoom(socket);
      break;
    case 'action':
      handleAction(socket, payload);
      break;
    case 'state_update':
      handleStateUpdate(socket, payload);
      break;
    default:
      safeSend(socket, { type: 'error', message: 'Unknown message type' });
      break;
  }
}

wss.on('connection', (socket) => {
  clients.set(socket, {
    roomCode: '',
    playerId: 0
  });

  safeSend(socket, { type: 'connected' });

  socket.on('message', (rawData) => {
    try {
      const payload = JSON.parse(rawData.toString());
      handleMessage(socket, payload);
    } catch (_error) {
      safeSend(socket, { type: 'error', message: 'Invalid message payload' });
    }
  });

  socket.on('close', () => {
    removeClientFromRoom(socket);
    clients.delete(socket);
  });

  socket.on('error', () => {
    removeClientFromRoom(socket);
    clients.delete(socket);
  });
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[Server] Listening on http://${HTTP_HOST}:${HTTP_PORT}`);
  console.log(`[Server] WebSocket endpoint ws://${HTTP_HOST}:${HTTP_PORT}/ws`);
});