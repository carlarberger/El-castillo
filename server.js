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

const U = (id, username, house, points, flight_xp, role, is_admin, look, is_npc = false, pass = '', loc = 'comedor', npc_trait = '', is_canon = false, yearOffset = 0) => ({
  id, username, house, points, flight_xp, role, is_admin,
  is_npc: !!is_npc,
  is_canon: !!is_canon,
  pass: pass || '',
  loc: loc || 'comedor',
  locSlot: '',
  npc_trait: npc_trait || 'Alumno del castillo',
  npc_path: null,
  npc_quidditch: false,
  npc_decided: false,
  npc_trials: 0,
  animagus: null,
  yearOffset: Number(yearOffset) || 0,
  look,
  created_at: id
});

const BASE_NPCS = [
  U(201, 'Harry Potter', 'gryffindor', 55, 0, 'student', false, { skin: 0, hair: 0, style: 'corto', eyes: 2 }, true, '', 'gryffindor', 'Mismo año que tú · Reflejos innatos para el vuelo y DCAO', true, 0),
  U(202, 'Hermione Granger', 'gryffindor', 65, 0, 'student', false, { skin: 0, hair: 1, style: 'rizado', eyes: 0 }, true, '', 'biblioteca', 'Mismo año que tú · La bruja más brillante de su generación', true, 0),
  U(203, 'Ron Weasley', 'gryffindor', 45, 0, 'student', false, { skin: 0, hair: 4, style: 'corto', eyes: 1 }, true, '', 'comedor', 'Mismo año que tú · Estratega de ajedrez mágico y amigo leal', true, 0),
  U(204, 'Ginny Weasley', 'gryffindor', 0, 0, 'student', false, { skin: 0, hair: 4, style: 'largo', eyes: 0 }, true, '', 'gryffindor', '1 año menor que Harry · Entra a 1.º curso a partir del Año 2', true, -1),
  U(205, 'Neville Longbottom', 'gryffindor', 42, 0, 'student', false, { skin: 0, hair: 1, style: 'corto', eyes: 0 }, true, '', 'invernaderos', 'Mismo año que tú · Prodigio en Herbología con gran valentía', true, 0),
  U(214, 'Fred Weasley', 'gryffindor', 50, 0, 'student', false, { skin: 0, hair: 4, style: 'corto', eyes: 0 }, true, '', 'patio', '2 años mayor · Ingenioso bromista y potente Golpeador', true, 2),
  U(215, 'George Weasley', 'gryffindor', 50, 0, 'student', false, { skin: 0, hair: 4, style: 'corto', eyes: 0 }, true, '', 'patio', '2 años mayor · Maestro de pasadizos secretos y vuelo', true, 2),
  U(216, 'Percy Weasley', 'gryffindor', 54, 0, 'student', false, { skin: 0, hair: 4, style: 'corto', eyes: 1 }, true, '', 'biblioteca', '4 años mayor · Estricto con el reglamento y aspirante a Prefecto', true, 4),
  U(217, 'Oliver Wood', 'gryffindor', 56, 0, 'student', false, { skin: 1, hair: 1, style: 'corto', eyes: 0 }, true, '', 'quidditch', '4 años mayor · Apasionado estratega de Quidditch', true, 4),
  U(206, 'Luna Lovegood', 'ravenclaw', 0, 0, 'student', false, { skin: 0, hair: 3, style: 'largo', eyes: 1 }, true, '', 'ravenclaw', '1 año menor que Harry · Entra a 1.º curso a partir del Año 2', true, -1),
  U(207, 'Cho Chang', 'ravenclaw', 48, 0, 'student', false, { skin: 1, hair: 0, style: 'largo', eyes: 0 }, true, '', 'astronomia', '1 año mayor · Ágil en el aire y leal compañera de Ravenclaw', true, 1),
  U(208, 'Draco Malfoy', 'slytherin', 58, 0, 'student', false, { skin: 0, hair: 3, style: 'corto', eyes: 3 }, true, '', 'mazmorras', 'Mismo año que tú · Ambicioso y competitivo en Slytherin', true, 0),
  U(209, 'Pansy Parkinson', 'slytherin', 44, 0, 'student', false, { skin: 0, hair: 0, style: 'corto', eyes: 0 }, true, '', 'slytherin', 'Mismo año que tú · Influyente en la sala común de Slytherin', true, 0),
  U(210, 'Blaise Zabini', 'slytherin', 46, 0, 'student', false, { skin: 3, hair: 0, style: 'corto', eyes: 0 }, true, '', 'mazmorras', 'Mismo año que tú · Calculador y talentoso en Pociones y Duelos', true, 0),
  U(211, 'Cedric Diggory', 'hufflepuff', 62, 0, 'student', false, { skin: 0, hair: 1, style: 'corto', eyes: 3 }, true, '', 'patio', '2 años mayor · Ejemplar, justo y líder natural de Hufflepuff', true, 2),
  U(212, 'Hannah Abbott', 'hufflepuff', 44, 0, 'student', false, { skin: 0, hair: 3, style: 'rizado', eyes: 0 }, true, '', 'invernaderos', 'Mismo año que tú · Dedicada en Herbología y leal amiga', true, 0),
  U(218, 'Ernie Macmillan', 'hufflepuff', 48, 0, 'student', false, { skin: 0, hair: 3, style: 'corto', eyes: 1 }, true, '', 'biblioteca', 'Mismo año que tú · Pomposo pero sumamente leal y futuro Prefecto de Hufflepuff', true, 0),
  U(213, 'Nymphadora Tonks', 'hufflepuff', 0, 0, 'student', false, { skin: 0, hair: 5, style: 'corto', eyes: 4 }, true, '', 'defensa', '7 años mayor que Harry · Graduada justo antes del Año 1 (Aprendiz de Auror y Metamorfaga)', true, 7),
  U(101, 'Aldebarán V.', 'gryffindor', 40, 0, 'student', false, { skin: 1, hair: 0, style: 'corto', eyes: 0 }, true, '', 'gryffindor', 'Mismo año que tú · Valiente compañero de Gryffindor', false, 0),
  U(104, 'Lyra M.', 'ravenclaw', 45, 0, 'student', false, { skin: 0, hair: 5, style: 'largo', eyes: 4 }, true, '', 'biblioteca', 'Mismo año que tú · Mente brillante de Ravenclaw', false, 0),
  U(107, 'Seraphina K.', 'slytherin', 45, 0, 'student', false, { skin: 0, hair: 0, style: 'largo', eyes: 2 }, true, '', 'mazmorras', '1 año mayor · Ambiciosa estratega de Slytherin', false, 1),
  U(110, 'Benjamín L.', 'hufflepuff', 40, 0, 'student', false, { skin: 1, hair: 2, style: 'rizado', eyes: 0 }, true, '', 'invernaderos', '1 año mayor · Leal protector de Hufflepuff', false, 1)
];

