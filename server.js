require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Database ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// File upload setup
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
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});
app.use('/uploads', express.static('uploads'));

// ─── DB Init ─────────────────────────────────────────────────
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
        phonepe_merchant_id VARCHAR(100),
        phonepe_salt_key VARCHAR(200),
        qr_code TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS print_jobs (
        id VARCHAR(50) PRIMARY KEY,
        shop_id VARCHAR(50) REFERENCES shops(id),
        file_name VARCHAR(500),
        file_path VARCHAR(500),
        file_type VARCHAR(20),
        copies INTEGER DEFAULT 1,
        color_mode VARCHAR(10) DEFAULT 'bw',
        pages INTEGER DEFAULT 1,
        amount INTEGER,
        status VARCHAR(20) DEFAULT 'pending',
        payment_status VARCHAR(20) DEFAULT 'pending',
        payment_id VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW(),
        printed_at TIMESTAMP
      );
    `);
    console.log('✅ Database ready!');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// SHOP OWNER APIs
// ═══════════════════════════════════════════════════════════

// Register / Update Shop
app.post('/api/shop/register', async (req, res) => {
  try {
    const { name, address, phone, printer_model, price_bw, price_color, phonepe_merchant_id, phonepe_salt_key } = req.body;
    const shopId = 'SHOP_' + uuidv4().substring(0, 8).toUpperCase();

    await pool.query(`
      INSERT INTO shops (id, name, address, phone, printer_model, price_bw, price_color, phonepe_merchant_id, phonepe_salt_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [shopId, name, address, phone, printer_model, price_bw || 5, price_color || 10, phonepe_merchant_id || '', phonepe_salt_key || '']);

    // Generate QR Code
    const qrUrl = `https://qr-se-print-production.up.railway.app/print/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });

    await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);

    res.json({ success: true, shopId, qrCode, qrUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Shop Info
app.get('/api/shop/:shopId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shops WHERE id=$1', [req.params.shopId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Shop not found' });
    const shop = result.rows[0];
    delete shop.phonepe_salt_key;
    res.json(shop);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shop Stats
app.get('/api/shop/:shopId/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        COALESCE(SUM(amount),0) as total_earnings,
        COUNT(CASE WHEN DATE(created_at)=$1 THEN 1 END) as today_orders,
        COALESCE(SUM(CASE WHEN DATE(created_at)=$1 THEN amount ELSE 0 END),0) as today_earnings,
        COALESCE(SUM(CASE WHEN DATE(created_at)=$1 THEN copies ELSE 0 END),0) as today_prints
      FROM print_jobs 
      WHERE shop_id=$2 AND payment_status='paid'
    `, [today, req.params.shopId]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// FILE UPLOAD API
