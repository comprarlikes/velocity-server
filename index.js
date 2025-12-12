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

// --- MOTOR DEL JUEGO ---

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    room.currentRound += 1;
    room.letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    let shuffled = ALL_CATEGORIES.sort(() => 0.5 - Math.random());
    room.categories = shuffled.slice(0, 5);
    room.isPanic = false;
    room.status = 'PLAYING';
    
    // Resetear puntuaciones de ronda
    for (let pid in room.players) {
        room.players[pid].score = 0;
    }

    console.log(`🔄 Ronda ${room.currentRound} iniciada en ${roomCode}. Letra: ${room.letter}`);

    // SI HAY BOT, ACTIVAR SU IA
    if (room.hasBot) {
        activateBotAI(room, roomCode);
    }

    return room;
}

// --- INTELIGENCIA ARTIFICIAL (EL CEREBRO DEL BOT) ---
function activateBotAI(room, roomCode) {
    const botId = Object.keys(room.players).find(id => room.players[id].isBot);
    if (!botId) return;

    // 1. Calcular cuánto tardará el bot (entre 20 y 45 segundos)
    // El bot será un poco más rápido que un humano medio para presionar
    const botThinkingTime = (Math.floor(Math.random() * 25) + 20) * 1000;
    
    console.log(`🤖 Bot ${room.players[botId].name} pensando... pulsará STOP en ${botThinkingTime/1000}s`);

    // Guardamos el timer para cancelarlo si el humano pulsa antes
    room.botTimer = setTimeout(() => {
        if (room.status !== 'PLAYING' || room.isPanic) return;

        console.log(`🤖 Bot ${room.players[botId].name} ha terminado y pulsa STOP!`);

        // 2. Generar palabras válidas del Bot
        let botWords = {};
        room.categories.forEach(cat => {
            // Truco: El bot pone "Categoria + Letra" (ej: "ANIMAL A")
            // Esto siempre es válido para el juez automático
            botWords[cat] = `${cat} ${room.letter}`; 
        });

        // 3. Enviar palabras internamente
        if (!globalGameData[roomCode]) { globalGameData[roomCode] = { playerWords: {}, votes: {} }; }
        globalGameData[roomCode].playerWords[botId] = botWords;

        // 4. Pulsar STOP (Dispara el pánico para el usuario)
        handleStop(roomCode, botId);

    }, botThinkingTime);
}

function handleStop(code, stopperId) {
    const room = rooms[code];
    if (!room || room.isPanic) return;

    room.isPanic = true;
    console.log(`🚨 STOP pulsado por ${stopperId} en sala ${code}`);
    
    // Avisar a los clientes (el móvil vibrará y se pondrá rojo)
    io.to(code).emit('panic_mode', {});
    
    // Forzar el final de ronda tras 8 segundos (Tiempo de Pánico)
    setTimeout(() => {
        finalizeRound(code);
    }, 8000);
}

