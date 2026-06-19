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

// ============================================================
// AUDIO ENGINE — theme music + sound effects
// CC0/Free Mixkit CDN urls (preview mp3s). Falls back to Web Audio synth if blocked.
// ============================================================
const SFX_URLS = {
  click:    'https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3', // soft UI click
  join:     'https://assets.mixkit.co/active_storage/sfx/270/270-preview.mp3',   // happy bell
  start:    'https://assets.mixkit.co/active_storage/sfx/2018/2018-preview.mp3', // game start fanfare
  countdown:'https://assets.mixkit.co/active_storage/sfx/2575/2575-preview.mp3', // tick
  accept:   'https://assets.mixkit.co/active_storage/sfx/220/220-preview.mp3',   // correct ding
  reject:   'https://assets.mixkit.co/active_storage/sfx/2017/2017-preview.mp3', // error buzz
  timeout:  'https://assets.mixkit.co/active_storage/sfx/2019/2019-preview.mp3', // negative
  heart:    'https://assets.mixkit.co/active_storage/sfx/2020/2020-preview.mp3', // heart loss
  dead:     'https://assets.mixkit.co/active_storage/sfx/1432/1432-preview.mp3', // sad lose
  win:      'https://assets.mixkit.co/active_storage/sfx/1689/1689-preview.mp3', // win fanfare
  myTurn:   'https://assets.mixkit.co/active_storage/sfx/255/255-preview.mp3',   // alert ping
  leave:    'https://assets.mixkit.co/active_storage/sfx/1010/1010-preview.mp3', // soft pop
};
const THEME_URL = 'https://assets.mixkit.co/active_storage/sfx/2696/2696-preview.mp3'; // upbeat loopable

