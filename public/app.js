// ===== Complete the Word — Client =====
const $ = id => document.getElementById(id);
const screens = {
  login: $('screen-login'), lobby: $('screen-lobby'), room: $('screen-room'),
  game: $('screen-game'), over: $('screen-over'),
};
function show(name){ Object.values(screens).forEach(s=>s.classList.remove('active')); screens[name].classList.add('active'); }

const AVATAR_COLORS = ['#ff5e7e','#ffd166','#3ddc97','#7c5cff','#4cc9f0','#f15bb5'];
function avatarColor(id){ let h=0; for(const c of id) h=(h*31+c.charCodeAt(0))>>>0; return AVATAR_COLORS[h%AVATAR_COLORS.length]; }
function heartsStr(n){ return '❤️'.repeat(Math.max(0,n)) + '🖤'.repeat(Math.max(0,3-n)); }

// ---------- persistent identity (survives Chrome refresh) ----------
const LS_KEY = 'ctw.session.v1';
function loadSession(){
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function saveSession(patch){
  const cur = loadSession();
  const next = { ...cur, ...patch };
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return next;
}
function clearSessionRoom(){ saveSession({ roomId: null }); }

let session = loadSession();
let ws=null, nick=session.nick||'', youId=session.token||null, roomId=session.roomId||null, hostId=null;
let currentRoom=null, selectedLetter=null;
let timerRAF=null, timerDeadline=0, timerTotal=12;
let amSpectator=false;
let reconnectAttempts=0;

// ---------- connection ----------
function connect(){
  const proto = location.protocol==='https:'?'wss':'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = ()=>{
    reconnectAttempts = 0;
    // Always say hello with our (possibly empty) token; server will issue one if missing
    sendMsg({ type:'hello', token: youId || session.token || '' });
  };
  ws.onmessage = ev=>handle(JSON.parse(ev.data));
  ws.onclose = ()=>{
    // Try to reconnect automatically (don't reload the page, so UI state stays)
    reconnectAttempts++;
    const delay = Math.min(5000, 600 * reconnectAttempts);
    toast('Naputol ang koneksyon… nire-reconnect');
    setTimeout(connect, delay);
  };
  ws.onerror = ()=>{ /* handled in onclose */ };
}
function sendMsg(o){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(o)); }
function watchLobby(){ sendMsg({type:'watchLobby'}); }

// ---------- toast ----------
let toastT=null;
function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2600); }

// ---------- login ----------
function doEnter(){
  const v=$('nick').value.trim();
  if(v.length<1){ toast('Maglagay ng nickname!'); return; }
  nick=v.slice(0,16);
  saveSession({ nick });
  $('lobbyNick').textContent=nick;
  if(!ws || ws.readyState>1) connect();
  show('lobby');
  const wait=setInterval(()=>{ if(ws&&ws.readyState===1){ watchLobby(); clearInterval(wait);} },120);
}
$('enterBtn').onclick=doEnter;
$('nick').addEventListener('keydown',e=>{ if(e.key==='Enter') doEnter(); });

// ---------- lobby ----------
$('refreshBtn').onclick=watchLobby;
$('createBtn').onclick=()=>{ sendMsg({type:'createRoom', nick, roomName:`${nick}'s Room`}); };
function renderRooms(rooms){
  const el=$('roomlist');
  if(!rooms.length){ el.innerHTML='<div class="empty">Walang available na room.<br>Gumawa ng bago! 👆</div>'; return; }
  el.innerHTML='';
  rooms.forEach(r=>{
    const inGame = (r.state==='playing' || r.state==='ended');
    const div=document.createElement('div');
    div.className='roomitem';
    let stateLabel = 'naghihintay';
    if(r.state==='countdown') stateLabel = 'magsisimula na…';
    else if(r.state==='playing') stateLabel = '🟢 IN GAME';
    else if(r.state==='ended') stateLabel = 'tapos na';
    div.innerHTML=`<div><div style="font-weight:700">${esc(r.name)} ${inGame?'<span class="badge live">LIVE</span>':''}</div>
      <div class="meta">${r.players}/${r.max} players • ${stateLabel}</div></div>`;
    const btn=document.createElement('button');
    btn.className='btn small';
    if(inGame){
      btn.textContent='👁️ Manood';
      btn.disabled=false;
      btn.onclick=()=>sendMsg({type:'joinRoom', roomId:r.id, nick});
    } else {
      const full = !r.canJoin;
      btn.textContent = full?'Puno':'Sali';
      btn.disabled = full;
      btn.onclick=()=>sendMsg({type:'joinRoom', roomId:r.id, nick});
    }
    div.appendChild(btn);
    el.appendChild(div);
  });
}

