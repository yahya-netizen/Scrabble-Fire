let socket;
let myUsername = null;
let myColor = '#ff4500';
let myRoomId = '';
let canStartGame = false;
let questionCategories = [];
let latestRooms = [];
let gameState = { soal: [], grid: {}, completedWords: {}, scores: {}, gameStarted: false, starterUsername: null };

function lockBrowserZoom() {
    document.addEventListener('wheel', (e) => {
        if (e.ctrlKey) e.preventDefault();
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();
        const zoomKey = key === '+' || key === '-' || key === '=' || key === '0';
        if ((e.ctrlKey || e.metaKey) && zoomKey) e.preventDefault();
    });

    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('gesturechange', (e) => e.preventDefault());
    document.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
}

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

async function startAs(username) {
    myUsername = username;
    document.getElementById('lobby-user-display').innerText = username;
    document.getElementById('lobby-avatar').innerText = username.charAt(0).toUpperCase();
    authOverlay.style.display = 'none';
    lobbyScreen.style.display = 'flex';
    await loadCategories();
    initSocket();
}

async function loadCategories() {
    const select = document.getElementById('inp-category');
    if (!select) return;

    try {
        const res = await fetch('/api/categories');
        questionCategories = await res.json();
        select.innerHTML = questionCategories.map(category => (
            `<option value="${category.id}">${category.name} (${category.questionCount} soal)</option>`
        )).join('');
    } catch (e) {
        questionCategories = [];
        select.innerHTML = '<option value="web">Pemrograman Web</option>';
    }
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
        latestRooms = rooms;
        const container = document.getElementById('room-list');
        if (!rooms.length) {
            container.innerHTML = '<div id="no-rooms">Belum ada room aktif. Buat room baru!</div>';
            return;
        }
        container.innerHTML = rooms.map(r => `
            <div class="room-item" onclick="pickRoom('${r.id}')">
                <div>
                    <div class="room-id">${r.id}</div>
                    <div class="room-meta">${r.playerCount}/${r.maxPlayers} pemain | ${r.categoryName || 'Kategori'} | ${formatDuration(r.duration)}</div>
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
        canStartGame = !!data.canStart;
        buildGrid();
        showScreen('game-screen');

        const badge = document.getElementById('topbar-player');
        badge.textContent = myUsername;
        badge.style.color = myColor;
        badge.style.borderColor = myColor;
        document.getElementById('topbar-room').textContent = `Room: ${myRoomId}`;
        document.getElementById('topbar-room').title = `${data.categoryName || 'Kategori'} | ${formatDuration(data.duration)}`;

        updateTimer(data.timeLeft);
        renderBoard();
        renderClues();
        renderPlayers(data.scores);
        updateStartControls();
    });

    socket.on('player_joined', ({ username, players, starterUsername }) => {
        if (username !== myUsername) showToast(`${username} bergabung 👋`);
        const sc = {};
        players.forEach(p => sc[p.username] = { score: p.score, color: p.color });
        gameState.starterUsername = starterUsername;
        canStartGame = starterUsername === myUsername;
        renderPlayers(sc);
        updateStartControls();
    });

    socket.on('player_left', ({ username, players, starterUsername }) => {
        showToast(`${username} meninggalkan room`);
        const sc = {};
        players.forEach(p => sc[p.username] = { score: p.score, color: p.color });
        gameState.starterUsername = starterUsername;
        canStartGame = starterUsername === myUsername;
        renderPlayers(sc);
        updateStartControls();
    });

    socket.on('cell_updated', ({ row, col, char, username }) => {
        const input = document.getElementById(`cell-${row}-${col}`);
        if (!input) return;
        input.value = char;
        input.classList.add('typing-other');
        setTimeout(() => input.classList.remove('typing-other'), 500);
        const playerColor = gameState.scores[username] ? gameState.scores[username].color : '#ffffff';
        gameState.grid[`${row}-${col}`] = { char, locked: false, lastBy: username, lastColor: playerColor };
        playCellSound();
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
        playWordSound(true);
        showToast(isSelf ? `🎉 Kamu menjawab kata ${answer}! +${pointsEarned} poin` : `✅ ${username} menjawab "${answer}"!`, isSelf ? color : null);
    });

    socket.on('game_started', ({ timeLeft, soal, message }) => {
        gameState.gameStarted = true;
        if (Array.isArray(soal)) gameState.soal = soal;
        updateTimer(timeLeft);
        renderBoard();
        renderClues();
        updateStartControls();
        playGameStartSound();
        showToast(message || 'Game dimulai!');
    });
    socket.on('timer_update', ({ timeLeft }) => updateTimer(timeLeft));
    socket.on('start_error', ({ message }) => showToast(message));
    socket.on('game_over', ({ reason, rankings, winner, winnerColor, burnedCells }) => {
        playVictorySound();
        setTimeout(() => playBurnSound(), 300);
        playWinnerBurnEffect({ winner, winnerColor, burnedCells });
        setTimeout(() => showGameOver(reason, rankings, winner), 2400);
    });
    
    socket.on('connect_error', (err) => {
        if (err.message === 'Authentication error') showAuth();
    });
}

function pickRoom(id) {
    document.getElementById('inp-room').value = id;
    const room = latestRooms.find(r => r.id === id);
    if (!room) return;

    const categorySelect = document.getElementById('inp-category');
    const durationSelect = document.getElementById('inp-duration');
    if (categorySelect && room.categoryId) categorySelect.value = room.categoryId;
    if (durationSelect && room.duration) durationSelect.value = String(room.duration);
}

function joinRoom() {
    const roomId = document.getElementById('inp-room').value.trim();
    if (!roomId) { document.getElementById('lobby-error').textContent = 'Masukkan ID room!'; return; }
    myRoomId = roomId;
    socket.emit('join_room', {
        roomId,
        settings: {
            categoryId: document.getElementById('inp-category')?.value,
            duration: Number(document.getElementById('inp-duration')?.value || 180)
        }
    });
}

function formatDuration(seconds) {
    const totalSeconds = Number(seconds) || 180;
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    if (!remainingSeconds) return `${minutes} menit`;
    return `${minutes}:${String(remainingSeconds).padStart(2, '0')} menit`;
}

function startGame() {
    if (!socket || !canStartGame || gameState.gameStarted) return;
    socket.emit('start_game');
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
            input.addEventListener('focus', () => {
                const word = getActiveWordAt(r, c, lastDirection);
                if (word) {
                    activeWordId = word.id;
                    lastDirection = word.direction;
                }
            });
            input.addEventListener('click', () => selectWordAtCell(r, c));
            input.addEventListener('input', (e) => {
                if (!gameState.gameStarted) {
                    e.target.value = '';
                    showToast('Tunggu pemain pertama memulai game.');
                    return;
                }
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
            input.classList.add('active'); input.readOnly = !gameState.gameStarted;
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

    if (!gameState.gameStarted) {
        listAcross.innerHTML = '<li class="clue-item locked-clue">Soal akan muncul setelah game dimulai.</li>';
        listDown.innerHTML = '<li class="clue-item locked-clue">Menunggu pemain pertama menekan Mulai Game.</li>';
        return;
    }

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
function updateStartControls() {
    const status = document.getElementById('start-status');
    const button = document.getElementById('btn-start-game');
    if (!status || !button) return;

    if (gameState.gameStarted) {
        status.textContent = 'Game sedang berlangsung.';
        button.style.display = 'none';
        return;
    }

    if (canStartGame) {
        status.textContent = 'Kamu pemain pertama. Mulai game saat pemain lain sudah siap.';
        button.style.display = 'block';
    } else {
        status.textContent = `Menunggu pemain pertama${gameState.starterUsername ? ` (${gameState.starterUsername})` : ''} memulai game...`;
        button.style.display = 'none';
    }
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    const screen = document.getElementById(id);
    if (id === 'game-screen') {
        screen.style.display = 'grid';
    } else if (id === 'lobby-screen' || id === 'gameover-screen') {
        screen.style.display = 'flex';
    } else {
        screen.style.display = 'block';
    }
}

function updateTimer(seconds) {
    const el = document.getElementById('timer-display');
    const m = Math.floor(seconds / 60); const s = seconds % 60;
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('urgent', seconds <= 30);
}

function playWinnerBurnEffect({ winner, winnerColor, burnedCells = [] }) {
    if (!winner || winner === 'Tidak Ada' || !Array.isArray(burnedCells) || !burnedCells.length) {
        showToast('Permainan selesai!');
        return;
    }

    const gridWrapper = document.getElementById('grid-wrapper');
    const grid = document.getElementById('grid');
    clearBurnEffects();

    const scorchLayer = document.createElement('div');
    scorchLayer.className = 'burn-scorch-layer';
    if (winnerColor) scorchLayer.style.setProperty('--winner-color', winnerColor);
    gridWrapper.appendChild(scorchLayer);

    const banner = document.createElement('div');
    banner.className = 'burn-victory-banner';
    banner.innerHTML = `<span>&#128293; ${winner} membakar kotak lawan!</span>`;
    if (winnerColor) banner.style.setProperty('--winner-color', winnerColor);
    gridWrapper.appendChild(banner);

    grid.classList.add('board-burn-active');
    const orderedCells = burnedCells
        .slice()
        .sort((a, b) => ((a.row - 8) ** 2 + (a.col - 8) ** 2) - ((b.row - 8) ** 2 + (b.col - 8) ** 2));

    orderedCells.forEach((cell, index) => {
        const input = document.getElementById(`cell-${cell.row}-${cell.col}`);
        const container = document.getElementById(`cont-${cell.row}-${cell.col}`);
        if (!input || !container) return;

        setTimeout(() => {
            input.classList.add('enemy-burned-cell');
            input.classList.toggle('enemy-burned-locked', !!cell.locked);
            input.style.setProperty('--enemy-color', cell.color || '#ffcc00');
            spawnFireBurst(container, winnerColor);
        }, Math.min(index * 48, 940));
    });

    setTimeout(() => {
        grid.classList.remove('board-burn-active');
        banner.remove();
        scorchLayer.remove();
    }, 2300);
}

function clearBurnEffects() {
    document.querySelectorAll('.burn-victory-banner, .burn-scorch-layer, .cell-flame, .fire-spark').forEach(el => el.remove());
    document.querySelectorAll('.enemy-burned-cell').forEach(cell => {
        cell.classList.remove('enemy-burned-cell', 'enemy-burned-locked');
        cell.style.removeProperty('--enemy-color');
    });
}

function spawnFireBurst(container, winnerColor) {
    const flame = document.createElement('div');
    flame.className = 'cell-flame';
    flame.style.setProperty('--winner-color', winnerColor || '#ff4500');
    container.appendChild(flame);

    for (let i = 0; i < 5; i++) {
        const spark = document.createElement('span');
        spark.className = 'fire-spark';
        spark.style.setProperty('--spark-x', `${(Math.random() * 34) - 17}px`);
        spark.style.setProperty('--spark-delay', `${Math.random() * 0.22}s`);
        container.appendChild(spark);
        setTimeout(() => spark.remove(), 1150);
    }

    setTimeout(() => flame.remove(), 1500);
}

function showGameOver(reason, rankings, winner) {
    document.getElementById('gameover-reason').textContent = reason;
    const winnerName = document.getElementById('winner-name');
    const winnerBanner = document.querySelector('.winner-banner');
    winnerName.textContent = winner || '-';
    winnerBanner.classList.toggle('fire-winner', !!winner && winner !== 'Tidak Ada');
    const ul = document.getElementById('final-rankings');
    ul.innerHTML = '';
    rankings.forEach(r => {
        const li = document.createElement('li');
        li.className = `rank-${r.rank}${r.username === winner ? ' winner-fire' : ''}`;
        li.innerHTML = `<span class="rank-num">${r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank}</span><span class="dot" style="background:${r.color}"></span><span>${r.username}</span><span class="rank-score">${r.score} poin</span>`;
        ul.appendChild(li);
    });
    showScreen('gameover-screen');
}

function backToLobby() { 
    location.reload(); 
}

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
let activeWordId = null;
function wordContainsCell(word, r, c) {
    return (word.direction === 'across' && r === word.row && c >= word.col && c < word.col + word.answer.length) ||
        (word.direction === 'down' && c === word.col && r >= word.row && r < word.row + word.answer.length);
}
function getActiveWordAt(r, c, preferDirection) {
    const candidates = gameState.soal.filter(s => wordContainsCell(s, r, c));
    return candidates.find(s => s.id === activeWordId) || candidates.find(s => s.direction === preferDirection) || candidates[0];
}
function selectWordAtCell(r, c) {
    const candidates = gameState.soal.filter(s => wordContainsCell(s, r, c));
    if (!candidates.length) return;

    const activeIndex = candidates.findIndex(s => s.id === activeWordId);
    const startsHere = candidates.filter(s => s.row === r && s.col === c);
    let word = null;

    if (activeIndex >= 0 && candidates.length > 1) {
        word = candidates[(activeIndex + 1) % candidates.length];
    } else {
        word = startsHere.find(s => s.direction === 'down') ||
            candidates.find(s => s.direction === 'down') ||
            candidates[0];
    }

    activeWordId = word.id;
    lastDirection = word.direction;
}
function getCellPositionInWord(word, r, c) {
    return word.direction === 'across' ? c - word.col : r - word.row;
}
function getWordCell(word, index) {
    const r = word.direction === 'across' ? word.row : word.row + index;
    const c = word.direction === 'across' ? word.col + index : word.col;
    return document.getElementById(`cell-${r}-${c}`);
}
function focusOpenCellInWord(word, fromIndex, step, emptyOnly = false) {
    activeWordId = word.id;
    lastDirection = word.direction;
    for (let i = fromIndex + step; i >= 0 && i < word.answer.length; i += step) {
        const input = getWordCell(word, i);
        if (input && input.classList.contains('active') && !input.readOnly && (!emptyOnly || !input.value)) {
            input.focus();
            return true;
        }
    }
    return false;
}
function focusNext(r, c) {
    const word = getActiveWordAt(r, c, lastDirection); if (!word) return;
    focusOpenCellInWord(word, getCellPositionInWord(word, r, c), 1, true);
}
function focusPrev(r, c) {
    const word = getActiveWordAt(r, c, lastDirection); if (!word) return;
    focusOpenCellInWord(word, getCellPositionInWord(word, r, c), -1);
}
function focusNextInWord(r, c, dir) {
    const word = gameState.soal.find(s => s.direction === dir && wordContainsCell(s, r, c));
    if (!word) return;
    focusOpenCellInWord(word, getCellPositionInWord(word, r, c), 1);
}
function focusPrevInWord(r, c, dir) {
    const word = gameState.soal.find(s => s.direction === dir && wordContainsCell(s, r, c));
    if (!word) return;
    focusOpenCellInWord(word, getCellPositionInWord(word, r, c), -1);
}
// ────────────────────────────────────────────────
//  🔊 SOUND EFFECTS
// ────────────────────────────────────────────────
let audioContext;

const audioConfig = {
    volume: 0.3,
    sample: 44100,
};

function initAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
}

