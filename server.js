// ===== Complete the Word — Real-time Multiplayer Server =====
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---------- Load dictionary ----------
console.log('Loading dictionary...');
const DICT = new Set(
  fs.readFileSync(path.join(__dirname, 'data', 'words.txt'), 'utf8')
    .split('\n')
    .map(w => w.trim().toLowerCase())
    .filter(Boolean)
);
console.log(`Dictionary loaded: ${DICT.size} words`);

// ---------- Static file server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, 'public', path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- Game constants ----------
const TURN_SECONDS = 12;
const START_COUNTDOWN = 5;
const START_HEARTS = 3;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const START_LETTERS_COUNT = 4;
const RECONNECT_GRACE_MS = 60_000; // how long a disconnected player can rejoin
const WRONG_WORD_PENALTY_MS = 2000; // -2 seconds per wrong word
const MIN_TURN_REMAINING_MS = 250;  // never push deadline before "now+250ms"
const FRIENDLY_LETTERS = 'ABCDEFGHILMNOPRSTUW';

function uid() { return Math.random().toString(36).slice(2, 10); }
function tok() { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10); }
function randLetter(pool) { return pool[Math.floor(Math.random() * pool.length)]; }

function makeStartLetters() {
  const set = new Set();
  while (set.size < START_LETTERS_COUNT) set.add(randLetter(FRIENDLY_LETTERS));
  return [...set];
}

// ---------- Rooms ----------
/*
room = {
  id, name, players: Map(playerId -> player), state: 'lobby'|'countdown'|'playing'|'ended',
  hostId, order: [playerId...], turnIndex, currentLetter, usedWords: Set,
  timer, countdownTimer, turnDeadline, winnerId, startLetters
}
player = {
  id,            // persistent player id == auth token (stable across refresh)
  nick,
  hearts, alive,
  isSpectator,   // true => was originally a player but ran out of hearts; stays in room watching
  ws,            // current ws, may be null while disconnected
  connected,
  disconnectAt,  // timestamp if currently disconnected
}

Each WebSocket gets:
  ws.playerId   (persistent id from client token, used as room key)
  ws.roomId
  ws.isLobby
*/
const rooms = new Map();
// Track recently-disconnected players so refresh can resume them without losing state
// key: playerId -> { roomId, expiresAt }
const reconnectIndex = new Map();

function publicRoomList() {
  // Show ALL rooms (including playing/ended) so users see what's in progress.
  return [...rooms.values()].map(r => ({
    id: r.id,
    name: r.name,
    players: countActive(r),
    max: MAX_PLAYERS,
    state: r.state,
    canJoin: (r.state === 'lobby' || r.state === 'countdown') && countActive(r) < MAX_PLAYERS,
  }));
}

function countActive(room) {
  // count non-spectator players for capacity purposes
  let n = 0;
  for (const p of room.players.values()) if (!p.isSpectator) n++;
  return n;
}

function broadcastLobby() {
  const msg = JSON.stringify({ type: 'roomList', rooms: publicRoomList() });
  for (const ws of lobbyWatchers) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function roomStatePayload(room) {
  const all = [...room.players.values()].map(p => ({
    id: p.id, nick: p.nick, hearts: p.hearts, alive: p.alive,
    isSpectator: !!p.isSpectator, connected: !!p.connected,
  }));
  return {
    type: 'roomState',
    room: {
      id: room.id,
      name: room.name,
      state: room.state,
      hostId: room.hostId,
      currentLetter: room.currentLetter,
      turnPlayerId: room.state === 'playing' ? room.order[room.turnIndex] : null,
      turnSeconds: TURN_SECONDS,
      turnDeadline: room.state === 'playing' ? room.turnDeadline : null,
      usedCount: room.usedWords.size,
      startLetters: room.startLetters || [],
      pickMode: room.state === 'playing' && room.currentLetter === null,
      players: room.order
        .map(id => room.players.get(id))
        .filter(Boolean)
        .map(p => ({ id: p.id, nick: p.nick, hearts: p.hearts, alive: p.alive, isSpectator: !!p.isSpectator, connected: !!p.connected })),
      lobbyPlayers: all,
      winnerId: room.winnerId || null,
    },
  };
}

function sendRoom(room, payload) {
  const msg = JSON.stringify(payload);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  }
}

function pushRoomState(room) {
  sendRoom(room, roomStatePayload(room));
}

function roomEvent(room, text, kind = 'info') {
  sendRoom(room, { type: 'event', text, kind });
}

// ---------- Lobby watchers ----------
const lobbyWatchers = new Set();

