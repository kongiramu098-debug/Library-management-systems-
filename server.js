require('dotenv').config();
const express = require('express'), mysql = require('mysql2/promise'), mongoose = require('mongoose');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), fs = require('fs');
const { DB_HOST = 'localhost', DB_USER = 'root', DB_PASS = '', DB_NAME = 'library',
  MONGO_URI = 'mongodb://127.0.0.1:27017/library', JWT_SECRET = 'change_me', PORT = 3000, UPI_ID = '', UPI_NAME = 'Campus Library' } = process.env;

// Rules
const LOAN_DAYS = 14, MAX_BOOKS = 3, FINE_PER_DAY = 5, REWARD = 10;
// Demo time machine (set DEMO_MODE=true in .env): skip days to test late returns
const DEMO = process.env.DEMO_MODE === 'true'; let skipDays = 0;
const now = () => new Date(Date.now() + skipDays * 864e5);

const app = express();
app.use(express.json());
app.use(express.static('public'));

// NoSQL (MongoDB): activity log
const Log = mongoose.model('Log', new mongoose.Schema({
  userId: Number, userName: String, type: String, message: String, at: { type: Date, default: Date.now }
}));
const log = (u, type, message) => Log.create({ userId: u.id, userName: u.name, type, message }).catch(() => {});

let db; // SQL (MySQL)
const w = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));
const auth = role => (req, res, next) => {
  try {
    const u = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    if (role && u.role !== role) return res.status(403).json({ error: 'Not allowed' });
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
};

// ---------- Auth ----------
app.post('/api/login', w(async (req, res) => {
  const { email, password } = req.body;
  const [[u]] = await db.query('SELECT * FROM users WHERE email=?', [email]);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(400).json({ error: 'Wrong email or password' });
  const user = { id: u.id, name: u.name, role: u.role };
  res.json({ token: jwt.sign(user, JWT_SECRET, { expiresIn: '8h' }), user });
}));

app.post('/api/register', w(async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Enter a name, an email and a password of 6+ characters' });
  const [[ex]] = await db.query('SELECT id FROM users WHERE email=?', [email]);
  if (ex) return res.status(400).json({ error: 'That email is already registered' });
  await db.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)',
    [name, email, bcrypt.hashSync(password, 10), role === 'librarian' ? 'librarian' : 'student']);
  res.json({ ok: true });
}));

// ---------- Shared ----------
app.get('/api/sections', auth(), w(async (_, res) => res.json((await db.query('SELECT * FROM sections ORDER BY name'))[0])));
app.get('/api/books', auth(), w(async (req, res) => {
  if (req.user.role === 'student' && (req.query.q || '').trim().length >= 3) log(req.user, 'search', req.query.q.trim());
  const q = `%${req.query.q || ''}%`;
  const [rows] = await db.query(`SELECT b.*, s.name section FROM books b JOIN sections s ON s.id=b.section_id
    WHERE b.title LIKE ? OR b.author LIKE ? OR s.name LIKE ? ORDER BY s.name, b.title`, [q, q, q]);
  res.json(rows);
}));

// ---------- Student ----------
app.get('/api/my', auth('student'), w(async (req, res) => {
  const [[me]] = await db.query('SELECT name, points FROM users WHERE id=?', [req.user.id]);
  const [rows] = await db.query(`SELECT r.*, b.title FROM borrowals r JOIN books b ON b.id=r.book_id
    WHERE r.user_id=? ORDER BY r.borrowed_at DESC`, [req.user.id]);
  rows.forEach(r => { // live fine estimate for unreturned books
    if (!r.returned_at) r.fine = Math.max(0, Math.ceil((now() - new Date(r.due_date)) / 864e5)) * FINE_PER_DAY;
  });
  res.json({ me, rows, rules: { LOAN_DAYS, MAX_BOOKS, FINE_PER_DAY, REWARD } });
}));