const Audio = (function(){
  const cache = {};
  let muted = JSON.parse(localStorage.getItem('ctw.muted')||'false');
  let musicMuted = JSON.parse(localStorage.getItem('ctw.musicMuted')||'false');
  let theme = null;
  let actx = null;
  let unlocked = false;

  function ensureCtx(){
    if(!actx){
      try { actx = new (window.AudioContext||window.webkitAudioContext)(); } catch {}
    }
    if(actx && actx.state==='suspended') actx.resume();
  }

  // Web Audio fallback "beep" for any SFX that fails to load
  function synth(name){
    ensureCtx(); if(!actx) return;
    const presets = {
      click:    [{f:600,d:.05,t:'square',g:.08}],
      join:     [{f:660,d:.08,t:'sine',g:.15},{f:880,d:.1,t:'sine',g:.15,delay:.08}],
      start:    [{f:523,d:.12,t:'triangle',g:.2},{f:659,d:.12,t:'triangle',g:.2,delay:.12},{f:784,d:.18,t:'triangle',g:.2,delay:.24}],
      countdown:[{f:880,d:.06,t:'square',g:.1}],
      accept:   [{f:880,d:.08,t:'sine',g:.2},{f:1320,d:.12,t:'sine',g:.18,delay:.08}],
      reject:   [{f:200,d:.18,t:'sawtooth',g:.22},{f:150,d:.18,t:'sawtooth',g:.22,delay:.06}],
      timeout:  [{f:330,d:.15,t:'square',g:.2},{f:220,d:.25,t:'square',g:.2,delay:.15}],
      heart:    [{f:180,d:.2,t:'triangle',g:.25}],
      dead:     [{f:300,d:.2,t:'sawtooth',g:.2},{f:220,d:.3,t:'sawtooth',g:.2,delay:.2},{f:140,d:.4,t:'sawtooth',g:.2,delay:.45}],
      win:      [{f:523,d:.12,t:'triangle',g:.22},{f:659,d:.12,t:'triangle',g:.22,delay:.12},{f:784,d:.12,t:'triangle',g:.22,delay:.24},{f:1047,d:.3,t:'triangle',g:.22,delay:.36}],
      myTurn:   [{f:1200,d:.08,t:'sine',g:.2},{f:1500,d:.1,t:'sine',g:.2,delay:.09}],
      leave:    [{f:400,d:.08,t:'sine',g:.12}],
    };
    const list = presets[name]||presets.click;
    list.forEach(p=>{
      const start = actx.currentTime + (p.delay||0);
      const osc = actx.createOscillator();
      const g = actx.createGain();
      osc.type = p.t; osc.frequency.value = p.f;
      g.gain.value = 0;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(p.g, start+0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, start+p.d);
      osc.connect(g).connect(actx.destination);
      osc.start(start); osc.stop(start+p.d+0.02);
    });
  }

  function load(name){
    if(cache[name]) return cache[name];
    const url = SFX_URLS[name];
    if(!url){ return null; }
    const a = new window.Audio(url);
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';
    a.volume = 0.55;
    a.dataset.failed = '0';
    a.addEventListener('error', ()=>{ a.dataset.failed='1'; });
    cache[name] = a;
    return a;
  }
  function preload(){
    Object.keys(SFX_URLS).forEach(load);
  }

  function play(name){
    if(muted) return;
    ensureCtx();
    const a = load(name);
    if(!a){ synth(name); return; }
    if(a.dataset.failed==='1'){ synth(name); return; }
    try {
      // clone so overlapping plays work
      const n = a.cloneNode(true);
      n.volume = a.volume;
      const p = n.play();
      if(p && p.catch){ p.catch(()=>synth(name)); }
    } catch { synth(name); }
  }

  function startTheme(){
    if(musicMuted) return;
    if(!theme){
      theme = new window.Audio(THEME_URL);
      theme.loop = true;
      theme.volume = 0.18;
      theme.crossOrigin = 'anonymous';
      theme.addEventListener('error', ()=>{ /* silent if fails */ });
    }
    const p = theme.play();
    if(p && p.catch){ p.catch(()=>{ /* will retry on next user click */ }); }
  }
  function stopTheme(){ if(theme){ try{ theme.pause(); }catch{} } }
  function setMusicMuted(v){
    musicMuted = !!v;
    localStorage.setItem('ctw.musicMuted', JSON.stringify(musicMuted));
    if(musicMuted) stopTheme(); else startTheme();
  }
  function setMuted(v){
    muted = !!v;
    localStorage.setItem('ctw.muted', JSON.stringify(muted));
  }
  function isMuted(){ return muted; }
  function isMusicMuted(){ return musicMuted; }

  // First user gesture unlocks audio playback in browsers
  function unlock(){
    if(unlocked) return;
    unlocked = true;
    ensureCtx();
    preload();
    // Try the theme immediately — if it fails, will retry next click
    startTheme();
  }
  window.addEventListener('pointerdown', unlock, { once:false });
  window.addEventListener('keydown', unlock, { once:false });

  return { play, startTheme, stopTheme, setMuted, setMusicMuted, isMuted, isMusicMuted, preload };
})();

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
function clearSessionAll(){ localStorage.removeItem(LS_KEY); }

let session = loadSession();
let ws=null, nick=session.nick||'', youId=session.token||null, roomId=session.roomId||null, hostId=null;
let currentRoom=null, selectedLetter=null;
let timerRAF=null, timerDeadline=0, timerTotal=12;
let amSpectator=false;
let reconnectAttempts=0;
let lastTurnPlayerId=null;