// ---------- Game flow ----------
function startCountdown(room) {
  if (room.state !== 'lobby') return;
  if (countActive(room) < MIN_PLAYERS) return;
  room.state = 'countdown';
  let count = START_COUNTDOWN;
  pushRoomState(room);
  broadcastLobby();
  sendRoom(room, { type: 'countdown', value: count });
  room.countdownTimer = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      beginGame(room);
    } else {
      sendRoom(room, { type: 'countdown', value: count });
    }
  }, 1000);
}

function cancelCountdown(room) {
  if (room.countdownTimer) { clearInterval(room.countdownTimer); room.countdownTimer = null; }
  if (room.state === 'countdown') {
    room.state = 'lobby';
    pushRoomState(room);
    broadcastLobby();
  }
}

function beginGame(room) {
  room.state = 'playing';
  room.usedWords = new Set();
  // only non-spectator players play
  const playerIds = [...room.players.values()].filter(p => !p.isSpectator).map(p => p.id);
  room.order = playerIds;
  for (let i = room.order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.order[i], room.order[j]] = [room.order[j], room.order[i]];
  }
  for (const id of room.order) {
    const p = room.players.get(id);
    p.hearts = START_HEARTS;
    p.alive = true;
    p.isSpectator = false;
  }
  room.turnIndex = 0;
  room.startLetters = makeStartLetters();
  room.currentLetter = null;
  room.winnerId = null;
  roomEvent(room, 'Nagsimula na ang laro! Matira matibay! 🔥', 'start');
  pushRoomState(room);
  broadcastLobby();
  sendRoom(room, { type: 'pickLetter', letters: room.startLetters, turnPlayerId: room.order[room.turnIndex] });
  startTurnTimer(room);
}

function alivePlayers(room) {
  return room.order.map(id => room.players.get(id)).filter(p => p && p.alive);
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  sendRoom(room, {
    type: 'turn',
    turnPlayerId: room.order[room.turnIndex],
    currentLetter: room.currentLetter,
    pickMode: room.currentLetter === null,
    letters: room.currentLetter === null ? room.startLetters : null,
    deadline: room.turnDeadline,
    seconds: TURN_SECONDS,
  });
  room.timer = setTimeout(() => onTimeout(room), TURN_SECONDS * 1000);
}

function clearTurnTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function onTimeout(room) {
  const pid = room.order[room.turnIndex];
  const p = room.players.get(pid);
  if (!p) { advanceTurn(room); return; }
  p.hearts--;
  roomEvent(room, `⏱️ Naubusan ng oras si ${p.nick}! -1 ❤️ (natitira: ${Math.max(0, p.hearts)})`, 'timeout');
  if (p.hearts <= 0) {
    p.alive = false;
    p.isSpectator = true; // becomes spectator, stays in room
    roomEvent(room, `💀 Talo na si ${p.nick}! Magiging spectator.`, 'dead');
    // notify the specific player they're now spectator
    if (p.ws && p.ws.readyState === p.ws.OPEN) {
      p.ws.send(JSON.stringify({ type: 'youSpectate', reason: 'Naubos ang hearts mo.' }));
    }
  }
  pushRoomState(room);
  if (checkGameOver(room)) return;
  advanceTurn(room);
}

function checkGameOver(room) {
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    clearTurnTimer(room);
    room.state = 'ended';
    room.winnerId = alive.length === 1 ? alive[0].id : null;
    const wname = alive.length === 1 ? alive[0].nick : 'Walang natira';
    roomEvent(room, `🏆 PANALO: ${wname}!`, 'win');
    sendRoom(room, { type: 'gameOver', winnerId: room.winnerId, winnerNick: alive.length === 1 ? alive[0].nick : null });
    pushRoomState(room);
    broadcastLobby();
    return true;
  }
  return false;
}

function advanceTurn(room) {
  if (room.state !== 'playing') return;
  let guard = 0;
  do {
    room.turnIndex = (room.turnIndex + 1) % room.order.length;
    guard++;
  } while (!(room.players.get(room.order[room.turnIndex]) || {}).alive && guard <= room.order.length);
  pushRoomState(room);
  startTurnTimer(room);
}

