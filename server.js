const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

// Store game state
let players = {}; // socket.id -> { anonymousName, ready, isActive }
let gameActive = false;
let currentRound = null; // { bottomId, topId, askerId, answererId, state, question, answer }

const anonymousNames = [
    'Purple Panda', 'Silent Wolf', 'Crimson Fox', 'Golden Eagle', 'Shadow Cat',
    'Mystic Owl', 'Thunder Hawk', 'Frost Dragon', 'Ember Phoenix', 'Storm Tiger',
    'Night Raven', 'Blazing Lion', 'Ocean Serpent', 'Iron Viper', 'Crystal Cobra'
];

function generateAnonymousName() {
    const available = anonymousNames.filter(name => !Object.values(players).some(p => p.anonymousName === name));
    if (available.length === 0) return `Guest${Math.floor(Math.random() * 1000)}`;
    return available[Math.floor(Math.random() * available.length)];
}

function broadcastPlayers() {
    const playersList = Object.entries(players).map(([id, p]) => ({
        id,
        anonymousName: p.anonymousName,
        ready: p.ready,
        isActive: p.isActive
    }));
    io.emit('players-update', playersList);
}

function broadcastGameState() {
    io.emit('game-state', { gameActive, currentRound });
}

function checkAutoStartRound() {
    const allPlayers = Object.values(players);
    if (!gameActive && allPlayers.length >= 8 && allPlayers.every(p => p.ready)) {
        // Auto-start game when 8+ players and all ready
        gameActive = true;
        broadcastGameState();
    }
}

io.on('connection', (socket) => {
    console.log('New player connected:', socket.id);
    
    // Assign anonymous name
    const anonymousName = generateAnonymousName();
    players[socket.id] = { anonymousName, ready: false, isActive: true };
    broadcastPlayers();
    
    // Send current state to new player
    socket.emit('game-state', { gameActive, currentRound });
    
    // Handle ready toggle
    socket.on('player-ready', (ready) => {
        if (players[socket.id]) {
            players[socket.id].ready = ready;
            broadcastPlayers();
            checkAutoStartRound();
        }
    });
    
    // Handle spin bottle (only when game active and no round in progress)
    socket.on('spin-bottle', () => {
        if (!gameActive || currentRound) return;
        
        const playerIds = Object.keys(players);
        if (playerIds.length < 2) return;
        
        // Random bottom and top (different players)
        let bottomId = playerIds[Math.floor(Math.random() * playerIds.length)];
        let topId = bottomId;
        while (topId === bottomId && playerIds.length > 1) {
            topId = playerIds[Math.floor(Math.random() * playerIds.length)];
        }
        
        currentRound = {
            bottomId,
            topId,
            askerId: bottomId, // bottom asks
            answererId: topId, // top answers
            state: 'waiting_question', // waiting_question, waiting_answer, completed
            question: null,
            answer: null
        };
        
        broadcastGameState();
        
        // Start 20-second countdown
        let timeLeft = 20;
        const countdownInterval = setInterval(() => {
            if (!currentRound) {
                clearInterval(countdownInterval);
                return;
            }
            io.emit('countdown', timeLeft);
            if (timeLeft === 3 || timeLeft === 2 || timeLeft === 1) {
                // Beep sound handled client-side
                io.emit('beep');
            }
            if (timeLeft <= 0) {
                clearInterval(countdownInterval);
                if (currentRound.state !== 'completed') {
                    currentRound.state = 'completed';
                    broadcastGameState();
                    io.emit('timeout');
                }
            }
            timeLeft--;
        }, 1000);
        
        // Store interval to clear later
        socket.intervalId = countdownInterval;
    });
    
    // Handle question from bottom
    socket.on('send-question', (question) => {
        if (!currentRound || currentRound.state !== 'waiting_question') return;
        if (socket.id !== currentRound.bottomId) return;
        
        currentRound.question = question;
        currentRound.state = 'waiting_answer';
        broadcastGameState();
        
        // Notify top that they can answer
        io.to(currentRound.topId).emit('you-can-answer');
    });
    
    // Handle answer from top
    socket.on('send-answer', (answer) => {
        if (!currentRound || currentRound.state !== 'waiting_answer') return;
        if (socket.id !== currentRound.topId) return;
        
        currentRound.answer = answer;
        currentRound.state = 'completed';
        broadcastGameState();
    });
    
    // Handle next round
    socket.on('next-round', () => {
        if (!gameActive) return;
        currentRound = null;
        broadcastGameState();
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete players[socket.id];
        broadcastPlayers();
        
        // If current round player left, reset round
        if (currentRound && (currentRound.bottomId === socket.id || currentRound.topId === socket.id)) {
            currentRound = null;
            broadcastGameState();
        }
        
        // If less than 8 players, deactivate game
        if (gameActive && Object.keys(players).length < 8) {
            gameActive = false;
            currentRound = null;
            broadcastGameState();
        }
    });
});

server.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
    console.log('For classroom: find your local IP (ipconfig on Windows, ifconfig on Mac/Linux) and use http://YOUR_IP:3000');
});
