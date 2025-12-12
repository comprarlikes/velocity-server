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
const BOT_NAMES = ["AlexBot", "Sofia_AI", "CyberMax", "NeoBot", "Trinity_AI", "VelocityMaster"];
const TOTAL_ROUNDS = 3; 

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

    // SI HAY BOT, ACTIVAR SU IA
    if (room.hasBot) {
        activateBotAI(room, roomCode);
    }

    return room;
}

// --- INTELIGENCIA ARTIFICIAL (CORREGIDA) ---
function activateBotAI(room, roomCode) {
    const botId = Object.keys(room.players).find(id => room.players[id].isBot);
    if (!botId) return;

    // El bot piensa entre 20 y 40 segundos
    const botThinkingTime = (Math.floor(Math.random() * 20) + 20) * 1000;
    
    console.log(`🤖 Bot ${room.players[botId].name} pensando... (${botThinkingTime/1000}s)`);

    room.botTimer = setTimeout(() => {
        if (room.status !== 'PLAYING' || room.isPanic) return;

        console.log(`🤖 Bot ${room.players[botId].name} pulsa STOP!`);

        // 1. Generar palabras VÁLIDAS (Letra al principio)
        let botWords = {};
        room.categories.forEach(cat => {
            // Ej: Si letra es P -> "P - COLOR"
            botWords[cat] = `${room.letter} - ${cat}`; 
        });

        // 2. Guardar palabras en la memoria global (IMPORTANTE)
        if (!globalGameData[roomCode]) { globalGameData[roomCode] = { playerWords: {}, votes: {} }; }
        globalGameData[roomCode].playerWords[botId] = botWords;

        // 3. Pulsar STOP
        handleStop(roomCode, botId);

    }, botThinkingTime);
}

function handleStop(code, stopperId) {
    const room = rooms[code];
    if (!room || room.isPanic) return;

    room.isPanic = true;
    console.log(`🚨 STOP pulsado por ${stopperId} en sala ${code}`);
    
    io.to(code).emit('panic_mode', {});
    
    setTimeout(() => {
        finalizeRound(code);
    }, 8000);
}