const SERVER_ACTS = [
  { key: 'pociones', name: 'Pociones', points: 5, room: 'mazmorras' },
  { key: 'transformaciones', name: 'Transformaciones', points: 5, room: 'transformaciones' },
  { key: 'encantamientos', name: 'Encantamientos', points: 5, room: 'encantamientos' },
  { key: 'criaturas', name: 'Cuidado de Criaturas Mágicas', points: 5, room: 'cabana' },
  { key: 'herbologia', name: 'Herbología', points: 5, room: 'invernaderos' },
  { key: 'defensa', name: 'Defensa contra las Artes Oscuras', points: 5, room: 'defensa' },
  { key: 'historia', name: 'Historia de la Magia', points: 4, room: 'historia' },
  { key: 'astronomia', name: 'Astronomía', points: 4, room: 'astronomia' },
  { key: 'runas', name: 'Runas Antiguas', points: 4, room: 'biblioteca' }
];

const SERVER_NPC_LINES = [
  '¡Vamos con todo por la Copa de las Casas este mes!',
  '¿Alguien viene a Transformaciones con la profesora McGonagall?',
  'Hagrid nos mostró un Hipogrifo increíble hoy en Cuidado de Criaturas Mágicas.',
  'Casi me quedo dormido en Historia de la Magia con el profesor Binns…',
  '¡Cuidado por la noche! Dicen que se vieron Mortífagos cerca de los terrenos.',
  'Recuerden volver a los dormitorios antes de las 22:00 por el toque de queda.',
  '¡Practicar nuestro hechizo Patronus y la forma Animaga nos salvará en las incursiones!',
  '¿Quién quiere estudiar juntos en la Biblioteca para subir nuestra amistad?'
];

const defaultDb = {
  users: BASE_NPCS,
  houses: [
    { id: 'gryffindor', points: 297 },
    { id: 'ravenclaw', points: 145 },
    { id: 'slytherin', points: 193 },
    { id: 'hufflepuff', points: 200 }
  ],
  log: [
    { u: '🤖 Hermione Granger', h: 'gryffindor', a: 'Transformaciones', p: 10, x: 0 },
    { u: '🤖 Cho Chang', h: 'ravenclaw', a: 'Cuidado de Criaturas Mágicas', p: 10, x: 0 },
    { u: '🤖 Draco Malfoy', h: 'slytherin', a: 'Pociones', p: 10, x: 0 },
    { u: '🤖 Cedric Diggory', h: 'hufflepuff', a: 'Defensa contra las Artes Oscuras', p: 10, x: 0 }
  ],
  apps: [],
  votes: [],
  events: [
    { name: 'Copa Inaugural del Trimestre', desc: 'Todas las clases y partidos otorgan puntos dobles.', mult: 2, active: true }
  ],
  period: 'application',
  schoolYear: 1,
  clockMode: 'real',
  mockTime: null,
  mockDay: null,
  free: false,
  npcAi: true,
  relations: {},
  profAffinity: {},
  raidShield: 100,
  chat: [
    { id: 1, u: '🤖 Hermione Granger', h: 'gryffindor', role: 'student', ch: 'global', text: '¡Recuerden que a las 22:00 comienza el toque de queda y todos debemos estar en los dormitorios de nuestra casa!', time: '20:40' },
    { id: 2, u: '🤖 Cedric Diggory', h: 'hufflepuff', role: 'student', ch: 'global', text: '¡Bienvenidos los de 1.º curso! Los de 3.º los ayudaremos a orientarse por el castillo.', time: '20:42' }
  ],
  matches: [],
  cooldowns: {},
  missions: {}
};

