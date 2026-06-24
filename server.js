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

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://qr-se-print.onrender.com';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'drnswjs1q';
const CLD_API_KEY = process.env.CLOUDINARY_API_KEY || '224393314967214';
const CLD_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'dnTnlUZI4e-yJJOBN0K_oLZW6Y0';

// (Global RAZORPAY_KEY_ID/SECRET removed — each shop now stores its own gateway credentials)

const JWT_SECRET = process.env.JWT_SECRET || 'qrseprint_default_secret_change_in_production_xk29';

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
  'Canon PIXMA G3060', 'Canon PIXMA G3070', 'Canon PIXMA G4010', 'Canon PIXMA G4020',
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
        qr_code TEXT,
        created_at TIMESTAMP DEFAULT NOW()
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
    `);

    console.log('Database ready!');
  } catch(err) { console.error('DB error:', err.message); }
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

    // Agar owner ne online payment chuna hai (both/online_only) to gateway details zaroori hain
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

    await pool.query(
      `INSERT INTO shops 
        (id,name,address,phone,printer_model,price_bw,price_color,payment_mode,password_hash,
         payment_gateway,razorpay_key_id,razorpay_key_secret,phonepe_merchant_id,phonepe_salt_key,phonepe_salt_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [shopId, name, address, phone, printer_model, price_bw||5, price_color||10, finalPaymentMode, passwordHash,
       finalGateway, razorpay_key_id||'', razorpay_key_secret||'', phonepe_merchant_id||'', phonepe_salt_key||'', phonepe_salt_index||'1']
    );
    const qrUrl = `${BASE_URL}/print/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width:300, margin:2 });
    await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);
    res.json({ success:true, shopId, qrCode, qrUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
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
      'SELECT id,name,address,phone,printer_model,price_bw,price_color,payment_mode,payment_gateway,razorpay_key_id,qr_code FROM shops WHERE id=$1',
      [req.params.shopId]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Shop not found' });
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
      `SELECT id,name,address,phone,printer_model,price_bw,price_color,payment_mode,qr_code,created_at,
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
      name, address, phone, printer_model, price_bw, price_color, payment_mode,
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
        phonepe_salt_index=$13
      WHERE id=$14`,
      [name, address, phone, printer_model, price_bw, price_color, finalPaymentMode,
       finalGateway, razorpay_key_id||'', finalRzpSecret||'', phonepe_merchant_id||'', finalPpSalt||'', phonepe_salt_index||'1',
       req.shopId]
    );

    const r = await pool.query('SELECT id,name,address,phone,printer_model,price_bw,price_color,payment_mode,payment_gateway,razorpay_key_id,phonepe_merchant_id,phonepe_salt_index FROM shops WHERE id=$1', [req.shopId]);
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

app.get('/api/jobs/pending/:shopId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,file_name,file_url,file_public_id,file_type,copies,color_mode,total_pages,selected_pages,amount FROM print_jobs WHERE shop_id=$1 AND status=$2 AND payment_status=$3 ORDER BY created_at ASC LIMIT 5',
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

// (Removed legacy global /api/razorpay/config — har shop ki apni gateway keys hoti hain ab)

app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/print/:shopId', (req,res) => res.sendFile(path.join(__dirname,'public','customer.html')));
app.get('/dashboard', (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/print-success', (req,res) => res.sendFile(path.join(__dirname,'public','success.html')));

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`QR Se Print - Port ${PORT}`);
    console.log(`${BASE_URL}`);
    console.log(`Cloudinary: ${CLOUD_NAME}`);
    console.log(`Payment: Per-shop gateway (Razorpay/PhonePe), Counter always available unless online_only`);
  });
});
