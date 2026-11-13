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

const U = (id, username, house, points, flight_xp, role, is_admin, look, is_npc = false, pass = '', loc = 'comedor', npc_trait = '') => ({
  id, username, house, points, flight_xp, role, is_admin,
  is_npc: !!is_npc,
  pass: pass || '',
  loc: loc || 'comedor',
  locSlot: '',
  npc_trait: npc_trait || 'Aprendiz prometedor',
  npc_path: null,
  npc_quidditch: false,
  npc_decided: false,
  npc_trials: 0,
  look,
  created_at: id
});

const BASE_NPCS = [
  U(101, 'Aldebarán V.', 'gryffindor', 40, 0, 'student', false, { skin: 1, hair: 0, style: 'corto', eyes: 0 }, true, '', 'gryffindor', 'Valiente pero indeciso entre volar o liderar'),
  U(102, 'Matilde S.', 'gryffindor', 35, 0, 'student', false, { skin: 0, hair: 4, style: 'largo', eyes: 2 }, true, '', 'patio', 'Reflejos rápidos; sueña con probarse en el aire'),
  U(103, 'Gael T.', 'gryffindor', 30, 0, 'student', false, { skin: 2, hair: 1, style: 'rizado', eyes: 0 }, true, '', 'comedor', 'Especialista en encantamientos defensivos'),
  U(104, 'Lyra M.', 'ravenclaw', 45, 0, 'student', false, { skin: 0, hair: 5, style: 'largo', eyes: 4 }, true, '', 'biblioteca', 'Mente brillante buscando aplicar su estrategia'),
  U(105, 'Caspian R.', 'ravenclaw', 35, 0, 'student', false, { skin: 1, hair: 1, style: 'corto', eyes: 1 }, true, '', 'astronomia', 'Observador de estrellas con gran vista para buscar'),
  U(106, 'Emilia C.', 'ravenclaw', 30, 0, 'student', false, { skin: 0, hair: 3, style: 'rizado', eyes: 1 }, true, '', 'ravenclaw', 'Creativa en pociones y acertijos antiguos'),
  U(107, 'Seraphina K.', 'slytherin', 45, 0, 'student', false, { skin: 0, hair: 0, style: 'largo', eyes: 2 }, true, '', 'mazmorras', 'Ambiciosa; busca destacar en su casa'),
  U(108, 'Dorian B.', 'slytherin', 35, 0, 'student', false, { skin: 1, hair: 3, style: 'corto', eyes: 3 }, true, '', 'slytherin', 'Calculador y veloz bajo presión'),
  U(109, 'Antonia V.', 'slytherin', 30, 0, 'student', false, { skin: 2, hair: 0, style: 'largo', eyes: 0 }, true, '', 'terrenos', 'Intrépida en duelos y artes mágicas'),
  U(110, 'Benjamín L.', 'hufflepuff', 40, 0, 'student', false, { skin: 1, hair: 2, style: 'rizado', eyes: 0 }, true, '', 'invernaderos', 'Leal y protector con sus compañeros'),
  U(111, 'Isolde F.', 'hufflepuff', 35, 0, 'student', false, { skin: 0, hair: 3, style: 'largo', eyes: 2 }, true, '', 'cabana', 'Amante de las criaturas y el vuelo libre'),
  U(112, 'Martín O.', 'hufflepuff', 30, 0, 'student', false, { skin: 3, hair: 0, style: 'corto', eyes: 0 }, true, '', 'comedor', 'Constante y tenaz en cada prueba')
];

const defaultDb = {
  users: BASE_NPCS,
  houses: [
    { id: 'gryffindor', points: 105 },
    { id: 'ravenclaw', points: 110 },
    { id: 'slytherin', points: 110 },
    { id: 'hufflepuff', points: 105 }
  ],
  log: [
    { u: '🤖 Lyra M.', h: 'ravenclaw', a: 'Astronomía', p: 8, x: 0 },
    { u: '🤖 Aldebarán V.', h: 'gryffindor', a: 'Encantamientos', p: 10, x: 0 },
    { u: '🤖 Seraphina K.', h: 'slytherin', a: 'Pociones', p: 10, x: 0 }
  ],
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
  npcAi: true,
  chat: [
    { id: 1, u: '🤖 Aldebarán V.', h: 'gryffindor', role: 'student', ch: 'global', text: '¡Bienvenidos al Castillo! Estamos preparándonos para las pruebas de cada casa.', time: '20:40' },
    { id: 2, u: '🤖 Lyra M.', h: 'ravenclaw', role: 'student', ch: 'global', text: '¿Alguien me acompaña en una prueba para decidir si postulo a Quidditch o a Prefecta?', time: '20:42' }
  ],
  matches: [],
  cooldowns: {},
  missions: {}
};

function sanitizeState(state) {
  if (!state || !Array.isArray(state.users)) return { ...defaultDb };
  const legacyNames = ['carla r.', 'vicente d.', 'matilde s.', 'joaquín p.', 'antonia v.', 'benjamín l.'];
  state.users = state.users.filter(u => {
    if (u.id <= 6 && !u.pass && !u.is_npc && legacyNames.includes((u.username || '').toLowerCase())) return false;
    return true;
  });
  if (!state.users.some(u => u.is_npc)) {
    BASE_NPCS.forEach(npc => {
      if (!state.users.some(u => u.id === npc.id)) state.users.push({ ...npc });
    });
  }
  state.users.forEach(u => {
    if (u.is_npc) {
      const baseRef = BASE_NPCS.find(b => b.id === u.id);
      if (!u.npc_trait && baseRef) u.npc_trait = baseRef.npc_trait;
      if (!u.npc_decided) {
        u.flight_xp = 0;
        u.npc_quidditch = false;
        u.role = 'student';
        u.npc_path = null;
      }
    }
  });
  if (Array.isArray(state.apps)) {
    state.apps = state.apps.filter(a => {
      const usr = state.users.find(x => x.id === a.user_id);
      if (usr && usr.is_npc && !usr.npc_decided) return false;
      return true;
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
