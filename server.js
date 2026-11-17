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
try {
  const lorePath = path.join(__dirname, 'lore.json');
  const rawLore = JSON.parse(fs.readFileSync(lorePath, 'utf8'));
  if (Array.isArray(rawLore)) {
    LORE = rawLore
      .filter(e => e && typeof e.info === 'string' && Array.isArray(e.keywords))
      // Cada entrada declara el año escolar mínimo para conocerla (minYear).
      // Si no lo declara, se asume que es conocimiento básico (Año 1).
      .map(e => ({ ...e, minYear: Math.max(1, Math.min(7, Number(e.minYear) || 1)) }));
    console.log(`📚 Cerebro de Hogwarts cargado: ${LORE.length} entradas canónicas.`);
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

  // La edición activa vive en el estado persistente del juego: se devuelve tal
  // cual durante 24 h (o hasta que cambie el año escolar), sin regenerarla por
  // cambios en puntos, logs u otros datos del castillo.
  const now = Date.now();
  const active = memoryState && memoryState.dailyProphet;
  if (active && active.issue && active.year === year && (now - Number(active.generatedAt)) < PROPHET_CACHE_TTL_MS) {
    return res.json({ ok: true, issue: active.issue, cached: true, fallback: !!active.issue.__fallback });
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
    return res.json({ ok: true, issue, cached: false, fallback: true });
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
    return res.json({ ok: true, issue, cached: false, fallback: false });
  } catch (err) {
    console.error('Error generando El Profeta (usando respaldo local):', err.message);
    const issue = fallbackIssue();
    if (issue) issue.__fallback = true;
    await publishIssue(issue);
    return res.json({ ok: true, issue, cached: false, fallback: true });
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
    // Edición activa de El Profeta: { issue, generatedAt, year } o null.
    dailyProphet: null,
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
function mergeUsers(serverUsers, incomingUsers) {
  const server = Array.isArray(serverUsers) ? serverUsers : [];
  const incoming = Array.isArray(incomingUsers) ? incomingUsers : [];
  const serverById = new Map(server.filter(u => u && u.id != null).map(u => [Number(u.id), u]));
  const incomingIds = new Set(incoming.filter(u => u && u.id != null).map(u => Number(u.id)));

  const merged = [];
  incoming.forEach(u => {
    if (!u || u.id == null) return;
    const sv = serverById.get(Number(u.id));
    if (sv && isRealUser(sv) && !isRealUser(u)) { merged.push(sv); return; }
    // Una cuenta protegida no puede quedar sin contraseña: un cliente obsoleto
    // (con `pass` vacío) no debe desactivar la protección de un jugador real.
    if (sv && isRealUser(sv) && !u.pass && sv.pass) {
      merged.push({ ...u, pass: sv.pass });
      return;
    }
    merged.push(u);
  });

  const preserved = [];
  server.forEach(u => {
    if (!u || u.id == null || incomingIds.has(Number(u.id)) || !isRealUser(u)) return;
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
      existing.yearOffset = npc.yearOffset;
      existing.npc_trait = npc.npc_trait;
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
    state.matches.forEach(m => { if (!m.type) m.type = 'amistoso'; });
  }

  reconcileHousePoints(state);
  return state;
}

const DB_FILE = path.join(__dirname, 'db.json');
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
    return;
  }
  const collection = db.collection('gameState');
  await collection.updateOne({ _id: 'global' }, { $set: stateToSave }, { upsert: true });
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

io.on('connection', async (socket) => {
  try {
    const currentState = await loadState();
    socket.emit('init_db', currentState);

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

        // Los usuarios reales del servidor NUNCA se pueden borrar por un cliente
        // con datos obsoletos o por defecto (solo NPCs). Se hace al final para
        // que las fusiones anteriores usen la lista aceptada por el cliente.
        data.db.users = mergeUsers((memoryState && memoryState.users) || [], liveUsers);
        if (!data.db.users.some(isRealUser) && (memoryState && memoryState.users || []).some(isRealUser)) {
          console.log('⛔ sync_db rechazado: eliminaría a todos los jugadores reales.');
          socket.emit('sync_db', { db: memoryState, reason: 'Corrección del servidor (Protección de datos)' });
          return;
        }

        await saveState(data.db);

        socket.broadcast.emit('sync_db', {
          db: memoryState,
          reason: data.reason || null
        });
      }
    });

    // ⬅️ MÓDULO SOCIAL: identidad del socket (sala privada por jugador)
    socket.on('identify', async (data) => {
      const uid = Number(data && data.userId);
      // Sale de las salas anteriores antes de entrar en la nueva.
      for (const room of Array.from(socket.rooms)) {
        if (room !== socket.id && room.startsWith('user:')) socket.leave(room);
      }
      if (!uid) return;
      socket.data.userId = uid;
      socket.join('user:' + uid);

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

        await persistExploration();
        emitExplorationUpdate(user, { event: 'merlin', trialId, reward: { galeones: 25, sabiduria: 15, housePoints: 10 } });
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
        user.alohomoraLevel = total >= 6 ? 3 : (total >= 3 ? 2 : 1);

        await persistExploration();
        emitExplorationUpdate(user, {
          event: 'turnIn',
          delivered: delivered.length,
          total,
          reward: { galeones: 40 * delivered.length, valentia: 20 * delivered.length }
        });
      } catch (err) {
        console.error('Error entregando Lunas Demiguise:', err.message);
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
  mergeUsers
};