// Reject a word AND penalize the current turn by removing 2 seconds.
// If the new remaining time is too low, force an immediate timeout (heart loss).
function rejectWithPenalty(room, player, reason) {
  // tell the rejecter what went wrong
  if (player.ws && player.ws.readyState === player.ws.OPEN) {
    player.ws.send(JSON.stringify({ type: 'rejected', reason, penaltyMs: WRONG_WORD_PENALTY_MS }));
  }
  // broadcast penalty event to everyone (for log + sound + visual)
  sendRoom(room, {
    type: 'penalty',
    playerId: player.id,
    nick: player.nick,
    reason,
    penaltyMs: WRONG_WORD_PENALTY_MS,
  });
  roomEvent(room, `⚠️ ${player.nick}: ${reason} (-2s ⏱️)`, 'timeout');

  // shrink the turn deadline by 2 seconds
  const now = Date.now();
  const remaining = (room.turnDeadline || now) - now;
  const newRemaining = remaining - WRONG_WORD_PENALTY_MS;
  if (newRemaining <= MIN_TURN_REMAINING_MS) {
    // Out of time — trigger timeout immediately
    clearTurnTimer(room);
    room.turnDeadline = now;
    onTimeout(room);
    return;
  }
  // Reschedule the turn timer with the reduced deadline
  clearTurnTimer(room);
  room.turnDeadline = now + newRemaining;
  // Notify clients of the new deadline so timers stay in sync
  sendRoom(room, {
    type: 'deadlineUpdate',
    turnPlayerId: room.order[room.turnIndex],
    deadline: room.turnDeadline,
    reason: 'wrongWord',
  });
  room.timer = setTimeout(() => onTimeout(room), newRemaining);
}

function handleWord(room, player, rawWord) {
  if (room.state !== 'playing') return;
  if (player.isSpectator || !player.alive) {
    player.ws && player.ws.send(JSON.stringify({ type: 'rejected', reason: 'Spectator ka na — manood ka na lang.' }));
    return;
  }
  const pid = room.order[room.turnIndex];
  if (pid !== player.id) {
    // not their turn — don't penalize someone else's turn timer
    player.ws.send(JSON.stringify({ type: 'rejected', reason: 'Hindi pa ikaw ang turn.' }));
    return;
  }
  const word = String(rawWord || '').trim().toLowerCase();

  // === pick-mode: must start with one of the start letters ===
  if (room.currentLetter === null) {
    if (!/^[a-z]+$/.test(word) || word.length < 2) {
      return rejectWithPenalty(room, player, 'Letters lang at least 2 ang haba.');
    }
    if (!room.startLetters.map(l => l.toLowerCase()).includes(word[0])) {
      return rejectWithPenalty(room, player, `Dapat magsimula sa isa sa: ${room.startLetters.join(', ')}`);
    }
    if (!DICT.has(word)) {
      return rejectWithPenalty(room, player, `"${word}" ay wala sa diksyunaryo.`);
    }
    acceptWord(room, player, word);
    return;
  }

  // === normal mode ===
  if (!/^[a-z]+$/.test(word) || word.length < 2) {
    return rejectWithPenalty(room, player, 'Letters lang at least 2 ang haba.');
  }
  if (word[0] !== room.currentLetter.toLowerCase()) {
    return rejectWithPenalty(room, player, `Dapat magsimula sa "${room.currentLetter.toUpperCase()}".`);
  }
  if (room.usedWords.has(word)) {
    return rejectWithPenalty(room, player, `"${word}" ay nagamit na.`);
  }
  if (!DICT.has(word)) {
    return rejectWithPenalty(room, player, `"${word}" ay wala sa diksyunaryo.`);
  }
  acceptWord(room, player, word);
}

function acceptWord(room, player, word) {
  room.usedWords.add(word);
  const lastLetter = word[word.length - 1];
  room.currentLetter = lastLetter.toUpperCase();
  roomEvent(room, `✅ ${player.nick}: ${word.toUpperCase()} → susunod na letra: ${room.currentLetter}`, 'word');
  sendRoom(room, { type: 'wordAccepted', word, by: player.nick, nextLetter: room.currentLetter });
  pushRoomState(room);
  clearTurnTimer(room);
  advanceTurn(room);
}