function finalizeRound(code) {
    const room = rooms[code];
    if (!room) return;

    // JUEZ AUTOMÁTICO
    let roundRanking = [];
    const gameData = globalGameData[code] || { playerWords: {} };

    // Si el bot jugó, asegurarnos de que sus palabras están ahí
    if (room.hasBot) {
        const botId = Object.keys(room.players).find(id => room.players[id].isBot);
        // Si el bot no había enviado (porque el humano pulsó STOP antes), generamos sus palabras ahora
        if (botId && (!gameData.playerWords || !gameData.playerWords[botId])) {
             if (!gameData.playerWords) gameData.playerWords = {};
             let botWords = {};
             room.categories.forEach(cat => botWords[cat] = `${cat} ${room.letter}`);
             gameData.playerWords[botId] = botWords;
        }
    }

    // Calcular Puntos para todos
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

    // Ordenar por puntos de ronda
    roundRanking.sort((a,b) => b.score - a.score);
    
    // Asignar Victoria de Ronda (Wins)
    if (roundRanking.length > 0 && roundRanking[0].score > 0) {
        // En caso de empate, damos victoria a todos los empatados en primer lugar
        const maxScore = roundRanking[0].score;
        roundRanking.forEach(p => {
            if (p.score === maxScore) {
                room.players[p.id].wins += 1;
            }
        });
    }

    io.to(code).emit('game_ranking', roundRanking.map(p => ({name: p.name, score: p.score})));

    // Decidir siguiente paso
    if (room.currentRound >= room.totalRounds) {
        // FIN DE PARTIDA
        let finalPodium = Object.values(room.players).sort((a,b) => b.wins - a.wins);
        
        // Guardar en Firebase solo si gana un humano (para no ensuciar la DB con bots)
        if (finalPodium.length > 0 && !finalPodium[0].isBot && db) {
             const winner = finalPodium[0];
             db.collection('players').doc(winner.name.toUpperCase()).set({ 
                 name: winner.name, wins: admin.firestore.FieldValue.increment(1), 
                 avatar: winner.avatar, frame: winner.frame 
             }, { merge: true });
        }
        
        io.to(code).emit('match_over', finalPodium);
        
        // Limpiar memoria
        delete rooms[code];
        delete globalGameData[code];
    } else {
        // SIGUIENTE RONDA
        setTimeout(() => {
            startNewRound(code);
            io.to(code).emit('round_start', { 
                letter: room.letter, categories: room.categories, 
                round: room.currentRound, totalRounds: room.totalRounds, time: room.roundTime 
            });
        }, 5000);
    }
}

