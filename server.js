// ⬅️ AÑADIDO: carga .env si está instalado (opcional, no rompe si falta)
try { require('dotenv').config(); } catch (e) { /* dotenv no instalado, se ignora */ }

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { MongoClient, ServerApiVersion } = require('mongodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

/* ===== IA GENERATIVA DE NPCs (GROQ) ===== */
const AI_KEY = process.env.GROQ_API_KEY || '';
const AI_URL = 'https://api.groq.com/openai/v1/chat/completions';
// 'llama-3.3-70b-versatile' fue retirado por Groq (responde 404 model_not_found),
// así que el modelo se puede fijar con GROQ_MODEL. Valor por defecto: uno disponible.
const AI_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const AI_ENABLED = !!AI_KEY;

/* ===== CLOUDFLARE WORKERS AI (imágenes de cromos) ===== */
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const CF_AI_ENABLED = !!CF_ACCOUNT_ID && !!CF_API_TOKEN;

async function generateImageWithAI(prompt) {
  if (!CF_AI_ENABLED) {
    throw new Error('Cloudflare AI no está configurado (faltan CLOUDFLARE_ACCOUNT_ID y/o CLOUDFLARE_API_TOKEN).');
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt }),
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Cloudflare AI HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = await res.json();
      const img = json?.result?.image || (Array.isArray(json?.result?.images) ? json.result.images[0] : null) || json?.image;
      if (!img) throw new Error('Respuesta de Cloudflare sin imagen Base64');
      return String(img);
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  } finally {
    clearTimeout(timer);
  }
}

/* ===== CLOUDFLARE R2 (almacenamiento de imágenes de cromos) ===== */
const R2_ENABLED = !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME && process.env.R2_PUBLIC_URL);
const s3Client = R2_ENABLED ? new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
}) : null;

async function uploadImageToR2(base64Image, prefix = 'cromo') {
  if (!R2_ENABLED || !s3Client) {
    throw new Error('Cloudflare R2 no está configurado (faltan variables de entorno).');
  }
  // Limpiar prefijo data: si existe
  const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  const fileName = `${prefix}-${Date.now()}.jpg`;
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: fileName,
    Body: buffer,
    ContentType: 'image/jpeg'
  });
  await s3Client.send(command);
  return `${process.env.R2_PUBLIC_URL}/${fileName}`;
}
const AI_CACHE_MAX = 400;
const AI_TIMEOUT_MS = 12000;

/* ===== CEREBRO DE HOGWARTS: ARCHIVO CANÓNICO (RAG) ===== */
// Se carga una sola vez al arrancar. Si el archivo falta o está corrupto, el juego
// sigue funcionando sin contexto adicional en lugar de caerse.
let LORE = [];
// Catálogos de exploración de la Tanda 2 (se cargan desde lore.json al arrancar).
let PHASE2_CATALOGS = { guidePages: [], arithmancyDoors: [], secretPassages: [], constellations: [], chests: [] };
// Catálogo oficial de varitas de Ollivanders (Tanda 4): maderas y núcleos con su
// lore completo. Se carga desde lore.json; si falta, se usan los valores por defecto.
let WAND_WOOD_CATALOG = [];
let WAND_CORE_CATALOG = [];
try {
  const lorePath = path.join(__dirname, 'lore.json');
  const rawLore = JSON.parse(fs.readFileSync(lorePath, 'utf8'));
  if (Array.isArray(rawLore)) {
    LORE = rawLore
      .filter(e => e && typeof e.info === 'string' && Array.isArray(e.keywords)
        // Las entradas de catálogo (categoría `_...`) alimentan mecánicas de
        // exploración, no el archivo canónico que usa Groq.
        && !String(e.categoria || '').startsWith('_'))
      // Cada entrada declara el año escolar mínimo para conocerla (minYear).
      // Si no lo declara, se asume que es conocimiento básico (Año 1).
      .map(e => ({ ...e, minYear: Math.max(1, Math.min(7, Number(e.minYear) || 1)) }));
    console.log(`📚 Cerebro de Hogwarts cargado: ${LORE.length} entradas canónicas.`);
    // Catálogos de exploración (Tanda 2): páginas, aritmancia, pasadizos,
    // constelaciones y cofres. Se validan aquí y se exponen por socket.
    const catalogOf = (cat, key) => {
      const entry = rawLore.find(e => e && e.categoria === cat);
      return (entry && Array.isArray(entry[key])) ? entry[key] : [];
    };
    PHASE2_CATALOGS = {
      guidePages: catalogOf('_guia_campo', 'guidePages'),
      arithmancyDoors: catalogOf('_arithmancy', 'arithmancyDoors'),
      secretPassages: catalogOf('_pasadizos', 'secretPassages'),
      constellations: catalogOf('_constelaciones', 'constellations'),
      chests: catalogOf('_cofres', 'chests')
    };
    // Catálogo oficial de varitas (Tanda 4): maderas y núcleos con lore.
    WAND_WOOD_CATALOG = catalogOf('_varitas', 'wandWoods');
    WAND_CORE_CATALOG = catalogOf('_varitas', 'wandCores');
    console.log(`🗺️ Catálogos de exploración: ${PHASE2_CATALOGS.guidePages.length} páginas, ${PHASE2_CATALOGS.arithmancyDoors.length} puertas, ${PHASE2_CATALOGS.secretPassages.length} pasadizos, ${PHASE2_CATALOGS.constellations.length} constelaciones, ${PHASE2_CATALOGS.chests.length} cofres.`);
    console.log(`🪄 Catálogo de Ollivanders: ${WAND_WOOD_CATALOG.length} maderas y ${WAND_CORE_CATALOG.length} núcleos.`);
  }
} catch (err) {
  console.error('⚠️ No se pudo cargar lore.json:', err.message);
}

// Normaliza tildes, mayúsculas y espacios para que «Merlín» y «merlin» coincidan.
function normalizeLoreText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LORE_INDEX = LORE.map(entry => ({
  entry,
  keywords: entry.keywords.map(normalizeLoreText).filter(Boolean)
}));

// Normaliza un año escolar a un entero entre 1 y 7.
function clampSchoolYear(value) {
  const year = Number(value);
  if (!Number.isFinite(year)) return 1;
  return Math.max(1, Math.min(7, Math.round(year)));
}

// Devuelve como máximo 3 entradas relevantes para no saturar el prompt de Groq.
// Solo se consideran las entradas cuyo minYear es <= al año actual del castillo:
// así un alumno del Año 1 nunca recibe datos sobre los Horrocruces, la Varita
// de Saúco o cualquier otro hecho posterior.
function getCanonContext(message, currentYear) {
  const text = normalizeLoreText(message);
  if (!text || !LORE_INDEX.length) return '';

  const year = clampSchoolYear(currentYear);

  const matches = [];
  for (const item of LORE_INDEX) {
    // Filtro temporal: los hechos del futuro no existen todavía en el mundo del juego.
    if ((Number(item.entry.minYear) || 1) > year) continue;
    let score = 0;
    for (const keyword of item.keywords) {
      if (!text.includes(keyword)) continue;
      // Las frases completas pesan más que una palabra suelta.
      score += keyword.includes(' ') ? 3 : 1;
    }
    if (score > 0) matches.push({ entry: item.entry, score });
  }

  if (!matches.length) return '';
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 3)
    .map(({ entry }) => `[${entry.categoria}] ${entry.info}`)
    .join('\n\n');
}

// Tres entradas aleatorias sin repetir para el generador de eventos canónicos.
// También respeta la línea temporal: solo usa hechos conocidos en el año actual.
function pickRandomLore(count, currentYear) {
  const year = clampSchoolYear(currentYear);
  const pool = LORE.filter(e => (Number(e.minYear) || 1) <= year);
  if (!pool.length) return [];
  const picks = [];
  while (pool.length && picks.length < count) {
    picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picks;
}

function buildCanonPrompt(context) {
  return `\n\nInformación histórica oficial que DEBES usar: ${context}. Responde basándote en esto.`;
}

// Instrucción de línea temporal que se añade al final del prompt de sistema.
function buildTimelinePrompt(currentYear) {
  const year = clampSchoolYear(currentYear);
  return `\n\nIMPORTANTE: Currently están en el Año ${year} de Hogwarts. No menciones ni des por sabidos eventos que ocurran en años posteriores del canon. Actúa como si el futuro no estuviera escrito.`;
}

// Respaldo local si no hay GROQ_API_KEY: el aviso sigue siendo canónico y visible.
function firstLoreSentence(text) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  const parts = clean.split(/\.\s+/);
  let sentence = parts[0] || clean;
  if (sentence.length < 40 && parts[1]) sentence += '. ' + parts[1];
  return sentence.replace(/[.!?]+$/, '');
}

function buildFallbackCanonEvent(entries) {
  const first = firstLoreSentence(entries[0]?.info);
  const second = firstLoreSentence(entries[1]?.info);
  const tail = second
    ? ` Los retratos murmuran que algo parecido a esto vuelve a despertar: ${second}.`
    : ' Los retratos del castillo se niegan a mirar hacia las sombras.';
  return `Un antiguo eco recorre los pasillos: ${first}.${tail}`;
}

// Prompts de sistema: personalidad fiel al canon, español y respuestas de máximo 2 frases.
const NPC_PERSONAS = {
  'harry potter': `Eres Harry Potter, el chico que sobrevivió, alumno de Gryffindor en Hogwarts. Eres valiente, leal y modesto, algo impulsivo cuando algo es injusto; desconfías de Draco Malfoy y de Slytherin, y aprecias a Ron, Hermione y a Dumbledore. Te encanta el Quidditch y odias las artes oscuras. Habla SIEMPRE en español, con un tono cercano y adolescente, en máximo 2 frases breves. Nunca rompas el canon de Harry Potter, nunca digas que eres una IA ni menciones el mundo real; si te preguntan algo ajeno al mundo mágico, responde con naturalidad dentro del personaje.`,
  'hermione granger': `Eres Hermione Granger, la bruja más brillante de su generación, de Gryffindor. Eres precisa, estudiosa, organizada y algo mandona; citas libros y reglas de Hogwarts, defiendes la justicia y los derechos de los elfos domésticos, y siempre animas a los demás a estudiar. Habla SIEMPRE en español, con vocabulario culto pero cercano, en máximo 2 frases. Nunca rompas el canon de Harry Potter, nunca digas que eres una IA ni menciones el mundo real; mantente siempre dentro del personaje.`,
  'ron weasley': `Eres Ron Weasley, alumno de Gryffindor, el mejor amigo de Harry. Eres divertido, sarcástico y un poco inseguro, muy leal a tu familia y a tus amigos; te encanta comer, el ajedrez mágico y el Quidditch, y te dan miedo las arañas. Habla SIEMPRE en español, con humor y bromas ligeras, en máximo 2 frases. Nunca rompas el canon de Harry Potter, nunca digas que eres una IA ni menciones el mundo real; mantente siempre dentro del personaje.`,
  'draco malfoy': `Eres Draco Malfoy, heredero de los Malfoy y alumno de Slytherin. Eres arrogante, sarcástico y despectivo, presumes de tu linaje y de tu padre Lucius, miras por encima del hombro a los Gryffindor y a los nacidos de muggles, aunque en el fondo eres más cobarde de lo que aparentas. Habla SIEMPRE en español, con tono altivo y frases cortantes, en máximo 2 frases. Nunca rompas el canon de Harry Potter, nunca digas que eres una IA ni menciones el mundo real; mantente siempre dentro del personaje.`,
  'luna lovegood': `Eres Luna Lovegood, alumna de Ravenclaw e hija del director de El Quisquilloso. Eres soñadora, sincera, tranquila y excéntrica; hablas con calma de criaturas improbables como los nargles y los crumple-horned snorkacks, y dices verdades incómodas sin malicia. Habla SIEMPRE en español, con un tono sereno y algo poético, en máximo 2 frases. Nunca rompas el canon de Harry Potter, nunca digas que eres una IA ni menciones el mundo real; mantente siempre dentro del personaje.`,
  'snape': `Eres Severus Snape, profesor de Pociones y jefe de la casa Slytherin en Hogwarts. Eres frío, sarcástico, severo y misterioso; exiges respeto y disciplina, desprecias la imprudencia de los Gryffindor y proteges tus verdaderos sentimientos tras una fachada hostil. Habla SIEMPRE en español, con frases secas y cortantes, en máximo 2 frases. Nunca rompas el canon de Harry Potter, nunca digas que eres una IA ni menciones el mundo real; mantente siempre dentro del personaje.`,
  'dumbledore': `Eres Albus Dumbledore, director de Hogwarts y uno de los magos más poderosos de la historia. Eres sereno, sabio, amable y enigmático; hablas con refranes y preguntas que invitan a pensar, crees en las segundas oportunidades y proteges a tus alumnos con firmeza. Habla SIEMPRE en español, con tono tranquilo y reflexivo, en máximo 2 frases. Nunca rompas el canon de Harry Potter, nunca digas que eres una IA ni menciones el mundo real; mantente siempre dentro del personaje.`
};

// Caché simple en memoria: pregunta normalizada -> respuesta del NPC.
const aiCache = new Map();

function npcPersonaKey(npcId, npcName) {
  if (typeof npcId === 'string' && NPC_PERSONAS[npcId.toLowerCase()]) return npcId.toLowerCase();
  const provided = String(npcName || '').toLowerCase().trim();
  if (NPC_PERSONAS[provided]) return provided;
  const npc = (memoryState?.users || []).find(u => u.id === Number(npcId));
  if (npc) {
    const key = String(npc.username || '').toLowerCase().trim();
    if (NPC_PERSONAS[key]) return key;
  }
  return null;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  perMessageDeflate: true
});

// ⬅️ AÑADIDO: bloquear archivos sensibles ANTES del static
const BLOCKED_PATHS = new Set([
  '/db.json', '/server.js', '/package.json',
  '/package-lock.json', '/.env', '/.gitignore', '/.env.local', '/lore.json'
]);
app.use((req, res, next) => {
  if (BLOCKED_PATHS.has(req.path)) return res.status(403).send('Forbidden');
  next();
});

// ⬅️ AÑADIDO: CORS para el frontend alojado en Cloudflare Pages (u otro origen).
const PAGES_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*pages\.dev$/i;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', (origin && PAGES_ORIGIN.test(origin)) ? origin : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  const index2Path = path.join(__dirname, 'index2.html');
  const castilloPath = path.join(__dirname, 'El Castillo.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else if (fs.existsSync(index2Path)) res.sendFile(index2Path);
  else if (fs.existsSync(castilloPath)) res.sendFile(castilloPath);
  else res.status(404).send('No se encontró el archivo del juego.');
});

// ⬅️ AÑADIDO: health-check para Render/Railway/Fly/UptimeRobot
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    mongo: !!db,
    users: memoryState?.users?.length || 0,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/generate-cromo', async (req, res) => {
  try {
    const cromoName = String((req.body && req.body.cromoName) || '').trim().slice(0, 80);
    const style = String((req.body && req.body.style) || 'retrato de fantasía, estilo cartoon').trim().slice(0, 200);
    if (!cromoName) return res.status(400).json({ ok: false, error: 'Falta el nombre del cromo.' });
    const prompt = `${cromoName}, ${style}, cromo de rana de chocolate Harry Potter, portrait`;
    const base64Image = await generateImageWithAI(prompt);
    const image = await uploadImageToR2(base64Image);
    res.json({ ok: true, image });
  } catch (err) {
    console.error('Error generando cromo (HTTP):', err.message);
    const msg = /no está configurado|no configurado/i.test(err.message)
      ? 'La generación de imágenes no está configurada en el servidor.'
      : 'No se pudo generar el retrato. Intenta de nuevo.';
    res.status(500).json({ ok: false, error: msg, detail: err.message });
  }
});

// Patronus / Animago: genera un retrato con IA (Flux Schnell) y lo sube a R2.
// Cachea por (tipo, forma, género) en db.spiritCache para no repetir generaciones.
app.post('/api/generate-spirit', async (req, res) => {
  try {
    const type = String((req.body && req.body.type) || '').trim().toLowerCase();
    const formName = String((req.body && req.body.formName) || '').trim().slice(0, 80);
    const formId = slugify((req.body && req.body.formId) || formName);
    const gender = normGender(String((req.body && req.body.gender) || '').trim().toLowerCase());
    if (type !== 'patronus' && type !== 'animagus') {
      return res.status(400).json({ ok: false, error: 'Tipo inválido: debe ser "patronus" o "animagus".' });
    }
    if (!formName) return res.status(400).json({ ok: false, error: 'Falta el nombre de la forma.' });

    const state = await loadState();
    if (!state.spiritCache || typeof state.spiritCache !== 'object') state.spiritCache = {};
    const cacheKey = `${type}_${formId}_${gender}`;
    if (state.spiritCache[cacheKey]) {
      return res.json({ ok: true, image: state.spiritCache[cacheKey], type, cached: true });
    }

    const genderWord = gender === 'f' ? 'female' : 'male';
    const prompt = type === 'patronus'
      ? `Ethereal, glowing silver-blue Patronus in the shape of a ${genderWord} ${formName}, made of pure magical light, floating in a dark enchanted forest, Harry Potter style, cinematic lighting, masterpiece, 8k, translucent, luminous, spirit animal`
      : `A majestic ${genderWord} ${formName} with a magical golden aura, realistic but slightly mystical, in the Forbidden Forest, Harry Potter style, cinematic lighting, 8k`;

    const base64Image = await generateImageWithAI(prompt);
    const image = await uploadImageToR2(base64Image, type === 'patronus' ? 'patronus' : 'animagus');
    state.spiritCache[cacheKey] = image;
    await saveState(state);
    res.json({ ok: true, image, type, cached: false });
  } catch (err) {
    console.error('Error generando espíritu (HTTP):', err.message);
    const msg = /no está configurado|no configurado/i.test(err.message)
      ? 'La generación de imágenes no está configurada en el servidor.'
      : 'No se pudo invocar el espíritu. Intenta de nuevo.';
    res.status(500).json({ ok: false, error: msg, detail: err.message });
  }
});

const FALLBACK_CLASS_TRIVIA = {
  pociones: [
    { question: '¿Qué piedra extraída del estómago de una cabra actúa como antídoto contra la mayoría de los venenos?', options: ['Bezoar', 'Piedra lunar', 'Ojo de tigre'], correctIndex: 0 },
    { question: '¿Qué ingrediente es fundamental en la Poción Multijugos para adoptar la forma de otra persona?', options: ['Algo de la persona a transformarse (como un cabello)', 'Pluma de fénix', 'Escama de dragón'], correctIndex: 0 },
    { question: '¿Qué poción otorga una suerte extraordinaria durante un periodo de tiempo?', options: ['Felix Felicis', 'Amortentia', 'Veritaserum'], correctIndex: 0 }
  ],
  transformaciones: [
    { question: '¿En qué animal se transforma la profesora Minerva McGonagall como Animaga?', options: ['Un gato atigrado', 'Un ciervo', 'Un cisne'], correctIndex: 0 },
    { question: '¿Cuál es el conjuro que transforma un animal en una copa de cristal?', options: ['Vera Verto', 'Reparo', 'Alohomora'], correctIndex: 0 },
    { question: '¿Cuál de estas cosas NO se puede crear de la nada según las Leyes de Gamp?', options: ['Comida', 'Agua', 'Luz'], correctIndex: 0 }
  ],
  encantamientos: [
    { question: '¿Qué movimiento de varita enseña el profesor Flitwick para Wingardium Leviosa?', options: ['Agitar y golpear', 'Girar en espiral', 'Dar tres toques secos'], correctIndex: 0 },
    { question: '¿Qué encantamiento sirve para abrir cerraduras comunes?', options: ['Alohomora', 'Colloportus', 'Lumos'], correctIndex: 0 },
    { question: '¿Qué conjuro atrae un objeto directamente hacia quien lo invoca?', options: ['Accio', 'Depulso', 'Diffindo'], correctIndex: 0 }
  ],
  defensa: [
    { question: '¿Qué hechizo se utiliza para transformar a un Boggart en algo cómico?', options: ['Riddikulus', 'Expecto Patronum', 'Stupefy'], correctIndex: 0 },
    { question: '¿Cuál es el conjuro de desarme más famoso en un duelo mágico?', options: ['Expelliarmus', 'Impedimenta', 'Reducto'], correctIndex: 0 },
    { question: '¿Qué encantamiento crea un escudo mágico para desviar hechizos?', options: ['Protego', 'Lumos Solem', 'Silencio'], correctIndex: 0 }
  ],
  herbologia: [
    { question: '¿Qué protección deben usar los alumnos al trasplantar Mandrágoras?', options: ['Orejeras protectoras', 'Gafas de sol', 'Capa de invisibilidad'], correctIndex: 0 },
    { question: '¿Qué debilidad tiene la planta Lazo del Diablo?', options: ['La luz y el calor del fuego', 'El agua helada', 'La oscuridad total'], correctIndex: 0 },
    { question: '¿Para qué se utiliza el pus diluido de los Bubotubérculos?', options: ['Para curar el acné severo', 'Para respirar bajo el agua', 'Para volar sin escoba'], correctIndex: 0 }
  ],
  criaturas: [
    { question: '¿Qué gesto debes hacer siempre antes de acercarte a un Hipogrifo?', options: ['Una reverencia manteniendo el contacto visual', 'Ofrecerle una varita', 'Aplaudir tres veces'], correctIndex: 0 },
    { question: '¿Qué pequeña criatura con aspecto de rama protege los árboles para varitas?', options: ['Bowtruckle', 'Escarbato', 'Puffskein'], correctIndex: 0 },
    { question: '¿Qué criatura siente fascinación por cualquier objeto brillante o moneda de oro?', options: ['Escarbato (Niffler)', 'Hipogrifo', 'Thestral'], correctIndex: 0 }
  ],
  historia: [
    { question: '¿Qué particularidad tiene el profesor Cuthbert Binns?', options: ['Es el único profesor fantasma de Hogwarts', 'Es un centauro', 'Es el fundador de Ravenclaw'], correctIndex: 0 },
    { question: '¿En qué año se firmó el Estatuto Internacional del Secreto Mágico?', options: ['1689', '1066', '1945'], correctIndex: 0 },
    { question: '¿Quién escribió el libro clásico "Historia de la Magia"?', options: ['Bathilda Bagshot', 'Gilderoy Lockhart', 'Newt Scamander'], correctIndex: 0 }
  ],
  vuelo: [
    { question: '¿Qué orden debes decir con firmeza para que la escoba suba a tu mano?', options: ['¡Arriba!', '¡Vuela!', '¡Accio!'], correctIndex: 0 },
    { question: '¿Cuántos puntos vale atrapar la Snitch Dorada en un partido de Quidditch?', options: ['150 puntos', '50 puntos', '10 puntos'], correctIndex: 0 },
    { question: '¿Cómo se llaman las bolas que los Golpeadores desvían con sus bates?', options: ['Bludgers', 'Quaffles', 'Snitches'], correctIndex: 0 }
  ],
  astronomia: [
    { question: '¿En qué lugar de Hogwarts se imparten las clases nocturnas de Astronomía?', options: ['En la Torre de Astronomía', 'En las Mazmorras', 'En la Cabaña de Hagrid'], correctIndex: 0 },
    { question: '¿Qué instrumento mágico utilizan los alumnos de 1.º para observar los planetas?', options: ['Un telescopio de latón', 'Un giratiempo', 'Un pensadero'], correctIndex: 0 },
    { question: '¿Qué fase lunar es determinante para la transformación de un hombre lobo?', options: ['Luna llena', 'Luna nueva', 'Cuarto menguante'], correctIndex: 0 }
  ],
  runas: [
    { question: '¿A partir de qué curso pueden elegir los alumnos la asignatura de Runas Antiguas?', options: ['3.er curso', '1.er curso', '7.º curso'], correctIndex: 0 },
    { question: '¿Qué criatura mágica representa el número cero en el alfabeto rúnico?', options: ['Demiguise', 'Unicornio', 'Basilisco'], correctIndex: 0 },
    { question: '¿Qué objeto utiliza un estudiante de Runas Antiguas para consultar significados?', options: ['El Silabario de Spellman', 'El Mapa del Merodeador', 'El Espejo de Oesed'], correctIndex: 0 }
  ]
};

function pickFallbackTrivia(subjectKey) {
  const list = FALLBACK_CLASS_TRIVIA[subjectKey] || FALLBACK_CLASS_TRIVIA.encantamientos;
  const item = list[Math.floor(Math.random() * list.length)];
  // Mezclar las opciones manteniendo el índice correcto
  const pairs = item.options.map((opt, idx) => ({ opt, isCorrect: idx === item.correctIndex }));
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return {
    question: item.question,
    options: pairs.map(p => p.opt),
    correctIndex: pairs.findIndex(p => p.isCorrect)
  };
}

/* ===== TANDA 3.1: PREGUNTAS DE EXAMEN (Groq + respaldo local) =====
   Genera una lista de preguntas de opción múltiple para una asignatura. Reutiliza
   el mismo cliente de Groq (`aiChatJSON`) exigiendo JSON estricto. Si la IA no
   está disponible o falla, se recurre al banco local (`pickFallbackTrivia`), de
   modo que el examen siempre puede celebrarse. */
async function generateExamQuestions(subjectKey, count, examName, year) {
  const subject = EXAM_SUBJECTS[subjectKey] || { name: subjectKey };
  const n = Math.max(3, Math.min(8, Number(count) || 5));
  if (AI_ENABLED) {
    try {
      const systemPrompt = `Eres un examinador oficial del Ministerio de Magia para Hogwarts. Genera ${n} preguntas de opción múltiple (nivel ${examName}, ${year}.º curso) sobre ${subject.name}. ` +
        `Devuelve ÚNICAMENTE un JSON válido sin bloques markdown con este esquema exacto: {"questions":[{"question":"texto","options":["a","b","c","d"],"correctIndex":0}]}. ` +
        `Cada pregunta debe tener exactamente 4 opciones, una sola correcta y ser apropiada para el canon de Harry Potter.`;
      const parsed = await aiChatJSON({ systemPrompt, userPrompt: `Genera las ${n} preguntas ahora.`, maxTokens: 1200, temperature: 0.8 });
      const list = Array.isArray(parsed && parsed.questions) ? parsed.questions : [];
      const clean = list.map(q => {
        const options = Array.isArray(q && q.options) ? q.options.map(o => String(o)).slice(0, 4) : [];
        let ci = Math.floor(Number(q && q.correctIndex));
        if (options.length !== 4 || !Number.isFinite(ci) || ci < 0 || ci > 3) return null;
        return { question: String(q.question || '').trim(), options, correctIndex: ci };
      }).filter(q => q && q.question);
      if (clean.length >= n) return clean.slice(0, n);
    } catch (err) {
      console.error('Error generando preguntas de examen con Groq:', err.message);
    }
  }
  // Respaldo local: banco de preguntas por asignatura.
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const q = pickFallbackTrivia(subjectKey);
    if (!q || !q.question) break;
    const key = q.question + '|' + q.options.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

// Respaldo local si Groq no está disponible: heurística por palabras clave del tema.
const SANDWICH_HINTS = {
  libros: ['estudio', 'libro', 'leer', 'biblioteca', 'examen', 'deberes', 'tarea', 'hechizo'],
  quidditch: ['quidditch', 'escoba', 'snitch', 'partido', 'vuelo', 'aro', 'bludger', 'golpeador', 'buscador'],
  snape: ['snape', 'pociones', 'caldero', 'mazmorras', 'profesor'],
  familia: ['padre', 'madre', 'familia', 'linaje', 'malfoy', 'sangre', 'casa'],
  criaturas: ['hipogrifo', 'dragón', 'criatura', 'cuidado de criaturas', 'hagrid', 'animal'],
  bromas: ['broma', 'travesura', 'weasley', 'chiste', 'filch', 'pasadizo']
};
function pickFallbackSandwich(npcName, phrase) {
  const text = normalizeLoreText(phrase);
  const name = normalizeLoreText(npcName);
  const likes = [];
  if (/hermione|percy|binns|flitwick|cho|lyra/.test(name)) likes.push('libros');
  if (/harry|ron|fred|george|oliver|cedric|ginny/.test(name)) likes.push('quidditch', 'bromas');
  if (/draco|pansy|blaise|seraphina/.test(name)) likes.push('familia', 'snape');
  if (/neville|hannah|sprout|hagrid|ernie/.test(name)) likes.push('criaturas');
  if (/luna/.test(name)) likes.push('criaturas');
  if (!likes.length) likes.push('quidditch', 'libros');
  const hitTopic = likes.find(topic => (SANDWICH_HINTS[topic] || []).some(k => text.includes(k)));
  const match = !!hitTopic;
  return {
    match,
    reply: match ? '¡Justo el tema que me encanta! Sigue, sigue…' : 'Mmm… prefiero hablar de otra cosa, la verdad.'
  };
}

// Respaldo local de chismes si Groq no está disponible: rumores canónicos y
// divertidos que no dependen del modelo.
const FALLBACK_GOSSIP = [
  'Draco Malfoy fue visto comprando un cargamento entero de dulces en Honeydukes… y luego fingió que era para su padre.',
  'A Ron Weasley se le escapó su rata Scabbers por los pasillos y la estuvo persiguiendo toda la tarde.',
  'Luna Lovegood asegura haber visto a un Crumple-Horned Snorkack cerca del lago. Nadie más lo ha visto.',
  'Se rumorea que los gemelos Weasley preparan una nueva broma contra Filch en el tercer piso.',
  'Neville Longbottom habló tan bajo en Pociones que Snape ni se dio cuenta de que había respondido bien.',
  'Un alumno juró que la escalera del ala este cambió de sentido justo cuando bajaba corriendo.',
  'Cho Chang fue vista entrenando a solas en el campo de Quidditch hasta el anochecer.',
  'Se dice que Peeves escondió las cartas de un profesor en la Torre de Astronomía.'
];

function pickFallbackGossip() {
  return FALLBACK_GOSSIP[Math.floor(Math.random() * FALLBACK_GOSSIP.length)];
}

// Llama a Groq pidiendo un JSON, con timeout y limpieza de bloques markdown.
// Reutilizable por los endpoints editoriales (El Profeta, etc.).
async function aiChatJSON({ systemPrompt, userPrompt, maxTokens = 900, temperature = 0.8, reasoning = 'low' }) {
  const aiBody = {
    model: AI_MODEL,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };
  if (/gpt-oss/i.test(AI_MODEL)) aiBody.reasoning_effort = reasoning;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const aiRes = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify(aiBody),
      signal: controller.signal
    });
    if (!aiRes.ok) throw new Error(`Groq HTTP ${aiRes.status}`);
    const json = await aiRes.json();
    let raw = String(json?.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const firstBrace = raw.indexOf('{'), lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) raw = raw.slice(firstBrace, lastBrace + 1);
    return JSON.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}

/* ===== EL PROFETA: PERIÓDICO EDITORIAL GENERADO CON IA ===== */
// Caché persistente de 24 h: la edición activa se guarda en el estado del juego
// (memoryState.dailyProphet) y sobrevive a reinicios del servidor.
const PROPHET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const asStr = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// Baraja un array (Fisher-Yates) sin mutar el original.
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Normaliza cualquier JSON editorial (de Groq o de respaldo) al esquema esperado
// por el modal. Devuelve null si falta lo esencial para no servir un periódico roto.
function normalizeProphetIssue(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const leadRaw = raw.lead && typeof raw.lead === 'object' ? raw.lead : {};
  const lead = {
    category: asStr(leadRaw.category, 40) || 'NOTICIA',
    headline: asStr(leadRaw.headline, 140),
    subheadline: asStr(leadRaw.subheadline, 200),
    byline: asStr(leadRaw.byline, 90) || 'POR EL EQUIPO DE REDACCIÓN DE EL PROFETA',
    paragraphs: (Array.isArray(leadRaw.paragraphs) ? leadRaw.paragraphs : [])
      .map(p => asStr(p, 900)).filter(Boolean).slice(0, 4)
  };
  if (!lead.headline || !lead.paragraphs.length) return null;

  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map(s => s && typeof s === 'object' ? {
      category: asStr(s.category, 40) || 'HOGWARTS',
      title: asStr(s.title, 120),
      subtitle: asStr(s.subtitle, 160),
      text: asStr(s.text, 600)
    } : null)
    .filter(s => s && s.title && s.text).slice(0, 4);

  const classifiedRaw = raw.classified && typeof raw.classified === 'object' ? raw.classified : {};
  const classified = {
    category: asStr(classifiedRaw.category, 60) || 'MINISTERIO · CLASIFICADO',
    title: asStr(classifiedRaw.title, 120) || 'INFORME SELLADO POR EL MINISTERIO',
    hint: asStr(classifiedRaw.hint, 200) || 'Este informe ha sido sellado con runas estándar del Ministerio.',
    secretText: asStr(classifiedRaw.secretText, 700) || pickFallbackProphetSecret(ctx.year)
  };

  const notices = (Array.isArray(raw.notices) ? raw.notices : [])
    .map(n => n && typeof n === 'object' ? { title: asStr(n.title, 60), text: asStr(n.text, 400) } : null)
    .filter(n => n && n.title && n.text).slice(0, 4);

  return {
    masthead: asStr(raw.masthead, 60) || 'El Profeta',
    tagline: asStr(raw.tagline, 90) || 'EL SEDUCTOR PERIÓDICO DEL MUNDO MÁGICO',
    dateline: asStr(raw.dateline, 60) || `LONDRES — ${new Date().getFullYear()}`,
    weather: asStr(raw.weather, 110) || 'CLIMA: LLOVIZNAS ENCANTADAS EN LAS TIERRAS ALTAS',
    lead,
    sections,
    classified,
    noticesTitle: asStr(raw.noticesTitle, 70) || 'AVISOS Y ANUNCIOS CLASIFICADOS',
    notices: notices.length ? notices : fallbackProphetNotices(ctx),
    footer: asStr(raw.footer, 120) || 'ENVIAR LECHUZAS A: EL PROFETA, CALLEJÓN DIAGON, LONDRES',
    generatedAt: Date.now()
  };
}

// Pista secreta canónica según el año escolar (sin spoilers de años posteriores).
const FALLBACK_PROPHET_SECRETS = [
  'Un guardabosques jura haber oído pisadas enormes junto al Bosque Prohibido. Los centauros guardan silencio.',
  'Las estatuas de búho repartidas por el castillo esconden Lunas de Demiguise… pero solo se ven de noche.',
  'En los Invernaderos brota díctamo más rápido de lo normal. Los profesores no saben por qué.',
  'Un alumno de primer año asegura que la escalera del ala este cambia de sentido cuando nadie la mira.',
  'Las armaduras del tercer piso amanecieron con las viseras abolladas. Nadie quiere hablar del asunto.',
  'Se han visto luces extrañas sobre el lago al filo de la medianoche. Los más veteranos callan.'
];
function pickFallbackProphetSecret(year) {
  const i = (clampSchoolYear(year) + FALLBACK_PROPHET_SECRETS.length) % FALLBACK_PROPHET_SECRETS.length;
  return FALLBACK_PROPHET_SECRETS[i];
}

// Avisos clasificados de respaldo: siempre con datos reales del servidor.
function fallbackProphetNotices(ctx) {
  const lead = ctx.leadingHouse || 'Gryffindor';
  const pts = Number(ctx.leadingPoints) || 0;
  return [
    { title: 'COPA DE LAS CASAS:', text: `${lead} encabeza la tabla con ${pts} puntos. Las demás casas acechan en los pasillos.` },
    { title: 'OLLIVANDERS:', text: 'Fabricantes de varitas de calidad desde el 382 a.C. La varita elige al mago. Callejón Diagon.' },
    { title: 'HONEYDUKES:', text: 'Ranas de Chocolate con cromos coleccionables y Grageas Bertie Bott de todos los sabores. ¡Cuidado con el de vómito!' }
  ];
}

// Periódico de respaldo si Groq falla o tarda: estructura completa y datos reales.
function buildFallbackProphet(ctx) {
  const lead = ctx.leadingHouse || 'Gryffindor';
  const pts = Number(ctx.leadingPoints) || 0;
  const names = (ctx.playerNames && ctx.playerNames.length) ? ctx.playerNames.slice(0, 3) : [];
  const roster = names.length ? names.join(', ') : 'los alumnos del castillo';
  const coupleLine = (ctx.couples && ctx.couples.length)
    ? ` Los pasillos murmuran sobre el romance entre ${ctx.couples[0]}.`
    : '';
  return normalizeProphetIssue({
    masthead: 'El Profeta',
    tagline: 'EL SEDUCTOR PERIÓDICO DEL MUNDO MÁGICO',
    dateline: `LONDRES — ${new Date().getFullYear()}`,
    weather: 'CLIMA: LLOVIZNAS ENCANTADAS EN LAS TIERRAS ALTAS',
    lead: {
      category: 'VIDA EN EL CASTILLO',
      headline: `${lead.toUpperCase()} DOMINA LA COPA DE LAS CASAS`,
      subheadline: `Con ${pts} puntos, ${lead} mira a sus rivales desde lo alto de la tabla.`,
      byline: 'POR EL EQUIPO DE REDACCIÓN DE EL PROFETA',
      paragraphs: [
        `La actividad no se detiene en Hogwarts. Entre clases, exploraciones y partidas en el patio, ${roster} acaparan las miradas de profesores y prefectos. La Copa de las Casas sigue apretada y ningún punto se da por perdido.`,
        `En ${lead} celebran el liderazgo con ${pts} puntos, aunque los prefectos avisan: en el castillo una buena racha puede deshacerse en una sola clase. Las casas perseguidoras afilan las varitas para el próximo torneo.`
      ]
    },
    sections: [
      {
        category: 'HOGWARTS',
        title: 'El curso avanza a paso firme',
        subtitle: 'Actividad intensa en aulas y terrenos',
        text: 'Las clases se suceden entre encantamientos, pociones y defensa. Los alumnos reparten su tiempo entre el estudio en la biblioteca y las exploraciones nocturnas.'
      },
      {
        category: 'QUIDDITCH',
        title: 'Los favoritos para la Copa',
        subtitle: 'La disputa por los puntos está al rojo vivo',
        text: `${lead} lidera la clasificación con ${pts} puntos. En el estadio, los equipos entrenan jugadas nuevas a la espera del próximo partido.`
      }
    ],
    classified: {
      category: 'MINISTERIO · CLASIFICADO',
      title: 'INFORME SELLADO POR EL MINISTERIO',
      hint: 'Este informe ha sido sellado con runas estándar del Ministerio.',
      secretText: pickFallbackProphetSecret(ctx.year)
    },
    noticesTitle: 'AVISOS Y ANUNCIOS CLASIFICADOS',
    notices: fallbackProphetNotices(ctx),
    footer: 'ENVIAR LECHUZAS A: EL PROFETA, CALLEJÓN DIAGON, LONDRES'
  }, ctx);
}

