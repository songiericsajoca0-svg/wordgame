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

let ws=null, nick='', youId=null, roomId=null, hostId=null;
let currentRoom=null, selectedLetter=null;
let timerRAF=null, timerDeadline=0, timerTotal=12;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ---------- Persistence ----------
function saveState() {
  try {
    localStorage.setItem('ctw_nick', nick);
    localStorage.setItem('ctw_roomId', roomId || '');
    localStorage.setItem('ctw_youId', youId || '');
  } catch(e) {}
}

function loadState() {
  try {
    const savedNick = localStorage.getItem('ctw_nick');
    const savedRoomId = localStorage.getItem('ctw_roomId');
    const savedYouId = localStorage.getItem('ctw_youId');
    return { nick: savedNick, roomId: savedRoomId, youId: savedYouId };
  } catch(e) { return {}; }
}

// ---------- connection ----------
function connect(){
  const proto = location.protocol==='https:'?'wss':'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = ()=>{ 
    reconnectAttempts = 0;
    // Restore nick
    if (nick) {
      sendMsg({type:'setNick', nick});
    }
    // Try to rejoin previous room
    const saved = loadState();
    if (saved.roomId && saved.youId) {
      sendMsg({type:'getRoomState', roomId: saved.roomId});
    }
    if (screens.lobby.classList.contains('active')) watchLobby(); 
  };
  ws.onmessage = ev=>handle(JSON.parse(ev.data));
  ws.onclose = ()=>{ 
    toast('Naputol ang koneksyon. Nagre-reconnect…');
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      setTimeout(connect, 2000 * reconnectAttempts);
    } else {
      toast('Hindi makakonek. I-refresh ang page.');
    }
  };
}

function sendMsg(o){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(o)); }
function watchLobby(){ sendMsg({type:'watchLobby'}); }

// ---------- toast ----------
let toastT=null;
function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2600); }

// ---------- login ----------
$('enterBtn').onclick=()=>{
  const v=$('nick').value.trim();
  if(v.length<1){ toast('Maglagay ng nickname!'); return; }
  nick=v.slice(0,16);
  $('lobbyNick').textContent=nick;
  saveState();
  connect();
  show('lobby');
  const wait=setInterval(()=>{ if(ws&&ws.readyState===1){ watchLobby(); clearInterval(wait);} },120);
};

// Auto-login if we have saved state
window.onload = function() {
  const saved = loadState();
  if (saved.nick) {
    nick = saved.nick;
    $('nick').value = nick;
    $('lobbyNick').textContent = nick;
    // Auto-connect
    connect();
    show('lobby');
    const wait=setInterval(()=>{ if(ws&&ws.readyState===1){ watchLobby(); clearInterval(wait);} },120);
  }
};

$('nick').addEventListener('keydown',e=>{ if(e.key==='Enter') $('enterBtn').click(); });

// ---------- lobby ----------
$('refreshBtn').onclick=watchLobby;
$('createBtn').onclick=()=>{ sendMsg({type:'createRoom', nick, roomName:`${nick}'s Room`}); };
function renderRooms(rooms){
  const el=$('roomlist');
  if(!rooms || !rooms.length){ 
    el.innerHTML='<div class="empty">Walang available na room.<br>Gumawa ng bago! 👆</div>'; 
    return; 
  }
  el.innerHTML='';
  rooms.forEach(r=>{
    const full=r.players>=r.max;
    const inGame = r.state === 'playing' || r.state === 'ended';
    const div=document.createElement('div');
    div.className='roomitem';
    div.innerHTML=`<div><div style="font-weight:700">${esc(r.name)}</div>
      <div class="meta">${r.players}/${r.max} players • ${inGame ? '🔴 Naglalaro' : (r.state==='countdown'?'⏳ Magsisimula…':'🟢 Naghihintay')}</div></div>`;
    const btn=document.createElement('button');
    btn.className='btn small';
    if (inGame) {
      btn.textContent='🔴 In Game';
      btn.disabled=true;
    } else if (full) {
      btn.textContent='Puno';
      btn.disabled=true;
    } else {
      btn.textContent='Sali';
      btn.onclick=()=>sendMsg({type:'joinRoom', roomId:r.id, nick});
    }
    div.appendChild(btn);
    el.appendChild(div);
  });
}

// ---------- room ----------
$('leaveBtn').onclick=()=>{ 
  sendMsg({type:'leaveRoom'}); 
  roomId=null; 
  youId=null;
  localStorage.removeItem('ctw_roomId');
  localStorage.removeItem('ctw_youId');
  show('lobby'); 
  watchLobby(); 
};
$('startBtn').onclick=()=>sendMsg({type:'startGame'});

function renderRoom(room){
  $('roomTitle').textContent=room.name;
  const list = room.lobbyPlayers||[];
  $('roomStatePill').textContent = room.state==='countdown'?'Magsisimula na…':`${list.length}/4 players`;
  const pe=$('roomPlayers'); pe.innerHTML='';
  list.forEach(p=>pe.appendChild(playerCard(p,room.hostId,false)));
  const isHost = room.hostId===youId;
  const enough = list.length>=2;
  $('startBtn').style.display = isHost?'block':'none';
  $('startBtn').disabled = !enough;
  $('waitHint').textContent = isHost
    ? (enough?'Handa na! Pindutin ang Simulan.':'Kailangan ng at least 2 players para magsimula.')
    : 'Naghihintay ng host na magsimula…';
}

