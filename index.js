const { Server } = require("socket.io");
const admin = require('firebase-admin');
const httpServer = require("http").createServer((req, res) => {
    if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Velocity Server (with Bots) is Online!"); }
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
const TOTAL_ROUNDS = 3;
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

    // --- LÓGICA DEL BOT ---
    // Si hay un bot en la sala, programamos su comportamiento
    const botId = Object.keys(room.players).find(id => room.players[id].isBot);
    if (botId) {
        handleBotTurn(room, botId, roomCode);
    }

    return room;
}

// --- INTELIGENCIA ARTIFICIAL DEL BOT ---
function handleBotTurn(room, botId, roomCode) {
    // 1. Calcular cuánto tardará el bot (entre 40 y 55 segundos)
    const botThinkingTime = (Math.floor(Math.random() * 15) + 40) * 1000;
    
    console.log(`🤖 Bot ${room.players[botId].name} pensando... (${botThinkingTime/1000}s)`);

    // Guardamos el timeout en la sala para poder cancelarlo si el humano gana antes
    room.botTimer = setTimeout(() => {
        if (room.status !== 'PLAYING' || room.isPanic) return;

        console.log(`🤖 Bot ${room.players[botId].name} pulsa STOP!`);

        // 2. Generar palabras del Bot
        let botWords = {};
        room.categories.forEach(cat => {
            // El bot es un poco vago, pone "Animal con A", "Color con A"
            // (Suficiente para que el sistema lo dé por válido)
            botWords[cat] = `${cat} ${room.letter}`; 
        });

        // 3. Simular envío de palabras
        // Llamamos a la lógica de submit interna
        handleSubmitWords(roomCode, botId, botWords);

        // 4. El Bot pulsa STOP
        handleStop(roomCode, botId);

    }, botThinkingTime);
}

function handleStop(code, playerId) {
    const room = rooms[code];
    if (!room || room.isPanic) return;

    room.isPanic = true;
    io.to(code).emit('panic_mode', {});
    
    // Disparar final de ronda tras 8 segundos
    setTimeout(() => finalizeRound(code), 8000);
}

function handleSubmitWords(code, playerId, words) {
    const room = rooms[code];
    if (!room) return;

    // Guardar palabras
    if (!globalGameData[code]) { globalGameData[code] = { playerWords: {}, votes: {} }; }
    
    // Si es un bot, simulamos el socket.id con su ID interno
    const pName = room.players[playerId].name;
    globalGameData[code].playerWords[playerId] = words;
}

function finalizeRound(code) {
    const room = rooms[code];
    if (!room) return;

    // Calcular puntos
    let roundRanking = [];
    const gameData = globalGameData[code];

    if (gameData && gameData.playerWords) {
        for (let pid in room.players) {
            let pScore = 0;
            const words = gameData.playerWords[pid];
            
            if (words) {
                for (const [cat, word] of Object.entries(words)) {
                    // Validación simple: no vacío y letra correcta
                    if (word && word.length > 0 && word[0].toUpperCase() === room.letter) {
                        pScore += 100;
                    }
                }
            }
            room.players[pid].score = pScore;
            roundRanking.push(room.players[pid]);
        }
    } else {
        // Si nadie envió nada (raro)
        for (let pid in room.players) roundRanking.push(room.players[pid]);
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
        // Guardar solo si ganó un humano (opcional)
        if (finalPodium.length > 0 && !finalPodium[0].isBot && db) {
             const winner = finalPodium[0];
             db.collection('players').doc(winner.name.toUpperCase()).set({ 
                 name: winner.name, wins: admin.firestore.FieldValue.increment(1), 
                 avatar: winner.avatar, frame: winner.frame 
             }, { merge: true });
        }
        io.to(code).emit('match_over', finalPodium);
        // Limpiar sala
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
  console.log("Jugador conectado:", socket.id);

  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      socket.join(code);
      rooms[code] = { 
          players: {}, admin: socket.id, status: 'LOBBY',
          currentRound: 0, totalRounds: data.rounds || 3, roundTime: data.time || 60,
          stopMode: data.stopMode || 'BLITZ', letter: "", categories: [], isPanic: false
      };
      const pName = data.playerName || data.name;
      rooms[code].players[socket.id] = { name: pName, score: 0, wins: 0, id: socket.id, avatar: data.avatar || 'robot1', frame: data.frame || 'none' };
      
      if (db) db.collection('players').doc(pName.toUpperCase()).set({ name: pName, avatar: data.avatar, frame: data.frame }, { merge: true });
      socket.emit('room_joined', { code: code, isHost: true, players: Object.values(rooms[code].players) });
  });

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

  socket.on('start_game', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      if (!room || room.admin !== socket.id) return;
      
      startNewRound(code);
      io.to(code).emit('round_start', { letter: room.letter, categories: room.categories, round: room.currentRound, totalRounds: room.totalRounds, time: room.roundTime });
  });

  // --- MATCHMAKING CON BOTS ---
  socket.on('find_match', (data) => {
      // 1. Buscar sala real
      for (let code in rooms) {
          if (rooms[code].status === 'LOBBY' && Object.keys(rooms[code].players).length < 8 && !rooms[code].hasBot) {
              socket.emit('match_found', { code: code });
              return;
          }
      }

      // 2. SI NO HAY SALA, CREAMOS UNA CON BOT
      const code = generateRoomCode();
      socket.join(code);
      
      const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
      const botId = "BOT_" + Math.random().toString(36).substr(2, 5);

      rooms[code] = { 
          players: {}, admin: socket.id, status: 'LOBBY', hasBot: true, // Marcamos que tiene bot
          currentRound: 0, totalRounds: 3, roundTime: 60,
          stopMode: 'BLITZ', letter: "", categories: [], isPanic: false
      };

      // Añadimos al BOT como si fuera un jugador más
      rooms[code].players[botId] = { 
          name: botName, score: 0, wins: 0, id: botId, isBot: true,
          avatar: 'demon', frame: 'gold_master' // El bot va chulo
      };

      // Añadimos al JUGADOR REAL (admin)
      const pName = data.name;
      rooms[code].players[socket.id] = { 
          name: pName, score: 0, wins: 0, id: socket.id,
          // (Asumimos avatar default hasta que el cliente lo actualice al entrar)
          avatar: 'robot1', frame: 'none' 
      };

      console.log(`🤖 Sala BOT ${code} creada para ${pName} vs ${botName}`);
      
      // Enviamos al jugador a esta sala
      socket.emit('match_found', { code: code });
      
      // NOTA: Cuando el jugador se una con 'join_room' (automático en la app),
      // verá al bot en la lista. Y como el jugador es admin, podrá darle a INICIAR.
  });

  socket.on('stop_pressed', (data) => {
     handleStop(data.roomCode, socket.id);
  });

  socket.on('submit_words', (data) => {
     handleSubmitWords(data.roomCode, socket.id, data.words);
     
     // Si hay bot, forzar la finalización tras un pequeño delay
     const room = rooms[data.roomCode];
     if (room && room.hasBot) {
         clearTimeout(room.botTimer); // El bot deja de pensar
         setTimeout(() => finalizeRound(data.roomCode), 1000);
     }
  });
  
  socket.on('send_message', (data) => { if(data.roomCode) io.to(data.roomCode).emit('receive_message', { sender: data.playerName, text: data.message }); });
  socket.on('send_reaction', (data) => { if(data.roomCode) io.to(data.roomCode).emit('receive_reaction', { emoji: data.emoji }); });
  socket.on("disconnect", () => {});
});

httpServer.listen(PORT, () => { console.log(`✅ Servidor listo en ${PORT}`); });