// ---------- room ----------
$('leaveBtn').onclick=()=>{ sendMsg({type:'leaveRoom'}); roomId=null; clearSessionRoom(); amSpectator=false; show('lobby'); watchLobby(); };
$('startBtn').onclick=()=>sendMsg({type:'startGame'});

function renderRoom(room){
  $('roomTitle').textContent=room.name;
  const list = room.lobbyPlayers||[];
  const activeCount = list.filter(p=>!p.isSpectator).length;
  $('roomStatePill').textContent = room.state==='countdown'?'Magsisimula na…':`${activeCount}/4 players`;
  const pe=$('roomPlayers'); pe.innerHTML='';
  list.forEach(p=>pe.appendChild(playerCard(p,room.hostId,false)));
  const isHost = room.hostId===youId;
  const enough = activeCount>=2;
  $('startBtn').style.display = isHost?'block':'none';
  $('startBtn').disabled = !enough;
  $('waitHint').textContent = isHost
    ? (enough?'Handa na! Pindutin ang Simulan.':'Kailangan ng at least 2 players para magsimula.')
    : 'Naghihintay ng host na magsimula…';
}

function playerCard(p, hostIdLocal, inGame){
  const d=document.createElement('div');
  d.className='pcard'+(!p.alive&&inGame?' dead':'')+(p.isSpectator?' spectator':'')+(!p.connected?' offline':'');
  const initial=(p.nick[0]||'?').toUpperCase();
  let tags='';
  if(p.id===hostIdLocal) tags+='<span class="tag host">HOST</span>';
  if(p.id===youId) tags+='<span class="tag you">IKAW</span>';
  if(p.isSpectator) tags+='<span class="tag spec">SPECTATOR</span>';
  if(!p.connected) tags+='<span class="tag off">OFFLINE</span>';
  d.innerHTML=`<div class="avatar" style="background:${avatarColor(p.id)}">${esc(initial)}</div>
    <div class="pname"><span>${esc(p.nick)}</span>${tags}</div>
    <div class="hearts">${inGame && !p.isSpectator?heartsStr(p.hearts):''}</div>`;
  d.dataset.pid=p.id;
  return d;
}

// ---------- game ----------
function renderGamePlayers(room){
  const pe=$('gamePlayers'); pe.innerHTML='';
  // include both order-players (active) and any spectators
  const ids = new Set((room.players||[]).map(p=>p.id));
  const all = [...(room.players||[])];
  (room.lobbyPlayers||[]).forEach(p=>{ if(!ids.has(p.id)) all.push(p); });
  all.forEach(p=>{
    const c=playerCard(p,room.hostId,true);
    if(room.turnPlayerId===p.id) c.classList.add('turn');
    pe.appendChild(c);
  });
}

