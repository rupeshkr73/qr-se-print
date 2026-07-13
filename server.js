require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://qr-se-print.onrender.com';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLD_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLD_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

// (Global RAZORPAY_KEY_ID/SECRET removed — each shop now stores its own gateway credentials)

// JWT_SECRET hamesha environment variable se aana chahiye production mein.
// Agar set nahi hai to random secret generate karte hain runtime pe (sirf is
// process ke chalte rehne tak valid — restart pe sab logged out ho jayenge).
// Yeh hardcoded secret se kahin zyada safe hai.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET environment variable set nahi hai! Random secret generate kiya gaya — Render restart hone par sab logged out ho jayenge. Render mein JWT_SECRET add karo.');
}

// Setup Fee collect karne ke liye system owner (Rupesh) ki Razorpay keys.
// Yeh per-shop gateway keys se ALAG hai — yeh sirf ₹499 registration fee ke liye hai.
const SETUP_FEE_AMOUNT = parseInt(process.env.SETUP_FEE_AMOUNT || '499');
const SETUP_ACTUAL_PRICE = parseInt(process.env.SETUP_ACTUAL_PRICE || '999');
const OWNER_RAZORPAY_KEY_ID = process.env.OWNER_RAZORPAY_KEY_ID || '';
const OWNER_RAZORPAY_KEY_SECRET = process.env.OWNER_RAZORPAY_KEY_SECRET || '';

// Super Admin login (Rupesh ka khud ka panel — sabhi shops dekhne ke liye)
const SUPER_ADMIN_ID = process.env.SUPER_ADMIN_ID || '';
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || '';

if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET) {
  console.warn('⚠️  OWNER_RAZORPAY_KEY_ID/SECRET set nahi hai — Setup Fee payment kaam nahi karega jab tak Render mein add na karo.');
}
if (!SUPER_ADMIN_ID || !SUPER_ADMIN_PASSWORD) {
  console.warn('⚠️  SUPER_ADMIN_ID/PASSWORD set nahi hai — Super Admin login kaam nahi karega jab tak Render mein add na karo.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
// verify: raw body stash — Razorpay webhook ka signature RAW body par
// HMAC hota hai, parsed JSON par nahi
app.use(express.json({ limit: '50mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf','.jpg','.jpeg','.png','.doc','.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('File type not allowed'));
  }
});

const PRINTER_MODELS = [
  '🔍 Auto Detect (System Installed Printer)',
  'Epson L120', 'Epson L130', 'Epson L210', 'Epson L220', 'Epson L360', 'Epson L361',
  'Epson L380', 'Epson L385', 'Epson L395', 'Epson L1110', 'Epson L1210', 'Epson L1250',
  'Epson L1255', 'Epson L1300', 'Epson L1350', 'Epson L1455', 'Epson L3100', 'Epson L3101',
  'Epson L3110', 'Epson L3115', 'Epson L3116', 'Epson L3150', 'Epson L3151', 'Epson L3152',
  'Epson L3156', 'Epson L3200', 'Epson L3210', 'Epson L3211', 'Epson L3215', 'Epson L3216',
  'Epson L3250', 'Epson L3251', 'Epson L3252', 'Epson L3255', 'Epson L3256', 'Epson L3260',
  'Epson L3550', 'Epson L3560', 'Epson L4150', 'Epson L4160', 'Epson L4260', 'Epson L5190',
  'Epson L5290', 'Epson L5390', 'Epson L5590', 'Epson L6160', 'Epson L6170', 'Epson L6190',
  'Epson L6270', 'Epson L6290', 'Epson L6460', 'Epson L6490', 'Epson L6570', 'Epson L6580',
  'Epson L8050', 'Epson L8160', 'Epson L8180', 'Epson L11050', 'Epson L14150', 'Epson L15150',
  'Epson L15160', 'Epson L15180', 'Epson L18050',
  'Epson M1100', 'Epson M1120', 'Epson M1140', 'Epson M1170', 'Epson M2120', 'Epson M2140',
  'Epson M2170', 'Epson WF-2810', 'Epson WF-2830', 'Epson WF-3825', 'Epson WF-C5390',
  'Canon PIXMA G1010', 'Canon PIXMA G1020', 'Canon PIXMA G1030', 'Canon PIXMA G2002',
  'Canon PIXMA G2010', 'Canon PIXMA G2012', 'Canon PIXMA G2020', 'Canon PIXMA G2070',
  'Canon PIXMA G3000', 'Canon PIXMA G3010', 'Canon PIXMA G3012', 'Canon PIXMA G3020',
  'Canon PIXMA G3060', 'Canon PIXMA G3070', 'Canon PIXMA G3770', 'Canon PIXMA G4010', 'Canon PIXMA G4020',
  'Canon PIXMA G4070', 'Canon PIXMA G5070', 'Canon PIXMA G6070', 'Canon PIXMA G7070',
  'Canon PIXMA TS207', 'Canon PIXMA TS307', 'Canon PIXMA TS3340', 'Canon PIXMA TS3475',
  'Canon PIXMA E477', 'Canon PIXMA E3370', 'Canon PIXMA E4270', 'Canon PIXMA MG2470',
  'Canon PIXMA MG3070',
  'Canon LBP2900', 'Canon LBP3300', 'Canon LBP6030', 'Canon LBP6230DW', 'Canon LBP226dw',
  'Canon imageCLASS MF3010', 'Canon imageCLASS MF237w', 'Canon imageCLASS MF244dw',
  'HP DeskJet 1112', 'HP DeskJet 2131', 'HP DeskJet 2332', 'HP DeskJet 2710',
  'HP DeskJet 2720', 'HP DeskJet 2776', 'HP DeskJet 2778', 'HP DeskJet 3635',
  'HP DeskJet 3776', 'HP DeskJet 3835', 'HP DeskJet 4178', 'HP DeskJet Ink Advantage 2135',
  'HP Smart Tank 515', 'HP Smart Tank 520', 'HP Smart Tank 580', 'HP Smart Tank 615',
  'HP Smart Tank 670', 'HP Smart Tank 750', 'HP Ink Tank 315', 'HP Ink Tank 319',
  'HP Ink Tank 415', 'HP Ink Tank 419', 'HP Ink Tank Wireless 416',
  'HP LaserJet 1018', 'HP LaserJet 1020', 'HP LaserJet 1022', 'HP LaserJet M1005',
  'HP LaserJet M1136', 'HP LaserJet P1108', 'HP LaserJet P1505', 'HP LaserJet Pro M15a',
  'HP LaserJet Pro M15w', 'HP LaserJet Pro M126nw', 'HP LaserJet Pro M404dn',
  'HP LaserJet Pro MFP M126nw', 'HP LaserJet Pro MFP M225dw',
  'Brother DCP-T220', 'Brother DCP-T225', 'Brother DCP-T226', 'Brother DCP-T310',
  'Brother DCP-T420W', 'Brother DCP-T426W', 'Brother DCP-T520W', 'Brother DCP-T710W',
  'Brother DCP-T820DW', 'Brother HL-1201', 'Brother HL-1221fn', 'Brother HL-L2321D',
  'Brother HL-L2361DN', 'Brother HL-L2375DW', 'Brother MFC-J2330DW', 'Brother MFC-T920DW',
  'Brother MFC-T4500DW',
  'Kyocera Ecosys P2040dn', 'Kyocera Ecosys P2235dn', 'Kyocera Ecosys M2040dn',
  'Kyocera Ecosys M2540dn', 'Kyocera FS-1020D',
  'Ricoh SP 210', 'Ricoh SP 311DN', 'Ricoh MP 2014',
  'Samsung ML-1640', 'Samsung Xpress M2020',
  'Other (Manually Type Below)'
];

async function uploadToCloudinary(fileBuffer, fileType) {
  if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) {
    return Promise.reject(new Error('Cloudinary configured nahi hai — Render environment variables check karo (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)'));
  }
  return new Promise((resolve, reject) => {
    const timestamp = Math.round(Date.now() / 1000);
    const publicId = 'qrprint_' + uuidv4().substring(0,8);
    const signStr = `public_id=${publicId}&timestamp=${timestamp}${CLD_API_SECRET}`;
    const signature = crypto.createHash('sha256').update(signStr).digest('hex');
    const mimeType = fileType === 'pdf' ? 'application/pdf' :
                     ['jpg','jpeg'].includes(fileType) ? 'image/jpeg' :
                     fileType === 'png' ? 'image/png' : 'application/octet-stream';
    const dataUri = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
    const postData = new URLSearchParams({
      file: dataUri, api_key: CLD_API_KEY,
      timestamp: timestamp.toString(), public_id: publicId,
      signature, resource_type: 'raw'
    }).toString();
    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUD_NAME}/raw/upload`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.secure_url) resolve({ url: result.secure_url, publicId: result.public_id });
          else reject(new Error('Cloudinary upload failed: ' + JSON.stringify(result)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function deleteFromCloudinary(publicId) {
  return new Promise((resolve) => {
    const timestamp = Math.round(Date.now() / 1000);
    const signStr = `public_id=${publicId}&timestamp=${timestamp}${CLD_API_SECRET}`;
    const signature = crypto.createHash('sha256').update(signStr).digest('hex');
    const postData = new URLSearchParams({
      public_id: publicId, api_key: CLD_API_KEY,
      timestamp: timestamp.toString(), signature, resource_type: 'raw'
    }).toString();
    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUD_NAME}/raw/destroy`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { console.log(`Deleted: ${publicId}`); } catch(e) {} resolve(); });
    });
    req.on('error', () => resolve());
    req.write(postData);
    req.end();
  });
}

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        address TEXT, phone VARCHAR(20),
        printer_model VARCHAR(150),
        price_bw INTEGER DEFAULT 5,
        price_color INTEGER DEFAULT 10,
        payment_mode VARCHAR(20) DEFAULT 'both',
        password_hash VARCHAR(255),
        payment_gateway VARCHAR(20) DEFAULT '',
        razorpay_key_id VARCHAR(200) DEFAULT '',
        razorpay_key_secret VARCHAR(200) DEFAULT '',
        phonepe_merchant_id VARCHAR(200) DEFAULT '',
        phonepe_salt_key VARCHAR(200) DEFAULT '',
        phonepe_salt_index VARCHAR(10) DEFAULT '1',
        setup_paid BOOLEAN DEFAULT false,
        setup_payment_id VARCHAR(200) DEFAULT '',
        setup_order_id VARCHAR(200) DEFAULT '',
        setup_amount INTEGER DEFAULT 0,
        qr_code TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS print_jobs (
        id VARCHAR(50) PRIMARY KEY,
        shop_id VARCHAR(50),
        file_name VARCHAR(500),
        file_url TEXT,
        file_public_id VARCHAR(500),
        file_type VARCHAR(20),
        total_pages INTEGER DEFAULT 1,
        selected_pages TEXT DEFAULT '',
        copies INTEGER DEFAULT 1,
        color_mode VARCHAR(10) DEFAULT 'bw',
        amount INTEGER,
        status VARCHAR(20) DEFAULT 'pending',
        payment_status VARCHAR(20) DEFAULT 'pending',
        payment_method VARCHAR(20) DEFAULT 'counter',
        payment_id VARCHAR(200),
        razorpay_order_id VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW(),
        printed_at TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20) DEFAULT 'both';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_last_seen TIMESTAMP;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printing_at TIMESTAMP;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_gateway VARCHAR(20) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS razorpay_key_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS razorpay_key_secret VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS phonepe_merchant_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS phonepe_salt_key VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS phonepe_salt_index VARCHAR(10) DEFAULT '1';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_paid BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_payment_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_order_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_amount INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_bw VARCHAR(300) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_color VARCHAR(300) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS referred_by VARCHAR(50) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS referral_earnings INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS referral_rewarded BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS supply_warning VARCHAR(30) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS demo BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMP;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS duplex_mode VARCHAR(10) DEFAULT '';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS duplex BOOLEAN DEFAULT false;
      CREATE TABLE IF NOT EXISTS demo_registrations (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(15) UNIQUE,
        ip VARCHAR(64),
        shop_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS demo_machines (
        machine_id VARCHAR(100) PRIMARY KEY,
        shop_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        shop_id VARCHAR(50),
        amount INTEGER,
        upi_id VARCHAR(120),
        status VARCHAR(20) DEFAULT 'pending',
        requested_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
    `);

    // GRANDFATHER MIGRATION: Purani shops jo setup-fee feature se PEHLE bani thi,
    // unka setup_paid abhi false hai (default) lekin unhone kabhi setup fee dene
    // ka option dekha hi nahi tha. Unhe lock out karna unfair hoga, isliye
    // ek baar ke liye unhe auto-activate kar dete hain. Yeh column sirf ek baar
    // chalta hai — jin shops ka qr_code already generated hai (purana flow se)
    // unhi ko activate karta hai, future naye registrations is condition mein nahi aayenge.
    await pool.query(`
      UPDATE shops SET setup_paid = true
      WHERE setup_paid = false AND qr_code IS NOT NULL AND qr_code != '' AND setup_payment_id = ''
    `);

    // Default setup fee (offer + actual price) seed karo agar database mein abhi tak set nahi hai
    await pool.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('setup_fee_amount', $1)
      ON CONFLICT (key) DO NOTHING
    `, [SETUP_FEE_AMOUNT.toString()]);

    await pool.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('setup_actual_price', $1)
      ON CONFLICT (key) DO NOTHING
    `, [SETUP_ACTUAL_PRICE.toString()]);

    // Agent version seed karo — agar pehle se set nahi hai. Yeh version number
    // har baar badhana hoga jab print_agent.py ka naya code daalo, taaki
    // sab customers ke PC pe Auto-Update trigger ho jaye.
    await pool.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('agent_version', '1')
      ON CONFLICT (key) DO NOTHING
    `);

    // Broken demo logins repair (bcrypt hash galti se gaya tha; login sha256
    // expect karta hai). Idempotent — sirf $2 (bcrypt) wale demo shops.
    const brokenDemos = await pool.query(
      "SELECT id, phone FROM shops WHERE demo=true AND password_hash LIKE '$2%'");
    for (const d of brokenDemos.rows) {
      const h = crypto.createHash('sha256').update(d.phone || '').digest('hex');
      await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [h, d.id]);
      console.log('🔧 Demo login repaired:', d.id);
    }

    console.log('Database ready!');
  } catch(err) { console.error('DB error:', err.message); }
}

