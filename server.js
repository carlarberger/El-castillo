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

const SERVER_ACTS = [
  { key: 'pociones', name: 'Pociones', points: 5, room: 'mazmorras' },
  { key: 'encantamientos', name: 'Encantamientos', points: 5, room: 'encantamientos' },
  { key: 'herbologia', name: 'Herbología', points: 5, room: 'invernaderos' },
  { key: 'defensa', name: 'Defensa contra las Artes Oscuras', points: 5, room: 'defensa' },
  { key: 'astronomia', name: 'Astronomía', points: 4, room: 'astronomia' },
  { key: 'runas', name: 'Runas Antiguas', points: 4, room: 'historia' }
];

const SERVER_NPC_LINES = [
  '¡Vamos con todo por la Copa de las Casas este mes!',
  '¿Alguien viene a practicar encantamientos antes de la cena?',
  'Acabo de ver al Troll en las mazmorras, ¡tengan cuidado!',
  '¡Recuerden completar sus 3 clases para el bono de la Misión Diaria!',
  'Estudiando runas antiguas en la biblioteca, qué glifos tan complejos.',
  '¡Qué buena música hay hoy en el Gran Comedor!'
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

// Recalcula siempre los puntos de cada casa como la suma real de todos sus miembros (jugadores + bots NPC) + victorias de Quidditch
function reconcileHousePoints(state) {
  if (!state || !Array.isArray(state.houses) || !Array.isArray(state.users)) return;
  const matchWins = { gryffindor: 0, ravenclaw: 0, slytherin: 0, hufflepuff: 0 };
  if (Array.isArray(state.matches)) {
    state.matches.forEach(m => {
      if (m.status === 'finished' && m.winner && matchWins[m.winner] !== undefined) {
        matchWins[m.winner] += 50;
      }
    });
  }
  state.houses.forEach(h => {
    const sum = state.users
      .filter(u => u.house === h.id)
      .reduce((acc, u) => acc + (Number(u.points) || 0), 0);
    h.points = sum + (matchWins[h.id] || 0);
  });
}

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
  reconcileHousePoints(state);
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
  memoryState = fixedState;
  return fixedState;
}

async function saveState(newState) {
  const { _id, ...stateToSave } = newState;
  reconcileHousePoints(stateToSave);
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
          db: memoryState,
          reason: data.reason || null
        });
      }
    });
  } catch (err) {
    console.error('Error en la conexión:', err);
  }
});

// Motor autónomo en el servidor: cada 25 segundos un bot NPC entrena, suma puntos a sí mismo y a su casa, y se guarda en MongoDB/db.json
setInterval(async () => {
  try {
    const state = await loadState();
    if (!state.npcAi) return;
    const npcs = state.users.filter(u => u.is_npc && u.house);
    if (!npcs.length) return;

    const npc = npcs[Math.floor(Math.random() * npcs.length)];
    const act = SERVER_ACTS[Math.floor(Math.random() * SERVER_ACTS.length)];
    const pts = act.points;

    npc.points = (Number(npc.points) || 0) + pts;
    npc.loc = act.room;

    if (npc.npc_quidditch && Math.random() < 0.35) {
      npc.flight_xp = (Number(npc.flight_xp) || 0) + 2;
    }

    state.log = state.log || [];
    state.log.unshift({ u: '🤖 ' + npc.username, h: npc.house, a: act.name, p: pts, x: 0 });
    state.log.length = Math.min(state.log.length, 15);

    if (Math.random() < 0.3) {
      const line = SERVER_NPC_LINES[Math.floor(Math.random() * SERVER_NPC_LINES.length)];
      state.chat = state.chat || [];
      state.chat.push({
        id: Date.now(),
        u: '🤖 ' + npc.username,
        h: npc.house,
        role: npc.role || 'student',
        ch: 'global',
        text: line,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
      if (state.chat.length > 60) state.chat.shift();
    }

    await saveState(state);
    io.emit('sync_db', { db: memoryState, reason: null });
  } catch (err) {
    console.error('Error en turno autónomo de bot:', err.message);
  }
}, 25000);

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
