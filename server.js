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
app.use(express.json({ limit: '50mb' }));
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
      phonepe_merchant_id, phonepe_salt_key, phonepe_salt_index
    } = req.body;

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

    const qrUrl = `${BASE_URL}/print/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });

    await pool.query(
      'UPDATE shops SET setup_paid=true, setup_payment_id=$1, qr_code=$2 WHERE id=$3',
      [razorpay_payment_id, qrCode, shopId]
    );

    console.log(`Setup fee paid: ${shopId} | Payment: ${razorpay_payment_id}`);
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

app.post('/api/shop/set-password', async (req, res) => {
  try {
    const { shopId, newPassword } = req.body;
    if (!shopId || !newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Shop ID aur kam se kam 4-character password chahiye' });
    }
    const r = await pool.query('SELECT id, password_hash FROM shops WHERE id=$1', [shopId.trim().toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop ID nahi mila' });
    if (r.rows[0].password_hash) {
      return res.status(400).json({ error: 'Password already set hai. Login karke change karo.' });
    }
    const passwordHash = crypto.createHash('sha256').update(newPassword).digest('hex');
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [passwordHash, shopId.trim().toUpperCase()]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/:shopId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,name,address,phone,printer_model,price_bw,price_color,payment_mode,payment_gateway,razorpay_key_id,qr_code,setup_paid FROM shops WHERE id=$1',
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
      `SELECT id,name,address,phone,printer_model,printer_name_bw,printer_name_color,price_bw,price_color,payment_mode,qr_code,created_at,
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
      `SELECT j.*, s.price_bw, s.price_color, s.payment_mode, s.payment_gateway,
              s.razorpay_key_id, s.razorpay_key_secret,
              s.phonepe_merchant_id, s.phonepe_salt_key, s.phonepe_salt_index
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`, [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error:'Job not found' });

    const job = jobCheck.rows[0];

    if (job.payment_mode === 'counter_only') {
      return res.status(400).json({ error: 'Yeh shop sirf Counter payment accept karta hai' });
    }
    if (!job.payment_gateway) {
      return res.status(400).json({ error: 'Is shop ne abhi online payment setup nahi kiya hai' });
    }

    const finalColorMode = colorMode || job.color_mode;
    const finalCopies = parseInt(copies) || job.copies;
    const finalPages = parseInt(totalPages) || job.total_pages;
    const finalSelectedPages = parseSelectedPages(selectedPages, job.total_pages);
    const pricePerPage = finalColorMode === 'color' ? job.price_color : job.price_bw;
    const amount = pricePerPage * finalPages * finalCopies;

    // Common job update (gateway se pehle)
    await pool.query(
      'UPDATE print_jobs SET color_mode=$1, copies=$2, total_pages=$3, selected_pages=$4, amount=$5 WHERE id=$6',
      [finalColorMode, finalCopies, finalPages, finalSelectedPages.join(','), amount, jobId]
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
      'SELECT j.*, s.price_bw, s.price_color, s.payment_mode FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1', [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error:'Job not found' });

    const job = jobCheck.rows[0];

    if (job.payment_mode === 'online_only') {
      return res.status(400).json({ error: 'Yeh shop sirf Online payment accept karta hai' });
    }

    const finalColorMode = colorMode || job.color_mode;
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
    const r = await pool.query(
      `SELECT j.id,j.file_name,j.file_url,j.file_public_id,j.file_type,j.copies,j.color_mode,j.total_pages,j.selected_pages,j.amount,
              s.printer_name_bw, s.printer_name_color
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id
       WHERE j.shop_id=$1 AND j.status=$2 AND j.payment_status=$3 AND s.setup_paid=true 
       ORDER BY j.created_at ASC LIMIT 5`,
      [req.params.shopId, 'queued', 'paid']
    );
    res.json({ jobs: r.rows });
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
    await pool.query('UPDATE print_jobs SET status=$1 WHERE id=$2', ['failed', req.params.jobId]);
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
