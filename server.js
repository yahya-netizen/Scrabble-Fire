const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Load questions
const dataSoal = JSON.parse(fs.readFileSync('soal.json', 'utf8'));

// Initialize 15x15 grid
let gridState = {}; // { "row-col": { char: 'A', locked: false } }
let completedWords = {}; // { wordId: username }
let scores = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Send initial state
    socket.emit('init_game', {
        soal: dataSoal,
        grid: gridState,
        completedWords: completedWords,
        scores: scores
    });

    // Handle real-time typing
    socket.on('cell_update', (data) => {
        const { row, col, char, username } = data;
        const cellId = `${row}-${col}`;

        // Update grid if not locked
        if (!gridState[cellId] || !gridState[cellId].locked) {
            gridState[cellId] = { char: char.toUpperCase(), lastBy: username };
            
            // Broadcast to everyone else
            socket.broadcast.emit('cell_updated', { row, col, char: char.toUpperCase(), username });

            // Check if any word is completed
            checkWordCompletion(username);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

function checkWordCompletion(username) {
    dataSoal.forEach(soal => {
        if (completedWords[soal.id]) return;

        let isCorrect = true;
        let wordChars = [];

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

            // Lock cells for this word
            for (let i = 0; i < soal.answer.length; i++) {
                let r = soal.row;
                let c = soal.col;
                if (soal.direction === 'across') c += i;
                else r += i;
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

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Scrable Fire running at http://localhost:${PORT}`);
});