function finalizeRound(code) {
    const room = rooms[code];
    if (!room) return;

    let roundRanking = [];
    const gameData = globalGameData[code] || { playerWords: {} };

    // ASEGURAR QUE EL BOT TIENE PALABRAS (Si el humano ganó muy rápido)
    if (room.hasBot) {
        const botId = Object.keys(room.players).find(id => room.players[id].isBot);
        if (botId && (!gameData.playerWords || !gameData.playerWords[botId])) {
             if (!gameData.playerWords) gameData.playerWords = {};
             let botWords = {};
             // El bot improvisa palabras rápidas si perdió
             room.categories.forEach(cat => botWords[cat] = `${room.letter} - ${cat}`);
             gameData.playerWords[botId] = botWords;
        }
    }

    // CALCULAR PUNTOS
    for (let pid in room.players) {
        let pScore = 0;
        const words = gameData.playerWords ? gameData.playerWords[pid] : null;
        
        if (words) {
            for (const [cat, word] of Object.entries(words)) {
                // Validación: No vacío y empieza por letra correcta
                if (word && word.length > 0 && word[0].toUpperCase() === room.letter) {
                    pScore += 100;
                }
            }
        }
        room.players[pid].score = pScore;
        roundRanking.push(room.players[pid]);
    }

    // Ordenar
    roundRanking.sort((a,b) => b.score - a.score);
    
    // Asignar Victoria de Ronda
    if (roundRanking.length > 0 && roundRanking[0].score > 0) {
        const maxScore = roundRanking[0].score;
        roundRanking.forEach(p => {
            if (p.score === maxScore) room.players[p.id].wins += 1;
        });
    }

    io.to(code).emit('game_ranking', roundRanking.map(p => ({name: p.name, score: p.score})));

    // Siguiente paso
    if (room.currentRound >= room.totalRounds) {
        let finalPodium = Object.values(room.players).sort((a,b) => b.wins - a.wins);
        if (finalPodium.length > 0 && !finalPodium[0].isBot && db) {
             const winner = finalPodium[0];
             db.collection('players').doc(winner.name.toUpperCase()).set({ 
                 name: winner.name, wins: admin.firestore.FieldValue.increment(1), 
                 avatar: winner.avatar, frame: winner.frame 
             }, { merge: true });
        }
        io.to(code).emit('match_over', finalPodium);
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
  
  // 1. MATCHMAKING (BOT)
  socket.on('find_match', (data) => {
      for (let code in rooms) {
          if (rooms[code].status === 'LOBBY' && Object.keys(rooms[code].players).length < 8 && !rooms[code].hasBot) {
              socket.emit('match_found', { code: code });
              return;
          }
      }

      const code = generateRoomCode();
      const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
      const botId = "BOT_" + Math.random().toString(36).substr(2, 5);

      rooms[code] = { 
          players: {}, admin: botId, status: 'LOBBY', hasBot: true,
          currentRound: 0, totalRounds: 3, roundTime: 60,
          stopMode: 'BLITZ', letter: "", categories: [], isPanic: false
      };

      rooms[code].players[botId] = { 
          name: botName, score: 0, wins: 0, id: botId, isBot: true,
          avatar: 'demon', frame: 'gold_master' 
      };

      console.log(`🤖 Sala BOT ${code} creada para ${data.name}`);
      socket.emit('match_found', { code: code });

      // AUTO-INICIO DEL BOT (10 seg para que te de tiempo a ver el lobby)
      setTimeout(() => {
          if (rooms[code] && rooms[code].status === 'LOBBY') {
              rooms[code].status = 'PLAYING';
              startNewRound(code);
              io.to(code).emit('round_start', { 
                  letter: rooms[code].letter, categories: rooms[code].categories,
                  round: rooms[code].currentRound, totalRounds: rooms[code].totalRounds,
                  time: rooms[code].roundTime
              });
          }
      }, 10000); 
  });

  // 2. UNIRSE
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
      
      const isUserHost = rooms[code].admin === socket.id;
      socket.emit('room_joined', { code: code, isHost: isUserHost, players: Object.values(rooms[code].players) });
      io.to(code).emit('update_players', Object.values(rooms[code].players));
  });

  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      socket.join(code);
      rooms[code] = { players: {}, admin: socket.id, status: 'LOBBY', currentRound: 0, totalRounds: data.rounds || 3, roundTime: data.time || 60, stopMode: 'BLITZ', letter: "", categories: [], isPanic: false };
      rooms[code].players[socket.id] = { name: data.playerName, score: 0, wins: 0, id: socket.id, avatar: data.avatar, frame: data.frame };
      if (db) db.collection('players').doc(data.playerName.toUpperCase()).set({ name: data.playerName, avatar: data.avatar, frame: data.frame }, { merge: true });
      socket.emit('room_joined', { code: code, isHost: true, players: Object.values(rooms[code].players) });
  });
  
  socket.on('start_game', (data) => {
     const room = rooms[data.roomCode];
     if(room && room.admin === socket.id) {
         startNewRound(data.roomCode);
         io.to(data.roomCode).emit('round_start', { letter: room.letter, categories: room.categories, round: room.currentRound, totalRounds: room.totalRounds, time: room.roundTime });
     }
  });

  socket.on('stop_pressed', (data) => { handleStop(data.roomCode, socket.id); });

  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      if (!room) return;
      
      if (!globalGameData[code]) { globalGameData[code] = { playerWords: {}, votes: {} }; }
      globalGameData[code].playerWords[socket.id] = data.words; 
      
      // Si hay bot y el humano envió, forzamos fin
      if (room.hasBot) {
          if (room.botTimer) clearTimeout(room.botTimer);
          // Generar palabras bot si no existen
          const botId = Object.keys(room.players).find(id => room.players[id].isBot);
          if (botId && !globalGameData[code].playerWords[botId]) {
               let botWords = {};
               room.categories.forEach(cat => botWords[cat] = `${room.letter} - ${cat}`);
               globalGameData[code].playerWords[botId] = botWords;
          }
          setTimeout(() => finalizeRound(code), 1000);
      } else {
          // Lógica multijugador normal
          const all = Object.keys(room.players).length;
          const sub = Object.keys(globalGameData[code].playerWords).length;
          if (sub >= all) finalizeRound(code);
      }
  });

  socket.on('send_message', (data) => { if(data.roomCode) io.to(data.roomCode).emit('receive_message', { sender: data.playerName, text: data.message }); });
  socket.on('send_reaction', (data) => { if(data.roomCode) io.to(data.roomCode).emit('receive_reaction', { emoji: data.emoji }); });
  socket.on("disconnect", () => {});
});

httpServer.listen(PORT, () => { console.log(`✅ Servidor listo en ${PORT}`); });
