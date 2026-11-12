const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

// Redirigir la raíz a "El Castillo.html" si no se ha renombrado a "index.html"
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  const castilloPath = path.join(__dirname, 'El Castillo.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else if (fs.existsSync(castilloPath)) {
    res.sendFile(castilloPath);
  } else {
    res.status(404).send('No se encontró El Castillo.html ni index.html en la carpeta.');
  }
});

// =====================================================================
// BASE DE DATOS PERSISTENTE (db.json)
// =====================================================================
const DB_FILE = path.join(__dirname, 'db.json');

const U = (id, username, house, points, flight_xp, role, is_admin) => ({
  id, username, house, points, flight_xp, role, is_admin, created_at: id
});

const defaultDb = {
  users: [
    U(1, 'Carla R.', 'ravenclaw', 90, 35, 'student', true),
    U(2, 'Vicente D.', 'ravenclaw', 70, 20, 'student', false),
    U(3, 'Matilde S.', 'gryffindor', 85, 30, 'student', false),
    U(4, 'Joaquín P.', 'gryffindor', 95, 10, 'prefect', false),
    U(5, 'Antonia V.', 'slytherin', 88, 25, 'student', false),
    U(6, 'Benjamín L.', 'hufflepuff', 82, 25, 'prefect', false)
  ],
  houses: [
    { id: 'gryffindor', points: 240 },
    { id: 'ravenclaw', points: 224 },
    { id: 'slytherin', points: 215 },
    { id: 'hufflepuff', points: 195 }
  ],
  log: [],
  apps: [],
  votes: [],
  events: [
    { name: 'Copa Inaugural del Trimestre', desc: 'Todas las clases y partidos otorgan puntos dobles.', mult: 2, active: true }
  ],
  period: 'application',
  clockMode: 'real',
  mockTime: null,
  mockDay: null,
  free: false,
  chat: [],
  matches: [],
  cooldowns: {},
  missions: {}
};

let db = defaultDb;
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error('Error cargando db.json, usando base por defecto');
  }
}

let saveTimeout;
function saveDb() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }, 500);
}

// =====================================================================
// SOCKET.IO (MULTIJUGADOR EN TIEMPO REAL)
// =====================================================================
io.on('connection', (socket) => {
  // Enviar estado inicial al conectarse
  socket.emit('init_db', db);

  // Recibir cambios de cualquier jugador, guardarlos y transmitirlos a los demás
  socket.on('sync_db', (data) => {
    if (data && data.db) {
      db = data.db;
      saveDb();
      socket.broadcast.emit('sync_db', {
        db: db,
        reason: data.reason || null
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🏰 El Castillo Multijugador corriendo en http://localhost:${PORT}`);
});
