const { Server } = require("socket.io");
const httpServer = require("http").createServer((req, res) => {
    if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Velocity Server is Online!"); }
}); 
const admin = require('firebase-admin');

// (Firebase init code)
// ...

const io = new Server(httpServer, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN DEL JUEGO ---
const ALPHABET = "ABCDEFGHIJLMNOPRSTUV";
const ALL_CATEGORIES = ["NOMBRE", "COLOR", "FRUTA", "PAÍS", "ANIMAL", "MARCA", "COMIDA", "OBJETO", "PROFESIÓN"];
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
    
    for (let pid in room.players) {
        room.players[pid].score = 0;
    }
}

io.on("connection", (socket) => {
  
  // --- CREAR SALA (LÓGICA ACTUALIZADA) ---
  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      socket.join(code);

      // Usamos las reglas enviadas por el cliente, o valores por defecto si no existen
      rooms[code] = { 
          players: {}, 
          admin: socket.id, 
          status: 'LOBBY',
          currentRound: 0,
          totalRounds: data.rounds || 3, // Default: 3 rondas
          roundTime: data.time || 60,   // Default: 60 segundos
          stopMode: data.stopMode || 'BLITZ', // Default: Modo Blitz
          password: data.password || null,
          letter: "", 
          categories: [], 
          isPanic: false
      };
      
      rooms[code].players[socket.id] = { name: data.playerName, score: 0, wins: 0, id: socket.id };
      
      console.log(`🏠 Sala ${code} creada por ${data.playerName} con ${rooms[code].totalRounds} rondas.`);

      socket.emit('room_joined', { 
          code: code, 
          isHost: true, 
          players: Object.values(rooms[code].players) 
      });
  });

  // ... (El resto de tu index.js sigue igual)
  socket.on('join_room', (data) => { /*...*/ });
  socket.on('start_game', (data) => { /*...*/ });
  socket.on('stop_pressed', (data) => { /*...*/ });
  socket.on('submit_words', (data) => { /*...*/ });
  socket.on('send_message', (data) => { /*...*/ });
  socket.on('send_reaction', (data) => { /*...*/ });
  socket.on("disconnect", () => { /*...*/ });
});

httpServer.listen(PORT, () => {
    console.log(`✅ Servidor escuchando en ${PORT}`);
});