app.post('/api/borrow', auth('student'), w(async (req, res) => {
  const [[{ c }]] = await db.query('SELECT COUNT(*) c FROM borrowals WHERE user_id=? AND returned_at IS NULL', [req.user.id]);
  if (c >= MAX_BOOKS) return res.status(400).json({ error: `You can hold ${MAX_BOOKS} books at a time` });
  const [[{ owed }]] = await db.query('SELECT COALESCE(SUM(fine-fine_paid),0) owed FROM borrowals WHERE user_id=? AND returned_at IS NOT NULL', [req.user.id]);
  if (owed > 0) return res.status(400).json({ error: `Pay your fine of ₹${owed} before borrowing` });
  const [[dup]] = await db.query('SELECT id FROM borrowals WHERE user_id=? AND book_id=? AND returned_at IS NULL', [req.user.id, req.body.bookId]);
  if (dup) return res.status(400).json({ error: 'You already have this book' });
  const [u] = await db.query('UPDATE books SET available_copies=available_copies-1 WHERE id=? AND available_copies>0', [req.body.bookId]);
  if (!u.affectedRows) return res.status(400).json({ error: 'No copies available' });
  await db.query('INSERT INTO borrowals (user_id,book_id,borrowed_at,due_date) VALUES (?,?,?,?)',
    [req.user.id, req.body.bookId, now(), new Date(now().getTime() + LOAN_DAYS * 864e5)]);
  log(req.user, 'borrow', `Borrowed book #${req.body.bookId}`);
  res.json({ ok: true });
}));

// Return (student returns own book; librarian can process any)
app.post('/api/return/:id', auth(), w(async (req, res) => {
  const [[r]] = await db.query('SELECT * FROM borrowals WHERE id=? AND returned_at IS NULL', [req.params.id]);
  if (!r || (req.user.role === 'student' && r.user_id !== req.user.id)) return res.status(404).json({ error: 'Borrowal not found' });
  const late = Math.max(0, Math.ceil((now() - new Date(r.due_date)) / 864e5));
  const fine = late * FINE_PER_DAY, pts = late ? 0 : REWARD;
  await db.query('UPDATE borrowals SET returned_at=?, fine=?, reward_points=? WHERE id=?', [now(), fine, pts, r.id]);
  await db.query('UPDATE books SET available_copies=available_copies+1 WHERE id=?', [r.book_id]);
  await db.query('UPDATE users SET points=points+? WHERE id=?', [pts, r.user_id]);
  log(req.user, 'return', late ? `Returned #${r.book_id} ${late} day(s) late, fine ${fine}` : `Returned #${r.book_id} on time, +${pts} points`);
  res.json({ late, fine, points: pts });
}));

// ---------- Librarian ----------
const lib = auth('librarian');
app.get('/api/stats', lib, w(async (_, res) => {
  const [sections] = await db.query(`SELECT s.id, s.name, COUNT(b.id) titles, COALESCE(SUM(b.total_copies),0) total,
    COALESCE(SUM(b.available_copies),0) available FROM sections s LEFT JOIN books b ON b.section_id=s.id GROUP BY s.id ORDER BY s.name`);
  const [[t]] = await db.query(`SELECT (SELECT COUNT(*) FROM users WHERE role='student') students,
    (SELECT COUNT(*) FROM borrowals WHERE returned_at IS NULL) borrowed,
    (SELECT COUNT(*) FROM borrowals WHERE returned_at IS NULL AND due_date<?) overdue,
    (SELECT COALESCE(SUM(fine_paid),0) FROM borrowals) fines,
    (SELECT COALESCE(SUM(fine-fine_paid),0) FROM borrowals WHERE returned_at IS NOT NULL) pending`, [now()]);
  res.json({ sections, totals: t });
}));
app.post('/api/sections', lib, w(async (req, res) => {
  await db.query('INSERT INTO sections (name) VALUES (?)', [req.body.name]); res.json({ ok: true });
}));
app.post('/api/books', lib, w(async (req, res) => {
  const { title, author, sectionId, copies } = req.body, n = Math.max(1, +copies || 1);
  await db.query('INSERT INTO books (title,author,section_id,total_copies,available_copies) VALUES (?,?,?,?,?)', [title, author, sectionId, n, n]);
  log(req.user, 'add-book', `Added "${title}" x${n}`); res.json({ ok: true });
}));
app.delete('/api/books/:id', lib, w(async (req, res) => {
  const [[a]] = await db.query('SELECT COUNT(*) c FROM borrowals WHERE book_id=? AND returned_at IS NULL', [req.params.id]);
  if (a.c) return res.status(400).json({ error: 'Book is currently borrowed' });
  await db.query('DELETE FROM payments WHERE borrowal_id IN (SELECT id FROM borrowals WHERE book_id=?)', [req.params.id]);
  await db.query('DELETE FROM borrowals WHERE book_id=?', [req.params.id]);
  await db.query('DELETE FROM books WHERE id=?', [req.params.id]); res.json({ ok: true });
}));
app.get('/api/students', lib, w(async (_, res) => res.json((await db.query(
  `SELECT id,name,email,points,(SELECT COUNT(*) FROM borrowals WHERE user_id=users.id AND returned_at IS NULL) active
   FROM users WHERE role='student' ORDER BY name`))[0])));
