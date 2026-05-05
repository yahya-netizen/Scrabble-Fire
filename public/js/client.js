let socket;
let myUsername = null;
let myColor = '#ff4500';
let myRoomId = '';
let gameState = { soal: [], grid: {}, completedWords: {}, scores: {} };

// --- DOM Elements ---
const authOverlay = document.getElementById('auth-overlay');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const gameoverScreen = document.getElementById('gameover-screen');

const authMessage = document.getElementById('auth-message');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');

// --- Auth Initialization ---
async function checkAuth() {
    try {
        const res = await fetch('/api/me');
        if (res.ok) {
            const data = await res.json();
            startAs(data.username);
        } else {
            showAuth();
        }
    } catch (e) {
        showAuth();
    }
}

function showAuth() {
    authOverlay.style.display = 'flex';
    lobbyScreen.style.display = 'none';
    gameScreen.style.display = 'none';
}

function startAs(username) {
    myUsername = username;
    document.getElementById('lobby-user-display').innerText = username;
    authOverlay.style.display = 'none';
    lobbyScreen.style.display = 'flex';
    initSocket();
}

// --- Auth Events ---
document.getElementById('show-register').onclick = () => {
    loginForm.style.display = 'none';
    registerForm.style.display = 'block';
};

document.getElementById('show-login').onclick = () => {
    registerForm.style.display = 'none';
    loginForm.style.display = 'block';
};

document.getElementById('btn-register').onclick = async () => {
    const username = document.getElementById('reg-username').value;
    const password = document.getElementById('reg-password').value;
    const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    authMessage.innerText = data.message;
    if (res.ok) setTimeout(() => document.getElementById('show-login').click(), 1000);
};

document.getElementById('btn-login').onclick = async () => {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok) startAs(data.username);
    else authMessage.innerText = data.message;
};

async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
}

// ────────────────────────────────────────────────
//  LOBBY & SOCKET
// ────────────────────────────────────────────────
function initSocket() {
    socket = io();

    socket.on('connect', () => {
        socket.emit('get_rooms');
    });

    socket.on('room_list', (rooms) => {
        const container = document.getElementById('room-list');
        if (!rooms.length) {
            container.innerHTML = '<div id="no-rooms">Belum ada room aktif. Buat room baru!</div>';
            return;
        }
        container.innerHTML = rooms.map(r => `
            <div class="room-item" onclick="pickRoom('${r.id}')">
                <div>
                    <div class="room-id">${r.id}</div>
                    <div class="room-meta">${r.playerCount}/${r.maxPlayers} pemain</div>
                </div>
                <span class="room-badge ${r.gameStarted ? 'started' : ''}">
                    ${r.gameStarted ? 'Berlangsung' : 'Menunggu'}
                </span>
            </div>`).join('');
    });

    socket.on('join_error', ({ message }) => {
        document.getElementById('lobby-error').textContent = message;
    });

    socket.on('game_state', (data) => {
        gameState = data;
        myColor = data.myColor;
        buildGrid();
        showScreen('game-screen');

        const badge = document.getElementById('topbar-player');
        badge.textContent = myUsername;
        badge.style.color = myColor;
        badge.style.borderColor = myColor;
        document.getElementById('topbar-room').textContent = `Room: ${myRoomId}`;

        updateTimer(data.timeLeft);
        renderBoard();
        renderClues();
        renderPlayers(data.scores);
    });

    socket.on('player_joined', ({ username, players }) => {
        if (username !== myUsername) showToast(`${username} bergabung 👋`);
        const sc = {};
        players.forEach(p => sc[p.username] = { score: p.score, color: p.color });
        renderPlayers(sc);
    });

    socket.on('player_left', ({ username, players }) => {
        showToast(`${username} meninggalkan room`);
        const sc = {};
        players.forEach(p => sc[p.username] = { score: p.score, color: p.color });
        renderPlayers(sc);
    });

    socket.on('cell_updated', ({ row, col, char, username }) => {
        const input = document.getElementById(`cell-${row}-${col}`);
        if (!input) return;
        input.value = char;
        input.classList.add('typing-other');
        setTimeout(() => input.classList.remove('typing-other'), 500);
        gameState.grid[`${row}-${col}`] = { char, locked: false, lastBy: username };
    });

    socket.on('word_completed', (data) => {
        const { wordId, username, scores, answer, direction, row, col, color, pointsEarned } = data;
        gameState.completedWords[wordId] = username;
        gameState.scores = scores;

        for (let i = 0; i < answer.length; i++) {
            let r = row, c = col;
            if (direction === 'across') c += i; else r += i;
            const cellId = `${r}-${c}`;
            gameState.grid[cellId] = { char: answer[i], locked: true, lockedBy: username, lockedColor: color };
            const input = document.getElementById(`cell-${r}-${c}`);
            if (input) {
                input.value = answer[i];
                input.classList.add('locked', 'word-pop');
                input.readOnly = true;
                input.style.color = color;
                input.style.textShadow = `0 0 8px ${color}`;
                setTimeout(() => input.classList.remove('word-pop'), 400);
            }
        }
        renderClues();
        renderPlayers(scores);
        const isSelf = username === myUsername;
        showToast(isSelf ? `🎉 Kamu menjawab kata ${answer}! +${pointsEarned} poin` : `✅ ${username} menjawab "${answer}"!`, isSelf ? color : null);
    });

    socket.on('timer_update', ({ timeLeft }) => updateTimer(timeLeft));
    socket.on('game_over', ({ reason, rankings, winner }) => showGameOver(reason, rankings, winner));
    
    socket.on('connect_error', (err) => {
        if (err.message === 'Authentication error') showAuth();
    });
}

