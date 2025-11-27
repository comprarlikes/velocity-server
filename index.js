const { Server } = require("socket.io");
// 1. Usamos el módulo HTTP nativo (Necesario para Render/Heroku)
const httpServer = require("http").createServer(); 

const io = new Server(httpServer, {
  cors: { origin: "*" } // Permitir conexiones desde cualquier móvil/web
});

// 2. CONFIGURACIÓN DEL PUERTO (Vital para la Nube)
// Si estamos en la nube, usa su puerto. Si estamos en casa, usa el 3000.
const PORT = process.env.PORT || 3000;

console.log(`🔥 Servidor VELOCITY: Arrancando sistema en puerto ${PORT}...`);

// --- CONFIGURACIÓN DEL JUEGO ---
const ALPHABET = "ABCDEFGHIJLMNOPRSTUV";
const ALL_CATEGORIES = [
    "NOMBRE", "COLOR", "FRUTA", "PAÍS", "ANIMAL", "MARCA", 
    "COMIDA", "OBJETO", "PROFESIÓN", "PELÍCULA", "SERIE", 
    "FAMOSO", "VERBO", "DEPORTE", "CUERPO", "ROPA", "TRANSPORTE",
    "VIDEOJUEGO", "CANTANTE", "CIUDAD", "ASIGNATURA"
];

// Estado global de las salas
let rooms = {}; 

// Generar código de sala aleatorio (4 letras/números)
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// Iniciar nueva ronda en una sala específica
function startNewRound(roomCode) {
    if (!rooms[roomCode]) return;

    // Elegir letra al azar
    rooms[roomCode].letter = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    
    // Elegir 5 categorías al azar
    let shuffled = ALL_CATEGORIES.sort(() => 0.5 - Math.random());
    rooms[roomCode].categories = shuffled.slice(0, 5);
    
    rooms[roomCode].isPanic = false;
    
    return rooms[roomCode];
}

io.on("connection", (socket) => {
  console.log("Nuevo jugador conectado:", socket.id);

  // --- 1. CREAR SALA (HOST) ---
  socket.on('create_room', (data) => {
      const code = generateRoomCode();
      const playerName = data.name;

      socket.join(code);

      // Crear la estructura de la sala
      rooms[code] = {
          players: {},
          admin: socket.id, // El creador es el administrador
          status: 'LOBBY',
          letter: "",
          categories: [],
          isPanic: false
      };

      // Añadir al host a la lista
      rooms[code].players[socket.id] = { name: playerName, score: 0, id: socket.id };
      
      console.log(`🏠 Sala creada: ${code} por ${playerName}`);

      // Confirmar al cliente
      socket.emit('room_joined', { 
          code: code,
          isHost: true,
          players: Object.values(rooms[code].players)
      });
  });

  // --- 2. UNIRSE A SALA (INVITADO) ---
  socket.on('join_room', (data) => {
      const code = data.code.toUpperCase(); // Asegurar mayúsculas
      const playerName = data.name;

      // Validación: ¿Existe la sala?
      if (!rooms[code]) {
          socket.emit('error_msg', 'La sala no existe o ha cerrado.');
          return;
      }

      socket.join(code);
      rooms[code].players[socket.id] = { name: playerName, score: 0, id: socket.id };

      console.log(`👤 ${playerName} se unió a la sala ${code}`);

      // Confirmar al cliente
      socket.emit('room_joined', { 
          code: code,
          isHost: false, // No es admin
          players: Object.values(rooms[code].players)
      });

      // Avisar a TODOS en la sala para actualizar la lista del lobby
      io.to(code).emit('update_players', Object.values(rooms[code].players));
  });

  // --- 3. INICIAR PARTIDA (Solo Host) ---
  socket.on('start_game', (data) => {
      const code = data.roomCode;
      const room = rooms[code];

      // Seguridad: Solo el admin puede iniciar
      if (!room || room.admin !== socket.id) return;

      console.log(`🚀 Iniciando partida en sala ${code}`);
      room.status = 'PLAYING';
      
      startNewRound(code);

      // Enviar señal de inicio a todos
      io.to(code).emit('round_start', { 
          letter: room.letter, 
          categories: room.categories 
      });
  });

  // --- 4. BOTÓN STOP (PÁNICO) ---
  socket.on('stop_pressed', (data) => {
      const code = data.roomCode; 
      const room = rooms[code];

      if (!room || room.isPanic) return; // Si ya hay pánico, ignorar

      console.log(`🚨 ¡STOP en sala ${code}!`);
      room.isPanic = true;

      // Avisar a todos para activar modo rojo y cuenta atrás
      io.to(code).emit('panic_mode', {});

      // Esperar 8 segundos (tiempo para escribir + lag)
      setTimeout(() => {
          // CALCULAR RANKING
          let ranking = [];
          
          for (let pid in room.players) {
              ranking.push({ 
                  name: room.players[pid].name, 
                  score: room.players[pid].score 
              });
              // Resetear puntuación para la siguiente ronda
              room.players[pid].score = 0; 
          }

          // Ordenar por puntuación (Mayor a menor)
          ranking.sort((a, b) => b.score - a.score);
          
          // Enviar resultados
          io.to(code).emit('game_ranking', ranking);

          // Pausa para ver resultados y luego NUEVA RONDA AUTOMÁTICA
          setTimeout(() => {
              room.isPanic = false;
              startNewRound(code);
              
              console.log(`🔄 Nueva ronda en sala ${code}: Letra ${room.letter}`);
              
              io.to(code).emit('round_start', { 
                  letter: room.letter, 
                  categories: room.categories 
              });
          }, 5000); // 5 segundos viendo el ranking

      }, 8000); // 8 segundos de pánico
  });

  // --- 5. RECIBIR Y CORREGIR PALABRAS ---
  socket.on('submit_words', (data) => {
      const code = data.roomCode;
      const room = rooms[code];
      const misPalabras = data.words;

      if (!room || !room.players[socket.id]) return;

      let score = 0;
      // Recorremos las palabras recibidas
      for (const [categoria, palabra] of Object.entries(misPalabras)) {
          // REGLA: No vacía Y empieza por la letra correcta
          if (palabra && palabra.length > 0 && palabra[0].toUpperCase() === room.letter) {
              score += 100;
          }
      }
      // Guardamos la nota en el servidor
      room.players[socket.id].score = score;
  });

  // --- 6. CHAT (SISTEMA DE MENSAJERÍA) ---
  socket.on('send_message', (data) => {
      const code = data.roomCode;
      // Reenviamos el mensaje a TODOS en la sala
      io.to(code).emit('receive_message', {
          sender: data.playerName,
          text: data.message
      });
  });

  // --- 7. REACCIONES (EMOJIS VOLADORES) ---
  socket.on('send_reaction', (data) => {
      const code = data.roomCode;
      // Reenviamos el emoji a TODOS
      io.to(code).emit('receive_reaction', {
          emoji: data.emoji
      });
  });

  // --- DESCONEXIÓN ---
  socket.on("disconnect", () => {
      // (Opcional) Aquí podrías borrar al jugador de la sala
      // Pero por ahora lo dejamos simple para evitar errores si se reconecta rápido
      console.log("Jugador desconectado:", socket.id);
  });
});

// 3. ARRANCAR EL SERVIDOR (OJO: Usamos httpServer, no io)
httpServer.listen(PORT, () => {
    console.log(`✅ Servidor escuchando en el puerto ${PORT}`);
});