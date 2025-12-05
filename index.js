const { Server } = require("socket.io");
const admin = require('firebase-admin');
const httpServer = require("http").createServer((req, res) => {
    // Despertador para que Render no duerma el servidor
    if (req.url === "/") { 
        res.writeHead(200, { "Content-Type": "text/plain" }); 
        res.end("Velocity Server is Online and Ready!"); 
    }
}); 

// --- CONFIGURACIÓN FIREBASE ---
let db;
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("✅ Conexión con Firebase establecida.");
} catch (error) {
    console.error("⚠️ ERROR: No se encontró 'serviceAccountKey.json'. El ranking global no guardará datos.");
    db = null;
}

const io = new Server(httpServer, {
  cors: { origin: "*" } // Permitir conexiones desde cualquier origen
});

const PORT = process.env.PORT || 3000;

// --- CONSTANTES DEL JUEGO ---
const ALPHABET = "ABCDEFGHIJLMNOPRSTUV";
const ALL_CATEGORIES = [
    "NOMBRE", "COLOR", "FRUTA", "PAÍS", "ANIMAL", "MARCA", 
    "COMIDA", "OBJETO", "PROFESIÓN", "PELÍCULA", "SERIE", 
    "FAMOSO", "VERBO", "DEPORTE", "CUERPO", "ROPA", "TRANSPORTE",
    "VIDEOJUEGO", "CANTANTE", "CIUDAD", "ASIGNATURA"
];
const DEFAULT_ROUNDS = 3;

// --- ESTADO GLOBAL ---
let rooms = {}; 
let globalGameData = {}; // Almacén temporal para palabras y votos durante la ronda

// --- FUNCIONES AUXILIARES ---

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// Prepara los datos para una nueva ronda
function prepareRoundData(room) {
    room.currentRound += 1;
    room.letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    
    // Mezclar y coger 5 categorías
    let shuffled = ALL_CATEGORIES.sort(() => 0.5 - Math.random());
    room.categories = shuffled.slice(0, 5);
    
    room.isPanic = false;
    room.status = 'PLAYING';
    
    // Resetear puntuación de la ronda actual (pero mantener wins)
    for (let pid in room.players) {
        room.players[pid].score = 0;
    }
    return room;
}

// Función principal para procesar los votos y decidir el ganador de la ronda
function _processVotesAndEndRound(code) {
    const room = rooms[code];
    const gameData = globalGameData[code];
    let roundRanking = [];

    if (!room || !gameData) return;

    console.log(`⚖️ Procesando votos para sala ${code}...`);

    // 1. Calcular puntuación basada en votos
    for (const [playerId, playerWords] of Object.entries(gameData.playerWords)) {
        let roundScore = 0;
        const playerName = room.players[playerId] ? room.players[playerId].name : "Desconocido";

        for (const [category, word] of Object.entries(playerWords)) {
            // Solo evaluamos si la palabra existe y empieza por la letra correcta
            if (word && word.length > 0 && word[0].toUpperCase() === room.letter) {
                
                let votesAgainst = 0;
                
                // Contar votos negativos
                for (const [voterName, votes] of Object.entries(gameData.votes)) {
                    // El voto se guarda por nombre de jugador
                    if (votes[playerName] && votes[playerName][category] === 'invalid') {
                        votesAgainst++;
                    }
                }
                
                // Regla: Si la mayoría (o empate) vota en contra, se anula.
                const totalVoters = Object.keys(room.players).length;
                if (votesAgainst < Math.ceil(totalVoters / 2)) {
                    roundScore += 100; // Palabra válida
                }
            }
        }
        
        // Actualizar puntuación del jugador en la sala
        if (room.players[playerId]) {
            room.players[playerId].score = roundScore;
            if (roundScore > 0) {
                roundRanking.push(room.players[playerId]);
            }
        }
    }
    
    // 2. Determinar ganador de la ronda
    roundRanking.sort((a, b) => b.score - a.score);
    
    if (roundRanking.length > 0 && roundRanking[0].score > 0) {
        const winnerId = roundRanking[0].id;
        // Sumar victoria de ronda
        if (room.players[winnerId]) {
            room.players[winnerId].wins += 1;
        }
    }

    // 3. Enviar resultados de la ronda a los clientes
    io.to(code).emit('game_ranking', roundRanking.map(p => ({
        name: p.name, 
        score: p.score
    })));
    
    // 4. Decidir si acaba la partida o sigue
    if (room.currentRound >= room.totalRounds) {
        // FIN DE PARTIDA
        let finalPodium = Object.values(room.players).sort((a, b) => b.wins - a.wins);
        
        // Guardar victoria en Firebase
        if (finalPodium.length > 0 && db) {
            const winner = finalPodium[0];
            const playerRef = db.collection('players').doc(winner.name.toUpperCase());
            
            playerRef.set({ 
                name: winner.name, 
                avatar: winner.avatar, 
                frame: winner.frame, 
                wins: admin.firestore.FieldValue.increment(1) 
            }, { merge: true });
            
            console.log(`🏆 Victoria de partida registrada para: ${winner.name}`);
        }
        
        io.to(code).emit('match_over', finalPodium);
        // Limpiar sala después de un tiempo (opcional)
        
    } else {
        // SIGUIENTE RONDA
        setTimeout(() => {
            prepareRoundData(room);
            io.to(code).emit('round_start', { 
                letter: room.letter, 
                categories: room.categories, 
                round: room.currentRound, 
                totalRounds: room.totalRounds, 
                time: room.roundTime 
            });
        }, 5000); // 5 seg para ver el ranking
    }
    
    // Limpiar datos temporales de la ronda
    delete globalGameData[code];
}