app.post('/api/class-trivia', async (req, res) => {
  const subjectKey = String((req.body && req.body.subjectKey) || 'encantamientos').trim().toLowerCase();
  const subjectName = String((req.body && req.body.subjectName) || 'Encantamientos').trim().slice(0, 80);
  const topic = String((req.body && req.body.topic) || subjectName).trim().slice(0, 120);
  const year = clampSchoolYear(req.body && req.body.year);

  if (!AI_ENABLED) {
    return res.json({ ok: true, ...pickFallbackTrivia(subjectKey), fallback: true });
  }

  const systemPrompt = `Eres un profesor de Hogwarts examinando en clase. Genera una pregunta de trivia sobre ${subjectName} para ${year}er año (tema: ${topic}) dentro del canon de Harry Potter en español. Devuelve ÚNICAMENTE un JSON válido sin bloques markdown con este esquema exacto: {"question":"¿...?","options":["Opción 1","Opción 2","Opción 3"],"correctIndex":0}`;
  const aiBody = {
    model: AI_MODEL,
    max_tokens: 220,
    temperature: 0.7,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Genera una pregunta de trivia sobre ${subjectName} para ${year}er año, devuelve un JSON con la pregunta y 3 opciones.` }
    ]
  };
  if (/gpt-oss/i.test(AI_MODEL)) aiBody.reasoning_effort = 'low';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const aiRes = await fetch(AI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_KEY}`
      },
      body: JSON.stringify(aiBody),
      signal: controller.signal
    });
    if (!aiRes.ok) throw new Error(`Groq HTTP ${aiRes.status}`);
    const json = await aiRes.json();
    let raw = String(json?.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      raw = raw.slice(firstBrace, lastBrace + 1);
    }
    const parsed = JSON.parse(raw);
    const question = String(parsed.question || parsed.pregunta || '').trim();
    const rawOpts = Array.isArray(parsed.options) ? parsed.options : (Array.isArray(parsed.opciones) ? parsed.opciones : []);
    const options = rawOpts.slice(0, 3).map(o => String(o || '').trim()).filter(Boolean);
    let correctIndex = Number(parsed.correctIndex ?? parsed.respuestaCorrecta ?? 0);
    if (!question || options.length !== 3 || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 2) {
      throw new Error('JSON de trivia incompleto');
    }
    return res.json({ ok: true, question, options, correctIndex, fallback: false });
  } catch (err) {
    console.error('Error generando trivia de clase (usando respaldo local):', err.message);
    return res.json({ ok: true, ...pickFallbackTrivia(subjectKey), fallback: true });
  } finally {
    clearTimeout(timer);
  }
});

// 🥪 Minijuego de sándwiches: la IA de Groq evalúa si la frase encaja con el personaje.
app.post('/api/sandwich', async (req, res) => {
  const npcName = String((req.body && req.body.npcName) || 'un alumno').trim().slice(0, 60);
  const phrase = String((req.body && req.body.phrase) || '').trim().slice(0, 120);
  const trait = String((req.body && req.body.trait) || '').trim().slice(0, 200);
  const year = clampSchoolYear(req.body && req.body.year);

  if (!phrase) return res.json({ ok: true, match: false, reply: 'Mejor hablemos de otra cosa…', fallback: true });

  if (!AI_ENABLED) {
    return res.json({ ok: true, ...pickFallbackSandwich(npcName, phrase), fallback: true });
  }

  const systemPrompt = `Eres ${npcName}, alumno del castillo de Hogwarts (${trait || 'alumno del castillo'}). Estás comiendo sándwiches en el Gran Comedor con el jugador. El jugador intenta sacar un tema de conversación. Decide si ese tema encaja con tu personalidad y tus gustos. Devuelve ÚNICAMENTE un JSON válido sin bloques markdown con este esquema: {"match": true o false, "reply": "tu reacción en una frase, en español y dentro del personaje"}. Nunca rompas el canon ni menciones que eres una IA. Están en el Año ${year}.`;
  const aiBody = {
    model: AI_MODEL,
    max_tokens: 180,
    temperature: 0.7,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Tema que saca el jugador mientras coméis: "${phrase}". ¿Te interesa? Devuelve el JSON.` }
    ]
  };
  if (/gpt-oss/i.test(AI_MODEL)) aiBody.reasoning_effort = 'low';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const aiRes = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify(aiBody),
      signal: controller.signal
    });
    if (!aiRes.ok) throw new Error(`Groq HTTP ${aiRes.status}`);
    const json = await aiRes.json();
    let raw = String(json?.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const firstBrace = raw.indexOf('{'), lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) raw = raw.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(raw);
    const match = parsed.match === true || parsed.match === 'true' || parsed.acierto === true;
    const reply = String(parsed.reply || parsed.respuesta || '').trim().slice(0, 200) || (match ? '¡Justo lo que quería oír!' : 'Prefiero hablar de otra cosa.');
    return res.json({ ok: true, match, reply, fallback: false });
  } catch (err) {
    console.error('Error evaluando sándwiches (usando respaldo local):', err.message);
    return res.json({ ok: true, ...pickFallbackSandwich(npcName, phrase), fallback: true });
  } finally {
    clearTimeout(timer);
  }
});

// Chismes y rumores: pide a Groq un rumor corto y divertido sobre otro alumno.
app.post('/api/gossip', async (req, res) => {
  const year = clampSchoolYear(req.body && req.body.year);
  const rawNames = Array.isArray(req.body && req.body.names) ? req.body.names : [];
  const names = rawNames.map(n => String(n || '').trim().slice(0, 40)).filter(Boolean).slice(0, 12);

  if (!AI_ENABLED) {
    return res.json({ ok: true, rumor: pickFallbackGossip(), fallback: true });
  }

  const roster = names.length ? names.join(', ') : 'alumnos del castillo';
  const systemPrompt = `Eres un alumno chismoso del castillo de Hogwarts. Cuenta un rumor corto, divertido y cariñoso (nunca cruel ni ofensivo) sobre OTRO alumno. Debe estar ambientado en el canon de Harry Potter, en español, en una sola frase de máximo 25 palabras. Elige a UN alumno de esta lista si puedes: ${roster}. Devuelve ÚNICAMENTE un JSON válido sin bloques markdown con este esquema exacto: {"rumor":"..."}. Están en el Año ${year}.`;

  const aiBody = {
    model: AI_MODEL,
    max_tokens: 120,
    temperature: 0.9,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Cuéntame el chisme de hoy. Devuelve el JSON.' }
    ]
  };
  if (/gpt-oss/i.test(AI_MODEL)) aiBody.reasoning_effort = 'low';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const aiRes = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify(aiBody),
      signal: controller.signal
    });
    if (!aiRes.ok) throw new Error(`Groq HTTP ${aiRes.status}`);
    const json = await aiRes.json();
    let raw = String(json?.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const firstBrace = raw.indexOf('{'), lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) raw = raw.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(raw);
    const rumor = String(parsed.rumor || parsed.chisme || parsed.texto || '').trim().slice(0, 240);
    if (!rumor) throw new Error('JSON de chisme incompleto');
    return res.json({ ok: true, rumor, fallback: false });
  } catch (err) {
    console.error('Error generando chisme (usando respaldo local):', err.message);
    return res.json({ ok: true, rumor: pickFallbackGossip(), fallback: true });
  } finally {
    clearTimeout(timer);
  }
});

// 📰 El Profeta: editorial vivo generado con IA a partir de lo que ocurre en el
// servidor (casas, registros recientes, jugadores y parejas). Caché de 10 minutos
// y respaldo local con datos reales si Groq tarda o falla.
app.post('/api/daily-prophet', async (req, res) => {
  const body = req.body || {};
  const year = clampSchoolYear(body.year);

  const leadingHouse = String(body.leadingHouse || 'Gryffindor').trim().slice(0, 40);
  const leadingPoints = Number(body.leadingPoints) || 0;
  const rawSummary = Array.isArray(body.housesSummary) ? body.housesSummary : [];
  const housesSummary = rawSummary
    .map(h => h && typeof h === 'object'
      ? `${String(h.name || h.id || 'Casa').trim().slice(0, 30)}: ${Number(h.points) || 0} pts`
      : String(h || '').trim().slice(0, 60))
    .filter(Boolean).slice(0, 4);
  const rawLogs = Array.isArray(body.recentLogs) ? body.recentLogs : [];
  const recentLogs = rawLogs.map(l => {
    if (l && typeof l === 'object') {
      const who = String(l.u || l.user || '').trim().slice(0, 40);
      const act = String(l.a || l.action || '').trim().slice(0, 80);
      const pts = Number(l.p) || 0;
      return [who, act, pts ? `(+${pts} pts)` : ''].filter(Boolean).join(' · ').slice(0, 140);
    }
    return String(l || '').trim().slice(0, 140);
  }).filter(Boolean).slice(0, 12);
  const rawNames = Array.isArray(body.playerNames) ? body.playerNames : [];
  const playerNames = rawNames.map(n => String(n || '').trim().slice(0, 40)).filter(Boolean).slice(0, 12);
  const rawCouples = Array.isArray(body.couples) ? body.couples : [];
  const couples = rawCouples.map(c => {
    if (c && typeof c === 'object') {
      const members = Array.isArray(c.members) ? c.members.map(m => String(m).trim().slice(0, 40)).filter(Boolean) : [];
      return members.join(' y ');
    }
    return String(c || '').trim().slice(0, 90);
  }).filter(Boolean).slice(0, 4);

  const ctx = { year, leadingHouse, leadingPoints, housesSummary, recentLogs, playerNames, couples };
  const fallbackIssue = () => buildFallbackProphet(ctx);

  // Parte 4B: las crónicas de Lee Jordan se publican como secciones del diario.
  const chronicles = (Array.isArray(memoryState && memoryState.prophetChronicles) ? memoryState.prophetChronicles : [])
    .filter(c => c && Array.isArray(c.lines) && c.lines.length)
    .slice(0, 4);
  const houseName = id => ({ gryffindor: 'Gryffindor', slytherin: 'Slytherin', ravenclaw: 'Ravenclaw', hufflepuff: 'Hufflepuff' }[id] || id);
  const attachChronicles = (issue) => {
    if (!issue || !chronicles.length) return issue;
    const qsec = chronicles.map(c => ({
      category: 'QUIDDITCH · CRÓNICA DE LEE JORDAN',
      title: `${houseName(c.a)} ${c.sa} - ${c.sb} ${houseName(c.b)}`,
      subtitle: c.winner && c.winner !== 'empate' ? `Victoria de ${houseName(c.winner)}` : 'Empate agónico',
      text: c.lines.join(' ')
    }));
    issue.sections = [...(Array.isArray(issue.sections) ? issue.sections : []), ...qsec].slice(0, 8);
    return issue;
  };

  // La edición activa vive en el estado persistente del juego: se devuelve tal
  // cual durante 24 h (o hasta que cambie el año escolar), sin regenerarla por
  // cambios en puntos, logs u otros datos del castillo.
  const now = Date.now();
  const active = memoryState && memoryState.dailyProphet;
  if (active && active.issue && active.year === year && (now - Number(active.generatedAt)) < PROPHET_CACHE_TTL_MS) {
    const issue = JSON.parse(JSON.stringify(active.issue));
    attachChronicles(issue);
    return res.json({ ok: true, issue, chronicles, cached: true, fallback: !!active.issue.__fallback });
  }

  // Persiste la edición recién generada y la marca como activa durante 24 h.
  const publishIssue = async (issue) => {
    memoryState.dailyProphet = { issue, generatedAt: Date.now(), year };
    try { await saveState(memoryState); }
    catch (err) { console.error('Error guardando El Profeta:', err.message); }
  };

  if (!AI_ENABLED) {
    const issue = fallbackIssue();
    if (issue) issue.__fallback = true;
    await publishIssue(issue);
    const out = JSON.parse(JSON.stringify(issue));
    attachChronicles(out);
    return res.json({ ok: true, issue: out, chronicles, cached: false, fallback: true });
  }

  const systemPrompt = `Eres el redactor jefe de "El Profeta", el periódico sensacionalista del mundo mágico de Harry Potter. Escribes SIEMPRE en español, con tono editorial exagerado, elegante y algo amarillista (como Rita Skeeter), pero sin inventar personajes reales fuera del canon de Harry Potter ni mencionar el mundo real, internet o IA. Están en el Año ${year} de Hogwarts: NO menciones ni des por sabidos hechos, criaturas o personajes que aparezcan en años posteriores del canon. Usa los datos del castillo que te doy (casa líder, registros recientes, nombres de alumnos y parejas) para que la edición se sienta viva y actual. Devuelve ÚNICAMENTE un JSON válido sin bloques markdown con esta forma exacta: {"masthead":"El Profeta","tagline":"EL SEDUCTOR PERIÓDICO DEL MUNDO MÁGICO","dateline":"LONDRES — ${new Date().getFullYear()}","weather":"CLIMA: ...","lead":{"category":"ESCÁNDALO","headline":"...","subheadline":"...","byline":"POR EL EQUIPO DE REDACCIÓN DE EL PROFETA","paragraphs":["...","..."]},"sections":[{"category":"HOGWARTS","title":"...","subtitle":"...","text":"..."},{"category":"QUIDDITCH","title":"...","subtitle":"...","text":"..."}],"classified":{"category":"MINISTERIO · CLASIFICADO","title":"INFORME SELLADO POR EL MINISTERIO","hint":"Este informe ha sido sellado con runas estándar del Ministerio.","secretText":"..."},"noticesTitle":"AVISOS Y ANUNCIOS CLASIFICADOS","notices":[{"title":"COPA DE LAS CASAS:","text":"..."},{"title":"OLLIVANDERS:","text":"..."}],"footer":"ENVIAR LECHUZAS A: EL PROFETA, CALLEJÓN DIAGON, LONDRES"}. El "secretText" debe ser una pista sobre criaturas del Bosque Prohibido, Estatuas Demiguise o amenazas oscuras del año actual, apta para revelarse con el hechizo LUMOS.`;

  const userPrompt = `Datos actuales del castillo:
- Año escolar: ${year}
- Casa líder: ${leadingHouse} (${leadingPoints} puntos)
- Resumen de casas: ${housesSummary.join(' | ') || 'sin datos'}
- Registros recientes: ${recentLogs.join(' | ') || 'sin registros recientes'}
- Alumnos activos: ${playerNames.join(', ') || 'varios alumnos'}
- Parejas oficiales: ${couples.join(' | ') || 'ninguna conocida'}

Redacta la edición de hoy de El Profeta en JSON.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const parsed = await aiChatJSON({ systemPrompt, userPrompt, maxTokens: 1600, temperature: 0.9, reasoning: 'low' });
    const issue = normalizeProphetIssue(parsed, ctx);
    if (!issue) throw new Error('JSON editorial incompleto');
    issue.__fallback = false;
    await publishIssue(issue);
    const out = JSON.parse(JSON.stringify(issue));
    attachChronicles(out);
    return res.json({ ok: true, issue: out, chronicles, cached: false, fallback: false });
  } catch (err) {
    console.error('Error generando El Profeta (usando respaldo local):', err.message);
    const issue = fallbackIssue();
    if (issue) issue.__fallback = true;
    await publishIssue(issue);
    const out = JSON.parse(JSON.stringify(issue));
    attachChronicles(out);
    return res.json({ ok: true, issue: out, chronicles, cached: false, fallback: true });
  } finally {
    clearTimeout(timer);
  }
});

/* ===== CUESTIONARIOS CANON (Cerveza de Mantequilla y Almuerzo de Amistad) ===== */
// Banco local de preguntas canónicas por personaje (respaldo si Groq no está).
const CANON_QUIZ_BANK = {
  'harry potter': [
    { q: '¿Qué posición juega Harry en el equipo de Quidditch de Gryffindor?', options: ['Buscador', 'Guardián', 'Golpeador'], correctIndex: 0 },
    { q: '¿Cómo se llama la lechuza de Harry?', options: ['Hedwig', 'Pigwidgeon', 'Errol'], correctIndex: 0 },
    { q: '¿Qué criatura acompaña siempre a Harry como Patronus?', options: ['Un ciervo', 'Una nutria', 'Un lobo'], correctIndex: 0 }
  ],
  'hermione granger': [
    { q: '¿De qué casa es Hermione Granger?', options: ['Gryffindor', 'Ravenclaw', 'Slytherin'], correctIndex: 0 },
    { q: '¿Qué criatura defiende Hermione con su activismo?', options: ['Los elfos domésticos', 'Los gnomos de jardín', 'Los dragones'], correctIndex: 0 },
    { q: '¿Qué asignatura favorita tiene Hermione por su rigor lógico?', options: ['Aritmancia', 'Adivinación', 'Vuelo'], correctIndex: 0 }
  ],
  'ron weasley': [
    { q: '¿Cuál es el mayor miedo de Ron?', options: ['Las arañas', 'Los dragones', 'Los fantasmas'], correctIndex: 0 },
    { q: '¿Qué animal es la mascota de Ron?', options: ['Una rata (Scabbers)', 'Un búho', 'Un gato'], correctIndex: 0 },
    { q: '¿Qué juego de ingenio domina Ron?', options: ['El ajedrez mágico', 'Las cartas explosivas', 'El Gobstones'], correctIndex: 0 }
  ],
  'draco malfoy': [
    { q: '¿De qué casa es Draco Malfoy?', options: ['Slytherin', 'Gryffindor', 'Ravenclaw'], correctIndex: 0 },
    { q: '¿Cómo se llama el padre de Draco?', options: ['Lucius', 'Abraxas', 'Narcissa'], correctIndex: 0 },
    { q: '¿Qué deporte le apasiona a Draco?', options: ['El Quidditch', 'El duelo de hechizos', 'La esgrima mágica'], correctIndex: 0 }
  ],
  'luna lovegood': [
    { q: '¿De qué casa es Luna Lovegood?', options: ['Ravenclaw', 'Hufflepuff', 'Gryffindor'], correctIndex: 0 },
    { q: '¿Qué criatura improbable defiende Luna?', options: ['Los nargles', 'Los hipogrifos', 'Los basilisco'], correctIndex: 0 },
    { q: '¿Qué revista dirige el padre de Luna?', options: ['El Quisquilloso', 'El Profeta', 'El Correo de las Brujas'], correctIndex: 0 }
  ],
  'neville longbottom': [
    { q: '¿En qué asignatura destaca Neville?', options: ['Herbología', 'Pociones', 'Adivinación'], correctIndex: 0 },
    { q: '¿Quién es la abuela que cría a Neville?', options: ['Augusta Longbottom', 'Minerva McGonagall', 'Pomona Sprout'], correctIndex: 0 },
    { q: '¿De qué casa es Neville?', options: ['Gryffindor', 'Hufflepuff', 'Ravenclaw'], correctIndex: 0 }
  ],
  'cho chang': [
    { q: '¿Qué posición juega Cho Chang en Quidditch?', options: ['Buscadora', 'Guardiana', 'Golpeadora'], correctIndex: 0 },
    { q: '¿De qué casa es Cho Chang?', options: ['Ravenclaw', 'Gryffindor', 'Slytherin'], correctIndex: 0 },
    { q: '¿A qué equipo pertenece Cho en el torneo?', options: ['Ravenclaw', 'Hufflepuff', 'Gryffindor'], correctIndex: 0 }
  ],
  'cedric diggory': [
    { q: '¿De qué casa es Cedric Diggory?', options: ['Hufflepuff', 'Gryffindor', 'Slytherin'], correctIndex: 0 },
    { q: '¿Qué posición juega Cedric en Quidditch?', options: ['Buscador', 'Guardián', 'Golpeador'], correctIndex: 0 },
    { q: '¿Cómo describen todos a Cedric?', options: ['Justo y ejemplar', 'Astuto y frío', 'Tímido y torpe'], correctIndex: 0 }
  ],
  'snape': [
    { q: '¿Qué asignatura imparte el profesor Snape?', options: ['Pociones', 'Encantamientos', 'Herbología'], correctIndex: 0 },
    { q: '¿De qué casa es jefe Snape?', options: ['Slytherin', 'Ravenclaw', 'Gryffindor'], correctIndex: 0 },
    { q: '¿En qué lugar da clase Snape?', options: ['En las mazmorras', 'En la torre de Astronomía', 'En los invernaderos'], correctIndex: 0 }
  ],
  'dumbledore': [
    { q: '¿Qué cargo tiene Albus Dumbledore en Hogwarts?', options: ['Director', 'Subdirector', 'Jefe de casa'], correctIndex: 0 },
    { q: '¿Qué ave acompaña a Dumbledore?', options: ['Un fénix', 'Un hipogrifo', 'Una lechuza'], correctIndex: 0 },
    { q: '¿De qué casa fue Dumbledore?', options: ['Gryffindor', 'Ravenclaw', 'Slytherin'], correctIndex: 0 }
  ]
};

// Elige 3 preguntas del banco para un personaje (o las genéricas si no está).
function pickFallbackCanonQuiz(npcName) {
  const key = normalizeLoreText(npcName).replace(/[^a-z ]/g, '').trim();
  let bank = CANON_QUIZ_BANK[key];
  if (!bank) {
    const hit = Object.keys(CANON_QUIZ_BANK).find(k => key.includes(k) || k.includes(key.split(' ')[0] || ''));
    bank = hit ? CANON_QUIZ_BANK[hit] : null;
  }
  if (!bank) {
    bank = [
      { q: '¿Cómo se llama el castillo donde estudian los alumnos?', options: ['Hogwarts', 'Beauxbatons', 'Durmstrang'], correctIndex: 0 },
      { q: '¿Cuántas casas tiene Hogwarts?', options: ['Cuatro', 'Tres', 'Cinco'], correctIndex: 0 },
      { q: '¿Qué asignatura enseña las defensas contra la magia oscura?', options: ['Defensa contra las Artes Oscuras', 'Pociones', 'Historia de la Magia'], correctIndex: 0 }
    ];
  }
  // Baraja y devuelve 3, mezclando también el orden de las opciones.
  const picks = shuffleArray(bank).slice(0, 3).map(item => {
    const pairs = item.options.map((opt, idx) => ({ opt, isCorrect: idx === item.correctIndex }));
    const mixed = shuffleArray(pairs);
    return { q: item.q, options: mixed.map(p => p.opt), correctIndex: mixed.findIndex(p => p.isCorrect) };
  });
  return picks;
}

