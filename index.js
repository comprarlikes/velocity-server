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
    console.error("⚠️ ERROR: No se encontró 'serviceAccountKey.json'.");
    db = null;
}

const io = new Server(httpServer, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN ---
const ALPHABET = "ABCDEFGHIJLMNOPRSTUV";
const ALL_CATEGORIES = ["NOMBRE", "COLOR", "FRUTA", "PAÍS", "ANIMAL", "MARCA", "COMIDA", "OBJETO", "PROFESIÓN", "PELÍCULA", "SERIE", "FAMOSO"];
const DEFAULT_ROUNDS = 3;

// ¡AQUÍ FALTABA ESTO! LISTA DE NOMBRES DE BOTS
const BOT_NAMES = ["Alex", "Sofía", "ProGamer", "Luna", "Max", "Leo", "Valeria", "VelocityBot", "Neo", "Trinity"];

let rooms = {}; 
let globalGameData = {}; 

function generateRoomCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    room.currentRound += 1;
    room.letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    let shuffled = ALL_CATEGORIES.sort(() => 0.5 - Math.random());
    room.categories = shuffled.slice(0, 5);
    room.isPanic = false;
    room.status = 'PLAYING';
    
    for (let pid in room.players) {
        room.players[pid].score = 0;
    }

    // SI HAY BOT, PROGRAMAR SU JUGADA
    const botPlayer = Object.values(room.players).find(p => p.isBot);
    if (botPlayer) {
        handleBotTurn(room, botPlayer.id, roomCode);
    }

    return room;
}

// --- IA DEL BOT ---
function handleBotTurn(room, botId, roomCode) {
    // El bot piensa entre 30 y 50 segundos
    const botThinkingTime = (Math.floor(Math.random() * 20) + 30) * 1000;
    
    console.log(`🤖 Bot ${room.players[botId].name} pensando... (${botThinkingTime/1000}s)`);

    // Limpiar timer anterior si existe
    if (room.botTimer) clearTimeout(room.botTimer);

    room.botTimer = setTimeout(() => {
        if (room.status !== 'PLAYING' || room.isPanic) return;

        console.log(`🤖 Bot ${room.players[botId].name} termina y pulsa STOP!`);

        // 1. Generar palabras del Bot
        let botWords = {};
        room.categories.forEach(cat => {
            botWords[cat] = `${cat} ${room.letter}`; 
        });

        // 2. Guardar palabras
        if (!globalGameData[roomCode]) { globalGameData[roomCode] = { playerWords: {}, votes: {} }; }
        globalGameData[roomCode].playerWords[botId] = botWords;

        // 3. Pulsar STOP
        handleStop(roomCode);

    }, botThinkingTime);
}

function handleStop(code) {
    const room = rooms[code];
    if (!room || room.isPanic) return;

    room.isPanic = true;
    io.to(code).emit('panic_mode', {});
    
    // Forzar el fin de ronda tras 8 segundos (tiempo de pánico)
    setTimeout(() => {
        finalizeRound(code);
    }, 8000);
}

function finalizeRound(code) {
    const room = rooms[code];
    if (!room) return;

    // Calcular puntos (Juez Automático)
    let roundRanking = [];
    const gameData = globalGameData[code] || { playerWords: {} };

    for (let pid in room.players) {
        let pScore = 0;
        const words = gameData.playerWords ? gameData.playerWords[pid] : null;
        
        if (words) {
            for (const [cat, word] of Object.entries(words)) {
                if (word && word.length > 0 && word[0].toUpperCase() === room.letter) {
                    pScore += 100;
                }
            }
        }
        room.players[pid].score = pScore;
        roundRanking.push(room.players[pid]);
    }

    // Ordenar y victorias
    roundRanking.sort((a,b) => b.score - a.score);
    if (roundRanking.length > 0 && roundRanking[0].score > 0) {
        const winnerId = roundRanking[0].id;
        if (room.players[winnerId]) room.players[winnerId].wins += 1;
    }

    io.to(code).emit('game_ranking', roundRanking.map(p => ({name: p.name, score: p.score})));

    // Fin de partida o siguiente ronda
    if (room.currentRound >= room.totalRounds) {
        let finalPodium = Object.values(room.players).sort((a,b) => b.wins - a.wins);
        // Guardar solo si ganó un humano
        if (finalPodium.length > 0 && !finalPodium[0].isBot && db) {
             const winner = finalPodium[0];
             db.collection('players').doc(winner.name.toUpperCase()).set({ 
                 name: winner.name, wins: admin.firestore.FieldValue.increment(1), 
                 avatar: winner.avatar, frame: winner.frame 
             }, { merge: true });
        }
        io.to(code).emit('match_over', finalPodium);
        // Limpieza
        delete rooms[code];
        delete globalGameData[code];
    } else {
        setTimeout(() => {
            startNewRound(code);
            io.to(code).emit('round_start', { 
                letter: room.letter, categories: room.categories, 
                round: room.currentRound, totalRounds: room.totalRounds, time: room.roundTime 
            });
        }, 5000);
    }
}

