let socket;
let myUsername = null;
let gameState = {
    soal: [],
    grid: {},
    completedWords: {},
    scores: {}
};

// --- DOM Elements ---
const authOverlay = document.getElementById('auth-overlay');
const gameUi = document.getElementById('game-ui');
const authMessage = document.getElementById('auth-message');
const userInfo = document.getElementById('user-info');

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');

const gridElement = document.getElementById('grid');
const listAcross = document.getElementById('list-across');
const listDown = document.getElementById('list-down');
const scoresElement = document.getElementById('scores');

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
    gameUi.style.display = 'none';
}

function startAs(username) {
    myUsername = username;
    userInfo.innerText = `Pemain: ${username}`;
    authOverlay.style.display = 'none';
    gameUi.style.display = 'block';
    initSocket();
    initGrid();
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
    if (res.ok) {
        setTimeout(() => document.getElementById('show-login').click(), 1000);
    }
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
    if (res.ok) {
        startAs(data.username);
    } else {
        authMessage.innerText = data.message;
    }
};

document.getElementById('btn-logout').onclick = async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
};

// --- Game Logic ---

function initGrid() {
    gridElement.innerHTML = '';
    for (let r = 1; r <= 15; r++) {
        for (let c = 1; c <= 15; c++) {
            const container = document.createElement('div');
            container.className = 'cell-container';
            container.id = `cont-${r}-${c}`;

            const input = document.createElement('input');
            input.type = 'text';
            input.maxLength = 1;
            input.className = 'cell';
            input.id = `cell-${r}-${c}`;
            input.dataset.row = r;
            input.dataset.col = c;

            input.addEventListener('input', (e) => {
                const char = e.target.value.toUpperCase();
                if (char) {
                    socket.emit('cell_update', { row: r, col: c, char: char });
                    focusNext(r, c);
                }
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !e.target.value) focusPrev(r, c);
            });

            container.appendChild(input);
            gridElement.appendChild(container);
        }
    }
}

function initSocket() {
    socket = io();

    socket.on('init_game', (data) => {
        gameState = data;
        renderAll();
    });

    socket.on('cell_updated', (data) => {
        const { row, col, char } = data;
        const input = document.getElementById(`cell-${row}-${col}`);
        if (input) {
            input.value = char;
            input.classList.add('typing-effect');
            setTimeout(() => input.classList.remove('typing-effect'), 400);
        }
    });

    socket.on('word_completed', (data) => {
        const { wordId, username, scores } = data;
        gameState.completedWords[wordId] = username;
        gameState.scores = scores;
        renderAll();
    });

    socket.on('connect_error', (err) => {
        console.error('Socket error:', err.message);
        if (err.message === 'Authentication error') {
            showAuth();
        }
    });
}

function renderAll() {
    // Reset grid
    document.querySelectorAll('.cell').forEach(cell => {
        cell.classList.remove('active', 'locked');
        cell.disabled = true;
    });
    document.querySelectorAll('.cell-number').forEach(n => n.remove());

    // Set clues and active cells
    gameState.soal.forEach(s => {
        // Add number
        const startCont = document.getElementById(`cont-${s.row}-${s.col}`);
        if (startCont && !startCont.querySelector('.cell-number')) {
            const numDiv = document.createElement('div');
            numDiv.className = 'cell-number';
            numDiv.innerText = s.number;
            startCont.appendChild(numDiv);
        }

        for (let i = 0; i < s.answer.length; i++) {
            let r = s.row, c = s.col;
            if (s.direction === 'across') c += i; else r += i;

            const input = document.getElementById(`cell-${r}-${c}`);
            if (input) {
                input.classList.add('active');
                input.disabled = false;

                const cellId = `${r}-${c}`;
                if (gameState.grid[cellId]) {
                    input.value = gameState.grid[cellId].char;
                    if (gameState.grid[cellId].locked) {
                        input.classList.add('locked');
                        input.disabled = true;
                    }
                }
            }
        }
    });

    // Render Clues
    listAcross.innerHTML = '';
    listDown.innerHTML = '';
    gameState.soal.forEach(s => {
        const isDone = gameState.completedWords[s.id];
        const li = document.createElement('li');
        li.className = `clue-item ${isDone ? 'completed' : ''}`;
        li.innerHTML = `<strong>${s.number}.</strong> ${s.clue} ${isDone ? `(${isDone})` : ''}`;
        
        if (s.direction === 'across') listAcross.appendChild(li);
        else listDown.appendChild(li);
    });

    // Render Scores
    scoresElement.innerHTML = '';
    Object.entries(gameState.scores).sort((a,b) => b[1] - a[1]).forEach(([name, score]) => {
        scoresElement.innerHTML += `<li><span>${name}</span> <span>${score} Poin</span></li>`;
    });
}

function focusNext(r, c) {
    const currentWord = gameState.soal.find(s => {
        if (s.direction === 'across' && r === s.row && c >= s.col && c < s.col + s.answer.length) return true;
        if (s.direction === 'down' && c === s.col && r >= s.row && r < s.row + s.answer.length) return true;
        return false;
    });

    if (currentWord) {
        let nextR = r, nextC = c;
        if (currentWord.direction === 'across') nextC++; else nextR++;
        const nextInput = document.getElementById(`cell-${nextR}-${nextC}`);
        if (nextInput && nextInput.classList.contains('active') && !nextInput.disabled) nextInput.focus();
    }
}

function focusPrev(r, c) {
    const currentWord = gameState.soal.find(s => {
        if (s.direction === 'across' && r === s.row && c > s.col && c < s.col + s.answer.length) return true;
        if (s.direction === 'down' && c === s.col && r > s.row && r < s.row + s.answer.length) return true;
        return false;
    });

    if (currentWord) {
        let prevR = r, prevC = c;
        if (currentWord.direction === 'across') prevC--; else prevR--;
        const prevInput = document.getElementById(`cell-${prevR}-${prevC}`);
        if (prevInput) prevInput.focus();
    }
}

// Start
checkAuth();