// ---------- connection ----------
function connect(){
  const proto = location.protocol==='https:'?'wss':'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = ()=>{
    reconnectAttempts = 0;
    sendMsg({ type:'hello', token: youId || session.token || '' });
  };
  ws.onmessage = ev=>handle(JSON.parse(ev.data));
  ws.onclose = ()=>{
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

// ---------- visual: screen shake + red flash for wrong word ----------
function shakeAndFlash(){
  const app = document.querySelector('.app');
  if(app){
    app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake');
    setTimeout(()=>app.classList.remove('shake'), 600);
  }
  const flash = $('flash');
  if(flash){
    flash.classList.remove('show'); void flash.offsetWidth; flash.classList.add('show');
    setTimeout(()=>flash.classList.remove('show'), 350);
  }
}

// ---------- login ----------
function doEnter(){
  const v=$('nick').value.trim();
  if(v.length<1){ toast('Maglagay ng nickname!'); return; }
  Audio.play('click');
  nick=v.slice(0,16);
  saveSession({ nick });
  $('lobbyNick').textContent=nick;
  if(!ws || ws.readyState>1) connect();
  show('lobby');
  Audio.startTheme();
  const wait=setInterval(()=>{ if(ws&&ws.readyState===1){ watchLobby(); clearInterval(wait);} },120);
}
$('enterBtn').onclick=doEnter;
$('nick').addEventListener('keydown',e=>{ if(e.key==='Enter') doEnter(); });

// ---------- lobby ----------
$('refreshBtn').onclick=()=>{ Audio.play('click'); watchLobby(); };
$('createBtn').onclick=()=>{ Audio.play('click'); sendMsg({type:'createRoom', nick, roomName:`${nick}'s Room`}); };

// LOGOUT
$('logoutBtn').onclick=()=>{
  Audio.play('leave');
  // leave any room first
  sendMsg({type:'leaveRoom'});
  clearSessionAll();
  nick=''; youId=null; roomId=null; amSpectator=false;
  $('nick').value='';
  toast('👋 Nag-logout ka na');
  // close socket so server forgets us and we get a fresh token on next connect
  try { if(ws){ ws.onclose=null; ws.close(); } } catch {}
  ws = null;
  show('login');
};

// CHANGE NICKNAME
$('changeNickBtn').onclick=()=>{
  Audio.play('click');
  const cur = nick || '';
  const nn = prompt('Bagong nickname (1-16 chars):', cur);
  if(nn===null) return;
  const v = String(nn).trim().slice(0,16);
  if(!v){ toast('Walang laman!'); return; }
  nick = v;
  saveSession({ nick });
  $('lobbyNick').textContent = nick;
  $('nick').value = nick;
  toast(`✅ Nickname: ${nick}`);
  // If currently in a room, the change takes effect next time you join (server keeps the old one for active session)
};

// MUTE BUTTONS
function updateMuteBtns(){
  $('muteBtn').textContent = Audio.isMuted() ? '🔇 SFX' : '🔊 SFX';
  $('musicBtn').textContent = Audio.isMusicMuted() ? '🎵 OFF' : '🎵 ON';
}
$('muteBtn').onclick=()=>{ Audio.setMuted(!Audio.isMuted()); updateMuteBtns(); if(!Audio.isMuted()) Audio.play('click'); };
$('musicBtn').onclick=()=>{ Audio.setMusicMuted(!Audio.isMusicMuted()); updateMuteBtns(); };
updateMuteBtns();

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
      btn.onclick=()=>{ Audio.play('click'); sendMsg({type:'joinRoom', roomId:r.id, nick}); };
    } else {
      const full = !r.canJoin;
      btn.textContent = full?'Puno':'Sali';
      btn.disabled = full;
      btn.onclick=()=>{ Audio.play('click'); sendMsg({type:'joinRoom', roomId:r.id, nick}); };
    }
    div.appendChild(btn);
    el.appendChild(div);
  });
}

// ---------- room ----------
$('leaveBtn').onclick=()=>{ Audio.play('leave'); sendMsg({type:'leaveRoom'}); roomId=null; clearSessionRoom(); amSpectator=false; show('lobby'); watchLobby(); };
$('startBtn').onclick=()=>{ Audio.play('click'); sendMsg({type:'startGame'}); };

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
      Audio.play('click');
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
$('againBtn').onclick=()=>{ Audio.play('click'); sendMsg({type:'playAgain'}); };
$('backLobbyBtn').onclick=()=>{ Audio.play('leave'); sendMsg({type:'leaveRoom'}); roomId=null; clearSessionRoom(); amSpectator=false; show('lobby'); watchLobby(); };

// ---------- overlay countdown ----------
function showCountdown(v){
  const ov=$('overlay'), n=$('cdNum');
  ov.classList.add('show'); n.textContent=v;
  n.style.animation='none'; void n.offsetWidth; n.style.animation='pop .9s ease';
  Audio.play('countdown');
}
function hideCountdown(){ $('overlay').classList.remove('show'); }