app.post('/api/canon-quiz', async (req, res) => {
  const body = req.body || {};
  const npcName = String(body.npcName || 'un alumno').trim().slice(0, 60);
  const house = String(body.house || '').trim().slice(0, 30);
  const trait = String(body.trait || '').trim().slice(0, 200);
  const mode = body.mode === 'butterbeer' ? 'butterbeer' : 'lunch';
  const year = clampSchoolYear(body.year);

  if (!AI_ENABLED) {
    return res.json({ ok: true, questions: pickFallbackCanonQuiz(npcName), fallback: true });
  }

  const focus = mode === 'butterbeer'
    ? 'historia personal, hazañas y anécdotas del personaje'
    : 'su casa, su varita, su familia o su mascota';
  const systemPrompt = `Eres un redactor de cuestionarios sobre el canon de Harry Potter en español. Genera EXACTAMENTE 3 preguntas de trivia de dificultad media sobre ${npcName}${house ? ` (casa ${house})` : ''}, centradas en ${focus}. Cada pregunta debe tener 3 opciones y una sola respuesta correcta. Datos del personaje: ${trait || 'alumno de Hogwarts'}. Están en el Año ${year}: no uses hechos posteriores del canon. Devuelve ÚNICAMENTE un JSON válido sin bloques markdown con esta forma exacta: {"questions":[{"q":"¿...?","options":["A","B","C"],"correctIndex":0},{"q":"...","options":["A","B","C"],"correctIndex":1},{"q":"...","options":["A","B","C"],"correctIndex":2}]}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const parsed = await aiChatJSON({
      systemPrompt,
      userPrompt: `Genera las 3 preguntas sobre ${npcName} y devuelve el JSON.`,
      maxTokens: 700, temperature: 0.7, reasoning: 'low'
    });
    const list = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = list.map(item => {
      const q = asStr(item && item.q, 240);
      const options = (Array.isArray(item && item.options) ? item.options : []).map(o => asStr(o, 90)).filter(Boolean);
      let correctIndex = Number(item && item.correctIndex);
      if (!q || options.length !== 3 || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 2) return null;
      return { q, options, correctIndex };
    }).filter(Boolean);
    if (questions.length < 3) throw new Error('Cuestionario canon incompleto');
    return res.json({ ok: true, questions: questions.slice(0, 3), fallback: false });
  } catch (err) {
    console.error('Error generando cuestionario canon (usando respaldo local):', err.message);
    return res.json({ ok: true, questions: pickFallbackCanonQuiz(npcName), fallback: true });
  } finally {
    clearTimeout(timer);
  }
});

/* ===== SISTEMA DE RELACIONES OFICIALES Y POLIAMOR (IA árbitro) ===== */
// Rasgos que definen cómo reacciona cada arquetipo ante una intervención romántica.
const ROMANCE_TRAIT_HINTS = {
  valentia: 'valiente y directo, defiende lo suyo',
  lealtad: 'leal, se siente traicionado con facilidad',
  sabiduria: 'reflexivo y sereno, acepta argumentos razonados',
  intelecto: 'analítico, valora la lógica y la elocuencia',
  astucia: 'astuto y calculador, busca su propio interés',
  ambicion: 'ambicioso, le importa el estatus y el poder',
  justicia: 'justo y recto, rechaza los atajos',
  empatia: 'empático y abierto, escucha con el corazón',
  responsabilidad: 'responsable y formal, evita escándalos',
  bromista: 'bromista, se toma pocas cosas en serio',
  liderazgo: 'líder, defiende su posición y su imagen'
};
function describeNpcForRomance(state, id) {
  const u = (state.users || []).find(x => Number(x.id) === Number(id));
  if (!u) return null;
  const traits = (Array.isArray(u.personality) ? u.personality : [])
    .map(t => ROMANCE_TRAIT_HINTS[t] || t)
    .join('; ');
  return {
    id: Number(u.id),
    name: u.username,
    house: u.house || 'sin casa',
    trait: u.npc_trait || 'alumno del castillo',
    traits: traits || 'de carácter reservado'
  };
}
function romanceRelScore(state, a, b) {
  const rel = (state.relations || {})[relKeyBetween(a, b)] || {};
  return {
    friendship: Number(rel.friendshipScore) || 0,
    romance: Number(rel.romanceScore) || 0
  };
}
// Respaldo local: heurística determinista si no hay GROQ_API_KEY o falla la IA.
function pickFallbackRomanceIntervention(target, partner, relTarget, relPartner, type, message) {
  const len = String(message || '').trim().length;
  const warm = /amor|querer|juntos|felic|respet|confianza|apoy|compartir|coraz/i.test(message || '');
  const base = type === 'poly' ? 0.25 : 0.35;
  const score = Math.min(1, base + (relTarget.romance / 200) + (len >= 60 ? 0.15 : 0) + (warm ? 0.15 : 0));
  const success = score >= 0.5;
  if (success) {
    return {
      success: true,
      resultType: type,
      message: type === 'poly'
        ? `${target.name} y ${partner.name} lo meditan y deciden darte una oportunidad: el amor puede repartirse sin romperse.`
        : `${target.name} escucha tus palabras, mira a ${partner.name} y decide dar el paso contigo.`,
      consequences: { playerFriendshipLoss: 0, playerRomanceLoss: 0, npcAnger: false },
      fallback: true
    };
  }
  return {
    success: false,
    resultType: 'reject',
    message: type === 'poly'
      ? `${target.name} y ${partner.name} se miran ofendidos: no piensan compartir lo que tienen contigo por medio.`
      : `${target.name} frunce el ceño: su relación con ${partner.name} no se toca por un simple mensaje.`,
    consequences: { playerFriendshipLoss: 20, playerRomanceLoss: 10, npcAnger: true },
    fallback: true
  };
}

app.post('/api/romance-intervention', async (req, res) => {
  const body = req.body || {};
  const playerId = Number(body.playerId);
  const targetId = Number(body.targetId);
  const partnerId = Number(body.partnerId);
  const type = body.type === 'poly' ? 'poly' : 'break';
  const message = String(body.message || '').trim().slice(0, 500);
  const year = clampSchoolYear(body.year);

  if (!message) return res.status(400).json({ error: 'Escribe un mensaje persuasivo.' });

  const state = memoryState;
  const player = (state.users || []).find(u => Number(u.id) === playerId);
  const target = describeNpcForRomance(state, targetId);
  const partner = describeNpcForRomance(state, partnerId);
  if (!player || !target || !partner) return res.status(404).json({ error: 'Personajes no encontrados.' });
  if (targetId === partnerId) return res.status(400).json({ error: 'La pareja no es válida.' });

  const relTarget = romanceRelScore(state, playerId, targetId);
  const relPartner = romanceRelScore(state, playerId, partnerId);

  if (!AI_ENABLED) {
    return res.json({ ok: true, ...pickFallbackRomanceIntervention(target, partner, relTarget, relPartner, type, message) });
  }

  const action = type === 'poly' ? 'proponer poliamor a' : 'intervenir para separar a';
  const systemPrompt = `Eres el árbitro de las relaciones en el castillo de Hogwarts. Evalúa con realismo y drama si dos alumnos NPC aceptarían la propuesta de un jugador. Usa sus personalidades y las puntuaciones actuales para decidir: un NPC posesivo o inseguro rechazará casi siempre; uno libre, empático o sabio puede aceptar. El jugador ${player.username} quiere ${action} la relación entre ${target.name} y ${partner.name}. El mensaje del jugador es: "${message}". Personalidad de ${target.name}: ${target.traits} (rasgo: ${target.trait}). Personalidad de ${partner.name}: ${partner.traits} (rasgo: ${partner.trait}). Amistad del jugador con ${target.name}: ${relTarget.friendship}/100, romance: ${relTarget.romance}/100. Amistad con ${partner.name}: ${relPartner.friendship}/100, romance: ${relPartner.romance}/100. Están en el Año ${year}. Devuelve ÚNICAMENTE un JSON válido sin bloques markdown con este esquema exacto: {"success": true o false, "resultType": "break" | "poly" | "reject", "message": "explicación breve de la reacción en español, en una o dos frases", "consequences": {"playerFriendshipLoss": número, "playerRomanceLoss": número, "npcAnger": true o false}}. Si success es true, resultType debe ser "${type}". Si es false, resultType debe ser "reject".`;

  const aiBody = {
    model: AI_MODEL,
    max_tokens: 320,
    temperature: 0.8,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Decide el desenlace y devuelve el JSON.' }
    ]
  };
  if (/gpt-oss/i.test(AI_MODEL)) aiBody.reasoning_effort = 'low';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const aiRes = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify(aiBody),
      signal: controller.signal
    });
    if (!aiRes.ok) throw new Error(`Groq HTTP ${aiRes.status}`);
    const json = await aiRes.json();
    let raw = String(json?.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const firstBrace = raw.indexOf('{'), lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) raw = raw.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(raw);

    const success = parsed.success === true || parsed.success === 'true';
    let resultType = String(parsed.resultType || '').toLowerCase();
    if (success) resultType = type;
    else resultType = 'reject';
    const reply = String(parsed.message || parsed.reply || '').trim().slice(0, 300)
      || (success ? 'Aceptan tu propuesta.' : 'Rechazan tu propuesta.');
    const c = parsed.consequences && typeof parsed.consequences === 'object' ? parsed.consequences : {};
    const consequences = {
      playerFriendshipLoss: Math.max(0, Math.min(100, Math.round(Number(c.playerFriendshipLoss) || (success ? 0 : 20)))),
      playerRomanceLoss: Math.max(0, Math.min(100, Math.round(Number(c.playerRomanceLoss) || (success ? 0 : 10)))),
      npcAnger: c.npcAnger === true || c.npcAnger === 'true' || (!success)
    };
    return res.json({ ok: true, success, resultType, message: reply, consequences, fallback: false });
  } catch (err) {
    console.error('Error evaluando la intervención romántica (usando respaldo local):', err.message);
    return res.json({ ok: true, ...pickFallbackRomanceIntervention(target, partner, relTarget, relPartner, type, message) });
  } finally {
    clearTimeout(timer);
  }
});

app.use((err, req, res, next) => {
  if (err && (err.name === 'MongooseError' || err.name === 'MongoNetworkError' || err.name === 'MongoServerSelectionError' || (err.message && err.message.includes('buffering timed out')))) {
    console.warn('[AI Studio] Database offline — returning mock empty response');
    if (req.method === 'GET') {
      return res.json(req.path.endsWith('s') || req.path.endsWith('s/') ? [] : {});
    }
    return res.status(503).json({ error: 'Service temporarily unavailable (database offline)' });
  }
  next(err);
});

const uri = process.env.MONGODB_URI;
let client = null;
let db = null;

// Género y preferencia romántica del personaje (creador). Se normalizan siempre.
const FEMALES = ['Hermione Granger', 'Ginny Weasley', 'Luna Lovegood', 'Cho Chang', 'Pansy Parkinson', 'Hannah Abbott', 'Nymphadora Tonks', 'Lyra M.', 'Seraphina K.'];
const GENDER_IDS = ['m', 'f'];
const ROMANCE_PREF_IDS = ['chicos', 'chicas', 'ambos', 'ninguno'];
const normGender = v => GENDER_IDS.includes(v) ? v : 'm';
const normRomancePref = v => ROMANCE_PREF_IDS.includes(v) ? v : 'todos';
const slugify = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

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
  pet: null, petLastUse: null, petLastPlay: null, petLove: 50,
  yearOffset: Number(yearOffset) || 0,
  happiness: 50, pride: 50, academic_progress: 0, animagus_stage: 0,
  attrValentia: 0, attrEmpatia: 0, attrSabiduria: 0,
  spells: [],
  galeones: 15, inv: {}, cromos: {}, inmunidadFilchHasta: 0, buffDobleGaleon: false,
  classStars: {}, lastClassDate: null, classStreak: 0, badges: [],
  patronus: null, patronusImage: null, animagusImage: null,
  // Cumpleaños del personaje (1-12 mes, 1-31 día) y año del último saludo.
  birthDay: null, birthMonth: null, lastBirthdayYear: null,
  gender: FEMALES.includes(username) ? 'f' : 'm',
  romancePref: 'todos',
  quidditch_approved: false,
  // Exploración: Pruebas de Merlín y Caza Nocturna de Estatuas Demiguise.
  merlinTrials: [],
  demiguiseCollected: [],
  demiguiseCarrying: [],
  alohomoraLevel: 1,
  bagCapacity: 5,
  // Parte 4A: hallazgos intangibles (encuentros/avistamientos), oro guardado
  // en la Bóveda de Gringotts y marca del último interés semanal abonado.
  encounters: [],
  vault: 0,
  vaultLastInterest: 0,
  // Enfriamiento de las acciones sociales rápidas (Parte 4A).
  socialCooldowns: {},
  // Exploración avanzada (Tanda 2): páginas de la Guía de Campo, puertas de
  // Aritmancia abiertas, pasadizos secretos, constelaciones y cofres.
  guidePages: [],
  arithmancyDoors: [],
  secretPassages: [],
  constellations: [],
  chests: [],
  // Perfil: varita de Ollivanders, títulos, guardarropa y bestiario (Tandas 4 y 8).
  wand: null,
  title: null,
  unlockedTitles: [],
  unlockedCosmetics: [],
  equippedCosmetics: [],
  bestiary: [],
  look: { facialHair: 'none', ...(look || {}) },
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
  U(213, 'Nymphadora Tonks', 'hufflepuff', 0, 0, 'student', false, { skin: 0, hair: 5, style: 'corto', eyes: 4 }, true, '', 'defensa', '7 años mayor que Harry · Graduada justo antes del Año 1 (Aprendiz de Auror y Metamorfomaga)', true, 7),
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
  { key: 'runas', name: 'Runas Antiguas', points: 4, room: 'biblioteca', minYear: 3 }
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

/* ===== VARITAS, TÍTULOS, GUARDARROPA Y BESTIARIO (Tandas 4 y 8) =====
   La ceremonia de varita de Ollivanders asigna madera, longitud y núcleo. El
   núcleo concede una pasiva REAL que el servidor aplica y valida (nunca solo el
   cliente): Fénix = hallazgos mágicos, Unicornio = Empatía, Dragón = Valentía. */
// Núcleos oficiales de Ollivanders. `axis` es la inclinación del test de la que
// hereda la pasiva real (Fénix = hallazgos, Unicornio = Empatía, Dragón =
// Valentía); `tier` distingue los tres núcleos supremos de los exóticos (más
// raros). `passive` es la pasiva REAL que aplica el servidor.
const WAND_CORES = {
  // Los Tres Núcleos Supremos (máxima calidad de Ollivanders).
  fenix:     { id: 'fenix',     name: 'Pluma de Fénix',             icon: '🪶', tier: 'supremo', axis: 'fenix',
               passive: '+10 % de probabilidad de hallazgos mágicos y recompensas extra.',
               desc: 'El núcleo más raro. Ofrece el mayor rango de magia, gran iniciativa propia y una lealtad muy difícil de ganar.' },
  unicornio: { id: 'unicornio', name: 'Pelo de Cola de Unicornio',  icon: '🦄', tier: 'supremo', axis: 'unicornio',
               passive: '+1 de Empatía efectiva en interacciones y diálogos; estabilidad mágica.',
               desc: 'Produce la magia más consistente, estable y fiel; es difícil inclinarla hacia las Artes Oscuras.' },
  dragon:    { id: 'dragon',    name: 'Fibra de Corazón de Dragón', icon: '🐉', tier: 'supremo', axis: 'dragon',
               passive: '+1 de Valentía efectiva en duelos y pruebas de acción.',
               desc: 'Otorga el mayor poder y hechizos extravagantes; aprende rápido y se vincula con fuerza, aunque es temperamental.' },
  // Núcleos exóticos / especiales (resultados raros del test).
  trueno:    { id: 'trueno',    name: 'Pluma de Ave del Trueno',    icon: '⚡', tier: 'exotico', axis: 'dragon',
               passive: 'Bono en duelos y encantamientos de gran potencia.',
               desc: 'Poderosa y difícil de dominar; premia a quien logra someterla.' },
  thestral:  { id: 'thestral',  name: 'Pelo de Thestral',           icon: '🐴', tier: 'exotico', axis: 'fenix',
               passive: 'Bono en exploración y en el descubrimiento de misterios.',
               desc: 'Inestable y extremadamente rara; solo se deja ver por quien comprende los misterios.' },
  augurey:   { id: 'augurey',   name: 'Cola de Augurey',            icon: '🪶', tier: 'exotico', axis: 'unicornio',
               passive: 'Bono de Sabiduría y en artes adivinatorias.',
               desc: 'Precisa y afinada para la Adivinación; susurra presagios a su dueño.' },
  billywig:  { id: 'billywig',  name: 'Aguijón de Billywig',        icon: '🐝', tier: 'exotico', axis: 'fenix',
               passive: 'Fuerte Encantamiento de Alegría; bono social y de carisma.',
               desc: 'Ligera y juguetona; canaliza con fuerza el Encantamiento de la Alegría.' },
  basilisco: { id: 'basilisco', name: 'Cuerno de Basilisco',        icon: '🐍', tier: 'exotico', axis: 'dragon',
               passive: 'Poder inmenso; exige un dueño de voluntad férrea.',
               desc: 'De poder inmenso y naturaleza temible; exige un dueño de voluntad férrea.' },
  veela:     { id: 'veela',     name: 'Pelo de Veela',              icon: '💫', tier: 'exotico', axis: 'unicornio',
               passive: 'Realza el encanto natural de su portador.',
               desc: 'Fascinante y seductora; realza el encanto natural de su portador.' },
  serpiente_cornuda: { id: 'serpiente_cornuda', name: 'Cuerno de Serpiente Cornuda', icon: '🐲', tier: 'exotico', axis: 'dragon',
               passive: 'Resistencia a las maldiciones y a la magia oscura.',
               desc: 'Resistente a las maldiciones; protege a su dueño de la magia oscura.' },
  monstruo_rio: { id: 'monstruo_rio', name: 'Espina del Monstruo del Río Blanco', icon: '🌊', tier: 'exotico', axis: 'unicornio',
               passive: 'Instinto protector; ideal para quien defiende a los suyos.',
               desc: 'Salvaje y protectora; ideal para magos que defienden a los suyos.' },
  lebrilope: { id: 'lebrilope', name: 'Astas de Lebrílope',         icon: '🐇', tier: 'exotico', axis: 'fenix',
               passive: 'Reflejos rápidos y suerte en la huida.',
               desc: 'Ágil y huidiza; otorga reflejos rápidos y suerte en la huida.' },
  acromantula: { id: 'acromantula', name: 'Telaraña de Acromántula', icon: '🕷️', tier: 'exotico', axis: 'unicornio',
               passive: 'Tenaz y sigilosa; favorece la magia de control.',
               desc: 'Tenaz y sigilosa; teje trampas y favorece la magia de control.' },
  kelpie:    { id: 'kelpie',    name: 'Pelo de Kelpie',             icon: '🐎', tier: 'exotico', axis: 'unicornio',
               passive: 'Afinidad con el agua; tan traicionera como el mar.',
               desc: 'Afinada a las aguas; tan traicionera como el mar que la vio nacer.' },
  rougarou:  { id: 'rougarou',  name: 'Pelo de Rougarou',           icon: '🐺', tier: 'exotico', axis: 'dragon',
               passive: 'Magia salvaje y primigenia.',
               desc: 'Feroz y cambiante; canaliza una magia salvaje y primigenia.' },
  trol:      { id: 'trol',      name: 'Bigote de Trol',             icon: '🧌', tier: 'exotico', axis: 'dragon',
               passive: 'Tosca pero potente; resiste hechizos simples.',
               desc: 'Tosca pero sorprendentemente potente; resiste hechizos simples.' }
};
// Las 20 maderas oficiales de Ollivanders, con el lore que se muestra en el
// Expediente. El catálogo de lore.json puede ampliarlo (se fusiona al arrancar).
const WAND_WOODS = [
  { id: 'acacia',  name: 'Acacia',  lore: 'Sutileza extrema; se niega a realizar magia para cualquiera que no sea su dueño legítimo. Ideal para magos discretos y de talento sutil.' },
  { id: 'aliso',   name: 'Aliso',   lore: 'Servicial y considerado; se adapta bien a hechizos no verbales y busca a un dueño amable y generoso.' },
  { id: 'manzano', name: 'Manzano', lore: 'Para quienes tienen altos ideales y un gran corazón; muy querida y poderosa en manos de un mago bondadoso.' },
  { id: 'fresno',  name: 'Fresno',  lore: 'Fiel a un único dueño durante toda la vida; obstinada y valiente, jamás arrogante.' },
  { id: 'alamo',   name: 'Álamo',   lore: 'De aspecto marfil; ideal para duelistas de mente fuerte y decidida.' },
  { id: 'haya',    name: 'Haya',    lore: 'De comprensión amplia y corazón lleno de empatía; rinde mejor en manos de quien comprende a los demás.' },
  { id: 'abedul',  name: 'Abedul',  lore: 'Asociada a la purificación y a los nuevos comienzos.' },
  { id: 'sauco',   name: 'Saúco',   lore: 'Caprichosa y difícil; solo se somete a un dueño verdaderamente excepcional.' },
  { id: 'espino',  name: 'Espino',  lore: 'Una paradoja: sirve tanto a sanadores como a quienes lanzan maldiciones; refleja el conflicto interno de su dueño.' },
  { id: 'acebo',   name: 'Acebo',   lore: 'Protectora; ayuda a superar la ira y la impulsividad, y acompaña en las búsquedas peligrosas.' },
  { id: 'tejo',    name: 'Tejo',    lore: 'Concede poder sobre la vida y la muerte; la eligen magos de gran destino.' },
  { id: 'roble',   name: 'Roble',   lore: 'Símbolo de fuerza, lealtad y supervivencia, con instinto de autoridad.' },
  { id: 'sauce',   name: 'Sauce',   lore: 'De gran poder curativo, misterio y afinidad por la magia no verbal.' },
  { id: 'cerezo',  name: 'Cerezo',  lore: 'Combina poder, elegancia y un carácter fuerte; destaca en manos decididas.' },
  { id: 'castano', name: 'Castaño', lore: 'Versátil; sus dueños suelen ser jueces expertos del carácter ajeno.' },
  { id: 'cipres',  name: 'Ciprés',  lore: 'De nobleza y misterio; acompaña a valientes dispuestos al sacrificio.' },
  { id: 'abeto',   name: 'Abeto',   lore: 'Madera de supervivientes; resistente, decidida y difícil de doblegar.' },
  { id: 'avellano',name: 'Avellano',lore: 'Sensible y de intuición excepcional; forja una conexión natural con su dueño.' },
  { id: 'olmo',    name: 'Olmo',    lore: 'De gran presencia, dignidad y elegancia; favorece a magos de porte distinguido.' },
  { id: 'vid',     name: 'Vid',     lore: 'Busca las profundidades ocultas y una visión más allá de lo ordinario.' }
];
const WAND_WOOD_IDS = WAND_WOODS.map(w => w.id);
const WAND_LENGTHS = [22, 24, 26, 28, 30, 32, 34, 36];

// Cuestionario de personalidad de Ollivanders. Cada opción declara su eje
// (`axis`) y, opcionalmente, un núcleo exótico (`exotic`) que se concede cuando
// esa respuesta concreta gana por mayoría. El orden de preguntas y opciones
// DEBE coincidir con WAND_QUIZ de index.html.
const WAND_QUIZ = [
  { q: '¿Qué cualidad valoras más en un mago?', opts: [
    { t: 'La capacidad de renacer y seguir adelante', axis: 'fenix' },
    { t: 'La bondad y la lealtad', axis: 'unicornio' },
    { t: 'El coraje para enfrentar el peligro', axis: 'dragon' } ] },
  { q: 'Elige tu lugar favorito del castillo:', opts: [
    { t: 'La Torre de Astronomía, entre las estrellas', axis: 'fenix' },
    { t: 'Los Invernaderos, entre plantas y criaturas', axis: 'unicornio' },
    { t: 'El Aula de Duelos, con la varita en alto', axis: 'dragon' } ] },
  { q: 'Un amigo está en apuros. ¿Qué haces?', opts: [
    { t: 'Busco una solución ingeniosa y creativa', axis: 'fenix' },
    { t: 'Lo consuelo y lo escucho con calma', axis: 'unicornio' },
    { t: 'Salgo a defenderlo sin dudarlo', axis: 'dragon' } ] },
  { q: '¿Qué tipo de magia te atrae más?', opts: [
    { t: 'Encantamientos versátiles y transformadores', axis: 'fenix' },
    { t: 'Herbología y cuidado de criaturas', axis: 'unicornio' },
    { t: 'Defensa contra las Artes Oscuras', axis: 'dragon' } ] },
  { q: 'Ante una derrota, tú…', opts: [
    { t: 'Aprendes y te reinventas para la próxima', axis: 'fenix' },
    { t: 'Reflexionas y apoyas a los tuyos', axis: 'unicornio' },
    { t: 'Te levantas y vuelves a intentarlo con más fuerza', axis: 'dragon' } ] }
];

// Deriva el núcleo de la varita a partir de las respuestas. El eje ganador
// (Fénix, Unicornio o Dragón) es la inclinación dominante del test. Cuando el
// perfil es DECIDIDO (un eje con al menos 4 de 5 respuestas, sin empates), el
// jugador puede recibir un núcleo exótico de ese eje; el exótico concreto se
// deriva de forma determinista del patrón exacto de respuestas (resultado raro
// y específico). Si no, se entrega el núcleo supremo del eje ganador.
function pickWandCore(answers) {
  const list = Array.isArray(answers) ? answers : [];
  const axisTally = { fenix: 0, unicornio: 0, dragon: 0 };
  list.forEach((a, i) => {
    const q = WAND_QUIZ[i];
    const opt = q && q.opts[Number(a)];
    if (opt && axisTally[opt.axis] !== undefined) axisTally[opt.axis] += 1;
  });
  const axis = Object.keys(axisTally).sort((a, b) => axisTally[b] - axisTally[a] || 0)[0] || 'fenix';
  const top = axisTally[axis];
  const tied = Object.values(axisTally).filter(v => v === top).length > 1;
  if (!tied && top >= 4) {
    const pool = Object.keys(WAND_CORES).filter(id => WAND_CORES[id].tier === 'exotico' && WAND_CORES[id].axis === axis);
    if (pool.length) {
      // Hash determinista del patrón de respuestas (mismo test -> mismo núcleo).
      const h = list.reduce((acc, v, i) => (acc * 131 + (Number(v) + 1) * 17 + i * 3) % 1000003, 23);
      // No todos los perfiles decididos dan un exótico: aproximadamente la mitad.
      if (h % 2 === 0) return pool[(h >> 1) % pool.length];
    }
  }
  return axis;
}
// ¿El núcleo tiene la pasiva de un eje concreto (p. ej. Valentía del Dragón)?
function wandAxisOf(coreId) { return WAND_CORES[coreId] ? WAND_CORES[coreId].axis : null; }
// Nombre y lore de una madera (catálogo fusionado).
function wandWoodInfo(id) {
  return WAND_WOODS.find(w => w.id === id) || null;
}
function wandCoreInfo(id) { return WAND_CORES[id] || null; }

// Títulos equipables: visibles junto al nombre en el chat y el registro.
const TITLES = {
  aprendiz:       { id: 'aprendiz',       name: 'Aprendiz de Primer Año', icon: '🎓', desc: 'Recién llegado a Hogwarts.' },
  elegido_varita: { id: 'elegido_varita', name: 'Elegido por la Varita',  icon: '🪄', desc: 'Completaste la ceremonia de Ollivanders.' },
  merlin:         { id: 'merlin',         name: 'Discípulo de Merlín',    icon: '🌿', desc: 'Superaste todas las Pruebas de Merlín.' },
  demiguise:      { id: 'demiguise',      name: 'Cazador de Lunas',       icon: '🌙', desc: 'Recuperaste todas las Estatuas Demiguise.' },
  coleccionista:  { id: 'coleccionista',  name: 'Coleccionista de Cromos', icon: '🐸', desc: 'Completaste el Álbum de Cromos.' },
  magizoologo:    { id: 'magizoologo',    name: 'Magizoólogo',            icon: '🦅', desc: 'Registraste muchas criaturas en tu Bestiario.' },
  enciclopedista: { id: 'enciclopedista', name: 'Enciclopedista',         icon: '📚', desc: 'Dominas la Guía de Campo del castillo.' },
  // Tanda 2: exploración avanzada.
  aritmante:      { id: 'aritmante',      name: 'Aritmante',              icon: '🔢', desc: 'Resolviste una puerta de Aritmancia.' },
  contrabandista: { id: 'contrabandista', name: 'Contrabandista',         icon: '🗺️', desc: 'Descubriste un pasadizo secreto del castillo.' },
  astronomo:      { id: 'astronomo',      name: 'Astrónomo',              icon: '🔭', desc: 'Trazaste todas las constelaciones mágicas.' },
  ladron_experto: { id: 'ladron_experto', name: 'Ladrón Experto',         icon: '🗝️', desc: 'Abriste todos los cofres con Alohomora.' },
  // Tanda 3: clubes extracurriculares y exámenes oficiales.
  club_esfinge:        { id: 'club_esfinge',        name: 'Esfinge del Club',        icon: '🐈', desc: 'Alcanzaste el nivel 3 del Club de la Esfinge.' },
  club_esfinge_maestro:{ id: 'club_esfinge_maestro',name: 'Maestro de la Esfinge',  icon: '🐈', desc: 'Alcanzaste el nivel 8 del Club de la Esfinge.' },
  club_hipogrifo:        { id: 'club_hipogrifo',        name: 'Hipogrifo del Club',   icon: '🦅', desc: 'Alcanzaste el nivel 3 del Club del Hipogrifo.' },
  club_hipogrifo_maestro:{ id: 'club_hipogrifo_maestro',name: 'Maestro del Hipogrifo',icon: '🦅', desc: 'Alcanzaste el nivel 8 del Club del Hipogrifo.' },
  club_dragon:        { id: 'club_dragon',        name: 'Dragón del Club',         icon: '🐉', desc: 'Alcanzaste el nivel 3 del Club del Dragón.' },
  club_dragon_maestro:{ id: 'club_dragon_maestro',name: 'Maestro del Dragón',      icon: '🐉', desc: 'Alcanzaste el nivel 8 del Club del Dragón.' },
  // Títulos permanentes de los exámenes oficiales (Tanda 3.1).
  auror_formacion:  { id: 'auror_formacion',  name: 'Auror en formación',  icon: '🛡️', desc: 'Superaste los exámenes con distinción en DCAO.' },
  sanador:          { id: 'sanador',          name: 'Sanador',             icon: '💊', desc: 'Superaste los exámenes con distinción en Pociones y Herbología.' },
  magizoologo_exam: { id: 'magizoologo_exam', name: 'Magizoólogo titulado', icon: '🦅', desc: 'Superaste los exámenes con distinción en Criaturas y Herbología.' },
  encantador_experto:{ id: 'encantador_experto',name: 'Encantador Experto', icon: '✨', desc: 'Superaste los exámenes con distinción en Encantamientos y Transformaciones.' },
  maestro_pociones: { id: 'maestro_pociones', name: 'Maestro de Pociones',  icon: '🧪', desc: 'Superaste los exámenes con distinción en Pociones.' }
};

// Número de peinados del catálogo del cliente (index.html: HAIR_STYLES). Se usa
// para acotar el índice de peinado de cada jugador y evitar valores fuera de rango.
const HAIR_STYLE_COUNT = 20;

/* ===== BALANCE CENTRALIZADO (Tanda 8.5) =====
   Fuente de verdad de todas las ganancias de Galeones, costos y XP para que la
   progresión sea fluida en sesiones grupales de 30–45 min sin inflación. */
const GAME_BALANCE = {
  clubs: {
    xpPerStar: 6,        // XP de club por estrella de clase en materias afines
    xpPerPractical: 12,  // XP de club por práctica de minijuego de la materia
    xpPerExploration: 15,// XP de club por hitos de exploración afines (aritmancia…)
    levelStep: 40,       // XP necesaria por nivel de club
    maxLevel: 10
  },
  potions:  { xp: 22, housePoints: 10, galeones: 6, clubXp: 14 },
  herbology:{ xp: 20, housePoints: 8,  galeones: 5, clubXp: 12 },
  exams:    { galeones: 40, housePoints: 25, clubXp: 25 },
  defense:  { maxPenalty: 15 },
  // Curva unificada de atributos (servidor y cliente comparten estos tramos).
  attributes: {
    maxLevel: 5,
    curve: [
      { level: 1, min: 0,  max: 9 },
      { level: 2, min: 10, max: 19 },
      { level: 3, min: 20, max: 34 },
      { level: 4, min: 35, max: 49 },
      { level: 5, min: 50, max: null }
    ],
    // Acción social rápida: sube atributos además de la afinidad.
    social: {
      chat: { label: 'Charlar', icon: '💬', attr: 'empatia',  points: 2, affinity: 8 },
      help: { label: 'Ayudar',  icon: '🤲', attr: 'valentia', points: 2, empathy: 1, affinity: 10 },
      cooldownMs: 12000
    }
  },
  // Bóveda de Gringotts: interés semanal pasivo sobre el oro depositado.
  bank: { weeklyRate: 0.05, weekMs: 7 * 24 * 60 * 60 * 1000, minMove: 1, maxBalance: 999999 },
  // Mercadillo entre jugadores: límites de ofertas y cantidades por intercambio.
  market: { maxOffers: 200, maxQty: 10 },
  // Cumpleaños: descuento en Honeydukes y Zonko.
  birthday: { discount: 0.5, minPrice: 1 },
  // Cestas de regalo: afinidad base y multiplicador por regalo favorito del NPC.
  gifts: { baseAffinity: 12, favoriteMultiplier: 2 },
  // Quidditch avanzado (Parte 4B): aros de entrenamiento, pasivas por posición,
  // apuestas amistosas, desafíos semanales y clausura de curso.
  quidditch: {
    // Aros de Entrenamiento Aéreo (Tanda 7.1): minijuego libre en los terrenos.
    hoops: { xpPerRing: 3, galeonesPerRing: 1, clubXpPerRing: 2, maxRings: 40, minDurationMs: 2500, cooldownMs: 45000 },
    // Especialización por posición (Tanda 7.2): pasivas reales aplicadas al partido.
    positions: {
      Buscador:  { label: 'Buscador',  icon: '🧹', desc: '+18 % de atrapar la Snitch (vale 150 pts).', snitchBonus: 0.18 },
      Cazador:   { label: 'Cazador',   icon: '🏐', desc: '+15 % de anotar con la Quaffle (10 pts por gol).', quaffleBonus: 0.15 },
      Golpeador: { label: 'Golpeador', icon: '🏏', desc: 'Reduce un 12 % la precisión rival con las Bludgers.', bludgerPenalty: 0.12 },
      Guardián:  { label: 'Guardián',  icon: '🥅', desc: '+20 % de parar los tiros rivales.', blockBonus: 0.20 }
    },
    // Apuestas amistosas (Tanda 5.4): hasta 20 Galeones por una casa.
    bets: { min: 1, max: 20, payout: 2 },
    // Desafíos semanales cooperativos por casa (Tanda 7.4).
    weekly: { targetMatches: 3, targetPoints: 300, targetSnitches: 2, rewardGaleones: 40, rewardPoints: 30 },
    // Ceremonia de clausura de curso (Tanda 7.5).
    closure: { rewardGaleones: 100, mvpPoints: 50 }
  }
};

/* Curva unificada de atributos: 0–9 Nv.1 · 10–19 Nv.2 · 20–34 Nv.3 ·
   35–49 Nv.4 · 50+ Nv.5. Una sola fuente de verdad para servidor y cliente. */
const ATTR_CURVE = GAME_BALANCE.attributes.curve;
function attrLevelFromPoints(points) {
  const p = Math.max(0, Math.floor(Number(points) || 0));
  for (let i = ATTR_CURVE.length - 1; i >= 0; i--) {
    if (p >= ATTR_CURVE[i].min) return ATTR_CURVE[i].level;
  }
  return 1;
}
// Progreso del atributo para las tarjetas: nivel, puntos actuales, umbral
// siguiente y porcentaje de la barra dentro del nivel actual.
function attrProgress(points) {
  const p = Math.max(0, Math.floor(Number(points) || 0));
  const level = attrLevelFromPoints(p);
  if (level >= GAME_BALANCE.attributes.maxLevel) {
    return { level, current: p, next: null, base: ATTR_CURVE[level - 1].min, pct: 100 };
  }
  const base = ATTR_CURVE[level - 1].min;
  const next = ATTR_CURVE[level].min;
  const span = Math.max(1, next - base);
  return { level, current: p, next, base, pct: Math.max(0, Math.min(100, Math.round((p - base) / span * 100))) };
}
// Precio de un objeto en Hogsmeade/Zonco aplicando el descuento de cumpleaños.
function birthdayPrice(base, isBirthday) {
  const price = Math.max(0, Math.floor(Number(base) || 0));
  if (!isBirthday) return price;
  const rate = GAME_BALANCE.birthday.discount;
  return Math.max(GAME_BALANCE.birthday.minPrice, Math.round(price * (1 - rate)));
}

/* ===== PARTE 4B: QUIDDITCH AVANZADO Y COPA DE LAS CASAS =====
   Todo se valida y se resuelve en el servidor: aros de entrenamiento, pasivas
   por posición, apuestas, desafíos semanales y ceremonia de clausura. */
// Orden de posiciones al alinearse (espejo del cliente, index.html: POSITIONS).
const QUIDDITCH_POSITIONS = ['Buscador', 'Cazador', 'Cazador', 'Cazador', 'Golpeador', 'Golpeador', 'Guardián'];
// Acciones válidas por posición (espejo del cliente, index.html: ACTIONS).
const QUIDDITCH_ACTIONS = {
  Cazador:   ['attack', 'defend'],
  Guardián:  ['block', 'idle'],
  Buscador:  ['search', 'idle'],
  Golpeador: ['hit', 'idle']
};
// Pasiva de una posición (o null si la posición no tiene pasiva).
function positionPassive(pos) {
  return GAME_BALANCE.quidditch.positions[pos] || null;
}
// Recompensa de una partida de aros: XP de vuelo, Galeones y XP de club (Dragón).
function hoopsReward(rings) {
  const b = GAME_BALANCE.quidditch.hoops;
  const n = Math.max(0, Math.min(b.maxRings, Math.floor(Number(rings) || 0)));
  return { rings: n, xp: n * b.xpPerRing, galeones: n * b.galeonesPerRing, clubXp: n * b.clubXpPerRing };
}
// Valida una partida de Aros de Entrenamiento Aéreo enviada por el cliente.
// Devuelve { ok, message } — la recompensa se calcula con hoopsReward().
function validateHoopsRun(data, user) {
  if (!user) return { ok: false, message: 'Inicia sesión con tu personaje primero.' };
  const b = GAME_BALANCE.quidditch.hoops;
  const rings = Math.floor(Number(data && data.rings));
  if (!Number.isFinite(rings) || rings < 0) return { ok: false, message: 'Resultado de entrenamiento inválido.' };
  if (rings > b.maxRings) return { ok: false, message: 'Demasiados aros para una sola partida.' };
  const durationMs = Math.floor(Number(data && data.durationMs));
  if (!Number.isFinite(durationMs) || durationMs < b.minDurationMs) {
    return { ok: false, message: 'La partida fue demasiado corta para contar.' };
  }
  const last = (user.socialCooldowns && Number(user.socialCooldowns.hoops)) || 0;
  if (last && Date.now() - last < b.cooldownMs) {
    return { ok: false, message: `Reposa un momento antes de volver a entrenar (${Math.ceil((b.cooldownMs - (Date.now() - last)) / 1000)} s).` };
  }
  return { ok: true };
}

// Normaliza la lista de apuestas de un partido: solo ids reales, casas válidas
// del partido, importes dentro de los límites y una apuesta por jugador.
function sanitizeMatchBets(bets, match) {
  const b = GAME_BALANCE.quidditch.bets;
  const houses = match ? [match.a, match.b] : [];
  const byUser = new Map();
  (Array.isArray(bets) ? bets : []).forEach(x => {
    if (!x || typeof x !== 'object') return;
    const uid = Number(x.uid);
    const house = String(x.house || '');
    const amount = Math.floor(Number(x.amount));
    if (!uid || !houses.includes(house)) return;
    if (!Number.isFinite(amount) || amount < b.min || amount > b.max) return;
    if (byUser.has(uid)) return;
    byUser.set(uid, { uid, house, amount, at: Number(x.at) || Date.now() });
  });
  return [...byUser.values()];
}
// Liquida las apuestas de un partido ya terminado. Devuelve los movimientos a
// aplicar (créditos a los acertantes) sin tocar todavía los usuarios.
function settleMatchBets(match) {
  const b = GAME_BALANCE.quidditch.bets;
  const winner = match && match.winner;
  return (Array.isArray(match && match.bets) ? match.bets : []).map(bet => {
    const won = !!winner && winner !== 'empate' && bet.house === winner;
    return { uid: bet.uid, house: bet.house, amount: bet.amount, won, payout: won ? bet.amount * b.payout : 0 };
  });
}

// ---- Desafíos semanales cooperativos por casa (Tanda 7.4) ----
// Clave de la semana en curso (bloques de 7 días desde el epoch).
function currentWeekKey(now = Date.now()) {
  return Math.floor(now / (7 * 24 * 60 * 60 * 1000));
}
const WEEKLY_HOUSE_IDS = ['gryffindor', 'slytherin', 'ravenclaw', 'hufflepuff'];
function emptyWeeklyHouse() {
  return { matches: 0, points: 0, snitches: 0, claimed: false };
}
// Normaliza los desafíos semanales: si cambia la semana, se reinician a cero.
function sanitizeWeeklyChallenges(raw, now = Date.now()) {
  const wk = currentWeekKey(now);
  const out = { weekKey: wk, houses: {} };
  WEEKLY_HOUSE_IDS.forEach(id => { out.houses[id] = emptyWeeklyHouse(); });
  if (!raw || typeof raw !== 'object' || Number(raw.weekKey) !== wk) return out;
  WEEKLY_HOUSE_IDS.forEach(id => {
    const h = raw.houses && raw.houses[id];
    if (!h || typeof h !== 'object') return;
    out.houses[id] = {
      matches: Math.max(0, Math.floor(Number(h.matches) || 0)),
      points: Math.max(0, Math.floor(Number(h.points) || 0)),
      snitches: Math.max(0, Math.floor(Number(h.snitches) || 0)),
      claimed: !!h.claimed
    };
  });
  return out;
}
// Registra el resultado de un partido en los desafíos de ambas casas.
function applyMatchToWeekly(state, match) {
  state.weeklyChallenges = sanitizeWeeklyChallenges(state.weeklyChallenges);
  const w = GAME_BALANCE.quidditch.weekly;
  [match.a, match.b].forEach(house => {
    const h = state.weeklyChallenges.houses[house];
    if (!h) return;
    h.matches += 1;
    h.points += house === match.a ? Number(match.sa) || 0 : Number(match.sb) || 0;
    if (match.caught === house) h.snitches += 1;
  });
}
// ¿Ha completado la casa todos los objetivos semanales?
function weeklyGoalsMet(houseState) {
  const w = GAME_BALANCE.quidditch.weekly;
  if (!houseState) return false;
  return houseState.matches >= w.targetMatches && houseState.points >= w.targetPoints && houseState.snitches >= w.targetSnitches;
}

// ---- Ceremonia de clausura de curso (Tanda 7.5) ----
// Construye el resumen de clausura: campeón, MVP por casa, prefectos y delegados.
function buildClosureSummary(state) {
  const houses = (state.houses || []).slice().sort((x, y) => (Number(y.points) || 0) - (Number(x.points) || 0));
  const champion = houses[0] ? houses[0].id : null;
  const enrolled = (state.users || []).filter(u => !u.is_npc || u.npc_decided !== false);
  const mvpByHouse = {};
  WEEKLY_HOUSE_IDS.forEach(id => {
    const pool = (state.users || []).filter(u => u.house === id && !u.is_npc);
    const best = pool.sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0))[0];
    mvpByHouse[id] = best ? { id: best.id, username: best.username, points: Number(best.points) || 0 } : null;
  });
  const prefects = enrolled.filter(u => u.role === 'prefect').map(u => ({ id: u.id, username: u.username, house: u.house }));
  const delegates = enrolled.filter(u => u.role === 'delegado').map(u => ({ id: u.id, username: u.username, house: u.house }));
  return { champion, houses, mvpByHouse, prefects, delegates, at: Date.now() };
}

// ---- Crónica de Lee Jordan (Tanda 7.3) ----
// Resumen local de 3 líneas con nombres reales (respaldo si Groq no responde).
function buildMatchChronicleFallback(match, state) {
  const houseName = id => {
    const H = { gryffindor: 'Gryffindor', slytherin: 'Slytherin', ravenclaw: 'Ravenclaw', hufflepuff: 'Hufflepuff' };
    return H[id] || id;
  };
  const scorers = (match.players || []).filter(p => p.pos === 'Cazador').slice(0, 2).map(p => p.username).filter(Boolean);
  const seeker = (match.players || []).find(p => p.pos === 'Buscador' && p.house === match.caught);
  const keeper = (match.players || []).find(p => p.pos === 'Guardián');
  const lines = [];
  lines.push(`¡${houseName(match.a)} ${match.sa} - ${match.sb} ${houseName(match.b)}! Un partido de los que hacen época en el Estadio de Hogwarts.`);
  if (seeker) lines.push(`El buscador ${seeker.username} de ${houseName(seeker.house)} atrapó la Snitch Dorada y desató el delirio de la grada.`);
  else if (scorers.length) lines.push(`Los cazadores ${scorers.join(' y ')} castigaron los aros rivales una y otra vez sin piedad.`);
  else lines.push(`El marcador se movió a base de bludgers y Quaffles hasta el último silbato.`);
  if (match.winner && match.winner !== 'empate') {
    lines.push(`Con el triunfo de ${houseName(match.winner)}, ${keeper ? `${keeper.username} y ` : ''}la Copa de las Casas tiembla: ¡esto no ha hecho más que empezar!`);
  } else {
    lines.push(`Empate agónico: ni la Snitch quiso decidir el vencedor esta vez. ¡Vuelta a los vestuarios con la cabeza bien alta!`);
  }
  return { lines: lines.slice(0, 3), fallback: true, at: Date.now() };
}
// Normaliza la crónica generada por la IA: exactamente 3 líneas no vacías.
function normalizeChronicle(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const lines = (Array.isArray(src.lines) ? src.lines : (Array.isArray(src) ? src : []))
    .map(l => String(l == null ? '' : l).trim().slice(0, 300)).filter(Boolean).slice(0, 3);
  if (lines.length < 3) return fallback;
  return { lines, fallback: false, at: Date.now() };
}
// Genera la crónica épica con Groq (Lee Jordan) y, si falla, usa el respaldo.
async function generateMatchChronicle(match, state) {
  const fallback = buildMatchChronicleFallback(match, state);
  if (!AI_ENABLED) return fallback;
  const houseName = id => ({ gryffindor: 'Gryffindor', slytherin: 'Slytherin', ravenclaw: 'Ravenclaw', hufflepuff: 'Hufflepuff' }[id] || id);
  const roster = (match.players || []).map(p => `${p.username} (${p.pos}, ${houseName(p.house)})`).join(', ') || 'jugadores anónimos';
  const systemPrompt = `Eres Lee Jordan, el legendario comentarista de Quidditch de Hogwarts: eufórico, gracioso y parcial, con humor británico y sin salirte del canon de Harry Potter (nada del mundo real ni de IA). Escribes SIEMPRE en español. Devuelve ÚNICAMENTE un JSON válido sin bloques markdown con esta forma: {"lines":["línea 1","línea 2","línea 3"]}. Cada línea es una frase breve y épica; en total EXACTAMENTE 3 líneas.`;
  const userPrompt = `Partido terminado: ${houseName(match.a)} ${match.sa} - ${match.sb} ${houseName(match.b)}. Ganador: ${match.winner === 'empate' ? 'empate' : houseName(match.winner)}. Snitch atrapada por: ${match.caught ? houseName(match.caught) : 'nadie'}. Alineación: ${roster}. Narra la crónica final en 3 líneas.`;
  try {
    const parsed = await aiChatJSON({ systemPrompt, userPrompt, maxTokens: 400, temperature: 0.9, reasoning: 'low' });
    return normalizeChronicle(parsed, fallback);
  } catch (err) {
    console.error('Error generando la crónica de Lee Jordan (usando respaldo local):', err.message);
    return fallback;
  }
}

/* ===== CLUBES EXTRACURRICULARES (Tanda 3.2) =====
   Tres clubes que suben automáticamente al ganar XP en sus materias afines. El
   servidor es la fuente de verdad: aquí se mapean las materias y los hitos. */
const CLUBS = {
  esfinge: {
    id: 'esfinge', name: 'Club de la Esfinge', icon: '🐈', color: '#4a6ee0',
    desc: 'Ingenio y precisión: Encantamientos, Astronomía, Transformaciones y Runas.',
    subjects: ['encantamientos', 'astronomia', 'transformaciones', 'runas']
  },
  hipogrifo: {
    id: 'hipogrifo', name: 'Club del Hipogrifo', icon: '🦅', color: '#e8b930',
    desc: 'Saberes vivos: Pociones, Herbología y Cuidado de Criaturas Mágicas.',
    subjects: ['pociones', 'herbologia', 'criaturas']
  },
  dragon: {
    id: 'dragon', name: 'Club del Dragón', icon: '🐉', color: '#c43b34',
    desc: 'Coraje y acción: Duelos (DCAO), Vuelo y Quidditch.',
    subjects: ['defensa', 'vuelo', 'quidditch']
  }
};
const CLUB_IDS = Object.keys(CLUBS);
// Hito de club: nivel en el que se entrega cada recompensa (se aplica al subir).
const CLUB_MILESTONES = {
  2:  { galeones: 15 },
  3:  { title: true, galeones: 20 },     // título del club
  5:  { cosmetic: true, galeones: 30 },  // insignia del club
  8:  { titleMaster: true, galeones: 50 }// título de maestro del club
};
// Devuelve el id de club al que pertenece una materia (o null).
function clubForSubject(subject) {
  const key = String(subject || '').trim().toLowerCase();
  return CLUB_IDS.find(id => CLUBS[id].subjects.includes(key)) || null;
}
// XP acumulada de un club para un jugador (0 si aún no tiene el campo).
function clubXpOf(user, clubId) {
  const c = user && user.clubs;
  return Math.max(0, Number(c && c[clubId]) || 0);
}
// Nivel de un club a partir de su XP (1..maxLevel).
function clubLevelOf(user, clubId) {
  const xp = clubXpOf(user, clubId);
  const lvl = Math.floor(xp / GAME_BALANCE.clubs.levelStep) + 1;
  return Math.max(1, Math.min(GAME_BALANCE.clubs.maxLevel, lvl));
}
// Aplica las recompensas de los hitos alcanzados al subir de nivel y devuelve
// la lista de títulos nuevos. Los hitos ya entregados quedan registrados.
function applyClubMilestones(user, clubId) {
  const level = clubLevelOf(user, clubId);
  user.clubMilestones = (user.clubMilestones && typeof user.clubMilestones === 'object') ? user.clubMilestones : {};
  const reached = Math.max(0, Math.floor(Number(user.clubMilestones[clubId]) || 0));
  const newTitles = [];
  const rewards = [];
  for (let lv = reached + 1; lv <= level; lv++) {
    const m = CLUB_MILESTONES[lv];
    if (!m) continue;
    if (m.galeones) { user.galeones = (Number(user.galeones) || 0) + m.galeones; rewards.push(`+${m.galeones} 🪙`); }
    if (m.title && grantTitle(user, `club_${clubId}`)) { newTitles.push(`club_${clubId}`); rewards.push(`🏅 Título del club`); }
    if (m.titleMaster && grantTitle(user, `club_${clubId}_maestro`)) { newTitles.push(`club_${clubId}_maestro`); rewards.push(`🏅 Maestro del club`); }
    if (m.cosmetic && COSMETICS[`insignia_${clubId}`]) {
      user.unlockedCosmetics = Array.isArray(user.unlockedCosmetics) ? user.unlockedCosmetics : [];
      if (!user.unlockedCosmetics.includes(`insignia_${clubId}`)) {
        user.unlockedCosmetics.push(`insignia_${clubId}`);
        rewards.push(`👗 Insignia del club`);
      }
    }
  }
  user.clubMilestones[clubId] = level;
  return { newTitles, rewards, level };
}
// Suma XP a un club (acotada), aplica hitos y devuelve un resumen.
function awardClubXp(user, clubId, amount) {
  if (!user || !CLUBS[clubId]) return null;
  const add = Math.max(0, Math.min(500, Math.floor(Number(amount) || 0)));
  if (!add) return null;
  user.clubs = (user.clubs && typeof user.clubs === 'object') ? user.clubs : {};
  const before = clubLevelOf(user, clubId);
  user.clubs[clubId] = clubXpOf(user, clubId) + add;
  const after = clubLevelOf(user, clubId);
  const ms = applyClubMilestones(user, clubId);
  return { clubId, gained: add, xp: user.clubs[clubId], level: after, levelUp: after > before, rewards: ms.rewards, newTitles: ms.newTitles };
}
// Resumen de los tres clubes para el expediente del jugador.
function clubSummary(user) {
  return CLUB_IDS.map(id => ({
    id, name: CLUBS[id].name, icon: CLUBS[id].icon, color: CLUBS[id].color, desc: CLUBS[id].desc,
    xp: clubXpOf(user, id), level: clubLevelOf(user, id),
    nextLevelXp: clubLevelOf(user, id) * GAME_BALANCE.clubs.levelStep,
    step: GAME_BALANCE.clubs.levelStep, maxLevel: GAME_BALANCE.clubs.maxLevel
  }));
}

/* ===== TANDA 3.3: CALDERO DE POCIONES POR PASOS =====
   El servidor conoce el orden correcto de los ingredientes, el rango de
   removidos y el número de aciertos de fuego; valida la partida del cliente
   antes de conceder ninguna recompensa. */
const POTION_RECIPES = {
  filtro_paz: {
    id: 'filtro_paz', name: 'Filtro de la Paz', icon: '🫧', year: 1, club: 'hipogrifo',
    desc: 'Un brebaje calmante que serena los ánimos más exaltados.',
    ingredients: [{ id: 'menta', name: 'Hojas de Menta', icon: '🌿' }, { id: 'lavanda', name: 'Lavanda', icon: '💜' }, { id: 'luna', name: 'Polvo de Luna', icon: '🌙' }],
    stirs: [4, 7], heat: [2, 4]
  },
  amortentia: {
    id: 'amortentia', name: 'Amortentia', icon: '💗', year: 4, club: 'hipogrifo',
    desc: 'El filtro de amor más poderoso; cada quien huele lo que más le atrae.',
    ingredients: [{ id: 'rosa', name: 'Pétalos de Rosa', icon: '🌹' }, { id: 'perla', name: 'Perlas Molidas', icon: '🦪' }, { id: 'sirena', name: 'Escamas de Sirena', icon: '🧜' }, { id: 'menta', name: 'Hojas de Menta', icon: '🌿' }],
    stirs: [6, 9], heat: [3, 5]
  },
  felix: {
    id: 'felix', name: 'Felix Felicis', icon: '🍀', year: 6, club: 'hipogrifo',
    desc: 'La suerte líquida: requiere una destreza excepcional en cada paso.',
    ingredients: [{ id: 'triton', name: 'Huevas de Tritón', icon: '🥚' }, { id: 'ocumo', name: 'Ráiz de Ocomu', icon: '🥕' }, { id: 'escarbato', name: 'Esencia de Escarbato', icon: '🦡' }, { id: 'sol', name: 'Espliego al Sol', icon: '☀️' }],
    stirs: [8, 11], heat: [4, 6]
  }
};
// Plantas del invernadero (Tanda 3.4): cada una exige una acción correcta y rápida.
const HERBOLOGY_PLANTS = {
  mandragora:  { id: 'mandragora',  name: 'Mandrágora',            icon: '🌱', action: 'orejeras',  hint: '¡Ponte las orejeras antes de sacarla!', club: 'hipogrifo' },
  tentacula:   { id: 'tentacula',   name: 'Tentácula Venenosa',    icon: '🌿', action: 'podar',     hint: 'Poda las zarcillos con las tijeras.',   club: 'hipogrifo' },
  lazo_diablo: { id: 'lazo_diablo', name: 'Lazo del Diablo',       icon: '🕸️', action: 'lumos',     hint: 'Lánzale Lumos Solem para que retroceda.', club: 'hipogrifo' },
  bubotubero:  { id: 'bubotubero',  name: 'Bubotubérculo',         icon: '🫧', action: 'drenar',    hint: 'Drena el pus con guantes protectores.',   club: 'hipogrifo' }
};
const HERBOLOGY_ACTIONS = {
  orejeras: { id: 'orejeras', label: 'Ponte las orejeras', icon: '🎧' },
  podar:    { id: 'podar',    label: 'Poda las zarcillos', icon: '✂️' },
  lumos:    { id: 'lumos',    label: 'Lanza Lumos Solem',  icon: '🔆' },
  drenar:   { id: 'drenar',   label: 'Drena con guantes',  icon: '🧤' }
};

/* ===== TANDA 3.1: EXÁMENES OFICIALES (T.I.M.O. / É.X.T.A.S.I.S.) =====
   Combina preguntas evaluadas con Groq (con respaldo local) y una prueba
   práctica. El servidor guarda las respuestas correctas y califica. */
const EXAM_TYPES = {
  timo:    { id: 'timo',    name: 'T.I.M.O.',      year: 5, questionCount: 5, passRatio: 0.6, galeones: GAME_BALANCE.exams.galeones, housePoints: GAME_BALANCE.exams.housePoints },
  extasis: { id: 'extasis', name: 'É.X.T.A.S.I.S.', year: 7, questionCount: 6, passRatio: 0.6, galeones: GAME_BALANCE.exams.galeones * 2, housePoints: GAME_BALANCE.exams.housePoints * 2 }
};
// Asignaturas examinables y el título que otorga una distinción (nota alta).
const EXAM_SUBJECTS = {
  encantamientos:   { name: 'Encantamientos',        title: 'encantador_experto',   attr: 'attrSabiduria' },
  transformaciones: { name: 'Transformaciones',       title: 'encantador_experto',   attr: 'attrValentia' },
  pociones:         { name: 'Pociones',               title: 'maestro_pociones',     attr: 'attrSabiduria' },
  herbologia:       { name: 'Herbología',             title: 'magizoologo_exam',     attr: 'attrEmpatia' },
  criaturas:        { name: 'Cuidado de Criaturas',   title: 'magizoologo_exam',     attr: 'attrEmpatia' },
  defensa:          { name: 'DCAO',                   title: 'auror_formacion',      attr: 'attrValentia' },
  historia:         { name: 'Historia de la Magia',   title: null,                   attr: 'attrSabiduria' },
  astronomia:       { name: 'Astronomía',             title: null,                   attr: 'attrSabiduria' }
};
const EXAM_SUBJECT_IDS = Object.keys(EXAM_SUBJECTS);

// Guardarropa: prendas cosméticas desbloqueables y equipables. Debe incluir
// TODAS las prendas icónicas del cliente (ICONIC_COSMETICS) para no borrar los
// desbloqueos ya conseguidos, más las prendas nuevas de las Tandas 4 y 8.
const COSMETICS = {
  gafas_harry:     { id: 'gafas_harry',     name: 'Gafas Redondas de Harry',     icon: '👓' },
  libro_hermione:  { id: 'libro_hermione',  name: 'Libro Encantado de Hermione', icon: '📖' },
  bufanda_weasley: { id: 'bufanda_weasley', name: 'Bufanda de la Sra. Weasley',  icon: '🧣' },
  sombrero_ginny:  { id: 'sombrero_ginny',  name: 'Sombrero de Gryffindor',      icon: '🎩' },
  guantes_neville: { id: 'guantes_neville', name: 'Guantes de Herbología',       icon: '🌱' },
  gafas_luna:      { id: 'gafas_luna',      name: 'Gafas de Luna',               icon: '👓' },
  pluma_cho:       { id: 'pluma_cho',       name: 'Pluma de Ravenclaw',          icon: '🪶' },
  broche_draco:    { id: 'broche_draco',    name: 'Broche de Draco',             icon: '💎' },
  panuelo_pansy:   { id: 'panuelo_pansy',   name: 'Pañuelo de Slytherin',        icon: '🐍' },
  anillo_blaise:   { id: 'anillo_blaise',   name: 'Anillo de Plata de Blaise',   icon: '💍' },
  bufanda_cedric:  { id: 'bufanda_cedric',  name: 'Bufanda de Hufflepuff',       icon: '💛' },
  cinta_hannah:    { id: 'cinta_hannah',    name: 'Cinta Amarilla de Hannah',    icon: '🎀' },
  gafas_tonks:     { id: 'gafas_tonks',     name: 'Gafas de Tonks',              icon: '🕶️' },
  caramelo_fred:   { id: 'caramelo_fred',   name: 'Caramelo de Broma',           icon: '🍬' },
  bomba_george:    { id: 'bomba_george',    name: 'Bomba Fétida Perfumada',      icon: '💣' },
  insignia_percy:  { id: 'insignia_percy',  name: 'Insignia de Prefecto',        icon: '📛' },
  guantes_oliver:  { id: 'guantes_oliver',  name: 'Guantes de Quidditch',        icon: '🧤' },
  escudo_ernie:    { id: 'escudo_ernie',    name: 'Escudo de Hufflepuff',        icon: '🛡️' },
  tunica_gala:     { id: 'tunica_gala',     name: 'Túnicas de Gala',             icon: '🎩' },
  // Tanda 3: insignias de los clubes extracurriculares.
  insignia_esfinge:   { id: 'insignia_esfinge',   name: 'Insignia del Club de la Esfinge',   icon: '🐈' },
  insignia_hipogrifo: { id: 'insignia_hipogrifo', name: 'Insignia del Club del Hipogrifo',   icon: '🦅' },
  insignia_dragon:    { id: 'insignia_dragon',    name: 'Insignia del Club del Dragón',      icon: '🐉' }
};

// Bestiario: criaturas mágicas que se registran al interactuar con ellas.
const CREATURES = {
  hipogrifo:   { id: 'hipogrifo',   name: 'Hipogrifo',                icon: '🦅', room: 'cabana',       desc: 'Orgulloso y noble; exige una reverencia.' },
  buckbeak:    { id: 'buckbeak',    name: 'Buckbeak',                 icon: '🦅', room: 'cabana',       desc: 'El hipogrifo favorito de Hagrid.' },
  duendecillo: { id: 'duendecillo', name: 'Duendecillo de Cornualles', icon: '🧚', room: 'cabana',       desc: 'Travieso y difícil de contener.' },
  gusarajo:    { id: 'gusarajo',    name: 'Gusarajo',                 icon: '🐛', room: 'cabana',       desc: 'Plaga común en las cosechas.' },
  mandragora:  { id: 'mandragora',  name: 'Mandrágora',               icon: '🌱', room: 'invernaderos', desc: 'Su grito puede despertar a un ejército.' },
  lazo_diablo: { id: 'lazo_diablo', name: 'Lazo del Diablo',          icon: '🌿', room: 'invernaderos', desc: 'Se defiende con Lumos Solem.' },
  thestral:    { id: 'thestral',    name: 'Thestral',                 icon: '🐴', room: 'terrenos',     desc: 'Solo lo ve quien ha presenciado una muerte.' },
  fenix:       { id: 'fenix',       name: 'Fénix',                    icon: '🪶', room: 'comedor',      desc: 'Renace de sus propias cenizas.' }
};

// Propiedad numérica de cada atributo base.
const ATTR_PROP = { valentia: 'attrValentia', empatia: 'attrEmpatia', sabiduria: 'attrSabiduria' };

// Normaliza listas de ids que pueden venir como strings o como objetos
// (los desbloqueos antiguos guardaban `{ id, name, icon, from, at }`).
function cleanCosmeticIds(v) {
  if (!Array.isArray(v)) return [];
  const ids = v.map(x => (x && typeof x === 'object') ? x.id : x).map(String).filter(Boolean);
  return [...new Set(ids)].slice(0, 64);
}

// Hallazgos mágicos al moverse: el SERVIDOR es la fuente de verdad (la pasiva de
// Fénix y la mascota rata se aplican aquí). Los nombres coinciden con
// RANDOM_FINDS de index.html para que la ficha mostrada sea coherente.
// Clasificación (Parte 4A): los hallazgos TANGIBLES (`tangible: true`) son
// objetos reales que van a la Mochila (`u.inv`); los intangibles (Dobby,
// Peeves, fantasmas, pistas) son SUCESOS que se guardan en `u.encounters[]`.
const SERVER_FINDS = [
  { name: 'Cromo de Rana de Chocolate de Dumbledore', pts: 5, xp: 0, galeones: 0, icon: '🃏', itemId: 'cromo_rana', tangible: true },
  { name: 'Galeón de oro perdido', pts: 8, xp: 0, galeones: 3, icon: '🪙', itemId: 'galeon_perdido', tangible: true },
  { name: 'Pista del Mapa del Merodeador', pts: 6, xp: 0, galeones: 0, icon: '🗺️', kind: 'encounter' },
  { name: 'Grajeas Bertie Bott', pts: 5, xp: 2, galeones: 0, icon: '🍬', itemId: 'grageas_bertie', tangible: true },
  { name: 'Encuentro con Dobby', pts: 7, xp: 0, galeones: 0, icon: '🧦', kind: 'encounter' },
  { name: 'Pluma de Fénix', pts: 8, xp: 2, galeones: 0, icon: '🪶', itemId: 'pluma_fenix', tangible: true },
  { name: 'Broma de Peeves', pts: 5, xp: 0, galeones: 0, icon: '👻', kind: 'encounter' },
  { name: 'Aparición de un fantasma del castillo', pts: 6, xp: 0, galeones: 0, icon: '🌫️', kind: 'encounter' }
];

// Objetos tangibles obtenibles como hallazgo (Parte 4A). Se guardan realmente
// en la Mochila (`u.inv`) y pueden intercambiarse en el Mercadillo.
const FIND_ITEM_DEFS = {
  cromo_rana:      { id: 'cromo_rana',      nombre: 'Cromo de Rana de Chocolate', icon: '🃏', desc: 'Un cromo coleccionable caído de una Rana de Chocolate.', vendible: 4 },
  galeon_perdido:  { id: 'galeon_perdido',  nombre: 'Galeón de Oro Perdido',      icon: '🪙', desc: 'Un galeón brillante extraviado por los pasillos.', vendible: 6 },
  grageas_bertie:  { id: 'grageas_bertie',  nombre: 'Grajeas Bertie Bott',        icon: '🍬', desc: 'Golosinas de todos los sabores… incluso los terribles.', vendible: 3 },
  pluma_fenix:     { id: 'pluma_fenix',     nombre: 'Pluma de Fénix',              icon: '🪶', desc: 'Una pluma cálida que nunca se apaga.', vendible: 8 }
};
const FIND_ITEM_IDS = new Set(Object.keys(FIND_ITEM_DEFS));

// Normaliza la colección de encuentros/avistamientos del jugador. Cada entrada
// es { id, name, icon, kind, count, at }. Máximo 64 entradas distintas.
function sanitizeEncounters(list) {
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  list.forEach(e => {
    if (!e || typeof e !== 'object') return;
    const name = String(e.name || '').trim().slice(0, 80);
    const id = String(e.id || name).trim().slice(0, 80);
    if (!id || !name) return;
    const prev = byId.get(id);
    byId.set(id, {
      id,
      name,
      icon: String(e.icon || (prev && prev.icon) || '✨').slice(0, 8),
      kind: String(e.kind || (prev && prev.kind) || 'encounter').slice(0, 24),
      count: Math.max(1, Number(prev && prev.count) || 1, Number(e.count) || 1),
      at: Number(e.at) || (prev && prev.at) || Date.now()
    });
  });
  return [...byId.values()].slice(-64);
}

// Núcleo de la varita del jugador (o null si aún no la tiene).
function wandCore(user) {
  const c = user && user.wand && user.wand.core;
  return WAND_CORES[c] ? c : null;
}
// Pasiva del eje Fénix: +10 % de probabilidad de hallazgos mágicos (los núcleos
// exóticos con eje Fénix, como Thestral o Lebrílope, la heredan).
function wandFindBonus(user) { return wandAxisOf(wandCore(user)) === 'fenix' ? 0.10 : 0; }
// Pasiva del eje Unicornio: +1 de Empatía efectiva.
function wandEmpatiaBonus(user) { return wandAxisOf(wandCore(user)) === 'unicornio' ? 1 : 0; }
// Pasiva del eje Dragón: +1 de Valentía efectiva.
function wandValentiaBonus(user) { return wandAxisOf(wandCore(user)) === 'dragon' ? 1 : 0; }
// Nivel efectivo de un atributo = nivel de la curva unificada + bonus de la varita.
function effectiveAttrLevel(user, key) {
  const prop = ATTR_PROP[key];
  if (!prop) return 1;
  const base = attrLevelFromPoints(user && user[prop]);
  if (key === 'empatia') return base + wandEmpatiaBonus(user);
  if (key === 'valentia') return base + wandValentiaBonus(user);
  return base;
}
// Desbloquea un título si el jugador no lo tenía. Devuelve true si es nuevo.
function grantTitle(user, id) {
  if (!user || !TITLES[id]) return false;
  user.unlockedTitles = Array.isArray(user.unlockedTitles) ? user.unlockedTitles : [];
  if (user.unlockedTitles.includes(id)) return false;
  user.unlockedTitles.push(id);
  if (!user.title) user.title = id;
  return true;
}
// Revisa el progreso real del jugador y desbloquea los títulos merecidos.
function syncTitleUnlocks(user) {
  if (!user) return [];
  const earned = [];
  if (user.wand) earned.push('elegido_varita');
  if (Array.isArray(user.merlinTrials) && user.merlinTrials.length >= MERLIN_TRIAL_IDS.length) earned.push('merlin');
  if (Array.isArray(user.demiguiseCollected) && user.demiguiseCollected.length >= DEMIGUISE_STATUE_IDS.length) earned.push('demiguise');
  const cromoCount = Object.values(user.cromos || {})
    .filter(v => ((typeof v === 'number') ? v : (v && v.count) || 0) > 0).length;
  if (cromoCount >= CROMO_IDS.length) earned.push('coleccionista');
  if (Array.isArray(user.bestiary) && user.bestiary.length >= 4) earned.push('magizoologo');
  if (Array.isArray(user.guidePages) && user.guidePages.length >= 5) earned.push('enciclopedista');
  // Tanda 2: títulos de exploración avanzada.
  if (Array.isArray(user.arithmancyDoors) && user.arithmancyDoors.length >= 1) earned.push('aritmante');
  if (Array.isArray(user.secretPassages) && user.secretPassages.length >= 1) earned.push('contrabandista');
  if (PHASE2_CATALOGS.constellations.length && Array.isArray(user.constellations)
      && user.constellations.length >= PHASE2_CATALOGS.constellations.length) earned.push('astronomo');
  if (PHASE2_CATALOGS.chests.length && Array.isArray(user.chests)
      && user.chests.length >= PHASE2_CATALOGS.chests.length) earned.push('ladron_experto');
  const newly = [];
  earned.forEach(id => { if (grantTitle(user, id)) newly.push(id); });
  return newly;
}

// ⬅️ AÑADIDO: función que devuelve un objeto NUEVO cada vez (evita mutar BASE_NPCS)
function defaultDb() {
  return {
    users: JSON.parse(JSON.stringify(BASE_NPCS)),
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
    // Parejas oficiales: { members: [id1, id2, ...], type: 'monogamous' | 'polyamorous', at }
    officialCouples: [],
    // Solicitudes de amistad pendientes: { id, from, to, type, at }
    friendRequests: [],
    // Ids de solicitudes ya resueltas (aceptadas/rechazadas): evita que un
    // cliente con datos obsoletos reintroduzca una solicitud ya cerrada.
    friendRequestsDone: [],
    profAffinity: {},
    // Apariencia personalizada de los profesores (no son usuarios): { [profId]: look }
    profLooks: {},
    raidShield: 100,
    chat: [
      { id: 1, u: '🤖 Hermione Granger', h: 'gryffindor', role: 'student', ch: 'global', text: '¡Recuerden que a las 22:00 comienza el toque de queda y todos debemos estar en los dormitorios de nuestra casa!', time: '20:40' },
      { id: 2, u: '🤖 Cedric Diggory', h: 'hufflepuff', role: 'student', ch: 'global', text: '¡Bienvenidos los de 1.º curso! Los de 3.º los ayudaremos a orientarse por el castillo.', time: '20:42' }
    ],
    matches: [],
    cooldowns: {},
    missions: {},
    // Correo por lechuza entre jugadores: { id, from, to, message, gift, read, claimed, at }
    letters: [],
    // Ofertas de intercambio de cromos: { id, from, to, giveCromoId, wantCromoId, status, at }
    tradeOffers: [],
    // Mercadillo (Parte 4A): ofertas de intercambio de objetos tangibles.
    // { id, from, to, giveItemId, giveQty, wantItemId, wantQty, status, at }
    itemTrades: [],
    // Lápida de usuarios eliminados por el administrador (Parte 5): evita que
    // un cliente con datos obsoletos (p. ej. otro navegador) reinyecte la cuenta
    // borrada al reenviar su `users`. Cada entrada: { id, name, at }.
    deletedUserIds: [],
    // Edición activa de El Profeta: { issue, generatedAt, year } o null.
    dailyProphet: null,
    // Desafíos semanales cooperativos por casa (Parte 4B):
    // { weekKey, houses: { [house]: { matches, points, snitches, claimed } } }
    weeklyChallenges: sanitizeWeeklyChallenges(null),
    // Crónica de la última clausura de curso (Parte 4B), o null.
    closure: null,
    // Crónicas de Lee Jordan publicadas en El Profeta (Parte 4B).
    prophetChronicles: [],
    // Caché global de retratos IA de Patronus/Animago: { [type_formId_gender]: url }
    spiritCache: {}
  };
}

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

function sanitizeFriendRequests(state, list) {
  if (!Array.isArray(list)) return [];
  const done = new Set((state && Array.isArray(state.friendRequestsDone) ? state.friendRequestsDone : []).map(String));
  const users = (state && Array.isArray(state.users)) ? state.users : [];
  const seenPairs = new Set();
  const out = [];
  list.forEach(r => {
    if (!r || r.from == null || r.to == null) return;
    const from = Number(r.from);
    const to = Number(r.to);
    if (!from || !to || from === to) return;
    const id = String(r.id || `fr_${from}_${to}_${Date.now()}`);
    if (done.has(id)) return;
    // Ambas partes deben existir todavía en el castillo.
    if (!users.some(u => u.id === from) || !users.some(u => u.id === to)) return;
    // Un jugador no puede tener dos solicitudes abiertas hacia la misma persona.
    const pair = `${from}->${to}`;
    if (seenPairs.has(pair)) return;
    seenPairs.add(pair);
    out.push({
      id,
      from,
      to,
      type: r.type === 'rival' ? 'rival' : 'friend',
      at: Number(r.at) || Date.now()
    });
  });
  return out;
}

// Fusiona la lista de solicitudes del servidor con la que envía un cliente.
// Las solicitudes ya resueltas (tombstones) nunca se reincorporan.
function mergeFriendRequests(serverList, incomingList, doneList, users) {
  const done = new Set((doneList || []).map(String));
  const map = new Map();
  const push = r => {
    if (!r || r.from == null || r.to == null) return;
    const from = Number(r.from);
    const to = Number(r.to);
    if (!from || !to || from === to) return;
    const id = String(r.id || `fr_${from}_${to}_${Date.now()}`);
    if (done.has(id)) return;
    map.set(id, { id, from, to, type: r.type === 'rival' ? 'rival' : 'friend', at: Number(r.at) || Date.now() });
  };
  (serverList || []).forEach(push);
  (incomingList || []).forEach(push);
  return sanitizeFriendRequests({ users: users || [], friendRequestsDone: doneList }, [...map.values()]);
}

/* ===== CORREO POR LECHUZA (cartas y regalos offline) ===== */
const LETTER_MAX = 200;
const LETTER_GIFT_GALEONES_MAX = 100;
// Objetos que un jugador puede adjuntar a una lechuza. Coincide con la tienda
// de Hogsmeade y los objetos de regalo (evita inyectar objetos inexistentes).
const LETTER_ITEM_IDS = new Set([
  'bomba_fetida', 'polvo_oscuridad', 'rana_chocolate', 'grageas_bertie', 'cerveza_mantequilla',
  'apuntes_magicos', 'libro_hechizos', 'pocion_curativa', 'pocion_prestigio', 'objeto_brillante'
]);

function sanitizeLetterGift(gift) {
  if (!gift || typeof gift !== 'object') return null;
  const type = String(gift.type || '');
  if (type === 'galeones') {
    const amount = Math.max(1, Math.min(LETTER_GIFT_GALEONES_MAX, Math.floor(Number(gift.amount) || 10)));
    return { type: 'galeones', amount };
  }
  if (type === 'cromo') {
    const cromoId = String(gift.cromoId || '').trim().slice(0, 40);
    return cromoId ? { type: 'cromo', cromoId } : null;
  }
  if (type === 'item') {
    const itemId = String(gift.itemId || '').trim().slice(0, 40);
    return (itemId && LETTER_ITEM_IDS.has(itemId)) ? { type: 'item', itemId } : null;
  }
  return null;
}

function sanitizeLetter(r, users) {
  if (!r || r.from == null || r.to == null) return null;
  const from = Number(r.from);
  const to = Number(r.to);
  if (!from || !to) return null;
  if (users && users.length && (!users.some(u => u.id === from) || !users.some(u => u.id === to))) return null;
  const sender = users && users.find(u => u.id === from);
  return {
    id: String(r.id || `ltr_${from}_${to}_${Date.now()}`),
    from,
    to,
    message: String(r.message || '').slice(0, 400),
    gift: sanitizeLetterGift(r.gift),
    // Marca de lechuza automática de NPC (o remitente que ya es NPC).
    npc: !!(r.npc || (sender && sender.is_npc)),
    read: !!r.read,
    claimed: !!r.claimed,
    at: Number(r.at) || Date.now()
  };
}

function sanitizeLetters(state, list) {
  if (!Array.isArray(list)) return [];
  const users = (state && Array.isArray(state.users)) ? state.users : [];
  const seen = new Set();
  const out = [];
  list.forEach(r => {
    const l = sanitizeLetter(r, users);
    if (!l || seen.has(l.id)) return;
    seen.add(l.id);
    out.push(l);
  });
  return out.slice(-LETTER_MAX);
}

// Fusiona cartas del servidor y del cliente. Los flags read/claimed son
// monotónicos: una carta leída o con regalo ya reclamado nunca vuelve atrás.
function mergeLetters(serverList, incomingList, users) {
  const map = new Map();
  (serverList || []).forEach(r => { const l = sanitizeLetter(r, users); if (l) map.set(l.id, l); });
  (incomingList || []).forEach(r => {
    const l = sanitizeLetter(r, users);
    if (!l) return;
    const prev = map.get(l.id);
    if (prev) map.set(l.id, { ...prev, read: prev.read || l.read, claimed: prev.claimed || l.claimed });
    else map.set(l.id, l);
  });
  return sanitizeLetters({ users }, [...map.values()]);
}

// Aplica el efecto de un regalo de lechuza al usuario (único punto de entrega
// de regalos de lechuza). Devuelve lo concedido o null si el regalo no es
// válido (entonces no se aplica absolutamente nada).
function applyLetterGiftToUser(user, gift) {
  if (!user || !gift || typeof gift !== 'object') return null;
  if (gift.type === 'galeones') {
    const amount = Math.max(1, Math.min(LETTER_GIFT_GALEONES_MAX, Math.floor(Number(gift.amount) || 0)));
    if (!amount) return null;
    user.galeones = (Number(user.galeones) || 0) + amount;
    return { type: 'galeones', amount };
  }
  if (gift.type === 'cromo') {
    const cromoId = String(gift.cromoId || '').trim();
    if (!cromoId) return null;
    user.cromos = (user.cromos && typeof user.cromos === 'object') ? user.cromos : {};
    const entry = user.cromos[cromoId];
    const count = (typeof entry === 'number') ? entry : ((entry && entry.count) || 0);
    user.cromos[cromoId] = { count: count + 1, image: (entry && entry.image) || undefined };
    return { type: 'cromo', cromoId };
  }
  if (gift.type === 'item') {
    const itemId = String(gift.itemId || '').trim();
    // Un objeto desconocido nunca se entrega: el jugador podrá reintentar.
    if (!itemId || !LETTER_ITEM_IDS.has(itemId)) return null;
    user.inv = (user.inv && typeof user.inv === 'object') ? user.inv : {};
    user.inv[itemId] = (Number(user.inv[itemId]) || 0) + 1;
    return { type: 'item', itemId };
  }
  return null;
}

// Reclama el regalo de una carta. Idempotente: si la carta ya estaba reclamada
// no vuelve a conceder nada. Solo marca la carta como reclamada si el regalo se
// entregó con éxito. Cada entrega recibe un número de secuencia creciente
// (`u.letterGrantSeq`) y se anota en el ledger `u.letterGrants`.
function grantLetterGift(state, user, letter) {
  if (!user || !letter || !letter.gift || letter.claimed) return null;
  const granted = applyLetterGiftToUser(user, letter.gift);
  if (!granted) {
    console.warn(`⚠️ Regalo de lechuza no entregable en la carta ${letter.id} (${JSON.stringify(letter.gift)}): no se marca como reclamada.`);
    return null;
  }
  letter.claimed = true;
  letter.read = true;
  const seq = (Number(user.letterGrantSeq) || 0) + 1;
  user.letterGrantSeq = seq;
  user.letterGrants = (user.letterGrants && typeof user.letterGrants === 'object') ? user.letterGrants : {};
  user.letterGrants[letter.id] = { seq, gift: granted };
  pruneLetterGrants(user);
  return granted;
}

const LETTER_GRANT_LEDGER_MAX = 100;
function pruneLetterGrants(user) {
  const grants = user && user.letterGrants;
  if (!grants || typeof grants !== 'object') return;
  const ids = Object.keys(grants);
  if (ids.length <= LETTER_GRANT_LEDGER_MAX) return;
  ids.sort((a, b) => (Number(grants[a] && grants[a].seq) || 0) - (Number(grants[b] && grants[b].seq) || 0));
  ids.slice(0, ids.length - LETTER_GRANT_LEDGER_MAX).forEach(id => delete grants[id]);
}

// El cliente envía su copia completa de la base de datos en cada sync_db. Si esa
// copia es obsoleta (una pestaña antigua, o un commit que se solapa con el
// claim) puede sobrescribir `u.inv`/`u.galeones` y borrar un regalo ya entregado.
//
// El servidor es la fuente de verdad del ledger (`letterGrants`/`letterGrantSeq`)
// que vive en `memoryState`. Aquí se fusiona ese ledger en el estado entrante y
// se re-aplican las entregas cuya secuencia el cliente todavía no reflejaba
// (eSeq > seq). Un cliente que ya recibió el regalo por broadcast trae la
// secuencia al día y no se re-aplica, así que nunca se duplica.
function reconcileLetterGrants(state, authoritativeUsers) {
  if (!state || !Array.isArray(state.users)) return;
  const source = Array.isArray(authoritativeUsers) ? authoritativeUsers : state.users;
  const byId = new Map(source.filter(u => u && u.id != null).map(u => [Number(u.id), u]));
  state.users.forEach(user => {
    const src = byId.get(Number(user.id));
    const srcGrants = (src && src.letterGrants && typeof src.letterGrants === 'object') ? src.letterGrants : null;
    if (!srcGrants) {
      // El servidor no tiene ledger para este usuario: se descarta cualquier
      // entrada que viniera del cliente (no es fuente de verdad).
      user.letterGrants = {};
      return;
    }
    // Secuencia que ESTE cliente ya refleja, antes de sustituir su ledger.
    let seq = Number(user.letterGrantSeq) || 0;
    Object.keys(srcGrants)
      .map(id => ({ id, entry: srcGrants[id] }))
      .sort((a, b) => (Number(a.entry && a.entry.seq) || 0) - (Number(b.entry && b.entry.seq) || 0))
      .forEach(({ entry }) => {
        const eSeq = Number(entry && entry.seq) || 0;
        if (entry && entry.gift && eSeq > seq) {
          if (applyLetterGiftToUser(user, entry.gift)) {
            console.warn(`🔁 Regalo de lechuza re-aplicado (cliente obsoleto): ${user.username} <- ${JSON.stringify(entry.gift)}`);
          }
          seq = eSeq;
        }
      });
    // El servidor es la fuente de verdad del ledger: se sustituye el del cliente
    // (una copia, para no compartir referencias con memoryState).
    user.letterGrants = {};
    Object.keys(srcGrants).forEach(id => {
      const e = srcGrants[id];
      user.letterGrants[id] = { seq: Number(e && e.seq) || 0, gift: (e && e.gift) ? { ...e.gift } : null };
    });
    user.letterGrantSeq = seq;
  });
}

/* ===== MERCADO DE INTERCAMBIO DE CROMOS ===== */
const TRADE_MAX = 200;
const TRADE_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled'];
const isTradeTerminal = s => s === 'accepted' || s === 'rejected' || s === 'cancelled';

function sanitizeTradeOffer(r, users) {
  if (!r || r.from == null || r.to == null) return null;
  const from = Number(r.from);
  const to = Number(r.to);
  if (!from || !to || from === to) return null;
  if (users && users.length && (!users.some(u => u.id === from) || !users.some(u => u.id === to))) return null;
  const giveCromoId = String(r.giveCromoId || '').trim().slice(0, 40);
  const wantCromoId = String(r.wantCromoId || '').trim().slice(0, 40);
  if (!giveCromoId || !wantCromoId) return null;
  let status = String(r.status || 'pending');
  if (!TRADE_STATUSES.includes(status)) status = 'pending';
  return {
    id: String(r.id || `trade_${from}_${to}_${Date.now()}`),
    from,
    to,
    giveCromoId,
    wantCromoId,
    status,
    at: Number(r.at) || Date.now()
  };
}

function sanitizeTradeOffers(state, list) {
  if (!Array.isArray(list)) return [];
  const users = (state && Array.isArray(state.users)) ? state.users : [];
  const seen = new Set();
  const out = [];
  list.forEach(r => {
    const o = sanitizeTradeOffer(r, users);
    if (!o || seen.has(o.id)) return;
    seen.add(o.id);
    out.push(o);
  });
  return out.slice(-TRADE_MAX);
}

// Un estado terminal (aceptada/rechazada/cancelada) nunca vuelve a 'pendiente'.
function mergeTradeOffers(serverList, incomingList, users) {
  const map = new Map();
  (serverList || []).forEach(r => { const o = sanitizeTradeOffer(r, users); if (o) map.set(o.id, o); });
  (incomingList || []).forEach(r => {
    const o = sanitizeTradeOffer(r, users);
    if (!o) return;
    const prev = map.get(o.id);
    if (prev) {
      const status = (!isTradeTerminal(prev.status) && isTradeTerminal(o.status)) ? o.status : prev.status;
      map.set(o.id, { ...prev, status });
    } else map.set(o.id, o);
  });
  return sanitizeTradeOffers({ users }, [...map.values()]);
}

/* ===== MERCADILLO DE OBJETOS TANGIBLES (Parte 4A) =====
   Intercambio atómico de pociones, dulces, artículos de Zonko y hallazgos
   tangibles entre jugadores. Mismo esquema de estados que el mercado de cromos. */
const ITEM_TRADE_MAX = GAME_BALANCE.market.maxOffers;
const ITEM_TRADE_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled'];
const isItemTradeTerminal = s => s === 'accepted' || s === 'rejected' || s === 'cancelled';

function sanitizeItemTrade(r, users) {
  if (!r || r.from == null || r.to == null) return null;
  const from = Number(r.from);
  const to = Number(r.to);
  if (!from || !to || from === to) return null;
  if (users && users.length && (!users.some(u => u.id === from) || !users.some(u => u.id === to))) return null;
  const giveItemId = String(r.giveItemId || '').trim().slice(0, 40);
  const wantItemId = String(r.wantItemId || '').trim().slice(0, 40);
  if (!giveItemId || !wantItemId) return null;
  const clampQty = v => Math.max(1, Math.min(GAME_BALANCE.market.maxQty, Math.floor(Number(v) || 1)));
  let status = String(r.status || 'pending');
  if (!ITEM_TRADE_STATUSES.includes(status)) status = 'pending';
  return {
    id: String(r.id || `itemtrade_${from}_${to}_${Date.now()}`),
    from, to,
    giveItemId, giveQty: clampQty(r.giveQty),
    wantItemId, wantQty: clampQty(r.wantQty),
    status,
    at: Number(r.at) || Date.now()
  };
}

function sanitizeItemTrades(state, list) {
  if (!Array.isArray(list)) return [];
  const users = (state && Array.isArray(state.users)) ? state.users : [];
  const seen = new Set();
  const out = [];
  list.forEach(r => {
    const o = sanitizeItemTrade(r, users);
    if (!o || seen.has(o.id)) return;
    seen.add(o.id);
    out.push(o);
  });
  return out.slice(-ITEM_TRADE_MAX);
}

// Un estado terminal (aceptada/rechazada/cancelada) nunca vuelve a 'pendiente'.
function mergeItemTrades(serverList, incomingList, users) {
  const map = new Map();
  (serverList || []).forEach(r => { const o = sanitizeItemTrade(r, users); if (o) map.set(o.id, o); });
  (incomingList || []).forEach(r => {
    const o = sanitizeItemTrade(r, users);
    if (!o) return;
    const prev = map.get(o.id);
    if (prev) {
      const status = (!isItemTradeTerminal(prev.status) && isItemTradeTerminal(o.status)) ? o.status : prev.status;
      map.set(o.id, { ...prev, status });
    } else map.set(o.id, o);
  });
  return sanitizeItemTrades({ users }, [...map.values()]);
}

/* ===== PARTE 4B: FUSIÓN DE PARTIDOS (cliente ↔ servidor) =====
   El cliente gestiona los partidos de forma local (temporizadores, resolución
   de rondas). El servidor protege las apuestas y la crónica ya resueltas para
   que un autosave obsoleto no las borre. */
function mergeMatches(serverList, incomingList) {
  const server = Array.isArray(serverList) ? serverList : [];
  const incoming = Array.isArray(incomingList) ? incomingList : [];
  const serverById = new Map(server.filter(m => m && m.id != null).map(m => [String(m.id), m]));
  return incoming.map(m => {
    if (!m || m.id == null) return m;
    const sv = serverById.get(String(m.id));
    if (!sv) return m;
    const out = { ...m };
    // Las apuestas ya liquidadas por el servidor nunca retroceden.
    if (sv.betsSettled) { out.betsSettled = true; out.bets = sv.bets; }
    // La crónica del servidor (con nombres reales) prevalece si el cliente no trae una.
    if (sv.chronicle && (!m.chronicle || !Array.isArray(m.chronicle.lines) || !m.chronicle.lines.length)) {
      out.chronicle = sv.chronicle;
    }
    return out;
  }).concat(server.filter(m => m && m.id != null && !incoming.some(x => x && String(x.id) === String(m.id))));
}

/* ===== PARTE 4B: LIQUIDACIÓN DE PARTIDOS =====
   Cuando un partido pasa a "finished", el servidor (fuente de verdad):
     · paga las apuestas amistosas acertadas,
     · avanza los desafíos semanales de ambas casas,
   y marca el partido como procesado (`betsSettled`) para no repetirlo. */
function settleFinishedMatches(state, prevMatches) {
  const prevById = new Map((Array.isArray(prevMatches) ? prevMatches : [])
    .filter(m => m && m.id != null).map(m => [String(m.id), m]));
  const settled = [];
  (Array.isArray(state.matches) ? state.matches : []).forEach(m => {
    if (!m || m.id == null || m.status !== 'finished' || m.betsSettled) return;
    m.bets = sanitizeMatchBets(m.bets, m);
    const results = settleMatchBets(m);
    results.forEach(r => {
      if (r.payout > 0) {
        const u = state.users.find(x => Number(x.id) === Number(r.uid));
        if (u) u.galeones = (Number(u.galeones) || 0) + r.payout;
      }
    });
    applyMatchToWeekly(state, m);
    m.betsSettled = true;
    m.betResults = results;
    settled.push(m);
  });
  return settled;
}

// Cuenta de un objeto en el inventario de un jugador.
function invCount(user, itemId) {
  const inv = user && user.inv;
  return Math.max(0, Math.floor(Number(inv && inv[itemId]) || 0));
}
// Suma/resta un objeto del inventario respetando el mínimo 0.
function invAdd(user, itemId, delta) {
  if (!user) return;
  user.inv = (user.inv && typeof user.inv === 'object') ? user.inv : {};
  const next = Math.max(0, invCount(user, itemId) + Math.floor(Number(delta) || 0));
  if (next <= 0) delete user.inv[itemId];
  else user.inv[itemId] = next;
}

/* ===== BÓVEDA DE GRINGOTTS (Parte 4A) =====
   El oro depositado genera un interés semanal pasivo. `vaultLastInterest`
   guarda la marca del último periodo abonado para no pagar dos veces. */
function accrueVaultInterest(user, now = Date.now()) {
  if (!user) return 0;
  const balance = Math.max(0, Math.floor(Number(user.vault) || 0));
  const last = Math.max(0, Number(user.vaultLastInterest) || 0);
  if (balance <= 0) { user.vaultLastInterest = last || now; return 0; }
  if (!last) { user.vaultLastInterest = now; return 0; }
  const weeks = Math.floor((now - last) / GAME_BALANCE.bank.weekMs);
  if (weeks <= 0) return 0;
  let interest = 0;
  for (let i = 0; i < weeks; i++) interest += Math.floor(balance * GAME_BALANCE.bank.weeklyRate);
  interest = Math.max(0, Math.min(GAME_BALANCE.bank.maxBalance - balance, interest));
  user.vault = balance + interest;
  user.vaultLastInterest = last + weeks * GAME_BALANCE.bank.weekMs;
  return interest;
}
// Deposita Galeones del monedero en la bóveda (abona antes el interés vencido).
function vaultDeposit(user, amount) {
  if (!user) return { ok: false, message: 'Sin personaje.' };
  accrueVaultInterest(user);
  const amt = Math.floor(Number(amount) || 0);
  if (amt < GAME_BALANCE.bank.minMove) return { ok: false, message: 'Cantidad demasiado baja.' };
  const wallet = Math.max(0, Number(user.galeones) || 0);
  if (wallet < amt) return { ok: false, message: 'No tienes suficientes Galeones en el monedero.' };
  const room = GAME_BALANCE.bank.maxBalance - Math.max(0, Math.floor(Number(user.vault) || 0));
  if (room <= 0) return { ok: false, message: 'Tu bóveda está llena.' };
  const moved = Math.min(amt, room);
  user.galeones = wallet - moved;
  user.vault = Math.max(0, Math.floor(Number(user.vault) || 0)) + moved;
  return { ok: true, moved, vault: user.vault, galeones: user.galeones };
}
// Retira Galeones de la bóveda al monedero.
function vaultWithdraw(user, amount) {
  if (!user) return { ok: false, message: 'Sin personaje.' };
  accrueVaultInterest(user);
  const amt = Math.floor(Number(amount) || 0);
  if (amt < GAME_BALANCE.bank.minMove) return { ok: false, message: 'Cantidad demasiado baja.' };
  const balance = Math.max(0, Math.floor(Number(user.vault) || 0));
  if (balance < amt) return { ok: false, message: 'No tienes suficiente oro en la bóveda.' };
  user.vault = balance - amt;
  user.galeones = Math.max(0, Number(user.galeones) || 0) + amt;
  return { ok: true, moved: amt, vault: user.vault, galeones: user.galeones };
}

/* ===== CESTAS DE REGALO (Parte 4A) =====
   Regalar a un NPC concede afinidad; si el objeto es su favorito, se duplica. */
function giftAffinityFor(npc, itemId) {
  const base = GAME_BALANCE.gifts.baseAffinity;
  const fav = npcFavoriteItem(npc);
  const favorite = !!(fav && fav === itemId);
  return { affinity: favorite ? base * GAME_BALANCE.gifts.favoriteMultiplier : base, favorite };
}

/* ===== MERCADILLO: INTERCAMBIO ATÓMICO (Parte 4A) =====
   Ejecuta la oferta en el servidor para que ambos inventarios queden siempre
   consistentes. Devuelve { ok, accepted, message }. */
function executeItemTrade(state, offerId, userId, accept) {
  const offer = (state.itemTrades || []).find(o => String(o.id) === String(offerId));
  if (!offer || offer.status !== 'pending' || Number(offer.to) !== Number(userId)) {
    return { ok: false, message: 'Oferta no disponible.' };
  }
  if (!accept) { offer.status = 'rejected'; return { ok: true, accepted: false, offer }; }
  const giver = state.users.find(u => u.id === Number(offer.from));
  const taker = state.users.find(u => u.id === Number(offer.to));
  if (!giver || !taker) { offer.status = 'cancelled'; return { ok: false, message: 'Alguno de los jugadores ya no está en el castillo.' }; }
  if (invCount(giver, offer.giveItemId) < offer.giveQty || invCount(taker, offer.wantItemId) < offer.wantQty) {
    offer.status = 'cancelled';
    return { ok: false, message: 'Ya no tenéis los objetos acordados.' };
  }
  invAdd(giver, offer.giveItemId, -offer.giveQty);
  invAdd(giver, offer.wantItemId, offer.wantQty);
  invAdd(taker, offer.wantItemId, -offer.wantQty);
  invAdd(taker, offer.giveItemId, offer.giveQty);
  offer.status = 'accepted';
  return { ok: true, accepted: true, offer, giver, taker };
}

/* ===== FUSIÓN DE USUARIOS (protección contra borrado masivo) ===== */
// Un jugador real tiene casa/contraseña y no es NPC.
function isRealUser(u) {
  return !!(u && !u.is_npc && (u.pass || u.house || u.is_admin));
}

// El cliente envía su array `users` completo en cada sync_db. Si ese cliente
// arrancó con la base por defecto (solo NPCs) o quedó obsoleto, sobrescribiría
// MongoDB y borraría a todos los jugadores reales.
//
// Reglas del servidor (fuente de verdad de la EXISTENCIA de personajes reales):
//   1. Un usuario del servidor que el cliente no traiga NUNCA se elimina si es
//      real (los NPCs se re-siembran solos en sanitizeState).
//   2. Un cliente no puede degradar a un jugador real (convertirlo en NPC o
//      vaciarle la contraseña); se conserva la versión del servidor.
//   3. Sí se aceptan registros nuevos (ids que el servidor no tenía) y las
//      actualizaciones normales de cada jugador.
// Fusiona un usuario entrante (posiblemente obsoleto) con la versión del
// servidor. Los campos que el servidor concede y valida (varita, títulos,
// guardarropa, bestiario y colecciones de exploración) NUNCA se pierden por un
// autosave anterior. El resto de campos (puntos, galeones, posición, etc.) sigue
// tomándose del cliente para no romper el flujo normal de guardado.
// Conjuntos de DESBLOQUEO: solo crecen, así que la unión evita que un cliente
// obsoleto los reduzca. No se incluyen campos mutables (título equipado, prendas
// equipadas) porque ahí el cliente es la autoridad.
const SERVER_AUTHORITY_FIELDS = ['unlockedTitles', 'unlockedCosmetics', 'bestiary',
  'guidePages', 'arithmancyDoors', 'secretPassages', 'constellations', 'chests'];
function mergeServerAuthority(serverUser, incomingUser) {
  const out = { ...incomingUser };
  // La varita asignada por el servidor es autoritativa mientras el cliente no
  // envíe otra varita distinta (p. ej. una receremonia permitida).
  if (serverUser.wand && !incomingUser.wand) out.wand = serverUser.wand;
  // Los desbloqueos son acumulativos: unión de ambos conjuntos.
  SERVER_AUTHORITY_FIELDS.forEach(field => {
    const sv = Array.isArray(serverUser[field]) ? serverUser[field] : [];
    const inc = Array.isArray(incomingUser[field]) ? incomingUser[field] : [];
    if (sv.length) out[field] = [...new Set([...inc, ...sv])];
  });
  // Las prendas equipadas son mutables: si el cliente no las envía (autosave
  // obsoleto) se conserva la selección del servidor; si las envía, mandan ellas.
  if (!Array.isArray(incomingUser.equippedCosmetics) && Array.isArray(serverUser.equippedCosmetics)) {
    out.equippedCosmetics = serverUser.equippedCosmetics;
  }
  // Contador de repeticiones de la ceremonia: solo crece (anti-abuso).
  out.wandRedos = Math.max(0, Number(serverUser.wandRedos) || 0, Number(incomingUser.wandRedos) || 0);
  // Clubes extracurriculares (Tanda 3.2): la XP de cada club y sus hitos son
  // autoritativos del servidor. El servidor es el único que concede XP de club
  // (por clases, pociones, herbología y exámenes), así que un cliente con datos
  // obsoletos o manipulados nunca puede sobrescribirlos.
  out.clubs = { ...(incomingUser.clubs || {}), ...(serverUser.clubs || {}) };
  out.clubMilestones = { ...(incomingUser.clubMilestones || {}), ...(serverUser.clubMilestones || {}) };
  // Exámenes oficiales (Tanda 3.1): el resultado de cada asignatura y los
  // contadores de intentos/defensas también son autoritativos del servidor.
  out.exams = { ...(incomingUser.exams || {}), ...(serverUser.exams || {}) };
  out.examAttempts = Math.max(0, Number(serverUser.examAttempts) || 0, Number(incomingUser.examAttempts) || 0);
  out.defenseCount = Math.max(0, Number(serverUser.defenseCount) || 0, Number(incomingUser.defenseCount) || 0);
  out.defenseGraceUntil = Math.max(0, Number(serverUser.defenseGraceUntil) || 0);
  // Bóveda de Gringotts (Parte 4A): el saldo guardado y la marca del último
  // interés son autoritativos del servidor (un cliente obsoleto no los borra).
  out.vault = Math.max(0, Number(serverUser.vault) || 0, Number(incomingUser.vault) || 0);
  out.vaultLastInterest = Math.max(0, Number(serverUser.vaultLastInterest) || 0);
  // Encuentros y avistamientos (Parte 4A): colección acumulativa; la unión
  // evita que un autosave antiguo borre los sucesos ya registrados.
  const svEnc = Array.isArray(serverUser.encounters) ? serverUser.encounters : [];
  const incEnc = Array.isArray(incomingUser.encounters) ? incomingUser.encounters : [];
  if (svEnc.length) {
    const byId = new Map();
    [...incEnc, ...svEnc].forEach(e => {
      if (!e || typeof e !== 'object') return;
      const id = String(e.id || e.name || '');
      if (!id) return;
      const prev = byId.get(id);
      byId.set(id, {
        id,
        name: e.name || (prev && prev.name) || id,
        icon: e.icon || (prev && prev.icon) || '✨',
        kind: e.kind || (prev && prev.kind) || 'encounter',
        at: Math.min(Number(prev && prev.at) || Number(e.at) || Date.now(), Number(e.at) || Number(prev && prev.at) || Date.now()),
        count: Math.max(1, Number(prev && prev.count) || 1, Number(e.count) || 1)
      });
    });
    out.encounters = [...byId.values()];
  }
  return out;
}

const DELETED_USERS_MAX = 100;
// Normaliza el nombre para comparar lápidas (sin acentos, minúsculas, sin espacios).
function normUserName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase();
}
// Sanea la lista de usuarios eliminados: solo entradas con id o nombre, sin
// duplicados (por id o por nombre) y con un máximo de las últimas 100.
function sanitizeDeletedUsers(list) {
  const out = [];
  const seenIds = new Set();
  const seenNames = new Set();
  (Array.isArray(list) ? list : []).forEach(e => {
    if (!e) return;
    const id = Number(e.id);
    const hasId = Number.isFinite(id) && id > 0;
    const name = normUserName(e.name || e.username);
    if (!hasId && !name) return;
    if ((hasId && seenIds.has(id)) || (name && seenNames.has(name))) return;
    if (hasId) seenIds.add(id);
    if (name) seenNames.add(name);
    out.push({ id: hasId ? id : null, name: name || null, at: Number(e.at) || Date.now() });
  });
  return out.slice(-DELETED_USERS_MAX);
}
// ¿Está el usuario en la lápida? Se compara por id y por nombre normalizado.
function isDeletedUser(user, deletedList) {
  if (!user) return false;
  const id = Number(user.id);
  const name = normUserName(user.username);
  return (Array.isArray(deletedList) ? deletedList : []).some(e => {
    if (!e) return false;
    if (Number.isFinite(id) && e.id != null && Number(e.id) === id) return true;
    if (name && e.name && e.name === name) return true;
    return false;
  });
}
// Baja "dura" para un usuario que YA existe en el servidor (o en el cliente): un
// id en la lápida siempre bloquea; un nombre solo bloquea a copias sin
// contraseña (un personaje recreado con contraseña nueva sobrevive).
function isHardDeletedUser(user, deletedList) {
  if (!user) return false;
  const id = Number(user.id);
  const name = normUserName(user.username);
  return (Array.isArray(deletedList) ? deletedList : []).some(e => {
    if (!e) return false;
    if (Number.isFinite(id) && e.id != null && Number(e.id) === id) return true;
    if (!user.pass && name && e.name && e.name === name) return true;
    return false;
  });
}
// Fusiona lápidas: solo crecen (una baja nunca se revierte), sin duplicados.
function mergeDeletedUsers(serverList, incomingList) {
  return sanitizeDeletedUsers([...(serverList || []), ...(incomingList || [])]);
}
// Ajusta las lápidas tras fusionar los usuarios: si el id ya está vivo, la baja
// se revirtió por completo; si el nombre lo usa una cuenta viva, se libera el
// nombre pero se conserva la lápida del id (un autosave obsoleto no puede
// revivir el registro antiguo). Solo se invoca con la lista ya fusionada.
function pruneTombstonesForLiveUsers(tombstones, users) {
  const list = Array.isArray(users) ? users : [];
  const liveIds = new Set(list.filter(u => u && u.id != null).map(u => Number(u.id)));
  const liveNames = new Set(list.filter(u => u && !u.is_npc && u.pass).map(u => normUserName(u.username)));
  const out = [];
  (tombstones || []).forEach(t => {
    if (!t) return;
    if (t.id != null && liveIds.has(Number(t.id))) return;
    const name = (t.name && !liveNames.has(t.name)) ? t.name : null;
    if (t.id == null && !name) return;
    out.push({ id: t.id, name, at: t.at });
  });
  return sanitizeDeletedUsers(out);
}

function mergeUsers(serverUsers, incomingUsers, deletedList) {
  const server = Array.isArray(serverUsers) ? serverUsers : [];
  const incoming = Array.isArray(incomingUsers) ? incomingUsers : [];
  const tombstones = sanitizeDeletedUsers(deletedList);
  const serverById = new Map(server.filter(u => u && u.id != null).map(u => [Number(u.id), u]));
  const incomingIds = new Set(incoming.filter(u => u && u.id != null).map(u => Number(u.id)));

  const merged = [];
  incoming.forEach(u => {
    if (!u || u.id == null) return;
    const sv = serverById.get(Number(u.id));
    // Un usuario eliminado por el administrador no puede resucitar desde el
    // cliente. Por id SIEMPRE se descarta; por nombre solo se admite si es un
    // registro nuevo explícito (id que el servidor no conocía y con contraseña),
    // para permitir recrear la cuenta sin que un autosave obsoleto la restaure.
    // Los NPC del canon quedan exentos (se re-siembran solos en sanitizeState).
    if (!u.is_npc) {
      if (tombstones.some(e => e.id != null && Number(e.id) === Number(u.id))) return;
      if (tombstones.some(e => e.name && e.name === normUserName(u.username))
          && !(u.pass && !sv)) return;
    }
    if (sv && isRealUser(sv) && !isRealUser(u)) { merged.push(sv); return; }
    // Una cuenta protegida no puede quedar sin contraseña: un cliente obsoleto
    // (con `pass` vacío) no debe desactivar la protección de un jugador real.
    if (sv && isRealUser(sv) && !u.pass && sv.pass) {
      merged.push(mergeServerAuthority(sv, { ...u, pass: sv.pass }));
      return;
    }
    // Un cliente con datos obsoletos (autosave anterior a una recompensa del
    // servidor) no puede borrar la varita ni los desbloqueos ya concedidos.
    merged.push((sv && isRealUser(sv) && isRealUser(u)) ? mergeServerAuthority(sv, u) : u);
  });

  const preserved = [];
  server.forEach(u => {
    if (!u || u.id == null || incomingIds.has(Number(u.id)) || !isRealUser(u)) return;
    // Un jugador marcado como eliminado no se preserva: la baja manda (un id en
    // la lápida bloquea siempre; el nombre solo a copias sin contraseña).
    if (isHardDeletedUser(u, tombstones)) return;
    merged.push(u);
    preserved.push(u.username);
  });
  if (preserved.length) {
    console.warn(`🛡️ sync_db: ${preserved.length} jugador(es) real(es) preservados del servidor: ${preserved.join(', ')}`);
  }
  return merged;
}

/* ===== MIGRACIÓN DE RELACIONES (amistad / romance) ===== */
// Las relaciones antiguas solo guardaban `score`. Se migran al esquema nuevo:
//   friendshipScore -> afinidad de amistad (hereda el score antiguo)
//   romanceScore    -> afinidad romántica (siempre 0 en relaciones antiguas)
//   rival           -> rivalidad (se conserva)
// El campo `score` desaparece para evitar confusiones futuras.
function migrateRelations(relations) {
  const out = {};
  if (!relations || typeof relations !== 'object') return out;
  Object.keys(relations).forEach(key => {
    const r = relations[key];
    if (!r || typeof r !== 'object') return;
    const oldScore = Number(r.score);
    const friendship = Number.isFinite(r.friendshipScore)
      ? Number(r.friendshipScore)
      : (Number.isFinite(oldScore) ? oldScore : 0);
    const romance = Number.isFinite(Number(r.romanceScore)) ? Number(r.romanceScore) : 0;
    out[key] = {
      friendshipScore: Math.max(0, Math.min(100, friendship)),
      romanceScore: Math.max(0, Math.min(100, romance)),
      rival: !!r.rival
    };
  });
  return out;
}

function sanitizeOfficialCouples(state) {
  const raw = state && Array.isArray(state.officialCouples) ? state.officialCouples : [];
  const validIds = new Set((state.users || []).map(u => Number(u.id)));
  const out = [];
  raw.forEach(c => {
    if (!c || !Array.isArray(c.members)) return;
    // Solo ids reales, sin duplicados y con un máximo razonable por relación.
    const members = [...new Set(c.members.map(Number).filter(id => validIds.has(id)))].slice(0, 6);
    if (members.length < 2) return;
    const type = c.type === 'polyamorous' ? 'polyamorous' : 'monogamous';
    // Un jugador solo puede estar en una relación oficial: se descarta la duplicada.
    if (members.some(id => out.some(o => o.members.includes(id)))) return;
    out.push({ members, type, at: Number(c.at) || Date.now() });
  });
  return out.slice(0, 200);
}

function sanitizeState(state) {
  if (!state || !Array.isArray(state.users)) return defaultDb();
  if (!state.schoolYear || state.schoolYear < 1 || state.schoolYear > 7) state.schoolYear = 1;

  const legacyNames = ['carla r.', 'vicente d.', 'matilde s.', 'joaquín p.', 'antonia v.', 'benjamín l.'];
  state.users = state.users.filter(u => {
    if (u.id <= 6 && !u.pass && !u.is_npc && legacyNames.includes((u.username || '').toLowerCase())) return false;
    return true;
  });

  BASE_NPCS.forEach(npc => {
    const existing = state.users.find(u => u.id === npc.id || (u.username || '').toLowerCase() === npc.username.toLowerCase());
    if (!existing) {
      state.users.push(JSON.parse(JSON.stringify(npc)));
    } else if (existing.is_npc) {
      if (npc.is_canon) existing.is_canon = true;
      // El curso del canon solo se re-siembra si el admin no lo fijó a mano
      // (yearCustom). Así una edición manual de curso sobrevive a cada sync.
      if (!existing.yearCustom) {
        existing.yearOffset = npc.yearOffset;
        existing.npc_trait = npc.npc_trait;
      }
    }
  });

  const PATRONUS_IDS = ['ciervo', 'nutria', 'lobo', 'fenix', 'perro', 'gato'];
  state.users.forEach(u => {
    if (typeof u.yearOffset !== 'number') u.yearOffset = 0;
    if (typeof u.galeones !== 'number') u.galeones = 15;
    if (!u.inv || typeof u.inv !== 'object') u.inv = {};
    if (typeof u.letterGrantSeq !== 'number') u.letterGrantSeq = 0;
    if (!u.letterGrants || typeof u.letterGrants !== 'object') u.letterGrants = {};
    if (!u.cromos || typeof u.cromos !== 'object') u.cromos = {};
    Object.keys(u.cromos).forEach(k => {
      const v = u.cromos[k];
      if (typeof v === 'number') u.cromos[k] = { count: v };
      else if (!v || typeof v !== 'object') delete u.cromos[k];
      else if (typeof v.count !== 'number') v.count = Number(v.count) || 0;
    });
    if (typeof u.inmunidadFilchHasta !== 'number') u.inmunidadFilchHasta = 0;
    if (typeof u.buffDobleGaleon !== 'boolean') u.buffDobleGaleon = false;
    // Apariencia (avatar): se normaliza para que un guardado antiguo sin los
    // campos nuevos (p. ej. `pacifier`) no rompa el renderizado del cliente.
    // El chupón es OPCIONAL y queda desactivado por defecto.
    if (!u.look || typeof u.look !== 'object') u.look = {};
    u.look.pacifier = u.look.pacifier === true;
    const hairIdx = Math.floor(Number(u.look.hair));
    u.look.hair = (Number.isFinite(hairIdx) && hairIdx >= 0 && hairIdx < HAIR_STYLE_COUNT) ? hairIdx : 0;
    ['skin', 'hairColor', 'eyeColor', 'features', 'clothing', 'eyes'].forEach(k => {
      const n = Math.floor(Number(u.look[k]));
      u.look[k] = Number.isFinite(n) && n >= 0 ? n : 0;
    });
    if (typeof u.look.style !== 'string') u.look.style = 'corto';
    if (typeof u.look.facialHair !== 'string') u.look.facialHair = 'none';
    if (typeof u.pet === 'undefined') u.pet = null;
    if (typeof u.petLastUse === 'undefined') u.petLastUse = null;
    if (typeof u.petLastPlay === 'undefined') u.petLastPlay = null;
    if (typeof u.petLove !== 'number' || Number.isNaN(u.petLove)) u.petLove = 50;
    else u.petLove = Math.max(0, Math.min(100, u.petLove));
    if (typeof u.attrValentia !== 'number' || Number.isNaN(u.attrValentia)) u.attrValentia = 0;
    if (typeof u.attrEmpatia !== 'number' || Number.isNaN(u.attrEmpatia)) u.attrEmpatia = 0;
    if (typeof u.attrSabiduria !== 'number' || Number.isNaN(u.attrSabiduria)) u.attrSabiduria = 0;
    if (!Array.isArray(u.spells)) u.spells = [];
    if (!u.classStars || typeof u.classStars !== 'object') { u.classStars = {}; }
    if (typeof u.lastClassDate === 'undefined') { u.lastClassDate = null; }
    if (typeof u.classStreak !== 'number') { u.classStreak = 0; }
    if (!Array.isArray(u.badges)) { u.badges = []; }
    if (u.patronus !== null && !PATRONUS_IDS.includes(u.patronus)) u.patronus = null;
    if (typeof u.patronusImage !== 'string') u.patronusImage = null;
    if (typeof u.animagusImage !== 'string') u.animagusImage = null;
    // Exploración: arrays de IDs (strings) y contadores acotados.
    const cleanIds = v => Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))].slice(0, 64) : [];
    u.merlinTrials = cleanIds(u.merlinTrials);
    u.demiguiseCollected = cleanIds(u.demiguiseCollected);
    u.demiguiseCarrying = cleanIds(u.demiguiseCarrying).filter(id => !u.demiguiseCollected.includes(id));
    const _alo = Math.floor(Number(u.alohomoraLevel));
    u.alohomoraLevel = (_alo >= 1 && _alo <= 3) ? _alo : 1;
    const _bag = Math.floor(Number(u.bagCapacity));
    u.bagCapacity = (_bag >= 5 && _bag <= 99) ? _bag : 5;
    // Exploración avanzada (Tanda 2): ids de páginas, puertas, pasadizos,
    // constelaciones y cofres recogidos/abiertos.
    u.guidePages = cleanIds(u.guidePages);
    u.arithmancyDoors = cleanIds(u.arithmancyDoors);
    u.secretPassages = cleanIds(u.secretPassages);
    u.constellations = cleanIds(u.constellations);
    u.chests = cleanIds(u.chests);
    // Parte 4A: encuentros/avistamientos (sucesos intangibles) y Bóveda de
    // Gringotts. Retrocompatible: un guardado antiguo arranca vacío y a cero.
    u.encounters = sanitizeEncounters(u.encounters);
    u.vault = Math.max(0, Math.min(GAME_BALANCE.bank.maxBalance, Math.floor(Number(u.vault) || 0)));
    u.vaultLastInterest = Math.max(0, Math.floor(Number(u.vaultLastInterest) || 0));
    // Enfriamientos de acciones sociales: solo marcas numéricas futuras válidas.
    if (!u.socialCooldowns || typeof u.socialCooldowns !== 'object' || Array.isArray(u.socialCooldowns)) {
      u.socialCooldowns = {};
    } else {
      Object.keys(u.socialCooldowns).forEach(k => {
        const v = Number(u.socialCooldowns[k]);
        if (!Number.isFinite(v) || v <= 0) delete u.socialCooldowns[k];
        else u.socialCooldowns[k] = v;
      });
    }
    // Perfil (Tandas 4 y 8): varita, títulos, guardarropa y bestiario.
    // Retrocompatibilidad: un guardado antiguo sin estos campos queda con
    // valores por defecto seguros en lugar de provocar errores `undefined`.
    // Normaliza la varita: núcleo válido, madera del catálogo y longitud sensata.
    if (u.wand && (typeof u.wand !== 'object' || !WAND_CORES[u.wand.core])) {
      u.wand = null;
    } else if (u.wand) {
      if (!WAND_WOOD_IDS.includes(u.wand.wood)) u.wand.wood = WAND_WOOD_IDS[(Number(u.id) || 0) % WAND_WOOD_IDS.length];
      const _len = Math.floor(Number(u.wand.length));
      u.wand.length = (Number.isFinite(_len) && _len >= 15 && _len <= 45) ? _len : WAND_LENGTHS[(Number(u.id) || 0) % WAND_LENGTHS.length];
      u.wand.chosenAt = Number(u.wand.chosenAt) || Date.now();
    }
    u.wandRedos = Math.max(0, Math.floor(Number(u.wandRedos) || 0));
    if (u.title != null && !TITLES[u.title]) u.title = null;
    u.unlockedTitles = cleanIds(u.unlockedTitles).filter(id => !!TITLES[id]);
    if (!u.unlockedTitles.length && u.wand) u.unlockedTitles.push('elegido_varita');
    if (u.title && !u.unlockedTitles.includes(u.title)) u.title = null;
    u.unlockedCosmetics = cleanCosmeticIds(u.unlockedCosmetics).filter(id => !!COSMETICS[id]);
    u.equippedCosmetics = cleanIds(u.equippedCosmetics).filter(id => u.unlockedCosmetics.includes(id));
    u.bestiary = cleanIds(u.bestiary).filter(id => !!CREATURES[id]);
    // Clubes extracurriculares (Tanda 3.2): XP por club y hitos ya entregados.
    // Retrocompatible: un guardado sin `clubs` arranca los tres en cero.
    u.clubs = (u.clubs && typeof u.clubs === 'object' && !Array.isArray(u.clubs)) ? u.clubs : {};
    CLUB_IDS.forEach(id => {
      const v = Math.floor(Number(u.clubs[id]));
      u.clubs[id] = (Number.isFinite(v) && v >= 0) ? Math.min(99999, v) : 0;
    });
    Object.keys(u.clubs).forEach(k => { if (!CLUBS[k]) delete u.clubs[k]; });
    u.clubMilestones = (u.clubMilestones && typeof u.clubMilestones === 'object' && !Array.isArray(u.clubMilestones)) ? u.clubMilestones : {};
    CLUB_IDS.forEach(id => {
      const v = Math.floor(Number(u.clubMilestones[id]));
      const lvl = clubLevelOf(u, id);
      u.clubMilestones[id] = (Number.isFinite(v) && v >= 0 && v <= lvl) ? v : lvl;
    });
    // Exámenes oficiales (Tanda 3.1): resultados T.I.M.O./É.X.T.A.S.I.S. y
    // contador de defensas verbales. Retrocompatible con guardados antiguos.
    u.exams = (u.exams && typeof u.exams === 'object' && !Array.isArray(u.exams)) ? u.exams : {};
    if (typeof u.examAttempts !== 'number' || Number.isNaN(u.examAttempts)) u.examAttempts = 0;
    if (typeof u.defenseCount !== 'number' || Number.isNaN(u.defenseCount)) u.defenseCount = 0;
    if (typeof u.defenseGraceUntil !== 'number' || Number.isNaN(u.defenseGraceUntil)) u.defenseGraceUntil = 0;
    // Cumpleaños: mes 1-12 y día 1-31; cualquier valor inválido se descarta.
    const bm = Math.floor(Number(u.birthMonth));
    const bd = Math.floor(Number(u.birthDay));
    u.birthMonth = (bm >= 1 && bm <= 12) ? bm : null;
    u.birthDay = (bd >= 1 && bd <= 31 && u.birthMonth !== null) ? bd : null;
    if (u.lastBirthdayYear !== null && !Number.isFinite(Number(u.lastBirthdayYear))) u.lastBirthdayYear = null;
    if (!GENDER_IDS.includes(u.gender)) u.gender = FEMALES.includes(u.username) ? 'f' : 'm';
    if (!ROMANCE_PREF_IDS.includes(u.romancePref)) u.romancePref = 'todos';

    if (u.is_npc && !u.npc_decided) {
      u.flight_xp = 0;
      u.npc_quidditch = false;
      u.role = 'student';
      u.npc_path = null;
    }
    if (u.is_npc && u.role === 'prefect' && (userYear(state, u) < 4 || userYear(state, u) > 7)) {
      u.role = 'student';
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
      if (usr && usr.is_npc && (userYear(state, usr) < 4 || userYear(state, usr) > 7)) return false;
      return true;
    });
  }
  if (!state.relations || typeof state.relations !== 'object') state.relations = {};
  state.relations = migrateRelations(state.relations);
  state.officialCouples = sanitizeOfficialCouples(state);
  if (!state.profAffinity || typeof state.profAffinity !== 'object') state.profAffinity = {};
  // Apariencia de profesores: solo se conservan claves con forma de objeto.
  if (!state.profLooks || typeof state.profLooks !== 'object') {
    state.profLooks = {};
  } else {
    Object.keys(state.profLooks).forEach(k => {
      const v = state.profLooks[k];
      if (!v || typeof v !== 'object' || Array.isArray(v)) delete state.profLooks[k];
    });
  }
  // Curso personalizado: flag booleano que protege la edición manual del curso.
  state.users.forEach(u => { u.yearCustom = !!u.yearCustom; });
  if (!Array.isArray(state.friendRequests)) state.friendRequests = [];
  if (!Array.isArray(state.friendRequestsDone)) state.friendRequestsDone = [];
  state.friendRequests = sanitizeFriendRequests(state, state.friendRequests);
  state.friendRequestsDone = state.friendRequestsDone.map(id => String(id)).slice(-200);
  if (typeof state.raidShield !== 'number') state.raidShield = 100;
  if (typeof state.npcAi === 'undefined') state.npcAi = true;
  // Correo por lechuza y mercado de cromos: arrays saneados y limitados.
  state.letters = sanitizeLetters(state, state.letters);
  // Re-aplica los regalos de lechuza ya reclamados que un cliente obsoleto
  // pudiera haber sobrescrito (protección contra lost update).
  reconcileLetterGrants(state);
  state.tradeOffers = sanitizeTradeOffers(state, state.tradeOffers);
  // Mercadillo de objetos tangibles (Parte 4A): se sanea igual que los cromos.
  state.itemTrades = sanitizeItemTrades(state, state.itemTrades);
  // Edición activa de El Profeta: estructura { issue, generatedAt, year } válida
  // o null. Se conserva al guardar otros cambios para no regenerarla antes de 24 h.
  const dp = state.dailyProphet;
  if (!dp || typeof dp !== 'object' || !dp.issue || typeof dp.issue !== 'object'
      || !Number.isFinite(Number(dp.generatedAt))) {
    state.dailyProphet = null;
  } else {
    state.dailyProphet = {
      issue: dp.issue,
      generatedAt: Number(dp.generatedAt),
      year: clampSchoolYear(dp.year)
    };
  }
  // Caché global de imágenes: descarta entradas corruptas y limita su tamaño.
  if (!state.spiritCache || typeof state.spiritCache !== 'object' || Array.isArray(state.spiritCache)) {
    state.spiritCache = {};
  } else {
    Object.keys(state.spiritCache).forEach(k => {
      if (typeof state.spiritCache[k] !== 'string' || !state.spiritCache[k]) delete state.spiritCache[k];
    });
    const keys = Object.keys(state.spiritCache);
    if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete state.spiritCache[k]);
  }

  if (Array.isArray(state.matches)) {
    state.matches.forEach(m => {
      if (!m.type) m.type = 'amistoso';
      // Parte 4B: apuestas amistosas saneadas y crónica de Lee Jordan normalizada.
      m.bets = sanitizeMatchBets(m.bets, m);
      m.betsSettled = !!m.betsSettled;
      if (m.chronicle && (!Array.isArray(m.chronicle.lines) || !m.chronicle.lines.length)) m.chronicle = null;
      if (Array.isArray(m.players)) {
        m.players.forEach(p => {
          if (!QUIDDITCH_POSITIONS.includes(p.pos)) p.pos = 'Suplente';
          if (!QUIDDITCH_ACTIONS[p.pos]) p.action = null;
          else if (p.action != null && !QUIDDITCH_ACTIONS[p.pos].includes(p.action)) p.action = null;
        });
      }
    });
  }
  // Desafíos semanales cooperativos por casa (Parte 4B): se reinician al cambiar
  // de semana. Ceremonia de clausura: estructura válida o null.
  state.weeklyChallenges = sanitizeWeeklyChallenges(state.weeklyChallenges);
  if (!state.closure || typeof state.closure !== 'object' || !state.closure.champion) state.closure = null;
  // Lápida de usuarios eliminados por el administrador (Parte 5): se sanea y se
  // usa para descartar cualquier cuenta borrada que reaparezca en el estado
  // (los NPC del canon quedan exentos y se re-siembran solos).
  state.deletedUserIds = sanitizeDeletedUsers(state.deletedUserIds);
  if (state.deletedUserIds.length) {
    state.users = state.users.filter(u => u && (u.is_npc || !isHardDeletedUser(u, state.deletedUserIds)));
  }
  // Crónicas de Lee Jordan publicadas en El Profeta (Parte 4B).
  state.prophetChronicles = (Array.isArray(state.prophetChronicles) ? state.prophetChronicles : [])
    .filter(c => c && typeof c === 'object' && Array.isArray(c.lines) && c.lines.length)
    .map(c => ({
      id: String(c.id || ''), matchId: String(c.matchId || ''),
      a: String(c.a || ''), b: String(c.b || ''),
      sa: Math.max(0, Math.floor(Number(c.sa) || 0)), sb: Math.max(0, Math.floor(Number(c.sb) || 0)),
      winner: c.winner ? String(c.winner) : null,
      lines: c.lines.map(l => String(l || '').slice(0, 300)).filter(Boolean).slice(0, 3),
      at: Number(c.at) || Date.now()
    }))
    .filter(c => c.lines.length === 3)
    .slice(0, 20);

  reconcileHousePoints(state);
  return state;
}

// Ruta del respaldo local. Se puede sobrescribir con DB_FILE para que las
// pruebas de integración no contaminen el db.json real del proyecto.
const DB_FILE = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(__dirname, 'db.json');
let memoryState = sanitizeState(defaultDb());
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
    const initial = defaultDb();
    await collection.insertOne({ _id: 'global', ...initial });
    memoryState = sanitizeState(initial);
    return memoryState;
  }
  const { _id, ...cleanState } = state;
  const fixedState = sanitizeState(cleanState);
  memoryState = fixedState;
  return fixedState;
}

async function saveState(newState) {
  const { _id, ...stateToSave } = newState;
  reconcileHousePoints(stateToSave);
  // El ledger de regalos de lechuza del servidor (memoryState previo) es la
  // fuente de verdad: antes de persistir se fusiona y se re-aplican las
  // entregas que un cliente con datos obsoletos hubiera podido borrar.
  const authoritativeUsers = (memoryState && Array.isArray(memoryState.users)) ? memoryState.users : null;
  reconcileLetterGrants(stateToSave, authoritativeUsers);
  // Parte 4B: liquida las apuestas de los partidos recién terminados y avanza
  // los desafíos semanales de las casas. Idempotente gracias a `betsSettled`.
  const prevMatches = (memoryState && Array.isArray(memoryState.matches)) ? memoryState.matches : [];
  const justSettled = settleFinishedMatches(stateToSave, prevMatches);
  // La edición activa de El Profeta es autoritativa del servidor: un cliente que
  // la omita (o reenvíe una copia antigua) no debe borrarla antes de sus 24 h.
  const prevProphet = memoryState && memoryState.dailyProphet;
  const incomingProphet = stateToSave.dailyProphet;
  if (prevProphet && prevProphet.issue
      && (!incomingProphet || Number(incomingProphet.generatedAt) <= Number(prevProphet.generatedAt))) {
    stateToSave.dailyProphet = prevProphet;
  }
  memoryState = stateToSave;
  if (!db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(stateToSave, null, 2));
  } else {
    const collection = db.collection('gameState');
    await collection.updateOne({ _id: 'global' }, { $set: stateToSave }, { upsert: true });
  }
  // La crónica de Lee Jordan se genera en segundo plano (una sola vez por partido).
  justSettled.forEach(m => { generateChronicleForMatch(String(m.id)); });
}

// Genera (una única vez) la crónica de Lee Jordan de un partido terminado y la
// publica en El Profeta. Si el partido ya tiene crónica, no hace nada.
const chroniclesInFlight = new Set();
async function generateChronicleForMatch(matchId) {
  if (chroniclesInFlight.has(matchId)) return;
  chroniclesInFlight.add(matchId);
  try {
    const state = memoryState;
    const match = (state.matches || []).find(m => String(m.id) === String(matchId));
    if (!match || match.status !== 'finished' || (match.chronicle && Array.isArray(match.chronicle.lines) && match.chronicle.lines.length)) return;
    const chronicle = await generateMatchChronicle(match, state);
    // El partido puede haber cambiado durante la llamada a la IA: se re-localiza.
    const again = (memoryState.matches || []).find(m => String(m.id) === String(matchId));
    if (!again) return;
    again.chronicle = chronicle;
    // Publicación en El Profeta: la crónica aparece como noticia destacada.
    memoryState.prophetChronicles = Array.isArray(memoryState.prophetChronicles) ? memoryState.prophetChronicles : [];
    memoryState.prophetChronicles.unshift({
      id: `chr_${matchId}`,
      matchId: String(matchId),
      a: again.a, b: again.b, sa: again.sa, sb: again.sb, winner: again.winner,
      lines: chronicle.lines, at: chronicle.at
    });
    memoryState.prophetChronicles = memoryState.prophetChronicles.slice(0, 20);
    await saveState(memoryState);
    io.emit('sync_db', { db: memoryState, reason: null });
    io.emit('quidditch:chronicle', { matchId: String(matchId), chronicle, match: { a: again.a, b: again.b, sa: again.sa, sb: again.sb, winner: again.winner } });
  } catch (err) {
    console.error('Error generando la crónica del partido:', err.message);
  } finally {
    chroniclesInFlight.delete(matchId);
  }
}

/* ===== CUMPLEAÑOS Y REGALOS ===== */
// Ids válidos de cromo (deben coincidir con CROMOS_MAGOS del cliente).
const CROMO_IDS = ['dumbledore', 'merlin', 'rowena', 'godric', 'helga', 'salazar', 'newt', 'morgana', 'flamel'];
const BIRTHDAY_GALEONES = 15;

/* ===== LECHUZAS AUTOMÁTICAS DE NPCs (personalidad y regalos) =====
   Cada NPC del canon tiene un pool de regalos coherente con su carácter.
   Cada regalo: { id, minFriendship, weight }. `id` pertenece a NPC_GIFT_CATALOG. */

// Catálogo de regalos: define qué concede cada id. Los objetos se guardan en
// `u.inv` (y se pueden usar desde la Mochila); los cromos y galeones, aparte.
const NPC_GIFT_CATALOG = {
  galeones_10:        { kind: 'galeones', amount: 10, label: '10 Galeones', icon: '🪙' },
  galeones_20:        { kind: 'galeones', amount: 20, label: '20 Galeones', icon: '🪙' },
  galeones_50:        { kind: 'galeones', amount: 50, label: '50 Galeones', icon: '🪙' },
  rana_chocolate:     { kind: 'item', itemId: 'rana_chocolate', label: 'Rana de Chocolate', icon: '🐸' },
  grageas_bertie:     { kind: 'item', itemId: 'grageas_bertie', label: 'Grageas de Todos los Sabores', icon: '🍬' },
  bomba_fetida:       { kind: 'item', itemId: 'bomba_fetida', label: 'Bomba Fétida', icon: '💣' },
  cerveza_mantequilla:{ kind: 'item', itemId: 'cerveza_mantequilla', label: 'Cerveza de Mantequilla', icon: '🍺' },
  apuntes_magicos:    { kind: 'item', itemId: 'apuntes_magicos', label: 'Apuntes Mágicos (+10 XP la próxima clase)', icon: '📝' },
  libro_hechizos:     { kind: 'item', itemId: 'libro_hechizos', label: 'Libro de Hechizos', icon: '📚' },
  pocion_curativa:    { kind: 'item', itemId: 'pocion_curativa', label: 'Poción Curativa', icon: '🧪' },
  pocion_prestigio:   { kind: 'item', itemId: 'pocion_prestigio', label: 'Poción de Prestigio (decorativa)', icon: '🍾' },
  objeto_brillante:   { kind: 'item', itemId: 'objeto_brillante', label: 'Objeto Brillante (vendible)', icon: '💎' },
  cromo_comun:        { kind: 'cromo_pool', rareza: 'Común', label: 'Cromo de mago', icon: '🐸' },
  cromo_raro:         { kind: 'cromo_pool', rareza: 'Raro', label: 'Cromo raro de mago', icon: '🐸' },
  cromo_legendario:   { kind: 'cromo_pool', rareza: 'Legendario', label: 'Cromo legendario', icon: '🌟' }
};

// Personalidades: pool de regalos por NPC del canon. La afinidad mínima de
// cada regalo hace que los obsequios evolucionen con la amistad.
const NPC_GIFT_POOLS = {
  'Harry Potter': [
    { id: 'galeones_10', minFriendship: 20, weight: 3 },
    { id: 'cromo_comun', minFriendship: 20, weight: 3 },
    { id: 'rana_chocolate', minFriendship: 20, weight: 2 },
    { id: 'cromo_raro', minFriendship: 50, weight: 2 },
    { id: 'pocion_curativa', minFriendship: 50, weight: 2 },
    { id: 'galeones_20', minFriendship: 60, weight: 2 }
  ],
  'Ron Weasley': [
    { id: 'grageas_bertie', minFriendship: 20, weight: 4 },
    { id: 'rana_chocolate', minFriendship: 20, weight: 4 },
    { id: 'bomba_fetida', minFriendship: 20, weight: 3 },
    { id: 'cerveza_mantequilla', minFriendship: 50, weight: 2 },
    { id: 'galeones_10', minFriendship: 60, weight: 1 }
  ],
  'Hermione Granger': [
    { id: 'apuntes_magicos', minFriendship: 20, weight: 4 },
    { id: 'libro_hechizos', minFriendship: 20, weight: 3 },
    { id: 'cromo_comun', minFriendship: 20, weight: 2 },
    { id: 'galeones_10', minFriendship: 50, weight: 2 },
    { id: 'cromo_raro', minFriendship: 60, weight: 2 }
  ],
  'Draco Malfoy': [
    { id: 'galeones_20', minFriendship: 40, weight: 3 },
    { id: 'galeones_50', minFriendship: 70, weight: 2 },
    { id: 'pocion_prestigio', minFriendship: 40, weight: 3 },
    { id: 'cromo_raro', minFriendship: 50, weight: 2 },
    { id: 'cromo_legendario', minFriendship: 80, weight: 1 }
  ],
  'Luna Lovegood': [
    { id: 'cromo_comun', minFriendship: 20, weight: 3 },
    { id: 'objeto_brillante', minFriendship: 20, weight: 3 },
    { id: 'cromo_raro', minFriendship: 40, weight: 3 },
    { id: 'galeones_10', minFriendship: 50, weight: 2 },
    { id: 'cromo_legendario', minFriendship: 70, weight: 1 }
  ],
  'Neville Longbottom': [
    { id: 'rana_chocolate', minFriendship: 20, weight: 3 },
    { id: 'pocion_curativa', minFriendship: 20, weight: 3 },
    { id: 'cromo_comun', minFriendship: 30, weight: 2 },
    { id: 'galeones_10', minFriendship: 50, weight: 2 }
  ],
  'Ginny Weasley': [
    { id: 'grageas_bertie', minFriendship: 20, weight: 3 },
    { id: 'cerveza_mantequilla', minFriendship: 20, weight: 2 },
    { id: 'cromo_comun', minFriendship: 30, weight: 2 },
    { id: 'galeones_10', minFriendship: 50, weight: 2 },
    { id: 'cromo_raro', minFriendship: 60, weight: 2 }
  ],
  'Fred Weasley': [
    { id: 'bomba_fetida', minFriendship: 20, weight: 4 },
    { id: 'grageas_bertie', minFriendship: 20, weight: 4 },
    { id: 'objeto_brillante', minFriendship: 30, weight: 2 },
    { id: 'galeones_10', minFriendship: 50, weight: 2 }
  ],
  'George Weasley': [
    { id: 'bomba_fetida', minFriendship: 20, weight: 4 },
    { id: 'grageas_bertie', minFriendship: 20, weight: 4 },
    { id: 'objeto_brillante', minFriendship: 30, weight: 2 },
    { id: 'galeones_10', minFriendship: 50, weight: 2 }
  ],
  'Percy Weasley': [
    { id: 'libro_hechizos', minFriendship: 20, weight: 4 },
    { id: 'apuntes_magicos', minFriendship: 30, weight: 3 },
    { id: 'galeones_10', minFriendship: 50, weight: 2 }
  ],
  'Oliver Wood': [
    { id: 'galeones_10', minFriendship: 20, weight: 3 },
    { id: 'cerveza_mantequilla', minFriendship: 30, weight: 3 },
    { id: 'cromo_comun', minFriendship: 30, weight: 2 },
    { id: 'cromo_raro', minFriendship: 60, weight: 2 }
  ],
  'Cho Chang': [
    { id: 'cromo_comun', minFriendship: 20, weight: 3 },
    { id: 'rana_chocolate', minFriendship: 20, weight: 2 },
    { id: 'objeto_brillante', minFriendship: 40, weight: 2 },
    { id: 'galeones_10', minFriendship: 50, weight: 2 }
  ],
  'Pansy Parkinson': [
    { id: 'galeones_10', minFriendship: 30, weight: 3 },
    { id: 'pocion_prestigio', minFriendship: 40, weight: 3 },
    { id: 'cromo_raro', minFriendship: 60, weight: 2 }
  ],
  'Blaise Zabini': [
    { id: 'pocion_curativa', minFriendship: 20, weight: 3 },
    { id: 'galeones_10', minFriendship: 40, weight: 3 },
    { id: 'cromo_raro', minFriendship: 60, weight: 2 },
    { id: 'cromo_legendario', minFriendship: 80, weight: 1 }
  ],
  'Cedric Diggory': [
    { id: 'galeones_10', minFriendship: 20, weight: 3 },
    { id: 'rana_chocolate', minFriendship: 20, weight: 2 },
    { id: 'cromo_comun', minFriendship: 30, weight: 2 },
    { id: 'cromo_raro', minFriendship: 60, weight: 2 }
  ],
  'Hannah Abbott': [
    { id: 'rana_chocolate', minFriendship: 20, weight: 3 },
    { id: 'pocion_curativa', minFriendship: 20, weight: 3 },
    { id: 'galeones_10', minFriendship: 50, weight: 2 }
  ],
  'Ernie Macmillan': [
    { id: 'libro_hechizos', minFriendship: 20, weight: 3 },
    { id: 'apuntes_magicos', minFriendship: 30, weight: 3 },
    { id: 'galeones_10', minFriendship: 50, weight: 2 }
  ],
  'Nymphadora Tonks': [
    { id: 'galeones_20', minFriendship: 40, weight: 3 },
    { id: 'bomba_fetida', minFriendship: 40, weight: 2 },
    { id: 'cromo_raro', minFriendship: 60, weight: 2 },
    { id: 'cromo_legendario', minFriendship: 80, weight: 1 }
  ]
};

// Regalos especiales de cumpleaños (afinidad >= 50): cromo legendario o 50 Galeones.
const NPC_BIRTHDAY_GIFTS = ['galeones_50', 'cromo_legendario'];

/* Regalo favorito de cada NPC del canon (Parte 4A). Regalarle su objeto
   favorito desde una Cesta de Regalo duplica la afinidad concedida. */
const NPC_FAVORITE_ITEMS = {
  'Harry Potter': 'objeto_brillante',
  'Ron Weasley': 'grageas_bertie',
  'Hermione Granger': 'libro_hechizos',
  'Draco Malfoy': 'pocion_prestigio',
  'Luna Lovegood': 'pluma_fenix',
  'Neville Longbottom': 'pocion_curativa',
  'Ginny Weasley': 'cerveza_mantequilla',
  'Fred Weasley': 'bomba_fetida',
  'George Weasley': 'polvo_oscuridad',
  'Percy Weasley': 'apuntes_magicos',
  'Oliver Wood': 'cerveza_mantequilla',
  'Cho Chang': 'cromo_rana',
  'Pansy Parkinson': 'pocion_prestigio',
  'Blaise Zabini': 'objeto_brillante',
  'Cedric Diggory': 'galeon_perdido',
  'Hannah Abbott': 'rana_chocolate',
  'Ernie Macmillan': 'apuntes_magicos',
  'Nymphadora Tonks': 'bomba_fetida'
};
// Objeto favorito de un NPC (o null si no tiene uno definido).
function npcFavoriteItem(npc) {
  if (!npc) return null;
  return NPC_FAVORITE_ITEMS[npc.username] || null;
}

/* ===== PARÁMETROS DE LAS LECHUZAS AUTOMÁTICAS =====
   Todo configurable por entorno para no saturar el servidor en producción. */
const NPC_FRIENDSHIP_MIN = Number(process.env.NPC_LETTER_FRIENDSHIP_MIN) || 20;      // afinidad mínima para recibir carta
const NPC_LETTER_INTERVAL_MS = Number(process.env.NPC_LETTER_INTERVAL_MS) || 30 * 60 * 1000; // revisión cada 30 min
const NPC_LETTER_CHANCE = Number(process.env.NPC_LETTER_CHANCE) || 0.35;            // prob. por jugador elegible y ciclo
const NPC_LETTER_MIN_GAP_MS = Number(process.env.NPC_LETTER_MIN_GAP_MS) || 45 * 60 * 1000; // separación mínima entre cartas por jugador
const NPC_LETTER_PENDING_CAP = Number(process.env.NPC_LETTER_PENDING_CAP) || 5;     // máx. cartas de NPC sin reclamar por jugador
const NPC_LETTER_PER_TICK = Number(process.env.NPC_LETTER_PER_TICK) || 3;           // máx. cartas generadas por ciclo (evita picos)

// Frases por defecto (sin IA) coherentes con la personalidad de cada NPC.
const NPC_LETTER_LINES = {
  'Harry Potter': ['Te mando algo por si te hace falta en una aventura. ¡Cuídate!'],
  'Ron Weasley': ['Esto me sobraba del carrito de Honeydukes. ¡No se lo digas a mi madre!'],
  'Hermione Granger': ['He hecho una copia de mis apuntes para ti. ¡No olvides repasar!'],
  'Draco Malfoy': ['No es que me importes, pero mi familia tiene de sobra. Tómalo.'],
  'Luna Lovegood': ['Los Nargles me dijeron que te haría ilusión esto.'],
  'Neville Longbottom': ['Mi abuela me dio más de lo que necesito. Quédatelo.'],
  'Ginny Weasley': ['Te mando esto con cariño. ¡Nos vemos en el campo de Quidditch!'],
  'Fred Weasley': ['¡Una pequeña travesura para ti! Úsala con cabeza… o sin ella.'],
  'George Weasley': ['¡De parte de los gemelos! Que Filch nunca te pille.'],
  'Percy Weasley': ['Adjunto material de estudio. La disciplina es la clave del éxito.'],
  'Oliver Wood': ['¡Un pequeño empujón para tus entrenamientos! Arriba la escoba.'],
  'Cho Chang': ['Pensé en ti al ver esto. ¡Hasta pronto en el castillo!'],
  'Pansy Parkinson': ['No se lo cuentes a nadie, pero me caes bien. Toma.'],
  'Blaise Zabini': ['Un detalle elegante para alguien que lo merece.'],
  'Cedric Diggory': ['Los buenos amigos se apoyan. Aquí tienes una muestra.'],
  'Hannah Abbott': ['¡Qué alegría tenerte cerca! Te mando un detalle dulce.'],
  'Ernie Macmillan': ['Como futuro Prefecto, recompenso a los alumnos ejemplares.'],
  'Nymphadora Tonks': ['¡Sorpresa! Un regalito de una vieja alumna. ¡Pásalo bien!']
};

function npcDefaultLine(name) {
  const lines = NPC_LETTER_LINES[name];
  if (Array.isArray(lines) && lines.length) return lines[Math.floor(Math.random() * lines.length)];
  return 'Te mando un pequeño detalle. ¡Cuídate por el castillo!';
}

function isBirthdayToday(u, now = new Date()) {
  if (!u || !u.birthMonth || !u.birthDay) return false;
  return (now.getMonth() + 1) === Number(u.birthMonth) && now.getDate() === Number(u.birthDay);
}

// Amigos NPC con afinidad alta (>= 50 y sin rivalidad) que felicitan al jugador.
function npcBirthdayFriends(state, uid) {
  const rels = state.relations || {};
  const out = [];
  state.users.forEach(npc => {
    if (!npc.is_npc || npc.id === uid) return;
    const [a, b] = [Math.min(uid, npc.id), Math.max(uid, npc.id)];
    const rel = rels[`${a}_${b}`];
    if (!rel || rel.rival) return;
    if ((Number(rel.friendshipScore) || 0) >= 50) out.push(npc);
  });
  return out;
}

/* ===== MOTOR DE LECHUZAS AUTOMÁTICAS DE NPCs ===== */
// Rareza de cada cromo para poder regalar por categoría.
const CROMO_RARITY = {
  dumbledore: 'Legendario', merlin: 'Legendario',
  rowena: 'Raro', godric: 'Raro', helga: 'Raro', salazar: 'Raro',
  newt: 'Común', morgana: 'Común', flamel: 'Común'
};
function cromoIdsByRarity(rareza) {
  const ids = CROMO_IDS.filter(id => CROMO_RARITY[id] === rareza);
  return ids.length ? ids : CROMO_IDS;
}

// Clave de relación (mismo esquema que el cliente: idMenor_idMayor).
function relKeyBetween(a, b) {
  const x = Math.min(Number(a), Number(b)), y = Math.max(Number(a), Number(b));
  return `${x}_${y}`;
}
function friendshipBetween(state, a, b) {
  const rel = (state.relations || {})[relKeyBetween(a, b)];
  if (!rel || rel.rival) return 0;
  return Number(rel.friendshipScore) || 0;
}

// Convierte un id del catálogo en el objeto `gift` que se guarda en la carta.
function buildGiftFromCatalog(giftId) {
  const def = NPC_GIFT_CATALOG[giftId];
  if (!def) return null;
  if (def.kind === 'galeones') return { type: 'galeones', amount: def.amount };
  if (def.kind === 'item') return { type: 'item', itemId: def.itemId };
  if (def.kind === 'cromo_pool') {
    const ids = cromoIdsByRarity(def.rareza);
    return { type: 'cromo', cromoId: ids[Math.floor(Math.random() * ids.length)] };
  }
  return null;
}

// Elige un regalo del pool del NPC filtrando por la afinidad actual y
// aplicando el peso de cada opción (los mejores regalos requieren más amistad).
function pickNpcGift(npcName, friendship) {
  const pool = NPC_GIFT_POOLS[npcName];
  if (!Array.isArray(pool) || !pool.length) return null;
  const eligible = pool.filter(g => NPC_GIFT_CATALOG[g.id] && friendship >= (Number(g.minFriendship) || 0));
  if (!eligible.length) return null;
  const total = eligible.reduce((s, g) => s + Math.max(1, Number(g.weight) || 1), 0);
  let r = Math.random() * total;
  for (const g of eligible) {
    r -= Math.max(1, Number(g.weight) || 1);
    if (r <= 0) return { giftId: g.id, gift: buildGiftFromCatalog(g.id) };
  }
  const last = eligible[eligible.length - 1];
  return { giftId: last.id, gift: buildGiftFromCatalog(last.id) };
}

// Nota que acompaña el regalo: frase de personalidad (Groq si está activo).
async function npcLetterMessage(npc, giftId, playerName) {
  const fallback = npcDefaultLine(npc.username);
  if (!AI_ENABLED) return fallback;
  const def = NPC_GIFT_CATALOG[giftId] || {};
  const giftName = def.label || 'un regalo';
  const systemPrompt = `Eres ${npc.username}, alumno de Hogwarts del canon de Harry Potter. Escribe una nota BREVE (máximo 25 palabras) en español, cariñosa y coherente con tu personalidad, para acompañar un regalo (${giftName}) que envías por lechuza a tu amigo ${playerName}. Devuelve ÚNICAMENTE un JSON válido sin bloques markdown con este esquema exacto: {"nota":"..."}`;
  const aiBody = {
    model: AI_MODEL,
    max_tokens: 90,
    temperature: 0.9,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Escribe la nota. Devuelve el JSON.' }
    ]
  };
  if (/gpt-oss/i.test(AI_MODEL)) aiBody.reasoning_effort = 'low';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const aiRes = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify(aiBody),
      signal: controller.signal
    });
    if (!aiRes.ok) throw new Error(`Groq HTTP ${aiRes.status}`);
    const json = await aiRes.json();
    let raw = String(json?.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const first = raw.indexOf('{'), last = raw.indexOf('}');
    if (first !== -1 && last !== -1) raw = raw.slice(first, last + 1);
    const nota = String(JSON.parse(raw).nota || '').trim().slice(0, 240);
    return nota || fallback;
  } catch (err) {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// Genera (una sola vez por año) el saludo de cumpleaños y las cartas de los
// amigos NPC (afinidad >= 50). Devuelve un resumen para el cliente o null.
function grantBirthdayIfDue(state, uid, now = new Date()) {
  const u = state.users.find(x => x.id === uid);
  if (!u || !isBirthdayToday(u, now)) return null;
  const year = now.getFullYear();
  if (Number(u.lastBirthdayYear) === year) return null;

  u.lastBirthdayYear = year;
  u.galeones = (Number(u.galeones) || 0) + BIRTHDAY_GALEONES;

  const friends = npcBirthdayFriends(state, uid);
  state.letters = Array.isArray(state.letters) ? state.letters : [];
  const existing = new Set(state.letters.map(l => l.id));
  const fromNames = [];
  friends.forEach((npc, i) => {
    const id = `bday_${uid}_${year}_${npc.id}`;
    if (existing.has(id)) return;
    // Regalo especial de cumpleaños: cromo legendario o 50 Galeones.
    const giftId = NPC_BIRTHDAY_GIFTS[i % NPC_BIRTHDAY_GIFTS.length];
    const gift = buildGiftFromCatalog(giftId) || { type: 'galeones', amount: 50 };
    state.letters.push({
      id, from: npc.id, to: uid, npc: true,
      message: `¡Feliz cumpleaños! Espero que pases un día mágico. Te mando un regalo especial. — ${npc.username}`,
      gift, read: false, claimed: false, at: Date.now()
    });
    fromNames.push(npc.username);
  });
  return { galeones: BIRTHDAY_GALEONES, friends: fromNames };
}

/* ===== MOTOR: cartas espontáneas de NPCs a jugadores reales =====
   Revisa a los jugadores reales matriculados y, con cierta probabilidad,
   hace que un NPC amigo (afinidad >= NPC_FRIENDSHIP_MIN) le envíe una carta
   con un regalo coherente con su personalidad y su nivel de amistad. */

// Cartas de NPC sin leer dirigidas a un jugador (para el aviso al conectarse).
function pendingNpcLetters(state, uid) {
  return (Array.isArray(state.letters) ? state.letters : [])
    .filter(l => Number(l.to) === Number(uid) && l.npc && !l.read);
}
// ¿Cuántas cartas de NPC sin reclamar tiene ya el jugador? (evita acumulación)
function unclaimedNpcLetters(state, uid) {
  return (Array.isArray(state.letters) ? state.letters : [])
    .filter(l => Number(l.to) === Number(uid) && l.npc && l.gift && !l.claimed).length;
}
// Última carta de NPC recibida (para respetar la separación mínima entre cartas).
function lastNpcLetterAt(state, uid) {
  let max = 0;
  (Array.isArray(state.letters) ? state.letters : []).forEach(l => {
    if (Number(l.to) === Number(uid) && l.npc) max = Math.max(max, Number(l.at) || 0);
  });
  return max;
}

// Un ciclo del motor: devuelve las cartas creadas (para notificar en tiempo real).
function runNpcLetterTick(state, now = Date.now()) {
  const created = [];
  if (!Array.isArray(state.users)) return created;
  const realPlayers = state.users.filter(u => !u.is_npc && u.house && u.pass && isEnrolled(state, u));

  for (const player of realPlayers) {
    if (created.length >= NPC_LETTER_PER_TICK) break;
    if (Math.random() > NPC_LETTER_CHANCE) continue;
    if (unclaimedNpcLetters(state, player.id) >= NPC_LETTER_PENDING_CAP) continue;
    if (now - lastNpcLetterAt(state, player.id) < NPC_LETTER_MIN_GAP_MS) continue;

    // NPCs amigos del jugador con afinidad suficiente y pool disponible.
    const friends = state.users.filter(npc => {
      if (!npc.is_npc || npc.id === player.id) return false;
      if (!NPC_GIFT_POOLS[npc.username]) return false;
      return friendshipBetween(state, player.id, npc.id) >= NPC_FRIENDSHIP_MIN;
    });
    if (!friends.length) continue;

    const npc = friends[Math.floor(Math.random() * friends.length)];
    const friendship = friendshipBetween(state, player.id, npc.id);
    const picked = pickNpcGift(npc.username, friendship);
    if (!picked || !picked.gift) continue;

    created.push({ player, npc, giftId: picked.giftId, gift: picked.gift });
  }
  return created;
}

/* ===== EXPLORACIÓN: Pruebas de Merlín y Estatuas Demiguise =====
   Deben coincidir con MERLIN_TRIALS / DEMIGUISE_STATUES de index.html.
   El servidor solo valida IDs; el minijuego se juega en el cliente. */
const MERLIN_TRIAL_IDS = ['merlin_patio', 'merlin_lago', 'merlin_bosque', 'merlin_quidditch', 'merlin_invernaderos', 'merlin_puente'];
const DEMIGUISE_STATUE_IDS = ['demi_biblioteca', 'demi_astronomia', 'demi_pociones', 'demi_pasillo3', 'demi_comedor', 'demi_encantamientos', 'demi_enfermeria', 'demi_mazmorras'];

/* ===== TANDA 2: ayudantes de los catálogos de exploración ===== */
// Valor numérico de cada criatura en el alfabeto de Aritmancia (guía del modal).
const ARITHMANCY_CREATURES = {
  demiguise: { name: 'Demiguise', value: 0, icon: '🐒' },
  unicornio: { name: 'Unicornio', value: 1, icon: '🦄' },
  graphorn:  { name: 'Graphorn',  value: 2, icon: '🐗' },
  runespoor: { name: 'Runespoor', value: 3, icon: '🐍' },
  fwooper:   { name: 'Fwooper',   value: 4, icon: '🦜' },
  quintaped: { name: 'Quintaped', value: 5, icon: '🦂' },
  salamandra:{ name: 'Salamandra',value: 6, icon: '🦎' },
  hidra:     { name: 'Hidra',     value: 9, icon: '🐉' },
  acromantula:{ name: 'Acromántula', value: 8, icon: '🕷️' }
};
// Nivel de Alohomora según las Lunas de Demiguise entregadas (Tanda 2.5).
function alohomoraLevelFor(collected) {
  const n = Array.isArray(collected) ? collected.length : 0;
  if (n >= 6) return 3;
  if (n >= 3) return 2;
  return 1;
}
// Busca una entrada del catálogo por id (null si no existe).
function catalogById(list, id) {
  if (!Array.isArray(list)) return null;
  return list.find(x => x && String(x.id) === String(id)) || null;
}
// Entrega un cromo del pool de la rareza indicada (o cualquiera si no hay).
function grantCromoByRarity(user, rarity) {
  if (!user) return null;
  const ids = rarity ? cromoIdsByRarity(rarity) : CROMO_IDS;
  const pool = ids.length ? ids : CROMO_IDS;
  if (!pool.length) return null;
  const cromoId = pool[Math.floor(Math.random() * pool.length)];
  user.cromos = (user.cromos && typeof user.cromos === 'object') ? user.cromos : {};
  const entry = user.cromos[cromoId];
  const count = (typeof entry === 'number') ? entry : ((entry && entry.count) || 0);
  user.cromos[cromoId] = { count: count + 1, image: (entry && entry.image) || undefined };
  return cromoId;
}
// Aplica una recompensa del catálogo (Galeones, XP, puntos, atributo, cromo,
// prenda) y devuelve un resumen legible. Todo se valida contra el catálogo.
function applyCatalogReward(user, reward) {
  if (!user || !reward || typeof reward !== 'object') return { lines: [], cromo: null, cosmetic: null };
  const lines = [];
  if (reward.galeones) {
    const g = Math.max(0, Math.min(500, Math.floor(Number(reward.galeones) || 0)));
    if (g) { user.galeones = (Number(user.galeones) || 0) + g; lines.push(`+${g} 🪙`); }
  }
  if (reward.xp) {
    const x = Math.max(0, Math.min(200, Math.floor(Number(reward.xp) || 0)));
    if (x) { user.flight_xp = (Number(user.flight_xp) || 0) + x; lines.push(`+${x} XP`); }
  }
  if (reward.points) {
    const p = Math.max(0, Math.min(200, Math.floor(Number(reward.points) || 0)));
    if (p) { user.points = (Number(user.points) || 0) + p; lines.push(`+${p} pts`); }
  }
  if (reward.sabiduria) user.attrSabiduria = (Number(user.attrSabiduria) || 0) + Math.max(0, Math.min(100, Math.floor(Number(reward.sabiduria) || 0)));
  if (reward.valentia) user.attrValentia = (Number(user.attrValentia) || 0) + Math.max(0, Math.min(100, Math.floor(Number(reward.valentia) || 0)));
  if (reward.empatia) user.attrEmpatia = (Number(user.attrEmpatia) || 0) + Math.max(0, Math.min(100, Math.floor(Number(reward.empatia) || 0)));
  let cromo = null;
  if (reward.cromoRarity) {
    cromo = grantCromoByRarity(user, reward.cromoRarity);
    if (cromo) lines.push(`🃏 Cromo ${reward.cromoRarity}`);
  }
  let cosmetic = null;
  if (reward.cosmetic && COSMETICS[reward.cosmetic]) {
    cosmetic = reward.cosmetic;
    user.unlockedCosmetics = Array.isArray(user.unlockedCosmetics) ? user.unlockedCosmetics : [];
    if (!user.unlockedCosmetics.includes(cosmetic)) {
      user.unlockedCosmetics.push(cosmetic);
      lines.push(`👗 ${COSMETICS[cosmetic].name}`);
    } else { cosmetic = null; }
  }
  return { lines, cromo, cosmetic };
}

// Hora del reloj del juego (coincide con la lógica del turno autónomo de NPCs).
function gameHour(state) {
  if (state && state.clockMode === 'mock' && state.mockTime) {
    const h = Number(String(state.mockTime).split(':')[0]);
    if (Number.isFinite(h)) return h;
  }
  return new Date().getHours();
}
// Toque de queda: 22:00 a 06:59 (sin sistema de energía ni esperas).
function isCurfewHour(state) {
  const h = gameHour(state);
  return h >= 22 || h < 7;
}

// ⬅️ PRESENCIA: jugadores reales conectados ahora mismo. { [userId]: nº de sockets }.
const onlineUsers = new Map();

function onlineUserIds() {
  return Array.from(onlineUsers.keys());
}
// Emite a todos la lista de jugadores reales en línea y en qué sala están.
function emitPresence() {
  const users = memoryState && Array.isArray(memoryState.users) ? memoryState.users : [];
  const list = onlineUserIds().map(id => {
    const u = users.find(x => x.id === id);
    if (!u) return null;
    return { id: u.id, username: u.username, house: u.house || null, loc: u.loc || null };
  }).filter(Boolean);
  io.emit('presence:update', { ids: onlineUserIds(), users: list });
}

io.on('connection', async (socket) => {
  try {
    const currentState = await loadState();
    socket.emit('init_db', currentState);
    // Catálogos de la Tanda 2 (páginas, aritmancia, pasadizos, constelaciones,
    // cofres): el servidor es la fuente de verdad de sus definiciones.
    socket.emit('exploration:catalog', PHASE2_CATALOGS);
    // Catálogo oficial de varitas (maderas y núcleos con lore) para el Expediente.
    // Se incluye también el catálogo de prendas para que el Guardarropa pueda
    // dibujar cualquier prenda desbloqueada (incluidas las de los clubes).
    socket.emit('wand:catalog', { woods: WAND_WOODS, cores: WAND_CORES, cosmetics: COSMETICS });
    // Catálogo de la Tanda 3: clubes, recetas de pociones, plantas de herbología y
    // exámenes. El servidor valida contra estas definiciones (nunca el cliente).
    socket.emit('phase3:catalog', {
      clubs: clubSummary({ clubs: {}, clubMilestones: {} }).map(c => ({
        id: c.id, name: c.name, icon: c.icon, color: c.color, desc: c.desc, step: c.step, maxLevel: c.maxLevel
      })),
      clubsMeta: CLUBS,
      potions: Object.values(POTION_RECIPES).map(r => ({ id: r.id, name: r.name, icon: r.icon, year: r.year, desc: r.desc, ingredients: r.ingredients, stirs: r.stirs, heat: r.heat })),
      herbology: { plants: Object.values(HERBOLOGY_PLANTS), actions: Object.values(HERBOLOGY_ACTIONS) },
      exams: { types: EXAM_TYPES, subjects: EXAM_SUBJECTS }
    });

    // ⬅️ AÑADIDO: rate-limit por socket (máx. ~20 sync/s)
    let lastSyncAt = 0;

    socket.on('sync_db', async (data) => {
      const now = Date.now();
      if (now - lastSyncAt < 50) return;
      lastSyncAt = now;

      if (data && data.db) {
        if (Array.isArray(data.db.users) && data.db.users.length > 200) {
          console.log('⚠️ Intento de creación masiva de usuarios bloqueado.');
          return;
        }

        // Las solicitudes de amistad se funden con la lista del servidor:
        // un cliente con datos obsoletos no puede borrar las pendientes.
        data.db.friendRequests = mergeFriendRequests(
          (memoryState && memoryState.friendRequests) || [],
          Array.isArray(data.db.friendRequests) ? data.db.friendRequests : [],
          (memoryState && memoryState.friendRequestsDone) || [],
          Array.isArray(data.db.users) ? data.db.users : ((memoryState && memoryState.users) || [])
        );
        data.db.friendRequestsDone = (memoryState && memoryState.friendRequestsDone) || [];

        // Cartas y ofertas de intercambio también se funden: el servidor es la
        // fuente de verdad y los estados terminales (leído/reclamado/aceptado)
        // nunca retroceden por culpa de un cliente con datos obsoletos.
        const liveUsers = Array.isArray(data.db.users) ? data.db.users : ((memoryState && memoryState.users) || []);
        data.db.letters = mergeLetters(
          (memoryState && memoryState.letters) || [],
          Array.isArray(data.db.letters) ? data.db.letters : [],
          liveUsers
        );
        data.db.tradeOffers = mergeTradeOffers(
          (memoryState && memoryState.tradeOffers) || [],
          Array.isArray(data.db.tradeOffers) ? data.db.tradeOffers : [],
          liveUsers
        );
        // Mercadillo de objetos (Parte 4A): mismo tratamiento que las ofertas de
        // cromos; los estados terminales nunca retroceden.
        data.db.itemTrades = mergeItemTrades(
          (memoryState && memoryState.itemTrades) || [],
          Array.isArray(data.db.itemTrades) ? data.db.itemTrades : [],
          liveUsers
        );

        // Partidos de Quidditch (Parte 4B): el cliente resuelve las rondas, pero
        // las apuestas liquidadas y la crónica del servidor nunca se pierden.
        data.db.matches = mergeMatches(
          (memoryState && memoryState.matches) || [],
          Array.isArray(data.db.matches) ? data.db.matches : []
        );

        // Desafíos semanales, clausura y crónicas (Parte 4B): autoritativos del
        // servidor. Un autosave obsoleto no puede reiniciar el progreso semanal
        // ni borrar la ceremonia o las crónicas ya publicadas.
        data.db.weeklyChallenges = sanitizeWeeklyChallenges(
          (memoryState && memoryState.weeklyChallenges) || data.db.weeklyChallenges
        );
        data.db.closure = (memoryState && memoryState.closure) || null;
        if (!Array.isArray(data.db.prophetChronicles) || !data.db.prophetChronicles.length) {
          data.db.prophetChronicles = (memoryState && Array.isArray(memoryState.prophetChronicles))
            ? memoryState.prophetChronicles : [];
        }

        // Lápida de usuarios eliminados (Parte 5): append-only. Un cliente con
        // datos obsoletos no puede revivir una baja, y las bajas nuevas se suman
        // (igual que el resto de listas fusionadas). Se poda después de fusionar
        // los usuarios, para permitir recrear una cuenta con contraseña nueva.
        const serverTombstones = (memoryState && memoryState.deletedUserIds) || [];
        const incomingTombstones = Array.isArray(data.db.deletedUserIds) ? data.db.deletedUserIds : [];
        data.db.deletedUserIds = mergeDeletedUsers(serverTombstones, incomingTombstones);

        // Los usuarios reales del servidor NUNCA se pueden borrar por un cliente
        // con datos obsoletos o por defecto (solo NPCs). Se hace al final para
        // que las fusiones anteriores usen la lista aceptada por el cliente.
        data.db.users = mergeUsers((memoryState && memoryState.users) || [], liveUsers, data.db.deletedUserIds);
        if (!data.db.users.some(isRealUser) && (memoryState && memoryState.users || []).some(isRealUser)) {
          console.log('⛔ sync_db rechazado: eliminaría a todos los jugadores reales.');
          socket.emit('sync_db', { db: memoryState, reason: 'Corrección del servidor (Protección de datos)' });
          return;
        }
        // Una cuenta recreada con contraseña nueva deja de estar bloqueada.
        data.db.deletedUserIds = pruneTombstonesForLiveUsers(data.db.deletedUserIds, data.db.users);

        await saveState(data.db);

        // El usuario recién creado/actualizado puede estar identificado: se
        // reintenta la presencia ahora que existe en el estado del servidor.
        try {
          const uid = Number(socket.data && socket.data.userId);
          if (uid) registerPresence(uid);
          // Refresca la sala mostrada en la lista de conectados al moverse.
          if (onlineUsers.size) emitPresence();
        } catch (err) {
          console.error('Error registrando presencia tras sync_db:', err.message);
        }

        socket.broadcast.emit('sync_db', {
          db: memoryState,
          reason: data.reason || null
        });
      }
    });

    // ⬅️ MÓDULO SOCIAL: identidad del socket (sala privada por jugador)
    // Registra la presencia del jugador en el socket (idempotente por socket:
    // se puede llamar desde `identify` y desde `sync_db` sin contar dos veces).
    // Es necesario en ambos porque al registrar un personaje nuevo el cliente
    // envía `identify` antes de que el usuario exista en el servidor.
    const registerPresence = (uid) => {
      if (!uid) return;
      const prev = socket.data.presenceUid;
      if (prev === uid) return;
      // Si el socket cambia de identidad, libera el conteo anterior.
      if (prev) {
        const n = (onlineUsers.get(prev) || 1) - 1;
        if (n <= 0) onlineUsers.delete(prev); else onlineUsers.set(prev, n);
      }
      const u = memoryState.users.find(x => x.id === uid);
      if (!u || u.is_npc) { socket.data.presenceUid = null; if (prev) emitPresence(); return; }
      onlineUsers.set(uid, (onlineUsers.get(uid) || 0) + 1);
      socket.data.presenceUid = uid;
      emitPresence();
    };

    socket.on('identify', async (data) => {
      const uid = Number(data && data.userId);
      // Sale de las salas anteriores antes de entrar en la nueva.
      for (const room of Array.from(socket.rooms)) {
        if (room !== socket.id && room.startsWith('user:')) socket.leave(room);
      }
      if (!uid) return;
      socket.data.userId = uid;
      socket.join('user:' + uid);

      // Presencia: registra al jugador real como conectado ahora mismo.
      try {
        registerPresence(uid);
      } catch (err) {
        console.error('Error registrando presencia:', err.message);
      }

      // Al identificarse el jugador se comprueba si hoy es su cumpleaños.
      try {
        const res = grantBirthdayIfDue(memoryState, uid);
        if (res) {
          await saveState(memoryState);
          io.emit('sync_db', { db: memoryState, reason: null });
          io.to('user:' + uid).emit('birthday_greeting', res);
        }
      } catch (err) {
        console.error('Error procesando el cumpleaños:', err.message);
      }

      // Aviso de cartas de NPC pendientes (enviadas mientras estaba desconectado).
      try {
        const pend = pendingNpcLetters(memoryState, uid);
        if (pend.length) {
          const fromIds = [...new Set(pend.map(l => Number(l.from)))];
          const fromNames = fromIds
            .map(id => { const u = memoryState.users.find(x => x.id === id); return u ? u.username : null; })
            .filter(Boolean);
          io.to('user:' + uid).emit('npc_letters_pending', {
            count: pend.length,
            hasGift: pend.some(l => l.gift),
            fromNames
          });
        }
      } catch (err) {
        console.error('Error avisando de lechuzas de NPC pendientes:', err.message);
      }
    });

    // ⬅️ EXPLORACIÓN: emite solo al socket del jugador y marca dirty para persistir.
    const explorationUser = () => {
      const uid = Number(socket.data && socket.data.userId);
      if (!uid) return null;
      return memoryState.users.find(u => u.id === uid) || null;
    };
    const emitExplorationUpdate = (user, extra) => {
      socket.emit('exploration:update', {
        userId: user.id,
        merlinTrials: user.merlinTrials,
        demiguiseCollected: user.demiguiseCollected,
        demiguiseCarrying: user.demiguiseCarrying,
        alohomoraLevel: user.alohomoraLevel,
        bagCapacity: user.bagCapacity,
        // Tanda 2: colecciones de exploración avanzada.
        guidePages: user.guidePages,
        arithmancyDoors: user.arithmancyDoors,
        secretPassages: user.secretPassages,
        constellations: user.constellations,
        chests: user.chests,
        galeones: user.galeones,
        points: user.points,
        attrSabiduria: user.attrSabiduria,
        attrValentia: user.attrValentia,
        ...(extra || {})
      });
    };
    // Persistencia ligera: guarda el estado global sin emitir broadcast masivo.
    const persistExploration = async () => {
      try { await saveState(memoryState); } catch (err) { console.error('Error guardando exploración:', err.message); }
    };

    socket.on('exploration:completeMerlin', async (data) => {
      try {
        const trialId = String((data && data.trialId) || '');
        if (!MERLIN_TRIAL_IDS.includes(trialId)) return;
        const user = explorationUser();
        if (!user) return;
        user.merlinTrials = Array.isArray(user.merlinTrials) ? user.merlinTrials : [];
        if (user.merlinTrials.includes(trialId)) return;

        user.merlinTrials.push(trialId);
        user.galeones = (Number(user.galeones) || 0) + 25;
        user.attrSabiduria = (Number(user.attrSabiduria) || 0) + 15;
        user.points = (Number(user.points) || 0) + 10;
        user.bagCapacity = 5 + Math.floor(user.merlinTrials.length / 2);

        const newly = syncTitleUnlocks(user);
        await persistExploration();
        emitExplorationUpdate(user, { event: 'merlin', trialId, reward: { galeones: 25, sabiduria: 15, housePoints: 10 }, newTitles: newly });
      } catch (err) {
        console.error('Error completando Prueba de Merlín:', err.message);
      }
    });

    socket.on('exploration:pickupDemiguise', async (data) => {
      try {
        const statueId = String((data && data.statueId) || '');
        if (!DEMIGUISE_STATUE_IDS.includes(statueId)) return;
        const user = explorationUser();
        if (!user) return;
        if (!isCurfewHour(memoryState)) {
          socket.emit('exploration:error', { message: 'Las estatuas Demiguise solo despiertan en el toque de queda (22:00–07:00).' });
          return;
        }
        user.demiguiseCollected = Array.isArray(user.demiguiseCollected) ? user.demiguiseCollected : [];
        user.demiguiseCarrying = Array.isArray(user.demiguiseCarrying) ? user.demiguiseCarrying : [];
        if (user.demiguiseCollected.includes(statueId) || user.demiguiseCarrying.includes(statueId)) return;

        user.demiguiseCarrying.push(statueId);
        await persistExploration();
        emitExplorationUpdate(user, { event: 'pickup', statueId, carrying: user.demiguiseCarrying.length });
      } catch (err) {
        console.error('Error recogiendo Luna Demiguise:', err.message);
      }
    });

    socket.on('exploration:turnInDemiguise', async () => {
      try {
        const user = explorationUser();
        if (!user) return;
        user.demiguiseCarrying = Array.isArray(user.demiguiseCarrying) ? user.demiguiseCarrying : [];
        if (!user.demiguiseCarrying.length) return;

        user.demiguiseCollected = Array.isArray(user.demiguiseCollected) ? user.demiguiseCollected : [];
        const delivered = user.demiguiseCarrying.slice();
        delivered.forEach(id => { if (!user.demiguiseCollected.includes(id)) user.demiguiseCollected.push(id); });
        user.demiguiseCarrying = [];

        const total = user.demiguiseCollected.length;
        user.galeones = (Number(user.galeones) || 0) + 40 * delivered.length;
        user.attrValentia = (Number(user.attrValentia) || 0) + 20 * delivered.length;
        user.alohomoraLevel = alohomoraLevelFor(user.demiguiseCollected);

        const newly = syncTitleUnlocks(user);
        await persistExploration();
        emitExplorationUpdate(user, {
          event: 'turnIn',
          delivered: delivered.length,
          total,
          reward: { galeones: 40 * delivered.length, valentia: 20 * delivered.length },
          newTitles: newly
        });
      } catch (err) {
        console.error('Error entregando Lunas Demiguise:', err.message);
      }
    });

    /* ===== TANDA 2: Páginas de la Guía de Campo (Revelio) ===== */
    socket.on('exploration:fieldPage', async (data) => {
      try {
        const pageId = String((data && data.pageId) || '');
        const page = catalogById(PHASE2_CATALOGS.guidePages, pageId);
        const user = explorationUser();
        if (!user || !page) return;
        user.guidePages = Array.isArray(user.guidePages) ? user.guidePages : [];
        if (user.guidePages.includes(pageId)) return;
        // El jugador debe estar realmente en la sala de la página.
        if (String(user.loc || '') !== String(page.roomId || '')) {
          socket.emit('exploration:error', { message: 'Esa página no está en esta sala.' });
          return;
        }
        user.guidePages.push(pageId);
        // XP de exploración; la pasiva de Fénix da un 10% extra.
        const baseXp = 15;
        const bonus = Math.round(baseXp * wandFindBonus(user));
        const xp = baseXp + bonus;
        user.flight_xp = (Number(user.flight_xp) || 0) + xp;
        const newly = syncTitleUnlocks(user);
        await persistExploration();
        emitExplorationUpdate(user, {
          event: 'fieldPage', pageId, xp, bonus, total: user.guidePages.length,
          totalPages: PHASE2_CATALOGS.guidePages.length, newTitles: newly
        });
      } catch (err) {
        console.error('Error recogiendo página de la Guía de Campo:', err.message);
      }
    });

    /* ===== TANDA 2: Puertas de Aritmancia ===== */
    socket.on('exploration:arithmancy', async (data) => {
      try {
        const doorId = String((data && data.doorId) || '');
        const door = catalogById(PHASE2_CATALOGS.arithmancyDoors, doorId);
        const user = explorationUser();
        if (!user || !door) return;
        user.arithmancyDoors = Array.isArray(user.arithmancyDoors) ? user.arithmancyDoors : [];
        if (user.arithmancyDoors.includes(doorId)) {
          socket.emit('exploration:arithmancyResult', { ok: true, alreadyOpen: true, doorId });
          return;
        }
        if (String(user.loc || '') !== String(door.roomId || '')) {
          socket.emit('exploration:error', { message: 'Esa puerta no está en esta sala.' });
          return;
        }
        // La solución la conoce solo el servidor: se valida el número enviado.
        const vertices = Array.isArray(door.vertices) ? door.vertices : [];
        const missingIdx = door.missing === 'left' ? 0 : (door.missing === 'right' ? 1 : 2);
        const others = vertices.filter((_, i) => i !== missingIdx);
        const target = Math.floor(Number(door.target) || 0);
        const othersSum = others.reduce((s, v) => s + (Math.floor(Number(v.value)) || 0), 0);
        const expected = target - othersSum;
        const answer = Math.floor(Number(data && data.answer));
        if (!Number.isFinite(answer) || answer !== expected) {
          socket.emit('exploration:arithmancyResult', { ok: false, doorId });
          return;
        }
        user.arithmancyDoors.push(doorId);
        const granted = applyCatalogReward(user, door.reward);
        const newly = syncTitleUnlocks(user);
        await persistExploration();
        emitExplorationUpdate(user, {
          event: 'arithmancy', doorId, rewardLines: granted.lines, cromo: granted.cromo, newTitles: newly
        });
        socket.emit('exploration:arithmancyResult', { ok: true, doorId, rewardLines: granted.lines, cromo: granted.cromo });
      } catch (err) {
        console.error('Error resolviendo puerta de Aritmancia:', err.message);
      }
    });

    /* ===== TANDA 2: Pasadizos Secretos ===== */
    socket.on('exploration:passage', async (data) => {
      try {
        const passageId = String((data && data.passageId) || '');
        const passage = catalogById(PHASE2_CATALOGS.secretPassages, passageId);
        const user = explorationUser();
        if (!user || !passage) return;
        user.secretPassages = Array.isArray(user.secretPassages) ? user.secretPassages : [];
        if (!user.secretPassages.includes(passageId)) {
          if (String(user.loc || '') !== String(passage.roomId || '')) {
            socket.emit('exploration:error', { message: 'Ese pasadizo no está en esta sala.' });
            return;
          }
          user.secretPassages.push(passageId);
          user.flight_xp = (Number(user.flight_xp) || 0) + 10;
        }
        // El atajo teletransporta al jugador a la sala destino.
        user.loc = String(passage.targetRoom || user.loc);
        user.locSlot = '';
        const newly = syncTitleUnlocks(user);
        await persistExploration();
        emitExplorationUpdate(user, {
          event: 'passage', passageId, targetRoom: user.loc, total: user.secretPassages.length, newTitles: newly
        });
      } catch (err) {
        console.error('Error usando pasadizo secreto:', err.message);
      }
    });

    /* ===== TANDA 2: Mesas de Astronomía (constelaciones) ===== */
    socket.on('exploration:constellation', async (data) => {
      try {
        const constId = String((data && data.constellationId) || '');
        const c = catalogById(PHASE2_CATALOGS.constellations, constId);
        const user = explorationUser();
        if (!user || !c) return;
        user.constellations = Array.isArray(user.constellations) ? user.constellations : [];
        if (user.constellations.includes(constId)) return;
        if (String(user.loc || '') !== 'astronomia') {
          socket.emit('exploration:error', { message: 'Las mesas de Astronomía están en la Torre de Astronomía.' });
          return;
        }
        user.constellations.push(constId);
        const granted = applyCatalogReward(user, c.reward);
        // La criatura asociada se registra en el Bestiario.
        let newCreature = null;
        if (c.creature && CREATURES[c.creature]) {
          user.bestiary = Array.isArray(user.bestiary) ? user.bestiary : [];
          if (!user.bestiary.includes(c.creature)) { user.bestiary.push(c.creature); newCreature = c.creature; }
        }
        const newly = syncTitleUnlocks(user);
        await persistExploration();
        emitExplorationUpdate(user, {
          event: 'constellation', constellationId: constId, rewardLines: granted.lines,
          creature: newCreature, newTitles: newly
        });
      } catch (err) {
        console.error('Error descubriendo constelación:', err.message);
      }
    });

    /* ===== TANDA 2: Cofres con nivel de Alohomora ===== */
    socket.on('exploration:chest', async (data) => {
      try {
        const chestId = String((data && data.chestId) || '');
        const chest = catalogById(PHASE2_CATALOGS.chests, chestId);
        const user = explorationUser();
        if (!user || !chest) return;
        user.chests = Array.isArray(user.chests) ? user.chests : [];
        if (user.chests.includes(chestId)) {
          socket.emit('exploration:chestResult', { ok: true, alreadyOpen: true, chestId });
          return;
        }
        if (String(user.loc || '') !== String(chest.roomId || '')) {
          socket.emit('exploration:error', { message: 'Ese cofre no está en esta sala.' });
          return;
        }
        const level = alohomoraLevelFor(user.demiguiseCollected);
        user.alohomoraLevel = level;
        const need = Math.floor(Number(chest.lockLevel) || 1);
        if (level < need) {
          socket.emit('exploration:chestResult', { ok: false, chestId, need, level });
          return;
        }
        user.chests.push(chestId);
        const granted = applyCatalogReward(user, chest.reward);
        const newly = syncTitleUnlocks(user);
        await persistExploration();
        emitExplorationUpdate(user, {
          event: 'chest', chestId, rewardLines: granted.lines, cromo: granted.cromo,
          cosmetic: granted.cosmetic, newTitles: newly
        });
        socket.emit('exploration:chestResult', { ok: true, chestId, rewardLines: granted.lines, cromo: granted.cromo, cosmetic: granted.cosmetic });
      } catch (err) {
        console.error('Error abriendo cofre:', err.message);
      }
    });

    // ⬅️ MÓDULO SOCIAL: nueva solicitud de amistad (notificación en tiempo real)
    socket.on('new_friend_request', async (data) => {
      try {
        const from = Number(data && data.from);
        const to = Number(data && data.to);
        const type = (data && data.type) === 'rival' ? 'rival' : 'friend';
        if (!from || !to || from === to) return;

        const state = await loadState();
        const sender = state.users.find(u => u.id === from);
        const target = state.users.find(u => u.id === to);
        if (!sender || !target) return;
        if (target.is_npc) return;

        const requestId = String((data && data.requestId) || `fr_${from}_${to}_${Date.now()}`);
        const existing = state.friendRequests.find(r => Number(r.from) === from && Number(r.to) === to);
        if (!existing) {
          // El servidor es la fuente de verdad de las solicitudes pendientes.
          state.friendRequests = mergeFriendRequests(
            state.friendRequests,
            [{ id: requestId, from, to, type, at: Date.now() }],
            state.friendRequestsDone,
            state.users
          );
          await saveState(state);
          io.emit('sync_db', { db: memoryState, reason: null });
        }

        const payload = {
          requestId: (existing && existing.id) || requestId,
          from,
          to,
          type,
          fromName: sender.username,
          toName: target.username,
          at: Date.now()
        };
        io.to('user:' + to).emit('new_friend_request', payload);
        io.to('user:' + from).emit('new_friend_request_sent', payload);
      } catch (err) {
        console.error('Error procesando la solicitud de amistad:', err.message);
      }
    });

    // ⬅️ MÓDULO SOCIAL: respuesta a una solicitud (aceptada o rechazada)
    socket.on('friend_request_response', async (data) => {
      try {
        const requestId = String((data && data.requestId) || '');
        if (!requestId) return;
        const accepted = !!(data && data.accepted);
        const from = Number(data && data.from); // quien responde
        const to = Number(data && data.to);     // quien envió la solicitud

        // Mutación síncrona: así un sync_db posterior no reintroduce la solicitud.
        const state = memoryState;
        state.friendRequests = (state.friendRequests || []).filter(r => String(r.id) !== requestId);
        if (!Array.isArray(state.friendRequestsDone)) state.friendRequestsDone = [];
        if (!state.friendRequestsDone.includes(requestId)) state.friendRequestsDone.push(requestId);
        state.friendRequestsDone = state.friendRequestsDone.slice(-200);

        try {
          await saveState(state);
          io.emit('sync_db', { db: memoryState, reason: null });
        } catch (err) {
          console.error('Error guardando la respuesta de amistad:', err.message);
        }

        const payload = { requestId, from, to, accepted, byName: String((data && data.byName) || '') };
        if (to) io.to('user:' + to).emit('friend_request_result', payload);
        if (from) io.to('user:' + from).emit('friend_request_result', payload);
      } catch (err) {
        console.error('Error notificando la respuesta de amistad:', err.message);
      }
    });

    // ⬅️ CORREO POR LECHUZA: se envía una carta (con regalo opcional).
    // El servidor descuenta el regalo del remitente de forma atómica: así el
    // saldo no se puede duplicar ni el regalo enviarse dos veces.
    socket.on('send_letter', async (data) => {
      try {
        const from = Number(data && data.from);
        const to = Number(data && data.to);
        if (!from || !to || from === to) return;
        const state = memoryState;
        const sender = state.users.find(u => u.id === from);
        const target = state.users.find(u => u.id === to);
        if (!sender || !target) return;

        const message = String((data && data.message) || '').slice(0, 400);
        let gift = sanitizeLetterGift(data && data.gift);
        if (!message && !gift) return;

        // Valida y descuenta el regalo antes de adjuntarlo a la carta.
        if (gift) {
          if (gift.type === 'galeones') {
            const amount = Math.max(1, Math.min(LETTER_GIFT_GALEONES_MAX, gift.amount));
            if ((Number(sender.galeones) || 0) < amount) {
              socket.emit('letter_error', { message: 'No tienes suficientes Galeones para ese regalo.' });
              return;
            }
            sender.galeones = (Number(sender.galeones) || 0) - amount;
            gift = { type: 'galeones', amount };
          } else if (gift.type === 'cromo') {
            const entry = (sender.cromos || {})[gift.cromoId];
            const count = (typeof entry === 'number') ? entry : ((entry && entry.count) || 0);
            if (count < 1) {
              socket.emit('letter_error', { message: 'No tienes ese cromo para regalar.' });
              return;
            }
            if (count <= 1) delete sender.cromos[gift.cromoId];
            else sender.cromos[gift.cromoId] = { count: count - 1, image: (entry && entry.image) || undefined };
            gift = { type: 'cromo', cromoId: gift.cromoId };
          } else if (gift.type === 'item') {
            sender.inv = sender.inv || {};
            const have = Number(sender.inv[gift.itemId]) || 0;
            if (have < 1) {
              socket.emit('letter_error', { message: 'No tienes ese objeto en tu mochila.' });
              return;
            }
            if (have <= 1) delete sender.inv[gift.itemId];
            else sender.inv[gift.itemId] = have - 1;
            gift = { type: 'item', itemId: gift.itemId };
          }
        }

        state.letters = Array.isArray(state.letters) ? state.letters : [];
        const letter = {
          id: `ltr_${from}_${to}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          from, to, message, gift, read: false, claimed: false, at: Date.now()
        };
        state.letters.push(letter);
        state.letters = sanitizeLetters(state, state.letters);

        await saveState(state);
        io.emit('sync_db', { db: memoryState, reason: null });
        io.to('user:' + to).emit('new_letter', {
          id: letter.id, from, fromName: sender.username, hasGift: !!gift, message
        });
        socket.emit('letter_sent', { to, toName: target.username });
      } catch (err) {
        console.error('Error enviando lechuza:', err.message);
      }
    });

    // ⬅️ CORREO POR LECHUZA: el destinatario reclama el regalo de una carta.
    // El cromo/monedas se conceden en el servidor para evitar duplicados.
    socket.on('claim_letter', async (data) => {
      try {
        const uid = Number(data && data.userId);
        const letterId = String((data && data.letterId) || '');
        if (!uid || !letterId) return;
        const state = memoryState;
        const user = state.users.find(u => u.id === uid);
        const letter = (state.letters || []).find(l => String(l.id) === letterId);
        if (!user || !letter || Number(letter.to) !== uid) return;

        let granted = null;
        if (letter.gift && !letter.claimed) {
          granted = grantLetterGift(state, user, letter);
          if (!granted) {
            // Regalo no entregable (objeto desconocido): no se marca la carta
            // como reclamada para que el jugador pueda reintentar tras un fix.
            socket.emit('letter_error', { message: 'Ese regalo no se puede entregar todavía. Inténtalo más tarde.' });
          }
        }
        letter.read = true;

        await saveState(state);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('letter_claimed', {
          letterId,
          granted,
          inventory: (user.inv && typeof user.inv === 'object') ? user.inv : {},
          galeones: Number(user.galeones) || 0,
          letterGrantSeq: Number(user.letterGrantSeq) || 0,
          letter: { id: letter.id, claimed: !!letter.claimed, read: !!letter.read }
        });
      } catch (err) {
        console.error('Error reclamando el regalo:', err.message);
      }
    });

    // ⬅️ MERCADO DE CROMOS: nueva oferta de intercambio entre jugadores reales.
    socket.on('send_trade_offer', async (data) => {
      try {
        const from = Number(data && data.from);
        const to = Number(data && data.to);
        if (!from || !to || from === to) return;
        const state = memoryState;
        const sender = state.users.find(u => u.id === from);
        const target = state.users.find(u => u.id === to);
        if (!sender || !target || target.is_npc) return;

        const offer = sanitizeTradeOffer({
          id: `trade_${from}_${to}_${Date.now()}`,
          from, to,
          giveCromoId: data && data.giveCromoId,
          wantCromoId: data && data.wantCromoId,
          status: 'pending'
        }, state.users);
        if (!offer) return;

        state.tradeOffers = Array.isArray(state.tradeOffers) ? state.tradeOffers : [];
        // No se admiten dos ofertas pendientes idénticas.
        const dup = state.tradeOffers.find(o =>
          o.status === 'pending' && Number(o.from) === from && Number(o.to) === to &&
          o.giveCromoId === offer.giveCromoId && o.wantCromoId === offer.wantCromoId);
        if (dup) { socket.emit('trade_error', { message: 'Ya enviaste esa oferta.' }); return; }

        state.tradeOffers.push(offer);
        state.tradeOffers = sanitizeTradeOffers(state, state.tradeOffers);

        await saveState(state);
        io.emit('sync_db', { db: memoryState, reason: null });
        io.to('user:' + to).emit('new_trade_offer', {
          id: offer.id, from, fromName: sender.username,
          giveCromoId: offer.giveCromoId, wantCromoId: offer.wantCromoId
        });
        socket.emit('trade_offer_sent', { to, toName: target.username });
      } catch (err) {
        console.error('Error enviando la oferta de intercambio:', err.message);
      }
    });

    // ⬅️ MERCADO DE CROMOS: aceptar o rechazar una oferta. El intercambio real
    // de cromos se ejecuta aquí, en el servidor, para que ambos inventarios
    // queden siempre consistentes.
    socket.on('trade_response', async (data) => {
      try {
        const uid = Number(data && data.userId);
        const offerId = String((data && data.offerId) || '');
        const accept = !!(data && data.accept);
        if (!uid || !offerId) return;
        const state = memoryState;
        const offer = (state.tradeOffers || []).find(o => String(o.id) === offerId);
        if (!offer || offer.status !== 'pending' || Number(offer.to) !== uid) return;

        if (!accept) {
          offer.status = 'rejected';
          await saveState(state);
          io.emit('sync_db', { db: memoryState, reason: null });
          io.to('user:' + Number(offer.from)).emit('trade_result', { offerId, accepted: false, byId: uid });
          return;
        }

        const giver = state.users.find(u => u.id === Number(offer.from));
        const taker = state.users.find(u => u.id === Number(offer.to));
        if (!giver || !taker) return;
        const countOf = (usr, id) => {
          const e = (usr.cromos || {})[id];
          return (typeof e === 'number') ? e : ((e && e.count) || 0);
        };
        const imgOf = (usr, id) => {
          const e = (usr.cromos || {})[id];
          return (e && typeof e === 'object') ? e.image : undefined;
        };
        // El oferente debe tener el cromo prometido; el receptor, el pedido.
        if (countOf(giver, offer.giveCromoId) < 1 || countOf(taker, offer.wantCromoId) < 1) {
          offer.status = 'cancelled';
          await saveState(state);
          io.emit('sync_db', { db: memoryState, reason: null });
          socket.emit('trade_error', { message: 'Ya no tenéis los cromos acordados.' });
          return;
        }
        const transfer = (fromUser, toUser, cromoId) => {
          const count = countOf(fromUser, cromoId);
          const img = imgOf(fromUser, cromoId);
          if (count <= 1) delete fromUser.cromos[cromoId];
          else fromUser.cromos[cromoId] = { count: count - 1, image: img };
          toUser.cromos = toUser.cromos || {};
          const tc = countOf(toUser, cromoId);
          toUser.cromos[cromoId] = { count: tc + 1, image: imgOf(toUser, cromoId) || img };
        };
        giver.cromos = giver.cromos || {};
        taker.cromos = taker.cromos || {};
        transfer(giver, taker, offer.giveCromoId);
        transfer(taker, giver, offer.wantCromoId);
        offer.status = 'accepted';

        await saveState(state);
        io.emit('sync_db', { db: memoryState, reason: null });
        io.to('user:' + Number(offer.from)).emit('trade_result', { offerId, accepted: true, byId: uid, byName: taker.username });
        io.to('user:' + uid).emit('trade_result', { offerId, accepted: true, byId: Number(offer.from), byName: giver.username });
      } catch (err) {
        console.error('Error respondiendo a la oferta de intercambio:', err.message);
      }
    });

    /* ===== PARTE 4A: ECONOMÍA GRUPAL ===== */

    // Acción social rápida: sube atributos (y afinidad) sin depender de un
    // objetivo concreto. El servidor es la fuente de verdad de los puntos.
    socket.on('social:quickAction', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const kind = String((data && data.kind) || 'chat');
        const social = GAME_BALANCE.attributes.social;
        const def = social[kind];
        if (!def || typeof def !== 'object' || !def.attr || !ATTR_PROP[def.attr]) return;
        const cooldownMs = Math.max(1000, Number(social.cooldownMs) || 12000);
        const cdKey = 'social_' + kind;
        const cd = Math.max(0, (Number(u.socialCooldowns && u.socialCooldowns[cdKey]) || 0) - Date.now());
        if (cd > 0) { socket.emit('social:error', { message: `Espera ${Math.ceil(cd / 1000)} s para otra acción social.` }); return; }
        const prop = ATTR_PROP[def.attr];
        if (prop) u[prop] = Math.max(0, Math.floor(Number(u[prop]) || 0) + def.points);
        if (def.empathy) u.attrEmpatia = Math.max(0, Math.floor(Number(u.attrEmpatia) || 0) + def.empathy);
        u.socialCooldowns = (u.socialCooldowns && typeof u.socialCooldowns === 'object') ? u.socialCooldowns : {};
        u.socialCooldowns[cdKey] = Date.now() + cooldownMs;
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('social:result', {
          ok: true, kind, label: def.label, icon: def.icon,
          attr: def.attr, points: def.points,
          attrValentia: u.attrValentia, attrEmpatia: u.attrEmpatia, attrSabiduria: u.attrSabiduria
        });
      } catch (err) {
        console.error('Error en la acción social:', err.message);
      }
    });

    // Bóveda de Gringotts: depósito, retiro y consulta (con interés vencido).
    socket.on('bank:deposit', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const res = vaultDeposit(u, data && data.amount);
        if (!res.ok) { socket.emit('bank:error', { message: res.message }); return; }
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('bank:result', { ok: true, action: 'deposit', moved: res.moved, vault: u.vault, galeones: u.galeones });
      } catch (err) {
        console.error('Error en el depósito de Gringotts:', err.message);
      }
    });
    socket.on('bank:withdraw', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const res = vaultWithdraw(u, data && data.amount);
        if (!res.ok) { socket.emit('bank:error', { message: res.message }); return; }
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('bank:result', { ok: true, action: 'withdraw', moved: res.moved, vault: u.vault, galeones: u.galeones });
      } catch (err) {
        console.error('Error en el retiro de Gringotts:', err.message);
      }
    });

    // Mercadillo: crear una oferta de intercambio de objetos tangibles.
    socket.on('trade:offer', async (data) => {
      try {
        const from = Number(socket.data && socket.data.userId) || Number(data && data.from);
        const to = Number(data && data.to);
        if (!from || !to || from === to) return;
        const state = memoryState;
        const sender = state.users.find(u => u.id === from);
        const target = state.users.find(u => u.id === to);
        if (!sender || !target || target.is_npc) return;
        const offer = sanitizeItemTrade({
          id: `itemtrade_${from}_${to}_${Date.now()}`,
          from, to,
          giveItemId: data && data.giveItemId, giveQty: data && data.giveQty,
          wantItemId: data && data.wantItemId, wantQty: data && data.wantQty,
          status: 'pending'
        }, state.users);
        if (!offer) { socket.emit('trade:error', { message: 'Oferta inválida.' }); return; }
        if (invCount(sender, offer.giveItemId) < offer.giveQty) {
          socket.emit('trade:error', { message: 'No tienes suficientes objetos para ofrecer.' });
          return;
        }
        state.itemTrades = Array.isArray(state.itemTrades) ? state.itemTrades : [];
        const dup = state.itemTrades.find(o =>
          o.status === 'pending' && Number(o.from) === from && Number(o.to) === to &&
          o.giveItemId === offer.giveItemId && o.wantItemId === offer.wantItemId);
        if (dup) { socket.emit('trade:error', { message: 'Ya enviaste esa oferta.' }); return; }
        state.itemTrades.push(offer);
        state.itemTrades = sanitizeItemTrades(state, state.itemTrades);
        await saveState(state);
        io.emit('sync_db', { db: memoryState, reason: null });
        io.to('user:' + to).emit('trade:newOffer', {
          id: offer.id, from, fromName: sender.username,
          giveItemId: offer.giveItemId, giveQty: offer.giveQty,
          wantItemId: offer.wantItemId, wantQty: offer.wantQty
        });
        socket.emit('trade:sent', { to, toName: target.username });
      } catch (err) {
        console.error('Error creando la oferta del mercadillo:', err.message);
      }
    });

    // Mercadillo: aceptar o rechazar una oferta (intercambio atómico).
    socket.on('trade:accept', async (data) => {
      try {
        const uid = Number(socket.data && socket.data.userId) || Number(data && data.userId);
        const offerId = String((data && data.offerId) || '');
        const accept = (data && typeof data.accept === 'boolean') ? data.accept : true;
        if (!uid || !offerId) return;
        const state = memoryState;
        const res = executeItemTrade(state, offerId, uid, accept);
        if (!res.ok) {
          await saveState(state);
          io.emit('sync_db', { db: memoryState, reason: null });
          socket.emit('trade:error', { message: res.message || 'No se pudo completar el intercambio.' });
          return;
        }
        await saveState(state);
        io.emit('sync_db', { db: memoryState, reason: null });
        if (res.accepted) {
          io.to('user:' + Number(res.offer.from)).emit('trade:result', { offerId, accepted: true, byId: uid, byName: res.taker.username });
          io.to('user:' + uid).emit('trade:result', { offerId, accepted: true, byId: Number(res.offer.from), byName: res.giver.username });
        } else {
          io.to('user:' + Number(res.offer.from)).emit('trade:result', { offerId, accepted: false, byId: uid });
        }
      } catch (err) {
        console.error('Error respondiendo a la oferta del mercadillo:', err.message);
      }
    });

    // Cesta de regalo: regala un objeto de la Mochila a un NPC. Su objeto
    // favorito duplica la afinidad concedida (Parte 4A).
    socket.on('gift:basket', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const npcId = Number(data && data.npcId);
        const itemId = String((data && data.itemId) || '').trim();
        const state = memoryState;
        const npc = state.users.find(x => x.id === npcId && x.is_npc);
        if (!npc) { socket.emit('gift:error', { message: 'Ese personaje no está en el castillo.' }); return; }
        if (invCount(u, itemId) < 1) { socket.emit('gift:error', { message: 'No tienes ese objeto en tu Mochila.' }); return; }
        const { affinity, favorite } = giftAffinityFor(npc, itemId);
        invAdd(u, itemId, -1);
        state.relations = state.relations || {};
        const key = relKeyBetween(u.id, npc.id);
        const rel = state.relations[key] || { friendshipScore: 0, romanceScore: 0, rival: false };
        rel.friendshipScore = Math.min(100, (Number(rel.friendshipScore) || 0) + affinity);
        state.relations[key] = rel;
        await saveState(state);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('gift:result', {
          ok: true, npcId: npc.id, npcName: npc.username, itemId,
          affinity, favorite, friendship: rel.friendshipScore,
          inventory: u.inv
        });
      } catch (err) {
        console.error('Error enviando la cesta de regalo:', err.message);
      }
    });

    /* ===== PARTE 4B: AROS DE ENTRENAMIENTO AÉREO (Tanda 7.1) =====
       Minijuego libre en los terrenos. El cliente envía el resultado; el
       servidor valida los aros, la duración y el enfriamiento antes de pagar. */
    socket.on('flight:hoops', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const check = validateHoopsRun(data, u);
        if (!check.ok) { socket.emit('flight:error', { message: check.message }); return; }
        const rw = hoopsReward(data && data.rings);
        u.flight_xp = (Number(u.flight_xp) || 0) + rw.xp;
        u.galeones = (Number(u.galeones) || 0) + rw.galeones;
        u.socialCooldowns = (u.socialCooldowns && typeof u.socialCooldowns === 'object') ? u.socialCooldowns : {};
        u.socialCooldowns.hoops = Date.now();
        const club = awardClubXp(u, 'dragon', rw.clubXp);
        const newly = syncTitleUnlocks(u);
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('flight:hoopsResult', {
          ok: true, rings: rw.rings, xp: rw.xp, galeones: rw.galeones,
          club, newTitles: newly, flight_xp: u.flight_xp, galeones_total: u.galeones
        });
      } catch (err) {
        console.error('Error en los aros de entrenamiento aéreo:', err.message);
      }
    });

    /* ===== PARTE 4B: APUESTAS AMISTOSAS (Tanda 5.4) =====
       Se apuestan hasta 20 Galeones por una de las dos casas antes de que el
       partido arranque. El pago lo resuelve el servidor al terminar. */
    socket.on('quidditch:bet', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const state = memoryState;
        const matchId = String((data && data.matchId) || '');
        const match = (state.matches || []).find(m => String(m.id) === matchId);
        if (!match) { socket.emit('quidditch:betError', { message: 'Partido no encontrado.' }); return; }
        if (match.status !== 'waiting') { socket.emit('quidditch:betError', { message: 'Las apuestas cierran cuando empieza el partido.' }); return; }
        const b = GAME_BALANCE.quidditch.bets;
        const house = String((data && data.house) || '');
        if (house !== match.a && house !== match.b) { socket.emit('quidditch:betError', { message: 'Esa casa no juega este partido.' }); return; }
        const amount = Math.floor(Number(data && data.amount));
        if (!Number.isFinite(amount) || amount < b.min || amount > b.max) {
          socket.emit('quidditch:betError', { message: `Puedes apostar entre ${b.min} y ${b.max} Galeones.` });
          return;
        }
        match.bets = sanitizeMatchBets(match.bets, match);
        if (match.bets.some(x => Number(x.uid) === Number(u.id))) {
          socket.emit('quidditch:betError', { message: 'Ya tienes una apuesta en este partido.' });
          return;
        }
        if ((Number(u.galeones) || 0) < amount) { socket.emit('quidditch:betError', { message: 'No tienes Galeones suficientes.' }); return; }
        u.galeones = (Number(u.galeones) || 0) - amount;
        match.bets.push({ uid: u.id, house, amount, at: Date.now() });
        match.bets = sanitizeMatchBets(match.bets, match);
        await saveState(state);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('quidditch:betResult', { ok: true, matchId, house, amount, galeones: u.galeones, payout: amount * b.payout });
      } catch (err) {
        console.error('Error registrando la apuesta de Quidditch:', err.message);
      }
    });

    /* ===== PARTE 4B: DESAFÍOS SEMANALES POR CASA (Tanda 7.4) =====
       El servidor es la fuente de verdad. Cada jugador puede reclamar la
       recompensa de su casa una vez por semana si se cumplen los objetivos. */
    socket.on('quidditch:claimWeekly', async () => {
      try {
        const u = profileUser();
        if (!u || !u.house) return;
        const state = memoryState;
        state.weeklyChallenges = sanitizeWeeklyChallenges(state.weeklyChallenges);
        const h = state.weeklyChallenges.houses[u.house];
        if (!h) { socket.emit('quidditch:weeklyError', { message: 'Tu casa no tiene desafíos activos.' }); return; }
        if (!weeklyGoalsMet(h)) { socket.emit('quidditch:weeklyError', { message: 'Tu casa aún no ha completado los desafíos de la semana.' }); return; }
        if (h.claimed) { socket.emit('quidditch:weeklyError', { message: 'Tu casa ya ha reclamado la recompensa esta semana.' }); return; }
        const w = GAME_BALANCE.quidditch.weekly;
        u.galeones = (Number(u.galeones) || 0) + w.rewardGaleones;
        u.points = (Number(u.points) || 0) + w.rewardPoints;
        h.claimed = true;
        reconcileHousePoints(state);
        await saveState(state);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('quidditch:weeklyResult', { ok: true, house: u.house, galeones: w.rewardGaleones, points: w.rewardPoints });
      } catch (err) {
        console.error('Error reclamando el desafío semanal:', err.message);
      }
    });

    /* ===== PARTE 4B: CERRAR EL CURSO / CLAUSURA (Tanda 7.5) =====
       Solo el Director/Profesorado puede cerrar el curso: se corona al campeón,
       se nombra MVP por casa y se publica el resumen en El Profeta. */
    socket.on('quidditch:ceremony', async () => {
      try {
        const uid = Number(socket.data && socket.data.userId);
        const u = uid ? memoryState.users.find(x => x.id === uid) : null;
        if (!u || !u.is_admin) { socket.emit('quidditch:ceremonyError', { message: 'Solo el Director/Profesorado puede cerrar el curso.' }); return; }
        const state = memoryState;
        const summary = buildClosureSummary(state);
        state.closure = summary;
        const c = GAME_BALANCE.quidditch.closure;
        // Recompensa al campeón: cada jugador real de la casa ganadora recibe oro.
        if (summary.champion) {
          state.users.filter(x => x.house === summary.champion && !x.is_npc).forEach(x => {
            x.galeones = (Number(x.galeones) || 0) + c.rewardGaleones;
          });
        }
        // El MVP de cada casa recibe un extra de puntos y oro.
        Object.values(summary.mvpByHouse).forEach(mvp => {
          if (!mvp) return;
          const x = state.users.find(y => y.id === mvp.id);
          if (!x) return;
          x.points = (Number(x.points) || 0) + c.mvpPoints;
          x.galeones = (Number(x.galeones) || 0) + c.rewardGaleones;
        });
        reconcileHousePoints(state);
        await saveState(state);
        io.emit('sync_db', { db: memoryState, reason: null });
        io.emit('quidditch:closure', summary);
      } catch (err) {
        console.error('Error en la ceremonia de clausura:', err.message);
      }
    });

    // ⬅️ AÑADIDO: chat con IA de los NPCs del canon (Groq)
    socket.on('npc_chat', async (data) => {
      const now = Date.now();
      const wait = 8000 - (now - (socket.lastAi || 0));
      if (wait > 0) {
        socket.emit('npc_reply', {
          npcId: data && data.npcId,
          error: true,
          message: `Espera ${Math.ceil(wait / 1000)} s antes de volver a hablar.`
        });
        return;
      }

      const npcId = data && data.npcId;
      const message = String((data && data.message) || '').trim().slice(0, 400);
      if (!message) {
        socket.emit('npc_reply', { npcId, error: true, message: 'Escribe un mensaje antes de enviarlo.' });
        return;
      }

      socket.lastAi = now;

      const personaKey = npcPersonaKey(npcId, data && data.npcName);
      const basePrompt = personaKey ? NPC_PERSONAS[personaKey] : NPC_PERSONAS['harry potter'];
      // Año actual del castillo: lo envía el frontend y, si no llega, se usa el del servidor.
      const currentYear = clampSchoolYear(
        (data && data.year != null && data.year !== '')
          ? data.year
          : (memoryState && memoryState.schoolYear)
      );
      const canonContext = getCanonContext(message, currentYear);
      const systemPrompt = (canonContext ? basePrompt + buildCanonPrompt(canonContext) : basePrompt)
        + buildTimelinePrompt(currentYear);
      const npcName = String((data && data.npcName) || (personaKey ? personaKey.replace(/\b\w/g, c => c.toUpperCase()) : 'Alumno'));
      const petName = data && data.petName ? String(data.petName).slice(0, 40) : '';
      const petPrompt = petName
        ? `\n\nEl jugador lleva a su ${petName} contigo. Menciónalo de forma natural en tu respuesta si encaja en el contexto.`
        : '';
      // El año forma parte de la clave de caché: la respuesta depende de la línea temporal.
      const cacheKey = `${personaKey || 'generic'}|${petName.toLowerCase()}|Y${currentYear}|${message.toLowerCase()}`;

      const cachedText = aiCache.get(cacheKey);
      if (cachedText) {
        socket.emit('npc_reply', { npcId, npcName, text: cachedText, cached: true });
        return;
      }

      if (!AI_ENABLED) {
        socket.emit('npc_reply', {
          npcId, npcName, error: true,
          message: 'La IA de los personajes no está configurada en el servidor (falta GROQ_API_KEY).'
        });
        return;
      }

      const playerName = String((data && data.playerName) || 'un alumno');
      const playerHouse = String((data && data.playerHouse) || 'sin casa');
      const relationship = data && data.relationship != null ? ` (afinidad con el jugador: ${data.relationship}/100)` : '';
      const userPrompt = `${playerName}, de la casa ${playerHouse}${relationship}, se te acerca y te dice: "${message}"`;

      const aiBody = {
        model: AI_MODEL,
        max_tokens: 120,
        temperature: 0.8,
        messages: [
          { role: 'system', content: systemPrompt + petPrompt },
          { role: 'user', content: userPrompt }
        ]
      };
      // Los modelos de razonamiento gastan los 120 tokens pensando y devuelven texto vacío.
      if (/gpt-oss/i.test(AI_MODEL)) aiBody.reasoning_effort = 'low';

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
      try {
        const res = await fetch(AI_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${AI_KEY}`
          },
          body: JSON.stringify(aiBody),
          signal: controller.signal
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          console.error(`Groq respondió ${res.status}: ${detail.slice(0, 200)}`);
          throw new Error(`Groq HTTP ${res.status}`);
        }

        const json = await res.json();
        let text = String(json?.choices?.[0]?.message?.content || '').trim();
        text = text.replace(/^["“']|["”']$/g, '').trim();
        if (!text) throw new Error('Respuesta vacía de Groq');

        aiCache.set(cacheKey, text);
        if (aiCache.size > AI_CACHE_MAX) aiCache.delete(aiCache.keys().next().value);

        socket.emit('npc_reply', { npcId, npcName, text, cached: false });
      } catch (err) {
        console.error('Error consultando Groq:', err.message);
        socket.emit('npc_reply', {
          npcId, npcName, error: true,
          message: `${npcName} no puede responderte ahora mismo. La IA del castillo está indispuesta; prueba de nuevo en unos segundos.`
        });
      } finally {
        clearTimeout(timer);
      }
    });

    // ⬅️ NUEVO: eventos canónicos generados a partir de 3 entradas del lore.json
    socket.on('generate_canon_event', async () => {
      const now = Date.now();
      const wait = 20000 - (now - (socket.lastCanonEvent || 0));
      if (wait > 0) {
        socket.emit('canon_event_generated', {
          error: true,
          message: `El archivo histórico necesita ${Math.ceil(wait / 1000)} s antes de revelar otro presagio.`
        });
        return;
      }

      if (!LORE.length) {
        socket.emit('canon_event_generated', {
          error: true,
          message: 'El archivo histórico del castillo está vacío o no se pudo cargar.'
        });
        return;
      }

      socket.lastCanonEvent = now;
      const currentYear = clampSchoolYear(memoryState && memoryState.schoolYear);
      const picks = pickRandomLore(3, currentYear);
      if (!picks.length) {
        io.emit('canon_event_generated', {
          error: true,
          message: 'El archivo histórico no tiene presagios conocidos para este año.'
        });
        return;
      }
      const loreText = picks.map(e => `- [${e.categoria}] ${e.info}`).join('\n');
      const prompt = `Eres el Director de Hogwarts. Basándote estrictamente en estos datos históricos: ${loreText}, genera un evento corto y misterioso que esté ocurriendo ahora mismo en el castillo. Máximo 2 frases. IMPORTANTE: Actualmente están en el Año ${currentYear} de Hogwarts. No menciones ni des por sabidos eventos que ocurran en años posteriores del canon. Actúa como si el futuro no estuviera escrito.`;

      const payloadBase = {
        entries: picks.map(e => ({ categoria: e.categoria, info: e.info })),
        at: new Date().toISOString()
      };

      if (!AI_ENABLED) {
        io.emit('canon_event_generated', {
          ...payloadBase,
          text: buildFallbackCanonEvent(picks),
          fallback: true
        });
        return;
      }

      const aiBody = {
        model: AI_MODEL,
        max_tokens: 140,
        temperature: 0.9,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: 'Anuncia el presagio en dos frases como máximo.' }
        ]
      };
      if (/gpt-oss/i.test(AI_MODEL)) aiBody.reasoning_effort = 'low';

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
      try {
        const res = await fetch(AI_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${AI_KEY}`
          },
          body: JSON.stringify(aiBody),
          signal: controller.signal
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          console.error(`Groq respondió ${res.status} al generar evento canónico: ${detail.slice(0, 200)}`);
          throw new Error(`Groq HTTP ${res.status}`);
        }

        const json = await res.json();
        let text = String(json?.choices?.[0]?.message?.content || '').trim();
        text = text.replace(/^["“']|["”']$/g, '').trim();
        if (!text) throw new Error('Respuesta vacía de Groq');

        io.emit('canon_event_generated', { ...payloadBase, text, fallback: false });
      } catch (err) {
        console.error('Error generando evento canónico:', err.message);
        // Si Groq falla, el castillo igual recibe un presagio construido con el canon local.
        io.emit('canon_event_generated', {
          ...payloadBase,
          text: buildFallbackCanonEvent(picks),
          fallback: true
        });
      } finally {
        clearTimeout(timer);
      }
    });

    // ⬅️ Generación de retratos IA para cromos de ranas de chocolate (Cloudflare Workers AI)
    socket.on('generate_cromo', async (data) => {
      const cromoId = data && data.cromoId;
      const cromoName = String((data && data.cromoName) || '').trim().slice(0, 80);
      const style = String((data && data.style) || 'retrato de fantasía, estilo cartoon').trim().slice(0, 200);
      if (!cromoId || !cromoName) {
        socket.emit('cromo_image_error', { cromoId, message: 'Faltan datos del cromo.' });
        return;
      }
      const prompt = `${cromoName}, ${style}, cromo de rana de chocolate Harry Potter, portrait`;
      try {
        const base64Image = await generateImageWithAI(prompt);
        const imageUrl = await uploadImageToR2(base64Image);
        socket.emit('cromo_image', { cromoId, image: imageUrl });
      } catch (err) {
        console.error('Error generando cromo:', err.message);
        const msg = /no está configurado|no configurado/i.test(err.message)
          ? 'La generación de imágenes no está configurada en el servidor.'
          : 'No se pudo generar el retrato. Intenta de nuevo.';
        socket.emit('cromo_image_error', { cromoId, message: msg });
      }
    });

    /* ===== PERFIL: VARITA, TÍTULOS, GUARDARROPA Y BESTIARIO (Tandas 4 y 8) =====
       Todas las recompensas y desbloqueos se validan y persisten en el servidor. */
    const profileUser = () => {
      const uid = Number(socket.data && socket.data.userId);
      if (!uid) return null;
      return memoryState.users.find(u => u.id === uid) || null;
    };
    // Resumen del expediente que se devuelve al cliente tras cada cambio.
    const profileSummary = (u) => {
      const cromoCount = Object.values(u.cromos || {})
        .filter(v => ((typeof v === 'number') ? v : (v && v.count) || 0) > 0).length;
      return {
        userId: u.id,
        wand: u.wand || null,
        title: u.title || null,
        unlockedTitles: u.unlockedTitles || [],
        unlockedCosmetics: u.unlockedCosmetics || [],
        equippedCosmetics: u.equippedCosmetics || [],
        bestiary: u.bestiary || [],
        guidePages: u.guidePages || [],
        arithmancyDoors: u.arithmancyDoors || [],
        secretPassages: u.secretPassages || [],
        constellations: u.constellations || [],
        chests: u.chests || [],
        progress: {
          merlin: (u.merlinTrials || []).length, merlinTotal: MERLIN_TRIAL_IDS.length,
          demiguise: (u.demiguiseCollected || []).length, demiguiseTotal: DEMIGUISE_STATUE_IDS.length,
          cromos: cromoCount, cromosTotal: CROMO_IDS.length,
          guide: (u.guidePages || []).length, guideTotal: PHASE2_CATALOGS.guidePages.length,
          arithmancy: (u.arithmancyDoors || []).length, arithmancyTotal: PHASE2_CATALOGS.arithmancyDoors.length,
          passages: (u.secretPassages || []).length, passagesTotal: PHASE2_CATALOGS.secretPassages.length,
          constellations: (u.constellations || []).length, constellationsTotal: PHASE2_CATALOGS.constellations.length,
          chests: (u.chests || []).length, chestsTotal: PHASE2_CATALOGS.chests.length,
          bestiary: (u.bestiary || []).length, bestiaryTotal: Object.keys(CREATURES).length,
          spells: Array.isArray(u.spells) ? u.spells.length : 0,
          classStars: u.classStars || {}
        },
        attrValentia: u.attrValentia, attrEmpatia: u.attrEmpatia, attrSabiduria: u.attrSabiduria,
        // Tanda 3: clubes extracurriculares, exámenes oficiales y defensas.
        clubs: clubSummary(u),
        exams: u.exams || {},
        examAttempts: Number(u.examAttempts) || 0,
        defenseCount: Number(u.defenseCount) || 0
      };
    };

    // Ceremonia de la varita: el núcleo se deriva de las respuestas en el servidor.
    socket.on('wand:choose', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        // Ya tiene varita: solo se permite UNA repetición de la ceremonia (por si
        // hubo un error), y solo si el cliente la pide explícitamente con `retry`.
        const wantsRetry = !!(data && data.retry);
        if (u.wand && !(wantsRetry && (Number(u.wandRedos) || 0) < 1)) {
          socket.emit('wand:result', { ok: false, message: 'Ya tienes tu varita de Ollivanders.' });
          return;
        }
        const answers = Array.isArray(data && data.answers) ? data.answers.slice(0, WAND_QUIZ.length) : [];
        if (answers.length < WAND_QUIZ.length) {
          socket.emit('wand:result', { ok: false, message: 'Debes responder todas las preguntas de Ollivanders.' });
          return;
        }
        const core = pickWandCore(answers);
        const seed = Number(u.id) || 0;
        // La madera y la longitud se derivan del perfil de respuestas (y del id),
        // de forma determinista pero variada entre jugadores.
        const sum = answers.reduce((a, b) => a + (Number(b) || 0), 0);
        const wood = WAND_WOOD_IDS[(seed + sum * 7) % WAND_WOOD_IDS.length];
        const length = WAND_LENGTHS[(seed + sum) % WAND_LENGTHS.length];
        const wand = { core, wood, length, chosenAt: Date.now() };
        if (u.wand) u.wandRedos = (Number(u.wandRedos) || 0) + 1;
        u.wand = wand;
        const newly = syncTitleUnlocks(u);
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('wand:result', { ok: true, wand, wandRedos: u.wandRedos, title: u.title, newTitles: newly, profile: profileSummary(u) });
      } catch (err) {
        console.error('Error en la ceremonia de la varita:', err.message);
      }
    });

    // Equipar / desequipar un título desbloqueado.
    socket.on('title:equip', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const id = String((data && data.titleId) || '');
        if (!TITLES[id] || !(u.unlockedTitles || []).includes(id)) return;
        u.title = (u.title === id) ? null : id;
        await saveState(memoryState);
        socket.emit('profile:update', profileSummary(u));
      } catch (err) {
        console.error('Error equipando título:', err.message);
      }
    });

    // Equipar / desequipar una prenda cosmética desbloqueada.
    socket.on('cosmetic:equip', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const id = String((data && data.cosmeticId) || '');
        if (!COSMETICS[id] || !(u.unlockedCosmetics || []).includes(id)) return;
        u.equippedCosmetics = Array.isArray(u.equippedCosmetics) ? u.equippedCosmetics : [];
        u.equippedCosmetics = u.equippedCosmetics.includes(id)
          ? u.equippedCosmetics.filter(x => x !== id)
          : u.equippedCosmetics.concat(id);
        await saveState(memoryState);
        socket.emit('profile:update', profileSummary(u));
      } catch (err) {
        console.error('Error equipando prenda:', err.message);
      }
    });

    // Registrar una criatura en el Bestiario al interactuar con ella.
    socket.on('creature:seen', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const id = String((data && data.creatureId) || '');
        if (!CREATURES[id]) return;
        u.bestiary = Array.isArray(u.bestiary) ? u.bestiary : [];
        if (u.bestiary.includes(id)) return;
        u.bestiary.push(id);
        const newly = syncTitleUnlocks(u);
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('profile:update', { ...profileSummary(u), event: 'creature', creatureId: id, newTitles: newly });
      } catch (err) {
        console.error('Error registrando criatura:', err.message);
      }
    });

    /* ===== TANDA 3: ATRIBUTOS EFECTIVOS Y PASIVA DE VARITA =====
       Valentía/Empatía efectivas incluyen la pasiva del núcleo (Dragón/Unicornio),
       igual que en el cliente, para validar las defensas verbales con justicia. */
    const effectiveAttr = (u, key) => {
      let base = Number(u[key]) || 0;
      const core = u.wand && u.wand.core;
      if (core === 'dragon' && key === 'attrValentia') base += 1;
      if (core === 'unicornio' && key === 'attrEmpatia') base += 1;
      return base;
    };
    // ¿Puede el jugador presentarse a un examen de este tipo? (curso suficiente)
    const examAvailable = (u, examType) => {
      const t = EXAM_TYPES[examType];
      if (!t) return false;
      const yr = userYear(memoryState, u);
      return yr >= t.year;
    };

    /* ===== TANDA 3.3: CALDERO DE POCIONES (validado en servidor) ===== */
    // El cliente envía la partida; el servidor verifica cada paso contra la receta.
    socket.on('potion:brew', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const recipeId = String((data && data.recipeId) || '');
        const recipe = POTION_RECIPES[recipeId];
        if (!recipe) return;
        if (userYear(memoryState, u) < recipe.year) {
          socket.emit('potion:result', { ok: false, message: `Necesitas ${recipe.year}.º curso para elaborar ${recipe.name}.` });
          return;
        }
        // Orden de ingredientes elegido por el jugador.
        const chosen = Array.isArray(data && data.ingredients) ? data.ingredients.map(String) : [];
        const correctOrder = recipe.ingredients.map(i => i.id);
        const ingredientsOk = chosen.length === correctOrder.length
          && chosen.every((id, i) => id === correctOrder[i]);
        // Removidos en círculo y aciertos de fuego.
        const stirs = Math.floor(Number(data && data.stirs) || 0);
        const [sMin, sMax] = recipe.stirs;
        const stirsOk = stirs >= sMin && stirs <= sMax;
        const heat = Math.floor(Number(data && data.heat) || 0);
        const [hMin, hMax] = recipe.heat;
        const heatOk = heat >= hMin && heat <= hMax;
        const success = ingredientsOk && stirsOk && heatOk;
        if (!success) {
          const fails = [];
          if (!ingredientsOk) fails.push('el orden de los ingredientes');
          if (!stirsOk) fails.push('el número de removidos');
          if (!heatOk) fails.push('el punto del fuego');
          socket.emit('potion:result', { ok: false, recipeId, message: `La poción se arruinó: revisa ${fails.join(', ')}.` });
          return;
        }
        // Recompensa validada en el servidor.
        const b = GAME_BALANCE.potions;
        u.points = (Number(u.points) || 0) + b.housePoints;
        u.galeones = (Number(u.galeones) || 0) + b.galeones;
        u.flight_xp = (Number(u.flight_xp) || 0) + b.xp;
        u.attrSabiduria = (Number(u.attrSabiduria) || 0) + 1;
        u.inv = (u.inv && typeof u.inv === 'object') ? u.inv : {};
        u.inv[recipe.id] = (Number(u.inv[recipe.id]) || 0) + 1;
        const club = awardClubXp(u, recipe.club, b.clubXp);
        const newly = syncTitleUnlocks(u);
        reconcileHousePoints(memoryState);
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('potion:result', {
          ok: true, recipeId, potion: { id: recipe.id, name: recipe.name, icon: recipe.icon },
          reward: { points: b.housePoints, galeones: b.galeones, xp: b.xp, sabiduria: 1 },
          club, newTitles: newly, profile: profileSummary(u)
        });
      } catch (err) {
        console.error('Error elaborando poción:', err.message);
      }
    });

    /* ===== TANDA 3.4: CLASIFICACIÓN DE PLANTAS (Invernaderos) ===== */
    // El cliente envía la acción elegida para cada planta; el servidor verifica
    // que coincide con la acción correcta y que se hizo a tiempo (reflejos).
    socket.on('herbology:care', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const plantId = String((data && data.plantId) || '');
        const plant = HERBOLOGY_PLANTS[plantId];
        if (!plant) return;
        if (String(u.loc || '') !== 'invernaderos') {
          socket.emit('herbology:result', { ok: false, message: 'Las plantas solo se cuidan en los Invernaderos.' });
          return;
        }
        const action = String((data && data.action) || '');
        const correct = action === plant.action;
        if (!correct) {
          socket.emit('herbology:result', { ok: false, plantId, message: `Acción incorrecta con ${plant.name}. ${plant.hint}` });
          return;
        }
        const b = GAME_BALANCE.herbology;
        u.points = (Number(u.points) || 0) + b.housePoints;
        u.galeones = (Number(u.galeones) || 0) + b.galeones;
        u.flight_xp = (Number(u.flight_xp) || 0) + b.xp;
        u.attrEmpatia = (Number(u.attrEmpatia) || 0) + 1;
        // La criatura/planta queda registrada en el Bestiario si procede.
        if (CREATURES[plantId]) {
          u.bestiary = Array.isArray(u.bestiary) ? u.bestiary : [];
          if (!u.bestiary.includes(plantId)) u.bestiary.push(plantId);
        }
        const club = awardClubXp(u, plant.club, b.clubXp);
        const newly = syncTitleUnlocks(u);
        reconcileHousePoints(memoryState);
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('herbology:result', {
          ok: true, plantId, plant: { id: plant.id, name: plant.name, icon: plant.icon },
          reward: { points: b.housePoints, galeones: b.galeones, xp: b.xp, empatia: 1 },
          club, newTitles: newly, profile: profileSummary(u)
        });
      } catch (err) {
        console.error('Error cuidando planta:', err.message);
      }
    });

    /* ===== TANDA 3.2: CLUBES EXTRACURRICULARES =====
       El cliente avisa de la finalización de una clase (que ya gestiona de forma
       local, como en la Tanda 1); el servidor valida la asignatura y concede la
       XP de club correspondiente. Las estrellas se acotan para evitar abusos. */
    socket.on('class:complete', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const subjectKey = String((data && data.subject) || '').trim().toLowerCase();
        const clubId = clubForSubject(subjectKey);
        if (!clubId) return;
        const stars = Math.max(1, Math.min(5, Math.floor(Number(data && data.stars) || 1)));
        const practical = data && data.practical === true;
        const perStar = practical ? GAME_BALANCE.clubs.xpPerPractical : GAME_BALANCE.clubs.xpPerStar;
        const amount = perStar * stars;
        const club = awardClubXp(u, clubId, amount);
        if (!club) return;
        await saveState(memoryState);
        socket.emit('club:update', { clubId, clubs: clubSummary(u), club, newTitles: club.newTitles });
        // Si la XP de club desbloqueó títulos, se reflejan en el estado global.
        if (club.newTitles && club.newTitles.length) io.emit('sync_db', { db: memoryState, reason: null });
      } catch (err) {
        console.error('Error registrando clase para clubes:', err.message);
      }
    });

    /* ===== TANDA 3.1: EXÁMENES OFICIALES T.I.M.O. / É.X.T.A.S.I.S. =====
       Las respuestas correctas NUNCA salen del servidor: se guardan en memoria
       por socket y el cliente solo recibe los enunciados. La calificación, las
       recompensas y los títulos se aplican aquí tras validar el resultado. */
    socket.on('exam:start', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const examType = String((data && data.examType) || 'timo');
        const subjectKey = String((data && data.subject) || '');
        const t = EXAM_TYPES[examType];
        if (!t || !EXAM_SUBJECTS[subjectKey]) return;
        if (!examAvailable(u, examType)) {
          socket.emit('exam:error', { message: `Los exámenes ${t.name} son de ${t.year}.º curso o superior.` });
          return;
        }
        const year = userYear(memoryState, u);
        const questions = await generateExamQuestions(subjectKey, t.questionCount, t.name, year);
        if (!questions.length) {
          socket.emit('exam:error', { message: 'No se pudieron preparar las preguntas del examen.' });
          return;
        }
        // Se guarda la solución en el servidor y se envía al cliente sin ella.
        socket.data.exam = {
          examType, subjectKey, startedAt: Date.now(),
          questions: questions.map(q => ({ question: q.question, options: q.options, correctIndex: q.correctIndex }))
        };
        socket.emit('exam:questions', {
          examType, subjectKey, examName: t.name, subjectName: EXAM_SUBJECTS[subjectKey].name,
          questions: questions.map(q => ({ question: q.question, options: q.options })),
          practical: true
        });
      } catch (err) {
        console.error('Error iniciando examen:', err.message);
        socket.emit('exam:error', { message: 'El examen no pudo comenzar.' });
      }
    });

    socket.on('exam:submit', async (data) => {
      try {
        const u = profileUser();
        const sess = socket.data && socket.data.exam;
        if (!u || !sess) {
          socket.emit('exam:error', { message: 'No hay un examen en curso.' });
          return;
        }
        const t = EXAM_TYPES[sess.examType];
        const subjectKey = sess.subjectKey;
        const subject = EXAM_SUBJECTS[subjectKey];
        // Calificación de las preguntas teóricas.
        const answers = Array.isArray(data && data.answers) ? data.answers : [];
        let correct = 0;
        sess.questions.forEach((q, i) => {
          if (Math.floor(Number(answers[i])) === q.correctIndex) correct++;
        });
        const theoryRatio = correct / sess.questions.length;
        // Prueba práctica: el cliente envía su resultado (booleano validado).
        const practical = data && data.practical === true;
        // Nota global: la teoría pesa 2/3 y la práctica 1/3.
        const score = Math.round((theoryRatio * 0.66 + (practical ? 0.34 : 0)) * 100);
        const passed = theoryRatio >= t.passRatio && practical;
        const distinction = passed && score >= 85;
        // La respuesta del servidor se invalida siempre tras corregir.
        socket.data.exam = null;
        if (!passed) {
          u.examAttempts = (Number(u.examAttempts) || 0) + 1;
          await saveState(memoryState);
          socket.emit('exam:result', { ok: false, examType: sess.examType, subjectKey, score, correct, total: sess.questions.length, passed: false, message: 'No alcanzaste la nota mínima. ¡Inténtalo de nuevo tras repasar!' });
          return;
        }
        // Recompensas validadas en el servidor.
        u.points = (Number(u.points) || 0) + t.housePoints;
        u.galeones = (Number(u.galeones) || 0) + t.galeones;
        u.flight_xp = (Number(u.flight_xp) || 0) + 20;
        if (subject.attr) u[subject.attr] = (Number(u[subject.attr]) || 0) + 2;
        u.examAttempts = (Number(u.examAttempts) || 0) + 1;
        u.exams = (u.exams && typeof u.exams === 'object') ? u.exams : {};
        const prev = u.exams[subjectKey] || {};
        u.exams[subjectKey] = {
          examType: sess.examType,
          best: Math.max(Number(prev.best) || 0, score),
          last: score,
          distinction: !!(prev.distinction || distinction),
          at: Date.now()
        };
        const newTitles = [];
        if (distinction && subject.title && grantTitle(u, subject.title)) newTitles.push(subject.title);
        // Los exámenes alimentan el club afín.
        const clubId = clubForSubject(subjectKey);
        const club = clubId ? awardClubXp(u, clubId, GAME_BALANCE.exams.clubXp) : null;
        const synced = syncTitleUnlocks(u);
        synced.forEach(id => { if (!newTitles.includes(id)) newTitles.push(id); });
        reconcileHousePoints(memoryState);
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('exam:result', {
          ok: true, examType: sess.examType, subjectKey, score, correct, total: sess.questions.length,
          passed: true, distinction,
          reward: { points: t.housePoints, galeones: t.galeones, xp: 20, attr: subject.attr ? 2 : 0 },
          title: distinction ? subject.title : null,
          club, newTitles, profile: profileSummary(u)
        });
      } catch (err) {
        console.error('Error corrigiendo examen:', err.message);
      }
    });

    /* ===== TANDA 3.5: DEFENSA VERBAL ANTE McGONAGALL / PREFECTOS =====
       El jugador escribe una excusa; Groq la evalúa considerando sus atributos
       actuales (Valentía, Empatía, Sabiduría, con la pasiva de varita incluida).
       Un buen argumento evita o reduce el castigo; uno malo lo empeora. */
    socket.on('defense:argue', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const message = String((data && data.message) || '').trim().slice(0, 500);
        if (!message) {
          socket.emit('defense:result', { ok: false, message: 'Escribe tu excusa antes de defenderte.' });
          return;
        }
        const profName = String((data && data.professor) || 'Minerva McGonagall').slice(0, 60);
        const profId = String((data && data.professorId) || 'mcgonagall').slice(0, 40);
        const basePenalty = Math.max(0, Math.min(GAME_BALANCE.defense.maxPenalty, Math.floor(Number(data && data.basePenalty) || 10)));
        const val = effectiveAttr(u, 'attrValentia');
        const emp = effectiveAttr(u, 'attrEmpatia');
        const sab = effectiveAttr(u, 'attrSabiduria');

        // Respaldo si la IA no está disponible: evaluación por atributos + longitud.
        let verdict;
        if (AI_ENABLED) {
          try {
            const systemPrompt = `Eres ${profName}, profesor de Hogwarts, evaluando la excusa de un alumno sorprendido fuera de la cama tras el toque de queda. ` +
              `Considera sus atributos: Valentía ${val}, Empatía ${emp}, Sabiduría ${sab}. Una excusa sincera, respetuosa e ingeniosa convence; una insolente o incoherente empeora el castigo. ` +
              `Devuelve ÚNICAMENTE un JSON válido sin bloques markdown con este esquema exacto: {"success":true o false,"quality":número de 0 a 100,"reply":"tu respuesta en una o dos frases, en español, en personaje"}.`;
            const parsed = await aiChatJSON({ systemPrompt, userPrompt: `La excusa del alumno ${u.username} es: "${message}"`, maxTokens: 320, temperature: 0.8 });
            const success = parsed.success === true || parsed.success === 'true';
            const quality = Math.max(0, Math.min(100, Math.round(Number(parsed.quality) || (success ? 70 : 30))));
            const reply = String(parsed.reply || parsed.message || '').trim().slice(0, 300)
              || (success ? 'Acepto tu explicación. Esta vez.' : 'Tu excusa no es convincente.');
            verdict = { success, quality, reply };
          } catch (err) {
            console.error('Error en defensa verbal con Groq:', err.message);
          }
        }
        if (!verdict) {
          // Heurística local: atributos + riqueza del texto.
          const len = message.split(/\s+/).filter(Boolean).length;
          const attrScore = val * 2 + emp * 2 + sab * 2;
          const quality = Math.max(0, Math.min(100, 30 + attrScore + Math.min(30, len)));
          verdict = {
            success: quality >= 55,
            quality,
            reply: quality >= 55
              ? `Hum… con ${sab} de Sabiduría se te da bien argumentar. Acepto tu explicación, ${u.username}.`
              : `No cuela, ${u.username}. A la cama, y mañana hablamos.`
          };
        }

        // Consecuencias validadas en el servidor.
        let penalty = basePenalty;
        let reward = null;
        if (verdict.success) {
          // La calidad del argumento reduce el castigo proporcionalmente.
          penalty = Math.max(0, Math.round(basePenalty * (1 - verdict.quality / 100)));
          reward = { points: 5, xp: 8 };
          u.flight_xp = (Number(u.flight_xp) || 0) + reward.xp;
          u.attrSabiduria = (Number(u.attrSabiduria) || 0) + 1;
        } else {
          penalty = Math.min(GAME_BALANCE.defense.maxPenalty, basePenalty + 5);
        }
        if (penalty > 0) {
          u.points = Math.max(0, (Number(u.points) || 0) - penalty);
        }
        u.defenseCount = (Number(u.defenseCount) || 0) + 1;
        // Aplica afinidad con el profesor: una buena defensa suma, una mala resta.
        memoryState.profAffinity = memoryState.profAffinity || {};
        const byUser = memoryState.profAffinity[u.id] = memoryState.profAffinity[u.id] || {};
        const delta = verdict.success ? 3 : -2;
        byUser[profId] = Math.max(0, Math.min(100, (Number(byUser[profId]) || 0) + delta));
        // Tras una defensa exitosa, el jugador evita la detención: pequeña gracia.
        if (verdict.success) u.defenseGraceUntil = Date.now() + 30000;
        reconcileHousePoints(memoryState);
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('defense:result', {
          ok: true, success: verdict.success, quality: verdict.quality, reply: verdict.reply,
          penalty, reward, professor: profName, profile: profileSummary(u)
        });
      } catch (err) {
        console.error('Error en defensa verbal:', err.message);
      }
    });

    // Hallazgo mágico al moverse: el servidor calcula probabilidad y recompensa
    // (pasiva de Fénix y mascota rata incluidas) y las persiste.
    socket.on('world:magicFind', async (data) => {
      try {
        const u = profileUser();
        if (!u) return;
        const roomId = String((data && data.room) || '');
        if (!roomId) return;
        const petBonus = (u.pet === 'rata') ? ((Number(u.petLove) || 0) >= 80 ? 0.20 : 0.10) : 0;
        const chance = 0.48 + petBonus + wandFindBonus(u);
        if (Math.random() >= chance) { socket.emit('world:magicFindResult', { found: false }); return; }
        const f = SERVER_FINDS[Math.floor(Math.random() * SERVER_FINDS.length)];
        u.points = (Number(u.points) || 0) + f.pts;
        if (f.xp) u.flight_xp = (Number(u.flight_xp) || 0) + f.xp;
        if (f.galeones) u.galeones = (Number(u.galeones) || 0) + f.galeones;
        // Clasificación (Parte 4A): el hallazgo tangible va a la Mochila; el
        // intangible (Dobby, Peeves, fantasmas…) se registra como encuentro.
        let tangible = null;
        let encounter = null;
        if (f.tangible && f.itemId && FIND_ITEM_DEFS[f.itemId]) {
          invAdd(u, f.itemId, 1);
          tangible = { itemId: f.itemId, name: FIND_ITEM_DEFS[f.itemId].nombre, icon: FIND_ITEM_DEFS[f.itemId].icon, qty: invCount(u, f.itemId) };
        } else {
          u.encounters = sanitizeEncounters(u.encounters);
          const id = `find:${f.name}`;
          const prev = u.encounters.find(e => e.id === id);
          if (prev) { prev.count += 1; prev.at = Date.now(); }
          else u.encounters.push({ id, name: f.name, icon: f.icon, kind: f.kind || 'encounter', count: 1, at: Date.now() });
          u.encounters = sanitizeEncounters(u.encounters);
          encounter = u.encounters.find(e => e.id === id) || null;
        }
        memoryState.log = Array.isArray(memoryState.log) ? memoryState.log : [];
        memoryState.log.unshift({ u: u.username, h: u.house, a: `Hallazgo: ${f.name}`, p: f.pts, x: f.xp });
        memoryState.log.length = Math.min(memoryState.log.length, 15);
        reconcileHousePoints(memoryState);
        await saveState(memoryState);
        io.emit('sync_db', { db: memoryState, reason: null });
        socket.emit('world:magicFindResult', { found: true, find: f, room: roomId, tangible, encounter, inventory: u.inv });
      } catch (err) {
        console.error('Error en hallazgo mágico:', err.message);
      }
    });

    // Desconexión: actualiza la presencia de jugadores reales.
    socket.on('disconnect', () => {
      const uid = socket.data && socket.data.presenceUid;
      if (!uid) return;
      const n = (onlineUsers.get(uid) || 1) - 1;
      if (n <= 0) onlineUsers.delete(uid); else onlineUsers.set(uid, n);
      emitPresence();
    });
  } catch (err) {
    console.error('Error en la conexión:', err);
  }
});

