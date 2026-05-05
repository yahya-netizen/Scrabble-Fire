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
const USERS_FILE = 'users.json';
const SOAL_FILE = 'soal.json';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// Helpers for persistence
const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const writeUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
const readSoal = () => JSON.parse(fs.readFileSync(SOAL_FILE, 'utf8'));

// ─────────────────────────────────────────────
//  ROOM MANAGEMENT
// ─────────────────────────────────────────────
const GAME_DURATION = 180; // seconds
const MAX_PLAYERS_PER_ROOM = 4;
const rooms = new Map();

function createRoom(roomId) {
    return {
        id: roomId,
        players: {},          // socketId → { username, score, color }
        gridState: {},        // "r-c" → { char, locked, lockedBy }
        completedWords: {},   // wordId → username
        timer: null,
        timeLeft: GAME_DURATION,
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
            list.push({ id, playerCount, maxPlayers: MAX_PLAYERS_PER_ROOM, gameStarted: room.gameStarted });
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
    if (!room || room.timer) return;

    room.gameStarted = true;
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

    io.to(roomId).emit('game_over', {
        reason,
        rankings,
        winner: winner ? winner.username : 'Tidak Ada',
        completedWords: room.completedWords
    });
}

function checkWordCompletion(room, roomId, username) {
    const dataSoal = readSoal();
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
    res.json(readSoal());
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

    socket.on('join_room', ({ roomId }) => {
        if (!roomId) return;
        
        let room = rooms.get(roomId);
        if (!room) {
            room = createRoom(roomId);
            rooms.set(roomId, room);
        }

        if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('join_error', { message: 'Room penuh!' });
            return;
        }

        if (room.gameOver) {
            socket.emit('join_error', { message: 'Permainan sudah selesai.' });
            return;
        }

        const color = assignColor(room);
        room.players[socket.id] = { username, score: 0, color, socketId: socket.id };
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.username = username;

        socket.emit('game_state', {
            soal: readSoal(),
            grid: room.gridState,
            completedWords: room.completedWords,
            scores: buildScores(room),
            timeLeft: room.timeLeft,
            gameStarted: room.gameStarted,
            gameOver: room.gameOver,
            myColor: color
        });

        io.to(roomId).emit('player_joined', {
            username,
            color,
            players: Object.values(room.players).map(p => ({ username: p.username, score: p.score, color: p.color }))
        });

        io.emit('room_list', getRoomList());

        if (!room.gameStarted) {
            startTimer(roomId);
        }
    });

    socket.on('cell_update', ({ row, col, char }) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room || room.gameOver) return;

        const cellId = `${row}-${col}`;
        if (room.gridState[cellId] && room.gridState[cellId].locked) return;

        room.gridState[cellId] = {
            char: char ? char.toUpperCase() : '',
            locked: false,
            lastBy: username
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
                io.to(roomId).emit('player_left', {
                    username,
                    players: Object.values(room.players).map(p => ({ username: p.username, score: p.score, color: p.color }))
                });
                if (Object.keys(room.players).length === 0 && !room.gameStarted) {
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