function setTurnUI(room){
  const me=(room.lobbyPlayers||room.players||[]).find(p=>p.id===youId);
  amSpectator = !!(me && me.isSpectator);
  const myTurn = !amSpectator && room.turnPlayerId===youId;
  const turnP=(room.players||[]).find(p=>p.id===room.turnPlayerId);
  if(amSpectator){
    $('turnLabel').textContent = turnP ? `👁️ Spectator mode — Turn ni ${turnP.nick}…` : '👁️ Spectator mode';
  } else {
    $('turnLabel').textContent = myTurn ? '👉 IKAW ang turn!' : (turnP?`Turn ni ${turnP.nick}…`:'—');
  }
  $('bigLetter').textContent = room.currentLetter || '?';
  const canPlay = myTurn && me && me.alive && !me.isSpectator;
  $('wordInput').disabled=!canPlay;
  $('submitBtn').disabled=!canPlay;
  // Show/hide input zone for spectators
  $('inputZone').style.display = amSpectator ? 'none' : 'block';
  if(canPlay){ setTimeout(()=>$('wordInput').focus(),50); }
}

function startTimer(deadline, total){
  timerDeadline=deadline; timerTotal=total;
  cancelAnimationFrame(timerRAF);
  const fill=$('timerFill'), num=$('timerNum');
  function tick(){
    const left=Math.max(0,timerDeadline-Date.now());
    const pct=Math.max(0,Math.min(100,(left/(timerTotal*1000))*100));
    fill.style.width=pct+'%';
    fill.style.background = pct<30?'#ff5e5e':(pct<60?'#ffd166':'linear-gradient(90deg,#3ddc97,#ffd166)');
    num.textContent=(left/1000).toFixed(1)+'s';
    if(left>0) timerRAF=requestAnimationFrame(tick);
  }
  tick();
}
function stopTimer(){ cancelAnimationFrame(timerRAF); }

function renderLetters(letters, active){
  const row=$('lettersRow');
  if(!letters){ row.style.display='none'; return; }
  row.style.display='flex'; row.innerHTML=''; selectedLetter=null;
  letters.forEach(L=>{
    const b=document.createElement('button');
    b.className='lbtn'; b.textContent=L;
    b.disabled=!active;
    b.onclick=()=>{
      document.querySelectorAll('.lbtn').forEach(x=>x.classList.remove('sel'));
      b.classList.add('sel'); selectedLetter=L;
      $('bigLetter').textContent=L;
      $('wordInput').focus();
    };
    row.appendChild(b);
  });
}

function submitWord(){
  let w=$('wordInput').value.trim().toLowerCase();
  if(!w) return;
  sendMsg({type:'submitWord', word:w});
}
$('submitBtn').onclick=submitWord;
$('wordInput').addEventListener('keydown',e=>{ if(e.key==='Enter') submitWord(); });

function addLog(text, kind){
  const log=$('log');
  const d=document.createElement('div');
  d.className=kind||''; d.textContent=text;
  log.appendChild(d);
  log.scrollTop=log.scrollHeight;
  while(log.children.length>40) log.removeChild(log.firstChild);
}

// ---------- game over ----------
$('againBtn').onclick=()=>{ sendMsg({type:'playAgain'}); };
$('backLobbyBtn').onclick=()=>{ sendMsg({type:'leaveRoom'}); roomId=null; clearSessionRoom(); amSpectator=false; show('lobby'); watchLobby(); };

// ---------- overlay countdown ----------
function showCountdown(v){
  const ov=$('overlay'), n=$('cdNum');
  ov.classList.add('show'); n.textContent=v;
  n.style.animation='none'; void n.offsetWidth; n.style.animation='pop .9s ease';
}
function hideCountdown(){ $('overlay').classList.remove('show'); }