// ---------- WebSocket handling ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.id = uid();              // ephemeral connection id
  ws.playerId = null;         // assigned after 'hello'
  ws.roomId = null;
  ws.isLobby = false;

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'hello': {
      // Client sends its persistent token (or asks for one)
      let token = String(msg.token || '').slice(0, 64);
      if (!token) token = tok();
      ws.playerId = token;
      // Try to resume previous room
      const prev = reconnectIndex.get(token);
      let resumedRoom = null;
      if (prev && rooms.has(prev.roomId)) {
        const r = rooms.get(prev.roomId);
        const p = r.players.get(token);
        if (p) {
          p.ws = ws;
          p.connected = true;
          p.disconnectAt = null;
          ws.roomId = r.id;
          resumedRoom = r;
          reconnectIndex.delete(token);
        }
      }
      ws.send(JSON.stringify({ type: 'welcome', token, youId: token, resumedRoomId: resumedRoom ? resumedRoom.id : null }));
      if (resumedRoom) {
        ws.send(JSON.stringify({ type: 'joined', roomId: resumedRoom.id, youId: token, hostId: resumedRoom.hostId, resumed: true }));
        pushRoomState(resumedRoom);
        // resend current turn info if playing
        if (resumedRoom.state === 'playing') {
          ws.send(JSON.stringify({
            type: 'turn',
            turnPlayerId: resumedRoom.order[resumedRoom.turnIndex],
            currentLetter: resumedRoom.currentLetter,
            pickMode: resumedRoom.currentLetter === null,
            letters: resumedRoom.currentLetter === null ? resumedRoom.startLetters : null,
            deadline: resumedRoom.turnDeadline,
            seconds: TURN_SECONDS,
          }));
        }
        roomEvent(resumedRoom, `🔄 Nakabalik si ${resumedRoom.players.get(token).nick}.`, 'join');
        broadcastLobby();
      }
      break;
    }
    case 'watchLobby': {
      ws.isLobby = true;
      lobbyWatchers.add(ws);
      ws.send(JSON.stringify({ type: 'roomList', rooms: publicRoomList() }));
      break;
    }
    case 'stopWatchLobby': {
      lobbyWatchers.delete(ws);
      ws.isLobby = false;
      break;
    }
    case 'createRoom': {
      if (!ws.playerId) ws.playerId = tok();
      const nick = sanitizeNick(msg.nick);
      const name = sanitizeRoomName(msg.roomName) || `${nick}'s Room`;
      const room = {
        id: uid(),
        name,
        players: new Map(),
        state: 'lobby',
        hostId: ws.playerId,
        order: [],
        turnIndex: 0,
        currentLetter: null,
        usedWords: new Set(),
        startLetters: [],
        timer: null,
        countdownTimer: null,
        winnerId: null,
      };
      rooms.set(room.id, room);
      joinRoomInternal(ws, room, nick);
      broadcastLobby();
      break;
    }
    case 'joinRoom': {
      const room = rooms.get(msg.roomId);
      const nick = sanitizeNick(msg.nick);
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Wala na ang room.' })); return; }
      // allow rejoin (player already in room with same playerId) without restrictions
      const existing = ws.playerId && room.players.get(ws.playerId);
      if (existing) {
        existing.ws = ws;
        existing.connected = true;
        existing.disconnectAt = null;
        ws.roomId = room.id;
        ws.send(JSON.stringify({ type: 'joined', roomId: room.id, youId: ws.playerId, hostId: room.hostId, resumed: true }));
        pushRoomState(room);
        broadcastLobby();
        return;
      }
      if (countActive(room) >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: 'Puno na ang room.' })); return; }
      if (room.state === 'playing' || room.state === 'countdown') {
        // join as spectator
        joinRoomInternal(ws, room, nick, { asSpectator: true });
        broadcastLobby();
        return;
      }
      if (room.state === 'ended') {
        // allow rejoin to lobby-ish; just join as spectator until host plays again
        joinRoomInternal(ws, room, nick, { asSpectator: true });
        broadcastLobby();
        return;
      }
      joinRoomInternal(ws, room, nick);
      broadcastLobby();
      break;
    }
    case 'leaveRoom': {
      leaveRoom(ws, { permanent: true });
      break;
    }
    case 'startGame': {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.playerId) { ws.send(JSON.stringify({ type: 'error', message: 'Host lang ang pwedeng mag-start.' })); return; }
      if (countActive(room) < MIN_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: `Kailangan ng at least ${MIN_PLAYERS} players.` })); return; }
      startCountdown(room);
      break;
    }
    case 'submitWord': {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const player = room.players.get(ws.playerId);
      if (!player) return;
      handleWord(room, player, msg.word);
      break;
    }
    case 'playAgain': {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.playerId) return;
      if (room.state !== 'ended') return;
      room.state = 'lobby';
      room.winnerId = null;
      room.usedWords = new Set();
      // Restore spectators back to active players (kept them in room across game)
      for (const p of room.players.values()) {
        p.hearts = START_HEARTS;
        p.alive = true;
        p.isSpectator = false;
      }
      pushRoomState(room);
      broadcastLobby();
      break;
    }
  }
}

