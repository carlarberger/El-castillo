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

async function uploadImageToR2(base64Image) {
  if (!R2_ENABLED || !s3Client) {
    throw new Error('Cloudflare R2 no está configurado (faltan variables de entorno).');
  }
  // Limpiar prefijo data: si existe
  const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  const fileName = `cromo-${Date.now()}.jpg`;
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
const io = new Server(server, { cors: { origin: '*' } });

// ⬅️ AÑADIDO: bloquear archivos sensibles ANTES del static
const BLOCKED_PATHS = new Set([
  '/db.json', '/server.js', '/package.json',
  '/package-lock.json', '/.env', '/.gitignore', '/.env.local', '/lore.json'
]);
app.use((req, res, next) => {
  if (BLOCKED_PATHS.has(req.path)) return res.status(403).send('Forbidden');
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
  quidditch_approved: false,
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
    missions: {}
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

  state.users.forEach(u => {
    if (typeof u.yearOffset !== 'number') u.yearOffset = 0;
    if (typeof u.galeones !== 'number') u.galeones = 15;
    if (!u.inv || typeof u.inv !== 'object') u.inv = {};
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
  if (!state.profAffinity || typeof state.profAffinity !== 'object') state.profAffinity = {};
  if (!Array.isArray(state.friendRequests)) state.friendRequests = [];
  if (!Array.isArray(state.friendRequestsDone)) state.friendRequestsDone = [];
  state.friendRequests = sanitizeFriendRequests(state, state.friendRequests);
  state.friendRequestsDone = state.friendRequestsDone.map(id => String(id)).slice(-200);
  if (typeof state.raidShield !== 'number') state.raidShield = 100;
  if (typeof state.npcAi === 'undefined') state.npcAi = true;

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

        const oldUsers = memoryState.users || [];
        for (const nu of data.db.users) {
          const ou = oldUsers.find(o => o.id === nu.id);
          if (ou && (Number(nu.points) - Number(ou.points)) > 500) {
            console.log(`⚠️ Sync bloqueado: ${nu.username} saltó ${nu.points - ou.points} pts.`);
            socket.emit('sync_db', { db: memoryState, reason: 'Corrección del servidor (Anti-Cheat)' });
            return;
          }
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

        await saveState(data.db);

        socket.broadcast.emit('sync_db', {
          db: memoryState,
          reason: data.reason || null
        });
      }
    });

    // ⬅️ MÓDULO SOCIAL: identidad del socket (sala privada por jugador)
    socket.on('identify', (data) => {
      const uid = Number(data && data.userId);
      // Sale de las salas anteriores antes de entrar en la nueva.
      for (const room of Array.from(socket.rooms)) {
        if (room !== socket.id && room.startsWith('user:')) socket.leave(room);
      }
      if (!uid) return;
      socket.data.userId = uid;
      socket.join('user:' + uid);
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

setInterval(async () => {
  try {
    const state = await loadState();
    if (!state.npcAi) return;
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
        serverSelectionTimeoutMS: 3000,
        connectTimeoutMS: 3000,
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

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => console.log(`🏰 Servidor en http://0.0.0.0:${PORT}`));
}

startServer();

// ⬅️ AÑADIDO: manejo de errores del proceso para no morir en silencio
process.on('unhandledRejection', (e) => console.error('⚠️ UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('⚠️ UncaughtException:', e));