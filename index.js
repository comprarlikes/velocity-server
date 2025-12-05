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
}

const io = new Server(httpServer, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

const ALPHABET = "ABCDEFGHIJLMNOPRSTUV";
const ALL_CATEGORIES = ["NOMBRE", "COLOR", "FRUTA", "PAÍS", "ANIMAL", "MARCA", "COMIDA", "OBJETO", "PROFESIÓN", "PELÍCULA", "SERIE", "FAMOSO"];
let rooms = {}; 

function generateRoomCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    room.currentRound += 1;
    room.letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    let shuffled = ALL_CATEGORIES.sort(() => 0.5 - Math.random());
    room.categories = shuffled.slice(0, 5);
    room.isPanic = false;
    for (let pid in room.players) { room.players[pid].score = 0; }
}

io.on("connection", (socket) => {
  
  // 1. CREAR SALA (Recibimos avatar y marco)
  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      socket.join(code);
      rooms[code] = { 
          players: {}, admin: socket.id, status: 'LOBBY',
          currentRound: 0, totalRounds: data.rounds || 3, roundTime: data.time || 60,
          stopMode: data.stopMode || 'BLITZ', letter: "", categories: [], isPanic: false
      };
      rooms[code].players[socket.id] = { 
          name: data.playerName || data.name, 
          score: 0, wins: 0, id: socket.id,
          avatar: data.avatar || 'robot1', // Guardamos look
          frame: data.frame || 'none' 
      };
      console.log(`🏠 Sala ${code} creada por ${data.playerName} (Look: ${data.avatar})`);
      socket.emit('room_joined', { code: code, isHost: true, players: Object.values(rooms[code].players) });
  });

  // 2. UNIRSE A SALA
  socket.on('join_room', (data) => {
      const code = data.code ? data.code.toUpperCase() : "";
      if (!rooms[code]) return socket.emit('error_msg', 'Sala no existe.');
      socket.join(code);
      rooms[code].players[socket.id] = { 
          name: data.name, score: 0, wins: 0, id: socket.id,
          avatar: data.avatar || 'robot1',
          frame: data.frame || 'none'
      };
      socket.emit('room_joined', { code: code, isHost: false, players: Object.values(rooms[code].players) });
      io.to(code).emit('update_players', Object.values(rooms[code].players));
  });

  // ... (start_game, stop_pressed, submit_words IGUAL) ...
  socket.on('start_game', (data) => {
      const code = data.roomCode;
      if (rooms[code] && rooms[code].admin === socket.id) {
          startNewRound(code);
          io.to(code).emit('round_start', { letter: rooms[code].letter, categories: rooms[code].categories, round: rooms[code].currentRound, totalRounds: rooms[code].totalRounds, time: rooms[code].roundTime });
      }
  });

  socket.on('stop_pressed', (data) => {
      const code = data.roomCode; const room = rooms[code];
      if (!room || room.isPanic) return;
      room.isPanic = true;
      io.to(code).emit('panic_mode', {});

      setTimeout(() => {
          let roundRanking = [];
          for (let pid in room.players) {
              roundRanking.push({ id: pid, name: room.players[pid].name, score: room.players[pid].score });
          }
          roundRanking.sort((a, b) => b.score - a.score);
          if (roundRanking.length > 0 && roundRanking[0].score > 0) {
              const winnerId = roundRanking[0].id;
              if (room.players[winnerId]) room.players[winnerId].wins += 1;
          }
          io.to(code).emit('game_ranking', roundRanking);

          if (room.currentRound >= room.totalRounds) {
              let finalPodium = Object.values(room.players).sort((a,b) => b.wins - a.wins);
              
              // GUARDAR EN FIREBASE CON AVATAR
              if (finalPodium.length > 0 && db) {
                  const winner = finalPodium[0];
                  const playerRef = db.collection('players').doc(winner.name.toUpperCase());
                  playerRef.set({ 
                      name: winner.name,
                      wins: admin.firestore.FieldValue.increment(1),
                      avatar: winner.avatar, // ¡Guardar!
                      frame: winner.frame    // ¡Guardar!
                  }, { merge: true });
              }
              io.to(code).emit('match_over', finalPodium);
          } else {
              setTimeout(() => {
                  room.isPanic = false;
                  startNewRound(code);
                  io.to(code).emit('round_start', { letter: room.letter, categories: room.categories, round: room.currentRound, totalRounds: room.totalRounds, time: room.roundTime });
              }, 5000);
          }
      }, 8000);
  });
  
  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      if (rooms[code] && rooms[code].players[socket.id]) {
          let score = 0;
          for (const [_, palabra] of Object.entries(data.words)) {
              if (palabra && palabra.length > 0 && palabra[0].toUpperCase() === rooms[code].letter) score += 100;
          }
          rooms[code].players[socket.id].score = score;
      }
  });

  socket.on('send_message', (data) => { io.to(data.roomCode).emit('receive_message', { sender: data.playerName, text: data.message }); });
  socket.on('send_reaction', (data) => { io.to(data.roomCode).emit('receive_reaction', { emoji: data.emoji }); });
  socket.on("disconnect", () => {});
});

httpServer.listen(PORT, () => { console.log(`✅ Servidor listo en ${PORT}`); });