function playTone(frequency, duration, volume = 0.3, envelope = 'default') {
    const ctx = initAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.frequency.value = frequency;
    osc.type = 'sine';
    gain.gain.value = 0;
    
    if (envelope === 'default') {
        gain.gain.linearRampToValueAtTime(volume, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.01, now + duration - 0.05);
    } else if (envelope === 'punch') {
        gain.gain.linearRampToValueAtTime(volume, now + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.01, now + duration - 0.02);
    }
    
    osc.start(now);
    osc.stop(now + duration);
}

function playWordSound(isCorrect = true) {
    if (isCorrect) {
        const frequencies = [523.25, 659.25, 783.99];
        frequencies.forEach((freq, i) => {
            setTimeout(() => playTone(freq, 0.15, 0.25), i * 100);
        });
    }
}

function playBurnSound() {
    for (let i = 0; i < 5; i++) {
        setTimeout(() => {
            const freq = 200 + Math.random() * 300;
            playTone(freq, 0.1, 0.4, 'punch');
        }, i * 80);
    }
}

function playVictorySound() {
    const frequencies = [523.25, 659.25, 783.99, 987.77, 1174.66];
    frequencies.forEach((freq, i) => {
        setTimeout(() => playTone(freq, 0.2, 0.25), i * 150);
    });
}

function playCellSound() {
    playTone(800 + Math.random() * 200, 0.05, 0.15);
}

function playGameStartSound() {
    playTone(400, 0.1, 0.3);
    setTimeout(() => playTone(600, 0.2, 0.3), 100);
}

// Start
lockBrowserZoom();
checkAuth();