function userYear(state, u) {
  const sy = Math.max(1, Math.min(7, Number(state?.schoolYear) || 1));
  if (!u) return sy;
  const off = typeof u.yearOffset === 'number' ? u.yearOffset : 0;
  const yr = sy + off;
  if (yr <= 0) return 0;
  if (yr > 7) return 8;
  return yr;
}

function isEnrolled(state, u) {
  const yr = userYear(state, u);
  return yr >= 1 && yr <= 7;
}

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
      .filter(u => u.house === h.id && isEnrolled(state, u))
      .reduce((acc, u) => acc + (Number(u.points) || 0), 0);
    h.points = sum + (matchWins[h.id] || 0);
  });
}

function sanitizeState(state) {
  if (!state || !Array.isArray(state.users)) return { ...defaultDb };
  if (!state.schoolYear || state.schoolYear < 1 || state.schoolYear > 7) state.schoolYear = 1;

  const legacyNames = ['carla r.', 'vicente d.', 'matilde s.', 'joaquín p.', 'antonia v.', 'benjamín l.'];
  state.users = state.users.filter(u => {
    if (u.id <= 6 && !u.pass && !u.is_npc && legacyNames.includes((u.username || '').toLowerCase())) return false;
    return true;
  });

  BASE_NPCS.forEach(npc => {
    const existing = state.users.find(u => u.id === npc.id || (u.username || '').toLowerCase() === npc.username.toLowerCase());
    if (!existing) {
      state.users.push({ ...npc });
    } else if (existing.is_npc) {
      if (npc.is_canon) existing.is_canon = true;
      existing.yearOffset = npc.yearOffset;
      existing.npc_trait = npc.npc_trait;
    }
  });

  state.users.forEach(u => {
    if (typeof u.yearOffset !== 'number') u.yearOffset = 0;
    if (u.is_npc && !u.npc_decided) {
      u.flight_xp = 0;
      u.npc_quidditch = false;
      u.role = 'student';
      u.npc_path = null;
    }
    if (u.is_npc && (userYear(state, u) === 0 || (u.yearOffset || 0) >= 7)) {
      u.points = 0;
      u.flight_xp = 0;
      u.npc_quidditch = false;
      u.role = 'student';
      u.npc_decided = false;
      u.npc_path = null;
    }
    if (u.is_npc && isEnrolled(state, u) && (u.points || 0) === 0 && (u.yearOffset || 0) < 0) {
      u.points = 35;
    }
  });

  if (Array.isArray(state.apps)) {
    state.apps = state.apps.filter(a => {
      const usr = state.users.find(x => x.id === a.user_id);
      if (!usr || !isEnrolled(state, usr)) return false;
      if (usr && usr.is_npc && !usr.npc_decided) return false;
      return true;
    });
  }
  if (!state.relations || typeof state.relations !== 'object') state.relations = {};
  if (!state.profAffinity || typeof state.profAffinity !== 'object') state.profAffinity = {};
  if (typeof state.raidShield !== 'number') state.raidShield = 100;
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

        // Anti-cheat básico: bloquear saltos anómalos de puntos en un solo sync
        const oldUsers = memoryState.users || [];
        for (const nu of data.db.users) {
          const ou = oldUsers.find(o => o.id === nu.id);
          if (ou && (Number(nu.points) - Number(ou.points)) > 500) {
            console.log(`⚠️ Sync bloqueado: ${nu.username} saltó ${nu.points - ou.points} pts.`);
            socket.emit('sync_db', { db: memoryState, reason: 'Corrección del servidor (Anti-Cheat)' });
            return;
          }
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

// Motor autónomo en el servidor
setInterval(async () => {
  try {
    const state = await loadState();
    if (!state.npcAi) return;
    const npcs = state.users.filter(u => u.is_npc && u.house && isEnrolled(state, u));
    if (!npcs.length) return;

    const npc = npcs[Math.floor(Math.random() * npcs.length)];
    const act = SERVER_ACTS[Math.floor(Math.random() * SERVER_ACTS.length)];
    const pts = act.points;

    npc.points = (Number(npc.points) || 0) + pts;

    const hour = state.clockMode === 'mock' && state.mockTime ? Number(state.mockTime.split(':')[0]) : new Date().getHours();
    if ((hour >= 22 || hour < 7) && !state.free) {
      npc.loc = npc.house;
    } else {
      npc.loc = act.room;
    }

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