let botTickCounter = 0;

if (require.main === module) setInterval(async () => {
  try {
    // Si no hay jugadores reales conectados, pausamos para no consumir red ni MongoDB
    if (io.engine.clientsCount === 0) return;

    // Usamos el estado en RAM (memoryState) en lugar de descargar todo MongoDB en cada ciclo
    const state = memoryState;
    if (!state || !state.npcAi) return;
    const npcs = state.users.filter(u => u.is_npc && u.house && isEnrolled(state, u));
    if (!npcs.length) return;

    const npc = npcs[Math.floor(Math.random() * npcs.length)];
    const npcYr = userYear(state, npc);
    const availableActs = SERVER_ACTS.filter(a => npcYr >= (a.minYear || 1));

    if (!availableActs.length) return;

    const act = availableActs[Math.floor(Math.random() * availableActs.length)];
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

    reconcileHousePoints(state);
    botTickCounter++;

    // Guardamos en MongoDB Atlas solo cada 5 ciclos (~5 minutos) en vez de cada 25 segundos
    if (botTickCounter % 5 === 0) {
      await saveState(state);
    }

    io.emit('sync_db', { db: memoryState, reason: null });
  } catch (err) {
    console.error('Error en turno autónomo de bot:', err.message);
  }
}, 60000);

