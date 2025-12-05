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
    console.log("✅ Conexión con Firebase establecida.");
} catch (error) {
    console.error("⚠️ ERROR: No se encontró 'serviceAccountKey.json'. Ranking desactivado.");
    db = null;
}

const io = new Server(httpServer, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

const ALPHABET = "ABCDEFGHIJLMNOPRSTUV";
const ALL_CATEGORIES = ["NOMBRE", "COLOR", "FRUTA", "PAÍS", "ANIMAL", "MARCA", "COMIDA", "OBJETO", "PROFESIÓN", "PELÍCULA", "SERIE", "FAMOSO"];
const DEFAULT_ROUNDS = 3;

let rooms = {}; 
let globalGameData = {}; // Guarda palabras y votos temporales

function generateRoomCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }

function prepareRoundData(room) {
    room.currentRound += 1;
    room.letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    let shuffled = ALL_CATEGORIES.sort(() => 0.5 - Math.random());
    room.categories = shuffled.slice(0, 5);
    room.isPanic = false;
    for (let pid in room.players) { room.players[pid].score = 0; }
    room.status = 'PLAYING';
    return room;
}

function _processVotesAndEndRound(code) {
    const room = rooms[code];
    const gameData = globalGameData[code];
    let roundRanking = [];

    if (!room || !gameData) return;

    // 1. Calcular puntuación basada en votos
    for (const [playerId, playerWords] of Object.entries(gameData.playerWords)) {
        let roundScore = 0;
        const playerName = room.players[playerId] ? room.players[playerId].name : "Desconocido";

        for (const [category, word] of Object.entries(playerWords)) {
            if (word.length > 0 && word[0].toUpperCase() === room.letter) {
                
                let votesAgainst = 0;
                
                if (Object.keys(room.players).length > 1) {
                    for (const [voterName, votes] of Object.entries(gameData.votes)) {
                        if (votes[playerName] && votes[playerName][category] === 'invalid') {
                            votesAgainst++;
                        }
                    }
                }
                
                const totalVoters = Object.keys(room.players).length;
                if (totalVoters === 1 || votesAgainst < Math.ceil(totalVoters / 2)) {
                    roundScore += 100;
                }
            }
        }
        
        // 2. Actualizar Score
        if (room.players[playerId]) {
            room.players[playerId].score = roundScore;
            if (roundScore > 0) {
                roundRanking.push(room.players[playerId]);
            }
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
    io.to(code).emit('game_ranking', roundRanking.map(p => ({name: p.name, score: p.score})));
    
    // 5. Iniciar siguiente paso
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
        }, 5000); // 5 seg para ver el ranking
    }
    
    delete globalGameData[code];
}

io.on("connection", (socket) => {
  
  // 1. CREAR SALA
  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      const pName = data.playerName || data.name;

      rooms[code] = { 
          players: {}, admin: socket.id, status: 'LOBBY',
          currentRound: 0, totalRounds: data.rounds || DEFAULT_ROUNDS, roundTime: data.time || 60,
          stopMode: data.stopMode || 'BLITZ', password: data.password || null,
          letter: "", categories: [], isPanic: false
      };
      
      socket.join(code);
      rooms[code].players[socket.id] = { name: pName, score: 0, wins: 0, id: socket.id, avatar: data.avatar || 'robot1', frame: data.frame || 'none' };
      
      if (db) db.collection('players').doc(pName.toUpperCase()).set({ name: pName, avatar: data.avatar, frame: data.frame }, { merge: true });
      socket.emit('room_joined', { code: code, isHost: true, players: Object.values(rooms[code].players) });
  });

  // 2. UNIRSE A SALA
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
      let found = false;
      for (let code in rooms) {
          if (rooms[code].status === 'LOBBY' && Object.keys(rooms[code].players).length < 8 && rooms[code].password === null) {
              socket.emit('match_found', { code: code });
              found = true;
              break;
          }
      }
      if (!found) {
          socket.emit('no_match_found', {});
      }
  });

  // 5. BOTÓN STOP (Solo señal de tiempo)
  socket.on('stop_pressed', (data) => {
      const code = data.roomCode; 
      const room = rooms[code];
      if (!room || room.isPanic) return;

      room.isPanic = true;
      io.to(code).emit('panic_mode', {});
  });

  // 6. RECIBIR PALABRAS (Fase de recolección y disparo de juicio)
  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      
      if (!room || room.status === 'JUDGING' || room.status === 'LOBBY') return;
      
      const playerName = rooms[code].players[socket.id].name;
      
      if (!globalGameData[code]) { globalGameData[code] = { playerWords: {}, votes: {} }; }
      
      globalGameData[code].playerWords[playerName] = data.words; 

      const allPlayerNames = Object.keys(room.players).map(id => room.players[id].name);
      const submittedPlayerNames = Object.keys(globalGameData[code].playerWords);

      let shouldStartJudging = false;
      if (allPlayerNames.every(name => submittedPlayerNames.includes(name)) || allPlayerNames.length === submittedPlayerNames.length) {
          shouldStartJudging = true;
      } 
      
      if (shouldStartJudging) {
          room.status = 'JUDGING';
          
          let wordsForClient = {};
          for (let pName in globalGameData[code].playerWords) {
              wordsForClient[pName] = globalGameData[code].playerWords[pName];
          }

          io.to(code).emit('start_judging', { 
              words: wordsForClient
          });
      }
  });

  // 7. RECIBIR VOTOS
  socket.on('submit_vote', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      
      if (!room || room.status !== 'JUDGING') return;

      const playerName = room.players[socket.id].name;
      
      if (!globalGameData[code]) return;

      globalGameData[code].votes[playerName] = data.votes;
      
      const totalPlayers = Object.keys(room.players).length;
      const totalVotes = Object.keys(globalGameData[code].votes).length;

      if (totalVotes === totalPlayers) { 
          _processVotesAndEndRound(code);
      }
  });

  // 8. CHAT Y REACCIONES
  socket.on('send_message', (data) => { 
      if(data.roomCode) io.to(data.roomCode).emit('receive_message', { sender: data.playerName, text: data.message }); 
  });
  socket.on('send_reaction', (data) => { 
      if(data.roomCode) io.to(data.roomCode).emit('receive_reaction', { emoji: data.emoji }); 
  });

  socket.on("disconnect", () => {});
});

httpServer.listen(PORT, () => { console.log(`✅ Servidor listo en puerto ${PORT}`); });