io.on("connection", (socket) => {
  
  // 1. CREAR SALA
  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      socket.join(code);
      rooms[code] = { 
          players: {}, admin: socket.id, status: 'LOBBY',
          currentRound: 0, totalRounds: data.rounds || DEFAULT_ROUNDS, roundTime: data.time || 60,
          stopMode: data.stopMode || 'BLITZ', letter: "", categories: [], isPanic: false
      };
      
      const pName = data.playerName || data.name;
      rooms[code].players[socket.id] = { 
          name: pName, score: 0, wins: 0, id: socket.id,
          avatar: data.avatar || 'robot1', frame: data.frame || 'none' 
      };
      
      if (db) db.collection('players').doc(pName.toUpperCase()).set({ name: pName, avatar: data.avatar, frame: data.frame }, { merge: true });
      socket.emit('room_joined', { code: code, isHost: true, players: Object.values(rooms[code].players) });
  });

  // 2. UNIRSE A SALA
  socket.on('join_room', (data) => {
      const code = data.code ? data.code.toUpperCase() : "";
      if (!rooms[code]) return socket.emit('error_msg', 'Sala no existe.');
      
      socket.join(code);
      const pData = { 
          name: data.name, score: 0, wins: 0, id: socket.id, 
          avatar: data.avatar || 'robot1', frame: data.frame || 'none' 
      };
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
      startNewRound(code);
      io.to(code).emit('round_start', { letter: room.letter, categories: room.categories, round: room.currentRound, totalRounds: room.totalRounds, time: room.roundTime });
  });

  // 4. FIND MATCH (CON BOTS)
  socket.on('find_match', (data) => {
      // Intentar unirse a sala existente
      for (let code in rooms) {
          if (rooms[code].status === 'LOBBY' && Object.keys(rooms[code].players).length < 8 && !rooms[code].hasBot) {
              socket.emit('match_found', { code: code });
              return;
          }
      }

      // Si no, crear sala con BOT
      const code = generateRoomCode();
      socket.join(code);
      
      const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
      const botId = "BOT_" + Math.random().toString(36).substr(2, 5);

      rooms[code] = { 
          players: {}, admin: socket.id, status: 'LOBBY', hasBot: true,
          currentRound: 0, totalRounds: DEFAULT_ROUNDS, roundTime: 60,
          stopMode: 'BLITZ', letter: "", categories: [], isPanic: false
      };

      // Añadir Bot
      rooms[code].players[botId] = { 
          name: botName, score: 0, wins: 0, id: botId, isBot: true,
          avatar: 'demon', frame: 'gold_master' 
      };

      // Añadir Jugador (Admin) - Se rellenará bien al hacer join_room
      // NOTA: No añadimos al jugador a rooms[code].players AQUI, 
      // porque el cliente va a llamar a 'join_room' inmediatamente después.
      // Solo le damos el código.
      
      console.log(`🤖 Sala Bot ${code} reservada para ${data.name}`);
      socket.emit('match_found', { code: code });
  });

  // 5. STOP
  socket.on('stop_pressed', (data) => {
      handleStop(data.roomCode);
  });

  // 6. SUBMIT WORDS
  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      const playerName = rooms[code].players[socket.id].name;
      
      if (!globalGameData[code]) { globalGameData[code] = { playerWords: {}, votes: {} }; }
      globalGameData[code].playerWords[socket.id] = data.words; 

      // Si hay bot, forzar finalización tras un momento
      if (room && room.hasBot) {
          if (room.botTimer) clearTimeout(room.botTimer); // Bot deja de pensar si tú acabas antes
          
          // Generar palabras del bot si no las tiene (porque le ganaste por velocidad)
          const botId = Object.keys(room.players).find(id => room.players[id].isBot);
          if (botId && !globalGameData[code].playerWords[botId]) {
              let botWords = {};
              room.categories.forEach(cat => botWords[cat] = `${cat} ${room.letter}`);
              globalGameData[code].playerWords[botId] = botWords;
          }

          setTimeout(() => finalizeRound(code), 1000);
      } else {
          // Lógica multijugador normal (esperar a todos)
          const allPlayers = Object.keys(room.players).length;
          const submitted = Object.keys(globalGameData[code].playerWords).length;
          if (submitted >= allPlayers) {
             finalizeRound(code); // Sin fase de juicio, directo a resultados
          }
      }
  });

  socket.on('send_message', (data) => { if(data.roomCode) io.to(data.roomCode).emit('receive_message', { sender: data.playerName, text: data.message }); });
  socket.on('send_reaction', (data) => { if(data.roomCode) io.to(data.roomCode).emit('receive_reaction', { emoji: data.emoji }); });
  socket.on("disconnect", () => {});
});

httpServer.listen(PORT, () => { console.log(`✅ Servidor listo en ${PORT}`); });
