const { Server } = require("socket.io");
const admin = require('firebase-admin');
const httpServer = require("http").createServer((req, res) => {
    // Despertador para Render
    if (req.url === "/") { 
        res.writeHead(200, { "Content-Type": "text/plain" }); 
        res.end("Velocity Server is Online and Ready!"); 
    }
}); 

let db;
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log("✅ Conexión con Firebase establecida.");
} catch (error) {
    console.error("⚠️ ERROR: No se encontró 'serviceAccountKey.json'. Ranking desactivado.");
    db = null;
}

const io = new Server(httpServer, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN DEL JUEGO ---
const ALPHABET = "ABCDEFGHIJLMNOPRSTUV";
const ALL_CATEGORIES = ["NOMBRE", "COLOR", "FRUTA", "PAÍS", "ANIMAL", "MARCA", "COMIDA", "OBJETO", "PROFESIÓN", "PELÍCULA", "SERIE", "FAMOSO"];
const TOTAL_ROUNDS = 3; 

let rooms = {}; 
let globalGameData = {}; // Guarda palabras y votos temporales

function generateRoomCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }

// FUNCIÓN DE INICIO DE RONDA
function prepareRoundData(room) {
    room.currentRound += 1;
    room.letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    let shuffled = ALL_CATEGORIES.sort(() => 0.5 - Math.random());
    room.categories = shuffled.slice(0, 5);
    room.isPanic = false;
    for (let pid in room.players) { room.players[pid].score = 0; }
    return room;
}

// PROCESAR VOTOS (FUNCIÓN CENTRAL)
function _processVotesAndEndRound(code) {
    const room = rooms[code];
    const gameData = globalGameData[code];
    let finalRanking = [];

    for (const [votedPlayerId, playerWords] of Object.entries(gameData.playerWords)) {
        let roundScore = 0;
        const votedPlayerName = room.players[votedPlayerId].name;

        for (const [category, word] of Object.entries(playerWords)) {
            if (word.length > 0 && word[0].toUpperCase() === room.letter) {
                
                let votesAgainst = 0;
                for (const [voterName, votes] of Object.entries(gameData.votes)) {
                    if (votes[votedPlayerName] && votes[votedPlayerName][category] === 'invalid') {
                        votesAgainst++;
                    }
                }
                
                // Regla de la Mayoría: Si menos de la mitad vota en contra, es válido.
                const totalVoters = Object.keys(room.players).length;
                if (votesAgainst < Math.ceil(totalVoters / 2)) {
                    roundScore += 100;
                }
            }
        }
        
        room.players[votedPlayerId].score = roundScore; 
        if (roundScore > 0) {
            finalRanking.push(room.players[votedPlayerId]);
        }
    }
    
    finalRanking.sort((a,b) => b.score - a.score);
    if (finalRanking.length > 0 && finalRanking[0].score > 0) {
        const winnerId = finalRanking[0].id;
        if (room.players[winnerId]) {
            room.players[winnerId].wins += 1;
        }
    }

    io.to(code).emit('game_ranking', finalRanking.map(p => ({name: p.name, score: p.score})));
    
    // LIMPIAR E INICIAR NUEVA RONDA O PARTIDA
    if (room.currentRound >= room.totalRounds) {
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
            prepareRoundData(room);
            io.to(code).emit('round_start', { letter: room.letter, categories: room.categories, round: room.currentRound, totalRounds: room.totalRounds, time: room.roundTime });
        }, 5000);
    }
    
    delete globalGameData[code];
}