app.post('/api/students', lib, w(async (req, res) => {
  const { name, email, password } = req.body;
  await db.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,"student")', [name, email, bcrypt.hashSync(password, 10)]);
  log(req.user, 'add-student', `Added student ${name}`); res.json({ ok: true });
}));
app.delete('/api/students/:id', lib, w(async (req, res) => {
  const [[a]] = await db.query('SELECT COUNT(*) c FROM borrowals WHERE user_id=? AND returned_at IS NULL', [req.params.id]);
  if (a.c) return res.status(400).json({ error: 'Student still has unreturned books' });
  await db.query('DELETE FROM payments WHERE user_id=?', [req.params.id]);
  await db.query('DELETE FROM borrowals WHERE user_id=?', [req.params.id]);
  await db.query('DELETE FROM users WHERE id=? AND role="student"', [req.params.id]);
  log(req.user, 'remove-student', `Removed student #${req.params.id}`); res.json({ ok: true });
}));
app.get('/api/borrowals', lib, w(async (_, res) => res.json((await db.query(
  `SELECT r.*, (r.returned_at IS NULL AND r.due_date<?) overdue, b.title, u.name student FROM borrowals r JOIN books b ON b.id=r.book_id JOIN users u ON u.id=r.user_id
   ORDER BY r.returned_at IS NULL DESC, r.borrowed_at DESC LIMIT 200`, [now()]))[0])));
app.get('/api/logs', lib, w(async (_, res) => res.json(await Log.find({ type: { $ne: 'search' } }).sort({ at: -1 }).limit(30))));

app.get('/api/history', lib, w(async (req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json((await db.query(`SELECT r.*, (r.returned_at IS NULL AND r.due_date<?) overdue, b.title, u.name student, u.email
    FROM borrowals r JOIN books b ON b.id=r.book_id JOIN users u ON u.id=r.user_id
    WHERE u.name LIKE ? OR u.email LIKE ? OR b.title LIKE ? ORDER BY r.borrowed_at DESC LIMIT 500`, [now(), q, q, q]))[0]);
}));
app.get('/api/searches', lib, w(async (_, res) => res.json(await Log.find({ type: 'search' }).sort({ at: -1 }).limit(50))));

