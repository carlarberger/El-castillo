const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  const castilloPath = path.join(__dirname, 'El Castillo.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else if (fs.existsSync(castilloPath)) res.sendFile(castilloPath);
  else res.status(404).send('No se encontró el archivo del juego.');
});

const uri = process.env.MONGODB_URI;
let client = null;
let db = null;

const U = (id, username, house, points, flight_xp, role, is_admin) => ({
  id, username, house, points, flight_xp, role, is_admin, created_at: id
});

const defaultDb = {
  users: [
    U(1, 'Carla R.', 'ravenclaw', 90, 35, 'student', false),
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

// Respaldo local en memoria/archivo si no hay MONGODB_URI configurado en local
const DB_FILE = path.join(__dirname, 'db.json');
let memoryState = defaultDb;
if (fs.existsSync(DB_FILE)) {
  try {
    memoryState = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error('Error leyendo db.json local:', e);
  }
}

async function loadState() {
  if (!db) return memoryState;
  const collection = db.collection('gameState');
  let state = await collection.findOne({ _id: 'global' });
  if (!state) {
    await collection.insertOne({ _id: 'global', ...defaultDb });
    return { ...defaultDb };
  }
  const { _id, ...cleanState } = state;
  return cleanState;
}

async function saveState(newState) {
  const { _id, ...stateToSave } = newState;
  memoryState = stateToSave;
  if (!db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(stateToSave, null, 2));
    return;
  }
  const collection = db.collection('gameState');
  await collection.updateOne({ _id: 'global' }, { $set: stateToSave }, { upsert: true });
}

io.on('connection', async (socket) => {
  try {
    const currentState = await loadState();
    socket.emit('init_db', currentState);

    socket.on('sync_db', async (data) => {
      if (data && data.db) {
        if (Array.isArray(data.db.users) && data.db.users.length > 150) {
          console.log('⚠️ Intento de creación masiva de usuarios bloqueado.');
          return;
        }

        await saveState(data.db);

        socket.broadcast.emit('sync_db', {
          db: data.db,
          reason: data.reason || null
        });
      }
    });
  } catch (err) {
    console.error('Error en la conexión:', err);
  }
});

async function startServer() {
  if (uri) {
    try {
      client = new MongoClient(uri, {
        serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
      });
      await client.connect();
      db = client.db('elcastillo');
      console.log('✅ Conectado a MongoDB Atlas');
    } catch (err) {
      console.error('❌ Error al conectar a MongoDB, usando respaldo local db.json:', err.message);
    }
  } else {
    console.log('⚠️ Variable MONGODB_URI no detectada: funcionando en modo local con db.json.');
  }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`🏰 Servidor en http://localhost:${PORT}`));
}

startServer();