function pickRoom(id) {
    document.getElementById('inp-room').value = id;
}

function joinRoom() {
    const roomId = document.getElementById('inp-room').value.trim();
    if (!roomId) { document.getElementById('lobby-error').textContent = 'Masukkan ID room!'; return; }
    myRoomId = roomId;
    socket.emit('join_room', { roomId });
}

// ────────────────────────────────────────────────
//  GRID & RENDER
// ────────────────────────────────────────────────
let gridBuilt = false;
function buildGrid() {
    if (gridBuilt) return;
    gridBuilt = true;
    const gridEl = document.getElementById('grid');
    gridEl.innerHTML = '';
    for (let r = 1; r <= 15; r++) {
        for (let c = 1; c <= 15; c++) {
            const container = document.createElement('div');
            container.className = 'cell-container';
            container.id = `cont-${r}-${c}`;
            const input = document.createElement('input');
            input.type = 'text'; input.maxLength = 1; input.className = 'cell';
            input.id = `cell-${r}-${c}`; input.dataset.row = r; input.dataset.col = c;
            input.readOnly = true;
            input.addEventListener('input', (e) => {
                const char = e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase();
                e.target.value = char;
                if (char) {
                    socket.emit('cell_update', { row: r, col: c, char: char });
                    focusNext(r, c);
                }
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !e.target.value) focusPrev(r, c);
                if (e.key === 'ArrowRight') { e.preventDefault(); focusNextInWord(r, c, 'across'); }
                if (e.key === 'ArrowLeft')  { e.preventDefault(); focusPrevInWord(r, c, 'across'); }
                if (e.key === 'ArrowDown')  { e.preventDefault(); focusNextInWord(r, c, 'down'); }
                if (e.key === 'ArrowUp')    { e.preventDefault(); focusPrevInWord(r, c, 'down'); }
            });
            container.appendChild(input);
            gridEl.appendChild(container);
        }
    }
}

function renderBoard() {
    document.querySelectorAll('.cell').forEach(cell => {
        cell.classList.remove('active', 'locked');
        cell.style.color = ''; cell.style.background = '';
        cell.readOnly = true; cell.value = '';
    });
    document.querySelectorAll('.cell-number').forEach(n => n.remove());
    gameState.soal.forEach(s => {
        const startCont = document.getElementById(`cont-${s.row}-${s.col}`);
        if (startCont && !startCont.querySelector('.cell-number')) {
            const numDiv = document.createElement('div');
            numDiv.className = 'cell-number'; numDiv.innerText = s.number;
            startCont.appendChild(numDiv);
        }
        for (let i = 0; i < s.answer.length; i++) {
            let r = s.row, c = s.col;
            if (s.direction === 'across') c += i; else r += i;
            const input = document.getElementById(`cell-${r}-${c}`);
            input.classList.add('active'); input.readOnly = false;
            const cellId = `${r}-${c}`;
            const cellData = gameState.grid[cellId];
            if (cellData) {
                input.value = cellData.char;
                if (cellData.locked) {
                    input.classList.add('locked'); input.readOnly = true;
                    if (cellData.lockedColor) { input.style.color = cellData.lockedColor; input.style.textShadow = `0 0 8px ${cellData.lockedColor}`; }
                }
            }
        }
    });
}

function renderClues() {
    const listAcross = document.getElementById('list-across');
    const listDown = document.getElementById('list-down');
    listAcross.innerHTML = ''; listDown.innerHTML = '';
    gameState.soal.forEach(s => {
        const isDone = gameState.completedWords[s.id];
        const solverColor = isDone && gameState.scores[isDone] ? gameState.scores[isDone].color : '#fff';
        const li = document.createElement('li');
        li.className = `clue-item ${isDone ? 'completed' : ''}`;
        li.innerHTML = `<strong>${s.number}.</strong> ${s.clue}` + (isDone ? ` <span class="solved-by" style="color:${solverColor}"> ✓ ${isDone}</span>` : '');
        if (!isDone) li.onclick = () => focusWord(s);
        if (s.direction === 'across') listAcross.appendChild(li); else listDown.appendChild(li);
    });
}

