require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const JWT_SECRET = process.env.JWT_SECRET || 'secret';
const USERS_FILE = process.env.USERS_FILE || 'data/users.json';
const SOAL_FILE = 'soal.json';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// Helpers for persistence
const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const writeUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
const readSoalData = () => JSON.parse(fs.readFileSync(SOAL_FILE, 'utf8'));
const normalizeSoalData = () => {
    const data = readSoalData();
    if (Array.isArray(data)) {
        return {
            categories: [
                {
                    id: 'default',
                    name: 'Default',
                    description: 'Kategori bawaan dari format soal lama.',
                    questions: data
                }
            ]
        };
    }
    return data;
};
const getCategories = () => normalizeSoalData().categories.map(category => ({
    id: category.id,
    name: category.name || category.id,
    description: category.description || '',
    questionCount: Array.isArray(category.questions) ? category.questions.length : 0
}));
const getCategoryById = (categoryId) => {
    const categories = normalizeSoalData().categories;
    return categories.find(category => category.id === categoryId) || categories[0];
};
const getSoalByCategory = (categoryId) => {
    const category = getCategoryById(categoryId);
    return category && Array.isArray(category.questions) ? category.questions : [];
};

// ─────────────────────────────────────────────
//  ROOM MANAGEMENT
// ─────────────────────────────────────────────
const DEFAULT_GAME_DURATION = 180; // seconds
const MAX_PLAYERS_PER_ROOM = 4;
const rooms = new Map();

function normalizeDuration(duration) {
    const parsed = Number(duration);
    if (!Number.isFinite(parsed)) return DEFAULT_GAME_DURATION;
    return Math.min(Math.max(Math.round(parsed), 60), 1800);
}

function createRoom(roomId, settings = {}) {
    const category = getCategoryById(settings.categoryId) || {
        id: 'empty',
        name: 'Tanpa Kategori',
        questions: []
    };
    const duration = normalizeDuration(settings.duration);

    return {
        id: roomId,
        categoryId: category.id,
        categoryName: category.name,
        duration,
        soal: getSoalByCategory(category.id),
        starterSocketId: null,
        players: {},          // socketId → { username, score, color }
        gridState: {},        // "r-c" → { char, locked, lockedBy }
        completedWords: {},   // wordId → username
        timer: null,
        timeLeft: duration,
        gameStarted: false,
        gameOver: false,
        validating: new Set()
    };
}

function getRoomList() {
    const list = [];
    rooms.forEach((room, id) => {
        const playerCount = Object.keys(room.players).length;
        if (!room.gameOver && playerCount < MAX_PLAYERS_PER_ROOM) {
            list.push({
                id,
                playerCount,
                maxPlayers: MAX_PLAYERS_PER_ROOM,
                gameStarted: room.gameStarted,
                categoryId: room.categoryId,
                categoryName: room.categoryName,
                duration: room.duration
            });
        }
    });
    return list;
}

const PLAYER_COLORS = ['#ff4500', '#00cfff', '#39ff14', '#ff00ff', '#ffd700'];
function assignColor(room) {
    const used = Object.values(room.players).map(p => p.color);
    return PLAYER_COLORS.find(c => !used.includes(c)) || PLAYER_COLORS[0];
}

function startTimer(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.timer || room.gameOver) return;

    room.gameStarted = true;
    io.to(roomId).emit('game_started', {
        timeLeft: room.timeLeft,
        soal: room.soal,
        message: 'Game dimulai!'
    });

    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomId).emit('timer_update', { timeLeft: room.timeLeft });

        if (room.timeLeft <= 0) {
            endGame(roomId, 'Waktu Habis!');
        }
    }, 1000);
}

