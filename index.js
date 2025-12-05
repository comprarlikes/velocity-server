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

io.on("connection", (socket) => {
  
  socket.on('create_room', (data) => { /* ... igual ... */ });
  socket.on('join_room', (data) => { /* ... igual ... */ });
  socket.on('start_game', (data) => { /* ... igual ... */ });
  socket.on('find_match', (data) => { /* ... igual ... */ });

  // BOTÓN STOP (Activamos Pánico y esperamos a que el cliente envíe las palabras al finalizar)
  socket.on('stop_pressed', (data) => {
      const code = data.roomCode; 
      const room = rooms[code];
      if (!room || room.isPanic) return;

      room.isPanic = true;
      io.to(code).emit('panic_mode', {});
      
      // Enviamos el mensaje de pánico, y el cliente tiene 5 segundos para enviar SUBMIT_WORDS
  });

  // RECIBIR PALABRAS (El Servidor es el JUEZ)
  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      const playerId = socket.id;
      
      if (!room || room.status !== 'PLAYING') return;

      // 1. Calcular puntuación
      let roundScore = 0;
      for (const [category, word] of Object.entries(data.words)) {
          if (word && word.length > 0 && word[0].toUpperCase() === room.letter) {
              roundScore += 100; // Asumimos 100 puntos (sin lógica de repetición)
          }
      }
      
      // 2. Actualizar Score
      if (room.players[playerId]) {
          room.players[playerId].score = roundScore;
      }
      
      // 3. Chequear si todos han enviado (simplificado: sólo un jugador para la prueba)
      // En un juego real, aquí habría que esperar a TODOS los jugadores...
      
      // 4. Pasar a fase de Ranking (Forzado para la prueba)
      
      // Copiamos la lógica de fin de ronda del servidor para dispararla ahora
      setTimeout(() => {
          let roundRanking = [];
          for (let pid in room.players) {
              roundRanking.push({ id: pid, name: room.players[pid].name, score: room.players[pid].score, avatar: room.players[pid].avatar, frame: room.players[pid].frame });
          }
          
          roundRanking.sort((a,b) => b.score - a.score);
          
          if (roundRanking.length > 0 && roundRanking[0].score > 0) {
              const winnerId = roundRanking[0].id;
              if (room.players[winnerId]) {
                  room.players[winnerId].wins += 1;
              }
          }

          io.to(code).emit('game_ranking', roundRanking.map(p => ({name: p.name, score: p.score})));
          
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
      }, 500); // Pequeña pausa antes de mostrar el ranking
  });


  socket.on('send_message', (data) => { /* ... igual ... */ });
  socket.on('send_reaction', (data) => { /* ... igual ... */ });
  socket.on("disconnect", () => {});
});

httpServer.listen(PORT, () => { console.log(`✅ Servidor listo en puerto ${PORT}`); });
