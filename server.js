const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static('public'));

// Load questions
const dataSoal = JSON.parse(fs.readFileSync('soal.json', 'utf8'));

// ─────────────────────────────────────────────
//  ROOM MANAGEMENT
// ─────────────────────────────────────────────
const GAME_DURATION = 180; // seconds
const MAX_PLAYERS_PER_ROOM = 4;

// rooms: Map<roomId, RoomState>
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
        // Mutex: set of wordIds currently being validated (prevent race condition)
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

// Player colors
const PLAYER_COLORS = ['#ff4500', '#00cfff', '#39ff14', '#ff00ff', '#ffd700'];
function assignColor(room) {
    const used = Object.values(room.players).map(p => p.color);
    return PLAYER_COLORS.find(c => !used.includes(c)) || PLAYER_COLORS[0];
}

// ─────────────────────────────────────────────
//  TIMER
// ─────────────────────────────────────────────
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

    // Calculate final rankings
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

// ─────────────────────────────────────────────
//  WORD COMPLETION CHECK (with Race Condition Guard)
// ─────────────────────────────────────────────
function checkWordCompletion(room, roomId, username) {
    dataSoal.forEach(soal => {
        // Already completed
        if (room.completedWords[soal.id]) return;
        // Currently being validated by another simultaneous request
        if (room.validating.has(soal.id)) return;

        // Check if all chars match
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
            // LOCK immediately to prevent race condition
            room.validating.add(soal.id);

            // Double-check after lock (another fiber might have completed it)
            if (room.completedWords[soal.id]) {
                room.validating.delete(soal.id);
                return;
            }

            // Register completion
            room.completedWords[soal.id] = username;

            // Find the player and add score
            const player = Object.values(room.players).find(p => p.username === username);
            if (player) {
                player.score += soal.answer.length * 2; // score = 2 × panjang kata
            }

            // Lock all cells of this word
            for (let i = 0; i < soal.answer.length; i++) {
                let r = soal.row;
                let c = soal.col;
                if (soal.direction === 'across') c += i;
                else r += i;
                const cellId = `${r}-${c}`;
                room.gridState[cellId].locked = true;
                room.gridState[cellId].lockedBy = username;
                room.gridState[cellId].lockedColor = player ? player.color : '#ffffff';
            }

            // Build current scores for broadcast
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

            // Check if all words are done → end game
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

// ─────────────────────────────────────────────
//  SOCKET.IO EVENTS
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    // ── Lobby: request available rooms ──
    socket.on('get_rooms', () => {
        socket.emit('room_list', getRoomList());
    });

    // ── Join Room ──
    socket.on('join_room', ({ roomId, username }) => {
        // Validation
        if (!roomId || !username) return;
        username = username.trim().substring(0, 20) || 'Anonim';

        let room = rooms.get(roomId);

        // Create room if not exists
        if (!room) {
            room = createRoom(roomId);
            rooms.set(roomId, room);
        }

        // Room full check
        if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('join_error', { message: 'Room penuh! Maksimal 4 pemain.' });
            return;
        }

        // Game already over
        if (room.gameOver) {
            socket.emit('join_error', { message: 'Permainan di room ini sudah selesai.' });
            return;
        }

        // Register player
        const color = assignColor(room);
        room.players[socket.id] = { username, score: 0, color, socketId: socket.id };
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.username = username;

        // Send current state to this player
        socket.emit('game_state', {
            soal: dataSoal,
            grid: room.gridState,
            completedWords: room.completedWords,
            scores: buildScores(room),
            timeLeft: room.timeLeft,
            gameStarted: room.gameStarted,
            gameOver: room.gameOver,
            myColor: color
        });

        // Notify everyone in room about new player
        io.to(roomId).emit('player_joined', {
            username,
            color,
            players: Object.values(room.players).map(p => ({ username: p.username, score: p.score, color: p.color }))
        });

        // Broadcast updated room list to lobby
        io.emit('room_list', getRoomList());

        // Auto-start timer when at least 1 player joins (solo mode allowed)
        if (!room.gameStarted) {
            startTimer(roomId);
        }

        console.log(`${username} joined room ${roomId}`);
    });

    // ── Cell Update (real-time typing) ──
    socket.on('cell_update', ({ row, col, char }) => {
        const roomId = socket.data.roomId;
        const username = socket.data.username;
        if (!roomId || !username) return;

        const room = rooms.get(roomId);
        if (!room || room.gameOver) return;

        const cellId = `${row}-${col}`;

        // Ignore if cell is locked
        if (room.gridState[cellId] && room.gridState[cellId].locked) return;

        // Update grid
        room.gridState[cellId] = {
            char: char ? char.toUpperCase() : '',
            locked: false,
            lastBy: username
        };

        // Broadcast to everyone ELSE in the room
        socket.to(roomId).emit('cell_updated', {
            row, col,
            char: char ? char.toUpperCase() : '',
            username
        });

        // Check if any word is now complete
        if (char) {
            checkWordCompletion(room, roomId, username);
        }
    });

    // ── Disconnect ──
    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        const username = socket.data.username;

        if (roomId) {
            const room = rooms.get(roomId);
            if (room) {
                delete room.players[socket.id];

                io.to(roomId).emit('player_left', {
                    username,
                    players: Object.values(room.players).map(p => ({ username: p.username, score: p.score, color: p.color }))
                });

                // Clean up empty rooms (but keep finished game rooms for a bit)
                if (Object.keys(room.players).length === 0 && !room.gameStarted) {
                    clearInterval(room.timer);
                    rooms.delete(roomId);
                }
            }
        }

        io.emit('room_list', getRoomList());
        console.log('Disconnected:', socket.id, username);
    });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 Scrabble Fire running at http://localhost:${PORT}`);
});