function joinRoomInternal(ws, room, nick, opts = {}) {
  // leave any previous room
  if (ws.roomId && ws.roomId !== room.id) leaveRoom(ws, { permanent: true });
  if (!ws.playerId) ws.playerId = tok();
  ws.roomId = room.id;
  lobbyWatchers.delete(ws);
  ws.isLobby = false;
  const isSpectator = !!opts.asSpectator;
  const player = {
    id: ws.playerId,
    nick,
    hearts: START_HEARTS,
    alive: !isSpectator,
    isSpectator,
    ws,
    connected: true,
    disconnectAt: null,
  };
  room.players.set(ws.playerId, player);
  if (!isSpectator && !room.order.includes(ws.playerId)) room.order.push(ws.playerId);
  ws.send(JSON.stringify({ type: 'joined', roomId: room.id, youId: ws.playerId, hostId: room.hostId, spectator: isSpectator }));
  if (isSpectator) {
    roomEvent(room, `👁️ Nanonood si ${nick} (spectator)`, 'join');
  } else {
    roomEvent(room, `👋 Sumali si ${nick}`, 'join');
  }
  pushRoomState(room);
}

// `permanent`: user explicitly left (leave button) — remove now.
// Otherwise (disconnect), keep player in room for grace period to allow refresh-resume.
function leaveRoom(ws, opts = {}) {
  const room = rooms.get(ws.roomId);
  const wasRoomId = ws.roomId;
  ws.roomId = null;
  if (!room) return;
  const player = room.players.get(ws.playerId);
  if (!player) return;
  const nick = player.nick;

  if (!opts.permanent) {
    // Soft disconnect: keep player; schedule cleanup
    player.connected = false;
    player.disconnectAt = Date.now();
    player.ws = null;
    reconnectIndex.set(ws.playerId, { roomId: wasRoomId, expiresAt: Date.now() + RECONNECT_GRACE_MS });
    roomEvent(room, `🔌 Nadiskonek si ${nick}… (naghihintay ng reconnect)`, 'leave');
    pushRoomState(room);
    broadcastLobby();
    // schedule hard-removal if not back in time
    setTimeout(() => {
      const r = rooms.get(wasRoomId);
      if (!r) return;
      const p = r.players.get(player.id);
      if (!p) return;
      if (p.connected) return; // came back
      // permanently remove
      hardRemovePlayer(r, p.id);
    }, RECONNECT_GRACE_MS + 500);
    return;
  }

  hardRemovePlayer(room, ws.playerId);
}

function hardRemovePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;
  const nick = player.nick;
  const wasHost = room.hostId === playerId;
  const wasTurn = room.order[room.turnIndex] === playerId;

  room.players.delete(playerId);
  room.order = room.order.filter(id => id !== playerId);
  reconnectIndex.delete(playerId);
  roomEvent(room, `🚪 Umalis si ${nick}`, 'leave');

  if (room.players.size === 0) {
    cleanupRoom(room);
    broadcastLobby();
    return;
  }
  if (wasHost) {
    // pass host to first remaining player (prefer non-spectator)
    const next = [...room.players.values()].find(p => !p.isSpectator) || room.players.values().next().value;
    room.hostId = next ? next.id : room.players.keys().next().value;
  }
  if (room.state === 'playing') {
    if (!checkGameOver(room)) {
      if (wasTurn) {
        clearTurnTimer(room);
        if (room.order.length > 0) {
          room.turnIndex = room.turnIndex % room.order.length;
          if (!(room.players.get(room.order[room.turnIndex]) || {}).alive) advanceTurn(room);
          else startTurnTimer(room);
        }
      }
    }
  }
  if (room.state === 'countdown' && countActive(room) < MIN_PLAYERS) {
    cancelCountdown(room);
  }
  pushRoomState(room);
  broadcastLobby();
}

function handleDisconnect(ws) {
  lobbyWatchers.delete(ws);
  if (ws.roomId) leaveRoom(ws, { permanent: false });
}

function cleanupRoom(room) {
  clearTurnTimer(room);
  if (room.countdownTimer) clearInterval(room.countdownTimer);
  rooms.delete(room.id);
}

// ---------- helpers ----------
function sanitizeNick(n) {
  n = String(n || '').trim().slice(0, 16).replace(/[<>]/g, '');
  return n || 'Player';
}
function sanitizeRoomName(n) {
  return String(n || '').trim().slice(0, 24).replace(/[<>]/g, '');
}

server.listen(PORT, () => {
  console.log(`\n🎮 Complete the Word running at http://localhost:${PORT}\n`);
});
