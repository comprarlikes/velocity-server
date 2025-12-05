const { Server } = require("socket.io");
const admin = require('firebase-admin');
const httpServer = require("http").createServer((req, res) => {
    if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Velocity Server is Online!"); }
}); 

let db;
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
} catch (error) {
    console.error("⚠️ ERROR: No se encontró 'serviceAccountKey.json'. Ranking desactivado.");
}

const io = new Server(httpServer, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

const ALPHABET = "ABCDEFGHIJLMNOPRSTUV";
const ALL_CATEGORIES = ["NOMBRE", "COLOR", "FRUTA", "PAÍS", "ANIMAL", "MARCA", "COMIDA", "OBJETO", "PROFESIÓN", "PELÍCULA", "SERIE", "FAMOSO"];
const TOTAL_ROUNDS = 3;

let rooms = {}; 
let globalGameData = {}; // Guarda palabras y votos temporales

function generateRoomCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    room.currentRound += 1;
    room.letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    let shuffled = ALL_CATEGORIES.sort(() => 0.5 - math.random());
    room.categories = shuffled.slice(0, 5);
    room.isPanic = false;
    for (let pid in room.players) { room.players[pid].score = 0; }
}

// PROCESA VOTOS, CALCULA PUNTOS Y TERMINA LA RONDA
function _processVotesAndEndRound(code) {
    const room = rooms[code];
    const gameData = globalGameData[code];
    let roundRanking = [];

    // 1. Procesar Palabras y Puntuación de CADA JUGADOR
    for (const [votedPlayerId, playerWords] of Object.entries(gameData.playerWords)) {
        let roundScore = 0;
        const votedPlayerName = room.players[votedPlayerId].name;

        for (const [category, word] of Object.entries(playerWords)) {
            if (word.length > 0 && word[0].toUpperCase() === room.letter) {
                
                let votesAgainst = 0;
                
                // Sumar votos de todos los jugadores que votaron "Inválido"
                for (const [voterName, votes] of Object.entries(gameData.votes)) {
                    // Cuidado: el voto es por nombre, el playerWords es por ID
                    if (votes[votedPlayerName] && votes[votedPlayerName][category] === 'invalid') {
                        votesAgainst++;
                    }
                }
                
                // Regla: Si la mayoría vota en contra (N/2), la palabra es inválida
                const totalVoters = Object.keys(room.players).length;
                if (votesAgainst < Math.ceil(totalVoters / 2)) {
                    // Si pasa la votación, da 10 puntos (simplificado)
                    roundScore += 100;
                }
            }
        }
        
        // 2. Actualizar Score y Ranking de Ronda
        room.players[votedPlayerId].score = roundScore; 
        
        // Añadir al ranking de ronda si tiene puntos
        if (roundScore > 0) {
            roundRanking.push(room.players[votedPlayerId]);
        }
    }
    
    // 3. Determinar Ganador de la Ronda y Asignar 'wins'
    roundRanking.sort((a,b) => b.score - a.score);
    if (roundRanking.length > 0 && roundRanking[0].score > 0) {
        const winnerId = roundRanking[0].id;
        if (room.players[winnerId]) {
            room.players[winnerId].wins += 1;
        }
    }

    // 4. Enviar Ranking
    io.to(code).emit('game_ranking', roundRanking.map(p => ({name: p.name, score: p.score}))); // Solo nombre y score
    
    // 5. Iniciar siguiente paso
    if (room.currentRound >= TOTAL_ROUNDS) {
        let finalPodium = Object.values(room.players).sort((a,b) => b.wins - a.wins);
        if (finalPodium.length > 0 && db) {
            const winner = finalPodium[0];
            const playerRef = db.collection('players').doc(winner.name.toUpperCase());
            playerRef.set({ name: winner.name, avatar: winner.avatar, frame: winner.frame, wins: admin.firestore.FieldValue.increment(1) }, { merge: true });
        }
        io.to(code).emit('match_over', finalPodium);

    } else {
        setTimeout(() => {
            room.status = 'PLAYING';
            startNewRound(code);
            io.to(code).emit('round_start', { letter: room.letter, categories: room.categories, round: room.currentRound, totalRounds: room.totalRounds, time: room.roundTime });
        }, 5000);
    }
    
    // Limpiar datos temporales
    delete globalGameData[code];
}

