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

const U = (id, username, house, points, flight_xp, role, is_admin, look, is_npc = false, pass = '', loc = 'comedor') => ({
  id, username, house, points, flight_xp, role, is_admin,
  is_npc: !!is_npc,
  pass: pass || '',
  loc: loc || 'comedor',
  locSlot: '',
  look,
  created_at: id
});

const BASE_NPCS = [
  U(101, 'Aldebarán V.', 'gryffindor', 85, 30, 'prefect', false, { skin: 1, hair: 0, style: 'corto', eyes: 0 }, true, '', 'gryffindor'),
  U(102, 'Matilde S.', 'gryffindor', 75, 25, 'student', false, { skin: 0, hair: 4, style: 'largo', eyes: 2 }, true, '', 'quidditch'),
  U(103, 'Gael T.', 'gryffindor', 60, 20, 'student', false, { skin: 2, hair: 1, style: 'rizado', eyes: 0 }, true, '', 'patio'),
  U(104, 'Lyra M.', 'ravenclaw', 90, 35, 'prefect', false, { skin: 0, hair: 5, style: 'largo', eyes: 4 }, true, '', 'biblioteca'),
  U(105, 'Caspian R.', 'ravenclaw', 72, 20, 'student', false, { skin: 1, hair: 1, style: 'corto', eyes: 1 }, true, '', 'astronomia'),
  U(106, 'Emilia C.', 'ravenclaw', 64, 15, 'student', false, { skin: 0, hair: 3, style: 'rizado', eyes: 1 }, true, '', 'ravenclaw'),
  U(107, 'Seraphina K.', 'slytherin', 88, 28, 'prefect', false, { skin: 0, hair: 0, style: 'largo', eyes: 2 }, true, '', 'mazmorras'),
  U(108, 'Dorian B.', 'slytherin', 74, 22, 'student', false, { skin: 1, hair: 3, style: 'corto', eyes: 3 }, true, '', 'slytherin'),
  U(109, 'Antonia V.', 'slytherin', 58, 15, 'student', false, { skin: 2, hair: 0, style: 'largo', eyes: 0 }, true, '', 'terrenos'),
  U(110, 'Benjamín L.', 'hufflepuff', 82, 25, 'prefect', false, { skin: 1, hair: 2, style: 'rizado', eyes: 0 }, true, '', 'invernaderos'),
  U(111, 'Isolde F.', 'hufflepuff', 68, 18, 'student', false, { skin: 0, hair: 3, style: 'largo', eyes: 2 }, true, '', 'cabana'),
  U(112, 'Martín O.', 'hufflepuff', 55, 12, 'student', false, { skin: 3, hair: 0, style: 'corto', eyes: 0 }, true, '', 'comedor')
];

const defaultDb = {
  users: BASE_NPCS,
  houses: [
    { id: 'gryffindor', points: 220 },
    { id: 'ravenclaw', points: 226 },
    { id: 'slytherin', points: 220 },
    { id: 'hufflepuff', points: 205 }
  ],
  log: [
    { u: '🤖 Lyra M.', h: 'ravenclaw', a: 'Astronomía', p: 16, x: 0 },
    { u: '🤖 Aldebarán V.', h: 'gryffindor', a: 'Clase de Vuelo', p: 20, x: 5 },
    { u: '🤖 Seraphina K.', h: 'slytherin', a: 'Pociones', p: 20, x: 0 }
  ],
  apps: [
    { id: 1, user_id: 104, house: 'ravenclaw', traits: ['Sabiduría', 'Liderazgo', 'Justicia'], pitch: 'Guiaré a Ravenclaw con ingenio y estrategia.', votes: 1, status: 'pending' },
    { id: 2, user_id: 101, house: 'gryffindor', traits: ['Valentía', 'Lealtad', 'Responsabilidad'], pitch: 'Defenderé el honor de Gryffindor en cada clase.', votes: 1, status: 'pending' },
    { id: 3, user_id: 107, house: 'slytherin', traits: ['Astucia', 'Liderazgo', 'Sabiduría'], pitch: 'La excelencia llevará a Slytherin a ganar la Copa.', votes: 1, status: 'pending' }
  ],
  votes: [],
  events: [
    { name: 'Copa Inaugural del Trimestre', desc: 'Todas las clases y partidos otorgan puntos dobles.', mult: 2, active: true }
  ],
  period: 'application',
  clockMode: 'real',
  mockTime: null,
  mockDay: null,
  free: false,
  npcAi: true,
  chat: [
    { id: 1, u: '🤖 Aldebarán V.', h: 'gryffindor', role: 'prefect', ch: 'global', text: '¡Bienvenidos al Castillo! Creen su personaje con contraseña para competir.', time: '20:40' },
    { id: 2, u: '🤖 Lyra M.', h: 'ravenclaw', role: 'prefect', ch: 'global', text: 'Los alumnos NPC ya estamos entrenando en las aulas y en el campo de Quidditch.', time: '20:42' }
  ],
  matches: [],
  cooldowns: {},
  missions: {}
};

function sanitizeState(state) {
  if (!state || !Array.isArray(state.users)) return { ...defaultDb };
  const legacyNames = ['carla r.', 'vicente d.', 'matilde s.', 'joaquín p.', 'antonia v.', 'benjamín l.'];
  // Eliminar los antiguos personajes por defecto sin contraseña (IDs 1..6)
  state.users = state.users.filter(u => {
    if (u.id <= 6 && !u.pass && !u.is_npc && legacyNames.includes((u.username || '').toLowerCase())) return false;
    return true;
  });
  // Si aún no están los NPCs base, agregarlos
  if (!state.users.some(u => u.is_npc)) {
    BASE_NPCS.forEach(npc => {
      if (!state.users.some(u => u.id === npc.id)) state.users.push({ ...npc });
    });
  }
  if (typeof state.npcAi === 'undefined') state.npcAi = true;
  return state;
}

const DB_FILE = path.join(__dirname, 'db.json');
let memoryState = sanitizeState(defaultDb);
if (fs.existsSync(DB_FILE)) {
  try {
    memoryState = sanitizeState(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
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
  const fixedState = sanitizeState(cleanState);
  return fixedState;
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
        if (Array.isArray(data.db.users) && data.db.users.length > 200) {
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