// --- SOCKET.IO ---
io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // 1. CREAR SALA
  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      const pName = data.playerName || data.name;

      // Unirse al canal
      socket.join(code);

      // Inicializar objeto de sala
      rooms[code] = { 
          players: {}, 
          admin: socket.id, 
          status: 'LOBBY',
          currentRound: 0,
          totalRounds: data.rounds || DEFAULT_ROUNDS,
          roundTime: data.time || 60,
          stopMode: data.stopMode || 'BLITZ',
          letter: "", categories: [], isPanic: false
      };
      
      // Añadir al creador
      rooms[code].players[socket.id] = { 
          name: pName, score: 0, wins: 0, id: socket.id,
          avatar: data.avatar || 'robot1',
          frame: data.frame || 'none' 
      };
      
      console.log(`🏠 Sala ${code} creada por ${pName}. Config: ${rooms[code].totalRounds} rondas.`);
      
      // Actualizar perfil en Firebase (si existe DB)
      if (db) db.collection('players').doc(pName.toUpperCase()).set({ name: pName, avatar: data.avatar, frame: data.frame }, { merge: true });

      socket.emit('room_joined', { 
          code: code, 
          isHost: true, 
          players: Object.values(rooms[code].players) 
      });
  });

  // 2. UNIRSE A SALA
  socket.on('join_room', (data) => {
      const code = data.code ? data.code.toUpperCase() : "";
      
      if (!rooms[code]) {
          return socket.emit('error_msg', 'La sala no existe.');
      }
      
      if (Object.keys(rooms[code].players).length >= 8) {
          return socket.emit('error_msg', 'La sala está llena.');
      }

      socket.join(code);
      
      const pData = { 
          name: data.name, score: 0, wins: 0, id: socket.id,
          avatar: data.avatar || 'robot1', 
          frame: data.frame || 'none' 
      };
      
      rooms[code].players[socket.id] = pData;
      
      if (db) db.collection('players').doc(pData.name.toUpperCase()).set({ name: pData.name, avatar: pData.avatar, frame: pData.frame }, { merge: true });

      socket.emit('room_joined', { 
          code: code, 
          isHost: false, 
          players: Object.values(rooms[code].players) 
      });

      io.to(code).emit('update_players', Object.values(rooms[code].players));
  });

  // 3. INICIAR PARTIDA
  socket.on('start_game', (data) => {
      const code = data.roomCode;
      const room = rooms[code];

      if (!room) return;
      if (room.admin !== socket.id) return; // Solo admin

      prepareRoundData(room);
      
      console.log(`🚀 Iniciando partida en sala ${code}`);

      io.to(code).emit('round_start', { 
          letter: room.letter, 
          categories: room.categories, 
          round: room.currentRound, 
          totalRounds: room.totalRounds, 
          time: room.roundTime
      });
  });

  // 4. BUSCAR PARTIDA (Matchmaking)
  socket.on('find_match', (data) => {
      let found = false;
      for (let code in rooms) {
          // Buscar sala pública (sin contraseña, aquí asumimos que todas son públicas por ahora) y en Lobby
          if (rooms[code].status === 'LOBBY' && Object.keys(rooms[code].players).length < 8) {
              console.log(`🔍 Jugador ${data.name} emparejado en sala ${code}`);
              socket.emit('match_found', { code: code });
              found = true;
              break;
          }
      }
      if (!found) {
          socket.emit('no_match_found', {});
      }
  });

  // 5. STOP PRESIONADO
  socket.on('stop_pressed', (data) => {
      const code = data.roomCode; 
      const room = rooms[code];
      if (!room || room.isPanic) return;

      room.isPanic = true;
      console.log(`🚨 STOP pulsado en sala ${code}`);
      
      io.to(code).emit('panic_mode', {});
      
      // El servidor espera a que los clientes envíen sus palabras (submit_words)
      // No calculamos ranking aquí, esperamos a la fase de votación
  });

  // 6. RECIBIR PALABRAS (Pre-Votación)
  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      
      if (!room) return;
      if (room.status === 'JUDGING') return; // Ya estamos juzgando
      
      const playerName = rooms[code].players[socket.id].name;
      
      // Inicializar estructura temporal si no existe
      if (!globalGameData[code]) { 
          globalGameData[code] = { playerWords: {}, votes: {} }; 
      }
      
      globalGameData[code].playerWords[socket.id] = data.words; 

      // Comprobar si todos los jugadores han enviado sus palabras
      const allPlayerIds = Object.keys(room.players);
      const submittedPlayerIds = Object.keys(globalGameData[code].playerWords);

      // Si todos han enviado (o si es un jugador solo)
      if (allPlayerIds.every(id => submittedPlayerIds.includes(id))) {
          room.status = 'JUDGING';
          
          // Convertir IDs a Nombres para el cliente
          let wordsForClient = {};
          for (let pid in globalGameData[code].playerWords) {
              let pName = room.players[pid].name;
              wordsForClient[pName] = globalGameData[code].playerWords[pid];
          }

          console.log(`⚖️ Iniciando juicio en sala ${code}`);
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

      // Guardar voto
      globalGameData[code].votes[playerName] = data.votes;
      
      // Comprobar si todos han votado
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

  socket.on("disconnect", () => {
      // Aquí se podría añadir lógica para limpiar jugadores desconectados
  });
});

// --- ARRANQUE ---
httpServer.listen(PORT, () => {
    console.log(`✅ Servidor escuchando en puerto ${PORT}`);
});