// ⬅️ LECHUZAS AUTOMÁTICAS DE NPCs: revisión periódica (30 min por defecto).
// Se añade una ligera variación (jitter) al primer arranque para repartir la
// carga y no coincidir con otros procesos periódicos del servidor.
let npcLetterTickRunning = false;
async function npcLetterTick() {
  if (npcLetterTickRunning) return; // evita solapamientos si una pasada tarda
  npcLetterTickRunning = true;
  try {
    const state = memoryState;
    const created = runNpcLetterTick(state);
    if (!created.length) return;

    const now = Date.now();
    state.letters = Array.isArray(state.letters) ? state.letters : [];
    for (const item of created) {
      // Nota de personalidad (Groq si está disponible; respaldo local si no).
      let message;
      try {
        message = await npcLetterMessage(item.npc, item.giftId, item.player.username);
      } catch (e) {
        message = npcDefaultLine(item.npc.username);
      }
      const letter = {
        id: `npc_${item.npc.id}_${item.player.id}_${now}_${Math.floor(Math.random() * 1000)}`,
        from: item.npc.id,
        to: item.player.id,
        message,
        gift: item.gift,
        npc: true,
        read: false,
        claimed: false,
        at: Date.now()
      };
      state.letters.push(letter);
      state.letters = sanitizeLetters(state, state.letters);
      // Aviso en tiempo real si el jugador está conectado (si no, quedará en espera).
      io.to('user:' + item.player.id).emit('new_letter', {
        id: letter.id, from: letter.from, fromName: item.npc.username,
        hasGift: !!letter.gift, message, npc: true
      });
    }

    await saveState(state);
    io.emit('sync_db', { db: memoryState, reason: null });
    console.log(`🦉 ${created.length} lechuza(s) automática(s) de NPC enviadas.`);
  } catch (err) {
    console.error('Error en el ciclo de lechuzas de NPC:', err.message);
  } finally {
    npcLetterTickRunning = false;
  }
}

