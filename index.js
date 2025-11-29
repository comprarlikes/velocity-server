const { Server } = require("socket.io");
const httpServer = require("http").createServer((req, res) => {
    if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Velocity Server is Online!"); }
}); 
const admin = require('firebase-admin');

try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    const db = admin.firestore();
    console.log("✅ Conexión con Firebase establecida.");
} catch (error) {
    console.error("⚠️ ERROR: 'serviceAccountKey.json' no encontrado.");
}

const io = new Server(httpServer, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN POR DEFECTO ---
const ALPHABET = "ABCDEFGHIJLMNOPRSTUV";
const ALL_CATEGORIES = ["NOMBRE", "COLOR", "FRUTA", "PAÍS", "ANIMAL", "MARCA", "COMIDA", "OBJETO", "PROFESIÓN", "PELÍCULA", "SERIE", "FAMOSO", "VERBO", "DEPORTE"];

let rooms = {}; 

function generateRoomCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }

// Función auxiliar para iniciar ronda
function prepareRoundData(room) {
    room.currentRound += 1;
    room.letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    let shuffled = ALL_CATEGORIES.sort(() => 0.5 - Math.random());
    room.categories = shuffled.slice(0, 5);
    room.isPanic = false;
    
    // Resetear puntuaciones de ronda
    for (let pid in room.players) {
        room.players[pid].score = 0;
    }
    return room;
}

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // 1. CREAR SALA (Recibe configuración personalizada)
  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      socket.join(code);

      // Guardamos las reglas personalizadas o usamos las de defecto
      rooms[code] = { 
          players: {}, 
          admin: socket.id, 
          status: 'LOBBY',
          currentRound: 0,
          totalRounds: data.rounds || 3,     // <--- REGLA PERSONALIZADA
          roundTime: data.time || 60,        // <--- REGLA PERSONALIZADA
          stopMode: data.stopMode || 'BLITZ',
          letter: "", categories: [], isPanic: false
      };
      
      rooms[code].players[socket.id] = { name: data.playerName || data.name, score: 0, wins: 0, id: socket.id };
      
      console.log(`🏠 Sala ${code} creada. Rondas: ${rooms[code].totalRounds}, Admin: ${socket.id}`);

      socket.emit('room_joined', { 
          code: code, 
          isHost: true, 
          players: Object.values(rooms[code].players) 
      });
  });

  // 2. UNIRSE A SALA
  socket.on('join_room', (data) => {
      const code = data.code ? data.code.toUpperCase() : "";
      if (!rooms[code]) return socket.emit('error_msg', 'La sala no existe.');
      
      socket.join(code);
      rooms[code].players[socket.id] = { name: data.name, score: 0, wins: 0, id: socket.id };
      
      socket.emit('room_joined', { 
          code: code, 
          isHost: false, 
          players: Object.values(rooms[code].players) 
      });
      io.to(code).emit('update_players', Object.values(rooms[code].players));
  });

  // 3. INICIAR PARTIDA (Botón del Host)
  socket.on('start_game', (data) => {
      const code = data.roomCode;
      const room = rooms[code];

      if (!room) return;
      
      // Verificación de seguridad: ¿Es el admin?
      if (room.admin !== socket.id) {
          console.log(`⚠️ Intento de inicio no autorizado en sala ${code}`);
          return;
      }
      
      console.log(`🚀 Iniciando partida en sala ${code}`);
      prepareRoundData(room); // Preparar datos

      // Enviar evento de inicio a TODOS (incluyendo tiempo personalizado)
      io.to(code).emit('round_start', { 
          letter: room.letter, 
          categories: room.categories,
          round: room.currentRound,
          totalRounds: room.totalRounds,
          time: room.roundTime // <--- TIEMPO PERSONALIZADO
      });
  });

  // 4. JUEGO (STOP)
  socket.on('stop_pressed', (data) => {
      const code = data.roomCode; 
      const room = rooms[code];
      if (!room || room.isPanic) return;

      room.isPanic = true;
      io.to(code).emit('panic_mode', {});

      setTimeout(() => {
          // Ranking Ronda
          let roundRanking = [];
          for (let pid in room.players) {
              roundRanking.push({ id: pid, name: room.players[pid].name, score: room.players[pid].score });
          }
          roundRanking.sort((a, b) => b.score - a.score);
          
          // Asignar victoria
          if (roundRanking.length > 0 && roundRanking[0].score > 0) {
              const winnerId = roundRanking[0].id;
              if (room.players[winnerId]) room.players[winnerId].wins += 1;
          }
          
          io.to(code).emit('game_ranking', roundRanking);

          // ¿FIN DE PARTIDA?
          if (room.currentRound >= room.totalRounds) {
              let finalPodium = Object.values(room.players).sort((a,b) => b.wins - a.wins);
              
              // Guardar en Firebase
              if (finalPodium.length > 0 && typeof db !== 'undefined') {
                  const winnerName = finalPodium[0].name;
                  const playerRef = db.collection('players').doc(winnerName.toUpperCase());
                  playerRef.set({ name: winnerName, wins: admin.firestore.FieldValue.increment(1) }, { merge: true });
              }
              io.to(code).emit('match_over', finalPodium);
          } else {
              // SIGUIENTE RONDA
              setTimeout(() => {
                  room.isPanic = false;
                  prepareRoundData(room);
                  io.to(code).emit('round_start', { 
                      letter: room.letter, 
                      categories: room.categories,
                      round: room.currentRound,
                      totalRounds: room.totalRounds,
                      time: room.roundTime
                  });
              }, 5000);
          }
      }, 8000);
  });

  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      if (!room || !room.players[socket.id]) return;
      let score = 0;
      for (const [_, palabra] of Object.entries(data.words)) {
          if (palabra && palabra.length > 0 && palabra[0].toUpperCase() === room.letter) score += 100;
      }
      room.players[socket.id].score = score;
  });

  socket.on('send_message', (data) => { io.to(data.roomCode).emit('receive_message', { sender: data.playerName, text: data.message }); });
  socket.on('send_reaction', (data) => { io.to(data.roomCode).emit('receive_reaction', { emoji: data.emoji }); });
  socket.on("disconnect", () => {});
});

httpServer.listen(PORT, () => {
    console.log(`✅ Servidor escuchando en ${PORT}`);
});
