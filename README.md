# 🎮 Complete the Word — Matira Matibay

Real-time multiplayer word-chain battle game. Mobile + desktop ready.

## Mga Mekanika
- **2–4 players** kada room
- Maglagay ng **nickname** → pumasok sa **lobby**
- Gumawa o sumali sa **room** → makikita ang ibang players na naghihintay
- Kapag pinindot ng host ang **Simulan**, may **5-second countdown** bago mag-start
- Ang unang player ay **pipili ng letra** mula sa random letters (hal. S, L, K, J) at bubuo ng tunay na English word
- Ang **huling letra** ng salita ang **simula** ng word ng susunod na player (word chain)
- **12 segundo** kada turn. Kapag naubusan ng oras → **-1 ❤️**
- **3 hearts** kada player. Pag naubos → talo na 💀
- Ang **huling natitirang player** ang panalo 🏆

## Paano Patakbuhin
```bash
cd wordchain
npm install        # kung hindi pa na-install ang 'ws'
npm start          # o: node server.js
```
Buksan sa browser: **http://localhost:3000**

Para maglaro nang sabay-sabay:
- Buksan ang link sa **maraming tabs / devices** sa parehong network
- Para sa ibang devices, gamitin ang **local IP** ng host machine: `http://<IP>:3000`

## Tech
- **Backend:** Node.js + WebSockets (`ws`) — real-time lobby at game state
- **Frontend:** Vanilla HTML/CSS/JS (responsive, walang build step)
- **Dictionary:** 359,039 English words (offline validation, bundled sa `data/words.txt`)

## File Structure
```
wordchain/
├── server.js          # WebSocket game server + lobby logic
├── public/
│   ├── index.html     # UI (login, lobby, room, game, gameover)
│   └── app.js         # Client logic + WebSocket handling
├── data/words.txt     # English dictionary
└── package.json
```