async function getSetupFeeAmount() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='setup_fee_amount'");
    if (r.rows.length) return parseInt(r.rows[0].value);
  } catch(e) {}
  return SETUP_FEE_AMOUNT;
}

async function getSetupPricing() {
  try {
    const r = await pool.query("SELECT key, value FROM system_settings WHERE key IN ('setup_fee_amount','setup_actual_price')");
    const map = {};
    r.rows.forEach(row => { map[row.key] = parseInt(row.value); });
    return {
      offerPrice: map.setup_fee_amount ?? SETUP_FEE_AMOUNT,
      actualPrice: map.setup_actual_price ?? SETUP_ACTUAL_PRICE
    };
  } catch(e) {
    return { offerPrice: SETUP_FEE_AMOUNT, actualPrice: SETUP_ACTUAL_PRICE };
  }
}

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Login required' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.shopId = decoded.shopId;
    next();
  } catch(err) {
    return res.status(401).json({ error: 'Session expired, please login again' });
  }
}

// ══════════════ REFER & EARN (shop side) ══════════════
// Referral dashboard: earnings, withdrawable, referred shops list
// ── Shop pause/holiday toggle ──
app.post('/api/shop/pause', verifyToken, async (req, res) => {
  try {
    const paused = !!req.body.paused;
    await pool.query('UPDATE shops SET paused=$1 WHERE id=$2', [paused, req.shopId]);
    res.json({ success: true, paused });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Supply self-report: '' | 'low_ink' | 'no_paper' ──
app.post('/api/shop/supply-warning', verifyToken, async (req, res) => {
  try {
    const w = String(req.body.warning || '');
    if (!['', 'low_ink', 'no_paper'].includes(w))
      return res.status(400).json({ error: 'Invalid warning' });
    await pool.query('UPDATE shops SET supply_warning=$1 WHERE id=$2', [w, req.shopId]);
    res.json({ success: true, warning: w });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 7-din earning breakdown (sirf paid) ──
app.get('/api/shop/earnings-breakdown', verifyToken, async (req, res) => {
  try {
    const daily = await pool.query(
      `SELECT DATE(created_at) as day,
              COUNT(*) as orders,
              COALESCE(SUM(copies),0) as prints,
              COALESCE(SUM(amount),0) as earnings
       FROM print_jobs
       WHERE shop_id=$1 AND payment_status='paid' AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at) ORDER BY day DESC`, [req.shopId]);
    const weeks = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN amount ELSE 0 END),0) as this_week,
              COALESCE(SUM(CASE WHEN created_at <= NOW() - INTERVAL '7 days' AND created_at > NOW() - INTERVAL '14 days' THEN amount ELSE 0 END),0) as last_week
       FROM print_jobs WHERE shop_id=$1 AND payment_status='paid'`, [req.shopId]);
    res.json({ daily: daily.rows, this_week: weeks.rows[0].this_week, last_week: weeks.rows[0].last_week });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/referral', verifyToken, async (req, res) => {
  try {
    const me = await pool.query('SELECT referral_earnings, setup_paid, demo FROM shops WHERE id=$1', [req.shopId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const earnings = me.rows[0].referral_earnings || 0;
    const canRefer = me.rows[0].setup_paid && !me.rows[0].demo; // paid AND non-demo hi refer kare — warna demo user free ₹50 kamata

    // Withdrawn total (done + pending — dono balance se ghatao taaki double-withdraw na ho)
    const wd = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
      [req.shopId]);
    const used = parseInt(wd.rows[0].used) || 0;
    const available = earnings - used;

    // Referred shops list — naam, number, paid status
    const refs = await pool.query(
      `SELECT name, phone, setup_paid, created_at FROM shops WHERE referred_by=$1 ORDER BY created_at DESC`,
      [req.shopId]);

    // Withdrawal history
    const hist = await pool.query(
      `SELECT amount, upi_id, status, requested_at, completed_at FROM withdrawals WHERE shop_id=$1 ORDER BY requested_at DESC`,
      [req.shopId]);

    res.json({
      canRefer,
      earnings,
      available,
      referred: refs.rows.map(r => ({
        name: r.name, phone: r.phone,
        status: r.setup_paid ? 'paid' : 'pending',
        date: r.created_at
      })),
      withdrawals: hist.rows
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Withdrawal request — min ₹500, UPI zaroori
app.post('/api/shop/withdraw', verifyToken, async (req, res) => {
  try {
    const { upi_id } = req.body;
    if (!upi_id || !/^[\w.\-]+@[\w.\-]+$/.test(upi_id.trim()))
      return res.status(400).json({ error: 'Sahi UPI ID daalo (jaise name@bank)' });

    const me = await pool.query('SELECT referral_earnings FROM shops WHERE id=$1', [req.shopId]);
    const earnings = me.rows[0]?.referral_earnings || 0;
    const wd = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
      [req.shopId]);
    const available = earnings - (parseInt(wd.rows[0].used) || 0);

    if (available < 500) return res.status(400).json({ error: `Withdrawal ke liye kam se kam ₹500 chahiye (abhi ₹${available})` });

    // Pending request already hai?
    const pend = await pool.query("SELECT id FROM withdrawals WHERE shop_id=$1 AND status='pending'", [req.shopId]);
    if (pend.rows.length) return res.status(400).json({ error: 'Ek withdrawal request pehle se pending hai' });

    await pool.query('INSERT INTO withdrawals (shop_id, amount, upi_id) VALUES ($1,$2,$3)',
      [req.shopId, available, upi_id.trim()]);
    res.json({ success: true, amount: available });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ WITHDRAWALS (superadmin side) ══════════════
// ── MANUAL ACTIVATE — jab payment Razorpay me dikh raha ho par website
// par match nahi hua (browser band, DB outage me order_id store nahi hua,
// waghera). activateShop hi use hota hai — QR, referral reward sab same. ──
app.post('/api/superadmin/shop/:shopId/activate', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const ref = String((req.body && req.body.payment_ref) || '').trim().slice(0, 60);
    if (!ref) return res.status(400).json({ error: 'Payment reference/ID daalo (Razorpay dashboard se)' });
    const chk = await pool.query('SELECT id, setup_paid FROM shops WHERE id=$1', [shopId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if (chk.rows[0].setup_paid) return res.status(400).json({ error: 'Shop pehle se active hai' });
    const { qrUrl } = await activateShop(shopId, 'MANUAL_' + ref);
    console.log(`Manual activation: ${shopId} | ref: ${ref}`);
    res.json({ success: true, qrUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Password reset (superadmin) — number badal gaya / bhool gaya cases ──
app.post('/api/superadmin/shop/:shopId/reset-password', verifySuperAdmin, async (req, res) => {
  try {
    const temp = 'QSP' + crypto.randomBytes(3).toString('hex');
    const h = crypto.createHash('sha256').update(temp).digest('hex');
    const r = await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2 RETURNING id', [h, req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    console.log(`Password reset by superadmin: ${req.params.shopId}`);
    res.json({ success: true, tempPassword: temp });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Demo accounts list — nazar rakhne + manual delete ke liye ──
app.get('/api/superadmin/demos', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.name, s.phone, s.created_at, s.demo_expires_at,
              (SELECT COUNT(*) FROM print_jobs j WHERE j.shop_id = s.id) as total_jobs,
              (SELECT COUNT(*) FROM print_jobs j WHERE j.shop_id = s.id AND j.payment_status='paid') as prints
       FROM shops s WHERE s.demo = true
       ORDER BY s.created_at DESC`);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/withdrawals', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT w.id, w.shop_id, s.name, s.phone, w.amount, w.upi_id, w.status, w.requested_at, w.completed_at
       FROM withdrawals w LEFT JOIN shops s ON w.shop_id=s.id
       ORDER BY (w.status='pending') DESC, w.requested_at DESC`);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/withdrawals/:id/complete', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE withdrawals SET status='done', completed_at=NOW() WHERE id=$1 AND status='pending' RETURNING shop_id, amount",
      [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pending withdrawal nahi mili' });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════ FREE DEMO (2 ghante) ══════════════════
// Anti-abuse: (1) ek phone = ek demo PERMANENT, (2) ek IP = 2/din,
// (3) ek MACHINE = ek demo permanent (agent MachineGuid bhejta hai).
function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}
function isDemoExpired(shop) {
  return shop && shop.demo && shop.demo_expires_at &&
         new Date(shop.demo_expires_at).getTime() < Date.now();
}

app.post('/api/demo/create', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 100);
    const phone = normPhone(req.body.phone);
    if (!name) return res.status(400).json({ error: 'Naam daalo' });
    if (!phone) return res.status(400).json({ error: 'Sahi 10-digit mobile number daalo' });

    // Layer 1: phone permanent lock
    const dup = await pool.query('SELECT id FROM demo_registrations WHERE phone=$1', [phone]);
    if (dup.rows.length)
      return res.status(400).json({ error: 'Is number par demo pehle liya ja chuka hai. Pasand aaya tha? Ab register karo 🙂' });

    // Layer 2: IP — max 2 demo/din
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60);
    const ipCount = await pool.query(
      "SELECT COUNT(*) FROM demo_registrations WHERE ip=$1 AND created_at > NOW() - INTERVAL '24 hours'", [ip]);
    if (parseInt(ipCount.rows[0].count) >= 2)
      return res.status(429).json({ error: 'Aaj ke liye demo limit ho gayi — kal try karo ya abhi register karo' });

    const shopId = 'DEMO_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const passwordHash = crypto.createHash('sha256').update(phone).digest('hex');
    await pool.query(
      `INSERT INTO shops (id, name, phone, price_bw, price_color, payment_mode, password_hash,
                          setup_paid, setup_amount, demo, demo_expires_at)
       VALUES ($1,$2,$3,5,10,'counter_only',$4,true,0,true,NOW() + INTERVAL '2 hours')`,
      [shopId, name + ' (Demo)', phone, passwordHash]);
    await pool.query('INSERT INTO demo_registrations (phone, ip, shop_id) VALUES ($1,$2,$3)', [phone, ip, shopId]);

    const qrUrl = `${BASE_URL}/print/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
    await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);

    console.log(`Demo created: ${shopId} | ${phone} | ip ${ip}`);
    res.json({ success: true, shopId, password: phone, qrUrl, qrCode,
               expiresInMinutes: 120,
               note: 'Login password = aapka mobile number' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/printer-models', (req, res) => {
  res.json({ models: PRINTER_MODELS });
});

app.get('/api/setup-fee/current', async (req, res) => {
  try {
    const pricing = await getSetupPricing();
    res.json({ amount: pricing.offerPrice, offerPrice: pricing.offerPrice, actualPrice: pricing.actualPrice });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/setup-fee/amount/:shopId', async (req, res) => {
  try {
    const r = await pool.query('SELECT setup_amount, setup_paid FROM shops WHERE id=$1', [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json({ amount: r.rows[0].setup_amount, paid: r.rows[0].setup_paid });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/register', async (req, res) => {
  try {
    const {
      name, address, phone, printer_model, price_bw, price_color, payment_mode, password,
      payment_gateway, razorpay_key_id, razorpay_key_secret,
      phonepe_merchant_id, phonepe_salt_key, phonepe_salt_index, ref
    } = req.body;

    // Referral: ?ref=SHOP_XXX se aaya — sirf tab valid jab wo referrer
    // EXIST kare aur khud PAID ho (unpaid shop refer nahi kar sakta),
    // aur khud ko refer na kare
    let referredBy = '';
    if (ref && typeof ref === 'string') {
      const r = await pool.query('SELECT id FROM shops WHERE id=$1 AND setup_paid=true AND demo=false', [ref.trim()]);
      if (r.rows.length) referredBy = ref.trim();
    }

    if (!name || !name.trim()) return res.status(400).json({ error: 'Shop ka naam zaroori hai' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password kam se kam 4 character ka hona chahiye' });

    const validPaymentModes = ['both', 'counter_only', 'online_only'];
    const finalPaymentMode = validPaymentModes.includes(payment_mode) ? payment_mode : 'both';

    const needsGateway = finalPaymentMode === 'both' || finalPaymentMode === 'online_only';
    let finalGateway = '';
    if (needsGateway) {
      if (payment_gateway === 'razorpay' && razorpay_key_id && razorpay_key_secret) {
        finalGateway = 'razorpay';
      } else if (payment_gateway === 'phonepe' && phonepe_merchant_id && phonepe_salt_key) {
        finalGateway = 'phonepe';
      } else {
        return res.status(400).json({ error: 'Online payment ke liye Razorpay ya PhonePe ki details zaroori hain' });
      }
    }

    const shopId = 'SHOP_' + uuidv4().substring(0,8).toUpperCase();
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    const currentSetupFee = await getSetupFeeAmount();

    // Shop create hoti hai lekin setup_paid=false rehta hai by default.
    // QR Code aur Print Agent sirf setup fee payment confirm hone ke baad milte hain.
    await pool.query(
      `INSERT INTO shops 
        (id,name,address,phone,printer_model,price_bw,price_color,payment_mode,password_hash,
         payment_gateway,razorpay_key_id,razorpay_key_secret,phonepe_merchant_id,phonepe_salt_key,phonepe_salt_index,
         setup_paid,setup_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16)`,
      [shopId, name, address, phone, printer_model, price_bw||5, price_color||10, finalPaymentMode, passwordHash,
       finalGateway, razorpay_key_id||'', razorpay_key_secret||'', phonepe_merchant_id||'', phonepe_salt_key||'', phonepe_salt_index||'1',
       currentSetupFee]
    );

    res.json({ success: true, shopId, setupFeeAmount: currentSetupFee });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── SETUP FEE PAYMENT — Rupesh (system owner) ki Razorpay account mein paisa aata hai ───
app.post('/api/setup-fee/create', async (req, res) => {
  try {
    const { shopId } = req.body;
    if (!shopId) return res.status(400).json({ error: 'Shop ID required' });

    const shopResult = await pool.query('SELECT id, setup_paid, setup_amount FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if (shopResult.rows[0].setup_paid) return res.status(400).json({ error: 'Setup fee already paid hai' });

    const amount = shopResult.rows[0].setup_amount || SETUP_FEE_AMOUNT;
    const amountInPaise = amount * 100;

    const orderData = JSON.stringify({
      amount: amountInPaise,
      currency: 'INR',
      receipt: 'SETUP_' + shopId,
      notes: { shopId, type: 'setup_fee' }
    });

    const authHeader = 'Basic ' + Buffer.from(`${OWNER_RAZORPAY_KEY_ID}:${OWNER_RAZORPAY_KEY_SECRET}`).toString('base64');

    const razorpayOrder = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.razorpay.com',
        path: '/v1/orders',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Content-Length': Buffer.byteLength(orderData)
        }
      };
      const r = https.request(options, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      r.on('error', reject);
      r.write(orderData);
      r.end();
    });

    if (!razorpayOrder.id) return res.status(400).json({ error: 'Setup fee order create nahi hua', details: razorpayOrder });

    await pool.query('UPDATE shops SET setup_order_id=$1 WHERE id=$2', [razorpayOrder.id, shopId]);

    res.json({
      success: true,
      orderId: razorpayOrder.id,
      amount: amountInPaise,
      keyId: OWNER_RAZORPAY_KEY_ID,
      shopId
    });
  } catch(err) {
    console.error('Setup fee create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Shop activation (setup fee confirm hone par) — verify handler,
//    webhook aur reconciliation teeno yahi use karte hain ──
async function activateShop(shopId, paymentId) {
  const qrUrl = `${BASE_URL}/print/${shopId}`;
  const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
  await pool.query(
    'UPDATE shops SET setup_paid=true, setup_payment_id=$1, qr_code=$2 WHERE id=$3',
    [paymentId, qrCode, shopId]
  );
  console.log(`Setup fee paid: ${shopId} | Payment: ${paymentId}`);

  // ── REFERRAL REWARD ── is naye shop ko kisi ne refer kiya tha?
  try {
    const me = await pool.query('SELECT referred_by, referral_rewarded FROM shops WHERE id=$1', [shopId]);
    const row = me.rows[0];
    if (row && row.referred_by && !row.referral_rewarded) {
      // Referrer khud PAID hona chahiye — warna reward nahi
      const ref = await pool.query('SELECT id, setup_paid FROM shops WHERE id=$1', [row.referred_by]);
      if (ref.rows.length && ref.rows[0].setup_paid) {
        await pool.query('UPDATE shops SET referral_earnings = referral_earnings + 50 WHERE id=$1', [row.referred_by]);
        console.log(`Referral reward: ₹50 -> ${row.referred_by} (referred ${shopId})`);
      }
      // rewarded flag hamesha set — dobara trigger na ho (referrer unpaid ho tab bhi)
      await pool.query('UPDATE shops SET referral_rewarded=true WHERE id=$1', [shopId]);
    }
  } catch(e) { console.error('Referral reward error:', e.message); }

  return { qrCode, qrUrl };
}

app.post('/api/setup-fee/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, shopId } = req.body;

    const expectedSignature = crypto
      .createHmac('sha256', OWNER_RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // Payment confirm — ab shop activate karo aur QR generate karo
    const shopResult = await pool.query('SELECT id FROM shops WHERE id=$1 AND setup_order_id=$2', [shopId, razorpay_order_id]);
    if (!shopResult.rows.length) return res.status(404).json({ error: 'Shop ya order match nahi hua' });

    const { qrCode, qrUrl } = await activateShop(shopId, razorpay_payment_id);
    res.json({ success: true, shopId, qrCode, qrUrl });
  } catch(err) {
    console.error('Setup fee verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shop/login', async (req, res) => {
  try {
    const { shopId, password } = req.body;
    if (!shopId || !password) return res.status(400).json({ error: 'Shop ID aur Password dono chahiye' });

    const r = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId.trim().toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop ID nahi mila' });

    const shop = r.rows[0];
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    if (!shop.password_hash) {
      return res.status(401).json({ error: 'Is shop ka password set nahi hai. Pehle Set Password karo.' });
    }
    if (shop.password_hash !== passwordHash) {
      return res.status(401).json({ error: 'Password galat hai' });
    }

    const token = jwt.sign({ shopId: shop.id }, JWT_SECRET, { expiresIn: '24h' });
    delete shop.password_hash;
    res.json({ success: true, token, shop });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Set/claim password — ab REGISTERED MOBILE verify hota hai ──
// Pehle koi bhi kisi legacy Shop ID (jo QR URL me public hai) ka password
// set karke shop hijack kar sakta tha. Ab: shop ka registered number do,
// match hua tabhi. Phone public API se hata diya gaya hai (neeche), to
// attacker use remotely nahi jaan sakta. + IP rate-limit (brute force).
const _spAttempts = new Map();  // ip -> {count, reset}
app.post('/api/shop/set-password', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const rec = _spAttempts.get(ip) || { count: 0, reset: now + 3600e3 };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + 3600e3; }
    if (rec.count >= 5) return res.status(429).json({ error: 'Bahut zyada koshish — 1 ghante baad try karo' });
    rec.count++; _spAttempts.set(ip, rec);

    const { shopId, phone, newPassword } = req.body;
    if (!shopId || !phone || !newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Shop ID, registered mobile aur 4+ character password — teeno chahiye' });
    }
    const r = await pool.query('SELECT id, phone, password_hash FROM shops WHERE id=$1', [shopId.trim().toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop ID nahi mila' });
    if (r.rows[0].password_hash) {
      return res.status(400).json({ error: 'Password already set hai. Login karke change karo, ya bhool gaye to admin se contact karo.' });
    }
    if (normPhone(phone) !== normPhone(r.rows[0].phone)) {
      return res.status(403).json({ error: 'Mobile number match nahi hua — wahi number daalo jo registration me diya tha' });
    }
    const passwordHash = crypto.createHash('sha256').update(newPassword).digest('hex');
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [passwordHash, shopId.trim().toUpperCase()]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/:shopId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,name,address,printer_model,price_bw,price_color,payment_mode,payment_gateway,razorpay_key_id,qr_code,setup_paid,paused,supply_warning,demo,demo_expires_at,duplex_mode FROM shops WHERE id=$1',
      [req.params.shopId]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Shop not found' });
    if (!r.rows[0].setup_paid) {
      return res.status(403).json({ error: 'Shop ka setup abhi incomplete hai. Shop owner ko setup fee complete karna hoga.' });
    }
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/:shopId/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await pool.query(`
      SELECT COUNT(*) as total_orders,
        COALESCE(SUM(amount),0) as total_earnings,
        COUNT(CASE WHEN DATE(created_at)=$1 THEN 1 END) as today_orders,
        COALESCE(SUM(CASE WHEN DATE(created_at)=$1 THEN amount ELSE 0 END),0) as today_earnings,
        COALESCE(SUM(CASE WHEN DATE(created_at)=$1 THEN copies ELSE 0 END),0) as today_prints
      FROM print_jobs WHERE shop_id=$2 AND payment_status='paid'
    `, [today, req.params.shopId]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/profile', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,name,address,phone,printer_model,printer_name_bw,printer_name_color,price_bw,price_color,payment_mode,qr_code,created_at,paused,supply_warning,duplex_mode,
              payment_gateway,razorpay_key_id,phonepe_merchant_id,phonepe_salt_index,
              CASE WHEN razorpay_key_secret != '' THEN true ELSE false END as has_razorpay_secret,
              CASE WHEN phonepe_salt_key != '' THEN true ELSE false END as has_phonepe_salt
       FROM shops WHERE id=$1`, [req.shopId]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Shop not found' });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/settings', verifyToken, async (req, res) => {
  try {
    const {
      name, address, phone, printer_model, printer_name_bw, printer_name_color, price_bw, price_color, payment_mode,
      payment_gateway, razorpay_key_id, razorpay_key_secret,
      phonepe_merchant_id, phonepe_salt_key, phonepe_salt_index
    } = req.body;

    const validPaymentModes = ['both', 'counter_only', 'online_only'];
    const finalPaymentMode = validPaymentModes.includes(payment_mode) ? payment_mode : 'both';

    const needsGateway = finalPaymentMode === 'both' || finalPaymentMode === 'online_only';

    // __KEEP__ sentinel ka matlab hai "purana secret hi rakho, change nahi karna"
    let finalRzpSecret = razorpay_key_secret;
    let finalPpSalt = phonepe_salt_key;
    if (razorpay_key_secret === '__KEEP__' || phonepe_salt_key === '__KEEP__') {
      const existing = await pool.query('SELECT razorpay_key_secret, phonepe_salt_key FROM shops WHERE id=$1', [req.shopId]);
      if (existing.rows.length) {
        if (razorpay_key_secret === '__KEEP__') finalRzpSecret = existing.rows[0].razorpay_key_secret;
        if (phonepe_salt_key === '__KEEP__') finalPpSalt = existing.rows[0].phonepe_salt_key;
      }
    }

    if (needsGateway) {
      const validRazorpay = payment_gateway === 'razorpay' && razorpay_key_id && finalRzpSecret;
      const validPhonepe = payment_gateway === 'phonepe' && phonepe_merchant_id && finalPpSalt;
      if (!validRazorpay && !validPhonepe) {
        return res.status(400).json({ error: 'Online payment ke liye Razorpay ya PhonePe ki details zaroori hain' });
      }
    }

    const finalGateway = needsGateway ? payment_gateway : '';

    await pool.query(
      `UPDATE shops SET 
        name=COALESCE($1,name), 
        address=COALESCE($2,address), 
        phone=COALESCE($3,phone), 
        printer_model=COALESCE($4,printer_model), 
        price_bw=COALESCE($5,price_bw), 
        price_color=COALESCE($6,price_color),
        payment_mode=$7,
        payment_gateway=$8,
        razorpay_key_id=$9,
        razorpay_key_secret=$10,
        phonepe_merchant_id=$11,
        phonepe_salt_key=$12,
        phonepe_salt_index=$13,
        printer_name_bw=COALESCE($14,printer_name_bw),
        printer_name_color=COALESCE($15,printer_name_color)
      WHERE id=$16`,
      [name, address, phone, printer_model, price_bw, price_color, finalPaymentMode,
       finalGateway, razorpay_key_id||'', finalRzpSecret||'', phonepe_merchant_id||'', finalPpSalt||'', phonepe_salt_index||'1',
       printer_name_bw, printer_name_color,
       req.shopId]
    );

    const r = await pool.query('SELECT id,name,address,phone,printer_model,printer_name_bw,printer_name_color,price_bw,price_color,payment_mode,payment_gateway,razorpay_key_id,phonepe_merchant_id,phonepe_salt_index FROM shops WHERE id=$1', [req.shopId]);
    // Duplex mode alag se (validate karke)
    if (typeof req.body.duplex_mode === 'string' && ['','auto','manual'].includes(req.body.duplex_mode)) {
      await pool.query('UPDATE shops SET duplex_mode=$1 WHERE id=$2', [req.body.duplex_mode, req.shopId]);
    }
    res.json({ success: true, shop: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/change-password', verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Naya password kam se kam 4 character ka hona chahiye' });
    }
    const r = await pool.query('SELECT password_hash FROM shops WHERE id=$1', [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });

    const currentHash = crypto.createHash('sha256').update(currentPassword || '').digest('hex');
    if (r.rows[0].password_hash !== currentHash) {
      return res.status(401).json({ error: 'Current password galat hai' });
    }

    const newHash = crypto.createHash('sha256').update(newPassword).digest('hex');
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [newHash, req.shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/jobs', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,file_name,amount,copies,color_mode,total_pages,status,payment_status,payment_method,created_at,printed_at FROM print_jobs WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.shopId]
    );
    res.json({ jobs: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'No file uploaded' });
    const { shopId, copies, colorMode, totalPages } = req.body;
    if (!shopId) return res.status(400).json({ error:'Shop ID required' });

    const shopResult = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error:'Shop not found' });
    const shop = shopResult.rows[0];

    const jobId = 'JOB_' + uuidv4().substring(0,10).toUpperCase();
    const fileType = path.extname(req.file.originalname).replace('.','').toLowerCase();
    const numCopies = parseInt(copies)||1;
    const numPages = parseInt(totalPages)||1;
    const pricePerPage = colorMode === 'color' ? shop.price_color : shop.price_bw;
    const amount = pricePerPage * numPages * numCopies;

    console.log(`Uploading: ${req.file.originalname} (${numPages} pages)`);
    const cloudResult = await uploadToCloudinary(req.file.buffer, fileType);
    console.log(`Cloudinary: ${cloudResult.url}`);

    await pool.query(
      'INSERT INTO print_jobs (id,shop_id,file_name,file_url,file_public_id,file_type,total_pages,copies,color_mode,amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [jobId, shopId, req.file.originalname, cloudResult.url, cloudResult.publicId, fileType, numPages, numCopies, colorMode||'bw', amount]
    );
    res.json({ success:true, jobId, fileName:req.file.originalname, fileType, amount, copies:numCopies, totalPages:numPages, colorMode:colorMode||'bw' });
  } catch(err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function parseSelectedPages(selectedPages, fallbackCount) {
  if (Array.isArray(selectedPages) && selectedPages.length) {
    return selectedPages.map(p => parseInt(p)).filter(p => !isNaN(p));
  }
  return Array.from({length: fallbackCount}, (_, i) => i + 1);
}

// ─── ONLINE PAYMENT: Har shop apni Razorpay/PhonePe keys use karta hai ───
// (Paisa seedha shop owner ke account mein jaata hai, system owner ke account mein nahi)

app.post('/api/payment/online/create', async (req, res) => {
  try {
    const { jobId, colorMode, copies, totalPages, selectedPages } = req.body;

    const jobCheck = await pool.query(
      `SELECT j.*, s.price_bw, s.price_color, s.payment_mode, s.payment_gateway, s.paused,
              s.razorpay_key_id, s.razorpay_key_secret,
              s.phonepe_merchant_id, s.phonepe_salt_key, s.phonepe_salt_index
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`, [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error:'Job not found' });
    if (jobCheck.rows[0].paused) return res.status(403).json({ error: '🏪 Shop abhi band hai — baad mein try karo' });

    const job = jobCheck.rows[0];

    if (job.payment_mode === 'counter_only') {
      return res.status(400).json({ error: 'Yeh shop sirf Counter payment accept karta hai' });
    }
    if (!job.payment_gateway) {
      return res.status(400).json({ error: 'Is shop ne abhi online payment setup nahi kiya hai' });
    }

    const finalColorMode = colorMode || job.color_mode;
    // ── DUPLEX ── sirf tab jab shop ne enable kiya ho; manual duplex par
    // copies zabardasti 1 (warna owner ko har copy pe front/back popup
    // jhelna padta aur pages mix ho jate)
    let finalDuplex = false;
    let dupShop = await pool.query('SELECT duplex_mode FROM shops WHERE id=$1', [job.shop_id]);
    const shopDuplexMode = dupShop.rows.length ? (dupShop.rows[0].duplex_mode || '') : '';
    if (req.body.duplex === true && shopDuplexMode) finalDuplex = true;
    const finalCopies = parseInt(copies) || job.copies;
    const finalPages = parseInt(totalPages) || job.total_pages;
    const finalSelectedPages = parseSelectedPages(selectedPages, job.total_pages);
    const pricePerPage = finalColorMode === 'color' ? job.price_color : job.price_bw;
    const amount = pricePerPage * finalPages * finalCopies;

    // Common job update (gateway se pehle)
    await pool.query(
      'UPDATE print_jobs SET color_mode=$1, copies=$2, total_pages=$3, selected_pages=$4, amount=$5, duplex=$6 WHERE id=$7',
      [finalColorMode, (finalDuplex && shopDuplexMode==='manual') ? 1 : finalCopies, finalTotalPages, finalSelectedPages, finalAmount, finalDuplex, jobId]
    );

    if (job.payment_gateway === 'razorpay') {
      if (!job.razorpay_key_id || !job.razorpay_key_secret) {
        return res.status(400).json({ error: 'Shop ki Razorpay keys set nahi hain' });
      }
      const amountInPaise = amount * 100;
      const orderData = JSON.stringify({
        amount: amountInPaise,
        currency: 'INR',
        receipt: jobId,
        notes: { jobId, colorMode: finalColorMode, copies: finalCopies, pages: finalPages }
      });
      const authHeader = 'Basic ' + Buffer.from(`${job.razorpay_key_id}:${job.razorpay_key_secret}`).toString('base64');

      const razorpayOrder = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'api.razorpay.com',
          path: '/v1/orders',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            'Content-Length': Buffer.byteLength(orderData)
          }
        };
        const r = https.request(options, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        });
        r.on('error', reject);
        r.write(orderData);
        r.end();
      });

      if (!razorpayOrder.id) return res.status(400).json({ error: 'Razorpay order failed', details: razorpayOrder });

      await pool.query(
        'UPDATE print_jobs SET razorpay_order_id=$1, payment_method=$2 WHERE id=$3',
        [razorpayOrder.id, 'online', jobId]
      );

      return res.json({
        success: true,
        gateway: 'razorpay',
        orderId: razorpayOrder.id,
        amount: amountInPaise,
        keyId: job.razorpay_key_id,
        jobId
      });
    }

    if (job.payment_gateway === 'phonepe') {
      if (!job.phonepe_merchant_id || !job.phonepe_salt_key) {
        return res.status(400).json({ error: 'Shop ki PhonePe keys set nahi hain' });
      }
      const amountInPaise = amount * 100;
      const merchantTransactionId = 'MT' + uuidv4().substring(0,16).replace(/-/g,'').toUpperCase();
      const saltIndex = job.phonepe_salt_index || '1';

      const payload = {
        merchantId: job.phonepe_merchant_id,
        merchantTransactionId,
        merchantUserId: 'CUST_' + jobId,
        amount: amountInPaise,
        redirectUrl: `${BASE_URL}/print-success?jobId=${jobId}&gateway=phonepe&txn=${merchantTransactionId}`,
        redirectMode: 'REDIRECT',
        callbackUrl: `${BASE_URL}/api/payment/phonepe/callback`,
        paymentInstrument: { type: 'PAY_PAGE' }
      };

      const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
      const checksum = crypto.createHash('sha256')
        .update(base64Payload + '/pg/v1/pay' + job.phonepe_salt_key)
        .digest('hex') + '###' + saltIndex;

      const phonepeResponse = await new Promise((resolve, reject) => {
        const postData = JSON.stringify({ request: base64Payload });
        const options = {
          hostname: 'api.phonepe.com',
          path: '/apis/hermes/pg/v1/pay',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-VERIFY': checksum,
            'Content-Length': Buffer.byteLength(postData)
          }
        };
        const r = https.request(options, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        });
        r.on('error', reject);
        r.write(postData);
        r.end();
      });

      if (!phonepeResponse.success) {
        return res.status(400).json({ error: 'PhonePe order failed', details: phonepeResponse });
      }

      await pool.query(
        'UPDATE print_jobs SET payment_id=$1, payment_method=$2 WHERE id=$3',
        [merchantTransactionId, 'online', jobId]
      );

      return res.json({
        success: true,
        gateway: 'phonepe',
        paymentUrl: phonepeResponse.data.instrumentResponse.redirectInfo.url,
        jobId
      });
    }

    res.status(400).json({ error: 'Unknown payment gateway' });
  } catch(err) {
    console.error('Online payment create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Razorpay verify — frontend se signature check
app.post('/api/payment/razorpay/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, jobId } = req.body;

    const jobCheck = await pool.query(
      'SELECT s.razorpay_key_secret FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1', [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error: 'Job not found' });
    const keySecret = jobCheck.rows[0].razorpay_key_secret;

    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    await pool.query(
      'UPDATE print_jobs SET payment_status=$1, status=$2, payment_id=$3 WHERE id=$4',
      ['paid', 'queued', razorpay_payment_id, jobId]
    );

    console.log(`Razorpay payment verified: ${jobId} | ${razorpay_payment_id}`);
    res.json({ success: true });
  } catch(err) {
    console.error('Razorpay verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PhonePe webhook callback — payment success hone par PhonePe yahan call karta hai
app.post('/api/payment/phonepe/callback', express.json(), async (req, res) => {
  try {
    const decoded = req.body.response
      ? JSON.parse(Buffer.from(req.body.response, 'base64').toString())
      : req.body;

    if (decoded.code === 'PAYMENT_SUCCESS') {
      const txnId = decoded.data.merchantTransactionId;
      await pool.query(
        'UPDATE print_jobs SET payment_status=$1, status=$2 WHERE payment_id=$3',
        ['paid', 'queued', txnId]
      );
      console.log(`PhonePe payment success: ${txnId}`);
    }
    res.json({ success: true });
  } catch(err) {
    console.error('PhonePe callback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PhonePe redirect ke baad status check (frontend polling ke liye)
app.get('/api/payment/phonepe/status/:jobId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT j.payment_id, j.payment_status, s.phonepe_merchant_id, s.phonepe_salt_key, s.phonepe_salt_index FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1',
      [req.params.jobId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = r.rows[0];

    // Agar already paid hai DB mein (webhook se aaya), seedha return karo
    if (job.payment_status === 'paid') {
      return res.json({ success: true, status: 'PAYMENT_SUCCESS' });
    }

    // Warna PhonePe se directly status check karo
    const txnId = job.payment_id;
    const saltIndex = job.phonepe_salt_index || '1';
    const checksum = crypto.createHash('sha256')
      .update(`/pg/v1/status/${job.phonepe_merchant_id}/${txnId}${job.phonepe_salt_key}`)
      .digest('hex') + '###' + saltIndex;

    const statusResponse = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.phonepe.com',
        path: `/apis/hermes/pg/v1/status/${job.phonepe_merchant_id}/${txnId}`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum,
          'X-MERCHANT-ID': job.phonepe_merchant_id
        }
      };
      const r2 = https.request(options, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      r2.on('error', reject);
      r2.end();
    });

    if (statusResponse.code === 'PAYMENT_SUCCESS') {
      await pool.query('UPDATE print_jobs SET payment_status=$1, status=$2 WHERE id=$3', ['paid', 'queued', req.params.jobId]);
    }

    res.json({ success: true, status: statusResponse.code });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payment/counter', async (req, res) => {
  try {
    const { jobId, colorMode, copies, totalPages, selectedPages } = req.body;
    if (!jobId) return res.status(400).json({ error:'Job ID required' });

    const jobCheck = await pool.query(
      'SELECT j.*, s.price_bw, s.price_color, s.payment_mode, s.paused FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1', [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error:'Job not found' });

    const job = jobCheck.rows[0];
    if (job.paused) return res.status(403).json({ error: '🏪 Shop abhi band hai — baad mein try karo' });

    // Demo guards: expiry + 10-print cap
    const shopD = await pool.query('SELECT demo, demo_expires_at FROM shops WHERE id=$1', [job.shop_id]);
    if (shopD.rows.length && shopD.rows[0].demo) {
      if (isDemoExpired(shopD.rows[0]))
        return res.status(403).json({ error: '⏰ Demo khatam — shop register karo!' });
      const cnt = await pool.query(
        "SELECT COUNT(*) FROM print_jobs WHERE shop_id=$1 AND payment_status='paid'", [job.shop_id]);
      if (parseInt(cnt.rows[0].count) >= 10)
        return res.status(403).json({ error: '🎯 Demo mein max 10 prints — pasand aaya to register karo!' });
    }

    if (job.payment_mode === 'online_only') {
      return res.status(400).json({ error: 'Yeh shop sirf Online payment accept karta hai' });
    }

    const finalColorMode = colorMode || job.color_mode;
    // ── DUPLEX ── sirf tab jab shop ne enable kiya ho; manual duplex par
    // copies zabardasti 1 (warna owner ko har copy pe front/back popup
    // jhelna padta aur pages mix ho jate)
    let finalDuplex = false;
    let dupShop = await pool.query('SELECT duplex_mode FROM shops WHERE id=$1', [job.shop_id]);
    const shopDuplexMode = dupShop.rows.length ? (dupShop.rows[0].duplex_mode || '') : '';
    if (req.body.duplex === true && shopDuplexMode) finalDuplex = true;
    const finalCopies = parseInt(copies) || job.copies;
    const finalPages = parseInt(totalPages) || job.total_pages;
    const finalSelectedPages = parseSelectedPages(selectedPages, job.total_pages);
    const pricePerPage = finalColorMode === 'color' ? job.price_color : job.price_bw;
    const amount = pricePerPage * finalPages * finalCopies;
    const txnId = 'COUNTER_' + uuidv4().substring(0,10).toUpperCase();

    await pool.query(
      'UPDATE print_jobs SET payment_status=$1, status=$2, payment_id=$3, color_mode=$4, copies=$5, total_pages=$6, selected_pages=$7, amount=$8, payment_method=$9 WHERE id=$10',
      ['paid', 'queued', txnId, finalColorMode, finalCopies, finalPages, finalSelectedPages.join(','), amount, 'counter', jobId]
    );

    console.log(`Counter payment: ${jobId} | Rs.${amount} | Pages: ${finalSelectedPages.join(',')}`);
    res.json({ success:true, txnId, amount });
  } catch(err) {
    console.error('Counter payment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// AGENT AUTO-UPDATE — Print Agent khud check karta hai naya version hai ya nahi
// ═══════════════════════════════════════════════

app.get('/api/agent/version', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='agent_version'");
    const version = r.rows.length ? parseInt(r.rows[0].value) : 1;
    res.json({ version });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Agent apni system pe installed printers ki list yahan bhejta hai (har
// startup pe aur har 30 min mein) — taaki dashboard mein owner ko dropdown
// se sahi printer naam dikh sakein, bina manually type kiye (typo-proof).
app.post('/api/agent/printers/:shopId', async (req, res) => {
  try {
    const { printers } = req.body;
    if (!Array.isArray(printers)) return res.status(400).json({ error: 'printers array chahiye' });
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [`printers_${req.params.shopId}`, JSON.stringify(printers)]
    );
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Dashboard yeh endpoint se agent ki reported printer list fetch karta hai
app.get('/api/admin/printers', verifyToken, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key=$1", [`printers_${req.shopId}`]);
    const printers = r.rows.length ? JSON.parse(r.rows[0].value) : [];
    res.json({ printers });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Agent yeh endpoint se naya code download karta hai (Shop ID/Server URL khud
// agent fill karega apni current values se, hum sirf raw template bhejte hain)
app.get('/api/agent/download-latest', async (req, res) => {
  try {
    const agentCode = fs.readFileSync(path.join(__dirname, 'agent-template', 'print_agent.py'), 'utf8');
    res.setHeader('Content-Type', 'text/plain');
    res.send(agentCode);
  } catch(err) {
    res.status(500).json({ error: 'Agent code load nahi hua: ' + err.message });
  }
});

// .exe mode agents ke liye — naya installer .exe seedha bhejte hain (silent
// install ke liye, .py code download karne ka koi matlab nahi exe mode mein
// kyunki compiled binary ko replace nahi kar sakte source se)
app.get('/api/agent/download-latest-exe', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='easy_installer_url'");
    if (!r.rows.length || !r.rows[0].value) {
      return res.status(404).send('Naya installer .exe abhi upload nahi hua hai server pe');
    }
    res.redirect(r.rows[0].value);
  } catch(err) {
    res.status(500).send('Installer load nahi hua: ' + err.message);
  }
});

app.get('/api/jobs/pending/:shopId', async (req, res) => {
  try {
    // Agent heartbeat — dashboard ka Online/Offline indicator isi se chalta hai
    await pool.query('UPDATE shops SET agent_last_seen=NOW() WHERE id=$1', [req.params.shopId]);

    // ── DEMO: machine-lock + expiry ──
    const shopRow = await pool.query(
      'SELECT demo, demo_expires_at FROM shops WHERE id=$1', [req.params.shopId]);
    if (shopRow.rows.length && shopRow.rows[0].demo) {
      const sh = shopRow.rows[0];
      // Layer 3: ek machine = ek demo PERMANENT. Agent ?m=MachineGuid bhejta
      // hai; is machine par pehle KISI AUR demo ka record hai to yeh demo
      // turant expire — naya number/IP kuch kaam nahi aayega.
      const m = String(req.query.m || '').trim().slice(0, 90);
      if (m) {
        const mc = await pool.query('SELECT shop_id FROM demo_machines WHERE machine_id=$1', [m]);
        if (!mc.rows.length) {
          await pool.query('INSERT INTO demo_machines (machine_id, shop_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [m, req.params.shopId]);
        } else if (mc.rows[0].shop_id !== req.params.shopId) {
          await pool.query('UPDATE shops SET demo_expires_at=NOW() WHERE id=$1', [req.params.shopId]);
          console.log(`Demo machine-lock: ${req.params.shopId} expired (machine pehle ${mc.rows[0].shop_id} use kar chuki)`);
          return res.json({ jobs: [], demo_expired: true });
        }
      }
      if (isDemoExpired({ demo: true, demo_expires_at: sh.demo_expires_at })) {
        return res.json({ jobs: [], demo_expired: true });
      }
    }

    // ATOMIC CLAIM: job dete hi status 'printing' ho jata hai. Pehle jobs
    // 'queued' hi rehte the fetch ke baad — bade PDF ke print ke दौरान agla
    // poll wahi job dobara utha ke DOUBLE PRINT kar deta tha, aur crashed
    // agent ka job detect karne ka koi tarika nahi tha. FOR UPDATE SKIP
    // LOCKED se do parallel polls me bhi ek job do baar claim nahi hota.
    const r = await pool.query(
      `UPDATE print_jobs j SET status='printing', printing_at=NOW()
       FROM shops s
       WHERE j.id IN (
         SELECT j2.id FROM print_jobs j2 JOIN shops s2 ON j2.shop_id=s2.id
         WHERE j2.shop_id=$1 AND j2.status='queued' AND j2.payment_status='paid' AND s2.setup_paid=true
         ORDER BY j2.created_at ASC LIMIT 5
         FOR UPDATE OF j2 SKIP LOCKED
       ) AND s.id=j.shop_id
       RETURNING j.id,j.file_name,j.file_url,j.file_public_id,j.file_type,j.copies,j.color_mode,
                 j.total_pages,j.selected_pages,j.amount,j.payment_method,j.created_at,j.duplex,
                 s.printer_name_bw,s.printer_name_color,s.duplex_mode`,
      [req.params.shopId]
    );
    res.json({ jobs: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Agent Online/Offline status (dashboard indicator) ──
app.get('/api/shop/:shopId/agent-status', async (req, res) => {
  try {
    const r = await pool.query('SELECT agent_last_seen FROM shops WHERE id=$1', [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const last = r.rows[0].agent_last_seen;
    const secondsAgo = last ? Math.round((Date.now() - new Date(last).getTime()) / 1000) : null;
    res.json({ online: secondsAgo !== null && secondsAgo < 45, seconds_ago: secondsAgo, last_seen: last });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/complete/:jobId', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE print_jobs SET status=$1, printed_at=NOW() WHERE id=$2 RETURNING file_public_id',
      ['printed', req.params.jobId]
    );
    if (result.rows.length && result.rows[0].file_public_id) {
      await deleteFromCloudinary(result.rows[0].file_public_id);
    }
    console.log(`Printed + Deleted: ${req.params.jobId}`);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/failed/:jobId', async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || '';
    const result = await pool.query(
      'UPDATE print_jobs SET status=$1 WHERE id=$2 RETURNING file_public_id',
      ['failed', req.params.jobId]);
    // Deny/fail par bhi customer ki file Cloudinary se saaf — warna orphan
    // files jama hoti rehti (privacy + storage dono)
    if (result.rows.length && result.rows[0].file_public_id) {
      await deleteFromCloudinary(result.rows[0].file_public_id);
    }
    console.log(`Job failed/denied: ${req.params.jobId}${reason ? ' | ' + reason : ''}`);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs/status/:jobId', async (req, res) => {
  try {
    const r = await pool.query('SELECT id,status,payment_status,amount,payment_method,created_at,printed_at FROM print_jobs WHERE id=$1', [req.params.jobId]);
    if (!r.rows.length) return res.status(404).json({ error:'Not found' });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Setup ke baad Print Agent Package Download ───
// Sirf paid (setup_paid=true) shops ke liye kaam karta hai
// ─── EASY INSTALLER (.exe) — Non-technical shop owners ke liye ───
// Yeh single .exe deta hai jisme Python + SumatraPDF + Agent sab bundled hain.
// Shop ID ko exe ke saath ek chhoti config file (shop_config.txt) mein bhejte
// hain jise installer khud padh ke print_agent ko configure kar dega.
app.get('/api/download/easy-installer/:shopId', async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const r = await pool.query('SELECT id, setup_paid FROM shops WHERE id=$1', [shopId]);
    if (!r.rows.length) return res.status(404).send('Shop not found');
    if (!r.rows[0].setup_paid) return res.status(403).send('Setup fee pehle complete karo');

    const urlResult = await pool.query("SELECT value FROM system_settings WHERE key='easy_installer_url'");
    if (!urlResult.rows.length || !urlResult.rows[0].value) {
      return res.status(404).send('Easy Installer abhi available nahi hai. ZIP wala (Python+INSTALL.bat) version use karo neeche se, ya thodi der baad try karo.');
    }

    res.redirect(urlResult.rows[0].value);
  } catch(err) {
    res.status(500).send('Installer download error: ' + err.message);
  }
});

app.get('/api/download/agent-package/:shopId', async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const r = await pool.query('SELECT id, name, setup_paid FROM shops WHERE id=$1', [shopId]);
    if (!r.rows.length) return res.status(404).send('Shop not found');
    if (!r.rows[0].setup_paid) return res.status(403).send('Setup fee pehle complete karo');

    const shopName = r.rows[0].name;

    // print_agent.py template padhke us mein Shop ID fill karo
    let agentCode = fs.readFileSync(path.join(__dirname, 'agent-template', 'print_agent.py'), 'utf8');
    agentCode = agentCode.replace('AAPKA_SHOP_ID', shopId);
    agentCode = agentCode.replace(
      'SERVER_URL         = "https://qr-se-print.onrender.com"',
      `SERVER_URL         = "${BASE_URL}"`
    );

    const installBat = fs.readFileSync(path.join(__dirname, 'agent-template', 'INSTALL.bat'), 'utf8');

    const readme = `========================================
QR SE PRINT - SETUP INSTRUCTIONS
========================================

Shop: ${shopName}
Shop ID: ${shopId}

Bahut Simple 4 Steps Hain:

STEP 1 - QR CODE
----------------
Is folder mein "QR-Code.png" file hai.
Ise PRINT KARKE apni shop ke counter/bahar lagao.
Customer yeh QR scan karke print bhej sakta hai.

STEP 2 - PRINT AGENT INSTALL KARO
-----------------------------------
1. "INSTALL.bat" file pe RIGHT-CLICK karo
2. "Run as Administrator" choose karo
3. Yeh automatically Python, packages, aur SumatraPDF install karega

   ⚠️ AGAR SUMATRAPDF DOWNLOAD HONE MEIN BAHUT TIME LAG RAHA HAI:
   1. Installer ko band kar do (window close kar do)
   2. Google pe search karo: "SumatraPDF download"
   3. Official site (sumatrapdfreader.org) se download karo
   4. Manually install karo (Next, Next, Finish)
   5. Uske baad seedha STEP 3 pe jao (RUN_AGENT.bat chalao)

STEP 3 - AGENT START KARO
--------------------------
1. Same folder mein "RUN_AGENT.bat" double-click karo
2. Koi black window nahi khulegi — agent System Tray mein chalega!
3. Neeche right corner (clock ke pass) ek chhota printer icon dikhega
   (Agar nahi dikh raha, "^" arrow pe click karke hidden icons check karo)
4. Icon pe right-click karke status, printer, version dekh sakte ho
5. Agent background mein chalta rahega — laptop band hone tak

STEP 4 - TEST KARO
-------------------
1. Apne phone se QR Code scan karo
2. Koi PDF/photo upload karo
3. Payment karo (online ya counter)
4. Printer se print nikal aayega!

========================================
AUTO-UPDATE
========================================
Agent khud check karta rehta hai naya version aaya hai ya nahi
(har 1 ghante mein). Naya update aane par khud download karke
apne aap restart ho jaata hai — aapko kuch nahi karna padta!

========================================
IMPORTANT
========================================
- Printer ko PC se connect karo aur "Set as Default Printer" karo
  (Windows Settings > Bluetooth & devices > Printers & scanners)
- Agent System Tray mein chalta rehta hai — koi window band karne
  ki tension nahi, bas PC/laptop on rehna chahiye
- PC restart hone par phir se RUN_AGENT.bat chalana padega
  (ya INSTALL.bat ke time "Startup mein add karo" Yes select karo —
  tab PC on hote hi agent automatically Tray mein chal jayega)
- Agent ko poori tarah band karne ke liye Tray icon pe right-click
  karke "Exit" choose karo

Koi problem aaye to apna Shop ID (${shopId}) ready rakhna.

========================================
QR Se Print | Developed by Rupesh Kumar Mahato
Instagram: @rupeshkr73
========================================
`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="QR-Se-Print-Setup-${shopId}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    archive.append(agentCode, { name: 'print_agent.py' });
    archive.append(installBat, { name: 'INSTALL.bat' });
    archive.append(readme, { name: 'README.txt' });

    // QR code image bhi add karo (base64 se PNG banake)
    const qrResult = await pool.query('SELECT qr_code FROM shops WHERE id=$1', [shopId]);
    if (qrResult.rows.length && qrResult.rows[0].qr_code) {
      const base64Data = qrResult.rows[0].qr_code.replace(/^data:image\/png;base64,/, '');
      archive.append(Buffer.from(base64Data, 'base64'), { name: 'QR-Code.png' });
    }

    archive.finalize();
  } catch(err) {
    console.error('Download package error:', err.message);
    res.status(500).send('Package banane mein error: ' + err.message);
  }
});



// ═══════════════════════════════════════════════
// SUPER ADMIN APIs — Rupesh ka khud ka panel, sab shops dekhne ke liye
// ═══════════════════════════════════════════════

function verifySuperAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Login required' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'super_admin') throw new Error('Not super admin');
    next();
  } catch(err) {
    return res.status(401).json({ error: 'Session expired, please login again' });
  }
}

app.post('/api/superadmin/login', async (req, res) => {
  try {
    if (!SUPER_ADMIN_ID || !SUPER_ADMIN_PASSWORD) {
      return res.status(500).json({ error: 'Super Admin abhi configure nahi hua hai. Render environment variables check karo.' });
    }
    const { adminId, password } = req.body;
    if (adminId !== SUPER_ADMIN_ID || password !== SUPER_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'ID ya Password galat hai' });
    }
    const token = jwt.sign({ role: 'super_admin', adminId }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/overview', verifySuperAdmin, async (req, res) => {
  try {
    const shopCount = await pool.query('SELECT COUNT(*) as total, COUNT(CASE WHEN setup_paid THEN 1 END) as active FROM shops');
    const earnings = await pool.query(`
      SELECT 
        COALESCE(SUM(setup_amount) FILTER (WHERE setup_paid), 0) as total_setup_revenue,
        COUNT(*) FILTER (WHERE setup_paid) as paid_shops
      FROM shops
    `);
    const printEarnings = await pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM print_jobs WHERE payment_status='paid'`);

    res.json({
      total_shops: parseInt(shopCount.rows[0].total),
      active_shops: parseInt(shopCount.rows[0].active),
      pending_shops: parseInt(shopCount.rows[0].total) - parseInt(shopCount.rows[0].active),
      total_setup_revenue: parseInt(earnings.rows[0].total_setup_revenue),
      total_print_volume: parseInt(printEarnings.rows[0].total)
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/shops', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, name, address, phone, printer_model, price_bw, price_color,
             payment_mode, payment_gateway, setup_paid, setup_amount, created_at
      FROM shops ORDER BY created_at DESC
    `);
    res.json({ shops: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Owner ka apna pehla shop — kabhi delete nahi hoga, chahe UI/API se kuch
// bhi bheja jaye. Server-side hardcoded taaki koi bypass na kar sake.
const PROTECTED_SHOP_IDS = ['SHOP_ECB1AB8A'];

// ─── Shop delete — paid amount 0 wali shops delete ho sakti hain ───
// Rule: setup_amount 0 (ya null) wali koi bhi shop delete ho sakti hai
// (pending + purane jinme amount capture nahi hua tha). Jisne ASLI paisa
// diya (setup_amount > 0) wo protected. Owner ka pehla shop hamesha safe.
app.delete('/api/superadmin/shop/:shopId', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    if (PROTECTED_SHOP_IDS.includes(shopId)) {
      return res.status(403).json({ error: 'Ye shop protected hai — delete nahi ho sakti' });
    }
    const chk = await pool.query('SELECT setup_amount FROM shops WHERE id=$1', [shopId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if ((chk.rows[0].setup_amount || 0) > 0) {
      return res.status(403).json({ error: 'Is shop ne setup fee pay ki hai — delete nahi ho sakti' });
    }
    await pool.query('DELETE FROM print_jobs WHERE shop_id=$1', [shopId]);
    await pool.query('DELETE FROM shops WHERE id=$1 AND COALESCE(setup_amount,0)=0', [shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/shop/:shopId/earnings', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT COUNT(*) as total_orders, COALESCE(SUM(amount),0) as total_earnings
      FROM print_jobs WHERE shop_id=$1 AND payment_status='paid'
    `, [req.params.shopId]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Setup Fee / Offer Price Management — Super Admin live change kar sake ───
app.get('/api/superadmin/setup-fee', verifySuperAdmin, async (req, res) => {
  try {
    const pricing = await getSetupPricing();
    res.json({
      offerPrice: pricing.offerPrice,
      actualPrice: pricing.actualPrice,
      defaultOfferPrice: SETUP_FEE_AMOUNT,
      defaultActualPrice: SETUP_ACTUAL_PRICE
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/setup-fee', verifySuperAdmin, async (req, res) => {
  try {
    const { offerPrice, actualPrice } = req.body;
    const newOfferPrice = parseInt(offerPrice);
    const newActualPrice = parseInt(actualPrice);

    if (isNaN(newOfferPrice) || newOfferPrice < 0) {
      return res.status(400).json({ error: 'Valid Offer Price daalo (0 ya zyada)' });
    }
    if (isNaN(newActualPrice) || newActualPrice < 0) {
      return res.status(400).json({ error: 'Valid Actual Price daalo (0 ya zyada)' });
    }
    if (newActualPrice < newOfferPrice) {
      return res.status(400).json({ error: 'Actual Price, Offer Price se kam nahi ho sakta' });
    }

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('setup_fee_amount', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [newOfferPrice.toString()]
    );
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('setup_actual_price', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [newActualPrice.toString()]
    );

    console.log(`Setup pricing updated by super admin: Actual ₹${newActualPrice}, Offer ₹${newOfferPrice}`);
    res.json({ success: true, offerPrice: newOfferPrice, actualPrice: newActualPrice });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Agent Version Management — Super Admin yahan se naya update push karta hai ───
app.get('/api/superadmin/agent-version', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT value, updated_at FROM system_settings WHERE key='agent_version'");
    const version = r.rows.length ? parseInt(r.rows[0].value) : 1;
    const updatedAt = r.rows.length ? r.rows[0].updated_at : null;
    res.json({ version, updatedAt });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/agent-version/bump', verifySuperAdmin, async (req, res) => {
  try {
    // Current version uthao aur +1 karo — koi manual number type karne ki zaroorat nahi,
    // taaki galti se koi purana/galat version number na daal de
    const r = await pool.query("SELECT value FROM system_settings WHERE key='agent_version'");
    const currentVersion = r.rows.length ? parseInt(r.rows[0].value) : 1;
    const newVersion = currentVersion + 1;

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('agent_version', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [newVersion.toString()]
    );

    console.log(`Agent version bumped to v${newVersion} by super admin — sab customers ke PC 1 ghante mein update ho jayenge`);
    res.json({ success: true, version: newVersion });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Easy Installer (.exe) URL Management — Cloudinary pe hosted ───
// GitHub/Render dono ki file-size limits avoid karne ke liye, naya .exe
// build hone par usko Cloudinary pe manually upload karke yahan se URL
// set/update kiya jaata hai. Code change/redeploy ki zaroorat nahi.
app.get('/api/superadmin/easy-installer-url', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT value, updated_at FROM system_settings WHERE key='easy_installer_url'");
    res.json({
      url: r.rows.length ? r.rows[0].value : '',
      updatedAt: r.rows.length ? r.rows[0].updated_at : null
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/easy-installer-url', verifySuperAdmin, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.trim().startsWith('http')) {
      return res.status(400).json({ error: 'Valid URL daalo (https:// se shuru honi chahiye)' });
    }
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('easy_installer_url', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [url.trim()]
    );
    console.log(`Easy Installer URL updated by super admin: ${url.trim()}`);
    res.json({ success: true, url: url.trim() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});



// ══════════════════════════════════════════════════════════════════
// RAZORPAY WEBHOOK — server-side payment confirmation
// Customer browser band kar de payment ke turant baad, tab bhi payment
// confirm hoti hai. NOTE: yeh sirf OWNER (setup fee) Razorpay account ke
// webhooks ke liye hai — Razorpay dashboard mein webhook URL + secret set
// karo, secret ko RAZORPAY_WEBHOOK_SECRET env mein daalo.
// Shop owners ke apne accounts ke liye niche wali RECONCILIATION chalti
// hai (unke dashboards mein webhook configure karwana practical nahi).
// ══════════════════════════════════════════════════════════════════
app.post('/api/webhook/razorpay', async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'Webhook secret configured nahi' });
    const signature = req.headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (signature !== expected) return res.status(400).json({ error: 'Invalid signature' });

    const event = req.body.event;
    if (event === 'payment.captured' || event === 'order.paid') {
      const payment = req.body.payload?.payment?.entity || {};
      const orderId = payment.order_id || req.body.payload?.order?.entity?.id;
      const paymentId = payment.id || '';
      if (orderId) {
        // 1) Setup fee?
        const sh = await pool.query(
          'SELECT id, setup_paid FROM shops WHERE setup_order_id=$1', [orderId]);
        if (sh.rows.length && !sh.rows[0].setup_paid) {
          await activateShop(sh.rows[0].id, paymentId);
        }
        // 2) Customer print job? (agar owner account se aaya ho)
        await pool.query(
          `UPDATE print_jobs SET payment_status='paid', payment_id=$1
           WHERE razorpay_order_id=$2 AND payment_status='pending'`,
          [paymentId, orderId]);
      }
    }
    res.json({ received: true });
  } catch(err) {
    console.error('Webhook error:', err.message);
    res.status(200).json({ received: true }); // 5xx par Razorpay retry-storm karta hai
  }
});

// ══════════════════════════════════════════════════════════════════
// BACKGROUND JOBS (har 2 min)
// 1) STUCK-JOB CLEANUP: agent print ke beech crash ho jaye to job
//    'printing' mein hamesha atka rehta tha. 10 min baad wapas 'queued',
//    2 retries ke baad 'failed' — poison job (corrupt PDF jo har baar
//    agent crash kare) infinite loop nahi banayega.
// 2) RAZORPAY RECONCILIATION: pending payments ko seedha Razorpay Orders
//    API se check karo — shop ki apni stored keys se. Customer browser
//    band kar de to bhi 2 min ke andar payment paid mark ho jati hai,
//    kisi webhook config ke bina.
// ══════════════════════════════════════════════════════════════════
async function razorpayOrderStatus(orderId, keyId, keySecret) {
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const resp = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, {
    headers: { 'Authorization': 'Basic ' + auth }
  });
  if (!resp.ok) return null;
  return resp.json();
}

let bgRunning = false;
async function backgroundMaintenance() {
  if (bgRunning) return; // overlap guard
  bgRunning = true;
  try {
    // 1) Stuck printing jobs
    const requeued = await pool.query(
      `UPDATE print_jobs SET status='queued', printing_at=NULL, retry_count=retry_count+1
       WHERE status='printing' AND printing_at < NOW() - INTERVAL '10 minutes' AND retry_count < 2
       RETURNING id`);
    if (requeued.rows.length) console.log('♻️ Requeued stuck jobs:', requeued.rows.map(r=>r.id).join(','));
    const failed = await pool.query(
      `UPDATE print_jobs SET status='failed'
       WHERE status='printing' AND printing_at < NOW() - INTERVAL '10 minutes' AND retry_count >= 2
       RETURNING id`);
    if (failed.rows.length) console.log('❌ Gave up on stuck jobs:', failed.rows.map(r=>r.id).join(','));

    // 2a) Customer job payments reconcile (shop ki apni keys)
    const pending = await pool.query(
      `SELECT j.id, j.razorpay_order_id, s.razorpay_key_id, s.razorpay_key_secret
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id
       WHERE j.payment_status='pending' AND j.razorpay_order_id IS NOT NULL
         AND j.razorpay_order_id <> '' AND s.razorpay_key_id <> ''
         AND j.created_at > NOW() - INTERVAL '45 minutes'
       LIMIT 20`);
    for (const job of pending.rows) {
      try {
        const order = await razorpayOrderStatus(job.razorpay_order_id, job.razorpay_key_id, job.razorpay_key_secret);
        if (order && order.status === 'paid') {
          await pool.query(
            `UPDATE print_jobs SET payment_status='paid' WHERE id=$1 AND payment_status='pending'`,
            [job.id]);
          console.log('💰 Reconciled payment for job:', job.id);
        }
      } catch(e) { /* agla cycle try karega */ }
    }

    // 2b) Setup fee reconcile (owner keys)
    if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
      const setups = await pool.query(
        `SELECT id, setup_order_id FROM shops
         WHERE setup_paid=false AND setup_order_id IS NOT NULL AND setup_order_id <> ''
         LIMIT 10`);
      for (const shop of setups.rows) {
        try {
          const order = await razorpayOrderStatus(shop.setup_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
          if (order && order.status === 'paid') {
            await activateShop(shop.id, order.id);
            console.log('💰 Reconciled setup fee:', shop.id);
          }
        } catch(e) { /* agla cycle */ }
      }
    }
    // 3) Purane demo shops saaf (7 din baad) — DB junk-free rahe
    const oldDemos = await pool.query(
      "SELECT id FROM shops WHERE demo=true AND demo_expires_at < NOW() - INTERVAL '7 days' LIMIT 20");
    for (const d of oldDemos.rows) {
      await pool.query('DELETE FROM print_jobs WHERE shop_id=$1', [d.id]);
      await pool.query('DELETE FROM shops WHERE id=$1', [d.id]);
      console.log('🧹 Old demo deleted:', d.id);
    }
  } catch(err) {
    console.error('Background maintenance error:', err.message);
  } finally {
    bgRunning = false;
  }
}
setInterval(backgroundMaintenance, 2 * 60 * 1000).unref();

app.get('/print/:shopId', (req,res) => res.sendFile(path.join(__dirname,'public','customer.html')));
app.get('/register',  (req,res) => res.sendFile(path.join(__dirname,'public','register.html')));
app.get('/dashboard', (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/superadmin', (req,res) => res.sendFile(path.join(__dirname,'public','superadmin.html')));
app.get('/print-success', (req,res) => res.sendFile(path.join(__dirname,'public','success.html')));
app.get('/setup-payment/:shopId', (req,res) => res.sendFile(path.join(__dirname,'public','setup-payment.html')));

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`QR Se Print - Port ${PORT}`);
    console.log(`${BASE_URL}`);
    console.log(`Cloudinary: ${CLOUD_NAME}`);
    console.log(`Payment: Per-shop gateway (Razorpay/PhonePe), Counter always available unless online_only`);
  });
});