// ---------- Payments (simulated: no real gateway, see README) ----------
// With UPI_ID set: your real UPI ID. Without it: a random demo UPI ID is generated for every payment popup.
const rnd = () => Math.random().toString(36).slice(2, 8);
app.get('/api/payconfig', auth(), (_, res) => res.json({
  upiId: UPI_ID || `library${rnd()}@upi`, payeeName: UPI_NAME, demo: !UPI_ID, ref: 'LIB' + Date.now().toString(36).toUpperCase() + rnd().toUpperCase()
}));
app.post('/api/pay', auth(), w(async (req, res) => {
  const [[r]] = await db.query(`SELECT r.*, b.title, u.name student FROM borrowals r JOIN books b ON b.id=r.book_id
    JOIN users u ON u.id=r.user_id WHERE r.id=? AND r.returned_at IS NOT NULL`, [req.body.borrowalId]);
  if (!r || (req.user.role === 'student' && r.user_id !== req.user.id)) return res.status(404).json({ error: 'Fine not found' });
  const amount = r.fine - r.fine_paid;
  if (amount <= 0) return res.status(400).json({ error: 'Nothing to pay' });
  const method = req.user.role === 'librarian' ? (req.body.method === 'upi-qr' ? 'upi-qr' : 'cash') : (['upi-qr', 'upi-transfer', 'card', 'netbanking'].includes(req.body.method) ? req.body.method : 'card');
  const utr = String(req.body.utr || '').trim().slice(0, 30);
  const okUtr = UPI_ID ? /^\d{12}$/.test(utr) : utr.length >= 6; // demo mode accepts any 6+ characters
  if ((method === 'upi-qr' || method === 'upi-transfer') && req.user.role !== 'librarian' && !okUtr) return res.status(400).json({ error: UPI_ID ? 'Enter the 12-digit UPI transaction ID from your payment app' : 'Enter a transaction ID of 6 or more characters' });
  const ref = 'PAY' + Date.now().toString(36).toUpperCase();
  await db.query('INSERT INTO payments (user_id,borrowal_id,amount,method,ref,utr,paid_at) VALUES (?,?,?,?,?,?,?)', [r.user_id, r.id, amount, method, ref, utr || null, now()]);
  await db.query('UPDATE borrowals SET fine_paid=fine WHERE id=?', [r.id]);
  log(req.user, 'payment', `${r.student} paid ₹${amount} (${method}) for "${r.title}", ref ${ref}`);
  res.json({ ref, amount, method });
}));
app.get('/api/payments', lib, w(async (_, res) => res.json((await db.query(
  `SELECT p.*, u.name student, b.title FROM payments p JOIN users u ON u.id=p.user_id JOIN borrowals r ON r.id=p.borrowal_id
   JOIN books b ON b.id=r.book_id ORDER BY p.paid_at DESC LIMIT 100`))[0])));

// ---------- Demo time machine ----------
const demoInfo = () => ({ demo: DEMO, skipDays, today: now() });
app.get('/api/demo', auth(), (_, res) => res.json(demoInfo()));
app.post('/api/demo/skip', auth(), (req, res) => {
  if (!DEMO) return res.status(403).json({ error: 'Demo mode is off' });
  skipDays += Math.max(0, +req.body.days || 0); res.json(demoInfo());
});
app.post('/api/demo/reset', auth(), (_, res) => { if (DEMO) skipDays = 0; res.json(demoInfo()); });

// ---------- Startup ----------
(async () => {
  const boot = await mysql.createConnection({ host: DB_HOST, user: DB_USER, password: DB_PASS, multipleStatements: true });
  await boot.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``); await boot.end();
  db = mysql.createPool({ host: DB_HOST, user: DB_USER, password: DB_PASS, database: DB_NAME, multipleStatements: true });
  await db.query(fs.readFileSync('schema.sql', 'utf8'));
  await db.query('ALTER TABLE borrowals ADD COLUMN fine_paid INT NOT NULL DEFAULT 0').catch(() => {}); // upgrade older databases
  await db.query('ALTER TABLE payments ADD COLUMN utr VARCHAR(30) NULL').catch(() => {});
  const [[{ c }]] = await db.query("SELECT COUNT(*) c FROM users WHERE role='librarian'");
  if (!c) { // seed default librarian + starter sections
    await db.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,"librarian")',
      ['Head Librarian', 'librarian@library.com', bcrypt.hashSync('admin123', 10)]);
    await db.query("INSERT IGNORE INTO sections (name) VALUES ('Science'),('Fiction'),('History'),('Technology')");
    console.log('Seeded librarian: librarian@library.com / admin123');
  }
  await mongoose.connect(MONGO_URI);
  app.listen(PORT, () => console.log(`Library running at http://localhost:${PORT}`));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
