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

// ⚠️ AQUÍ VA TU CONEXIÓN A MONGODB
// Lo leeremos desde Render para que no esté en el código público
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

let db;
const defaultDb = {
  users: [
    { id: 1, username: 'Carla R.', house: 'ravenclaw', points: 90, flight_xp: 35, role: 'student', is_admin: true },
    { id: 2, username: 'Vicente D.', house: 'ravenclaw', points: 70, flight_xp: 20, role: 'student', is_admin: false }
  ],
  houses: [
    { id: 'gryffindor', points: 240 }, { id: 'ravenclaw', points: 224 },
    { id: 'slytherin', points: 215 }, { id: 'hufflepuff', points: 195 }
  ],
  log: [], apps: [], votes: [],
  events: [{ name: 'Copa Inaugural del Trimestre', desc: 'Todas las clases y partidos otorgan puntos dobles.', mult: 2, active: true }],
  period: 'application', clockMode: 'real', mockTime: null, mockDay: null, free: false,
  chat: [], matches: [], cooldowns: {}, missions: {}
};

async function loadState() {
  const collection = db.collection('gameState');
  let state = await collection.findOne({ _id: 'global' });
  if (!state) {
    await collection.insertOne({ _id: 'global', ...defaultDb });
    state = { _id: 'global', ...defaultDb };
  }
  return state;
}

async function saveState(newState) {
  const collection = db.collection('gameState');
  const { _id, ...stateToSave } = newState;
  await collection.updateOne({ _id: 'global' }, { $set: stateToSave }, { upsert: true });
}

io.on('connection', async (socket) => {
  try {
    const currentState = await loadState();
    socket.emit('init_db', currentState);

    socket.on('sync_db', async (data) => {
      if (data && data.db) {
        // Validación básica: Evitar que inunden la base de datos con usuarios falsos de golpe
        if (data.db.users.length > 150) {
           console.log('⚠️ Intento de creación masiva de usuarios bloqueado.');
           return; 
        }

        // Guardar en MongoDB
        await saveState(data.db);
        
        // Retransmitir a los demás
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
  if (!uri) {
    console.log('❌ ERROR: Falta la variable MONGODB_URI en Render.');
    return;
  }
  try {
    await client.connect();
    db = client.db('elcastillo');
    console.log('✅ Conectado a MongoDB Atlas');
    
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`🏰 Servidor en http://localhost:${PORT}`));
  } catch (err) {
    console.error('❌ Error al conectar a MongoDB:', err);
  }
}

startServer();
