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
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Letters that are reasonable to start a word with (avoid x, z, q as forced starts)
const FRIENDLY_LETTERS = 'ABCDEFGHILMNOPRSTUW';

function uid() { return Math.random().toString(36).slice(2, 10); }
function randLetter(pool) { return pool[Math.floor(Math.random() * pool.length)]; }

function makeStartLetters() {
  const set = new Set();
  while (set.size < START_LETTERS_COUNT) set.add(randLetter(FRIENDLY_LETTERS));
  return [...set];
}

// Does the dictionary contain at least one word starting with this letter (that isn't used)?
function hasWordForLetter(letter, used) {
  letter = letter.toLowerCase();
  // quick check: most letters have plenty; just confirm existence
  for (const w of DICT) {
    if (w[0] === letter && !used.has(w)) return true;
  }
  return false;
}

// ---------- Rooms ----------
/*
room = {
  id, name, players: Map(clientId -> player), state: 'lobby'|'countdown'|'playing'|'ended',
  hostId, order: [clientId...], turnIndex, currentLetter, usedWords: Set,
  timer, countdownTimer, turnDeadline, winnerId
}
player = { id, nick, hearts, alive, ws, connected }
*/
const rooms = new Map();

function publicRoomList() {
  return [...rooms.values()]
    .filter(r => r.state === 'lobby' || r.state === 'countdown')
    .map(r => ({
      id: r.id,
      name: r.name,
      players: r.players.size,
      max: MAX_PLAYERS,
      state: r.state,
    }));
}

function broadcastLobby() {
  const msg = JSON.stringify({ type: 'roomList', rooms: publicRoomList() });
  for (const ws of lobbyWatchers) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function roomStatePayload(room) {
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
      usedCount: room.usedWords.size,
      players: room.order
        .map(id => room.players.get(id))
        .filter(Boolean)
        .map(p => ({ id: p.id, nick: p.nick, hearts: p.hearts, alive: p.alive, connected: p.connected })),
      // also include players not yet in order (lobby)
      lobbyPlayers: [...room.players.values()].map(p => ({ id: p.id, nick: p.nick, hearts: p.hearts, alive: p.alive, connected: p.connected })),
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
  if (room.players.size < MIN_PLAYERS) return;
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
  room.order = [...room.players.keys()];
  // shuffle order
  for (let i = room.order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.order[i], room.order[j]] = [room.order[j], room.order[i]];
  }
  for (const p of room.players.values()) { p.hearts = START_HEARTS; p.alive = true; }
  room.turnIndex = 0;
  // initial set of random letters; first player picks one
  room.startLetters = makeStartLetters();
  room.currentLetter = null; // null means "pick from startLetters"
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
    roomEvent(room, `💀 Talo na si ${p.nick}!`, 'dead');
  }
  pushRoomState(room);
  if (checkGameOver(room)) return;
  // If player timed out during pick-mode, keep pick-mode for next player too
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
  // move to next alive player
  let guard = 0;
  do {
    room.turnIndex = (room.turnIndex + 1) % room.order.length;
    guard++;
  } while (!(room.players.get(room.order[room.turnIndex]) || {}).alive && guard <= room.order.length);
  pushRoomState(room);
  startTurnTimer(room);
}