// ---------- message handler ----------
function handle(m){
  switch(m.type){
    case 'welcome':
      if(m.token){ youId = m.token; saveSession({ token: m.token }); }
      if(m.resumedRoomId){
        roomId = m.resumedRoomId;
        saveSession({ roomId });
      } else {
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
      if(!m.resumed){ show('room'); Audio.play('join'); }
      break;
    case 'roomState':{
      currentRoom=m.room;
      hostId = m.room.hostId;
      const me = (m.room.lobbyPlayers||[]).find(p=>p.id===youId);
      amSpectator = !!(me && me.isSpectator);
      if(m.room.state==='lobby'||m.room.state==='countdown'){
        if(!screens.over.classList.contains('active')) show('room');
        renderRoom(m.room);
      } else if(m.room.state==='playing'){
        show('game'); renderGamePlayers(m.room); setTurnUI(m.room);
        // detect turn change → if it became my turn, play alert
        if(m.room.turnPlayerId && m.room.turnPlayerId!==lastTurnPlayerId){
          lastTurnPlayerId = m.room.turnPlayerId;
          if(m.room.turnPlayerId===youId && !amSpectator){ Audio.play('myTurn'); }
        }
        if(m.room.turnDeadline){ startTimer(m.room.turnDeadline, m.room.turnSeconds||12); }
      } else if(m.room.state==='ended'){
        renderGamePlayers(m.room);
      }
      break;
    }
    case 'countdown':
      if(m.value>0){ showCountdown(m.value); } break;
    case 'pickLetter':
      hideCountdown();
      show('game');
      $('rejected').textContent='';
      $('log').innerHTML='';
      Audio.play('start');
      break;
    case 'turn':{
      hideCountdown();
      $('rejected').textContent='';
      $('wordInput').value='';
      const myTurn = !amSpectator && m.turnPlayerId===youId;
      if(myTurn && m.turnPlayerId!==lastTurnPlayerId){ Audio.play('myTurn'); }
      lastTurnPlayerId = m.turnPlayerId;
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
    case 'deadlineUpdate':
      // Penalty applied: shrink the turn timer for everyone in sync
      if(m.deadline){ startTimer(m.deadline, timerTotal); }
      break;
    case 'wordAccepted':
      Audio.play('accept');
      addLog(`✅ ${m.by}: ${m.word.toUpperCase()} → ${m.nextLetter}`, 'word');
      $('wordInput').value='';
      $('rejected').textContent='';
      break;
    case 'rejected':
      Audio.play('reject');
      shakeAndFlash();
      $('rejected').textContent = '✖ ' + m.reason + (m.penaltyMs ? ` (-${(m.penaltyMs/1000).toFixed(0)}s)` : '');
      $('wordInput').select();
      break;
    case 'penalty':
      // global penalty broadcast (for spectators / other players to hear the buzz)
      if(m.playerId!==youId){
        Audio.play('reject');
      }
      addLog(`⚠️ ${m.nick}: ${m.reason} (-${(m.penaltyMs/1000).toFixed(0)}s)`, 'timeout');
      break;
    case 'event':
      // Specific event kinds get specific sounds
      if(m.kind==='join') Audio.play('join');
      else if(m.kind==='leave') Audio.play('leave');
      else if(m.kind==='dead') Audio.play('dead');
      else if(m.kind==='timeout') Audio.play('timeout');
      else if(m.kind==='start') Audio.play('start');
      addLog(m.text, m.kind);
      break;
    case 'youSpectate':
      Audio.play('dead');
      amSpectator = true;
      toast('💀 Naubos ang hearts mo — spectator ka na. Manood ka muna!');
      if(currentRoom) setTurnUI(currentRoom);
      break;
    case 'gameOver':
      stopTimer();
      Audio.play('win');
      setTimeout(()=>{
        show('over');
        if(m.winnerId===youId){ $('winName').textContent='🎉 IKAW ang Panalo!'; $('winSub').textContent='Matira matibay champion!'; }
        else if(m.winnerNick){ $('winName').textContent=`Panalo si ${m.winnerNick}`; $('winSub').textContent='Mas swerte sa susunod!'; }
        else { $('winName').textContent='Tabla!'; $('winSub').textContent='Walang natira.'; }
        $('againBtn').style.display = (hostId===youId)?'block':'none';
      }, 700);
      break;
    case 'error':
      Audio.play('reject');
      toast(m.message); break;
  }
  if(currentRoom) hostId=currentRoom.hostId;
}

function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ---------- BOOT ----------
(function boot(){
  if(nick){
    $('nick').value = nick;
    $('lobbyNick').textContent = nick;
  }
  connect();
  if(roomId || nick){
    show('lobby');
    $('roomlist').innerHTML='<div class="empty">Kumokonekta…</div>';
  } else {
    show('login');
  }
})();