io.on("connection", (socket) => {
  
  // CREAR SALA (Similar a antes)
  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      socket.join(code);
      rooms[code] = { /* ... configuración ... */ };
      const pData = { name: data.playerName || data.name, score: 0, wins: 0, id: socket.id, avatar: data.avatar || 'robot1', frame: data.frame || 'none' };
      rooms[code].players[socket.id] = pData;
      // Actualizar Firebase al entrar
      if (db) db.collection('players').doc(pData.name.toUpperCase()).set({ name: pData.name, avatar: pData.avatar, frame: pData.frame }, { merge: true });
      socket.emit('room_joined', { code: code, isHost: true, players: Object.values(rooms[code].players) });
  });

  // UNIRSE A SALA (Similar a antes)
  socket.on('join_room', (data) => {
      const code = data.code ? data.code.toUpperCase() : "";
      if (!rooms[code]) return socket.emit('error_msg', 'Sala no existe.');
      socket.join(code);
      const pData = { name: data.name, score: 0, wins: 0, id: socket.id, avatar: data.avatar || 'robot1', frame: data.frame || 'none' };
      rooms[code].players[socket.id] = pData;
      if (db) db.collection('players').doc(pData.name.toUpperCase()).set({ name: pData.name, avatar: pData.avatar, frame: pData.frame }, { merge: true });
      socket.emit('room_joined', { code: code, isHost: false, players: Object.values(rooms[code].players) });
      io.to(code).emit('update_players', Object.values(rooms[code].players));
  });

  // START GAME (Similar a antes)
  socket.on('start_game', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      if (!room || room.admin !== socket.id) return;
      startNewRound(code);
      io.to(code).emit('round_start', { letter: room.letter, categories: room.categories, round: room.currentRound, totalRounds: TOTAL_ROUNDS, time: room.roundTime });
  });

  // PULSAR STOP (Solo activa la fase de SUBMIT)
  socket.on('stop_pressed', (data) => {
      const code = data.roomCode; const room = rooms[code];
      if (!room || room.isPanic) return;
      room.isPanic = true;
      io.to(code).emit('panic_mode', {});
      
      // Enviamos la señal a todos de que el tiempo se acaba.
      // El cliente debe enviar SUBMIT_WORDS cuando el tiempo llegue a 0.
  });

  // RECIBIR PALABRAS
  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      const playerName = rooms[code].players[socket.id].name;

      if (!room || room.status === 'JUDGING' || room.status === 'LOBBY') return;
      
      // Guardar palabras
      if (!globalGameData[code]) { globalGameData[code] = { playerWords: {}, votes: {} }; }
      globalGameData[code].playerWords[playerName] = data.words; 
      
      // Simulación de final de tiempo: Si todos envían, iniciamos el Juicio.
      const allPlayers = Object.keys(room.players).map(id => room.players[id].name);
      const submittedPlayers = Object.keys(globalGameData[code].playerWords);

      if (allPlayers.every(player => submittedPlayers.includes(player))) {
          room.status = 'JUDGING';
          io.to(code).emit('start_judging', { 
              words: globalGameData[code].playerWords,
              players: allPlayers
          });
      }
  });

  // RECIBIR VOTO
  socket.on('submit_vote', (data) => {
      const code = data.roomCode;
      const playerName = rooms[code].players[socket.id].name;
      const room = rooms[code];
      
      if (!room || room.status !== 'JUDGING' || globalGameData[code].votes[playerName]) return;

      globalGameData[code].votes[playerName] = data.votes;
      
      const allPlayers = Object.keys(room.players).map(id => room.players[id].name);
      const votedPlayers = Object.keys(globalGameData[code].votes);

      if (votedPlayers.length === allPlayers.length) { 
          _processVotesAndEndRound(code);
      }
  });


  socket.on("disconnect", () => { /* ... */ });
});

httpServer.listen(PORT, () => { console.log(`✅ Servidor listo en ${PORT}`); });
