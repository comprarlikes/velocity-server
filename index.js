const { Server } = require("socket.io");
const admin = require('firebase-admin');

// 1. EL "DESPERTADOR" PARA LA NUBE
const httpServer = require("http").createServer((req, res) => {
    // Si alguien visita la URL principal (ej: con un navegador), respondemos "Estoy vivo".
    // Esto evita que servicios como Render pongan el servidor a "dormir" por inactividad.
    if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Velocity Server is Online and Ready!");
    }
}); 

// 2. CONEXIÓN A LA BASE DE DATOS (FIREBASE)
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    const db = admin.firestore();
    console.log("✅ Conexión con Firebase establecida.");
} catch (error) {
    console.error("⚠️ ERROR: No se encontró 'serviceAccountKey.json'. El ranking global no funcionará.");
    // El juego puede seguir sin base de datos, pero no guardará victorias.
}

// 3. CONFIGURACIÓN DEL SERVIDOR DE JUEGO (SOCKET.IO)
const io = new Server(httpServer, {
  cors: { origin: "*" } // Permitir conexiones desde cualquier lugar
});

// 4. CONFIGURACIÓN DEL PUERTO (NUBE O LOCAL)
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN DEL JUEGO ---
const ALPHABET = "ABCDEFGHIJLMNOPRSTUV";
const ALL_CATEGORIES = [
    "NOMBRE", "COLOR", "FRUTA", "PAÍS", "ANIMAL", "MARCA", 
    "COMIDA", "OBJETO", "PROFESIÓN", "PELÍCULA", "SERIE", 
    "FAMOSO", "VERBO", "DEPORTE", "CUERPO", "ROPA", "TRANSPORTE",
    "VIDEOJUEGO", "CANTANTE", "CIUDAD", "ASIGNATURA"
];

// Almacén de salas activas
let rooms = {}; 

// --- FUNCIONES AUXILIARES ---
function generateRoomCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }

function startNewRound(roomCode) {
    if (!rooms[roomCode]) return;
    rooms[roomCode].letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    let shuffled = ALL_CATEGORIES.sort(() => 0.5 - Math.random());
    rooms[roomCode].categories = shuffled.slice(0, 5);
    rooms[roomCode].isPanic = false;
}

// --- LÓGICA PRINCIPAL DEL SERVIDOR ---
io.on("connection", (socket) => {
  
  // CREAR SALA
  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      socket.join(code);
      rooms[code] = { players: {}, admin: socket.id, status: 'LOBBY' };
      rooms[code].players[socket.id] = { name: data.name, score: 0 };
      console.log(`🏠 Sala ${code} creada por ${data.name}`);
      socket.emit('room_joined', { code: code, isHost: true, players: Object.values(rooms[code].players) });
  });

  // UNIRSE A SALA
  socket.on('join_room', (data) => {
      const code = data.code.toUpperCase();
      if (!rooms[code]) {
          socket.emit('error_msg', 'La sala no existe.');
          return;
      }
      socket.join(code);
      rooms[code].players[socket.id] = { name: data.name, score: 0 };
      console.log(`👤 ${data.name} entró a ${code}`);
      socket.emit('room_joined', { code: code, isHost: false, players: Object.values(rooms[code].players) });
      io.to(code).emit('update_players', Object.values(rooms[code].players));
  });

  // INICIAR PARTIDA
  socket.on('start_game', (data) => {
      const code = data.roomCode;
      if (!rooms[code] || rooms[code].admin !== socket.id) return;
      startNewRound(code);
      io.to(code).emit('round_start', { letter: rooms[code].letter, categories: rooms[code].categories });
  });

  // BOTÓN STOP
  socket.on('stop_pressed', (data) => {
      const code = data.roomCode; 
      const room = rooms[code];
      if (!room || room.isPanic) return;
      room.isPanic = true;
      io.to(code).emit('panic_mode', {});

      setTimeout(() => {
          let ranking = [];
          for (let pid in room.players) {
              ranking.push({ name: room.players[pid].name, score: room.players[pid].score });
          }
          ranking.sort((a, b) => b.score - a.score);
          io.to(code).emit('game_ranking', ranking);

          // GUARDAR VICTORIA EN FIREBASE
          if (ranking.length > 0 && ranking[0].score > 0 && db) {
              const winnerName = ranking[0].name;
              const playerRef = db.collection('players').doc(winnerName.toUpperCase());
              playerRef.set({ 
                  name: winnerName,
                  wins: admin.firestore.FieldValue.increment(1) 
              }, { merge: true });
              console.log(`🏆 Victoria para ${winnerName} guardada.`);
          }
          
          for (let pid in room.players) { room.players[pid].score = 0; } // Reset scores

          setTimeout(() => {
              room.isPanic = false;
              startNewRound(code);
              io.to(code).emit('round_start', { letter: room.letter, categories: room.categories });
          }, 5000);
      }, 8000);
  });

  // CORREGIR PALABRAS
  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      if (!room || !room.players[socket.id]) return;
      let score = 0;
      for (const [_, palabra] of Object.entries(data.words)) {
          if (palabra && palabra.length > 0 && palabra[0] === room.letter) score += 100;
      }
      room.players[socket.id].score = score;
  });

  // CHAT
  socket.on('send_message', (data) => {
      io.to(data.roomCode).emit('receive_message', { sender: data.playerName, text: data.message });
  });

  // REACCIONES
  socket.on('send_reaction', (data) => {
      io.to(data.roomCode).emit('receive_reaction', { emoji: data.emoji });
  });

  // DESCONEXIÓN
  socket.on("disconnect", () => {
      // (Lógica para borrar al jugador de la sala si se va)
  });
});

// --- ARRANCAR SERVIDOR ---
httpServer.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
