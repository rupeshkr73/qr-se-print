require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://qr-se-print-production.up.railway.app';

// ─── Database ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// File upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf','.jpg','.jpeg','.png','.doc','.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('File type not allowed'));
  }
});
app.use('/uploads', express.static('uploads'));

// ─── DB Init ──────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        address TEXT,
        phone VARCHAR(20),
        printer_model VARCHAR(100),
        price_bw INTEGER DEFAULT 5,
        price_color INTEGER DEFAULT 10,
        payment_key VARCHAR(200),
        payment_secret VARCHAR(200),
        qr_code TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS print_jobs (
        id VARCHAR(50) PRIMARY KEY,
        shop_id VARCHAR(50),
        file_name VARCHAR(500),
        file_path VARCHAR(500),
        file_type VARCHAR(20),
        copies INTEGER DEFAULT 1,
        color_mode VARCHAR(10) DEFAULT 'bw',
        amount INTEGER,
        status VARCHAR(20) DEFAULT 'pending',
        payment_status VARCHAR(20) DEFAULT 'pending',
        payment_id VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW(),
        printed_at TIMESTAMP
      );
    `);
    console.log('✅ Database ready!');
  } catch(err) {
    console.error('❌ DB error:', err.message);
  }
}

// ═══════════════════════════════════════════════
// SHOP APIs
// ═══════════════════════════════════════════════

app.post('/api/shop/register', async (req, res) => {
  try {
    const { name, address, phone, printer_model, price_bw, price_color, payment_key, payment_secret } = req.body;
    const shopId = 'SHOP_' + uuidv4().substring(0,8).toUpperCase();

    await pool.query(`
      INSERT INTO shops (id,name,address,phone,printer_model,price_bw,price_color,payment_key,payment_secret)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [shopId, name, address, phone, printer_model, price_bw||5, price_color||10, payment_key||'', payment_secret||'']);

    const qrUrl = `${BASE_URL}/print/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width:300, margin:2 });
    await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);

    res.json({ success:true, shopId, qrCode, qrUrl });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shop/:shopId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shops WHERE id=$1', [req.params.shopId]);
    if (!result.rows.length) return res.status(404).json({ error:'Shop not found' });
    const shop = result.rows[0];
    delete shop.payment_secret;
    res.json(shop);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shop/:shopId/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await pool.query(`
      SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(amount),0) as total_earnings,
        COUNT(CASE WHEN DATE(created_at)=$1 THEN 1 END) as today_orders,
        COALESCE(SUM(CASE WHEN DATE(created_at)=$1 THEN amount ELSE 0 END),0) as today_earnings,
        COALESCE(SUM(CASE WHEN DATE(created_at)=$1 THEN copies ELSE 0 END),0) as today_prints
      FROM print_jobs WHERE shop_id=$2 AND payment_status='paid'
    `, [today, req.params.shopId]);
    res.json(r.rows[0]);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// FILE UPLOAD
// ═══════════════════════════════════════════════

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'No file' });
    const { shopId, copies, colorMode } = req.body;
    const jobId = 'JOB_' + uuidv4().substring(0,10).toUpperCase();
    const fileType = path.extname(req.file.originalname).replace('.','').toLowerCase();

    const shopResult = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error:'Shop not found' });
    const shop = shopResult.rows[0];

    const pricePerPage = colorMode === 'color' ? shop.price_color : shop.price_bw;
    const numCopies = parseInt(copies)||1;
    const amount = pricePerPage * numCopies;

    await pool.query(`
      INSERT INTO print_jobs (id,shop_id,file_name,file_path,file_type,copies,color_mode,amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [jobId, shopId, req.file.originalname, req.file.path, fileType, numCopies, colorMode||'bw', amount]);

    res.json({
      success:true, jobId,
      fileName: req.file.originalname,
      fileUrl: `/uploads/${req.file.filename}`,
      fileType, amount, copies: numCopies, colorMode: colorMode||'bw'
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// PAYMENT — TEST MODE (bypass)
// ═══════════════════════════════════════════════

app.post('/api/payment/create', async (req, res) => {
  try {
    const { jobId } = req.body;

    // TEST MODE: seedha paid mark karo, print queue mein daalo
    const txnId = 'TEST_' + uuidv4().substring(0,12).toUpperCase();
    await pool.query(
      'UPDATE print_jobs SET payment_status=$1, status=$2, payment_id=$3 WHERE id=$4',
      ['paid', 'queued', txnId, jobId]
    );

    console.log(`✅ TEST PAYMENT: Job ${jobId} queued for print!`);

    // Seedha success page pe bhejo
    res.json({
      success: true,
      testMode: true,
      redirectUrl: `${BASE_URL}/print-success?jobId=${jobId}&txnId=${txnId}`
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// PRINT JOB APIs (Agent use karta hai)
// ═══════════════════════════════════════════════

app.get('/api/jobs/pending/:shopId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, file_name, file_path, file_type, copies, color_mode, amount,
             CONCAT($1, '/', file_path) as file_url
      FROM print_jobs
      WHERE shop_id=$2 AND status='queued' AND payment_status='paid'
      ORDER BY created_at ASC LIMIT 5
    `, [BASE_URL, req.params.shopId]);
    res.json({ jobs: result.rows });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/complete/:jobId', async (req, res) => {
  try {
    await pool.query(
      'UPDATE print_jobs SET status=$1, printed_at=NOW() WHERE id=$2',
      ['printed', req.params.jobId]
    );
    console.log(`🖨️  PRINTED: ${req.params.jobId}`);
    res.json({ success:true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/failed/:jobId', async (req, res) => {
  try {
    await pool.query('UPDATE print_jobs SET status=$1 WHERE id=$2', ['failed', req.params.jobId]);
    res.json({ success:true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/status/:jobId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,status,payment_status,created_at,printed_at FROM print_jobs WHERE id=$1',
      [req.params.jobId]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Not found' });
    res.json(r.rows[0]);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// PAGES
// ═══════════════════════════════════════════════
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/print/:shopId', (req,res) => res.sendFile(path.join(__dirname,'public','customer.html')));
app.get('/dashboard', (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/print-success', (req,res) => res.sendFile(path.join(__dirname,'public','success.html')));

// ─── Start ────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 QR Se Print — Port ${PORT}`);
    console.log(`🌐 ${BASE_URL}`);
    console.log(`💳 Payment: TEST MODE (bypass)`);
  });
});