io.on("connection", (socket) => {
  
  // 1. CREAR SALA (CORREGIDO)
  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      const pName = data.playerName || data.name;

      // 1. CREAR EL OBJETO SALA
      rooms[code] = { 
          players: {}, 
          admin: socket.id, 
          status: 'LOBBY',
          currentRound: 0,
          totalRounds: data.rounds || TOTAL_ROUNDS, // Usa valor de configuración o 3
          roundTime: data.time || 60,
          stopMode: data.stopMode || 'BLITZ',
          password: data.password || null, // Para salas privadas
          letter: "", categories: [], isPanic: false
      };
      
      // 2. UNIRSE A LA SALA EN SOCKET.IO
      socket.join(code);

      // 3. AÑADIR AL JUGADOR
      rooms[code].players[socket.id] = { 
          name: pName, score: 0, wins: 0, id: socket.id,
          avatar: data.avatar || 'robot1',
          frame: data.frame || 'none' 
      };
      
      console.log(`🏠 Sala ${code} creada por ${pName}.`);
      
      // 4. ACTUALIZAR FIREBASE Y ENVIAR RESPUESTA
      if (db) db.collection('players').doc(pName.toUpperCase()).set({ name: pName, avatar: data.avatar, frame: data.frame }, { merge: true });
      socket.emit('room_joined', { code: code, isHost: true, players: Object.values(rooms[code].players) });
  });

  // 2. UNIRSE A SALA (Revisado)
  socket.on('join_room', (data) => {
      const code = data.code ? data.code.toUpperCase() : "";
      if (!rooms[code]) return socket.emit('error_msg', 'Sala no existe.');
      
      if (Object.keys(rooms[code].players).length >= 8) return socket.emit('error_msg', 'La sala está llena.');

      socket.join(code);
      const pData = { name: data.name, score: 0, wins: 0, id: socket.id, avatar: data.avatar || 'robot1', frame: data.frame || 'none' };
      rooms[code].players[socket.id] = pData;
      
      if (db) db.collection('players').doc(pData.name.toUpperCase()).set({ name: pData.name, avatar: pData.avatar, frame: pData.frame }, { merge: true });
      socket.emit('room_joined', { code: code, isHost: false, players: Object.values(rooms[code].players) });
      io.to(code).emit('update_players', Object.values(rooms[code].players));
  });

  // 3. INICIAR PARTIDA
  socket.on('start_game', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      if (!room || room.admin !== socket.id) return;
      
      prepareRoundData(room);
      
      io.to(code).emit('round_start', { 
          letter: room.letter, categories: room.categories, round: room.currentRound, totalRounds: room.totalRounds, time: room.roundTime
      });
  });

  // 4. BUSCAR PARTIDA (Matchmaking)
  socket.on('find_match', (data) => {
      for (let code in rooms) {
          if (rooms[code].status === 'LOBBY' && Object.keys(rooms[code].players).length < 8 && rooms[code].password === null) {
              console.log(`🔍 Jugador ${data.name} encontró sala ${code}`);
              socket.emit('match_found', { code: code });
              return;
          }
      }
      // Si llega aquí, no encontró nada, le decimos que cree
      socket.emit('no_match_found', {});
  });

  // 5. BOTÓN STOP (Solo señal de tiempo)
  socket.on('stop_pressed', (data) => {
      const code = data.roomCode; 
      const room = rooms[code];
      if (!room || room.isPanic) return;

      room.isPanic = true;
      io.to(code).emit('panic_mode', {});
      
      // El cliente enviará submit_words cuando su contador de pánico llegue a cero.
  });

  // 6. RECIBIR PALABRAS
  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      const playerName = rooms[code].players[socket.id].name;
      
      if (!room || room.status === 'JUDGING' || room.status === 'LOBBY') return;
      
      if (!globalGameData[code]) { globalGameData[code] = { playerWords: {}, votes: {} }; }
      globalGameData[code].playerWords[playerName] = data.words; 

      const allPlayers = Object.keys(room.players).map(id => room.players[id].name);
      const submittedPlayers = Object.keys(globalGameData[code].playerWords);

      // Si todos enviaron, iniciamos el Juicio
      if (allPlayers.every(player => submittedPlayers.includes(player))) {
          room.status = 'JUDGING';
          io.to(code).emit('start_judging', { 
              words: globalGameData[code].playerWords,
              players: allPlayers
          });
      }
  });

  // 7. RECIBIR VOTO
  socket.on('submit_vote', (data) => {
      const code = data.code;
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

httpServer.listen(PORT, () => { console.log(`✅ Servidor listo en puerto ${PORT}`); });
