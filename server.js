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
const io = new Server(server);

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

// Game State
let gridState = {}; 
let completedWords = {}; 
let scores = {};

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

// --- DATA API ---

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

app.get('/api/leaderboard', (req, res) => {
    res.json(scores);
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
    console.log(`User connected: ${username} (${socket.id})`);

    // Send initial state
    socket.emit('init_game', {
        soal: readSoal(),
        grid: gridState,
        completedWords: completedWords,
        scores: scores
    });

    socket.on('cell_update', (data) => {
        const { row, col, char } = data;
        const cellId = `${row}-${col}`;

        if (!gridState[cellId] || !gridState[cellId].locked) {
            gridState[cellId] = { char: char.toUpperCase(), lastBy: username };
            socket.broadcast.emit('cell_updated', { row, col, char: char.toUpperCase(), username });
            checkWordCompletion(username);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${username}`);
    });
});

function checkWordCompletion(username) {
    const dataSoal = readSoal();
    dataSoal.forEach(soal => {
        if (completedWords[soal.id]) return;

        let isCorrect = true;
        for (let i = 0; i < soal.answer.length; i++) {
            let r = soal.row;
            let c = soal.col;
            if (soal.direction === 'across') c += i;
            else r += i;

            const cellId = `${r}-${c}`;
            const cell = gridState[cellId];
            if (!cell || cell.char !== soal.answer[i].toUpperCase()) {
                isCorrect = false;
                break;
            }
        }

        if (isCorrect) {
            completedWords[soal.id] = username;
            if (!scores[username]) scores[username] = 0;
            scores[username] += 10;

            for (let i = 0; i < soal.answer.length; i++) {
                let r = soal.row, c = soal.col;
                if (soal.direction === 'across') c += i; else r += i;
                gridState[`${r}-${c}`].locked = true;
            }

            io.emit('word_completed', {
                wordId: soal.id,
                username: username,
                scores: scores,
                answer: soal.answer
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});