function handleWord(room, player, rawWord) {
  if (room.state !== 'playing') return;
  const pid = room.order[room.turnIndex];
  if (pid !== player.id) {
    player.ws.send(JSON.stringify({ type: 'rejected', reason: 'Hindi pa ikaw ang turn.' }));
    return;
  }
  const word = String(rawWord || '').trim().toLowerCase();
  // pick-mode: first move OR after a timeout in pick-mode -> player must choose a start letter implicitly via first letter of word
  if (room.currentLetter === null) {
    if (!/^[a-z]+$/.test(word) || word.length < 2) {
      player.ws.send(JSON.stringify({ type: 'rejected', reason: 'Letters lang at least 2 ang haba.' }));
      return;
    }
    if (!room.startLetters.map(l => l.toLowerCase()).includes(word[0])) {
      player.ws.send(JSON.stringify({ type: 'rejected', reason: `Dapat magsimula sa isa sa: ${room.startLetters.join(', ')}` }));
      return;
    }
    if (!DICT.has(word)) {
      player.ws.send(JSON.stringify({ type: 'rejected', reason: `"${word}" ay wala sa diksyunaryo.` }));
      return;
    }
    acceptWord(room, player, word);
    return;
  }
  // normal mode
  if (!/^[a-z]+$/.test(word) || word.length < 2) {
    player.ws.send(JSON.stringify({ type: 'rejected', reason: 'Letters lang at least 2 ang haba.' }));
    return;
  }
  if (word[0] !== room.currentLetter.toLowerCase()) {
    player.ws.send(JSON.stringify({ type: 'rejected', reason: `Dapat magsimula sa "${room.currentLetter.toUpperCase()}".` }));
    return;
  }
  if (room.usedWords.has(word)) {
    player.ws.send(JSON.stringify({ type: 'rejected', reason: `"${word}" ay nagamit na.` }));
    return;
  }
  if (!DICT.has(word)) {
    player.ws.send(JSON.stringify({ type: 'rejected', reason: `"${word}" ay wala sa diksyunaryo.` }));
    return;
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
  ws.id = uid();
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
    case 'watchLobby': {
      ws.isLobby = true;
      lobbyWatchers.add(ws);
      ws.send(JSON.stringify({ type: 'roomList', rooms: publicRoomList() }));
      break;
    }
    case 'stopWatchLobby': {
      lobbyWatchers.delete(ws);
      break;
    }
    case 'createRoom': {
      const nick = sanitizeNick(msg.nick);
      const name = sanitizeRoomName(msg.roomName) || `${nick}'s Room`;
      const room = {
        id: uid(),
        name,
        players: new Map(),
        state: 'lobby',
        hostId: ws.id,
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
      if (room.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: 'Puno na ang room.' })); return; }
      if (room.state === 'playing' || room.state === 'ended') { ws.send(JSON.stringify({ type: 'error', message: 'Naglalaro na — hintayin ang susunod.' })); return; }
      joinRoomInternal(ws, room, nick);
      broadcastLobby();
      break;
    }
    case 'leaveRoom': {
      leaveRoom(ws);
      break;
    }
    case 'startGame': {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.id) { ws.send(JSON.stringify({ type: 'error', message: 'Host lang ang pwedeng mag-start.' })); return; }
      if (room.players.size < MIN_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: `Kailangan ng at least ${MIN_PLAYERS} players.` })); return; }
      startCountdown(room);
      break;
    }
    case 'submitWord': {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const player = room.players.get(ws.id);
      if (!player) return;
      handleWord(room, player, msg.word);
      break;
    }
    case 'playAgain': {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.id) return;
      if (room.state !== 'ended') return;
      room.state = 'lobby';
      room.winnerId = null;
      room.usedWords = new Set();
      for (const p of room.players.values()) { p.hearts = START_HEARTS; p.alive = true; }
      pushRoomState(room);
      broadcastLobby();
      break;
    }
  }
}

function joinRoomInternal(ws, room, nick) {
  // remove from any previous room
  if (ws.roomId && ws.roomId !== room.id) leaveRoom(ws);
  ws.roomId = room.id;
  lobbyWatchers.delete(ws);
  const player = { id: ws.id, nick, hearts: START_HEARTS, alive: true, ws, connected: true };
  room.players.set(ws.id, player);
  if (!room.order.includes(ws.id)) room.order.push(ws.id);
  ws.send(JSON.stringify({ type: 'joined', roomId: room.id, youId: ws.id, hostId: room.hostId }));
  roomEvent(room, `👋 Sumali si ${nick}`, 'join');
  pushRoomState(room);
}

function leaveRoom(ws) {
  const room = rooms.get(ws.roomId);
  ws.roomId = null;
  if (!room) return;
  const player = room.players.get(ws.id);
  const nick = player ? player.nick : '?';
  room.players.delete(ws.id);
  room.order = room.order.filter(id => id !== ws.id);
  roomEvent(room, `🚪 Umalis si ${nick}`, 'leave');

  if (room.players.size === 0) {
    cleanupRoom(room);
    broadcastLobby();
    return;
  }
  // reassign host
  if (room.hostId === ws.id) {
    room.hostId = room.players.keys().next().value;
  }
  // if game in progress and player left
  if (room.state === 'playing') {
    // if it was their turn, advance
    const wasTurn = room.order[room.turnIndex] === ws.id;
    if (!checkGameOver(room)) {
      if (wasTurn) {
        clearTurnTimer(room);
        room.turnIndex = room.turnIndex % Math.max(1, room.order.length);
        // ensure pointing at alive
        if (!(room.players.get(room.order[room.turnIndex]) || {}).alive) advanceTurn(room);
        else startTurnTimer(room);
      }
    }
  }
  if (room.state === 'countdown' && room.players.size < MIN_PLAYERS) {
    cancelCountdown(room);
  }
  pushRoomState(room);
  broadcastLobby();
}

function handleDisconnect(ws) {
  lobbyWatchers.delete(ws);
  if (ws.roomId) leaveRoom(ws);
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