function endGame(roomId, reason) {
    const room = rooms.get(roomId);
    if (!room || room.gameOver) return;

    room.gameOver = true;
    clearInterval(room.timer);
    room.timer = null;

    const rankings = Object.values(room.players)
        .sort((a, b) => b.score - a.score)
        .map((p, i) => ({ rank: i + 1, username: p.username, score: p.score, color: p.color }));

    const winner = rankings[0] || null;
    const burnedCells = winner ? Object.entries(room.gridState)
        .filter(([, cell]) => cell && cell.char && (cell.lockedBy || cell.lastBy) && (cell.lockedBy || cell.lastBy) !== winner.username)
        .map(([cellId, cell]) => {
            const [row, col] = cellId.split('-').map(Number);
            const owner = cell.lockedBy || cell.lastBy;
            const ownerPlayer = Object.values(room.players).find(p => p.username === owner);
            return {
                row,
                col,
                char: cell.char,
                owner,
                locked: !!cell.locked,
                color: ownerPlayer ? ownerPlayer.color : cell.lockedColor || cell.lastColor || '#ffffff'
            };
        }) : [];

    io.to(roomId).emit('game_over', {
        reason,
        rankings,
        winner: winner ? winner.username : 'Tidak Ada',
        winnerColor: winner ? winner.color : null,
        burnedCells,
        completedWords: room.completedWords
    });
}

function checkWordCompletion(room, roomId, username) {
    const dataSoal = room.soal;
    dataSoal.forEach(soal => {
        if (room.completedWords[soal.id]) return;
        if (room.validating.has(soal.id)) return;

        let isCorrect = true;
        for (let i = 0; i < soal.answer.length; i++) {
            let r = soal.row;
            let c = soal.col;
            if (soal.direction === 'across') c += i;
            else r += i;

            const cell = room.gridState[`${r}-${c}`];
            if (!cell || cell.char !== soal.answer[i].toUpperCase()) {
                isCorrect = false;
                break;
            }
        }

        if (isCorrect) {
            room.validating.add(soal.id);

            if (room.completedWords[soal.id]) {
                room.validating.delete(soal.id);
                return;
            }

            room.completedWords[soal.id] = username;
            const player = Object.values(room.players).find(p => p.username === username);
            if (player) {
                player.score += soal.answer.length * 2;
            }

            for (let i = 0; i < soal.answer.length; i++) {
                let r = soal.row, c = soal.col;
                if (soal.direction === 'across') c += i; else r += i;
                const cellId = `${r}-${c}`;
                if (!room.gridState[cellId]) room.gridState[cellId] = { char: soal.answer[i] };
                room.gridState[cellId].locked = true;
                room.gridState[cellId].lockedBy = username;
                room.gridState[cellId].lockedColor = player ? player.color : '#ffffff';
            }

            const scores = buildScores(room);
            io.to(roomId).emit('word_completed', {
                wordId: soal.id,
                username,
                scores,
                answer: soal.answer,
                direction: soal.direction,
                row: soal.row,
                col: soal.col,
                color: player ? player.color : '#ffffff',
                pointsEarned: soal.answer.length * 2
            });

            room.validating.delete(soal.id);

            if (Object.keys(room.completedWords).length === dataSoal.length) {
                setTimeout(() => endGame(roomId, 'Semua Kata Selesai! 🎉'), 800);
            }
        }
    });
}

function buildScores(room) {
    const scores = {};
    Object.values(room.players).forEach(p => {
        scores[p.username] = { score: p.score, color: p.color };
    });
    return scores;
}

function buildPlayers(room) {
    return Object.values(room.players).map(p => ({
        username: p.username,
        score: p.score,
        color: p.color,
        canStart: p.socketId === room.starterSocketId
    }));
}

// --- AUTH API ---

app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ message: 'Username dan password diperlukan' });

        const users = readUsers();
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ message: 'Username sudah terdaftar' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        users.push({ username, password: hashedPassword });
        writeUsers(users);

        res.status(201).json({ message: 'Registrasi berhasil' });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = readUsers();
        const user = users.find(u => u.username === username);

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: 'Username atau password salah' });
        }

        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1d' });
        res.cookie('token', token, { httpOnly: true });
        res.json({ message: 'Login berhasil', username });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logout berhasil' });
});

app.get('/api/me', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ message: 'Not authenticated' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        res.json({ username: decoded.username });
    } catch (error) {
        res.status(401).json({ message: 'Invalid token' });
    }
});

app.get('/api/soal', (req, res) => {
    const categoryId = req.query.category;
    res.json(categoryId ? getSoalByCategory(categoryId) : normalizeSoalData());
});

app.get('/api/categories', (req, res) => {
    res.json(getCategories());
});