// Primer ciclo con retardo aleatorio (entre 1 y 5 min) y luego cada intervalo fijo.
const NPC_LETTER_FIRST_DELAY_MS = Number(process.env.NPC_LETTER_FIRST_DELAY_MS) || (60 * 1000 + Math.floor(Math.random() * 4 * 60 * 1000));
if (require.main === module) setTimeout(() => {
  npcLetterTick();
  setInterval(npcLetterTick, NPC_LETTER_INTERVAL_MS);
}, NPC_LETTER_FIRST_DELAY_MS);

async function startServer() {
  if (uri) {
    try {
      client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 3000,
        connectTimeoutMS: 3000,
        serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
      });
      await client.connect();
      db = client.db('elcastillo');
      await loadState();
      console.log('✅ Conectado a MongoDB Atlas y estado inicial cargado');
    } catch (err) {
      console.error('❌ Error al conectar a MongoDB, usando respaldo local db.json:', err.message);
    }
  } else {
    console.log('⚠️ Variable MONGODB_URI no detectada: funcionando en modo local con db.json.');
  }

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => console.log(`🏰 Servidor en http://0.0.0.0:${PORT}`));
}

if (require.main === module) startServer();

// ⬅️ AÑADIDO: manejo de errores del proceso para no morir en silencio
process.on('unhandledRejection', (e) => console.error('⚠️ UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('⚠️ UncaughtException:', e));

// Exporta los helpers puros para las pruebas automatizadas (el servidor no
// arranca si el módulo se importa con require()).
module.exports = {
  applyLetterGiftToUser,
  grantLetterGift,
  reconcileLetterGrants,
  isRealUser,
  mergeUsers,
  mergeServerAuthority,
  normUserName,
  sanitizeDeletedUsers,
  isDeletedUser,
  isHardDeletedUser,
  mergeDeletedUsers,
  pruneTombstonesForLiveUsers,
  pickWandCore,
  wandFindBonus,
  wandEmpatiaBonus,
  wandValentiaBonus,
  wandAxisOf,
  wandWoodInfo,
  wandCoreInfo,
  effectiveAttrLevel,
  grantTitle,
  syncTitleUnlocks,
  WAND_QUIZ,
  WAND_CORES,
  WAND_WOODS,
  WAND_WOOD_IDS,
  WAND_LENGTHS,
  WAND_WOOD_CATALOG,
  WAND_CORE_CATALOG,
  TITLES,
  COSMETICS,
  CREATURES,
  // Tanda 2: catálogos y ayudantes de exploración.
  PHASE2_CATALOGS,
  ARITHMANCY_CREATURES,
  alohomoraLevelFor,
  catalogById,
  grantCromoByRarity,
  applyCatalogReward,
  // Tanda 3: clubes, pociones, herbología y exámenes.
  GAME_BALANCE,
  CLUBS,
  CLUB_IDS,
  clubForSubject,
  clubXpOf,
  clubLevelOf,
  awardClubXp,
  clubSummary,
  POTION_RECIPES,
  HERBOLOGY_PLANTS,
  HERBOLOGY_ACTIONS,
  EXAM_TYPES,
  EXAM_SUBJECTS,
  EXAM_SUBJECT_IDS,
  generateExamQuestions,
  // Parte 4A: atributos, encuentros, Gringotts, mercadillo y regalos.
  ATTR_CURVE,
  attrLevelFromPoints,
  attrProgress,
  birthdayPrice,
  isBirthdayToday,
  sanitizeEncounters,
  SERVER_FINDS,
  FIND_ITEM_DEFS,
  FIND_ITEM_IDS,
  invCount,
  invAdd,
  accrueVaultInterest,
  vaultDeposit,
  vaultWithdraw,
  executeItemTrade,
  sanitizeItemTrade,
  sanitizeItemTrades,
  mergeItemTrades,
  giftAffinityFor,
  npcFavoriteItem,
  NPC_FAVORITE_ITEMS,
  // Parte 4B: Quidditch avanzado, apuestas, desafíos semanales y clausura.
  QUIDDITCH_POSITIONS,
  QUIDDITCH_ACTIONS,
  positionPassive,
  hoopsReward,
  validateHoopsRun,
  sanitizeMatchBets,
  settleMatchBets,
  settleFinishedMatches,
  mergeMatches,
  currentWeekKey,
  sanitizeWeeklyChallenges,
  applyMatchToWeekly,
  weeklyGoalsMet,
  buildClosureSummary,
  buildMatchChronicleFallback,
  normalizeChronicle,
  defaultDb,
  sanitizeState
};
