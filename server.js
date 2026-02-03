const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json());

const DB_PATH = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(DB_PATH);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function run(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      lat REAL,
      lng REAL,
      location_updated_at TEXT
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      UNIQUE(from_user_id, to_user_id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, friend_id)
    )
  `);
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const result = await run(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, passwordHash]
    );
    return res.status(201).json({ id: result.lastID, username });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = await get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: '7d'
  });
  return res.json({ token });
});

app.get('/api/users', authMiddleware, async (req, res) => {
  const users = await all(
    'SELECT id, username FROM users WHERE id != ? ORDER BY username',
    [req.user.id]
  );
  return res.json({ users });
});

app.post('/api/friends/request', authMiddleware, async (req, res) => {
  const { toUserId } = req.body;
  if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
  if (Number(toUserId) === req.user.id) {
    return res.status(400).json({ error: 'Cannot friend yourself' });
  }
  const existing = await get(
    'SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?',
    [req.user.id, toUserId]
  );
  if (existing) return res.status(409).json({ error: 'Already friends' });
  try {
    const result = await run(
      'INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, ?)',
      [req.user.id, toUserId, 'pending', new Date().toISOString()]
    );
    return res.status(201).json({ requestId: result.lastID });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Request already sent' });
    }
    return res.status(500).json({ error: 'Request failed' });
  }
});

app.get('/api/friends/requests', authMiddleware, async (req, res) => {
  const requests = await all(
    `SELECT fr.id, fr.from_user_id, u.username
     FROM friend_requests fr
     JOIN users u ON u.id = fr.from_user_id
     WHERE fr.to_user_id = ? AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [req.user.id]
  );
  return res.json({ requests });
});

app.post('/api/friends/accept', authMiddleware, async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: 'requestId required' });
  const request = await get(
    `SELECT * FROM friend_requests WHERE id = ? AND to_user_id = ? AND status = 'pending'`,
    [requestId, req.user.id]
  );
  if (!request) return res.status(404).json({ error: 'Request not found' });
  await run('UPDATE friend_requests SET status = ? WHERE id = ?', [
    'accepted',
    requestId
  ]);
  const now = new Date().toISOString();
  await run(
    'INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)',
    [request.from_user_id, request.to_user_id, now]
  );
  await run(
    'INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)',
    [request.to_user_id, request.from_user_id, now]
  );
  return res.json({ status: 'accepted' });
});

app.post('/api/location', authMiddleware, async (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng must be numbers' });
  }
  await run(
    'UPDATE users SET lat = ?, lng = ?, location_updated_at = ? WHERE id = ?',
    [lat, lng, new Date().toISOString(), req.user.id]
  );
  return res.json({ status: 'updated' });
});

app.get('/api/friends', authMiddleware, async (req, res) => {
  const friends = await all(
    `SELECT u.id, u.username, u.lat, u.lng, u.location_updated_at
     FROM friends f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ?
     ORDER BY u.username`,
    [req.user.id]
  );
  return res.json({ friends });
});

initDb().then(() => {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
});