// --- WEBSOCKET AUTH ---

io.use((socket, next) => {
    const cookie = socket.handshake.headers.cookie;
    if (!cookie) return next(new Error('Authentication error'));

    const token = cookie.split('; ').find(row => row.startsWith('token='))?.split('=')[1];
    if (!token) return next(new Error('Authentication error'));

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.user = decoded;
        next();
    } catch (err) {
        next(new Error('Authentication error'));
    }
});

// --- WEBSOCKET LOGIC ---

io.on('connection', (socket) => {
    const username = socket.user.username;
    console.log(`Connected: ${username} (${socket.id})`);

    socket.on('get_rooms', () => {
        socket.emit('room_list', getRoomList());
    });

    socket.on('join_room', ({ roomId, settings }) => {
        if (!roomId) return;
        
        let room = rooms.get(roomId);
        if (room && room.gameOver && Object.keys(room.players).length === 0) {
            clearInterval(room.timer);
            rooms.delete(roomId);
            room = null;
        }

        if (!room) {
            room = createRoom(roomId, settings);
            if (!room.soal.length) {
                socket.emit('join_error', { message: 'Kategori soal ini belum punya soal.' });
                return;
            }
            rooms.set(roomId, room);
        }

        if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('join_error', { message: 'Room penuh!' });
            return;
        }

        if (room.gameOver) {
            socket.emit('join_error', { message: 'Permainan sudah selesai. Tunggu semua pemain keluar, lalu buat room lagi dengan ID yang sama.' });
            return;
        }

        const color = assignColor(room);
        room.players[socket.id] = { username, score: 0, color, socketId: socket.id };
        if (!room.starterSocketId || !room.players[room.starterSocketId]) {
            room.starterSocketId = socket.id;
        }
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.username = username;

        socket.emit('game_state', {
            soal: room.gameStarted ? room.soal : [],
            grid: room.gridState,
            completedWords: room.completedWords,
            scores: buildScores(room),
            timeLeft: room.timeLeft,
            duration: room.duration,
            categoryId: room.categoryId,
            categoryName: room.categoryName,
            gameStarted: room.gameStarted,
            gameOver: room.gameOver,
            canStart: socket.id === room.starterSocketId,
            starterUsername: room.players[room.starterSocketId]?.username || username,
            myColor: color
        });

        io.to(roomId).emit('player_joined', {
            username,
            color,
            starterUsername: room.players[room.starterSocketId]?.username || username,
            players: buildPlayers(room)
        });

        io.emit('room_list', getRoomList());
    });

    socket.on('start_game', () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room || room.gameOver || room.gameStarted) return;

        if (socket.id !== room.starterSocketId) {
            socket.emit('start_error', { message: 'Hanya pemain pertama yang bisa memulai game.' });
            return;
        }

        startTimer(roomId);
        io.emit('room_list', getRoomList());
    });

    socket.on('cell_update', ({ row, col, char }) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room || room.gameOver || !room.gameStarted) return;

        const cellId = `${row}-${col}`;
        if (room.gridState[cellId] && room.gridState[cellId].locked) return;

        const player = room.players[socket.id];
        room.gridState[cellId] = {
            char: char ? char.toUpperCase() : '',
            locked: false,
            lastBy: username,
            lastColor: player ? player.color : '#ffffff'
        };

        socket.to(roomId).emit('cell_updated', { row, col, char: char ? char.toUpperCase() : '', username });

        if (char) {
            checkWordCompletion(room, roomId, username);
        }
    });

    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        if (roomId) {
            const room = rooms.get(roomId);
            if (room) {
                delete room.players[socket.id];
                if (room.starterSocketId === socket.id) {
                    room.starterSocketId = Object.keys(room.players)[0] || null;
                }
                io.to(roomId).emit('player_left', {
                    username,
                    starterUsername: room.starterSocketId ? room.players[room.starterSocketId].username : null,
                    players: buildPlayers(room)
                });
                if (Object.keys(room.players).length === 0) {
                    clearInterval(room.timer);
                    rooms.delete(roomId);
                }
            }
        }
        io.emit('room_list', getRoomList());
        console.log(`Disconnected: ${username}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 Scrabble Fire running at http://localhost:${PORT}`);
});