function renderPlayers(scores) {
    const list = document.getElementById('players-list');
    list.innerHTML = '';
    const entries = Object.entries(scores).sort((a,b) => b[1].score - a[1].score);
    if (!entries.length) { list.innerHTML = '<li>Belum ada pemain</li>'; return; }
    entries.forEach(([name, data]) => {
        const li = document.createElement('li');
        const isSelf = name === myUsername;
        li.innerHTML = `<span class="dot" style="background:${data.color}"></span><span style="${isSelf ? 'font-weight:700;color:#fff' : ''}">${name}${isSelf ? ' (kamu)' : ''}</span><span class="player-score">${data.score}</span>`;
        list.appendChild(li);
    });
}

// ────────────────────────────────────────────────
//  UI HELPERS
// ────────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById(id).style.display = (id === 'lobby-screen' ? 'flex' : 'block');
    if (id === 'game-screen' || id === 'gameover-screen') document.getElementById(id).style.display = 'flex';
}

function updateTimer(seconds) {
    const el = document.getElementById('timer-display');
    const m = Math.floor(seconds / 60); const s = seconds % 60;
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('urgent', seconds <= 30);
}

function showGameOver(reason, rankings, winner) {
    document.getElementById('gameover-reason').textContent = reason;
    document.getElementById('winner-name').textContent = winner || '-';
    const ul = document.getElementById('final-rankings');
    ul.innerHTML = '';
    rankings.forEach(r => {
        const li = document.createElement('li');
        li.className = `rank-${r.rank}`;
        li.innerHTML = `<span class="rank-num">${r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank}</span><span class="dot" style="background:${r.color}"></span><span>${r.username}</span><span class="rank-score">${r.score} poin</span>`;
        ul.appendChild(li);
    });
    showScreen('gameover-screen');
}

function backToLobby() { location.reload(); }

function showToast(msg, color) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (color) toast.style.borderLeftColor = color;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ────────────────────────────────────────────────
//  FOCUS HELPERS
// ────────────────────────────────────────────────
let lastDirection = 'across';
function getActiveWordAt(r, c, preferDirection) {
    const candidates = gameState.soal.filter(s => (s.direction === 'across' && r === s.row && c >= s.col && c < s.col + s.answer.length) || (s.direction === 'down' && c === s.col && r >= s.row && r < s.row + s.answer.length));
    return candidates.find(s => s.direction === preferDirection) || candidates[0];
}
function focusNext(r, c) {
    const word = getActiveWordAt(r, c, lastDirection); if (!word) return;
    lastDirection = word.direction; let nr = r, nc = c;
    if (word.direction === 'across') nc++; else nr++;
    const next = document.getElementById(`cell-${nr}-${nc}`);
    if (next && next.classList.contains('active') && !next.readOnly) next.focus();
}
function focusPrev(r, c) {
    const word = getActiveWordAt(r, c, lastDirection); if (!word) return;
    let pr = r, pc = c; if (word.direction === 'across') pc--; else pr--;
    const prev = document.getElementById(`cell-${pr}-${pc}`);
    if (prev && prev.classList.contains('active') && !prev.readOnly) prev.focus();
}
function focusNextInWord(r, c, dir) {
    const word = gameState.soal.find(s => s.direction === dir && ((dir === 'across' && r === s.row && c >= s.col && c < s.col + s.answer.length) || (dir === 'down' && c === s.col && r >= s.row && r < s.row + s.answer.length)));
    if (!word) return; lastDirection = dir; let nr = r, nc = c;
    if (dir === 'across') nc++; else nr++;
    const next = document.getElementById(`cell-${nr}-${nc}`);
    if (next && next.classList.contains('active') && !next.readOnly) next.focus();
}
function focusPrevInWord(r, c, dir) {
    const word = gameState.soal.find(s => s.direction === dir && ((dir === 'across' && r === s.row && c > s.col && c <= s.col + s.answer.length) || (dir === 'down' && c === s.col && r > s.row && r <= s.row + s.answer.length)));
    if (!word) return; lastDirection = dir; let pr = r, pc = c;
    if (dir === 'across') pc--; else pr--;
    const prev = document.getElementById(`cell-${pr}-${pc}`);
    if (prev && prev.classList.contains('active') && !prev.readOnly) prev.focus();
}
function focusWord(soal) {
    lastDirection = soal.direction;
    for (let i = 0; i < soal.answer.length; i++) {
        let r = soal.row, c = soal.col; if (soal.direction === 'across') c += i; else r += i;
        const input = document.getElementById(`cell-${r}-${c}`);
        if (input && !input.readOnly && !input.value) { input.focus(); return; }
    }
    const first = document.getElementById(`cell-${soal.row}-${soal.col}`);
    if (first && !first.readOnly) first.focus();
}

// Start
checkAuth();