// ---------- message handler ----------
function handle(m){
  switch(m.type){
    case 'welcome':
      // server confirms our token & may resume a room
      if(m.token){ youId = m.token; saveSession({ token: m.token }); }
      if(m.resumedRoomId){
        roomId = m.resumedRoomId;
        saveSession({ roomId });
      } else {
        // No active room. If we have a saved nick, jump to lobby; else show login.
        if(nick){
          $('lobbyNick').textContent=nick;
          show('lobby');
          watchLobby();
        } else {
          show('login');
        }
      }
      break;
    case 'roomList': renderRooms(m.rooms); break;
    case 'joined':
      roomId=m.roomId; youId=m.youId; hostId=m.hostId;
      saveSession({ roomId, token: youId });
      if(m.spectator){ amSpectator = true; toast('🟢 Sumali ka bilang spectator'); }
      if(!m.resumed) show('room');
      break;
    case 'roomState':
      currentRoom=m.room;
      hostId = m.room.hostId;
      // Update spectator status for me
      const me = (m.room.lobbyPlayers||[]).find(p=>p.id===youId);
      amSpectator = !!(me && me.isSpectator);
      if(m.room.state==='lobby'||m.room.state==='countdown'){
        if(!screens.over.classList.contains('active')) show('room');
        renderRoom(m.room);
      } else if(m.room.state==='playing'){
        show('game'); renderGamePlayers(m.room); setTurnUI(m.room);
        // If we have a turn deadline and timer isn't running yet, start it
        if(m.room.turnDeadline){ startTimer(m.room.turnDeadline, m.room.turnSeconds||12); }
      } else if(m.room.state==='ended'){
        renderGamePlayers(m.room);
      }
      break;
    case 'countdown':
      if(m.value>0){ showCountdown(m.value); } break;
    case 'pickLetter':
      hideCountdown();
      show('game');
      $('rejected').textContent='';
      $('log').innerHTML='';
      break;
    case 'turn':{
      hideCountdown();
      $('rejected').textContent='';
      $('wordInput').value='';
      const myTurn = !amSpectator && m.turnPlayerId===youId;
      if(m.pickMode){
        renderLetters(m.letters, myTurn);
        if(amSpectator){
          $('turnLabel').textContent = '👁️ Spectator — pumipili ng letra ang player…';
        } else {
          $('turnLabel').textContent = myTurn?'👉 Pumili ng letra at bumuo ng salita!':'Pumipili pa ang kalaban…';
        }
        $('bigLetter').textContent = '?';
      } else {
        renderLetters(null,false);
      }
      startTimer(m.deadline, m.seconds);
      break;
    }
    case 'wordAccepted':
      addLog(`✅ ${m.by}: ${m.word.toUpperCase()} → ${m.nextLetter}`, 'word');
      $('wordInput').value='';
      $('rejected').textContent='';
      break;
    case 'rejected':
      $('rejected').textContent='✖ '+m.reason;
      $('wordInput').select();
      break;
    case 'event':
      addLog(m.text, m.kind);
      break;
    case 'youSpectate':
      amSpectator = true;
      toast('💀 Naubos ang hearts mo — spectator ka na. Manood ka muna!');
      // Refresh game UI to hide input
      if(currentRoom) setTurnUI(currentRoom);
      break;
    case 'gameOver':
      stopTimer();
      setTimeout(()=>{
        show('over');
        if(m.winnerId===youId){ $('winName').textContent='🎉 IKAW ang Panalo!'; $('winSub').textContent='Matira matibay champion!'; }
        else if(m.winnerNick){ $('winName').textContent=`Panalo si ${m.winnerNick}`; $('winSub').textContent='Mas swerte sa susunod!'; }
        else { $('winName').textContent='Tabla!'; $('winSub').textContent='Walang natira.'; }
        $('againBtn').style.display = (hostId===youId)?'block':'none';
      }, 700);
      break;
    case 'error':
      toast(m.message); break;
  }
  if(currentRoom) hostId=currentRoom.hostId;
}

function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ---------- BOOT: auto-restore on page load ----------
(function boot(){
  if(nick){
    $('nick').value = nick;
    $('lobbyNick').textContent = nick;
  }
  // Always connect right away so we can resume an existing room
  connect();
  // Initial screen decision will be finalized by 'welcome' message:
  //  - if server resumes us into a room => 'joined' will push us in
  //  - if not, and we have a nick => go to lobby
  //  - else => stay on login
  if(roomId || nick){
    // show a loading-ish lobby while waiting for welcome
    show('lobby');
    $('roomlist').innerHTML='<div class="empty">Kumokonekta…</div>';
  } else {
    show('login');
  }
})();