// ═══════════════════════════════════════════════════════════

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { shopId, copies, colorMode } = req.body;
    const jobId = 'JOB_' + uuidv4().substring(0, 10).toUpperCase();
    const fileType = path.extname(req.file.originalname).replace('.', '').toLowerCase();

    // Get shop pricing
    const shopResult = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId]);
    if (shopResult.rows.length === 0) return res.status(404).json({ error: 'Shop not found' });
    const shop = shopResult.rows[0];

    const pricePerPage = colorMode === 'color' ? shop.price_color : shop.price_bw;
    const numCopies = parseInt(copies) || 1;
    const amount = pricePerPage * numCopies;

    await pool.query(`
      INSERT INTO print_jobs (id, shop_id, file_name, file_path, file_type, copies, color_mode, amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [jobId, shopId, req.file.originalname, req.file.path, fileType, numCopies, colorMode || 'bw', amount]);

    res.json({
      success: true,
      jobId,
      fileName: req.file.originalname,
      fileUrl: `/uploads/${req.file.filename}`,
      fileType,
      amount,
      copies: numCopies,
      colorMode: colorMode || 'bw'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PHONEPE PAYMENT APIs
// ═══════════════════════════════════════════════════════════

app.post('/api/payment/create', async (req, res) => {
  try {
    const { jobId } = req.body;
    const jobResult = await pool.query('SELECT j.*, s.phonepe_merchant_id, s.phonepe_salt_key FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1', [jobId]);
    if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
    const job = jobResult.rows[0];

    const merchantId = job.phonepe_merchant_id || process.env.PHONEPE_MERCHANT_ID;
    const saltKey = job.phonepe_salt_key || process.env.PHONEPE_SALT_KEY;
    const saltIndex = process.env.PHONEPE_SALT_INDEX || '1';

    const transactionId = 'TXN_' + uuidv4().substring(0, 12).toUpperCase();
    const amountInPaise = job.amount * 100;

    const payload = {
      merchantId,
      merchantTransactionId: transactionId,
      merchantUserId: 'CUST_' + jobId,
      amount: amountInPaise,
      redirectUrl: `https://qr-se-print-production.up.railway.app/payment/callback?jobId=${jobId}&txnId=${transactionId}`,
      redirectMode: 'REDIRECT',
      callbackUrl: `https://qr-se-print-production.up.railway.app/api/payment/webhook`,
      paymentInstrument: { type: 'PAY_PAGE' }
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const checksum = crypto.createHash('sha256').update(base64Payload + '/pg/v1/pay' + saltKey).digest('hex') + '###' + saltIndex;

    const response = await require('axios').post(
      'https://api.phonepe.com/apis/hermes/pg/v1/pay',
      { request: base64Payload },
      { headers: { 'Content-Type': 'application/json', 'X-VERIFY': checksum } }
    );

    if (response.data.success) {
      await pool.query('UPDATE print_jobs SET payment_id=$1, status=$2 WHERE id=$3', [transactionId, 'payment_initiated', jobId]);
      res.json({ success: true, paymentUrl: response.data.data.instrumentResponse.redirectInfo.url, transactionId });
    } else {
      res.status(400).json({ error: 'Payment initiation failed', details: response.data });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PhonePe Webhook - payment confirm hone pe
app.post('/api/payment/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const body = req.body.toString();
    const data = JSON.parse(Buffer.from(JSON.parse(body).response, 'base64').toString());

    if (data.code === 'PAYMENT_SUCCESS') {
      const txnId = data.data.merchantTransactionId;
      const result = await pool.query(
        'UPDATE print_jobs SET payment_status=$1, status=$2, printed_at=NOW() WHERE payment_id=$3 RETURNING *',
        ['paid', 'queued', txnId]
      );
      console.log(`✅ Payment success: ${txnId} → Job queued for print`);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Payment callback (redirect after payment)
app.get('/payment/callback', async (req, res) => {
  const { jobId, txnId } = req.query;
  // Mark as paid (backup - webhook bhi karta hai)
  await pool.query(
    'UPDATE print_jobs SET payment_status=$1, status=$2 WHERE id=$3 AND payment_status=$4',
    ['paid', 'queued', jobId, 'pending']
  );
  res.redirect(`/print-success?jobId=${jobId}`);
});

// ═══════════════════════════════════════════════════════════
// PRINT JOB APIs (Local Agent use karta hai)
// ═══════════════════════════════════════════════════════════

// Pending jobs fetch (agent polling karta hai)
app.get('/api/jobs/pending/:shopId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, file_name, file_path, file_type, copies, color_mode, amount,
             CONCAT('https://qr-se-print-production.up.railway.app/', file_path) as file_url
      FROM print_jobs 
      WHERE shop_id=$1 AND status='queued' AND payment_status='paid'
      ORDER BY created_at ASC
      LIMIT 5
    `, [req.params.shopId]);
    res.json({ jobs: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Job complete mark karo
app.post('/api/jobs/complete/:jobId', async (req, res) => {
  try {
    await pool.query(
      'UPDATE print_jobs SET status=$1, printed_at=NOW() WHERE id=$2',
      ['printed', req.params.jobId]
    );
    console.log(`🖨️ Job printed: ${req.params.jobId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Job failed
app.post('/api/jobs/failed/:jobId', async (req, res) => {
  try {
    await pool.query('UPDATE print_jobs SET status=$1 WHERE id=$2', ['failed', req.params.jobId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Job status check (customer ke liye)
app.get('/api/jobs/status/:jobId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, status, payment_status, created_at, printed_at FROM print_jobs WHERE id=$1',
      [req.params.jobId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PAGES (HTML serve karna)
// ═══════════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/print/:shopId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'customer.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/print-success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));

// ─── Start ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 QR Se Print Server chal raha hai: Port ${PORT}`);
    console.log(`🌐 URL: https://qr-se-print-production.up.railway.app`);
  });
});