function playerCard(p, hostIdLocal, inGame){
  const d=document.createElement('div');
  d.className='pcard';
  if (inGame) {
    if (!p.alive) d.classList.add('dead');
    if (p.isSpectator) d.classList.add('spectator');
  }
  const initial=(p.nick[0]||'?').toUpperCase();
  let tags='';
  if(p.id===hostIdLocal) tags+='<span class="tag host">HOST</span>';
  if(p.id===youId) tags+='<span class="tag you">IKAW</span>';
  if(p.isSpectator) tags+='<span class="tag spectator-tag">👀 SPECTATOR</span>';
  d.innerHTML=`<div class="avatar" style="background:${avatarColor(p.id)}">${esc(initial)}</div>
    <div class="pname"><span>${esc(p.nick)}</span>${tags}</div>
    <div class="hearts">${inGame?heartsStr(p.hearts):''}</div>`;
  d.dataset.pid=p.id;
  return d;
}

// ---------- game ----------
function renderGamePlayers(room){
  const pe=$('gamePlayers'); pe.innerHTML='';
  (room.players||[]).forEach(p=>{
    const c=playerCard(p,room.hostId,true);
    if(room.turnPlayerId===p.id && p.alive) c.classList.add('turn');
    pe.appendChild(c);
  });
}

function setTurnUI(room){
  const myTurn = room.turnPlayerId===youId;
  const me=(room.players||[]).find(p=>p.id===youId);
  const turnP=(room.players||[]).find(p=>p.id===room.turnPlayerId);
  
  const isSpectator = me && !me.alive;
  
  if (isSpectator) {
    $('turnLabel').textContent = '👀 Nanonood ka na (spectator)';
    $('bigLetter').textContent = room.currentLetter || '?';
    $('wordInput').disabled=true;
    $('submitBtn').disabled=true;
    renderLetters(null, false);
    return;
  }
  
  $('turnLabel').textContent = myTurn ? '👉 IKAW ang turn!' : (turnP?`Turn ni ${turnP.nick}…`:'—');
  $('bigLetter').textContent = room.currentLetter || '?';
  const canPlay = myTurn && me && me.alive;
  $('wordInput').disabled=!canPlay;
  $('submitBtn').disabled=!canPlay;
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
$('backLobbyBtn').onclick=()=>{ 
  sendMsg({type:'leaveRoom'}); 
  roomId=null; 
  youId=null;
  localStorage.removeItem('ctw_roomId');
  localStorage.removeItem('ctw_youId');
  show('lobby'); 
  watchLobby(); 
};

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
    case 'roomList': renderRooms(m.rooms); break;
    case 'joined':
      roomId=m.roomId; youId=m.youId; hostId=m.hostId;
      saveState();
      show('room'); 
      break;
    case 'roomState':
      currentRoom=m.room;
      if (m.room.state==='lobby'||m.room.state==='countdown'){
        if(!screens.over.classList.contains('active')) show('room');
        renderRoom(m.room);
      } else if(m.room.state==='playing'){
        show('game'); 
        renderGamePlayers(m.room); 
        setTurnUI(m.room);
        // Check if we're a spectator
        const me = (m.room.players||[]).find(p=>p.id===youId);
        if (me && !me.alive) {
          $('turnLabel').textContent = '👀 Nanonood ka na (spectator)';
          $('wordInput').disabled=true;
          $('submitBtn').disabled=true;
        }
      } else if(m.room.state==='ended'){
        renderGamePlayers(m.room);
        // Check if we should show game over
        setTimeout(()=>{
          if (m.room.winnerId === youId) {
            show('over');
            $('winName').textContent='🎉 IKAW ang Panalo!';
            $('winSub').textContent='Matira matibay champion!';
          } else if (m.room.winnerId) {
            const winner = (m.room.players||[]).find(p=>p.id===m.room.winnerId);
            show('over');
            $('winName').textContent=`🏆 Panalo si ${winner ? winner.nick : '?'}`;
            $('winSub').textContent='Mas swerte sa susunod!';
          }
          $('againBtn').style.display = (hostId===youId)?'block':'none';
        }, 700);
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
      const me = (currentRoom && currentRoom.players||[]).find(p=>p.id===youId);
      const isSpectator = me && !me.alive;
      
      if (isSpectator) {
        renderLetters(null, false);
        $('turnLabel').textContent = '👀 Nanonood ka na (spectator)';
        $('wordInput').disabled=true;
        $('submitBtn').disabled=true;
        startTimer(m.deadline, m.seconds);
        return;
      }
      
      const myTurn = m.turnPlayerId===youId;
      if(m.pickMode){
        renderLetters(m.letters, myTurn);
        $('turnLabel').textContent = myTurn?'👉 Pumili ng letra at bumuo ng salita!':'Pumipili pa ang kalaban…';
        $('bigLetter').textContent = myTurn?'?':'?';
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
    case 'gameOver':
      stopTimer();
      break;
    case 'error':
      toast(m.message); break;
  }
  if(currentRoom) hostId=currentRoom.hostId;
}

function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