// --- SOCKET.IO HANDLERS ---
io.on("connection", (socket) => {
  
  // 1. MATCHMAKING INTELIGENTE (BOT FILLING)
  socket.on('find_match', (data) => {
      // A. Buscar sala humana existente
      for (let code in rooms) {
          if (rooms[code].status === 'LOBBY' && Object.keys(rooms[code].players).length < 8 && !rooms[code].hasBot) {
              console.log(`🔍 ${data.name} se une a humanos en ${code}`);
              socket.emit('match_found', { code: code });
              return;
          }
      }

      // B. Si no hay humanos, CREAR SALA CON BOT
      const code = generateRoomCode();
      const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
      const botId = "BOT_" + Math.random().toString(36).substr(2, 5);

      rooms[code] = { 
          players: {}, 
          admin: botId, // ¡EL BOT ES EL JEFE!
          status: 'LOBBY', hasBot: true,
          currentRound: 0, totalRounds: 3, roundTime: 60,
          stopMode: 'BLITZ', letter: "", categories: [], isPanic: false
      };

      // Añadir Bot
      rooms[code].players[botId] = { 
          name: botName, score: 0, wins: 0, id: botId, isBot: true,
          avatar: 'demon', frame: 'gold_master' // Look del bot
      };

      console.log(`🤖 Sala BOT ${code} creada. ${data.name} vs ${botName}`);
      
      // Enviamos al jugador el código. 
      // Al unirse, verá que no es el host, por lo que saldrá "Esperando al líder..."
      socket.emit('match_found', { code: code });

      // C. PROGRAMAR AUTO-INICIO
      // Como el Bot es el líder, él debe "pulsar" iniciar.
      // Lo simulamos con un timeout de 5 segundos (para pruebas rápidas)
      // Cambia 5000 a 30000 si quieres 30 segundos reales.
      setTimeout(() => {
          if (rooms[code] && rooms[code].status === 'LOBBY') {
              console.log(`🤖 Bot inicia la partida en sala ${code}`);
              
              // Simular evento start_game
              rooms[code].status = 'PLAYING';
              startNewRound(code);
              
              io.to(code).emit('round_start', { 
                  letter: rooms[code].letter, 
                  categories: rooms[code].categories,
                  round: rooms[code].currentRound,
                  totalRounds: rooms[code].totalRounds,
                  time: rooms[code].roundTime
              });
          }
      }, 5000); // <--- TIEMPO DE ESPERA EN LOBBY (5s para testing)
  });

  // 2. UNIRSE A SALA
  socket.on('join_room', (data) => {
      const code = data.code ? data.code.toUpperCase() : "";
      if (!rooms[code]) return socket.emit('error_msg', 'Sala no existe.');
      
      socket.join(code);
      
      // Añadir jugador real
      const pData = { 
          name: data.name, score: 0, wins: 0, id: socket.id, 
          avatar: data.avatar || 'robot1', frame: data.frame || 'none' 
      };
      rooms[code].players[socket.id] = pData;
      
      // Actualizar Firebase
      if (db) db.collection('players').doc(pData.name.toUpperCase()).set({ name: pData.name, avatar: pData.avatar, frame: pData.frame }, { merge: true });
      
      // Enviar info de sala
      // isHost será false porque rooms[code].admin es el Bot ID
      const isUserHost = rooms[code].admin === socket.id;
      
      socket.emit('room_joined', { 
          code: code, 
          isHost: isUserHost, 
          players: Object.values(rooms[code].players) 
      });
      
      io.to(code).emit('update_players', Object.values(rooms[code].players));
  });

  // 3. STOP DEL JUGADOR
  socket.on('stop_pressed', (data) => {
      handleStop(data.roomCode, socket.id);
  });

  // 4. PALABRAS DEL JUGADOR
  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      
      if (!room) return;
      
      if (!globalGameData[code]) { globalGameData[code] = { playerWords: {}, votes: {} }; }
      
      // Guardar palabras del jugador
      globalGameData[code].playerWords[socket.id] = data.words; 
      
      // Si estamos contra un Bot y el humano ya envió, el bot debe terminar ya
      if (room.hasBot) {
          if (room.botTimer) clearTimeout(room.botTimer); // Cancelar pensamiento del bot
          
          // El bot envía sus palabras inmediatamente (si no lo hizo ya)
          const botId = Object.keys(room.players).find(id => room.players[id].isBot);
          if (botId && !globalGameData[code].playerWords[botId]) {
               let botWords = {};
               room.categories.forEach(cat => botWords[cat] = `${cat} ${room.letter}`);
               globalGameData[code].playerWords[botId] = botWords;
          }
          
          // Finalizar ronda casi inmediatamente para dar sensación de velocidad
          setTimeout(() => finalizeRound(code), 1000);
      }
  });

  // --- STANDARD HANDLERS ---
  socket.on('create_room', (data) => { /* Lógica manual de antes... */ 
      // (Mantenemos la lógica manual por si alguien quiere crear privada)
      const code = generateRoomCode();
      socket.join(code);
      rooms[code] = { players: {}, admin: socket.id, status: 'LOBBY', currentRound: 0, totalRounds: data.rounds || 3, roundTime: data.time || 60, stopMode: 'BLITZ', letter: "", categories: [], isPanic: false };
      rooms[code].players[socket.id] = { name: data.playerName, score: 0, wins: 0, id: socket.id, avatar: data.avatar, frame: data.frame };
      if (db) db.collection('players').doc(data.playerName.toUpperCase()).set({ name: data.playerName, avatar: data.avatar, frame: data.frame }, { merge: true });
      socket.emit('room_joined', { code: code, isHost: true, players: Object.values(rooms[code].players) });
  });
  
  socket.on('start_game', (data) => { /* Inicio manual por jugador */
     const room = rooms[data.roomCode];
     if(room && room.admin === socket.id) {
         startNewRound(data.roomCode);
         io.to(data.roomCode).emit('round_start', { letter: room.letter, categories: room.categories, round: room.currentRound, totalRounds: room.totalRounds, time: room.roundTime });
     }
  });

  socket.on('send_message', (data) => { if(data.roomCode) io.to(data.roomCode).emit('receive_message', { sender: data.playerName, text: data.message }); });
  socket.on('send_reaction', (data) => { if(data.roomCode) io.to(data.roomCode).emit('receive_reaction', { emoji: data.emoji }); });
  socket.on("disconnect", () => {});
});

httpServer.listen(PORT, () => { console.log(`✅ Servidor listo en ${PORT}`); });
