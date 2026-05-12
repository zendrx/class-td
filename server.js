const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname)));

// Game state
let gameState = {
    players: [],           // { id, name, isAdmin }
    bracket: [],           // tournament bracket
    currentMatch: null,    // { playerA, playerB, leg, aggregate, board, turn, gameActive, winner }
    matchIndex: 0,         // current match index in bracket
    roundIndex: 0,         // current round index
    tournamentStarted: false,
    availableSpots: 16     // UEFA-style round of 16
};

// Helper: Create empty bracket
function createBracket(playerList) {
    // Fill to next power of 2 (8, 16, 32)
    let size = 8;
    while (size < playerList.length) size *= 2;
    
    let bracket = [];
    for (let i = 0; i < size; i++) {
        bracket.push(playerList[i] || { name: 'TBD', id: null });
    }
    return bracket;
}

// Helper: Build matches from bracket
function buildMatchesFromBracket(bracket, round = 0) {
    let matches = [];
    let step = Math.pow(2, round + 1);
    for (let i = 0; i < bracket.length; i += step) {
        matches.push({
            playerA: bracket[i],
            playerB: bracket[i + step/2],
            winner: null,
            leg1Result: null,
            leg2Result: null,
            leg3Result: null
        });
    }
    return matches;
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Register player
    socket.on('register', ({ name, isAdmin }) => {
        const existing = gameState.players.find(p => p.name === name);
        if (existing) {
            socket.emit('registered', { success: false, error: 'Name already taken' });
            return;
        }
        
        const player = { id: socket.id, name, isAdmin };
        gameState.players.push(player);
        socket.emit('registered', { success: true, player });
        
        // If not started and we have enough players, auto-fill bracket
        if (!gameState.tournamentStarted && gameState.players.length >= 2) {
            // Wait for 16 or max players
            if (gameState.players.length >= gameState.availableSpots || gameState.players.length === gameState.availableSpots) {
                startTournament();
            }
        }
        
        io.emit('stateUpdate', gameState);
    });
    
    function startTournament() {
        // Shuffle players
        let shuffled = [...gameState.players];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        
        // Fill bracket slots
        let bracketSlots = [];
        for (let i = 0; i < gameState.availableSpots; i++) {
            bracketSlots.push(shuffled[i] || { name: 'BYE', id: null });
        }
        
        gameState.bracket = bracketSlots;
        gameState.matches = buildMatchesFromBracket(bracketSlots, 0);
        gameState.currentRound = 0;
        gameState.currentMatchIdx = 0;
        gameState.tournamentStarted = true;
        
        // Start first match
        startMatch(0, 0);
        
        io.emit('stateUpdate', gameState);
    }
    
    function startMatch(round, matchIdx) {
        const match = gameState.matches[matchIdx];
        if (!match || !match.playerA || !match.playerB || match.playerA.name === 'BYE') {
            // Auto-advance if BYE
            advanceToNextMatch();
            return;
        }
        
        gameState.currentMatch = {
            playerA: match.playerA,
            playerB: match.playerB,
            leg: 1,
            aggregate: { A: 0, B: 0 },
            board: Array(9).fill(null),
            turn: 'X', // X goes first
            gameActive: true,
            winner: null,
            legWinner: null,
            legOver: false,
            xoChoice: { A: null, B: null } // null, 'X', or 'O'
        };
        
        io.emit('stateUpdate', gameState);
    }
    
    // Player chooses X or O
    socket.on('chooseXO', ({ playerId, choice }) => {
        if (!gameState.currentMatch) return;
        const match = gameState.currentMatch;
        let isPlayerA = match.playerA.id === playerId;
        let isPlayerB = match.playerB.id === playerId;
        
        if (!isPlayerA && !isPlayerB) return;
        
        if (isPlayerA) match.xoChoice.A = choice;
        if (isPlayerB) match.xoChoice.B = choice;
        
        // If both chose, assign actual X/O
        if (match.xoChoice.A && match.xoChoice.B) {
            if (match.xoChoice.A === match.xoChoice.B) {
                // Conflict - randomize
                match.playerASymbol = Math.random() < 0.5 ? 'X' : 'O';
            } else {
                match.playerASymbol = match.xoChoice.A;
            }
            match.playerBSymbol = match.playerASymbol === 'X' ? 'O' : 'X';
            match.turn = 'X'; // X always goes first
            io.emit('stateUpdate', gameState);
        }
    });
    
    // Make a move
    socket.on('makeMove', ({ playerId, index }) => {
        if (!gameState.currentMatch) return;
        const match = gameState.currentMatch;
        if (!match.gameActive || match.legOver) return;
        
        // Check if it's this player's turn
        let isPlayerA = match.playerA.id === playerId;
        let isPlayerB = match.playerB.id === playerId;
        let playerSymbol = isPlayerA ? match.playerASymbol : (isPlayerB ? match.playerBSymbol : null);
        if (!playerSymbol) return;
        if (match.turn !== playerSymbol) return;
        if (match.board[index] !== null) return;
        
        // Make move
        match.board[index] = playerSymbol;
        
        // Check win/draw
        let win = checkWin(match.board);
        if (win) {
            match.gameActive = false;
            match.legOver = true;
            match.legWinner = (playerSymbol === match.playerASymbol) ? 'A' : 'B';
            // Update aggregate
            if (match.legWinner === 'A') match.aggregate.A++;
            else match.aggregate.B++;
            
            io.emit('stateUpdate', gameState);
            
            // Auto-advance leg after 2 seconds
            setTimeout(() => nextLegOrMatch(), 2000);
        } else if (match.board.every(cell => cell !== null)) {
            // Draw
            match.gameActive = false;
            match.legOver = true;
            match.legWinner = null; // draw
            io.emit('stateUpdate', gameState);
            setTimeout(() => nextLegOrMatch(), 2000);
        } else {
            // Switch turn
            match.turn = match.turn === 'X' ? 'O' : 'X';
            io.emit('stateUpdate', gameState);
        }
    });
    
    function checkWin(board) {
        const lines = [
            [0,1,2], [3,4,5], [6,7,8],
            [0,3,6], [1,4,7], [2,5,8],
            [0,4,8], [2,4,6]
        ];
        for (let line of lines) {
            const [a,b,c] = line;
            if (board[a] && board[a] === board[b] && board[a] === board[c]) {
                return true;
            }
        }
        return false;
    }
    
    function nextLegOrMatch() {
        const match = gameState.currentMatch;
        if (!match) return;
        
        if (match.leg === 1) {
            // Start leg 2
            match.leg = 2;
            match.board = Array(9).fill(null);
            match.gameActive = true;
            match.legOver = false;
            match.legWinner = null;
            match.turn = 'X';
            match.xoChoice = { A: null, B: null };
            match.playerASymbol = null;
            match.playerBSymbol = null;
            io.emit('stateUpdate', gameState);
        } else if (match.leg === 2) {
            // Check aggregate
            if (match.aggregate.A !== match.aggregate.B) {
                // Winner decided
                const winner = match.aggregate.A > match.aggregate.B ? match.playerA : match.playerB;
                finishMatch(winner);
            } else {
                // Leg 3
                match.leg = 3;
                match.board = Array(9).fill(null);
                match.gameActive = true;
                match.legOver = false;
                match.legWinner = null;
                match.turn = 'X';
                match.xoChoice = { A: null, B: null };
                match.playerASymbol = null;
                match.playerBSymbol = null;
                io.emit('stateUpdate', gameState);
            }
        } else if (match.leg === 3) {
            // Leg 3 winner
            const winner = match.legWinner === 'A' ? match.playerA : match.playerB;
            finishMatch(winner);
        }
    }
    
    function finishMatch(winner) {
        // Update bracket
        const currentMatchObj = gameState.matches[gameState.currentMatchIdx];
        currentMatchObj.winner = winner;
        
        // Advance winner to next round
        advanceToNextMatch();
    }
    
    function advanceToNextMatch() {
        gameState.currentMatchIdx++;
        if (gameState.currentMatchIdx >= gameState.matches.length) {
            // Next round
            gameState.currentRound++;
            gameState.matches = buildMatchesFromBracket(gameState.bracket, gameState.currentRound);
            gameState.currentMatchIdx = 0;
            
            if (gameState.matches.length === 0 || gameState.matches[0].playerA.name === 'TBD') {
                io.emit('tournamentComplete', { winner: gameState.players.find(p => p.id === gameState.matches[0]?.winner?.id) });
                return;
            }
        }
        
        startMatch(gameState.currentRound, gameState.currentMatchIdx);
        io.emit('stateUpdate', gameState);
    }
    
    // Admin force next
    socket.on('adminForceNext', () => {
        advanceToNextMatch();
    });
    
    socket.on('adminReset', () => {
        gameState = {
            players: [],
            bracket: [],
            currentMatch: null,
            matchIndex: 0,
            roundIndex: 0,
            tournamentStarted: false,
            availableSpots: 16
        };
        io.emit('stateUpdate', gameState);
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        gameState.players = gameState.players.filter(p => p.id !== socket.id);
        io.emit('stateUpdate', gameState);
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`For other devices, use your computer's IP address:3000`);
});
