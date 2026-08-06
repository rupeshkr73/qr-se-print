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
const nodemailer = require('nodemailer');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://qr-se-print.onrender.com';

// ── White-label homepage settings ──
// Monthly plan ka minimum — partner isse neeche price nahi rakh sakta.
const WL_MIN_MONTHLY = 399;

// Price decimal me bhi ho sakta hai (2.5, 1.5) — 2 decimal tak round karo.
// Galat/negative aaye to null lautao taaki purana price waisa hi rahe.
function parsePrice(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  if (isNaN(n) || n < 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}
// Homepage ke jo button/section partner on-off kar sakta hai.
const WL_HP_BUTTON_KEYS = ['contact','partner','agent','features','setupGuide',
                           'pricing','reviews','faq','demo','register','shopLogin'];

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLD_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLD_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

// (Global RAZORPAY_KEY_ID/SECRET removed — each shop now stores its own gateway credentials)

// JWT_SECRET hamesha environment variable se aana chahiye production mein.
// Agar set nahi hai to random secret generate karte hain runtime pe (sirf is
// process ke chalte rehne tak valid — restart pe sab logged out ho jayenge).
// Yeh hardcoded secret se kahin zyada safe hai.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// ═══════════════════════════════════════════════════════════════════
//  SECURITY
// ═══════════════════════════════════════════════════════════════════

// ── PASSWORD ──
// Pehle plain SHA-256 tha (bina salt). SHA-256 itna tez hai ki ek normal
// GPU crore hash per second try karta hai — DB leak hone par 4-character
// password minute bhar me khul jaata. Ab Node ka BUILT-IN scrypt use
// karte hain: har password ka apna salt, aur jaan-bujh ke slow.
// Koi naya npm package nahi chahiye (crypto Node me pehle se hai).
const PASSWORD_MAX = 200;            // isse lamba password lena hi nahi
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };   // ~16MB, ~100ms per hash

function scryptDerive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).slice(0, PASSWORD_MAX), salt, 32, SCRYPT_PARAMS,
      (err, dk) => err ? reject(err) : resolve(dk));
  });
}

// Format: scrypt$<salt-base64>$<hash-base64>  (~76 char, column 200 me fit)
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scryptDerive(password, salt);
  return 'scrypt$' + salt.toString('base64') + '$' + dk.toString('base64');
}

// Length barabar na ho to timingSafeEqual throw karta hai — isliye wrapper
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// PURANE (sha256) aur NAYE (scrypt) dono hash chalte hain — isi wajah se
// migration me kisi ka login nahi tootega.
async function verifyPassword(password, stored) {
  try {
    if (!stored) return false;
    const s = String(stored);
    if (s.startsWith('scrypt$')) {
      const parts = s.split('$');
      if (parts.length !== 3) return false;
      const dk = await scryptDerive(password, Buffer.from(parts[1], 'base64'));
      return safeEq(dk.toString('base64'), parts[2]);
    }
    // Legacy: 64-char hex sha256
    const legacy = crypto.createHash('sha256')
      .update(String(password).slice(0, PASSWORD_MAX)).digest('hex');
    return safeEq(legacy, s);
  } catch (e) { return false; }
}

function isLegacyHash(stored) {
  return !!stored && !String(stored).startsWith('scrypt$');
}

// Login sahi hua aur hash abhi purana hai — chupchaap scrypt me badal do.
// User ko kuch pata nahi chalta; dheere-dheere sab migrate ho jaate hain.
async function upgradeHashIfLegacy(table, idCol, idVal, storedHash, plainPassword) {
  try {
    if (!isLegacyHash(storedHash)) return;
    const fresh = await hashPassword(plainPassword);
    await pool.query(`UPDATE ${table} SET password_hash=$1 WHERE ${idCol}=$2`, [fresh, idVal]);
    console.log(`Password hash upgraded to scrypt: ${table}/${idVal}`);
  } catch (e) { console.error('hash upgrade fail:', e.message); }
}

// ── LOGIN RATE LIMIT ──
// Bina iske koi bhi ek Shop ID par unlimited password try kar sakta hai.
// In-memory hai (Render par ek hi instance chalta hai) — koi package nahi.
const loginHits = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 8;

setInterval(() => {                    // purane entries hata do (memory leak na ho)
  const now = Date.now();
  for (const [k, v] of loginHits) if (now > v.resetAt) loginHits.delete(k);
}, 5 * 60 * 1000).unref();

function loginLimiter(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress || 'unknown';
  const key = ip + '|' + String(req.body?.shopId || req.body?.slug || req.body?.username || '').toLowerCase();
  const now = Date.now();
  let e = loginHits.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + LOGIN_WINDOW_MS }; loginHits.set(key, e); }
  e.count++;
  if (e.count > LOGIN_MAX) {
    const mins = Math.ceil((e.resetAt - now) / 60000);
    return res.status(429).json({ error: `Bahut zyada galat koshish. ${mins} minute baad try karo.` });
  }
  next();
}

// Login sahi ho gaya to counter reset — asli user ko dikkat na ho
function clearLoginHits(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress || 'unknown';
  loginHits.delete(ip + '|' + String(req.body?.shopId || req.body?.slug || req.body?.username || '').toLowerCase());
}

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
app.disable('x-powered-by'); // Express ka "X-Powered-By: Express" header hata do — tech-stack fingerprint kam
// verify: raw body stash — Razorpay webhook ka signature RAW body par
// HMAC hota hai, parsed JSON par nahi
// Security headers — helmet package ki zaroorat nahi, ye headers hi kaafi hain
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  // CSP — site abhi inline <script>/onclick/style bahut use karta hai (poori
  // codebase isi pattern par bani hai), isliye 'unsafe-inline' rakhna padega
  // varna sab tootega. Fir bhi ye asli faayda deta hai: koi attacker agar
  // kabhi HTML me <script src="..."> ya <iframe> ghusa de, to sirf yahi
  // listed domains se load hoga — baaki sab (jaise evil.com) block ho jayega.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://cdnjs.cloudflare.com https://*.cashfree.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https://res.cloudinary.com https://*.razorpay.com https://*.cashfree.com",
    "connect-src 'self' https://*.cashfree.com",
    "frame-src https://checkout.razorpay.com https://api.razorpay.com https://*.cashfree.com https://www.youtube-nocookie.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.razorpay.com https://*.cashfree.com",
    "frame-ancestors 'self'"
  ].join('; '));
  if (req.headers['x-forwarded-proto'] === 'https')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  next();
});

// JSON body 50mb -> 2mb. File upload MULTER se hota hai (uski apni 50mb limit
// alag hai) — isliye upload par koi asar nahi. Pehle koi bhi 50mb ka JSON
// baar-baar bhej ke Render ki 512MB RAM bhar sakta tha.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// HTML pages HAMESHA fresh — bina iske phone Chrome purani HTML ghanton
// tak cache se dikhata hai (har push ke baad "fix nahi hua" ka asli karan).
// Sirf pages (extension-less routes + .html) — images/assets cache rehte hain.
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (!p.startsWith('/api/') && (p.endsWith('.html') || !p.slice(1).includes('.'))) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
  next();
});
// ══════════════════════════════════════════════════════════════
// BANDWIDTH — sabse bada kharcha yahi tha
//
// 1) gzip/brotli: HTML ~182 KB se ~30 KB ho jaata hai (6x kam).
//    Ek visitor = 182 KB tha, ab ~30 KB.
// 2) Cache headers: dobara aane wale visitor ko file dobara nahi
//    bhejni padti — server sirf "304 Not Modified" bhejta hai (0 bytes).
// ══════════════════════════════════════════════════════════════
app.use(compression({
  level: 6,                       // speed aur size ka balance
  threshold: 1024,                // 1 KB se chhoti cheez compress karna faaltu hai
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(express.static('public', {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.(js|css|png|jpg|jpeg|svg|ico|woff2?)$/i.test(filePath)) {
      // Assets — 7 din cache, phir bhi badal jaye to naam/etag se pata chal jaata hai
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else if (/\.html$/i.test(filePath)) {
      // HTML — har baar check karo par badla na ho to 304 (0 bytes)
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));

// ─── Canonical host redirect ───
// Purane customers ka QR / bookmark / WhatsApp me shared link
// qr-se-print.onrender.com pe hi hai. Unko naye domain par bhejo — path,
// query string, sab as-is. Jab tak PRIMARY_HOST env na set ho, redirect
// band (staging/local pe fasne se bachne ke liye).
const PRIMARY_HOST = process.env.PRIMARY_HOST || '';
if (PRIMARY_HOST) {
  app.use((req, res, next) => {
    // API calls ko KABHI redirect nahi — 301 par POST body gir jaati hai
    // (clients POST ko GET bana dete hain) aur field ke saare agents
    // 404 khane lagte hain (printer list, complete/failed reports sab).
    if (req.path.startsWith('/api/')) return next();
    const host = (req.headers.host || '').toLowerCase().split(':')[0];
    // www.qrseprint.in, onrender.com — sab canonical par (SEO: ek hi domain
    // rank kare, duplicate content na bane)
    // White-label subdomain (abc.qrseprint.in) ko redirect NAHI karna —
    // warna reseller ka brand khulte hi main site par phenk deta hai.
    // www aur baaki hosts (onrender.com waghairah) pehle jaise hi redirect.
    const isWlSubdomain = PRIMARY_HOST && host.endsWith('.' + PRIMARY_HOST) && host !== 'www.' + PRIMARY_HOST;
    if (host && host !== PRIMARY_HOST && !isWlSubdomain && host !== 'localhost' && host !== '127.0.0.1') {
      return res.redirect(301, 'https://' + PRIMARY_HOST + req.originalUrl);
    }
    next();
  });
}

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

// PNG signature check (magic bytes)
function isPng(buf) {
  return buf && buf.length > 8 &&
    buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47 &&
    buf[4]===0x0D && buf[5]===0x0A && buf[6]===0x1A && buf[7]===0x0A;
}

// PNG me transparency hai? IHDR color type padho (offset 25):
//  type 4 = grayscale+alpha, 6 = RGBA -> alpha channel hai.
//  type 3 (palette) me tRNS chunk ho to bhi transparent ho sakta hai.
// JPEG hai? (magic bytes FF D8 FF ... aur end me FF D9)
function isJpeg(buf) {
  return buf && buf.length > 3 &&
    buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

function pngHasAlpha(buf) {
  try {
    if (!isPng(buf) || buf.length < 26) return false;
    const colorType = buf[25];   // IHDR: width(4)+height(4)+bitdepth(1)+colortype(1) => index 25
    if (colorType === 4 || colorType === 6) return true;   // alpha channel present
    if (colorType === 3) {
      // palette PNG: tRNS chunk dhundo
      const s = buf.toString('latin1');
      return s.includes('tRNS');
    }
    return false;
  } catch(e) { return false; }
}

async function uploadImageToCloudinary(fileBuffer, mimeType) {
  if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) return Promise.reject(new Error('Cloudinary configured nahi'));
  return new Promise((resolve, reject) => {
    const timestamp = Math.round(Date.now() / 1000);
    const publicId = 'qsp_logo_' + uuidv4().substring(0,8);
    const signStr = `public_id=${publicId}&timestamp=${timestamp}${CLD_API_SECRET}`;
    const signature = crypto.createHash('sha256').update(signStr).digest('hex');
    const dataUri = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
    const postData = new URLSearchParams({
      file: dataUri, api_key: CLD_API_KEY, timestamp: timestamp.toString(),
      public_id: publicId, signature, resource_type: 'image'
    }).toString();
    const req = https.request({
      hostname: 'api.cloudinary.com', path: `/v1_1/${CLOUD_NAME}/image/upload`, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    }, (resp) => {
      let data = ''; resp.on('data', c => data += c);
      resp.on('end', () => { try { const j = JSON.parse(data); j.secure_url ? resolve(j.secure_url) : reject(new Error(j.error?.message || 'Upload fail')); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(postData); req.end();
  });
}

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

// Cloudinary par ASLI me kya pada hai — Admin API se list.
// DB ki nazar se orphan files (jinka job row hi nahi) sirf isse dikhti hain.
let _sweepTick = 0;

async function listCloudinaryFiles(nextCursor = '') {
  return new Promise((resolve) => {
    if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) return resolve({ resources: [] });
    const auth = Buffer.from(`${CLD_API_KEY}:${CLD_API_SECRET}`).toString('base64');
    let path = `/v1_1/${CLOUD_NAME}/resources/raw?prefix=qrprint_&max_results=100`;
    if (nextCursor) path += `&next_cursor=${encodeURIComponent(nextCursor)}`;
    const req = https.request({
      hostname: 'api.cloudinary.com', path, method: 'GET',
      headers: { Authorization: 'Basic ' + auth }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve({ resources: j.resources || [], next_cursor: j.next_cursor || '' });
        } catch (e) { resolve({ resources: [] }); }
      });
    });
    req.on('error', () => resolve({ resources: [] }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ resources: [] }); });
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
        cashfree_app_id VARCHAR(200) DEFAULT '',
        cashfree_secret_key VARCHAR(300) DEFAULT '',
        email VARCHAR(160) DEFAULT '',
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
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_version INT;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS whitelabel_id VARCHAR(50) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS notify_email VARCHAR(160) DEFAULT '';
      -- ── White-label: homepage customization + Cashfree support ──
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS cashfree_app_id VARCHAR(120) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS cashfree_secret_key VARCHAR(200) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS gateway VARCHAR(20) DEFAULT 'razorpay';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_title VARCHAR(160) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_subtitle VARCHAR(200) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_tagline VARCHAR(200) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS made_in VARCHAR(120) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS social_instagram VARCHAR(300) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS social_youtube VARCHAR(300) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS social_facebook VARCHAR(300) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_buttons TEXT DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS monthly_price INTEGER DEFAULT 0;
      -- Partner ka apna domain (jaise https://sharmadigital.in). Set hai to
      -- uski shops ke mail me yahi link jaata hai — mera domain nahi dikhta.
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS site_url VARCHAR(200) DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_shops_wl ON shops(whitelabel_id);
      -- ══ AGENT PROGRAM ══
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS is_agent BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_code VARCHAR(20);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_upi VARCHAR(120) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_price INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_blocked BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_earnings INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_joined_at TIMESTAMP;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS onboarded_by VARCHAR(50) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS base_price_at_signup INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS sold_price INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_credited BOOLEAN DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_agent_code ON shops(agent_code) WHERE agent_code IS NOT NULL;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printing_at TIMESTAMP;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_gateway VARCHAR(20) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS razorpay_key_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS razorpay_key_secret VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS cashfree_app_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS cashfree_secret_key VARCHAR(300) DEFAULT '';
      -- Shop owner ka email — payment confirmation mail isi par jaata hai
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS email VARCHAR(160) DEFAULT '';
      -- PhonePe ab support nahi hai. Columns JAAN-BUJH KAR rakhe hain: data
      -- delete karna wapas nahi aata. Code inhe ab kahin use nahi karta.
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
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_bw_duplex INTEGER DEFAULT 0;
      -- ── Decimal price support (₹2.50 / ₹1.50 jaise rate) ──
      -- INTEGER me 2.5 nahi ban sakta, isliye NUMERIC(10,2) kar rahe hain.
      ALTER TABLE shops ALTER COLUMN price_bw            TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_color         TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_bw_duplex     TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_color_duplex  TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_4x6_4         TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_4x6_6         TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_4x6_10        TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_resume_color  TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_resume_bw     TYPE NUMERIC(10,2);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_color_duplex INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_4x6 VARCHAR(300) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_a3 VARCHAR(300) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS plan_type VARCHAR(12) DEFAULT 'onetime';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS paid_until TIMESTAMP;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS renewal_order_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_unlocked BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_order_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_4 INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_6 INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_10 INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_resume_color INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_resume_bw INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_notice VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_active BOOLEAN DEFAULT true;
      -- Advance ke andar 4 alag-alag module. Har ek ka apna switch, taki
      -- owner sirf wahi feature customer ko dikhaye jo uski shop me chalta hai.
      -- Default true = purani shops ka behaviour bilkul waisa hi rehta hai.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_legal_active  BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_resume_active BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_4x6_active    BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_a3_active     BOOLEAN DEFAULT true;
      -- Purane demo accounts ko bhi advanced features de do. Sirf demo par —
      -- paid shops ka paywall bilkul waise ka waisa rehta hai.
      UPDATE shops SET advanced_unlocked = true
       WHERE demo = true AND advanced_unlocked = false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_logo VARCHAR(400) DEFAULT '';
      -- ── PhonePe hataya gaya ── jo shops PhonePe par thi unka online payment
      -- ab kaam nahi karega, isliye unhe counter-cash par daal rahe hain.
      -- Owner apne panel se Razorpay/Cashfree lagate hi online wapas chalu.
      -- Dobara chale to kuch nahi hota — pehli baar ke baad koi row match hi nahi karti.
      UPDATE shops SET payment_mode='counter_only', payment_gateway=''
        WHERE payment_gateway='phonepe';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS feedback SMALLINT DEFAULT 0;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS duplex BOOLEAN DEFAULT false;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS failure_reason VARCHAR(200) DEFAULT '';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_deleted BOOLEAN DEFAULT false;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paper_size VARCHAR(12) DEFAULT 'a4';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS orientation VARCHAR(12) DEFAULT 'portrait';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS service VARCHAR(16) DEFAULT 'doc';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS photo_count INTEGER DEFAULT 0;
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
      CREATE TABLE IF NOT EXISTS agent_commissions (
        id SERIAL PRIMARY KEY,
        agent_id VARCHAR(50),
        shop_id VARCHAR(50),
        shop_name VARCHAR(200),
        base_price INTEGER DEFAULT 0,
        sold_price INTEGER DEFAULT 0,
        markup INTEGER DEFAULT 0,
        commission INTEGER DEFAULT 0,
        bonus INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ══ TRANSLATIONS ══
      -- source = Hinglish text jo HTML me likha hai (yahi "key" hai).
      -- Har language ke liye ek row. Missing ho to source hi dikhta hai —
      -- isliye adhoori translation se bhi kuch tootta nahi.
      CREATE TABLE IF NOT EXISTS translations (
        id SERIAL PRIMARY KEY,
        lang VARCHAR(8) NOT NULL,
        source TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tr_lang_src ON translations(lang, md5(source));
      CREATE INDEX IF NOT EXISTS idx_tr_lang ON translations(lang);

      -- ══ REVIEWS — homepage par dikhne wale customer reviews ══
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        stars SMALLINT DEFAULT 5,
        text TEXT DEFAULT '',
        city VARCHAR(120) DEFAULT '',
        active BOOLEAN DEFAULT true,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ══ WHITE LABEL — reseller apne brand se bechta hai ══
      -- Reseller apna Razorpay lagata hai, isliye uski shops ka setup fee
      -- SEEDHA usi ke account me jaata hai (hamare paas nahi aata).
      -- Hamein sirf ek baar ka license fee milta hai.
      CREATE TABLE IF NOT EXISTS whitelabels (
        id VARCHAR(50) PRIMARY KEY,
        slug VARCHAR(40) UNIQUE,
        brand_name VARCHAR(120) NOT NULL,
        owner_name VARCHAR(120) DEFAULT '',
        phone VARCHAR(20) DEFAULT '',
        email VARCHAR(160) DEFAULT '',
        password_hash VARCHAR(200) NOT NULL,
        logo_url VARCHAR(400) DEFAULT '',
        powered_by VARCHAR(160) DEFAULT '',
        support_email VARCHAR(160) DEFAULT '',
        support_phone VARCHAR(20) DEFAULT '',
        razorpay_key_id VARCHAR(120) DEFAULT '',
        razorpay_key_secret VARCHAR(200) DEFAULT '',
        shop_price INTEGER DEFAULT 0,
        base_price INTEGER DEFAULT 0,
        license_fee INTEGER DEFAULT 0,
        license_order_id VARCHAR(120) DEFAULT '',
        paid BOOLEAN DEFAULT false,
        blocked BOOLEAN DEFAULT false,
        broadcast TEXT DEFAULT '',
        license_expires_at TIMESTAMP,
        shop_credits INTEGER DEFAULT -1,
        created_at TIMESTAMP DEFAULT NOW(),
        paid_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_wl_slug ON whitelabels(slug);

      -- ══ ANALYTICS — homepage funnel (pageviews + CTA clicks) ══
      -- Demo-create aur paid-conversion ka asli data 'shops' table me
      -- pehle se hai; ye table sirf TOP-of-funnel capture karti hai jo
      -- kahin aur record nahi hoti.
      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(40) NOT NULL,
        path VARCHAR(200) DEFAULT '',
        ref VARCHAR(100) DEFAULT '',
        utm_source VARCHAR(100) DEFAULT '',
        visitor_id VARCHAR(64) DEFAULT '',
        wl VARCHAR(40) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS wl VARCHAR(40) DEFAULT '';
      -- Shop khud review bhej sake, par homepage par tabhi dikhe jab
      -- superadmin approve kare. Purane reviews (jo superadmin ne khud
      -- daale the) DEFAULT 'approved' se apne aap live rehte hain.
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status VARCHAR(12) DEFAULT 'approved';
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS shop_id VARCHAR(50) DEFAULT '';
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS state VARCHAR(80) DEFAULT '';
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT false;
      CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
      -- 'ref' me agent ka referral code jaata hai. Visitor kahan se aaya
      -- (google/facebook/instagram) uske liye alag column chahiye.
      ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS referrer VARCHAR(160) DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_analytics_wl ON analytics_events(wl);
      CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);

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
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_enabled','1') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_minutes','120') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('monthly_fee','399') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('advanced_fee','199') ON CONFLICT DO NOTHING");
    // Agent Base Price (0 = abhi tak set nahi — tab tak agent ka floor = public
    // Offer Price hi rahega). Monthly/Advanced Actual Price bhi 0 = strikethrough
    // hide rahega jab tak superadmin explicitly na daale.
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('agent_base_price','0') ON CONFLICT DO NOTHING");
    // White Label — license fee (ek baar) aur reseller ka minimum shop price
    // Naye shop ka EMAIL alert. SMTP sirf ek baar superadmin set karta hai;
    // partners ko kuch setup nahi karna — wo sirf apna email daalte hain.
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_host','smtp.gmail.com') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_port','587') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_user','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_pass','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('notify_email','') ON CONFLICT DO NOTHING");
    // Brevo HTTPS API — Render jaise hosts SMTP ports block karte hain,
    // isliye default yahi hai (port 443 kabhi block nahi hota).
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('brevo_api_key','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('brevo_sender','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('wl_license_fee','25000') ON CONFLICT DO NOTHING");
    // License ka "kata hua" price — 0 = dikhega hi nahi
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('wl_license_actual','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('wl_base_price','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('monthly_actual_price','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('advanced_actual_price','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('homepage_config', $1) ON CONFLICT DO NOTHING", ["{\"logoUrl\": \"\", \"statShops\": \"\", \"statPrints\": \"\", \"showStats\": true, \"supportEmail\": \"mahatonetcafe@gmail.com\", \"supportPhone\": \"9999999999\", \"planDemo\": [\"Demo Auto Print Software\", \"Personalize QR For Shop\", \"Unlimited Print 24/Hrs\", \"Setup Guide (README) included\"], \"planMonthly\": [\"Auto Print Software\", \"Personalize QR For Shop\", \"Unlimited Print\", \"Advance Feature (4x6 Photo, Resume, A3, Duplex) \\u2014 sab included\", \"Assistant in Setup\", \"On Demand Service will be added\", \"Bug fix on update\", \"WhatsApp Assistant\"], \"planOnetime\": [\"Sab kuch Monthly wala\", \"Assistant in Online Payment Gateway Setup\", \"Bug Fix Within 2Hr\", \"AnyDesk Remote Support\", \"Lifetime Access & Update\", \"No renewal \\u2014 ek baar pay\"], \"faqs\": [{\"q\": \"QR Se Print kya hai?\", \"a\": \"QR Se Print cyber cafe aur print shop ke liye ek automatic print software hai. Aap apni shop ka QR code lagate ho \\u2014 customer apne phone se scan karke file upload karta hai, payment karta hai, aur print aapke printer se automatic nikal jata hai. Na WhatsApp pe file mangni padti hai, na pendrive, na email.\"}, {\"q\": \"Customer file kaise bhejta hai?\", \"a\": \"Shop par laga QR code scan karo, file select karo (PDF, photo \\u2014 ek saath kai files), edit karo (crop, rotate, brightness), payment karo (online ya counter cash) \\u2014 print automatic nikal jata hai. Poora kaam customer ke phone se, 1 minute me.\"}, {\"q\": \"WhatsApp pe file lene se ye better kyun hai?\", \"a\": \"WhatsApp me aapka personal number public ho jata hai, chat me files kho jaati hain, aur hisaab manually rakhna padta hai. QR Se Print me number private rehta hai, har print ka payment record automatic banta hai, aur customer ki file print ke 90 minute baad khud delete ho jaati hai.\"}, {\"q\": \"Kaunse printer ke saath chalta hai?\", \"a\": \"Har Windows printer ke saath \\u2014 HP, Canon, Epson, Brother, sab. B&W aur Color ke liye alag printer set kar sakte ho. Advance me 4x6 photo printer, A3 bada printer aur duplex (dono side) printing bhi support hai.\"}, {\"q\": \"Payment kaise milta hai? Koi commission?\", \"a\": \"Do tarike: counter par cash, ya online payment (Razorpay/Cashfree) jo seedha aapke account me jata hai. Hum beech me nahi aate \\u2014 koi commission nahi, unlimited prints.\"}, {\"q\": \"Kitna kharcha aata hai?\", \"a\": \"Free demo se shuru karo. Phir Rs 399/month ka monthly plan ya Rs 999 one-time lifetime plan \\u2014 ek baar do, hamesha chalao. Koi hidden charge nahi, koi per-print commission nahi.\"}, {\"q\": \"Internet chala jaye to print ka kya hoga?\", \"a\": \"Customer ke jobs queue me safe rehte hain. Internet wapas aate hi software khud jobs utha ke print nikal deta hai \\u2014 kuch khota nahi.\"}]}"]);

    // Broken demo logins repair (bcrypt hash galti se gaya tha; login sha256
    // expect karta hai). Idempotent — sirf $2 (bcrypt) wale demo shops.
    const brokenDemos = await pool.query(
      "SELECT id, phone FROM shops WHERE demo=true AND password_hash LIKE '$2%'");
    for (const d of brokenDemos.rows) {
      const h = await hashPassword(d.phone || '');
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
      monthlyFee: await getMonthlyFee(),
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
// Owner: customer ko dikhne wala notice set/clear
// Owner: advance feature khud on/off (sirf unlocked shop)
// Owner: apni shop ka logo upload (customer QR page par dikhega)
app.post('/api/shop/upload-logo', verifyToken, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Koi file nahi' });
    // SIRF PNG (transparent background ke liye) — JPG/WEBP allowed nahi
    if (req.file.mimetype !== 'image/png' || !isPng(req.file.buffer))
      return res.status(400).json({ error: 'Sirf PNG file chalegi (transparent background wali)' });
    // Max 50 KB
    if (req.file.size > 50 * 1024)
      return res.status(400).json({ error: `Logo 50 KB se chhota hona chahiye (abhi ${Math.round(req.file.size/1024)} KB hai)` });
    // Transparency check — PNG me alpha channel hona chahiye
    if (!pngHasAlpha(req.file.buffer))
      return res.status(400).json({ error: 'PNG transparent background wali honi chahiye (abhi solid background hai)' });
    const url = await uploadImageToCloudinary(req.file.buffer, req.file.mimetype);
    await pool.query('UPDATE shops SET shop_logo=$1 WHERE id=$2', [url, req.shopId]);
    res.json({ success: true, logoUrl: url });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Owner: logo hatao
app.post('/api/shop/remove-logo', verifyToken, async (req, res) => {
  try {
    await pool.query("UPDATE shops SET shop_logo='' WHERE id=$1", [req.shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/advance-active', verifyToken, async (req, res) => {
  try {
    const chk = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    if (!chk.rows.length || !chk.rows[0].advanced_unlocked)
      return res.status(403).json({ error: 'Advance feature unlock nahi hai' });
    const active = req.body.active === true;
    await pool.query('UPDATE shops SET advanced_active=$1 WHERE id=$2', [active, req.shopId]);
    res.json({ success: true, active });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Advance ke 4 module — har ek alag on/off.
// Column name whitelist se aata hai, isliye SQL injection ka scope nahi.
const ADV_MODULE_COLS = {
  legal:  'adv_legal_active',
  resume: 'adv_resume_active',
  '4x6':  'adv_4x6_active',
  a3:     'adv_a3_active'
};

app.post('/api/shop/advance-module', verifyToken, async (req, res) => {
  try {
    const col = ADV_MODULE_COLS[String(req.body.module || '')];
    if (!col) return res.status(400).json({ error: 'Galat module' });
    const chk = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    if (!chk.rows.length || !chk.rows[0].advanced_unlocked)
      return res.status(403).json({ error: 'Advance feature unlock nahi hai' });
    const active = req.body.active === true;
    const r = await pool.query(
      `UPDATE shops SET ${col}=$1 WHERE id=$2
       RETURNING adv_legal_active, adv_resume_active, adv_4x6_active, adv_a3_active`,
      [active, req.shopId]);
    res.json({ success: true, modules: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/notice', verifyToken, async (req, res) => {
  try {
    const notice = typeof req.body.notice === 'string' ? req.body.notice.slice(0, 200) : '';
    await pool.query('UPDATE shops SET shop_notice=$1 WHERE id=$2', [notice, req.shopId]);
    res.json({ success: true, notice });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Owner: busy-time + feedback summary insights
app.get('/api/shop/insights', verifyToken, async (req, res) => {
  try {
    // Busy hours (last 30 din, IST = UTC+5:30)
    const hours = await pool.query(
      `SELECT EXTRACT(HOUR FROM created_at + INTERVAL '5 hours 30 minutes') as hr, COUNT(*) as n
       FROM print_jobs WHERE shop_id=$1 AND payment_status='paid' AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY hr ORDER BY n DESC LIMIT 1`, [req.shopId]);
    // Feedback tally
    const fb = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN feedback=1 THEN 1 ELSE 0 END),0) as up,
              COALESCE(SUM(CASE WHEN feedback=-1 THEN 1 ELSE 0 END),0) as down
       FROM print_jobs WHERE shop_id=$1`, [req.shopId]);
    let peak = null;
    if (hours.rows.length) {
      const h = parseInt(hours.rows[0].hr);
      const ampm = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      peak = `${h12} ${ampm} - ${(h12 % 12) + 1} ${h < 11 || h >= 23 ? ampm : (h+1 < 12 ? 'AM' : 'PM')}`;
    }
    res.json({ peakHour: peak, feedbackUp: parseInt(fb.rows[0].up), feedbackDown: parseInt(fb.rows[0].down) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

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
    const me = await pool.query('SELECT referral_earnings, agent_earnings, setup_paid, demo FROM shops WHERE id=$1', [req.shopId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const earnings = (me.rows[0].referral_earnings || 0) + (me.rows[0].agent_earnings || 0);
    const canRefer = me.rows[0].setup_paid && !me.rows[0].demo; // paid AND non-demo hi refer kare — warna demo user free ₹50 kamata

    // Withdrawn total (done + pending — dono balance se ghatao taaki double-withdraw na ho)
    const wd = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
      [req.shopId]);
    const used = parseInt(wd.rows[0].used) || 0;
    const available = earnings - used;

    // Referred shops list — naam, number, paid status
    const refs = await pool.query(
      // Agent ne jo shops khud onboard ki hain wo yahan NAHI — unka hisaab
      // Agent tab me alag dikhta hai (₹200 commission wala), warna ek hi shop
      // dono jagah dikh kar confuse karti hai
      `SELECT name, phone, setup_paid, created_at FROM shops
       WHERE referred_by=$1 AND COALESCE(onboarded_by,'')='' ORDER BY created_at DESC`,
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

// ══════════════════════════════════════════════════════════════
// AGENT APIs — shop login (verifyToken) ke andar
// ══════════════════════════════════════════════════════════════

// Mera agent status + stats
app.get('/api/agent/status', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,name,is_agent,agent_code,agent_upi,agent_price,agent_blocked,
              agent_earnings,agent_joined_at,setup_paid,demo
       FROM shops WHERE id=$1`, [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const s = r.rows[0];
    const base = await getAgentBasePrice();  // agent ka apna floor, public price nahi

    let stats = { total: 0, paid: 0, pending: 0, demo: 0 };
    if (s.is_agent) {
      const c = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE setup_paid=true AND demo=false)::int AS paid,
                COUNT(*) FILTER (WHERE setup_paid=false AND demo=false)::int AS pending,
                COUNT(*) FILTER (WHERE demo=true)::int AS demo
         FROM shops WHERE onboarded_by=$1`, [req.shopId]);
      stats = c.rows[0];
    }
    const wd = await pool.query(
      "SELECT COALESCE(SUM(amount),0)::int AS used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
      [req.shopId]);

    res.json({
      is_agent: !!s.is_agent, agent_code: s.agent_code, upi: s.agent_upi || '',
      blocked: !!s.agent_blocked, price: s.agent_price || 0,
      base_price: base, max_price: AGENT_PRICE_MAX,
      commission_per_shop: AGENT_COMMISSION,
      bonus_every: AGENT_BONUS_EVERY, bonus_amount: AGENT_BONUS_AMOUNT,
      earnings: s.agent_earnings || 0,
      withdrawn: wd.rows[0].used,
      available: Math.max(0, (s.agent_earnings || 0) - wd.rows[0].used),
      eligible: !!(s.setup_paid && !s.demo),
      joined_at: s.agent_joined_at, stats,
      link: s.agent_code ? `${BASE_URL}/?ref=${s.agent_code}` : null
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Agent bano — sirf paid (non-demo) shop owner
app.post('/api/agent/join', verifyToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT setup_paid,demo,is_agent,agent_code FROM shops WHERE id=$1', [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const s = r.rows[0];
    if (s.demo || !s.setup_paid)
      return res.status(403).json({ error: 'Agent banne ke liye pehle plan lena zaroori hai. Demo account agent nahi ban sakta.' });
    if (s.is_agent) return res.json({ success: true, agent_code: s.agent_code, already: true });

    const code = s.agent_code || await genAgentCode();
    await pool.query(
      'UPDATE shops SET is_agent=true, agent_code=$2, agent_joined_at=NOW() WHERE id=$1',
      [req.shopId, code]);
    res.json({ success: true, agent_code: code, link: `${BASE_URL}/?ref=${code}` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// UPI save — commission isi par aayega
app.put('/api/agent/upi', verifyToken, async (req, res) => {
  try {
    const upi = String(req.body.upi_id || '').trim();
    if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upi))
      return res.status(400).json({ error: 'Sahi UPI ID daalo (jaise name@bank)' });
    const r = await pool.query('SELECT is_agent FROM shops WHERE id=$1', [req.shopId]);
    if (!r.rows.length || !r.rows[0].is_agent) return res.status(403).json({ error: 'Aap agent nahi ho' });
    await pool.query('UPDATE shops SET agent_upi=$2 WHERE id=$1', [req.shopId, upi]);
    res.json({ success: true, upi_id: upi });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Apna selling price set karo — base se neeche nahi, cap se upar nahi
app.put('/api/agent/price', verifyToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT is_agent, agent_blocked FROM shops WHERE id=$1', [req.shopId]);
    if (!r.rows.length || !r.rows[0].is_agent) return res.status(403).json({ error: 'Aap agent nahi ho' });
    if (r.rows[0].agent_blocked) return res.status(403).json({ error: 'Aapka agent account abhi paused hai' });

    const base = await getAgentBasePrice();  // agent isse neeche nahi ja sakta
    const p = parseInt(req.body.price, 10);
    if (!Number.isInteger(p)) return res.status(400).json({ error: 'Sahi price daalo' });
    if (p < base) return res.status(400).json({ error: `Price ₹${base} se kam nahi ho sakta` });
    if (p > AGENT_PRICE_MAX) return res.status(400).json({ error: `Price ₹${AGENT_PRICE_MAX} se zyada nahi ho sakta` });

    await pool.query('UPDATE shops SET agent_price=$2 WHERE id=$1', [req.shopId, p]);
    res.json({ success: true, price: p, base, markup: p - base });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Meri onboard ki hui shops
app.get('/api/agent/shops', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.name, s.phone, s.address, s.created_at, s.setup_paid, s.demo, s.plan_type,
              s.base_price_at_signup, s.sold_price, s.setup_amount, s.agent_last_seen,
              c.total AS earned, c.markup, c.commission, c.bonus
       FROM shops s
       LEFT JOIN agent_commissions c ON c.shop_id = s.id AND c.agent_id = $1
       WHERE s.onboarded_by=$1 ORDER BY s.created_at DESC`, [req.shopId]);
    res.json({ shops: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Kamai ka poora hisaab (payout history)
app.get('/api/agent/commissions', verifyToken, async (req, res) => {
  try {
    const c = await pool.query(
      'SELECT * FROM agent_commissions WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 200', [req.shopId]);
    const w = await pool.query(
      'SELECT amount, upi_id, status, requested_at, completed_at FROM withdrawals WHERE shop_id=$1 ORDER BY requested_at DESC LIMIT 50',
      [req.shopId]);
    res.json({ commissions: c.rows, payouts: w.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Agent khud kisi ki shop onboard kare — Shop ID + password generate
app.post('/api/agent/onboard', verifyToken, async (req, res) => {
  try {
    const me = await pool.query(
      'SELECT is_agent, agent_blocked, agent_price, demo FROM shops WHERE id=$1', [req.shopId]);
    // Demo account sab kuch DEKH sakta hai, par shop onboard nahi kar sakta.
    // Frontend par bhi gate hai — ye doosri layer hai taaki koi seedha
    // API call karke bhi na nikal jaye.
    if (me.rows.length && me.rows[0].demo) {
      return res.status(403).json({
        error: 'To use this feature you must be a paid shop owner',
        needPlan: true
      });
    }
    if (!me.rows.length || !me.rows[0].is_agent) return res.status(403).json({ error: 'Aap agent nahi ho' });
    if (me.rows[0].agent_blocked) return res.status(403).json({ error: 'Aapka agent account abhi paused hai' });

    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim();
    if (!name) return res.status(400).json({ error: 'Shop ka naam zaroori hai' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Sahi 10 digit mobile number daalo' });

    const base = await getSetupFeeAmount();
    const ap = me.rows[0].agent_price;
    const sold = (ap && ap > base) ? ap : base;

    // Baaki details — normal registration jaisi hi
    const printerModel = String(req.body.printer_model || '').trim().slice(0,120);
    const priceBw    = parsePrice(req.body.price_bw);
    const priceColor = parsePrice(req.body.price_color);
    const modes = ['counter_only','both','online_only'];
    const payMode = modes.includes(req.body.payment_mode) ? req.body.payment_mode : 'counter_only';
    // Online payment ke liye shop owner ki apni keys chahiye — wo baad me
    // Payment Setup se khud daalega, isliye agent sirf counter_only de sakta hai
    const finalMode = payMode === 'counter_only' ? 'counter_only' : 'counter_only';

    const shopId = 'SHOP_' + uuidv4().substring(0,8).toUpperCase();
    let password = String(req.body.password || '').trim();
    if (password.length < 4) {
      password = Math.random().toString(36).slice(-4).toUpperCase() + Math.floor(1000 + Math.random()*9000);
    }
    const passwordHash = await hashPassword(password);

    await pool.query(
      `INSERT INTO shops (id,name,address,phone,printer_model,price_bw,price_color,payment_mode,
         password_hash,setup_paid,setup_amount,plan_type,referred_by,onboarded_by,base_price_at_signup,sold_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,'onetime',$11,$11,$12,$13)`,
      [shopId, name, address, phone, printerModel,
       Number.isInteger(priceBw) && priceBw > 0 ? priceBw : 5,
       Number.isInteger(priceColor) && priceColor > 0 ? priceColor : 10,
       finalMode, passwordHash, sold, req.shopId, base, sold]);

    res.json({ success: true, shopId, password, amount: sold,
      pay_url: `${BASE_URL}/setup-payment/${shopId}` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ SUPERADMIN: AGENTS ══════════════
app.get('/api/superadmin/agents', verifySuperAdmin, async (req, res) => {
  try {
    const base = await getAgentBasePrice();  // agent ka apna floor — 599 nahi, 699
    const ags = await pool.query(
      `SELECT id,name,phone,agent_code,agent_upi,agent_price,agent_blocked,agent_earnings,agent_joined_at
       FROM shops WHERE is_agent=true ORDER BY agent_joined_at DESC NULLS LAST`);
    const out = [];
    for (const a of ags.rows) {
      const sh = await pool.query(
        `SELECT s.id,s.name,s.phone,s.created_at,s.setup_paid,s.demo,s.plan_type,
                s.base_price_at_signup,s.sold_price,s.setup_amount,s.agent_last_seen,s.paused,
                c.total AS earned, c.markup, c.commission, c.bonus
         FROM shops s
         LEFT JOIN agent_commissions c ON c.shop_id=s.id AND c.agent_id=$1
         WHERE s.onboarded_by=$1 ORDER BY s.created_at DESC`, [a.id]);
      const wd = await pool.query(
        "SELECT COALESCE(SUM(amount),0)::int AS used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
        [a.id]);
      out.push({
        ...a,
        base_price: base,
        markup: Math.max(0, (a.agent_price || 0) - base),
        paid_out: wd.rows[0].used,
        pending_payout: Math.max(0, (a.agent_earnings || 0) - wd.rows[0].used),
        shops: sh.rows
      });
    }
    res.json({ agents: out, base_price: base, commission: AGENT_COMMISSION,
      max_price: AGENT_PRICE_MAX, bonus_every: AGENT_BONUS_EVERY, bonus_amount: AGENT_BONUS_AMOUNT });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/agent/:shopId/block', verifySuperAdmin, async (req, res) => {
  try {
    const block = !!req.body.blocked;
    const r = await pool.query(
      'UPDATE shops SET agent_blocked=$2 WHERE id=$1 AND is_agent=true RETURNING id, agent_blocked',
      [req.params.shopId, block]);
    if (!r.rows.length) return res.status(404).json({ error: 'Agent nahi mila' });
    res.json({ success: true, blocked: r.rows[0].agent_blocked });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Withdrawal request — min ₹500, UPI zaroori
app.post('/api/shop/withdraw', verifyToken, async (req, res) => {
  try {
    const { upi_id } = req.body;
    if (!upi_id || !/^[\w.\-]+@[\w.\-]+$/.test(upi_id.trim()))
      return res.status(400).json({ error: 'Sahi UPI ID daalo (jaise name@bank)' });

    const me = await pool.query('SELECT referral_earnings, agent_earnings FROM shops WHERE id=$1', [req.shopId]);
    // Referral (₹50) + Agent commission — dono ek hi wallet me
    const earnings = (me.rows[0]?.referral_earnings || 0) + (me.rows[0]?.agent_earnings || 0);
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
// Support: monthly shop ko +30 din (cash/offline payment case)
app.post('/api/superadmin/shop/:shopId/extend', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE shops SET paid_until = GREATEST(NOW(), COALESCE(paid_until, NOW())) + INTERVAL '30 days',
         plan_type='monthly'
       WHERE id=$1 RETURNING paid_until`, [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    console.log(`Superadmin extend +30d: ${req.params.shopId} -> ${r.rows[0].paid_until}`);
    res.json({ success: true, paid_until: r.rows[0].paid_until });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Support: kisi bhi shop ko Advance Feature FREE unlock (bina payment)
app.post('/api/superadmin/shop/:shopId/unlock-advanced', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE shops SET advanced_unlocked=true WHERE id=$1 RETURNING id, name",
      [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    console.log(`Superadmin FREE advanced unlock: ${req.params.shopId}`);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/shop/:shopId/reset-password', verifySuperAdmin, async (req, res) => {
  try {
    const temp = 'QSP' + crypto.randomBytes(3).toString('hex');
    const h = await hashPassword(temp);
    const r = await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2 RETURNING id', [h, req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    console.log(`Password reset by superadmin: ${req.params.shopId}`);
    res.json({ success: true, tempPassword: temp });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Demo accounts list — nazar rakhne + manual delete ke liye ──
// Cloudinary status — kitni file abhi padi hai (sach, DB se nahi, Cloudinary se)
// ══════════════ DB MIGRATION (Railway -> Supabase) ══════════════
// GUI-only migration: OLD_DATABASE_URL env me purana (Railway) URL daalo,
// DATABASE_URL me naya (Supabase). Server boot par naye DB me tables khud
// ban jaate hain (initDB), phir ye endpoint saara data copy karta hai.
// Idempotent — ON CONFLICT DO NOTHING, do baar chalao to bhi safe.
const MIGRATE_TABLES = [
  'system_settings', 'shops', 'print_jobs', 'withdrawals',
  'demo_registrations', 'demo_machines'
];

app.post('/api/superadmin/migrate-db', verifySuperAdmin, async (req, res) => {
  const oldUrl = process.env.OLD_DATABASE_URL;
  if (!oldUrl) return res.status(400).json({ error: 'OLD_DATABASE_URL env set nahi hai' });

  const oldPool = new Pool({
    connectionString: oldUrl,
    ssl: { rejectUnauthorized: false }
  });

  const report = {};
  try {
    for (const table of MIGRATE_TABLES) {
      try {
        const src = await oldPool.query(`SELECT * FROM ${table}`);
        if (!src.rows.length) { report[table] = { found: 0, copied: 0 }; continue; }

        let copied = 0;
        for (const row of src.rows) {
          const cols = Object.keys(row);
          const vals = cols.map(c => row[c]);
          const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
          try {
            await pool.query(
              `INSERT INTO ${table} (${cols.map(c => '"' + c + '"').join(',')})
               VALUES (${ph}) ON CONFLICT DO NOTHING`, vals);
            copied++;
          } catch (e) { /* naya schema me column nahi — skip */ }
        }
        report[table] = { found: src.rows.length, copied };
      } catch (e) {
        report[table] = { error: e.message.slice(0, 80) };
      }
    }
    await oldPool.end();
    console.log('DB migration report:', JSON.stringify(report));
    res.json({ success: true, report });
  } catch (err) {
    try { await oldPool.end(); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

// ══════════════ BACKUP DOWNLOAD ══════════════
// Supabase free me automatic backup nahi hota. Ye button poora DB ek JSON
// file me deta hai — hafte me ek baar dabao, apne phone/PC me rakh lo.
app.get('/api/superadmin/backup', verifySuperAdmin, async (req, res) => {
  try {
    const dump = { taken_at: new Date().toISOString(), tables: {} };
    for (const table of MIGRATE_TABLES) {
      try {
        const r = await pool.query(`SELECT * FROM ${table}`);
        dump.tables[table] = r.rows;
      } catch (e) { dump.tables[table] = { error: e.message }; }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="qrseprint-backup-${stamp}.json"`);
    res.send(JSON.stringify(dump, null, 2));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Row counts — migration verify karne ke liye
app.get('/api/superadmin/db-counts', verifySuperAdmin, async (req, res) => {
  try {
    const counts = {};
    for (const t of MIGRATE_TABLES) {
      try {
        const r = await pool.query(`SELECT COUNT(*) FROM ${t}`);
        counts[t] = parseInt(r.rows[0].count);
      } catch (e) { counts[t] = -1; }
    }
    res.json(counts);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/cloudinary-status', verifySuperAdmin, async (req, res) => {
  try {
    let cursor = '', all = [];
    for (let p = 0; p < 5; p++) {
      const { resources, next_cursor } = await listCloudinaryFiles(cursor);
      all = all.concat(resources);
      if (!next_cursor) break;
      cursor = next_cursor;
    }
    const now = Date.now();
    const files = all.map(r => ({
      public_id: r.public_id,
      bytes: r.bytes || 0,
      age_min: Math.round((now - new Date(r.created_at).getTime()) / 60000)
    })).sort((a, b) => b.age_min - a.age_min);
    const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
    res.json({
      count: files.length,
      total_kb: Math.round(totalBytes / 1024),
      stale: files.filter(f => f.age_min >= 90).length,   // ye nahi hone chahiye
      files: files.slice(0, 20)
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Manual sweep — "abhi saaf karo" button
app.post('/api/superadmin/cloudinary-sweep', verifySuperAdmin, async (req, res) => {
  try {
    let cursor = '', swept = 0;
    for (let p = 0; p < 5; p++) {
      const { resources, next_cursor } = await listCloudinaryFiles(cursor);
      for (const r of resources) {
        const ageMin = (Date.now() - new Date(r.created_at).getTime()) / 60000;
        if (ageMin < 90) continue;
        const active = await pool.query(
          "SELECT 1 FROM print_jobs WHERE file_public_id=$1 AND status IN ('queued','printing')", [r.public_id]);
        if (active.rows.length) continue;
        await deleteFromCloudinary(r.public_id);
        await pool.query('UPDATE print_jobs SET file_deleted=true WHERE file_public_id=$1', [r.public_id]);
        swept++;
      }
      if (!next_cursor) break;
      cursor = next_cursor;
    }
    res.json({ success: true, swept });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/demo-config', verifySuperAdmin, async (req, res) => {
  res.json(await getDemoConfig());
});
app.put('/api/superadmin/demo-config', verifySuperAdmin, async (req, res) => {
  try {
    const enabled = req.body.enabled ? '1' : '0';
    let mins = parseInt(req.body.minutes);
    if (isNaN(mins) || mins < 15 || mins > 1440)
      return res.status(400).json({ error: 'Minutes 15 se 1440 (24 ghante) ke beech ho' });
    await pool.query("UPDATE system_settings SET value=$1 WHERE key='demo_enabled'", [enabled]);
    await pool.query("UPDATE system_settings SET value=$1 WHERE key='demo_minutes'", [String(mins)]);
    res.json({ success: true, enabled: enabled === '1', minutes: mins });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/demos', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.name, s.phone, s.created_at, s.demo_expires_at, s.agent_last_seen, s.agent_version,
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
async function getDemoConfig() {
  try {
    const r = await pool.query("SELECT key,value FROM system_settings WHERE key IN ('demo_enabled','demo_minutes')");
    const m = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    const mins = Math.max(15, Math.min(1440, parseInt(m.demo_minutes) || 120)); // 15 min .. 24 hr guard
    return { enabled: (m.demo_enabled || '1') === '1', minutes: mins };
  } catch (e) { return { enabled: true, minutes: 120 }; }
}

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
    const cfg = await getDemoConfig();
    if (!cfg.enabled) return res.status(403).json({ error: 'Demo abhi band hai — thodi der baad try karo ya seedha register karo' });

    const name = String(req.body.name || '').trim().slice(0, 100);
    const phone = normPhone(req.body.phone);
    if (!name) return res.status(400).json({ error: 'Naam daalo' });
    if (!phone) return res.status(400).json({ error: 'Sahi 10-digit mobile number daalo' });

    // Layer 1: phone permanent lock — demo_registrations AUR shops dono check
    // karo. (Migration me demo_registrations khali reh gaya tha to ye double
    // safety hai — duplicate demo shops nahi banenge.)
    const dup = await pool.query('SELECT id FROM demo_registrations WHERE phone=$1', [phone]);
    const dupShop = await pool.query('SELECT id FROM shops WHERE phone=$1 AND demo=true', [phone]);
    if (dup.rows.length || dupShop.rows.length)
      return res.status(400).json({ error: 'Is number par demo pehle liya ja chuka hai. Pasand aaya tha? Ab register karo 🙂' });

    // Layer 2: IP — max 2 demo/din
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60);
    const ipCount = await pool.query(
      "SELECT COUNT(*) FROM demo_registrations WHERE ip=$1 AND created_at > NOW() - INTERVAL '24 hours'", [ip]);
    if (parseInt(ipCount.rows[0].count) >= 2)
      return res.status(429).json({ error: 'Aaj ke liye demo limit ho gayi — kal try karo ya abhi register karo' });

    const shopId = 'DEMO_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const passwordHash = await hashPassword(phone);
    await pool.query(
      // advanced_unlocked=true — demo me saare advanced features khule
      // rehte hain. Demo ka matlab hi hai ki banda poora software dekh
      // sake; aadha dikha kar paise maangna ulta pad jaata hai.
      // Paid shops par ye paywall waise ka waisa hai.
      `INSERT INTO shops (id, name, phone, price_bw, price_color, payment_mode, password_hash,
                          setup_paid, setup_amount, demo, demo_expires_at, advanced_unlocked)
       VALUES ($1,$2,$3,5,10,'counter_only',$4,true,0,true,NOW() + ($5 || ' minutes')::INTERVAL,true)`,
      [shopId, name + ' (Demo)', phone, passwordHash, String(cfg.minutes)]);
    // Unique index (uniq_demo_reg_phone) DB pe race ko bhi rok deta hai —
    // agar do request ek saath aaye to doosri yahan safely fail hogi.
    try {
      await pool.query('INSERT INTO demo_registrations (phone, ip, shop_id) VALUES ($1,$2,$3)', [phone, ip, shopId]);
    } catch (e) {
      if (e.code === '23505') { // unique_violation — phone pehle se locked
        await pool.query('DELETE FROM shops WHERE id=$1', [shopId]); // abhi bana shop rollback
        return res.status(400).json({ error: 'Is number par demo pehle liya ja chuka hai. Ab register karo 🙂' });
      }
      throw e;
    }

    const qrUrl = `${BASE_URL}/print/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
    await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);

    console.log(`Demo created: ${shopId} | ${phone} | ip ${ip}`);
    res.json({ success: true, shopId, password: phone, qrUrl, qrCode,
               expiresInMinutes: cfg.minutes,
               note: 'Login password = aapka mobile number' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/printer-models', (req, res) => {
  res.json({ models: PRINTER_MODELS });
});

app.get('/api/demo/config', async (req, res) => {
  const c = await getDemoConfig();
  res.json({ enabled: c.enabled, minutes: c.minutes });
});

// Setup-payment page: is shop ka plan + amount (sirf unpaid — paid par info leak nahi)
app.get('/api/setup-status/:shopId', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, setup_paid, setup_amount, plan_type FROM shops WHERE id=$1', [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if (r.rows[0].setup_paid) return res.json({ paid: true });
    res.json({ paid: false, plan: r.rows[0].plan_type || 'onetime', amount: r.rows[0].setup_amount || 0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/setup-readme/:shopId', async (req, res) => {
  const shopId = (req.params.shopId || '').toUpperCase();
  const txt = `\uFEFF========================================
   QR SE PRINT — SETUP GUIDE (README)
========================================

Aapki Shop ID: ${shopId}

Ye guide follow karke 10 minute me apni shop chalu karo.

----------------------------------------
STEP 1: SOFTWARE DOWNLOAD
----------------------------------------
1. Shop Login karo: qrseprint.in/admin
   (Shop ID + jo password aapne register/demo me set kiya)
2. Left menu me "QR & Downloads" tab kholo
3. "Download Latest Software Version" (green button) dabao
4. File download hone do (QRSePrint-Setup.exe)

----------------------------------------
STEP 2: INSTALL
----------------------------------------
1. Downloaded .exe file par double-click karo
2. Windows "Unknown publisher" warning de to
   "More info" -> "Run anyway" dabao (safe hai)
3. Install complete hone do
4. Software khulega aur SHOP ID maangega

----------------------------------------
STEP 3: SHOP ID PASTE
----------------------------------------
1. Aapki Shop ID: ${shopId}
2. Ye Shop ID software me paste karo
   (Shop Login -> QR & Downloads me bhi dikhti hai — copy kar sakte ho)
3. Save/OK dabao
4. Neeche right corner (system tray) me printer icon aa jayega
   = Software chalu, server se juda hua

----------------------------------------
STEP 4: PRINTER SETTINGS (ZAROORI)
----------------------------------------
1. Shop Login -> "Settings" tab kholo
2. Yahan printer select karo:
   - B&W print kaun se printer se? (list me se chuno)
   - Color print kaun se printer se?
   - Duplex (dual-side) chahiye to mode chuno
   - 4x6 photo / A3 ke liye alag printer ho to wo bhi
3. "Save" dabao
   (Printer list software se automatic aati hai —
    software chalu hona chahiye tabhi list dikhegi)

----------------------------------------
STEP 5: PAYMENT SETTINGS
----------------------------------------
Settings me payment mode chuno:
   - Sirf Counter Cash (sabse simple — koi gateway nahi)
   - Online + Counter dono
   - Sirf Online (gateway zaroori)

ONLINE PAYMENT ke liye (Razorpay ya Cashfree):
   Settings me "Keys Kaise Milegi" guide diya hai —
   step by step Key ID / Secret (Razorpay) ya App ID /
   Secret Key (Cashfree) kahan se milegi aur kahan
   paste karni hai, sab likha hai.
   Business/Website URL puchhe to likho: qrseprint.in

----------------------------------------
STEP 6: TEST
----------------------------------------
1. Apne phone se apni shop ka QR scan karo
2. Ek file upload karo, payment karo (ya counter)
3. Print nikalna chahiye
4. Ho gaya! Ab customers use kar sakte hain.

----------------------------------------
MADAD CHAHIYE?
----------------------------------------
WhatsApp Assistant se contact karo.
One-Time plan walon ko AnyDesk support bhi milta hai.

========================================
   Developed by Rupesh Kumar Mahato
========================================
`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="QRSePrint-Setup-Guide.txt"`);
  res.send(txt);
});

// ══════════════════════════════════════════════════════════════
// AGENT PROGRAM — helpers
// Agent = paid shop owner jo doosri shops onboard karke commission kamata hai.
// Kamai = ₹200 fix per shop + markup (agent ka price − superadmin ka base price)
// + har 10 shop par ₹300 bonus. Payout manual (UPI), withdrawals table se.
// ══════════════════════════════════════════════════════════════
const AGENT_COMMISSION   = 200;   // per successful paid shop
const AGENT_PRICE_MAX    = 2999;  // agent isse upar price nahi rakh sakta
const AGENT_BONUS_EVERY  = 10;    // har 10 shop par
const AGENT_BONUS_AMOUNT = 300;   // itna extra bonus

// ══════════════════════════════════════════════════════════════
// WHITE LABEL — helpers
// Reseller apne brand + apne Razorpay se shops bechta hai. Uski shops ka
// setup fee SEEDHA uske Razorpay me jaata hai; hamare paas sirf ek baar
// ka license fee aata hai.
// ══════════════════════════════════════════════════════════════
async function getWlLicenseFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='wl_license_fee'");
    return Math.max(1, parseInt(r.rows[0]?.value) || 25000);
  } catch(e) { return 25000; }
}

// Reseller isse neeche shop price nahi rakh sakta. 0/unset = public Offer Price.
async function getWlLicenseActual() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='wl_license_actual'");
    return Math.max(0, parseInt(r.rows[0]?.value) || 0);
  } catch(e) { return 0; }
}

async function getWlBasePrice() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='wl_base_price'");
    const v = parseInt(r.rows[0]?.value) || 0;
    if (v > 0) return v;
  } catch(e) {}
  return await getSetupFeeAmount();
}

// slug: sirf chhote akshar, number aur dash
function cleanSlug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

// Reseller dhoondo — ?wl=slug se, ya subdomain (abc.qrseprint.in) se
async function resolveWhitelabel(req) {
  try {
    let slug = cleanSlug(req.query.wl || req.body?.wl || '');
    if (!slug) {
      const host = String(req.headers.host || '').toLowerCase().split(':')[0];
      const parts = host.split('.');
      // abc.qrseprint.in -> abc  (www aur main domain chhod do)
      if (parts.length > 2 && parts[0] !== 'www') slug = cleanSlug(parts[0]);
    }
    if (!slug) return null;
    const r = await pool.query(
      'SELECT * FROM whitelabels WHERE slug=$1 AND paid=true AND blocked=false', [slug]);
    return r.rows[0] || null;
  } catch(e) { return null; }
}

// Reseller ka JWT verify
function verifyWhitelabel(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Login zaroori hai' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (!d.wlId) return res.status(403).json({ error: 'Ye whitelabel token nahi hai' });
    req.wlId = d.wlId;
    next();
  } catch(e) { return res.status(401).json({ error: 'Session expire ho gaya, dobara login karo' }); }
}

async function genAgentCode() {
  for (let i = 0; i < 40; i++) {
    const code = 'QRA-' + Math.floor(1000 + Math.random() * 9000);
    const c = await pool.query('SELECT 1 FROM shops WHERE agent_code=$1', [code]);
    if (!c.rows.length) return code;
  }
  return 'QRA-' + Date.now().toString().slice(-6);
}

// ref = agent code (QRA-1234) ya purana shop id (SHOP_XXXX) — dono chalte hain
async function resolveRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const v = ref.trim().toUpperCase();
  if (!v) return null;
  const r = await pool.query(
    `SELECT id, name, is_agent, agent_blocked, agent_price, setup_paid, demo
     FROM shops WHERE (agent_code=$1 OR UPPER(id)=$1) LIMIT 1`, [v]);
  if (!r.rows.length) return null;
  const s = r.rows[0];
  if (!s.setup_paid || s.demo) return null;          // unpaid/demo refer nahi kar sakta
  if (s.is_agent && s.agent_blocked) return null;    // blocked agent ka link dead
  return s;
}

// Kisi ref ke hisaab se one-time setup price (agent ne badhaya ho to wahi)
async function priceForRef(ref) {
  const base = await getSetupFeeAmount();
  const s = await resolveRef(ref);
  if (s && s.is_agent && s.agent_price && s.agent_price > base) {
    return { price: s.agent_price, base, agent: s };
  }
  return { price: base, base, agent: s || null };
}

// ══════════════════════════════════════════════════════════════
// ANALYTICS — homepage funnel tracking (first-party, no external service)
// ══════════════════════════════════════════════════════════════
const ANALYTICS_EVENTS = [
  'pageview', 'demo_click', 'register_click', 'inquiry_click',
  'guide_click', 'agent_click',
  'pay_click',    // register form me "Pay & Activate" dabaya
  'demo_login'    // demo shop ne dashboard me login kiya
];

// Referrer se pata karo visitor kahan se aaya. Sirf hostname rakhte hain —
// poora URL nahi, taaki kisi ka private page path store na ho.
function refHostname(raw) {
  try {
    const v = String(raw || '').trim();
    if (!v) return '';
    const u = new URL(v.includes('://') ? v : 'https://' + v);
    return u.hostname.replace(/^www\./, '').slice(0, 160);
  } catch (e) { return ''; }
}

// Public, halka beacon — koi auth nahi (anonymous pageview/click hi hai).
// Kabhi bhi page ko block/error nahi karta, client se fire-and-forget.
app.post('/api/track', async (req, res) => {
  try {
    const b = req.body || {};
    const eventType = String(b.event_type || '').slice(0, 40);
    if (!ANALYTICS_EVENTS.includes(eventType)) return res.status(400).json({ error: 'invalid event' });
    await pool.query(
      `INSERT INTO analytics_events (event_type, path, ref, utm_source, visitor_id, wl, referrer)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        eventType,
        String(b.path || '').slice(0, 200),
        String(b.ref || '').slice(0, 100),
        String(b.utm_source || '').slice(0, 100),
        String(b.visitor_id || '').slice(0, 64),
        cleanSlug(b.wl || ''),
        refHostname(b.referrer)
      ]
    );
    res.json({ success: true });
  } catch (err) { res.status(200).json({ success: false }); } // kabhi bhi client ko error na dikhe
});

// Superadmin: aggregated funnel data — daily breakdown + totals + source split

// ═══════════════════════════════════════════════════════════════════
//  ACTION CENTER — "Aaj kya dekhna hai"
//  19 tab me ghoomne ke bajaye ek jagah: kya atka hai, kya chhoot raha
//  hai, kis shop ko aaj message karna hai. Sab kuch pehle se maujood
//  data se banta hai — koi naya tracking nahi.
// ═══════════════════════════════════════════════════════════════════
app.get('/api/superadmin/action-center', verifySuperAdmin, async (req, res) => {
  try {
    const LIMIT = 25;

    // 1. Register hua par paisa nahi diya — seedha khoya hua paisa.
    //    45 din se purane chhod dete hain, wo dead lead hain.
    const unpaid = await pool.query(`
      SELECT id, name, phone, email, created_at,
             EXTRACT(DAY FROM NOW() - created_at)::int AS days_ago
      FROM shops
      WHERE demo = false AND setup_paid = false
        AND created_at > NOW() - INTERVAL '45 days'
      ORDER BY created_at DESC LIMIT ${LIMIT}`);

    // 2. Demo khatam hone wale — abhi baat karoge to paid ban sakte hain
    const demoExpiring = await pool.query(`
      SELECT id, name, phone, email, demo_expires_at,
             GREATEST(0, CEIL(EXTRACT(EPOCH FROM (demo_expires_at - NOW()))/86400))::int AS days_left
      FROM shops
      WHERE demo = true AND demo_expires_at IS NOT NULL
        AND demo_expires_at > NOW() AND demo_expires_at < NOW() + INTERVAL '3 days'
      ORDER BY demo_expires_at ASC LIMIT ${LIMIT}`);

    // 2b. Demo khatam HO CHUKA — ye sabse garam lead hain, inhone product
    //     use kiya aur ab band ho gaya. 30 din tak follow-up worth hai.
    const demoExpired = await pool.query(`
      SELECT id, name, phone, email, demo_expires_at,
             GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - demo_expires_at))/86400))::int AS days_ago
      FROM shops
      WHERE demo = true AND demo_expires_at IS NOT NULL
        AND demo_expires_at <= NOW()
        AND demo_expires_at > NOW() - INTERVAL '30 days'
      ORDER BY demo_expires_at DESC LIMIT ${LIMIT}`);

    // 3. Print agent offline — pehle chal raha tha, ab 24 ghante se nahi.
    //    Jinhone kabhi install hi nahi kiya wo yahan nahi aate, wo alag
    //    problem hai (onboarding), yahan sirf toota hua setup dikhta hai.
    const agentOffline = await pool.query(`
      SELECT id, name, phone, agent_last_seen, agent_version,
             FLOOR(EXTRACT(EPOCH FROM (NOW() - agent_last_seen))/3600)::int AS hours_ago
      FROM shops
      WHERE demo = false AND setup_paid = true AND paused = false
        AND agent_last_seen IS NOT NULL
        AND agent_last_seen < NOW() - INTERVAL '24 hours'
      ORDER BY agent_last_seen ASC LIMIT ${LIMIT}`);

    // 4. Chup shops — 7 din se ek bhi print nahi. Ye chhodne wali hain.
    //    Nayi shops (7 din se kam purani) ko chhod dete hain, unka
    //    abhi setup hi chal raha hota hai.
    const silent = await pool.query(`
      SELECT s.id, s.name, s.phone, s.created_at,
             MAX(p.created_at) AS last_print,
             CASE WHEN MAX(p.created_at) IS NULL THEN NULL
                  ELSE EXTRACT(DAY FROM NOW() - MAX(p.created_at))::int END AS days_silent
      FROM shops s
      LEFT JOIN print_jobs p ON p.shop_id = s.id
      WHERE s.demo = false AND s.setup_paid = true AND s.paused = false
        AND s.created_at < NOW() - INTERVAL '7 days'
      GROUP BY s.id, s.name, s.phone, s.created_at
      HAVING MAX(p.created_at) IS NULL OR MAX(p.created_at) < NOW() - INTERVAL '7 days'
      ORDER BY MAX(p.created_at) ASC NULLS FIRST LIMIT ${LIMIT}`);

    // 5. Renewal — 5 din me khatam, ya khatam ho chuka.
    //    Bina reminder ke ye chupchaap chhoot jaate hain.
    const renewals = await pool.query(`
      SELECT id, name, phone, email, paid_until, plan_type,
             CEIL(EXTRACT(EPOCH FROM (paid_until - NOW()))/86400)::int AS days_left
      FROM shops
      WHERE demo = false AND paid_until IS NOT NULL
        AND paid_until < NOW() + INTERVAL '5 days'
        AND paid_until > NOW() - INTERVAL '30 days'
      ORDER BY paid_until ASC LIMIT ${LIMIT}`);

    // 6. Chhote counters — inke liye poori list ki zaroorat nahi
    const wd = await pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::int AS amount
       FROM withdrawals WHERE status='pending'`);
    const rv = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM reviews WHERE status='pending'");

    res.json({
      unpaid: unpaid.rows,
      demoExpiring: demoExpiring.rows,
      demoExpired: demoExpired.rows,
      agentOffline: agentOffline.rows,
      silent: silent.rows,
      renewals: renewals.rows,
      withdrawals: wd.rows[0] || { cnt: 0, amount: 0 },
      reviewsPending: (rv.rows[0] || {}).cnt || 0
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/analytics', verifySuperAdmin, async (req, res) => {
  try {
    // ── Range: chhote ranges (1h/12h/1d) ghante-war bucket karte hain,
    // baaki (7d/14d/30d/90d) din-war — jaisa pehle se tha.
    const RANGE_MAP = {
      '1h':  { amount: 1,  unit: 'hours', bucket: 'hour' },
      '12h': { amount: 12, unit: 'hours', bucket: 'hour' },
      '1d':  { amount: 24, unit: 'hours', bucket: 'hour' },
      '7d':  { amount: 7,  unit: 'days',  bucket: 'day'  },
      '14d': { amount: 14, unit: 'days',  bucket: 'day'  },
      '30d': { amount: 30, unit: 'days',  bucket: 'day'  },
      '90d': { amount: 90, unit: 'days',  bucket: 'day'  }
    };
    let rangeKey = String(req.query.range || '');
    if (!RANGE_MAP[rangeKey]) {
      // Purana ?days= param bhi chalta rahe (backward compatible)
      const legacyDays = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
      rangeKey = [7,14,30,90].includes(legacyDays) ? legacyDays + 'd' : '30d';
    }
    const cfg = RANGE_MAP[rangeKey];
    const intervalStr = `${cfg.amount} ${cfg.unit}`;
    const isHourly = cfg.bucket === 'hour';
    const days = cfg.unit === 'days' ? cfg.amount : 0; // legacy field, frontend ke liye

    // Ghante-war bucket IST me dikhate hain (readable), din-war bucket
    // waisa hi rehta hai jaisa pehle tha (behaviour change nahi karna).
    const bucketExpr = isHourly
      ? `TO_CHAR(created_at + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD"T"HH24:00')`
      : `TO_CHAR(created_at, 'YYYY-MM-DD')`;

    const daily = await pool.query(
      `SELECT event_type, ${bucketExpr} AS day,
              COUNT(*)::int AS cnt, COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events
       WHERE created_at > NOW() - $1::interval
       GROUP BY event_type, day ORDER BY day ASC`, [intervalStr]);

    const shopsDaily = await pool.query(
      `SELECT ${bucketExpr} AS day,
              COUNT(*) FILTER (WHERE demo=true)::int AS demo_created,
              COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int AS paid_created
       FROM shops
       WHERE created_at > NOW() - $1::interval
       GROUP BY day ORDER BY day ASC`, [intervalStr]);

    const totals = await pool.query(
      `SELECT event_type, COUNT(*)::int AS cnt, COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events WHERE created_at > NOW() - $1::interval
       GROUP BY event_type`, [intervalStr]);

    const bySource = await pool.query(
      `SELECT COALESCE(NULLIF(utm_source,''),'direct') AS source, COUNT(*)::int AS cnt
       FROM analytics_events
       WHERE event_type='pageview' AND created_at > NOW() - $1::interval
       GROUP BY source ORDER BY cnt DESC LIMIT 10`, [intervalStr]);

    // Visitor kahan se aaya — utm_source ho to wahi (chhote alias jaise
    // 'ig'/'fb' ko poore naam me normalize karte hain), warna referrer ke
    // hostname se pehchano. Ek hi visitor ko ek hi baar gino (DISTINCT).
    const sourceSql = `
      CASE
        WHEN LOWER(utm_source) IN ('ig','insta')      THEN 'instagram'
        WHEN LOWER(utm_source) IN ('fb','fbook')       THEN 'facebook'
        WHEN LOWER(utm_source) IN ('wa','whats')       THEN 'whatsapp'
        WHEN LOWER(utm_source) IN ('yt')                THEN 'youtube'
        WHEN LOWER(utm_source) IN ('tg')                THEN 'telegram'
        WHEN LOWER(utm_source) IN ('li')                THEN 'linkedin'
        WHEN LOWER(utm_source) IN ('tw','x')            THEN 'twitter'
        WHEN LOWER(utm_source) IN ('gg','g')            THEN 'google'
        WHEN utm_source <> ''                           THEN LOWER(utm_source)
        WHEN referrer ILIKE '%google.%'    THEN 'google'
        WHEN referrer ILIKE '%bing.%' OR referrer ILIKE '%duckduckgo%'
          OR referrer ILIKE '%yahoo.%'     THEN 'other-search'
        WHEN referrer ILIKE '%facebook%' OR referrer ILIKE '%fb.%'
          OR referrer ILIKE '%fb.watch%'   THEN 'facebook'
        WHEN referrer ILIKE '%instagram%'  THEN 'instagram'
        WHEN referrer ILIKE '%whatsapp%'   THEN 'whatsapp'
        WHEN referrer ILIKE '%youtube%' OR referrer ILIKE '%youtu.be%' THEN 'youtube'
        WHEN referrer ILIKE '%t.me%' OR referrer ILIKE '%telegram%'    THEN 'telegram'
        WHEN referrer ILIKE '%linkedin%'   THEN 'linkedin'
        WHEN referrer ILIKE '%twitter%' OR referrer ILIKE '%x.com%'    THEN 'twitter'
        WHEN referrer = ''                 THEN 'direct'
        ELSE 'other'
      END`;

    const sources = await pool.query(
      `SELECT ${sourceSql} AS source,
              COUNT(*)::int AS views,
              COUNT(DISTINCT NULLIF(visitor_id,''))::int AS visitors
       FROM analytics_events
       WHERE event_type='pageview' AND created_at > NOW() - $1::interval
       GROUP BY 1 ORDER BY visitors DESC, views DESC`, [intervalStr]);

    // Kaunsa source sabse zyada asli grahak laata hai — sirf traffic nahi,
    // demo aur pay tak kaun pahunchta hai wo bhi.
    const sourceQuality = await pool.query(
      `SELECT ${sourceSql} AS source,
              COUNT(DISTINCT NULLIF(visitor_id,'')) FILTER (WHERE event_type='pageview')::int   AS visitors,
              COUNT(DISTINCT NULLIF(visitor_id,'')) FILTER (WHERE event_type='demo_click')::int AS demo_clicks,
              COUNT(DISTINCT NULLIF(visitor_id,'')) FILTER (WHERE event_type='pay_click')::int  AS pay_clicks
       FROM analytics_events
       WHERE created_at > NOW() - $1::interval
       GROUP BY 1 ORDER BY visitors DESC`, [intervalStr]);

    // Din me kitna traffic, raat me kitna — IST 6AM-6PM ko "din" maante
    // hain. created_at UTC me store hota hai isliye +5:30 shift karke
    // IST ghanta nikalte hain.
    const dayNight = await pool.query(
      `SELECT
         CASE WHEN EXTRACT(HOUR FROM (created_at + INTERVAL '5 hours 30 minutes')) BETWEEN 6 AND 17
              THEN 'day' ELSE 'night' END AS period,
         COUNT(*)::int AS cnt,
         COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events
       WHERE event_type='pageview' AND created_at > NOW() - $1::interval
       GROUP BY period`, [intervalStr]);

    // Paise ka funnel — ye analytics_events se nahi, shops table ke asli data se
    const payments = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE demo=false)::int                                  AS registered,
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int              AS paid,
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=false)::int             AS pending,
         COALESCE(SUM(setup_amount) FILTER (WHERE demo=false AND setup_paid=true),0)::int AS revenue
       FROM shops
       WHERE created_at > NOW() - $1::interval`, [intervalStr]);

    // Shops ki abhi ki halat — ye poore time ka hai, sirf range ka nahi
    const shopStats = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int   AS active,
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=false)::int  AS unpaid,
         COUNT(*) FILTER (WHERE demo=true AND (demo_expires_at IS NULL OR demo_expires_at > NOW()))::int AS demo_live,
         COUNT(*) FILTER (WHERE demo=true AND demo_expires_at IS NOT NULL AND demo_expires_at <= NOW())::int AS demo_expired,
         COUNT(*)::int AS total
       FROM shops`);

    // Total overall income — "Active shops" jaisa hi POORE TIME ka hai,
    // range filter se independent. NOTE: is table me har shop ki sirf
    // PEHLI payment record hoti hai (setup_amount). Monthly plan ke
    // baad ke renewals abhi alag se log nahi hote, isliye monthly
    // shops ke liye ye unka poora lifetime revenue nahi — sirf
    // onboarding revenue hai. Onetime shops ke liye ye hi final hai.
    const revenueAllTime = await pool.query(
      `SELECT
         COALESCE(SUM(setup_amount) FILTER (WHERE demo=false AND setup_paid=true),0)::int AS total,
         COALESCE(SUM(setup_amount) FILTER (WHERE demo=false AND setup_paid=true AND plan_type='onetime'),0)::int AS onetime_total,
         COALESCE(SUM(setup_amount) FILTER (WHERE demo=false AND setup_paid=true AND plan_type='monthly'),0)::int AS monthly_first_total
       FROM shops`);

    res.json({
      daily: daily.rows,
      shopsDaily: shopsDaily.rows,
      totals: totals.rows,
      bySource: bySource.rows,
      sources: sources.rows,
      sourceQuality: sourceQuality.rows,
      dayNight: dayNight.rows,
      payments: payments.rows[0] || {},
      shopStats: shopStats.rows[0] || {},
      revenueAllTime: revenueAllTime.rows[0] || {},
      days,
      range: rangeKey,
      hourly: isHourly,
      rangeAmount: cfg.amount,
      rangeUnit: cfg.unit
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Razorpay order banane ka reusable helper (kiske keys se — wo caller decide kare)
function createRazorpayOrder(keyId, keySecret, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req2 = https.request({
      hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
        'Content-Length': Buffer.byteLength(body)
      }
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req2.on('error', reject);
    req2.write(body);
    req2.end();
  });
}

// ══════════════ WHITE LABEL — public ══════════════

// License ka price (registration page dikhata hai)
app.get('/api/whitelabel/license-fee', async (req, res) => {
  try {
    res.json({
      licenseFee: await getWlLicenseFee(),
      licenseActual: await getWlLicenseActual(),
      basePrice: await getWlBasePrice()
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Branding — homepage/customer page yahan se apna brand uthate hain
// (?wl=slug se ya subdomain se). Koi WL nahi mila to default QR Se Print.
app.get('/api/whitelabel/branding', async (req, res) => {
  try {
    const wl = await resolveWhitelabel(req);
    if (!wl) return res.json({ isWhitelabel: false });
    // Homepage ke live counters — seedha DB se (hardcoded nahi)
    let stats = { shops: 0, prints: 0 };
    try {
      const c = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM shops
             WHERE whitelabel_id=$1 AND COALESCE(demo,false)=false) AS shops,
           (SELECT COUNT(*)::int FROM print_jobs j
             JOIN shops s ON s.id=j.shop_id
            WHERE s.whitelabel_id=$1) AS prints`, [wl.id]);
      stats = { shops: c.rows[0].shops || 0, prints: c.rows[0].prints || 0 };
    } catch (e) { /* count fail ho to homepage na toote */ }

    let buttons = {};
    try { buttons = wl.hp_buttons ? JSON.parse(wl.hp_buttons) : {}; } catch (e) { buttons = {}; }

    res.json({
      isWhitelabel: true,
      slug: wl.slug,
      brandName: wl.brand_name,
      logoUrl: wl.logo_url || '',
      poweredBy: wl.powered_by || wl.brand_name,
      supportEmail: wl.support_email || '',
      supportPhone: wl.support_phone || '',
      shopPrice: wl.shop_price || 0,
      monthlyPrice: wl.monthly_price || 0,
      hpTitle: wl.hp_title || '',
      hpSubtitle: wl.hp_subtitle || '',
      hpTagline: wl.hp_tagline || '',
      madeIn: wl.made_in || '',
      social: {
        instagram: wl.social_instagram || '',
        youtube:   wl.social_youtube || '',
        facebook:  wl.social_facebook || ''
      },
      buttons: buttons,
      stats: stats
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Step 1 — reseller register kare (abhi paid=false)
app.post('/api/whitelabel/register', async (req, res) => {
  try {
    const b = req.body || {};
    const brand = String(b.brand_name || '').trim().slice(0, 120);
    const owner = String(b.owner_name || '').trim().slice(0, 120);
    const phone = String(b.phone || '').trim();
    const email = String(b.email || '').trim().slice(0, 160);
    const slug  = cleanSlug(b.slug);

    if (brand.length < 2) return res.status(400).json({ error: 'Brand ka naam daalo' });
    if (!owner) return res.status(400).json({ error: 'Apna naam daalo' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Sahi 10 digit mobile number daalo' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Sahi email daalo' });
    if (slug.length < 3) return res.status(400).json({ error: 'Slug kam se kam 3 akshar ka ho (sirf a-z, 0-9, dash)' });

    const RESERVED = ['www','api','admin','superadmin','app','mail','shop','print','register','agent','wl','whitelabel'];
    if (RESERVED.includes(slug)) return res.status(400).json({ error: 'Ye slug reserved hai, dusra chuno' });

    const dup = await pool.query('SELECT id FROM whitelabels WHERE slug=$1', [slug]);
    if (dup.rows.length) return res.status(400).json({ error: 'Ye slug already liya jaa chuka hai' });

    const wlId = 'WL_' + uuidv4().substring(0, 8).toUpperCase();
    const fee = await getWlLicenseFee();
    const base = await getWlBasePrice();
    // Password abhi random — payment ke baad hi reseller ko dikhaya jaayega
    const tempPass = crypto.randomBytes(16).toString('hex');

    await pool.query(
      `INSERT INTO whitelabels (id, slug, brand_name, owner_name, phone, email, password_hash,
        powered_by, support_email, support_phone, license_fee, base_price, shop_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [wlId, slug, brand, owner, phone, email,
       await hashPassword(tempPass),
       brand, email, phone, fee, base]);

    res.json({ success: true, wlId, slug, licenseFee: fee });
  } catch(err) {
    console.error('WL register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 2 — license fee ka order (ye paisa HAMARE account me aata hai)
app.post('/api/whitelabel/license/create', async (req, res) => {
  try {
    const wlId = String(req.body.wlId || '').trim();
    const r = await pool.query('SELECT id, paid, license_fee FROM whitelabels WHERE id=$1', [wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registration nahi mila' });
    if (r.rows[0].paid) return res.status(400).json({ error: 'License already paid hai' });

    if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'Payment gateway configure nahi hai.' });
    }

    const amount = r.rows[0].license_fee || await getWlLicenseFee();
    const order = await createRazorpayOrder(OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET, {
      amount: amount * 100, currency: 'INR',
      receipt: 'WL_' + wlId, notes: { wlId, type: 'whitelabel_license' }
    });
    if (!order.id) {
      const why = order?.error?.description || 'Razorpay ne order reject kiya';
      console.error('WL license create — Razorpay:', JSON.stringify(order));
      return res.status(400).json({ error: 'Order create nahi hua: ' + why });
    }
    await pool.query('UPDATE whitelabels SET license_order_id=$1 WHERE id=$2', [order.id, wlId]);
    res.json({ success: true, orderId: order.id, amount: amount * 100, keyId: OWNER_RAZORPAY_KEY_ID, wlId });
  } catch(err) {
    console.error('WL license create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 3 — payment verify -> account activate + login credentials
app.post('/api/whitelabel/license/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, wlId } = req.body;
    const expected = crypto.createHmac('sha256', OWNER_RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Payment verification failed' });

    const r = await pool.query('SELECT id, slug, paid FROM whitelabels WHERE id=$1 AND license_order_id=$2',
      [wlId, razorpay_order_id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Order match nahi hua' });

    // Idempotent — dobara verify aaye to naya password mat banao
    if (r.rows[0].paid) return res.json({ success: true, alreadyPaid: true, wlId, slug: r.rows[0].slug });

    const password = Math.random().toString(36).slice(-4).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
    await pool.query(
      `UPDATE whitelabels SET paid=true, paid_at=NOW(), password_hash=$2 WHERE id=$1`,
      [wlId, await hashPassword(password)]);

    console.log(`White label activated: ${wlId} (${r.rows[0].slug})`);
    res.json({ success: true, wlId, slug: r.rows[0].slug, password,
      loginUrl: `${BASE_URL}/wl-admin` });
  } catch(err) {
    console.error('WL license verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reseller login
app.post('/api/whitelabel/login', loginLimiter, async (req, res) => {
  try {
    const wlId = String(req.body.wlId || '').trim().toUpperCase();
    const password = String(req.body.password || '');
    const r = await pool.query('SELECT id, brand_name, paid, blocked, password_hash FROM whitelabels WHERE id=$1', [wlId]);
    if (!r.rows.length) return res.status(401).json({ error: 'ID ya password galat hai' });
    const wl = r.rows[0];
    if (!(await verifyPassword(password, wl.password_hash))) {
      return res.status(401).json({ error: 'ID ya password galat hai' });
    }
    if (!wl.paid) return res.status(403).json({ error: 'License payment abhi complete nahi hua' });
    if (wl.blocked) return res.status(403).json({ error: 'Aapka account abhi paused hai. Admin se baat kariye.' });

    clearLoginHits(req);
    await upgradeHashIfLegacy('whitelabels', 'id', wl.id, wl.password_hash, password);

    const token = jwt.sign({ wlId: wl.id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, brandName: wl.brand_name });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ WHITE LABEL — reseller ka apna panel ══════════════

app.get('/api/whitelabel/me', verifyWhitelabel, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    const wl = r.rows[0];

    const s = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int  AS paid,
              COUNT(*) FILTER (WHERE demo=false AND setup_paid=false)::int AS pending,
              COUNT(*) FILTER (WHERE demo=true)::int                       AS demo,
              COUNT(*)::int                                                AS total
       FROM shops WHERE whitelabel_id=$1`, [req.wlId]);

    const earned = await pool.query(
      `SELECT COALESCE(SUM(setup_amount),0)::int AS total
       FROM shops WHERE whitelabel_id=$1 AND setup_paid=true AND demo=false`, [req.wlId]);

    res.json({
      id: wl.id, slug: wl.slug, brandName: wl.brand_name, ownerName: wl.owner_name,
      phone: wl.phone, email: wl.email, logoUrl: wl.logo_url || '',
      poweredBy: wl.powered_by || '', supportEmail: wl.support_email || '',
      supportPhone: wl.support_phone || '', broadcast: wl.broadcast || '',
      shopPrice: wl.shop_price || 0, basePrice: wl.base_price || 0,
      razorpayKeyId: wl.razorpay_key_id || '',
      razorpayReady: !!(wl.razorpay_key_id && wl.razorpay_key_secret),
      cashfreeAppId: wl.cashfree_app_id || '',
      cashfreeReady: !!(wl.cashfree_app_id && wl.cashfree_secret_key),
      gateway: wl.gateway || 'razorpay',
      // Homepage customization
      hpTitle: wl.hp_title || '', hpSubtitle: wl.hp_subtitle || '',
      hpTagline: wl.hp_tagline || '', madeIn: wl.made_in || '',
      socialInstagram: wl.social_instagram || '',
      socialYoutube: wl.social_youtube || '',
      socialFacebook: wl.social_facebook || '',
      buttons: (function () { try { return wl.hp_buttons ? JSON.parse(wl.hp_buttons) : {}; } catch (e) { return {}; } })(),
      monthlyPrice: wl.monthly_price || 0,
      minMonthlyPrice: WL_MIN_MONTHLY,
      buttonKeys: WL_HP_BUTTON_KEYS,
      notifyEmail: wl.notify_email || '',
      blocked: !!wl.blocked, licenseFee: wl.license_fee || 0, paidAt: wl.paid_at,
      stats: s.rows[0], collected: earned.rows[0].total,
      shareLink: `${BASE_URL}/?wl=${wl.slug}`,
      subdomainLink: `https://${wl.slug}.${(BASE_URL || '').replace(/^https?:\/\//, '')}`
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Branding — powered by, logo, support contact, brand naam
app.put('/api/whitelabel/branding', verifyWhitelabel, async (req, res) => {
  try {
    const b = req.body || {};
    const cut = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null);
    const email = cut(b.support_email, 160);
    if (email && email !== '' && !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Sahi support email daalo' });
    }
    const phone = cut(b.support_phone, 20);
    if (phone && phone !== '' && !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Sahi 10 digit support number daalo' });
    }
    await pool.query(
      `UPDATE whitelabels SET
         brand_name    = COALESCE(NULLIF($2,''), brand_name),
         powered_by    = COALESCE($3, powered_by),
         logo_url      = COALESCE($4, logo_url),
         support_email = COALESCE($5, support_email),
         support_phone = COALESCE($6, support_phone)
       WHERE id=$1`,
      [req.wlId, cut(b.brand_name, 120) || '', cut(b.powered_by, 160), cut(b.logo_url, 400), email, phone]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Partner ka logo — file upload (PNG/JPG, max 40 KB) ──
const WL_LOGO_MAX_KB = 40;
app.post('/api/whitelabel/upload-logo', verifyWhitelabel, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Koi file nahi mili' });

    const mt = req.file.mimetype;
    const isP = (mt === 'image/png')  && isPng(req.file.buffer);
    const isJ = (mt === 'image/jpeg' || mt === 'image/jpg') && isJpeg(req.file.buffer);
    if (!isP && !isJ) {
      return res.status(400).json({ error: 'Sirf PNG ya JPG file chalegi' });
    }
    if (req.file.size > WL_LOGO_MAX_KB * 1024) {
      return res.status(400).json({
        error: `Logo ${WL_LOGO_MAX_KB} KB se chhota hona chahiye (abhi ${Math.round(req.file.size / 1024)} KB hai)`
      });
    }

    const url = await uploadImageToCloudinary(req.file.buffer, isP ? 'image/png' : 'image/jpeg');
    // logo_url VARCHAR(400) hai — Cloudinary URL isme aaram se aa jaata hai
    await pool.query('UPDATE whitelabels SET logo_url=$2 WHERE id=$1', [req.wlId, String(url).slice(0, 400)]);
    res.json({ success: true, logoUrl: url, sizeKb: Math.round(req.file.size / 1024) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/whitelabel/remove-logo', verifyWhitelabel, async (req, res) => {
  try {
    await pool.query("UPDATE whitelabels SET logo_url='' WHERE id=$1", [req.wlId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Homepage customization (title, tagline, socials, buttons on/off, price) ──
app.put('/api/whitelabel/homepage', verifyWhitelabel, async (req, res) => {
  try {
    const b = req.body || {};
    const cut = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null);
    // Link sirf http(s) — javascript: jaisa kuch na ghuse
    const link = (v, n) => {
      const t = cut(v, n);
      if (t === null) return null;
      if (t === '') return '';
      if (!/^https?:\/\//i.test(t)) return null;
      return t;
    };
    const ig = link(b.social_instagram, 300);
    const yt = link(b.social_youtube, 300);
    const fb = link(b.social_facebook, 300);
    if (b.social_instagram && ig === null) return res.status(400).json({ error: 'Instagram link https:// se shuru hona chahiye' });
    if (b.social_youtube   && yt === null) return res.status(400).json({ error: 'YouTube link https:// se shuru hona chahiye' });
    if (b.social_facebook  && fb === null) return res.status(400).json({ error: 'Facebook link https:// se shuru hona chahiye' });

    // Monthly plan ka price — 399 se kam nahi ho sakta
    let monthly = null;
    if (b.monthly_price !== undefined && b.monthly_price !== null && b.monthly_price !== '') {
      monthly = parseInt(b.monthly_price, 10);
      if (isNaN(monthly)) return res.status(400).json({ error: 'Monthly price number me daalo' });
      if (monthly < WL_MIN_MONTHLY) return res.status(400).json({ error: 'Monthly price ' + WL_MIN_MONTHLY + ' se kam nahi ho sakta' });
      if (monthly > 100000) return res.status(400).json({ error: 'Monthly price bahut zyada hai' });
    }

    // Buttons on/off — sirf allowed keys, sirf true/false
    let btnJson = null;
    if (b.buttons && typeof b.buttons === 'object') {
      const clean = {};
      WL_HP_BUTTON_KEYS.forEach(function (k) {
        if (b.buttons[k] !== undefined) clean[k] = !!b.buttons[k];
      });
      btnJson = JSON.stringify(clean);
    }

    await pool.query(
      `UPDATE whitelabels SET
         hp_title          = COALESCE($2, hp_title),
         hp_subtitle       = COALESCE($3, hp_subtitle),
         hp_tagline        = COALESCE($4, hp_tagline),
         made_in           = COALESCE($5, made_in),
         social_instagram  = COALESCE($6, social_instagram),
         social_youtube    = COALESCE($7, social_youtube),
         social_facebook   = COALESCE($8, social_facebook),
         hp_buttons        = COALESCE($9, hp_buttons),
         monthly_price     = COALESCE($10, monthly_price)
       WHERE id=$1`,
      [req.wlId, cut(b.hp_title, 160), cut(b.hp_subtitle, 200), cut(b.hp_tagline, 200),
       cut(b.made_in, 120), ig, yt, fb, btnJson, monthly]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Apna Cashfree (Razorpay ka doosra option) ──
app.put('/api/whitelabel/cashfree', verifyWhitelabel, async (req, res) => {
  try {
    const appId  = String(req.body.cashfree_app_id || '').trim().slice(0, 120);
    const secret = String(req.body.cashfree_secret_key || '').trim().slice(0, 200);
    if (appId && !secret) return res.status(400).json({ error: 'Secret key bhi daalo' });
    if (secret && !appId) return res.status(400).json({ error: 'App ID bhi daalo' });
    await pool.query(
      'UPDATE whitelabels SET cashfree_app_id=$2, cashfree_secret_key=$3 WHERE id=$1',
      [req.wlId, appId, secret]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Kaunsa gateway use karna hai (razorpay / cashfree) ──
app.put('/api/whitelabel/gateway', verifyWhitelabel, async (req, res) => {
  try {
    const g = String(req.body.gateway || '').trim().toLowerCase();
    if (g !== 'razorpay' && g !== 'cashfree') {
      return res.status(400).json({ error: 'Gateway razorpay ya cashfree hi ho sakta hai' });
    }
    const me = await pool.query(
      'SELECT razorpay_key_id, cashfree_app_id FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    if (g === 'razorpay' && !me.rows[0].razorpay_key_id) {
      return res.status(400).json({ error: 'Pehle Razorpay keys save karo' });
    }
    if (g === 'cashfree' && !me.rows[0].cashfree_app_id) {
      return res.status(400).json({ error: 'Pehle Cashfree keys save karo' });
    }
    await pool.query('UPDATE whitelabels SET gateway=$2 WHERE id=$1', [req.wlId, g]);
    res.json({ success: true, gateway: g });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Demo account — ab sirf partner apne login se bana sakta hai ──
app.post('/api/whitelabel/demo/create', verifyWhitelabel, async (req, res) => {
  try {
    const me = await pool.query('SELECT blocked FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    if (me.rows[0].blocked) return res.status(403).json({ error: 'Aapka account abhi paused hai' });

    const cfg = await getDemoConfig();
    const name = String(req.body.name || '').trim().slice(0, 100);
    const phone = normPhone(req.body.phone);
    if (!name)  return res.status(400).json({ error: 'Naam daalo' });
    if (!phone) return res.status(400).json({ error: 'Sahi 10-digit mobile number daalo' });

    const dupShop = await pool.query('SELECT id FROM shops WHERE phone=$1 AND demo=true', [phone]);
    if (dupShop.rows.length) {
      return res.status(400).json({ error: 'Is number par demo pehle se hai' });
    }

    const minutes = Math.min(43200, Math.max(10, parseInt(req.body.minutes, 10) || cfg.minutes || 60));
    const shopId = 'DEMO_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const passwordHash = await hashPassword(phone);
    await pool.query(
      `INSERT INTO shops (id, name, phone, price_bw, price_color, payment_mode, password_hash,
                          setup_paid, setup_amount, demo, demo_expires_at, advanced_unlocked, whitelabel_id)
       VALUES ($1,$2,$3,5,10,'counter_only',$4,true,0,true,NOW() + ($5 || ' minutes')::INTERVAL,true,$6)`,
      [shopId, name + ' (Demo)', phone, passwordHash, String(minutes), req.wlId]);

    const qrUrl = `${BASE_URL}/print/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
    await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);

    console.log(`[WL demo] ${shopId} | wl=${req.wlId} | ${phone} | ${minutes}min`);
    res.json({ success: true, shopId, password: phone, qrUrl, qrCode,
               expiresInMinutes: minutes, note: 'Login password = shop ka mobile number' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apna Razorpay — shops ka setup fee SEEDHA yahan aayega
app.put('/api/whitelabel/razorpay', verifyWhitelabel, async (req, res) => {
  try {
    const keyId = String(req.body.razorpay_key_id || '').trim().slice(0, 120);
    const secret = String(req.body.razorpay_key_secret || '').trim().slice(0, 200);
    if (!keyId || !secret) return res.status(400).json({ error: 'Key ID aur Secret dono daalo' });
    if (!/^rzp_/i.test(keyId)) return res.status(400).json({ error: 'Key ID rzp_ se shuru honi chahiye' });
    await pool.query('UPDATE whitelabels SET razorpay_key_id=$2, razorpay_key_secret=$3 WHERE id=$1',
      [req.wlId, keyId, secret]);
    res.json({ success: true, razorpayReady: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Shop registration ka price — base se neeche nahi
app.put('/api/whitelabel/price', verifyWhitelabel, async (req, res) => {
  try {
    const r = await pool.query('SELECT base_price, blocked FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    if (r.rows[0].blocked) return res.status(403).json({ error: 'Account paused hai' });

    const base = r.rows[0].base_price || await getWlBasePrice();
    const p = parseInt(req.body.price, 10);
    if (!Number.isInteger(p)) return res.status(400).json({ error: 'Sahi price daalo' });
    if (p < base) return res.status(400).json({ error: `Price \u20b9${base} se kam nahi ho sakta` });
    if (p > 9999) return res.status(400).json({ error: 'Price \u20b99999 se zyada nahi ho sakta' });

    await pool.query('UPDATE whitelabels SET shop_price=$2 WHERE id=$1', [req.wlId, p]);
    res.json({ success: true, price: p, base });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Broadcast — sirf ISKI shops ko dikhega
app.put('/api/whitelabel/broadcast', verifyWhitelabel, async (req, res) => {
  try {
    const msg = String(req.body.message || '').slice(0, 1000);
    await pool.query('UPDATE whitelabels SET broadcast=$2 WHERE id=$1', [req.wlId, msg]);
    res.json({ success: true, message: msg });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Meri shops
app.get('/api/whitelabel/shops', verifyWhitelabel, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, phone, address, created_at, setup_paid, demo, demo_expires_at,
              plan_type, setup_amount, agent_last_seen, paused
       FROM shops WHERE whitelabel_id=$1 ORDER BY created_at DESC LIMIT 500`, [req.wlId]);
    res.json({ shops: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ SUPERADMIN: WHITE LABELS ══════════════
app.get('/api/superadmin/whitelabels', verifySuperAdmin, async (req, res) => {
  try {
    const wls = await pool.query('SELECT * FROM whitelabels ORDER BY created_at DESC');
    const out = [];
    for (const w of wls.rows) {
      const s = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int  AS paid,
                COUNT(*) FILTER (WHERE demo=false AND setup_paid=false)::int AS pending,
                COUNT(*) FILTER (WHERE demo=true)::int                       AS demo,
                COUNT(*)::int                                                AS total,
                COALESCE(SUM(setup_amount) FILTER (WHERE setup_paid=true AND demo=false),0)::int AS collected
         FROM shops WHERE whitelabel_id=$1`, [w.id]);
      out.push({
        id: w.id, slug: w.slug, brandName: w.brand_name, ownerName: w.owner_name,
        phone: w.phone, email: w.email, paid: !!w.paid, blocked: !!w.blocked,
        licenseFee: w.license_fee || 0, basePrice: w.base_price || 0, shopPrice: w.shop_price || 0,
        razorpayReady: !!(w.razorpay_key_id && w.razorpay_key_secret),
        poweredBy: w.powered_by || '', createdAt: w.created_at, paidAt: w.paid_at,
        stats: s.rows[0]
      });
    }
    res.json({
      whitelabels: out,
      licenseFee: await getWlLicenseFee(),
      licenseActual: await getWlLicenseActual(),
      defaultBasePrice: await getWlBasePrice()
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Block/unblock + is reseller ka apna base price
app.put('/api/superadmin/whitelabel/:id', verifySuperAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const chk = await pool.query('SELECT id, shop_price FROM whitelabels WHERE id=$1', [req.params.id]);
    if (!chk.rows.length) return res.status(404).json({ error: 'White label nahi mila' });

    if (b.blocked !== undefined) {
      await pool.query('UPDATE whitelabels SET blocked=$2 WHERE id=$1', [req.params.id, !!b.blocked]);
    }
    if (b.base_price !== undefined && b.base_price !== '') {
      const bp = parseInt(b.base_price, 10);
      if (isNaN(bp) || bp < 0) return res.status(400).json({ error: 'Valid base price daalo' });
      await pool.query('UPDATE whitelabels SET base_price=$2 WHERE id=$1', [req.params.id, bp]);
      // Reseller ka price base se neeche reh gaya ho to usko bhi upar utha do
      if (chk.rows[0].shop_price < bp) {
        await pool.query('UPDATE whitelabels SET shop_price=$2 WHERE id=$1', [req.params.id, bp]);
      }
    }
    const out = await pool.query('SELECT blocked, base_price, shop_price FROM whitelabels WHERE id=$1', [req.params.id]);
    res.json({ success: true, ...out.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════ WHITE LABEL — apni shops par control ══════════
// SABSE ZAROORI: har action se pehle confirm karo ki shop ISI partner ki hai.
// Warna ek partner doosre ki (ya hamari) shops chhu sakta hai.
async function assertWlShop(wlId, shopId) {
  const r = await pool.query(
    'SELECT id, name, setup_paid, setup_amount, demo, whitelabel_id FROM shops WHERE id=$1', [shopId]);
  if (!r.rows.length) return { err: 'Shop nahi mila' };
  if ((r.rows[0].whitelabel_id || '') !== wlId) return { err: 'Ye shop aapki nahi hai' };
  return { shop: r.rows[0] };
}

// Partner apna password badle
app.put('/api/whitelabel/password', verifyWhitelabel, async (req, res) => {
  try {
    const oldPass = String(req.body.old_password || '');
    const newPass = String(req.body.new_password || '');
    if (newPass.length < 6) return res.status(400).json({ error: 'Naya password kam se kam 6 akshar ka ho' });

    const r = await pool.query('SELECT password_hash FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    if (!(await verifyPassword(oldPass, r.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Purana password galat hai' });
    }
    await pool.query('UPDATE whitelabels SET password_hash=$2 WHERE id=$1',
      [req.wlId, crypto.createHash('sha256').update(newPass).digest('hex')]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Partner khud shop onboard kare (Shop ID + password turant)
app.post('/api/whitelabel/onboard', verifyWhitelabel, async (req, res) => {
  try {
    const me = await pool.query(
      `SELECT blocked, shop_price, base_price, razorpay_key_id, cashfree_app_id, gateway
         FROM whitelabels WHERE id=$1`, [req.wlId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    if (me.rows[0].blocked) return res.status(403).json({ error: 'Aapka account abhi paused hai' });
    // Razorpay YA Cashfree — koi ek set hona chahiye
    if (!me.rows[0].razorpay_key_id && !me.rows[0].cashfree_app_id) {
      return res.status(400).json({ error: 'Pehle apna Razorpay ya Cashfree set karo — warna shop payment nahi kar payegi' });
    }

    const name = String(req.body.name || '').trim().slice(0, 200);
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim().slice(0, 300);
    const printerModel = String(req.body.printer_model || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Shop ka naam zaroori hai' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Sahi 10 digit mobile number daalo' });

    const wlBase = me.rows[0].base_price || await getWlBasePrice();
    const sold = (me.rows[0].shop_price && me.rows[0].shop_price > wlBase) ? me.rows[0].shop_price : wlBase;

    const priceBw = parseInt(req.body.price_bw, 10);
    const priceColor = parseInt(req.body.price_color, 10);
    const shopId = 'SHOP_' + uuidv4().substring(0, 8).toUpperCase();
    let password = String(req.body.password || '').trim();
    if (password.length < 4) {
      password = Math.random().toString(36).slice(-4).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
    }

    await pool.query(
      `INSERT INTO shops (id,name,address,phone,printer_model,price_bw,price_color,payment_mode,
         password_hash,setup_paid,setup_amount,plan_type,base_price_at_signup,sold_price,whitelabel_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'counter_only',$8,false,$9,'onetime',$10,$9,$11)`,
      [shopId, name, address, phone, printerModel,
       Number.isInteger(priceBw) && priceBw > 0 ? priceBw : 5,
       Number.isInteger(priceColor) && priceColor > 0 ? priceColor : 10,
       await hashPassword(password),
       sold, wlBase, req.wlId]);

    res.json({ success: true, shopId, password, amount: sold,
      pay_url: `${BASE_URL}/setup-payment/${shopId}` });
  } catch(err) {
    console.error('WL onboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Shop ka password reset
app.post('/api/whitelabel/shop/:shopId/reset-password', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    const temp = 'QSP' + crypto.randomBytes(3).toString('hex');
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2',
      [await hashPassword(temp), req.params.shopId]);
    console.log(`WL ${req.wlId} reset password for ${req.params.shopId}`);
    res.json({ success: true, tempPassword: temp });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Manual activate — partner ne cash le liya (paisa uska hai, risk bhi uska)
app.post('/api/whitelabel/shop/:shopId/activate', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    if (chk.shop.setup_paid) return res.status(400).json({ error: 'Shop pehle se active hai' });
    const ref = String(req.body.payment_ref || '').trim().slice(0, 60);
    if (!ref) return res.status(400).json({ error: 'Payment reference daalo (cash ho to "CASH" likh do)' });
    const { qrUrl } = await activateShop(req.params.shopId, 'WLMANUAL_' + ref);
    console.log(`WL manual activation: ${req.params.shopId} by ${req.wlId} | ref: ${ref}`);
    res.json({ success: true, qrUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Pending shop delete — paid shop kabhi nahi
app.delete('/api/whitelabel/shop/:shopId', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    if (chk.shop.setup_paid) return res.status(403).json({ error: 'Paid shop delete nahi ho sakti' });
    await pool.query('DELETE FROM print_jobs WHERE shop_id=$1', [req.params.shopId]);
    await pool.query('DELETE FROM shops WHERE id=$1', [req.params.shopId]);
    console.log(`WL ${req.wlId} deleted pending shop ${req.params.shopId}`);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Shop ke PC ka printer list + selection
app.get('/api/whitelabel/shop/:shopId/printers', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    const s = await pool.query(
      `SELECT id, name, agent_last_seen, printer_name_bw, printer_name_color,
              printer_name_4x6, printer_name_a3
       FROM shops WHERE id=$1`, [req.params.shopId]);
    const p = await pool.query('SELECT value, updated_at FROM system_settings WHERE key=$1',
      [`printers_${req.params.shopId}`]);
    let available = [];
    if (p.rows.length) { try { available = JSON.parse(p.rows[0].value) || []; } catch(e) { available = []; } }
    res.json({ shop: s.rows[0], available: Array.isArray(available) ? available : [],
      reported_at: p.rows.length ? p.rows[0].updated_at : null });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/whitelabel/shop/:shopId/printers', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    const clean = v => (typeof v === 'string' ? v.trim().slice(0, 300) : null);
    await pool.query(
      `UPDATE shops SET
         printer_name_bw    = COALESCE($2, printer_name_bw),
         printer_name_color = COALESCE($3, printer_name_color),
         printer_name_4x6   = COALESCE($4, printer_name_4x6),
         printer_name_a3    = COALESCE($5, printer_name_a3)
       WHERE id=$1`,
      [req.params.shopId, clean(req.body.printer_name_bw), clean(req.body.printer_name_color),
       clean(req.body.printer_name_4x6), clean(req.body.printer_name_a3)]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Partner ke apne link ka analytics
app.get('/api/whitelabel/analytics', verifyWhitelabel, async (req, res) => {
  try {
    // Superadmin wale analytics jaisa — chhote range ghante-war, bade din-war
    const RANGE_MAP = {
      '1h':  { amount: 1,  unit: 'hours', bucket: 'hour' },
      '12h': { amount: 12, unit: 'hours', bucket: 'hour' },
      '1d':  { amount: 24, unit: 'hours', bucket: 'hour' },
      '7d':  { amount: 7,  unit: 'days',  bucket: 'day'  },
      '14d': { amount: 14, unit: 'days',  bucket: 'day'  },
      '30d': { amount: 30, unit: 'days',  bucket: 'day'  },
      '90d': { amount: 90, unit: 'days',  bucket: 'day'  }
    };
    let rangeKey = String(req.query.range || '');
    if (!RANGE_MAP[rangeKey]) {
      const legacyDays = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
      rangeKey = [7, 14, 30, 90].includes(legacyDays) ? legacyDays + 'd' : '30d';
    }
    const cfg = RANGE_MAP[rangeKey];
    const intervalStr = `${cfg.amount} ${cfg.unit}`;
    const isHourly = cfg.bucket === 'hour';
    const days = cfg.unit === 'days' ? cfg.amount : 0;
    const bucketExpr = isHourly
      ? `TO_CHAR(created_at + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD"T"HH24:00')`
      : `TO_CHAR(created_at, 'YYYY-MM-DD')`;

    const me = await pool.query('SELECT slug FROM whitelabels WHERE id=$1', [req.wlId]);
    const slug = me.rows[0]?.slug || '';

    const totals = await pool.query(
      `SELECT event_type, COUNT(*)::int AS cnt, COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events
       WHERE wl=$1 AND created_at > NOW() - ($2)::interval
       GROUP BY event_type`, [slug, intervalStr]);

    const daily = await pool.query(
      `SELECT ${bucketExpr} AS day, COUNT(*)::int AS cnt,
              COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events
       WHERE wl=$1 AND event_type='pageview' AND created_at > NOW() - ($2)::interval
       GROUP BY 1 ORDER BY 1 ASC`, [slug, intervalStr]);

    const topPaths = await pool.query(
      `SELECT COALESCE(NULLIF(path,''),'/') AS path, COUNT(*)::int AS cnt
       FROM analytics_events
       WHERE wl=$1 AND event_type='pageview' AND created_at > NOW() - ($2)::interval
       GROUP BY 1 ORDER BY cnt DESC LIMIT 10`, [slug, intervalStr]);

    const topRefs = await pool.query(
      `SELECT COALESCE(NULLIF(ref,''),'direct') AS ref, COUNT(*)::int AS cnt
       FROM analytics_events
       WHERE wl=$1 AND event_type='pageview' AND created_at > NOW() - ($2)::interval
       GROUP BY 1 ORDER BY cnt DESC LIMIT 10`, [slug, intervalStr]);

    const topSources = await pool.query(
      `SELECT COALESCE(NULLIF(utm_source,''),'(none)') AS source, COUNT(*)::int AS cnt
       FROM analytics_events
       WHERE wl=$1 AND created_at > NOW() - ($2)::interval
       GROUP BY 1 ORDER BY cnt DESC LIMIT 10`, [slug, intervalStr]);

    const shopsDaily = await pool.query(
      `SELECT ${bucketExpr} AS day,
              COUNT(*) FILTER (WHERE setup_paid=true AND COALESCE(demo,false)=false)::int AS paid,
              COUNT(*) FILTER (WHERE COALESCE(demo,false)=true)::int                     AS demo
       FROM shops WHERE whitelabel_id=$1 AND created_at > NOW() - ($2)::interval
       GROUP BY 1 ORDER BY 1 ASC`, [req.wlId, intervalStr]);

    // Business summary — shops, prints, kamai
    const summary = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM shops
           WHERE whitelabel_id=$1 AND COALESCE(demo,false)=false) AS shops_total,
         (SELECT COUNT(*)::int FROM shops
           WHERE whitelabel_id=$1 AND COALESCE(demo,false)=false
             AND created_at > NOW() - ($2)::interval) AS shops_new,
         (SELECT COUNT(*)::int FROM shops
           WHERE whitelabel_id=$1 AND COALESCE(demo,false)=true) AS demo_total,
         (SELECT COALESCE(SUM(setup_amount),0)::int FROM shops
           WHERE whitelabel_id=$1 AND setup_paid=true AND COALESCE(demo,false)=false) AS earned_total,
         (SELECT COUNT(*)::int FROM print_jobs j JOIN shops s ON s.id=j.shop_id
           WHERE s.whitelabel_id=$1) AS prints_total,
         (SELECT COUNT(*)::int FROM print_jobs j JOIN shops s ON s.id=j.shop_id
           WHERE s.whitelabel_id=$1 AND j.created_at > NOW() - ($2)::interval) AS prints_range`,
      [req.wlId, intervalStr]);

    res.json({
      slug, range: rangeKey, days, bucket: cfg.bucket,
      totals: totals.rows, daily: daily.rows, shopsDaily: shopsDaily.rows,
      topPaths: topPaths.rows, topRefs: topRefs.rows, topSources: topSources.rows,
      summary: summary.rows[0]
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ REVIEWS ══════════════
// Public — homepage in par dikhata hai
app.get('/api/reviews', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, stars, text,
              COALESCE(NULLIF(state,''), city) AS city
       FROM reviews
       WHERE active=true AND status='approved'
       ORDER BY sort_order ASC, created_at DESC LIMIT 50`);
    const avg = await pool.query(
      "SELECT COALESCE(AVG(stars),0)::numeric(3,1) AS avg, COUNT(*)::int AS total FROM reviews WHERE active=true AND status='approved'");
    res.json({ reviews: r.rows, average: parseFloat(avg.rows[0].avg) || 0, total: avg.rows[0].total });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Shop apna review bhejta hai — seedha live nahi hota, pehle superadmin
// approve karega. Ek shop ka ek hi review: dobara bhejne par purana update
// ho jaata hai aur wapas pending me chala jaata hai.
app.post('/api/shop/review', verifyToken, async (req, res) => {
  try {
    const name  = String(req.body.name  || '').trim().slice(0, 120);
    const state = String(req.body.state || '').trim().slice(0, 80);
    const text  = String(req.body.text  || '').trim().slice(0, 1200);
    let stars   = parseInt(req.body.stars, 10);
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) stars = 5;

    if (!name)  return res.status(400).json({ error: 'Naam daalo' });
    if (!state) return res.status(400).json({ error: 'State daalo' });
    if (text.length < 10) return res.status(400).json({ error: 'Review kam se kam 10 character ka likho' });

    const existing = await pool.query('SELECT id FROM reviews WHERE shop_id=$1', [req.shopId]);

    let r;
    if (existing.rows.length) {
      r = await pool.query(
        `UPDATE reviews SET name=$1, state=$2, text=$3, stars=$4,
                status='pending', edited=false, created_at=NOW()
         WHERE shop_id=$5 RETURNING id, status`,
        [name, state, text, stars, req.shopId]);
    } else {
      r = await pool.query(
        `INSERT INTO reviews (name, stars, text, state, shop_id, status, active, sort_order)
         VALUES ($1,$2,$3,$4,$5,'pending',true,
                 COALESCE((SELECT MAX(sort_order)+1 FROM reviews),0))
         RETURNING id, status`,
        [name, stars, text, state, req.shopId]);
    }
    res.json({ success: true, review: r.rows[0],
               message: 'Review bhej diya. Approve hone par homepage par dikhega.' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Shop apna bheja hua review aur uski halat dekh sake
app.get('/api/shop/review', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, state, stars, text, status, edited, created_at
       FROM reviews WHERE shop_id=$1`, [req.shopId]);
    res.json({ review: r.rows[0] || null });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/reviews', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM reviews ORDER BY sort_order ASC, created_at DESC');
    res.json({ reviews: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/reviews', verifySuperAdmin, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 120);
    const text = String(req.body.text || '').trim().slice(0, 1000);
    const city = String(req.body.city || '').trim().slice(0, 120);
    let stars = parseInt(req.body.stars, 10);
    if (!name) return res.status(400).json({ error: 'Naam daalo' });
    if (!text) return res.status(400).json({ error: 'Review likho' });
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) stars = 5;
    const r = await pool.query(
      `INSERT INTO reviews (name, stars, text, city, sort_order)
       VALUES ($1,$2,$3,$4,COALESCE((SELECT MAX(sort_order)+1 FROM reviews),0)) RETURNING *`,
      [name, stars, text, city]);
    res.json({ success: true, review: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/reviews/:id', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Galat id' });
    const b = req.body || {};
    let stars = parseInt(b.stars, 10);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) stars = null;
    const r = await pool.query(
      `UPDATE reviews SET
         name   = COALESCE(NULLIF($2,''), name),
         text   = COALESCE(NULLIF($3,''), text),
         city   = COALESCE($4, city),
         stars  = COALESCE($5, stars),
         active = COALESCE($6, active),
         sort_order = COALESCE($7, sort_order)
       WHERE id=$1 RETURNING *`,
      [id,
       typeof b.name === 'string' ? b.name.trim().slice(0,120) : '',
       typeof b.text === 'string' ? b.text.trim().slice(0,1000) : '',
       typeof b.city === 'string' ? b.city.trim().slice(0,120) : null,
       stars,
       typeof b.active === 'boolean' ? b.active : null,
       Number.isInteger(parseInt(b.sort_order,10)) ? parseInt(b.sort_order,10) : null]);
    if (!r.rows.length) return res.status(404).json({ error: 'Review nahi mila' });
    res.json({ success: true, review: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Approve — bina badle, ya edit ke saath. Jo fields bheje jaate hain
// sirf wahi badalte hain, baaki waise ke waise rehte hain.
app.post('/api/superadmin/reviews/:id/approve', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Galat id' });

    const cur = await pool.query('SELECT * FROM reviews WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Review nahi mila' });
    const c = cur.rows[0];

    const has = k => Object.prototype.hasOwnProperty.call(req.body, k);
    const name  = has('name')  ? String(req.body.name  || '').trim().slice(0,120) : c.name;
    const state = has('state') ? String(req.body.state || '').trim().slice(0,80)  : c.state;
    const text  = has('text')  ? String(req.body.text  || '').trim().slice(0,1200): c.text;
    let stars = c.stars;
    if (has('stars')) {
      const v = parseInt(req.body.stars, 10);
      if (Number.isFinite(v) && v >= 1 && v <= 5) stars = v;
    }
    if (!name) return res.status(400).json({ error: 'Naam khaali nahi ho sakta' });
    if (!text) return res.status(400).json({ error: 'Review khaali nahi ho sakta' });

    const changed = (name !== c.name) || (state !== (c.state||'')) ||
                    (text !== c.text) || (stars !== c.stars);

    const r = await pool.query(
      `UPDATE reviews SET name=$1, state=$2, text=$3, stars=$4,
              status='approved', active=true, edited=$5
       WHERE id=$6 RETURNING *`,
      [name, state, text, stars, changed || c.edited, id]);
    res.json({ success: true, review: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Wapas pending me bhejo (galti se approve ho gaya to)
app.post('/api/superadmin/reviews/:id/unapprove', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Galat id' });
    const r = await pool.query(
      "UPDATE reviews SET status='pending' WHERE id=$1 RETURNING *", [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Review nahi mila' });
    res.json({ success: true, review: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/superadmin/reviews/:id', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Galat id' });
    await pool.query('DELETE FROM reviews WHERE id=$1', [id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// ALERTS — naya shop aane par EMAIL
//
// SMTP sirf EK BAAR superadmin set karta hai (Gmail app password se
// 2 minute me ho jaata hai — free hai). Uske baad:
//   normal shop      -> superadmin ke email par
//   white-label shop -> us PARTNER ke email par
// Partner ko koi SMTP setup nahi karna — wo bas apna email daalta hai.
//
// Poori tarah "fire and forget" — email fail ho to bhi registration ya
// payment kabhi nahi rukega.
// ══════════════════════════════════════════════════════════════
let _mailer = null, _mailerAt = 0;

async function getMailer() {
  // 5 min cache — har mail par DB hit na ho
  if (_mailer && (Date.now() - _mailerAt) < 5 * 60 * 1000) return _mailer;
  const r = await pool.query(
    "SELECT key,value FROM system_settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass')");
  const m = {}; r.rows.forEach(x => { m[x.key] = x.value; });
  if (!m.smtp_host || !m.smtp_user || !m.smtp_pass) return null;
  const port = parseInt(m.smtp_port, 10) || 587;
  _mailer = nodemailer.createTransport({
    host: m.smtp_host, port,
    secure: port === 465,               // 465 = SSL, 587 = STARTTLS
    auth: { user: m.smtp_user, pass: m.smtp_pass }
  });
  _mailer._fromAddr = m.smtp_user;
  _mailerAt = Date.now();
  return _mailer;
}

// Brevo ka HTTPS API — SMTP ki tarah block nahi hota
function sendViaBrevo(apiKey, senderEmail, senderName, to, subject, text, html) {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({
        sender: { name: senderName || 'QR Se Print', email: senderEmail },
        to: [{ email: to }],
        subject, textContent: text, htmlContent: html
      });
      const req = https.request({
        hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          'accept': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (resp) => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => {
          let j = {}; try { j = JSON.parse(d); } catch (e) {}
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            resolve({ ok: true, messageId: j.messageId || '', response: 'Brevo ' + resp.statusCode + ' OK' });
          } else {
            resolve({ ok: false, why: (j && (j.message || j.code)) || ('Brevo ' + resp.statusCode) });
          }
        });
      });
      req.on('error', e => resolve({ ok: false, why: e.message }));
      req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, why: 'Brevo timeout' }); });
      req.write(payload); req.end();
    } catch (e) { resolve({ ok: false, why: e.message }); }
  });
}

// htmlOverride: designed mail (jaise payment confirmation) ke liye. Na do to
// pehle jaisa hi <pre> wala plain look — purane saare alert waise ke waise.
async function sendEmailAlert(to, subject, body, fromName, htmlOverride) {
  try {
    if (!to) return { ok: false, why: 'email set nahi hai' };

    const html = htmlOverride ||
      ('<pre style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.7;white-space:pre-wrap;margin:0;">'
      + String(body).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>');

    // 1) Brevo (HTTPS) — Render par yahi chalta hai
    const bc = await pool.query(
      "SELECT key,value FROM system_settings WHERE key IN ('brevo_api_key','brevo_sender')");
    const bm = {}; bc.rows.forEach(r => { bm[r.key] = r.value; });
    if (bm.brevo_api_key && bm.brevo_sender) {
      const r = await sendViaBrevo(bm.brevo_api_key, bm.brevo_sender, fromName, to, subject, body, html);
      if (r.ok) return { ok: true, from: bm.brevo_sender, via: 'Brevo', messageId: r.messageId, response: r.response, accepted: [to], rejected: [] };
      return { ok: false, why: r.why, via: 'Brevo' };
    }

    // 2) SMTP — sirf tab jab host block na kare
    const t = await getMailer();
    if (!t) return { ok: false, why: 'Email setup nahi hai — Brevo API key daalo (ya SMTP)' };
    const info = await t.sendMail({
      from: `"${(fromName || 'QR Se Print').replace(/"/g, '')}" <${t._fromAddr}>`,
      to, subject, text: body, html
    });
    // SMTP ne kya jawab diya — yahi asli proof hai ki mail accept hui
    return {
      ok: true, via: 'SMTP',
      from: t._fromAddr,
      messageId: info && info.messageId,
      response: info && info.response,
      accepted: (info && info.accepted) || [],
      rejected: (info && info.rejected) || []
    };
  } catch (e) {
    _mailer = null;                     // agli baar naya transport banega
    return { ok: false, why: e.message };
  }
}

// Kis ko bhejna hai wo khud dhoondh leta hai:
// white-label ki shop -> us PARTNER ko, warna hamein.
async function alertNewShop(shopId, kind) {
  try {
    const s = await pool.query(
      'SELECT id,name,phone,address,setup_amount,whitelabel_id,demo FROM shops WHERE id=$1', [shopId]);
    if (!s.rows.length) return;
    const shop = s.rows[0];
    if (shop.demo) return;   // demo par alert nahi — bahut zyada ho jaayenge

    let to = '', brand = 'QR Se Print';
    if (shop.whitelabel_id) {
      const w = await pool.query(
        'SELECT brand_name, notify_email, email FROM whitelabels WHERE id=$1', [shop.whitelabel_id]);
      if (!w.rows.length) return;
      brand = w.rows[0].brand_name || brand;
      to = w.rows[0].notify_email || w.rows[0].email || '';   // alert email na ho to login wala
    } else {
      const c = await pool.query("SELECT value FROM system_settings WHERE key='notify_email'");
      to = c.rows[0]?.value || '';
    }
    if (!to) return;   // set nahi hai — chup rehna

    const head = kind === 'paid' ? '💰 PAYMENT AAYA' : '🆕 NAYI SHOP REGISTER HUI';
    const body =
      `${head}\n\n` +
      `🏪 Shop     : ${shop.name || '-'}\n` +
      `📱 Mobile   : ${shop.phone || '-'}\n` +
      (shop.address ? `📍 Address  : ${shop.address}\n` : '') +
      `🆔 Shop ID  : ${shop.id}\n` +
      `💵 Amount   : ₹${shop.setup_amount || 0}\n\n` +
      (kind === 'paid'
        ? `✅ Shop active ho gayi hai.`
        : `⏳ Payment abhi baaki hai — follow-up kar lena.`) +
      `\n\n— ${brand}`;

    const subject = `${kind === 'paid' ? '💰 Payment aaya' : '🆕 Nayi shop'}: ${shop.name || shop.id}`;
    const r = await sendEmailAlert(to, subject, body, brand);
    console.log(`Alert (${kind}) ${shopId} -> ${to}: ${r.ok ? 'sent' : 'FAIL ' + r.why}`);
  } catch (e) {
    console.error('alertNewShop error:', e.message);   // kabhi throw nahi karega
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SHOP KO PAYMENT CONFIRMATION EMAIL
//  Payment confirm hone par shop owner ko jaata hai (aapke alert se alag).
//  White-label ki shop ko PARTNER ke brand aur PARTNER ke support se.
// ═══════════════════════════════════════════════════════════════════

// Render UTC me chalta hai — isliye har date zabardasti IST me
function fmtIST(d) {
  if (!d) return '-';
  try {
    return new Date(d).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long',
      year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    }).replace(/\u202f/g, ' ');   // kuch Node build me narrow-space aata hai
  } catch (e) { return String(d); }
}

// Wahi regex jo baaki server me pehle se chal raha hai — behaviour ek jaisa rahe
function isValidEmail(e) {
  return /^\S+@\S+\.\S+$/.test(String(e || '').trim());
}

// Shop ka naam customer ka diya hua hai — HTML me daalne se pehle escape ZAROORI
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildShopPaymentEmailHtml(d) {
  const ink = '#12181F', paper = '#FFFFFF', rule = '#DDDFD8',
        muted = '#6B7280', green = '#1B7A4B', pageBg = '#ECEDE8',
        mono = "'DejaVu Sans Mono','Courier New',monospace",
        sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

  // Receipt jaisi perforated line — yahi is mail ki pehchaan hai
  const perf = '<tr><td style="padding:0 28px"><div style="border-top:2px dashed ' + rule +
    ';height:1px;line-height:1px;font-size:1px">&nbsp;</div></td></tr>';

  const row = (label, value, isMono, isBig) =>
    '<tr>' +
    '<td style="padding:9px 0;font-family:' + sans + ';font-size:13px;color:' + muted +
      ';white-space:nowrap;vertical-align:top">' + label + '</td>' +
    '<td style="padding:9px 0;text-align:right;font-family:' + (isMono ? mono : sans) +
      ';font-size:' + (isBig ? '19px' : '14px') + ';font-weight:' + (isBig ? '700' : '600') +
      ';color:' + ink + '">' + value + '</td>' +
    '</tr>';

  const sectionTitle = t =>
    '<tr><td style="padding:22px 28px 4px;font-family:' + sans + ';font-size:11px;font-weight:700;' +
    'letter-spacing:.11em;text-transform:uppercase;color:' + muted + '">' + t + '</td></tr>';

  const waDigits = String(d.supportPhone || '').replace(/[^0-9]/g, '').slice(-10);

  return '' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + pageBg + ';margin:0;padding:22px 12px">' +
'<tr><td align="center">' +
  '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:' + paper + ';border-radius:10px;overflow:hidden;border:1px solid ' + rule + '">' +

    '<tr><td style="padding:26px 28px 20px;border-bottom:1px solid ' + rule + '">' +
      '<span style="font-family:' + sans + ';font-size:17px;font-weight:700;color:' + ink + '">' + esc(d.brand) + '</span>' +
    '</td></tr>' +

    '<tr><td style="padding:28px 28px 0">' +
      '<span style="display:inline-block;font-family:' + sans + ';font-size:11px;font-weight:700;letter-spacing:.11em;' +
        'text-transform:uppercase;color:' + green + ';border:2px solid ' + green + ';border-radius:4px;padding:5px 11px">Payment received</span>' +
      '<div style="font-family:' + sans + ';font-size:23px;font-weight:700;line-height:1.3;color:' + ink + ';margin:16px 0 8px">' +
        'Shukriya, ' + esc(d.shopName) + ' &mdash; aapki shop ab active hai.</div>' +
      '<div style="font-family:' + sans + ';font-size:14.5px;line-height:1.65;color:' + muted + '">' +
        'Payment mil gaya hai. Neeche aapki shop aur payment ki poori detail hai &mdash; ise sambhaal ke rakhiye.</div>' +
    '</td></tr>' +

    sectionTitle('Shop details') +
    '<tr><td style="padding:0 28px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      row('Shop ID', esc(d.shopId), true, true) +
      row('Shop ka naam', esc(d.shopName), false, false) +
      row('Register hui', esc(d.registeredAt), false, false) +
    '</table></td></tr>' +

    '<tr><td style="padding:12px 0"></td></tr>' + perf +

    sectionTitle('Payment details') +
    '<tr><td style="padding:0 28px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      row('Plan', esc(d.plan), false, false) +
      row('Amount paid', '&#8377;' + esc(d.amount), true, true) +
      row('Payment ID', esc(d.paymentId), true, false) +
      row('Paid on', esc(d.paidAt), false, false) +
      (d.validTill ? row('Valid till', esc(d.validTill), false, false) : '') +
    '</table></td></tr>' +

    '<tr><td style="padding:12px 0"></td></tr>' + perf +

    sectionTitle('Ab kya karein') +
    '<tr><td style="padding:2px 28px 0;font-family:' + sans + ';font-size:14.5px;line-height:1.75;color:' + ink + '">' +
      '<div style="padding:4px 0"><b>1.</b> Dashboard me login kariye &mdash; Shop ID aur apna password se</div>' +
      '<div style="padding:4px 0"><b>2.</b> Apna QR code download karke shop par lagaiye</div>' +
      '<div style="padding:4px 0"><b>3.</b> Print Agent install kariye &mdash; uske baad print automatic nikalega</div>' +
    '</td></tr>' +
    (d.dashboardUrl
      ? '<tr><td style="padding:20px 28px 4px">' +
          '<a href="' + esc(d.dashboardUrl) + '" style="display:inline-block;background:' + ink + ';color:#ffffff;' +
          'text-decoration:none;font-family:' + sans + ';font-size:15px;font-weight:600;padding:13px 26px;border-radius:6px">' +
          'Dashboard kholiye &rarr;</a></td></tr>'
      : '') +

    '<tr><td style="padding:22px 0 0"></td></tr>' + perf +

    sectionTitle('Madad chahiye') +
    '<tr><td style="padding:2px 28px 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
      (waDigits.length === 10
        ? '<td style="padding:6px 10px 6px 0"><a href="https://wa.me/91' + waDigits + '" ' +
          'style="display:inline-block;border:1.5px solid ' + ink + ';border-radius:6px;padding:10px 18px;font-family:' + sans +
          ';font-size:14px;font-weight:600;color:' + ink + ';text-decoration:none">WhatsApp ' + esc(d.supportPhone) + '</a></td>'
        : '') +
      (d.supportEmail
        ? '<td style="padding:6px 0"><a href="mailto:' + esc(d.supportEmail) + '" ' +
          'style="display:inline-block;border:1.5px solid ' + rule + ';border-radius:6px;padding:10px 18px;font-family:' + sans +
          ';font-size:14px;font-weight:600;color:' + ink + ';text-decoration:none">' + esc(d.supportEmail) + '</a></td>'
        : '') +
    '</tr></table></td></tr>' +

    '<tr><td style="padding:26px 28px 28px">' +
      '<div style="border-top:1px solid ' + rule + ';padding-top:16px;font-family:' + sans +
        ';font-size:12.5px;line-height:1.7;color:' + muted + '">' +
        'Ye mail ' + esc(d.brand) + ' ki taraf se automatic bheja gaya hai.<br>' +
        'Payment aapne nahi kiya? Turant upar wale number par batayiye.' +
      '</div>' +
    '</td></tr>' +

  '</table>' +
'</td></tr></table>';
}

// Plain-text version — purane mail apps aur inbox preview line ke liye
function buildShopPaymentEmailText(d) {
  return 'PAYMENT RECEIVED — ' + d.brand + '\n' +
    '=================================\n\n' +
    'Shukriya, ' + d.shopName + ' — aapki shop ab active hai.\n\n' +
    'SHOP DETAILS\n' +
    'Shop ID       : ' + d.shopId + '\n' +
    'Shop ka naam  : ' + d.shopName + '\n' +
    'Register hui  : ' + d.registeredAt + '\n\n' +
    'PAYMENT DETAILS\n' +
    'Plan          : ' + d.plan + '\n' +
    'Amount paid   : Rs ' + d.amount + '\n' +
    'Payment ID    : ' + d.paymentId + '\n' +
    'Paid on       : ' + d.paidAt + '\n' +
    (d.validTill ? 'Valid till    : ' + d.validTill + '\n' : '') + '\n' +
    'AB KYA KAREIN\n' +
    '1. Dashboard me login kariye — Shop ID aur apna password se\n' +
    '2. Apna QR code download karke shop par lagaiye\n' +
    '3. Print Agent install kariye — print automatic nikalega\n\n' +
    (d.dashboardUrl ? 'Dashboard: ' + d.dashboardUrl + '\n\n' : '') +
    'MADAD CHAHIYE\n' +
    (d.supportPhone ? 'WhatsApp : ' + d.supportPhone + '\n' : '') +
    (d.supportEmail ? 'Email    : ' + d.supportEmail + '\n' : '') + '\n' +
    '-- ' + d.brand + '\n' +
    'Payment aapne nahi kiya? Turant upar wale number par batayiye.';
}

// Saara data DB se uthata hai aur mail bhejta hai. Fail ho to bhi kabhi
// throw nahi karta — activation is se kabhi nahi rukna chahiye.
async function sendShopPaymentEmail(shopId) {
  try {
    const s = await pool.query(
      `SELECT id,name,email,created_at,setup_amount,setup_payment_id,
              plan_type,paid_until,whitelabel_id,demo
       FROM shops WHERE id=$1`, [shopId]);
    if (!s.rows.length) return;
    const shop = s.rows[0];
    if (shop.demo) return;                 // demo par mail nahi
    if (!shop.email) {                     // purani shop — email hai hi nahi
      console.log(`Shop mail skip ${shopId}: email set nahi hai`);
      return;
    }

    let brand = 'QR Se Print', supportEmail = '', supportPhone = '', dashboardUrl = BASE_URL + '/admin';

    if (shop.whitelabel_id) {
      // ── WHITE LABEL ── partner ka brand aur partner ka support. Mera
      // naam, number ya koi program is mail me kahin nahi jaana chahiye.
      const w = await pool.query(
        'SELECT brand_name, slug, support_email, support_phone, site_url FROM whitelabels WHERE id=$1',
        [shop.whitelabel_id]);
      if (!w.rows.length) return;
      const wl = w.rows[0];
      brand = wl.brand_name || 'Print Service';
      supportEmail = wl.support_email || '';
      supportPhone = wl.support_phone || '';
      dashboardUrl = wl.site_url ? (String(wl.site_url).replace(/\/+$/, '') + '/admin')
                                 : (BASE_URL + '/admin?wl=' + encodeURIComponent(wl.slug || ''));
    } else {
      const c = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
      try {
        const cfg = JSON.parse(c.rows[0]?.value || '{}');
        supportEmail = cfg.supportEmail || '';
        supportPhone = cfg.supportPhone || '';
      } catch (e) { /* config toota ho to support ke bina hi mail jaayegi */ }
    }

    const isMonthly = (shop.plan_type || 'onetime') === 'monthly';
    const data = {
      brand,
      shopId: shop.id,
      shopName: shop.name || shop.id,
      registeredAt: fmtIST(shop.created_at),
      plan: isMonthly ? ('Monthly (Rs ' + (shop.setup_amount || 0) + '/mahina)') : 'One-time (Lifetime)',
      amount: String(shop.setup_amount || 0),
      paymentId: shop.setup_payment_id || '-',
      paidAt: fmtIST(new Date()),
      validTill: isMonthly && shop.paid_until ? fmtIST(shop.paid_until).split(',')[0] : '',
      dashboardUrl, supportEmail, supportPhone
    };

    const r = await sendEmailAlert(
      shop.email,
      'Payment mil gaya — ' + data.shopName + ' active hai',
      buildShopPaymentEmailText(data),
      brand,
      buildShopPaymentEmailHtml(data)
    );
    console.log(`Shop mail ${shopId} -> ${shop.email}: ${r.ok ? 'sent' : 'FAIL ' + r.why}`);
  } catch (e) {
    console.error('sendShopPaymentEmail error:', e.message);
  }
}

// ── Superadmin: email alert settings ──
app.get('/api/superadmin/notify', verifySuperAdmin, async (req, res) => {
  try {
    const c = await pool.query(
      "SELECT key,value FROM system_settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass','notify_email','brevo_api_key','brevo_sender')");
    const m = {}; c.rows.forEach(r => { m[r.key] = r.value; });
    res.json({
      host: m.smtp_host || 'smtp.gmail.com',
      port: m.smtp_port || '587',
      user: m.smtp_user || '',
      hasPass: !!m.smtp_pass,          // password kabhi wapas nahi bhejte
      notifyEmail: m.notify_email || '',
      brevoSender: m.brevo_sender || '',
      hasBrevoKey: !!m.brevo_api_key
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/notify', verifySuperAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const set = async (k, v) => {
      await pool.query(
        `INSERT INTO system_settings (key,value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value=$2`, [k, String(v || '').slice(0, 300)]);
    };
    if (b.host !== undefined) await set('smtp_host', String(b.host).trim());
    if (b.port !== undefined) await set('smtp_port', String(parseInt(b.port, 10) || 587));
    if (b.user !== undefined) await set('smtp_user', String(b.user).trim());
    // Password khaali bheja = purana rehne do (form me dobara type na karna pade)
    if (b.pass) await set('smtp_pass', String(b.pass).trim());
    if (b.notifyEmail !== undefined) {
      const e = String(b.notifyEmail).trim();
      if (e && !/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'Sahi email daalo' });
      await set('notify_email', e);
    }
    if (b.brevoSender !== undefined) {
      const e = String(b.brevoSender).trim();
      if (e && !/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'Sahi sender email daalo' });
      await set('brevo_sender', e);
    }
    if (b.brevoKey) await set('brevo_api_key', String(b.brevoKey).trim());
    _mailer = null;   // settings badli — naya transport banega
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/notify/test', verifySuperAdmin, async (req, res) => {
  try {
    const c = await pool.query("SELECT value FROM system_settings WHERE key='notify_email'");
    const to = c.rows[0]?.value || '';
    if (!to) return res.status(400).json({ error: 'Pehle alert email save karo' });

    // Brevo set hai to seedha bhejo. Warna SMTP ka connection pehle check karo.
    const bk = await pool.query("SELECT value FROM system_settings WHERE key='brevo_api_key'");
    const usingBrevo = !!(bk.rows[0]?.value);
    if (!usingBrevo) {
      const t = await getMailer();
      if (!t) return res.status(400).json({ error: 'Email setup nahi hai — Brevo API key daalo (recommended) ya SMTP bharo' });
      try {
        await t.verify();
      } catch (e) {
        _mailer = null;
        const hint = /timeout|ETIMEDOUT|ECONNREFUSED/i.test(e.message)
          ? ' — lagta hai hosting ne SMTP port block kiya hai. Brevo API key use karo (upar wala option).'
          : '';
        return res.status(400).json({ error: 'SMTP connect nahi hua: ' + e.message + hint });
      }
    }

    const r = await sendEmailAlert(to, '✅ Test — QR Se Print alerts',
      'Ye ek test email hai.\n\nAgar ye mil gaya, matlab alerts chalu ho gaye hain.\nAb nayi shop register hone par aapko yahan message aayega.\n\n— QR Se Print');
    if (!r.ok) return res.status(400).json({ error: 'Bheja nahi ja saka: ' + r.why });
    if (r.rejected && r.rejected.length) {
      return res.status(400).json({ error: 'Server ne reject kiya: ' + r.rejected.join(', ') });
    }
    console.log(`Test mail -> ${to} | ${r.response} | id=${r.messageId}`);
    res.json({
      success: true, to, from: r.from, via: r.via,
      accepted: r.accepted, messageId: r.messageId, response: r.response
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── White label partner: sirf apna email (koi SMTP setup nahi) ──
app.put('/api/whitelabel/notify', verifyWhitelabel, async (req, res) => {
  try {
    const e = String(req.body.notifyEmail || '').trim();
    if (e && !/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'Sahi email daalo' });
    await pool.query('UPDATE whitelabels SET notify_email=$2 WHERE id=$1', [req.wlId, e]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/whitelabel/notify/test', verifyWhitelabel, async (req, res) => {
  try {
    const w = await pool.query(
      'SELECT brand_name, notify_email, email FROM whitelabels WHERE id=$1', [req.wlId]);
    const row = w.rows[0];
    const to = (row && (row.notify_email || row.email)) || '';
    if (!to) return res.status(400).json({ error: 'Pehle apna email save karo' });
    const brand = row.brand_name || 'Partner';
    const r = await sendEmailAlert(to, `✅ Test — ${brand} alerts`,
      `Ye ek test email hai.\n\nAgar ye mil gaya, matlab alerts chalu ho gaye hain.\nAb aapke link se nayi shop register hone par yahan message aayega.\n\n— ${brand}`, brand);
    if (!r.ok) return res.status(400).json({ error: 'Bheja nahi ja saka: ' + r.why });
    res.json({ success: true, to });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/setup-fee/current', async (req, res) => {
  try {
    const pricing = await getSetupPricing();
    const out = {
      amount: pricing.offerPrice, ...pricing,
      advancedFee: await getAdvancedFee(),
      monthlyActualPrice: await getMonthlyActualFee(),
      advancedActualPrice: await getAdvancedActualFee()
    };
    // ?ref=QRA-1234 — agent ka apna price (sirf one-time plan par).
    // Agent ka floor ab AGENT BASE PRICE hai, public Offer Price nahi —
    // agent ne kuch set na kiya ho tab bhi yahi (699 jaisa) dikhega.
    if (req.query.ref) {
      const s = await resolveRef(req.query.ref);
      if (s && s.is_agent) {
        const agentBase = await getAgentBasePrice();
        const agentPrice = (s.agent_price && s.agent_price > agentBase) ? s.agent_price : agentBase;
        out.offerPrice = agentPrice;
        out.amount = agentPrice;
        out.agentRef = req.query.ref;
        out.agentName = s.name;
      }
    }
    res.json(out);
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
      cashfree_app_id, cashfree_secret_key, email, ref
    } = req.body;

    // Referral: ?ref=SHOP_XXX se aaya — sirf tab valid jab wo referrer
    // EXIST kare aur khud PAID ho (unpaid shop refer nahi kar sakta),
    // aur khud ko refer na kare
    // ref = agent code (QRA-1234) ya purana shop id — dono support
    const refShop = await resolveRef(ref);
    const referredBy = refShop ? refShop.id : '';
    const onboardedBy = (refShop && refShop.is_agent) ? refShop.id : '';

    if (!name || !name.trim()) return res.status(400).json({ error: 'Shop ka naam zaroori hai' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password kam se kam 4 character ka hona chahiye' });
    if (password.length > PASSWORD_MAX) return res.status(400).json({ error: 'Password bahut lamba hai' });

    // Email ab ZAROORI hai — payment confirmation isi par jaati hai
    const finalEmail = String(email || '').trim().toLowerCase();
    if (!finalEmail) return res.status(400).json({ error: 'Email zaroori hai — payment ki receipt isi par aayegi' });
    if (!isValidEmail(finalEmail)) return res.status(400).json({ error: 'Email sahi nahi lag raha — dobara check karo' });

    const validPaymentModes = ['both', 'counter_only', 'online_only'];
    const finalPaymentMode = validPaymentModes.includes(payment_mode) ? payment_mode : 'both';

    const needsGateway = finalPaymentMode === 'both' || finalPaymentMode === 'online_only';
    let finalGateway = '';
    if (needsGateway) {
      if (payment_gateway === 'razorpay' && razorpay_key_id && razorpay_key_secret) {
        finalGateway = 'razorpay';
      } else if (payment_gateway === 'cashfree' && cashfree_app_id && cashfree_secret_key) {
        finalGateway = 'cashfree';
      } else {
        return res.status(400).json({ error: 'Online payment ke liye Razorpay ya Cashfree ki details zaroori hain' });
      }
    }

    const shopId = 'SHOP_' + uuidv4().substring(0,8).toUpperCase();
    const passwordHash = await hashPassword(password);
    const currentSetupFee = await getSetupFeeAmount();
    // Plan: 'onetime' (default) ya 'monthly' (₹99/mahina — pehli payment se 30 din)
    const plan = req.body.plan === 'monthly' ? 'monthly' : 'onetime';
    const monthlyFee = await getMonthlyFee();
    // Agent ke link se aaya hai to floor = AGENT BASE PRICE (superadmin ne
    // set kiya hua, jaise 699) — public Offer Price (599) nahi. Agent ne
    // khud kuch aur set kiya ho (jaise 799) to wahi lagega. Ye SIRF
    // one-time plan par lagta hai; monthly hamesha public rate par.
    let oneTimePrice = currentSetupFee;
    let onetimeBaseForRecord = currentSetupFee;
    if (onboardedBy) {
      const agentBase = await getAgentBasePrice();
      oneTimePrice = (refShop.agent_price && refShop.agent_price > agentBase) ? refShop.agent_price : agentBase;
      onetimeBaseForRecord = agentBase;
    }

    // ── WHITE LABEL ── ?wl=slug ya subdomain se aaya ho to reseller ka
    // price lagta hai, aur setup fee SEEDHA uske Razorpay me jaayega.
    const wl = await resolveWhitelabel(req);
    let whitelabelId = '';
    if (wl) {
      // Reseller ne apna Razorpay nahi lagaya — paisa galti se hamare paas
      // aa jaata, isliye registration hi rok do (saaf message ke saath)
      if (!wl.razorpay_key_id || !wl.razorpay_key_secret) {
        return res.status(503).json({ error: 'Ye partner abhi payment setup complete nahi kiya hai. Thodi der baad try kariye.' });
      }
      whitelabelId = wl.id;
      const wlBase = wl.base_price || await getWlBasePrice();
      oneTimePrice = (wl.shop_price && wl.shop_price > wlBase) ? wl.shop_price : wlBase;
      onetimeBaseForRecord = wlBase;
    }
    const firstPayment = plan === 'monthly' ? monthlyFee : oneTimePrice;
    const soldPrice = plan === 'monthly' ? monthlyFee : oneTimePrice;
    const basePrice  = plan === 'monthly' ? monthlyFee : onetimeBaseForRecord;

    // Shop create hoti hai lekin setup_paid=false rehta hai by default.
    // QR Code aur Print Agent sirf setup fee payment confirm hone ke baad milte hain.
    await pool.query(
      `INSERT INTO shops 
        (id,name,address,phone,email,printer_model,price_bw,price_color,payment_mode,password_hash,
         payment_gateway,razorpay_key_id,razorpay_key_secret,cashfree_app_id,cashfree_secret_key,
         setup_paid,setup_amount,plan_type,referred_by,onboarded_by,base_price_at_signup,sold_price,whitelabel_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16,$17,$18,$19,$20,$21,$22)`,
      [shopId, name, address, phone, finalEmail, printer_model, price_bw||5, price_color||10, finalPaymentMode, passwordHash,
       finalGateway, razorpay_key_id||'', razorpay_key_secret||'', cashfree_app_id||'', cashfree_secret_key||'',
       firstPayment, plan, referredBy, onboardedBy, basePrice, soldPrice, whitelabelId]
    );

    res.json({ success: true, shopId, setupFeeAmount: firstPayment, plan });
    // Alert baad me — response pehle ja chuka hai, isliye customer ko wait nahi karna padta
    alertNewShop(shopId, 'new');
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── SETUP FEE PAYMENT — Rupesh (system owner) ki Razorpay account mein paisa aata hai ───
app.post('/api/setup-fee/create', async (req, res) => {
  try {
    const { shopId } = req.body;
    if (!shopId) return res.status(400).json({ error: 'Shop ID required' });

    const shopResult = await pool.query('SELECT id, setup_paid, setup_amount, whitelabel_id FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if (shopResult.rows[0].setup_paid) return res.status(400).json({ error: 'Setup fee already paid hai' });

    // ── Paisa kiske account me? ──
    // Normal shop -> hamara Razorpay. White-label ki shop -> RESELLER ka
    // Razorpay (uski kamai seedha usi ke paas jaati hai, hamare paas nahi).
    let payKeyId = OWNER_RAZORPAY_KEY_ID, payKeySecret = OWNER_RAZORPAY_KEY_SECRET;
    const wlIdOfShop = shopResult.rows[0].whitelabel_id || '';
    if (wlIdOfShop) {
      const w = await pool.query(
        'SELECT razorpay_key_id, razorpay_key_secret, blocked FROM whitelabels WHERE id=$1', [wlIdOfShop]);
      const wrow = w.rows[0];
      if (!wrow || !wrow.razorpay_key_id || !wrow.razorpay_key_secret) {
        return res.status(503).json({ error: 'Partner ka payment setup adhoora hai. Unse sampark kariye.' });
      }
      if (wrow.blocked) return res.status(403).json({ error: 'Ye partner account abhi active nahi hai.' });
      payKeyId = wrow.razorpay_key_id;
      payKeySecret = wrow.razorpay_key_secret;
    }

    if (!payKeyId || !payKeySecret) {
      console.error('Setup fee create error: Razorpay keys missing');
      return res.status(500).json({ error: 'Payment gateway configure nahi hai.' });
    }

    const amount = shopResult.rows[0].setup_amount || SETUP_FEE_AMOUNT;
    const amountInPaise = amount * 100;

    const orderData = JSON.stringify({
      amount: amountInPaise,
      currency: 'INR',
      receipt: 'SETUP_' + shopId,
      notes: { shopId, type: 'setup_fee' }
    });

    const authHeader = 'Basic ' + Buffer.from(`${payKeyId}:${payKeySecret}`).toString('base64');

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

    if (!razorpayOrder.id) {
      // Razorpay ka asli reason (galat key, amount, etc.) yahi aata hai —
      // isko log bhi karo aur frontend ko bhejo taaki debug ho sake.
      const rzpReason = razorpayOrder && razorpayOrder.error && razorpayOrder.error.description
        ? razorpayOrder.error.description
        : 'Razorpay ne order reject kiya';
      console.error('Setup fee create error — Razorpay:', JSON.stringify(razorpayOrder));
      return res.status(400).json({ error: 'Setup fee order create nahi hua: ' + rzpReason, details: razorpayOrder });
    }

    await pool.query('UPDATE shops SET setup_order_id=$1 WHERE id=$2', [razorpayOrder.id, shopId]);

    res.json({
      success: true,
      orderId: razorpayOrder.id,
      amount: amountInPaise,
      keyId: payKeyId,
      shopId
    });
  } catch(err) {
    console.error('Setup fee create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Shop activation (setup fee confirm hone par) — verify handler,
//    webhook aur reconciliation teeno yahi use karte hain ──
async function getAdvancedFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='advanced_fee'");
    return Math.max(1, parseInt(r.rows[0]?.value) || 199);
  } catch(e) { return 199; }
}

async function getMonthlyFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='monthly_fee'");
    return Math.max(1, parseInt(r.rows[0]?.value) || 99);
  } catch(e) { return 99; }
}

async function getMonthlyActualFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='monthly_actual_price'");
    return Math.max(0, parseInt(r.rows[0]?.value) || 0);
  } catch(e) { return 0; }
}

async function getAdvancedActualFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='advanced_actual_price'");
    return Math.max(0, parseInt(r.rows[0]?.value) || 0);
  } catch(e) { return 0; }
}

// Agent Base Price — agent ke liye alag floor. 0/unset ho to public Offer
// Price hi floor rehta hai (purana behaviour, kuch nahi tootega). Superadmin
// jab explicitly ise set karega tabhi agent ka price homepage ke price se
// alag dikhna shuru hoga.
async function getAgentBasePrice() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='agent_base_price'");
    const v = parseInt(r.rows[0]?.value) || 0;
    if (v > 0) return v;
  } catch(e) {}
  return await getSetupFeeAmount();
}

// Shop ka subscription zinda hai? onetime = hamesha; monthly = paid_until check
function isSubscriptionActive(shop) {
  if (!shop) return false;
  if ((shop.plan_type || 'onetime') !== 'monthly') return true;
  return shop.paid_until && new Date(shop.paid_until).getTime() > Date.now();
}

// Monthly renewal — RACE-SAFE: renewal_order_id match + clear ek hi atomic
// UPDATE me (webhook + verify + reconcile teeno fire ho sakte hain — sirf
// pehla jeeta, baaki no-op, double +30din kabhi nahi)
async function extendShop(shopId, orderId, paymentId) {
  const r = await pool.query(
    `UPDATE shops SET
       paid_until = GREATEST(NOW(), COALESCE(paid_until, NOW())) + INTERVAL '30 days',
       renewal_order_id = ''
     WHERE id=$1 AND renewal_order_id=$2
     RETURNING paid_until`,
    [shopId, orderId]);
  if (r.rows.length) {
    console.log(`Subscription renewed: ${shopId} | till ${r.rows[0].paid_until} | pay ${paymentId}`);
    return r.rows[0].paid_until;
  }
  return null; // koi aur pehle process kar chuka
}

async function activateShop(shopId, paymentId) {
  const qrUrl = `${BASE_URL}/print/${shopId}`;
  const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });

  // RACE-SAFE: webhook, verify aur reconcile — teeno ek saath aa sakte hain.
  // `AND setup_paid=false` ki wajah se sirf PEHLA jeetega, baaki no-op.
  // Isi se alert aur shop ko email DO BAAR kabhi nahi jaayenge.
  const upd = await pool.query(
    `UPDATE shops SET setup_paid=true, setup_payment_id=$1, qr_code=$2
     WHERE id=$3 AND setup_paid=false RETURNING id`,
    [paymentId, qrCode, shopId]
  );
  const firstTime = upd.rows.length > 0;

  if (firstTime) {
    // Monthly plan: pehli payment = pehle 30 din
    await pool.query(
      "UPDATE shops SET paid_until = NOW() + INTERVAL '30 days' WHERE id=$1 AND plan_type='monthly'",
      [shopId]);
    console.log(`Setup fee paid: ${shopId} | Payment: ${paymentId}`);

    // Aapko alert (fail ho to bhi activation nahi rukega)
    alertNewShop(shopId, 'paid');
    // Shop owner ko payment confirmation email
    sendShopPaymentEmail(shopId);
  } else {
    console.log(`Setup fee: ${shopId} pehle se paid hai — dobara alert/mail nahi bheja`);
  }

  // ── AGENT COMMISSION ── kya ye shop kisi agent ne onboard ki thi?
  try {
    const ob = await pool.query(
      `SELECT name, onboarded_by, agent_credited, base_price_at_signup, sold_price, setup_amount
       FROM shops WHERE id=$1`, [shopId]);
    const s = ob.rows[0];
    if (s && s.onboarded_by && !s.agent_credited) {
      const ag = await pool.query(
        'SELECT id, is_agent, agent_blocked FROM shops WHERE id=$1', [s.onboarded_by]);
      if (ag.rows.length && ag.rows[0].is_agent && !ag.rows[0].agent_blocked) {
        const base   = s.base_price_at_signup || 0;
        const sold   = s.sold_price || s.setup_amount || 0;
        const markup = Math.max(0, sold - base);

        // Bonus: har 10 onboarded (paid) shop par ek baar
        const cnt = await pool.query(
          'SELECT COUNT(*)::int AS n FROM agent_commissions WHERE agent_id=$1', [s.onboarded_by]);
        const nth = (cnt.rows[0].n || 0) + 1;
        const bonus = (nth % AGENT_BONUS_EVERY === 0) ? AGENT_BONUS_AMOUNT : 0;
        const total = AGENT_COMMISSION + markup + bonus;

        await pool.query(
          `INSERT INTO agent_commissions
             (agent_id, shop_id, shop_name, base_price, sold_price, markup, commission, bonus, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [s.onboarded_by, shopId, s.name || '', base, sold, markup, AGENT_COMMISSION, bonus, total]);
        await pool.query(
          'UPDATE shops SET agent_earnings = COALESCE(agent_earnings,0) + $2 WHERE id=$1',
          [s.onboarded_by, total]);
        console.log(`Agent commission: ₹${total} (₹${AGENT_COMMISSION}+₹${markup}+bonus ₹${bonus}) -> ${s.onboarded_by} for ${shopId}`);
      }
      await pool.query('UPDATE shops SET agent_credited=true WHERE id=$1', [shopId]);
    }
  } catch(e) { console.error('Agent commission error:', e.message); }

  // ── REFERRAL REWARD ── is naye shop ko kisi ne refer kiya tha?
  // NOTE: agar shop kisi AGENT ne onboard ki hai to ₹50 referral nahi milta —
  // usko ₹200 wala agent commission upar mil chuka hai (double count se bachne ke liye)
  try {
    const me = await pool.query('SELECT referred_by, referral_rewarded, onboarded_by FROM shops WHERE id=$1', [shopId]);
    const row = me.rows[0];
    if (row && row.onboarded_by) {
      await pool.query('UPDATE shops SET referral_rewarded=true WHERE id=$1', [shopId]);
    } else if (row && row.referred_by && !row.referral_rewarded) {
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

    // Signature usi SECRET se verify hoga jisse order bana tha —
    // white-label ki shop ka order reseller ke keys se banta hai.
    let vSecret = OWNER_RAZORPAY_KEY_SECRET;
    const wlq = await pool.query('SELECT whitelabel_id FROM shops WHERE id=$1', [shopId]);
    const wlIdV = wlq.rows[0]?.whitelabel_id || '';
    if (wlIdV) {
      const w = await pool.query('SELECT razorpay_key_secret FROM whitelabels WHERE id=$1', [wlIdV]);
      if (w.rows[0]?.razorpay_key_secret) vSecret = w.rows[0].razorpay_key_secret;
    }

    const expectedSignature = crypto
      .createHmac('sha256', vSecret)
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

// ─── ADVANCED PRINTING UNLOCK — ₹199 one-time ───
app.post('/api/admin/advanced/create-order', verifyToken, async (req, res) => {
  try {
    if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET)
      return res.status(500).json({ error: 'Owner Razorpay configured nahi' });
    const sh = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if (sh.rows[0].advanced_unlocked) return res.status(400).json({ error: 'Advanced already unlocked hai' });

    const fee = await getAdvancedFee();
    const orderData = JSON.stringify({
      amount: fee * 100, currency: 'INR',
      receipt: 'adv_' + req.shopId.slice(-8) + '_' + Date.now().toString().slice(-6),
      notes: { shopId: req.shopId, kind: 'advanced_unlock' }
    });
    const auth = Buffer.from(`${OWNER_RAZORPAY_KEY_ID}:${OWNER_RAZORPAY_KEY_SECRET}`).toString('base64');
    const order = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth,
                   'Content-Length': Buffer.byteLength(orderData) }
      }, (resp) => { let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}}); });
      r.on('error', reject); r.write(orderData); r.end();
    });
    if (!order.id) return res.status(400).json({ error: 'Order create nahi hua' });
    await pool.query('UPDATE shops SET advanced_order_id=$1 WHERE id=$2', [order.id, req.shopId]);
    res.json({ success: true, orderId: order.id, amount: fee * 100, keyId: OWNER_RAZORPAY_KEY_ID, fee });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/advanced/verify', verifyToken, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = crypto.createHmac('sha256', OWNER_RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Verification failed' });
    // Atomic: order match + unlock ek saath (double-fire safe)
    const r = await pool.query(
      "UPDATE shops SET advanced_unlocked=true, advanced_order_id='' WHERE id=$1 AND advanced_order_id=$2 RETURNING id",
      [req.shopId, razorpay_order_id]);
    if (r.rows.length) console.log('Advanced unlocked:', req.shopId, razorpay_payment_id);
    res.json({ success: true, unlocked: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── MONTHLY RENEWAL — ₹99 owner ke Razorpay se Rupesh ko ───
app.post('/api/admin/renew/create-order', verifyToken, async (req, res) => {
  try {
    if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET)
      return res.status(500).json({ error: 'Owner Razorpay configured nahi' });
    const sh = await pool.query('SELECT id, plan_type FROM shops WHERE id=$1', [req.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if (sh.rows[0].plan_type !== 'monthly')
      return res.status(400).json({ error: 'Ye shop one-time plan par hai — renewal ki zaroorat nahi' });

    const fee = await getMonthlyFee();
    const amountInPaise = fee * 100;
    const orderData = JSON.stringify({
      amount: amountInPaise, currency: 'INR',
      receipt: 'renew_' + req.shopId.slice(-8) + '_' + Date.now().toString().slice(-6),
      notes: { shopId: req.shopId, kind: 'renewal' }
    });
    const auth = Buffer.from(`${OWNER_RAZORPAY_KEY_ID}:${OWNER_RAZORPAY_KEY_SECRET}`).toString('base64');
    const razorpayOrder = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth,
                   'Content-Length': Buffer.byteLength(orderData) }
      }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      r.on('error', reject);
      r.write(orderData);
      r.end();
    });
    if (!razorpayOrder.id) return res.status(400).json({ error: 'Renewal order create nahi hua' });

    await pool.query('UPDATE shops SET renewal_order_id=$1 WHERE id=$2', [razorpayOrder.id, req.shopId]);
    res.json({ success: true, orderId: razorpayOrder.id, amount: amountInPaise, keyId: OWNER_RAZORPAY_KEY_ID, fee });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/renew/verify', verifyToken, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = crypto.createHmac('sha256', OWNER_RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Payment verification failed' });
    const till = await extendShop(req.shopId, razorpay_order_id, razorpay_payment_id);
    res.json({ success: true, paid_until: till });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/login', loginLimiter, async (req, res) => {
  try {
    const { shopId, password } = req.body;
    if (!shopId || !password) return res.status(400).json({ error: 'Shop ID aur Password dono chahiye' });

    const r = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId.trim().toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop ID nahi mila' });

    const shop = r.rows[0];


    if (!shop.password_hash) {
      return res.status(401).json({ error: 'Is shop ka password set nahi hai. Pehle Set Password karo.' });
    }
    if (!(await verifyPassword(password, shop.password_hash))) {
      return res.status(401).json({ error: 'Password galat hai' });
    }

    clearLoginHits(req);
    // Purana sha256 hash hai to abhi scrypt me badal do — user ko pata nahi chalega
    await upgradeHashIfLegacy('shops', 'id', shop.id, shop.password_hash, password);

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
    // Password set HO YA NA HO — registered phone match = reset allowed.
    // (Pehle set-hone par admin-contact bolta tha; ab self-serve reset.
    //  Security wahi: phone public API se hata hua hai + IP rate-limit.)
    if (normPhone(phone) !== normPhone(r.rows[0].phone)) {
      return res.status(403).json({ error: 'Mobile number match nahi hua — wahi number daalo jo registration me diya tha' });
    }
    const passwordHash = await hashPassword(newPassword);
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [passwordHash, shopId.trim().toUpperCase()]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Demo status — agent 30 min me ek baar poochta hai (halka payload)
app.get('/api/shop/:shopId/demo-status', async (req, res) => {
  try {
    const r = await pool.query('SELECT demo, demo_expires_at FROM shops WHERE id=$1', [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const s = r.rows[0];
    const expired = !!(s.demo && s.demo_expires_at && new Date(s.demo_expires_at).getTime() < Date.now());
    res.json({ demo: !!s.demo, demo_expires_at: s.demo_expires_at, expired });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/:shopId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,name,address,printer_model,price_bw,price_color,price_bw_duplex,price_color_duplex,payment_mode,payment_gateway,razorpay_key_id,qr_code,setup_paid,paused,supply_warning,demo,demo_expires_at,duplex_mode,plan_type,paid_until,advanced_unlocked,price_4x6_4,price_4x6_6,price_4x6_10,price_resume_color,price_resume_bw,shop_notice,advanced_active,shop_logo,adv_legal_active,adv_resume_active,adv_4x6_active,adv_a3_active FROM shops WHERE id=$1',
      [req.params.shopId]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Shop not found' });
    if (!r.rows[0].setup_paid) {
      return res.status(403).json({ error: 'Shop ka setup abhi incomplete hai. Shop owner ko setup fee complete karna hoga.' });
    }
    const shopInfo = r.rows[0];
    // Customer ke liye advance tabhi ON jab kharida (unlocked) AUR owner ne active rakha
    const advOn = !!(shopInfo.advanced_unlocked && shopInfo.advanced_active !== false);
    shopInfo.advanced_unlocked = advOn;
    // Har module ka effective status = advance ON aur us module ka switch ON.
    // Customer page inhi 4 flags se apna layout banata hai.
    shopInfo.adv_legal_active  = advOn && shopInfo.adv_legal_active  !== false;
    shopInfo.adv_resume_active = advOn && shopInfo.adv_resume_active !== false;
    shopInfo.adv_4x6_active    = advOn && shopInfo.adv_4x6_active    !== false;
    shopInfo.adv_a3_active     = advOn && shopInfo.adv_a3_active     !== false;

    // White-label ki shop hai to customer page par PARTNER ka brand dikhega
    try {
      const wq = await pool.query('SELECT whitelabel_id FROM shops WHERE id=$1', [req.params.shopId]);
      const wlId = wq.rows[0]?.whitelabel_id || '';
      if (wlId) {
        const w = await pool.query(
          'SELECT brand_name, powered_by, support_email, support_phone, blocked FROM whitelabels WHERE id=$1', [wlId]);
        if (w.rows.length && !w.rows[0].blocked) {
          shopInfo.powered_by = w.rows[0].powered_by || w.rows[0].brand_name || '';
          shopInfo.wl_brand = w.rows[0].brand_name || '';
          shopInfo.wl_support_email = w.rows[0].support_email || '';
          shopInfo.wl_support_phone = w.rows[0].support_phone || '';
        }
      }
    } catch(e) { /* branding fail ho to default hi rahega */ }
    shopInfo.subscription_expired = !isSubscriptionActive(shopInfo);
    delete shopInfo.paid_until; // customer ko exact date nahi dikhani
    res.json(shopInfo);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Customer: print ke baad thumbs up/down (public, ek baar)
app.post('/api/jobs/:jobId/feedback', async (req, res) => {
  try {
    const v = req.body.up === true ? 1 : req.body.up === false ? -1 : 0;
    if (!v) return res.status(400).json({ error: 'up boolean chahiye' });
    // Sirf printed job, aur sirf jab feedback abhi 0 hai (ek baar)
    const r = await pool.query(
      "UPDATE print_jobs SET feedback=$1 WHERE id=$2 AND status='printed' AND feedback=0 RETURNING id",
      [v, req.params.jobId]);
    res.json({ success: true, recorded: r.rows.length > 0 });
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
      `SELECT id,name,address,phone,demo,plan_type,paid_until,advanced_unlocked,advanced_active,
              adv_legal_active,adv_resume_active,adv_4x6_active,adv_a3_active,shop_notice,shop_logo,price_4x6_4,price_4x6_6,price_4x6_10,price_resume_color,price_resume_bw,printer_model,printer_name_bw,printer_name_color,printer_name_4x6,printer_name_a3,price_bw,price_color,price_bw_duplex,price_color_duplex,payment_mode,qr_code,created_at,paused,supply_warning,duplex_mode,
              email,payment_gateway,razorpay_key_id,cashfree_app_id,
              CASE WHEN razorpay_key_secret != '' THEN true ELSE false END as has_razorpay_secret,
              CASE WHEN cashfree_secret_key != '' THEN true ELSE false END as has_cashfree_secret
       FROM shops WHERE id=$1`, [req.shopId]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Shop not found' });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/settings', verifyToken, async (req, res) => {
  try {
    // Advanced-lock status SABSE PEHLE — duplex aur 4x6/A3 dono blocks
    // ise use karte hain (pehle neeche declare tha -> TDZ crash on save)
    const unlockChk = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    const advUnlocked = unlockChk.rows.length && unlockChk.rows[0].advanced_unlocked;
    const {
      name, address, phone, email, printer_model, printer_name_bw, printer_name_color, price_bw, price_color, payment_mode,
      payment_gateway, razorpay_key_id, razorpay_key_secret,
      cashfree_app_id: cashfreeAppIdRaw, cashfree_secret_key: cashfreeSecretRaw
    } = req.body;
    // Copy-paste (especially mobile) aksar leading/trailing space ya newline
    // chhod deta hai — Cashfree auth silently fail ho jaata hai bina kisi
    // wajah ke. Isliye yahin trim kar dete hain (__KEEP__ sentinel ko chhod ke).
    const cashfree_app_id = typeof cashfreeAppIdRaw === 'string' ? cashfreeAppIdRaw.trim() : cashfreeAppIdRaw;
    const cashfree_secret_key = (typeof cashfreeSecretRaw === 'string' && cashfreeSecretRaw !== '__KEEP__')
      ? cashfreeSecretRaw.trim() : cashfreeSecretRaw;

    // Email — purani shops (jinke paas email nahi tha) yahan se bhar sakti hain.
    // undefined = field bheji hi nahi, to purana waise ka waisa rehta hai.
    let finalEmail;
    if (email !== undefined) {
      const e = String(email || '').trim().toLowerCase();
      if (e && !isValidEmail(e)) return res.status(400).json({ error: 'Sahi email daalo' });
      finalEmail = e;
    }

    const validPaymentModes = ['both', 'counter_only', 'online_only'];
    const finalPaymentMode = validPaymentModes.includes(payment_mode) ? payment_mode : 'both';

    const needsGateway = finalPaymentMode === 'both' || finalPaymentMode === 'online_only';

    // __KEEP__ sentinel ka matlab hai "purana secret hi rakho, change nahi karna"
    let finalRzpSecret = razorpay_key_secret;
    let finalCfSecret = cashfree_secret_key;
    if (razorpay_key_secret === '__KEEP__' || cashfree_secret_key === '__KEEP__') {
      const existing = await pool.query('SELECT razorpay_key_secret, cashfree_secret_key FROM shops WHERE id=$1', [req.shopId]);
      if (existing.rows.length) {
        if (razorpay_key_secret === '__KEEP__') finalRzpSecret = existing.rows[0].razorpay_key_secret;
        if (cashfree_secret_key === '__KEEP__') finalCfSecret = existing.rows[0].cashfree_secret_key;
      }
    }

    if (needsGateway) {
      const validRazorpay = payment_gateway === 'razorpay' && razorpay_key_id && finalRzpSecret;
      const validCashfree = payment_gateway === 'cashfree' && cashfree_app_id && finalCfSecret;
      if (!validRazorpay && !validCashfree) {
        return res.status(400).json({ error: 'Online payment ke liye Razorpay ya Cashfree ki details zaroori hain' });
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
        cashfree_app_id=$11,
        cashfree_secret_key=$12,
        email=COALESCE($13,email),
        printer_name_bw=COALESCE($14,printer_name_bw),
        printer_name_color=COALESCE($15,printer_name_color)
      WHERE id=$16`,
      [name, address, phone, printer_model, price_bw, price_color, finalPaymentMode,
       finalGateway, razorpay_key_id||'', finalRzpSecret||'', cashfree_app_id||'', finalCfSecret||'',
       finalEmail === undefined ? null : finalEmail,
       printer_name_bw, printer_name_color,
       req.shopId]
    );

    const r = await pool.query('SELECT id,name,address,phone,email,printer_model,printer_name_bw,printer_name_color,price_bw,price_color,payment_mode,payment_gateway,razorpay_key_id,cashfree_app_id FROM shops WHERE id=$1', [req.shopId]);
    // Duplex mode alag se (validate karke)
    if (advUnlocked && typeof req.body.duplex_mode === 'string' && ['','auto','manual'].includes(req.body.duplex_mode)) {
      await pool.query('UPDATE shops SET duplex_mode=$1 WHERE id=$2', [req.body.duplex_mode, req.shopId]);
    }
    if (advUnlocked) {
      if (typeof req.body.printer_name_4x6 === 'string')
        await pool.query('UPDATE shops SET printer_name_4x6=$1 WHERE id=$2', [req.body.printer_name_4x6.slice(0,300), req.shopId]);
      if (typeof req.body.printer_name_a3 === 'string')
        await pool.query('UPDATE shops SET printer_name_a3=$1 WHERE id=$2', [req.body.printer_name_a3.slice(0,300), req.shopId]);
      // Advance pricing (4x6 sheet: 4-photo/6-photo; resume: color/bw)
      for (const [key, col] of [['price_4x6_4','price_4x6_4'],['price_4x6_6','price_4x6_6'],['price_4x6_10','price_4x6_10'],
                                ['price_resume_color','price_resume_color'],['price_resume_bw','price_resume_bw']]) {
        const v = parsePrice(req.body[key]);
        if (v !== null) {
          await pool.query(`UPDATE shops SET ${col}=$1 WHERE id=$2`, [v, req.shopId]);
        }
      }
    }
    // Duplex prices — sirf tab store jab valid non-negative int mile
    const pbwd = parsePrice(req.body.price_bw_duplex);
    const pcld = parsePrice(req.body.price_color_duplex);
    if (pbwd !== null) await pool.query('UPDATE shops SET price_bw_duplex=$1 WHERE id=$2', [pbwd, req.shopId]);
    if (pcld !== null) await pool.query('UPDATE shops SET price_color_duplex=$1 WHERE id=$2', [pcld, req.shopId]);
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


    if (!(await verifyPassword(currentPassword || '', r.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Current password galat hai' });
    }

    const newHash = await hashPassword(newPassword);
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [newHash, req.shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/jobs', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,file_name,amount,copies,color_mode,total_pages,selected_pages,duplex,status,payment_status,payment_method,failure_reason,file_deleted,created_at,printed_at FROM print_jobs WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.shopId]
    );
    res.json({ jobs: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// DIRECT UPLOAD — Customer → Cloudinary (Render ko file chhuti hi nahi)
//
// Purana flow: Customer → Render → Cloudinary. 10 MB file par Render ko
// 10 MB receive + ~13 MB bhejna padta tha (base64 33% bada kar deta hai)
// = ~23 MB per file. Render ka 5 GB isi me udd raha tha.
//
// Naya flow: Render sirf ek signature deta hai (~200 bytes), customer
// seedha Cloudinary ko file bhejta hai, phir Render ko sirf public_id
// aata hai (~300 bytes). Bandwidth ~99% bach jaata hai.
//
// Security: signature ke saath ek HMAC token bhi jaata hai. Confirm par
// wahi token match hona chahiye AUR Cloudinary se confirm hona chahiye ki
// file sach me wahan hai — warna koi jhoota public_id bhej kar bina file
// ke job bana sakta tha.
// ══════════════════════════════════════════════════════════════
function uploadTokenFor(shopId, publicId) {
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(`${shopId}|${publicId}`).digest('hex').slice(0, 32);
}

app.post('/api/upload/sign', async (req, res) => {
  try {
    const shopId = String(req.body.shopId || '').trim();
    if (!shopId) return res.status(400).json({ error: 'Shop ID required' });
    if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) {
      return res.status(500).json({ error: 'Cloudinary configure nahi hai' });
    }
    const s = await pool.query('SELECT id FROM shops WHERE id=$1', [shopId]);
    if (!s.rows.length) return res.status(404).json({ error: 'Shop not found' });

    const timestamp = Math.round(Date.now() / 1000);
    const publicId = 'qrprint_' + uuidv4().substring(0, 8);
    const signature = crypto.createHash('sha256')
      .update(`public_id=${publicId}&timestamp=${timestamp}${CLD_API_SECRET}`).digest('hex');

    res.json({
      success: true, cloudName: CLOUD_NAME, apiKey: CLD_API_KEY,
      timestamp, publicId, signature,
      uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/raw/upload`,
      uploadToken: uploadTokenFor(shopId, publicId)
    });
  } catch(err) {
    console.error('Upload sign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cloudinary se confirm karo ki file sach me wahan hai (aur uska asli URL lo)
function cloudinaryResourceInfo(publicId) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUD_NAME}/resources/raw/upload/${encodeURIComponent(publicId)}`,
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${CLD_API_KEY}:${CLD_API_SECRET}`).toString('base64') }
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (resp.statusCode !== 200) return reject(new Error(j?.error?.message || 'File Cloudinary par nahi mili'));
          resolve(j);
        } catch(e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => { r.destroy(); reject(new Error('Cloudinary timeout')); });
    r.end();
  });
}

app.post('/api/upload/confirm', async (req, res) => {
  try {
    const b = req.body || {};
    const shopId = String(b.shopId || '').trim();
    // Cloudinary raw upload par public_id ke aage extension jod deta hai
    // (qrprint_abc -> qrprint_abc.pdf). Isliye do alag values aati hain:
    //   signedPublicId = jo humne sign kiya (token isi se bana)
    //   publicId       = jo Cloudinary ne wapas diya (lookup isi se hoga)
    const publicId = String(b.publicId || '').trim();
    const signedPublicId = String(b.signedPublicId || b.publicId || '').trim();
    const token = String(b.uploadToken || '').trim();
    if (!shopId || !publicId) return res.status(400).json({ error: 'shopId aur publicId chahiye' });

    // 1) Token match — ye public_id humne hi is shop ke liye issue kiya tha?
    if (token !== uploadTokenFor(shopId, signedPublicId)) {
      return res.status(403).json({ error: 'Upload token match nahi hua' });
    }
    // 2) Cloudinary ka public_id wahi hona chahiye jo humne sign kiya
    //    (bas extension juda ho sakta hai) — warna koi doosri file point kar sakta hai
    if (publicId !== signedPublicId && !publicId.startsWith(signedPublicId + '.')) {
      return res.status(403).json({ error: 'Public ID match nahi hua' });
    }

    const shopResult = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const shop = shopResult.rows[0];

    // 3) File ka URL.
    //    Security pehle hi ho chuki hai: HMAC token proof hai ki ye public_id
    //    HUMNE isi shop ke liye issue kiya tha, aur public_id prefix bhi match
    //    kar chuka hai. Isliye URL banane ke liye Cloudinary se poochna
    //    ZAROORI nahi — aur wahi Admin API call 500 de raha tha.
    //
    //    Rasta: URL client se lo par crypto-validate karo; na mile to khud
    //    bana lo (raw upload ka URL format fixed hai). Cloudinary se verify
    //    sirf "best effort" — fail ho to bhi job banega (file sach me na hui
    //    to agent download par pata chal jayega aur job fail ho jayega).
    let fileUrl = String(b.secureUrl || '').trim();
    let cldInfo = null;
    const okHost = fileUrl.startsWith(`https://res.cloudinary.com/${CLOUD_NAME}/`);
    if (!fileUrl || !okHost || !fileUrl.includes(signedPublicId)) {
      // Purana client ho ya URL galat — khud bana lo (deterministic)
      fileUrl = `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/${publicId}`;
    }

    try {
      cldInfo = await cloudinaryResourceInfo(publicId);
      if (cldInfo && (cldInfo.secure_url || cldInfo.url)) fileUrl = cldInfo.secure_url || cldInfo.url;
    } catch (e) {
      console.warn(`Cloudinary verify skip (${e.message}) — URL khud bana liya: ${publicId}`);
    }

    const jobId = 'JOB_' + uuidv4().substring(0, 10).toUpperCase();
    const fileName = String(b.fileName || 'document.pdf').slice(0, 200);
    const fileType = (path.extname(fileName).replace('.', '').toLowerCase()) || 'pdf';
    const numCopies = parseInt(b.copies) || 1;
    const numPages = parseInt(b.totalPages) || 1;
    const colorMode = b.colorMode === 'color' ? 'color' : 'bw';
    const pricePerPage = colorMode === 'color' ? shop.price_color : shop.price_bw;
    const amount = pricePerPage * numPages * numCopies;

    await pool.query(
      'INSERT INTO print_jobs (id,shop_id,file_name,file_url,file_public_id,file_type,total_pages,copies,color_mode,amount,paper_size,orientation,service,photo_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [jobId, shopId, fileName, fileUrl, publicId, fileType, numPages, numCopies, colorMode, amount,
       ['4x6','a4','a5','letter','legal','a3','a2','a1'].includes(b.paperSize) ? b.paperSize : 'a4',
       ['portrait','landscape'].includes(b.orientation) ? b.orientation : 'portrait',
       ['doc','resume','photo4x6'].includes(b.service) ? b.service : 'doc',
       [4,6].includes(parseInt(b.photoCount)) ? parseInt(b.photoCount) : 0]
    );
    console.log(`Direct upload confirmed: ${jobId} (${(cldInfo && cldInfo.bytes) || '?'} bytes, Render se nahi guzri)`);
    res.json({ success: true, jobId, fileName, fileType, amount,
      copies: numCopies, totalPages: numPages, colorMode });
  } catch(err) {
    console.error('Upload confirm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Purana upload (fallback) — direct upload fail ho to isse kaam chalta rahe ──
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
      'INSERT INTO print_jobs (id,shop_id,file_name,file_url,file_public_id,file_type,total_pages,copies,color_mode,amount,paper_size,orientation,service,photo_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [jobId, shopId, req.file.originalname, cloudResult.url, cloudResult.publicId, fileType, numPages, numCopies, colorMode||'bw', amount,
       ['4x6','a4','a5','letter','legal','a3','a2','a1'].includes(req.body.paperSize) ? req.body.paperSize : 'a4',
       ['portrait','landscape'].includes(req.body.orientation) ? req.body.orientation : 'portrait',
       ['doc','resume','photo4x6'].includes(req.body.service) ? req.body.service : 'doc',
       [4,6].includes(parseInt(req.body.photoCount)) ? parseInt(req.body.photoCount) : 0]
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

// ═══════════════════════════════════════════════════════════════════
//  CASHFREE HELPERS
// ═══════════════════════════════════════════════════════════════════

// Sirf LIVE — sandbox nahi. Test karna ho to Cashfree dashboard ki
// test keys nahi chalengi, live keys hi lagani hongi.
const CASHFREE_HOST = 'api.cashfree.com';
const CASHFREE_API_VERSION = '2025-01-01';

// Kabhi throw nahi karta — hamesha object deta hai (sendViaBrevo jaisa hi pattern)
function cashfreeRequest(method, path, appId, secretKey, body) {
  return new Promise((resolve) => {
    try {
      const headers = {
        'x-api-version': CASHFREE_API_VERSION,
        'x-client-id': String(appId || '').trim(),
        'x-client-secret': String(secretKey || '').trim(),
        'accept': 'application/json'
      };
      if (body) {
        headers['content-type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const r = https.request({ hostname: CASHFREE_HOST, path, method, headers }, (resp) => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch (e) { resolve({ message: 'Cashfree ka jawab samajh nahi aaya (HTTP ' + resp.statusCode + ')' }); }
        });
      });
      r.on('error', e => resolve({ message: e.message }));
      r.setTimeout(20000, () => { r.destroy(); resolve({ message: 'Cashfree timeout' }); });
      if (body) r.write(body);
      r.end();
    } catch (e) { resolve({ message: e.message }); }
  });
}

// Webhook signature: base64( HMAC-SHA256( secret, timestamp + rawBody ) )
// RAW body chahiye — JSON.parse kiya hua object se signature KABHI match nahi karega.
function verifyCashfreeWebhook(secretKey, timestamp, rawBody, signature) {
  try {
    if (!secretKey || !timestamp || !signature) return false;
    const expected = crypto.createHmac('sha256', secretKey)
      .update(String(timestamp) + String(rawBody)).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    // timingSafeEqual barabar length maangta hai — warna throw kar deta hai
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// ─── ONLINE PAYMENT: Har shop apni Razorpay/Cashfree keys use karta hai ───
// (Paisa seedha shop owner ke account mein jaata hai, system owner ke account mein nahi)

app.post('/api/payment/online/create', async (req, res) => {
  try {
    const { jobId, colorMode, copies, totalPages, selectedPages } = req.body;

    const jobCheck = await pool.query(
      `SELECT j.*, s.price_bw, s.price_color, s.price_bw_duplex, s.price_color_duplex, s.price_4x6_4, s.price_4x6_6, s.price_4x6_10, s.price_resume_color, s.price_resume_bw, s.payment_mode, s.payment_gateway, s.paused, s.plan_type, s.paid_until,
              s.razorpay_key_id, s.razorpay_key_secret,
              s.cashfree_app_id, s.cashfree_secret_key
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`, [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error:'Job not found' });
    if (jobCheck.rows[0].paused) return res.status(403).json({ error: '🏪 Shop abhi band hai — baad mein try karo' });
    if (!isSubscriptionActive(jobCheck.rows[0])) return res.status(403).json({ error: '⏸️ Shop inactive hai — owner ko subscription renew karni hai' });

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
    // Manual duplex par copies HAMESHA 1 — print bhi aur BILL bhi (warna
    // customer se N copies ka paisa, print 1 ka)
    const effCopies = (finalDuplex && shopDuplexMode === 'manual') ? 1 : finalCopies;
    const finalSelectedPages = parseSelectedPages(selectedPages, job.total_pages);
    // Duplex prices: agar owner ne set kiye hain (>0) to use, warna normal
    // rate hi lagta hai (backwards-compat + accidentally 0 rakhna safe)
    const _rateBw    = (finalDuplex && parseInt(job.price_bw_duplex) > 0)    ? job.price_bw_duplex    : job.price_bw;
    const _rateColor = (finalDuplex && parseInt(job.price_color_duplex) > 0) ? job.price_color_duplex : job.price_color;
    const pricePerPage = finalColorMode === 'color' ? _rateColor : _rateBw;
    // ── ADVANCE SERVICE PRICING ── resume: owner ka resume rate (color/bw)
    // x copies; photo4x6: sheet rate (4/6 photo) x copies; rate 0 ho to
    // normal per-page pricing fallback
    let amount = pricePerPage * finalPages * effCopies;
    if (job.service === 'resume') {
      const rRate = finalColorMode === 'color' ? (parseInt(job.price_resume_color) || 0) : (parseInt(job.price_resume_bw) || 0);
      if (rRate > 0) amount = rRate * effCopies;
    } else if (job.service === 'photo4x6') {
      const pRate = job.photo_count === 10 ? (parseInt(job.price_4x6_10) || 0)
                 : job.photo_count === 6 ? (parseInt(job.price_4x6_6) || 0)
                 : (parseInt(job.price_4x6_4) || 0);
      if (pRate > 0) amount = pRate * effCopies;
    }

    // Common job update (gateway se pehle)
    await pool.query(
      'UPDATE print_jobs SET color_mode=$1, copies=$2, total_pages=$3, selected_pages=$4, amount=$5, duplex=$6 WHERE id=$7',
      [finalColorMode, effCopies, finalPages, finalSelectedPages.join(','), amount, finalDuplex, jobId]
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
        notes: { jobId, colorMode: finalColorMode, copies: effCopies, pages: finalPages }
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

    if (job.payment_gateway === 'cashfree') {
      if (!job.cashfree_app_id || !job.cashfree_secret_key) {
        return res.status(400).json({ error: 'Shop ki Cashfree keys set nahi hain' });
      }

      // DEBUG log — Render logs me dikhega ki create call hua aur kya bana
      console.log('[Cashfree] create attempt job=' + jobId + ' shop=' + job.shop_id + ' amount=' + amount + ' appid_len=' + String(job.cashfree_app_id).length);

      // ⚠️ SABSE ZAROORI FARAK: Razorpay PAISE leta hai (₹10 = 1000),
      // Cashfree RUPEES leta hai (₹10 = 10). Yahan *100 kabhi mat karna —
      // warna customer se 100 guna paisa kat jaayega.
      // ⚠️ Cashfree order_id GLOBALLY UNIQUE hona chahiye — same id dobara
      // bhejne par "order with same id is already present" error aata hai.
      // Pehle 'QSP_'+jobId fixed tha, isliye customer ke DOBARA "Pay" dabane
      // (retry / page reload / abandon) par same id jaata aur Cashfree reject
      // kar deta tha (Razorpay me ye dikkat nahi kyunki wahan jobId sirf
      // receipt hai, order id Razorpay khud unique banata hai). Ab har attempt
      // ka fresh unique id. Webhook aur status dono STORED payment_id se job
      // dhoondhte hain (order_id format se nahi), isliye kuch aur badalne ki
      // zaroorat nahi. Length ~31 chars (Cashfree limit 50), sirf A-Z 0-9 _.
      const cfOrderId = 'QSP_' + jobId + '_' + Date.now().toString(36).toUpperCase()
        + crypto.randomBytes(4).toString('hex').toUpperCase();
      // Cashfree ko customer_phone chahiye hi chahiye, par hum customer ka
      // number lete hi nahi (QR scan karke seedha print — koi login nahi).
      // Isliye placeholder. Payment par iska koi asar nahi padta.
      const customerPhone = '9999999999';

      const cfBody = JSON.stringify({
        order_id: cfOrderId,
        order_amount: Number(amount),          // rupees, paise NAHI
        order_currency: 'INR',
        customer_details: {
          customer_id: 'CUST_' + jobId,
          customer_phone: customerPhone
        },
        order_meta: {
          return_url: `${BASE_URL}/print-success?jobId=${jobId}&gateway=cashfree`,
          notify_url: `${BASE_URL}/api/payment/cashfree/webhook`
        },
        order_note: 'Print job ' + jobId
      });

      const cfOrder = await cashfreeRequest('POST', '/pg/orders',
        job.cashfree_app_id, job.cashfree_secret_key, cfBody);

      if (!cfOrder || !cfOrder.payment_session_id) {
        console.error('[Cashfree] order FAILED job=' + jobId + ' resp=' + JSON.stringify(cfOrder).slice(0, 400));
        return res.status(400).json({
          error: 'Cashfree order nahi bana — shop ki keys check karo',
          details: (cfOrder && (cfOrder.message || cfOrder.type || cfOrder.code)) || 'unknown'
        });
      }

      console.log('[Cashfree] order OK job=' + jobId + ' cfid=' + cfOrderId + ' session=' + String(cfOrder.payment_session_id).slice(0, 22) + '...');

      // cf_order_id nahi, HAMARA order_id save karte hain — webhook aur
      // status dono isi se job dhoondhte hain
      await pool.query(
        'UPDATE print_jobs SET payment_id=$1, payment_method=$2 WHERE id=$3',
        [cfOrderId, 'online', jobId]
      );

      return res.json({
        success: true,
        gateway: 'cashfree',
        paymentSessionId: cfOrder.payment_session_id,
        orderId: cfOrderId,
        amount,
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

// Cashfree webhook — payment hone par Cashfree yahan call karta hai.
// Signature RAW body par verify hoti hai (line 62 wala req.rawBody).
app.post('/api/payment/cashfree/webhook', async (req, res) => {
  try {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (!rawBody) return res.status(400).json({ error: 'empty body' });

    let payload = {};
    try { payload = JSON.parse(rawBody); } catch (e) {
      return res.status(400).json({ error: 'bad json' });
    }

    const orderId = (payload.data && payload.data.order && payload.data.order.order_id) || '';
    if (!orderId) return res.json({ success: true });   // koi aur event — ignore

    // Multi-tenant: har shop ki apni key hai. Isliye pehle order se shop
    // dhoondho, tabhi uska secret milega jisse signature check hogi.
    // Body sirf order_id nikalne ke liye padhi hai — VERIFY se pehle kuch
    // bhi change nahi kiya jaata.
    const jr = await pool.query(
      `SELECT j.id AS job_id, j.payment_status, s.cashfree_secret_key
       FROM print_jobs j JOIN shops s ON j.shop_id = s.id
       WHERE j.payment_id = $1`, [orderId]);
    if (!jr.rows.length) return res.json({ success: true });
    const job = jr.rows[0];

    // Replay guard: 5 minute se purana webhook nahi lenge
    const wts = parseInt(req.headers['x-webhook-timestamp'], 10);
    if (!wts || Math.abs(Date.now() / 1000 - wts) > 300) {
      console.warn('Cashfree webhook: timestamp purana/galat |', orderId);
      return res.status(401).json({ error: 'stale timestamp' });
    }

    const sigOk = verifyCashfreeWebhook(
      job.cashfree_secret_key,
      req.headers['x-webhook-timestamp'],
      rawBody,
      req.headers['x-webhook-signature']
    );
    if (!sigOk) {
      console.warn('Cashfree webhook: signature match nahi hui |', orderId);
      return res.status(401).json({ error: 'bad signature' });
    }

    const payStatus = (payload.data && payload.data.payment && payload.data.payment.payment_status) || '';
    if (payStatus === 'SUCCESS') {
      // payment_id ko chhedte nahi — wahi hamara stable lookup key hai
      const upd = await pool.query(
        `UPDATE print_jobs SET payment_status='paid', status='queued'
         WHERE id=$1 AND payment_status <> 'paid' RETURNING id`, [job.job_id]);
      if (upd.rows.length) console.log(`Cashfree payment success: ${orderId} | job ${job.job_id}`);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Cashfree webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cashfree se wapas aane ke baad status check (frontend polling ke liye).
// Webhook late aaye ya na aaye, isse customer atakta nahi.
app.get('/api/payment/cashfree/status/:jobId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT j.payment_id, j.payment_status, s.cashfree_app_id, s.cashfree_secret_key
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`,
      [req.params.jobId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = r.rows[0];

    // Webhook pehle aa gaya to DB me already paid hai — seedha bata do
    if (job.payment_status === 'paid') {
      return res.json({ success: true, status: 'PAID' });
    }
    if (!job.payment_id || !job.cashfree_app_id || !job.cashfree_secret_key) {
      return res.json({ success: true, status: 'PENDING' });
    }

    const order = await cashfreeRequest('GET', '/pg/orders/' + encodeURIComponent(job.payment_id),
      job.cashfree_app_id, job.cashfree_secret_key, null);

    const status = (order && order.order_status) || 'PENDING';
    if (status === 'PAID') {
      await pool.query(
        `UPDATE print_jobs SET payment_status='paid', status='queued'
         WHERE id=$1 AND payment_status <> 'paid'`, [req.params.jobId]);
      console.log(`Cashfree status-check paid: ${job.payment_id}`);
    }
    res.json({ success: true, status });
  } catch (err) {
    console.error('Cashfree status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payment/counter', async (req, res) => {
  try {
    const { jobId, colorMode, copies, totalPages, selectedPages } = req.body;
    if (!jobId) return res.status(400).json({ error:'Job ID required' });

    const jobCheck = await pool.query(
      'SELECT j.*, s.price_bw, s.price_color, s.price_bw_duplex, s.price_color_duplex, s.price_4x6_4, s.price_4x6_6, s.price_4x6_10, s.price_resume_color, s.price_resume_bw, s.payment_mode, s.paused, s.plan_type, s.paid_until FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1', [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error:'Job not found' });

    const job = jobCheck.rows[0];
    if (job.paused) return res.status(403).json({ error: '🏪 Shop abhi band hai — baad mein try karo' });
    if (!isSubscriptionActive(job)) return res.status(403).json({ error: '⏸️ Shop inactive hai — owner ko subscription renew karni hai' });

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
    // Manual duplex par copies HAMESHA 1 — print bhi aur BILL bhi (warna
    // customer se N copies ka paisa, print 1 ka)
    const effCopies = (finalDuplex && shopDuplexMode === 'manual') ? 1 : finalCopies;
    const finalSelectedPages = parseSelectedPages(selectedPages, job.total_pages);
    // Duplex prices: agar owner ne set kiye hain (>0) to use, warna normal
    // rate hi lagta hai (backwards-compat + accidentally 0 rakhna safe)
    const _rateBw    = (finalDuplex && parseInt(job.price_bw_duplex) > 0)    ? job.price_bw_duplex    : job.price_bw;
    const _rateColor = (finalDuplex && parseInt(job.price_color_duplex) > 0) ? job.price_color_duplex : job.price_color;
    const pricePerPage = finalColorMode === 'color' ? _rateColor : _rateBw;
    // ── ADVANCE SERVICE PRICING ── resume: owner ka resume rate (color/bw)
    // x copies; photo4x6: sheet rate (4/6 photo) x copies; rate 0 ho to
    // normal per-page pricing fallback
    let amount = pricePerPage * finalPages * effCopies;
    if (job.service === 'resume') {
      const rRate = finalColorMode === 'color' ? (parseInt(job.price_resume_color) || 0) : (parseInt(job.price_resume_bw) || 0);
      if (rRate > 0) amount = rRate * effCopies;
    } else if (job.service === 'photo4x6') {
      const pRate = job.photo_count === 10 ? (parseInt(job.price_4x6_10) || 0)
                 : job.photo_count === 6 ? (parseInt(job.price_4x6_6) || 0)
                 : (parseInt(job.price_4x6_4) || 0);
      if (pRate > 0) amount = pRate * effCopies;
    }
    const txnId = 'COUNTER_' + uuidv4().substring(0,10).toUpperCase();

    await pool.query(
      'UPDATE print_jobs SET payment_status=$1, status=$2, payment_id=$3, color_mode=$4, copies=$5, total_pages=$6, selected_pages=$7, amount=$8, payment_method=$9, duplex=$10 WHERE id=$11',
      ['paid', 'queued', txnId, finalColorMode, effCopies, finalPages, finalSelectedPages.join(','), amount, 'counter', finalDuplex, jobId]
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
    // Agent heartbeat — dashboard ka Online/Offline indicator isi se chalta hai.
    // Agent apna version bhi bhejta hai (?v=), taaki superadmin dekh sake kis
    // shop par kaun sa version chal raha hai.
    // Heartbeat + shop info EK HI query me (pehle do alag queries thi).
    // Har agent har 5 second me poll karta hai — ek query kam matlab
    // roz lakhon round-trip kam, aur utna hi bandwidth bacha.
    const _av = parseInt(req.query.v, 10);
    const shopRow = await pool.query(
      `UPDATE shops
         SET agent_last_seen = NOW(),
             agent_version   = COALESCE($2, agent_version)
       WHERE id = $1
       RETURNING demo, demo_expires_at`,
      [req.params.shopId, (Number.isInteger(_av) && _av > 0 && _av < 100000) ? _av : null]);
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
                 j.paper_size,j.orientation,
                 s.printer_name_bw,s.printer_name_color,s.printer_name_4x6,s.printer_name_a3,s.duplex_mode`,
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
    // Sirf active job hi 'printed' ban sakta hai. Late/duplicate report par
    // (job pehle hi printed/failed) chupchaap success — agent retry karta
    // hai, use error nahi chahiye. Requeued ('queued') job ka late complete
    // aana ACHHA hai — matlab print asal me ho chuka tha, dubara nahi hoga.
    const result = await pool.query(
      `UPDATE print_jobs SET status=$1, printed_at=NOW()
       WHERE id=$2 AND status NOT IN ('printed','failed','abandoned')
       RETURNING file_public_id`,
      ['printed', req.params.jobId]
    );
    if (!result.rows.length) return res.json({ success: true, already: true });
    if (result.rows.length && result.rows[0].file_public_id) {
      await deleteFromCloudinary(result.rows[0].file_public_id);
      await pool.query('UPDATE print_jobs SET file_deleted=true WHERE id=$1', [req.params.jobId]);
    }
    console.log(`Printed + Deleted: ${req.params.jobId}`);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/failed/:jobId', async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || '';
    const result = await pool.query(
      `UPDATE print_jobs SET status=$1, failure_reason=$2
       WHERE id=$3 AND status NOT IN ('printed','abandoned')
       RETURNING file_public_id`,
      ['failed', reason.slice(0, 200), req.params.jobId]);
    if (!result.rows.length) return res.json({ success: true, already: true });
    // Deny/fail par bhi customer ki file Cloudinary se saaf — warna orphan
    // files jama hoti rehti (privacy + storage dono)
    if (result.rows.length && result.rows[0].file_public_id) {
      await deleteFromCloudinary(result.rows[0].file_public_id);
      await pool.query('UPDATE print_jobs SET file_deleted=true WHERE id=$1', [req.params.jobId]);
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

app.post('/api/superadmin/login', loginLimiter, async (req, res) => {
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

// ═══ ADMIN BROADCAST (superadmin → sabhi shops ko dikhne wala message) ═══
// Superadmin ek message likhta hai, wo har shop ke Overview par dikhta hai.
// system_settings (key/value) table reuse — koi nayi table nahi.

// Shop panel isse fetch karta hai (public, token nahi chahiye)
app.get('/api/admin-broadcast', async (req, res) => {
  try {
    // White-label ki shop ko RESELLER ka message dikhega, hamara nahi —
    // warna do alag brand ke message ek hi dashboard me mix ho jaate.
    const shopId = String(req.query.shopId || '').trim();
    if (shopId) {
      const s = await pool.query('SELECT whitelabel_id FROM shops WHERE id=$1', [shopId]);
      const wlId = s.rows[0]?.whitelabel_id || '';
      if (wlId) {
        const w = await pool.query('SELECT broadcast FROM whitelabels WHERE id=$1', [wlId]);
        return res.json({ message: w.rows[0]?.broadcast || '' });
      }
    }
    const r = await pool.query("SELECT value FROM system_settings WHERE key='admin_broadcast'");
    res.json({ message: r.rows.length ? r.rows[0].value : '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Superadmin isse save karta hai (khali bhejo to message hat jayega)
app.post('/api/superadmin/admin-broadcast', verifySuperAdmin, async (req, res) => {
  try {
    const message = (req.body && typeof req.body.message === 'string') ? req.body.message.trim().slice(0, 500) : '';
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('admin_broadcast', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [message]
    );
    res.json({ success: true, message });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ QR REGENERATE (sabhi shops ke QR current BASE_URL se naye banao) ═══
// Kyun: purane QR tab bane the jab BASE_URL onrender.com tha — us image ke
// andar purana URL encode hai. Ye route har shop ka QR dobara banata hai
// current BASE_URL se. Jinke QR pehle se sahi (qrseprint.in) hain, unka
// naya QR bilkul same banega — koi nuksaan nahi. Jinke purane onrender
// wale hain, wo sahi ho jayenge.
app.post('/api/superadmin/regenerate-qrs', verifySuperAdmin, async (req, res) => {
  try {
    const shops = await pool.query('SELECT id FROM shops');
    let done = 0, failed = 0;
    for (const row of shops.rows) {
      try {
        const qrUrl = `${BASE_URL}/print/${row.id}`;
        const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
        await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, row.id]);
        done++;
      } catch (e) {
        failed++;
        console.error(`QR regen fail for ${row.id}:`, e.message);
      }
    }
    res.json({ success: true, total: shops.rows.length, regenerated: done, failed, base_url: BASE_URL });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Superadmin -> shop agent notification (counter-popup jaisa)
app.post('/api/superadmin/notify-shop', verifySuperAdmin, async (req, res) => {
  try {
    const { shop_id, message } = req.body || {};
    if (!shop_id) return res.status(400).json({ error: 'shop_id chahiye' });
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['notify_' + shop_id, message || 'Any Problem in Printing? Contact Admin']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Agent isse poll ke saath uthata hai, dikha ke ack karta hai
app.get('/api/agent/notification/:shopId', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key=$1", ['notify_' + req.params.shopId]);
    res.json({ message: r.rows.length ? r.rows[0].value : '' });
  } catch (err) { res.json({ message: '' }); }
});
app.post('/api/agent/notification-ack/:shopId', async (req, res) => {
  try {
    await pool.query("DELETE FROM system_settings WHERE key=$1", ['notify_' + req.params.shopId]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false }); }
});

app.get('/api/superadmin/overview', verifySuperAdmin, async (req, res) => {
  try {
    // Overview ab sirf shop ki ginti dikhata hai — paisa Analytics me hai,
    // do jagah same number rakhne se confusion hota hai.
    const shopCount = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE demo = false AND setup_paid = true)::int  AS active,
        COUNT(*) FILTER (WHERE demo = false AND setup_paid = false)::int AS pending,
        COUNT(*) FILTER (WHERE demo = true
              AND (demo_expires_at IS NULL OR demo_expires_at > NOW()))::int AS demo_live,
        COUNT(*) FILTER (WHERE demo = true
              AND demo_expires_at IS NOT NULL AND demo_expires_at <= NOW())::int AS demo_expired,
        COUNT(*) FILTER (WHERE demo = false AND plan_type = 'monthly')::int AS monthly
      FROM shops`);
    const earnings = await pool.query(`
      SELECT 
        COALESCE(SUM(setup_amount) FILTER (WHERE setup_paid), 0) as total_setup_revenue,
        COUNT(*) FILTER (WHERE setup_paid) as paid_shops
      FROM shops
    `);
    const printEarnings = await pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM print_jobs WHERE payment_status='paid'`);

    res.json({
      total_shops:   shopCount.rows[0].total,
      active_shops:  shopCount.rows[0].active,
      pending_shops: shopCount.rows[0].pending,
      demo_shops:    shopCount.rows[0].demo_live,
      demo_expired:  shopCount.rows[0].demo_expired,
      monthly_shops: shopCount.rows[0].monthly,
      total_setup_revenue: parseInt(earnings.rows[0].total_setup_revenue),
      total_print_volume: parseInt(printEarnings.rows[0].total)
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/shops', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, name, address, phone, printer_model, price_bw, price_color,
             payment_mode, payment_gateway, setup_paid, setup_amount, created_at,
             demo, plan_type, paid_until, advanced_unlocked, agent_last_seen, agent_version, onboarded_by
      FROM shops ORDER BY created_at DESC
    `);
    res.json({ shops: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Superadmin: kisi bhi shop (paid ya demo) ka PC printer list + selection ───
// Agent har 30 min apni printer list bhejta hai (system_settings.printers_<id>).
// Superadmin yahan se dekh sakta hai aur kaun sa printer kis kaam ke liye
// use hoga wo save kar sakta hai.
app.get('/api/superadmin/shop/:shopId/printers', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const s = await pool.query(
      `SELECT id, name, demo, payment_mode, agent_last_seen,
              printer_name_bw, printer_name_color, printer_name_4x6, printer_name_a3
       FROM shops WHERE id=$1`, [shopId]);
    if (!s.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const p = await pool.query(
      'SELECT value, updated_at FROM system_settings WHERE key=$1', [`printers_${shopId}`]);
    let available = [];
    if (p.rows.length) { try { available = JSON.parse(p.rows[0].value) || []; } catch (e) { available = []; } }
    res.json({
      shop: s.rows[0],
      available: Array.isArray(available) ? available : [],
      reported_at: p.rows.length ? p.rows[0].updated_at : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Printer selection + payment mode save.
// SAKHT NIYAM: superadmin sirf 'counter_only' set kar sakta hai. Online/Both
// shop owner ko khud apne login se karna hoga (kyunki usme uski apni
// Razorpay/Cashfree keys chahiye hoti hain).
app.put('/api/superadmin/shop/:shopId/printers', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const b = req.body || {};
    const chk = await pool.query('SELECT id FROM shops WHERE id=$1', [shopId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });

    const clean = v => (typeof v === 'string' ? v.trim().slice(0, 300) : null);
    const bw = clean(b.printer_name_bw);
    const color = clean(b.printer_name_color);
    const p4x6 = clean(b.printer_name_4x6);
    const a3 = clean(b.printer_name_a3);

    let setPayment = false;
    if (b.payment_mode !== undefined && b.payment_mode !== null && b.payment_mode !== '') {
      if (b.payment_mode !== 'counter_only') {
        return res.status(403).json({
          error: 'Superadmin sirf "Counter par payment" set kar sakta hai. Online/Both ke liye shop owner ko khud login karke apni payment keys daalni hongi.'
        });
      }
      setPayment = true;
    }

    await pool.query(
      `UPDATE shops SET
         printer_name_bw    = COALESCE($2, printer_name_bw),
         printer_name_color = COALESCE($3, printer_name_color),
         printer_name_4x6   = COALESCE($4, printer_name_4x6),
         printer_name_a3    = COALESCE($5, printer_name_a3),
         payment_mode       = CASE WHEN $6 THEN 'counter_only' ELSE payment_mode END
       WHERE id=$1`,
      [shopId, bw, color, p4x6, a3, setPayment]);

    const out = await pool.query(
      `SELECT payment_mode, printer_name_bw, printer_name_color, printer_name_4x6, printer_name_a3
       FROM shops WHERE id=$1`, [shopId]);
    res.json({ success: true, shop: out.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const chk = await pool.query('SELECT setup_paid, setup_amount FROM shops WHERE id=$1', [shopId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    // Delete-able: PENDING (setup_paid=false — naye ho ya purane) YA
    // legacy paid-₹0. setup_amount register par hi store hota hai (payment
    // se pehle), isliye amount>0 hona payment ka saboot NAHI — setup_paid hai.
    const deletable = !chk.rows[0].setup_paid || (chk.rows[0].setup_amount || 0) === 0;
    if (!deletable) {
      return res.status(403).json({ error: 'Paid/Active shop delete nahi ho sakti' });
    }
    await pool.query('DELETE FROM print_jobs WHERE shop_id=$1', [shopId]);
    await pool.query("DELETE FROM shops WHERE id=$1 AND (setup_paid=false OR COALESCE(setup_amount,0)=0)", [shopId]);
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
app.get('/api/superadmin/homepage-config', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
    res.json(r.rows.length ? JSON.parse(r.rows[0].value) : {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/superadmin/homepage-config', verifySuperAdmin, async (req, res) => {
  try {
    // Sanitize: sirf known keys, arrays ko string-array me force
    const cur = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
    const cfg = cur.rows.length ? JSON.parse(cur.rows[0].value) : {};
    const b = req.body || {};
    const strKeys = ['logoUrl','statShops','statPrints','supportEmail','supportPhone','instagram','facebook','youtube'];
    for (const k of strKeys) if (typeof b[k] === 'string') cfg[k] = b[k].slice(0, 300);
    // Social links: https:// missing ho ya sirf username ho to bhi sahi URL banao
    const SOC_BASE = { instagram: 'instagram.com/', facebook: 'facebook.com/', youtube: 'youtube.com/@' };
    for (const k of Object.keys(SOC_BASE)) {
      let v = String(cfg[k] || '').trim();
      if (!v) { cfg[k] = ''; continue; }
      if (/^(https?:)?\/\//i.test(v)) {
        v = v.replace(/^\/\//, 'https://');
      } else {
        v = v.replace(/^\/+/, '').replace(/^@/, '');
        v = /[.\/]/.test(v) ? 'https://' + v : 'https://' + SOC_BASE[k] + v;
      }
      cfg[k] = v.slice(0, 300);
    }
    if (typeof b.showStats === 'boolean') cfg.showStats = b.showStats;
    // Homepage ke saare button/text (data-cfg keys) — ek hi object me
    if (b.texts && typeof b.texts === 'object' && !Array.isArray(b.texts)) {
      const t = {};
      let n = 0;
      for (const k of Object.keys(b.texts)) {
        if (n >= 550) break;
        if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
        const v = b.texts[k];
        if (typeof v !== 'string') continue;
        const s = v.slice(0, 800).trim();
        if (s) { t[k] = s; n++; }
      }
      cfg.texts = t;
    }
    for (const k of ['planDemo','planMonthly','planOnetime']) {
      if (Array.isArray(b[k])) cfg[k] = b[k].filter(x => typeof x === 'string').map(x => x.slice(0,120)).slice(0, 20);
    }
    if (Array.isArray(b.faqs)) {
      cfg.faqs = b.faqs
        .filter(f => f && typeof f.q === 'string' && typeof f.a === 'string' && f.q.trim())
        .map(f => ({ q: f.q.trim().slice(0,200), a: f.a.trim().slice(0,1000) }))
        .slice(0, 30);
    }
    await pool.query("UPDATE system_settings SET value=$1 WHERE key='homepage_config'", [JSON.stringify(cfg)]);
    _hpCfgCache = { t: 0, data: null };  // cache bust
    res.json({ success: true, config: cfg });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/superadmin/upload-logo', verifySuperAdmin, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Koi file nahi' });
    if (!['image/png','image/jpeg','image/webp','image/svg+xml'].includes(req.file.mimetype))
      return res.status(400).json({ error: 'Sirf PNG/JPG/WEBP/SVG' });
    if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'Logo 2MB se kam ho' });
    const url = await uploadImageToCloudinary(req.file.buffer, req.file.mimetype);
    const cur = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
    const cfg = cur.rows.length ? JSON.parse(cur.rows[0].value) : {};
    cfg.logoUrl = url;
    await pool.query("UPDATE system_settings SET value=$1 WHERE key='homepage_config'", [JSON.stringify(cfg)]);
    _hpCfgCache = { t: 0, data: null };
    res.json({ success: true, logoUrl: url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/superadmin/setup-fee', verifySuperAdmin, async (req, res) => {
  try {
    const pricing = await getSetupPricing();
    res.json({
      offerPrice: pricing.offerPrice,
      actualPrice: pricing.actualPrice,
      monthlyFee: pricing.monthlyFee,
      advancedFee: await getAdvancedFee(),
      monthlyActualPrice: await getMonthlyActualFee(),
      advancedActualPrice: await getAdvancedActualFee(),
      agentBasePrice: await getAgentBasePrice(),
      wlLicenseFee: await getWlLicenseFee(),
      wlLicenseActual: await getWlLicenseActual(),
      wlBasePrice: await getWlBasePrice(),
      agentBasePriceIsSet: (await pool.query("SELECT value FROM system_settings WHERE key='agent_base_price'")).rows[0]?.value > 0,
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

    let newMonthlyFee = null, newAdvancedFee = null;
    if (req.body.monthlyFee !== undefined) {
      const mf = parseInt(req.body.monthlyFee);
      if (!isNaN(mf) && mf >= 1) {
        newMonthlyFee = mf;
        await pool.query("UPDATE system_settings SET value=$1 WHERE key='monthly_fee'", [String(mf)]);
      }
    }
    if (req.body.advancedFee !== undefined) {
      const af = parseInt(req.body.advancedFee);
      if (!isNaN(af) && af >= 1) {
        newAdvancedFee = af;
        await pool.query("UPDATE system_settings SET value=$1 WHERE key='advanced_fee'", [String(af)]);
      }
    }

    // Monthly Actual Price — strikethrough. 0/khaali = hide, warna >= Monthly Fee hona chahiye
    if (req.body.monthlyActualPrice !== undefined && req.body.monthlyActualPrice !== '') {
      const map = parseInt(req.body.monthlyActualPrice);
      const mfCheck = newMonthlyFee ?? await getMonthlyFee();
      if (isNaN(map) || map < 0) return res.status(400).json({ error: 'Valid Monthly Actual Price daalo' });
      if (map > 0 && map < mfCheck) return res.status(400).json({ error: 'Monthly Actual Price, Monthly Fee se kam nahi ho sakta' });
      await pool.query("UPDATE system_settings SET value=$1 WHERE key='monthly_actual_price'", [String(map)]);
    }
    // Advanced Actual Price — strikethrough. 0/khaali = hide, warna >= Advanced Fee hona chahiye
    if (req.body.advancedActualPrice !== undefined && req.body.advancedActualPrice !== '') {
      const aap = parseInt(req.body.advancedActualPrice);
      const afCheck = newAdvancedFee ?? await getAdvancedFee();
      if (isNaN(aap) || aap < 0) return res.status(400).json({ error: 'Valid Advanced Actual Price daalo' });
      if (aap > 0 && aap < afCheck) return res.status(400).json({ error: 'Advanced Actual Price, Advanced Fee se kam nahi ho sakta' });
      await pool.query("UPDATE system_settings SET value=$1 WHERE key='advanced_actual_price'", [String(aap)]);
    }
    // Agent Base Price — 0/khaali = "abhi set nahi", agent ka floor = public Offer Price hi rahega.
    // Value diya ho to Offer Price se kam nahi ho sakta — warna agent public se sasta bech payega.
    // White Label — license fee (ek baar) aur reseller ka minimum shop price
    if (req.body.wlLicenseFee !== undefined && req.body.wlLicenseFee !== '') {
      const lf = parseInt(req.body.wlLicenseFee, 10);
      if (isNaN(lf) || lf < 1) return res.status(400).json({ error: 'Valid White Label license fee daalo' });
      await pool.query("UPDATE system_settings SET value=$1 WHERE key='wl_license_fee'", [String(lf)]);
    }
    if (req.body.wlLicenseActual !== undefined && req.body.wlLicenseActual !== '') {
      const la = parseInt(req.body.wlLicenseActual, 10);
      if (isNaN(la) || la < 0) return res.status(400).json({ error: 'Valid White Label actual price daalo' });
      const lfNow = parseInt(req.body.wlLicenseFee, 10) || await getWlLicenseFee();
      if (la > 0 && la < lfNow) {
        return res.status(400).json({ error: 'Actual Price, License Fee se kam nahi ho sakta' });
      }
      await pool.query("UPDATE system_settings SET value=$1 WHERE key='wl_license_actual'", [String(la)]);
    }
    if (req.body.wlBasePrice !== undefined && req.body.wlBasePrice !== '') {
      const wbp = parseInt(req.body.wlBasePrice, 10);
      if (isNaN(wbp) || wbp < 0) return res.status(400).json({ error: 'Valid White Label base price daalo' });
      if (wbp > 0 && wbp < newOfferPrice) {
        return res.status(400).json({ error: 'White Label base price, Offer Price se kam nahi ho sakta' });
      }
      await pool.query("UPDATE system_settings SET value=$1 WHERE key='wl_base_price'", [String(wbp)]);
    }
    if (req.body.agentBasePrice !== undefined && req.body.agentBasePrice !== '') {
      const abp = parseInt(req.body.agentBasePrice);
      if (isNaN(abp) || abp < 0) return res.status(400).json({ error: 'Valid Agent Base Price daalo' });
      if (abp > 0 && abp < newOfferPrice) return res.status(400).json({ error: 'Agent Base Price, Offer Price se kam nahi ho sakta' });
      await pool.query("UPDATE system_settings SET value=$1 WHERE key='agent_base_price'", [String(abp)]);
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
        // Renewal order? (setup match na ho to)
        if (!sh.rows.length) {
          const rn = await pool.query('SELECT id FROM shops WHERE renewal_order_id=$1', [orderId]);
          if (rn.rows.length) {
            await extendShop(rn.rows[0].id, orderId, paymentId || 'WEBHOOK');
            return res.json({ status: 'ok' });
          }
          const adv = await pool.query('SELECT id FROM shops WHERE advanced_order_id=$1', [orderId]);
          if (adv.rows.length) {
            await pool.query("UPDATE shops SET advanced_unlocked=true, advanced_order_id='' WHERE id=$1", [adv.rows[0].id]);
            console.log('Advanced unlocked (webhook):', adv.rows[0].id);
            return res.json({ status: 'ok' });
          }
        }
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
    // Max EK requeue. Pehle 2 the — matlab ek job 3 baar tak print ho
    // sakta tha (report kho jaye to har 10 min me dubara). Duplicate print
    // ka nuksan missed print se zyada hai.
    const requeued = await pool.query(
      `UPDATE print_jobs SET status='queued', printing_at=NULL, retry_count=retry_count+1
       WHERE status='printing' AND printing_at < NOW() - INTERVAL '10 minutes' AND retry_count < 1
       RETURNING id`);
    if (requeued.rows.length) console.log('♻️ Requeued stuck jobs:', requeued.rows.map(r=>r.id).join(','));
    const failed = await pool.query(
      `UPDATE print_jobs SET status='failed',
              failure_reason='Print timeout — shop PC/printer respond nahi kiya'
       WHERE status='printing' AND printing_at < NOW() - INTERVAL '10 minutes' AND retry_count >= 1
       RETURNING id, file_public_id`);
    for (const fj of failed.rows) {
      if (fj.file_public_id) {
        await deleteFromCloudinary(fj.file_public_id);
        await pool.query('UPDATE print_jobs SET file_deleted=true WHERE id=$1', [fj.id]);
      }
    }
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
          // payment_status ke saath status bhi 'queued' karo — warna agent
          // (jo queued+paid uthata hai) is job ko KABHI nahi uthata aur
          // customer ka paisa kat ke bhi print nahi nikalta.
          await pool.query(
            `UPDATE print_jobs
             SET payment_status='paid',
                 status = CASE WHEN status='pending' THEN 'queued' ELSE status END
             WHERE id=$1 AND payment_status='pending'`,
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
    // 2b-ii) Renewal reconcile — renewal order bana par verify nahi pahuncha
    if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
      const renews = await pool.query(
        `SELECT id, renewal_order_id FROM shops
         WHERE renewal_order_id IS NOT NULL AND renewal_order_id <> '' LIMIT 10`);
      for (const shop of renews.rows) {
        try {
          const order = await razorpayOrderStatus(shop.renewal_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
          if (order && order.status === 'paid') {
            await extendShop(shop.id, shop.renewal_order_id, 'RECONCILE');
            console.log('💰 Reconciled renewal:', shop.id);
          }
        } catch(e) { /* agla cycle */ }
      }
    }

    // 2b-iii) Advanced unlock reconcile
    if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
      const advs = await pool.query(
        `SELECT id, advanced_order_id FROM shops WHERE advanced_order_id IS NOT NULL AND advanced_order_id <> '' LIMIT 10`);
      for (const shop of advs.rows) {
        try {
          const order = await razorpayOrderStatus(shop.advanced_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
          if (order && order.status === 'paid') {
            await pool.query("UPDATE shops SET advanced_unlocked=true, advanced_order_id='' WHERE id=$1", [shop.id]);
            console.log('Advanced unlocked (reconcile):', shop.id);
          }
        } catch(e) {}
      }
    }

    // 2c) ABANDONED uploads — customer ne upload kiya par payment complete
    // nahi kiya. Pehle ye files Cloudinary par HAMESHA padi rehti thi
    // (storage leak + customer ki private file server par). Ab 60 min baad
    // file delete + job abandoned mark.
    const abandoned = await pool.query(
      `SELECT id, file_public_id FROM print_jobs
       WHERE status='pending' AND payment_status='pending'
         AND created_at < NOW() - INTERVAL '60 minutes'
       LIMIT 20`);
    for (const j of abandoned.rows) {
      if (j.file_public_id) await deleteFromCloudinary(j.file_public_id);
      await pool.query(
        "UPDATE print_jobs SET status='abandoned', file_deleted=true, failure_reason=$1 WHERE id=$2",
        ['Customer ne payment complete nahi kiya', j.id]);
      console.log('🧹 Abandoned upload cleaned:', j.id);
    }

    // ══════════ SAFETY LAYER 1: VERIFY SWEEP ══════════
    // Job complete/fail/abandon ho gayi par file_deleted flag false hai
    // (matlab delete call silently fail hua tha — network, API error).
    // 5 min baad dobara delete maaro. Cloudinary destroy idempotent hai.
    const unverified = await pool.query(
      `SELECT id, file_public_id FROM print_jobs
       WHERE status IN ('printed','failed','abandoned')
         AND file_deleted = false
         AND file_public_id IS NOT NULL AND file_public_id <> ''
         AND created_at < NOW() - INTERVAL '5 minutes'
       LIMIT 25`);
    for (const j of unverified.rows) {
      await deleteFromCloudinary(j.file_public_id);
      await pool.query('UPDATE print_jobs SET file_deleted=true WHERE id=$1', [j.id]);
      console.log('🔁 Retry-deleted leftover file:', j.id);
    }

    // ══════════ SAFETY LAYER 2: CLOUDINARY ORPHAN SWEEP ══════════
    // Har ~10 min: Cloudinary se ASLI list lo. Jo file 90+ min purani hai
    // aur kisi ACTIVE job ki nahi hai — uda do. Ye un files ko bhi pakadta
    // hai jinka DB me row hi nahi (upload hua par insert fail, ya row delete
    // ho gaya) — DB-based cleanup unhe kabhi nahi dekh sakta.
    _sweepTick++;
    if (_sweepTick % 5 === 0) {
      let cursor = '';
      let swept = 0;
      for (let page = 0; page < 5; page++) {   // max 500 files/cycle
        const { resources, next_cursor } = await listCloudinaryFiles(cursor);
        if (!resources.length) break;
        for (const r of resources) {
          const ageMin = (Date.now() - new Date(r.created_at).getTime()) / 60000;
          if (ageMin < 90) continue;   // fresh file — abhi koi use kar raha ho sakta hai
          // Active job to nahi hai iski?
          const active = await pool.query(
            `SELECT 1 FROM print_jobs
             WHERE file_public_id=$1 AND status IN ('queued','printing')`, [r.public_id]);
          if (active.rows.length) continue;   // print hone wali hai — chhod do
          await deleteFromCloudinary(r.public_id);
          await pool.query('UPDATE print_jobs SET file_deleted=true WHERE file_public_id=$1', [r.public_id]);
          swept++;
        }
        if (!next_cursor) break;
        cursor = next_cursor;
      }
      if (swept) console.log(`🧹 Cloudinary orphan sweep: ${swept} file(s) deleted`);
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
app.get('/agent',     (req,res) => res.sendFile(path.join(__dirname,'public','agent.html')));
app.get('/whitelabel',(req,res) => res.sendFile(path.join(__dirname,'public','whitelabel.html')));
app.get('/wl-admin',  (req,res) => res.sendFile(path.join(__dirname,'public','wl-admin.html')));
app.get('/dashboard', (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/superadmin', (req,res) => res.sendFile(path.join(__dirname,'public','superadmin.html')));
app.get('/print-success', (req,res) => res.sendFile(path.join(__dirname,'public','success.html')));

// ═══ SEO: sub-pages ke ASLI URL (Google me alag page + sitelinks ke liye) ═══
// index.html hi serve hota hai, par har URL ka apna title/description/canonical
// inject karke bhejte hain — tabhi Google inhe alag page maanta hai.
// Frontend JS pathname dekh kar wahi section khol deta hai.
const SEO_PAGES = {
  '/features': {
    title: 'Features — QR Se Print | Cyber Cafe Auto Print Software',
    desc: 'QR Se Print ke saare features: QR se file upload, online payment, auto print, passport photo, resume maker, shop dashboard aur reports.'
  },
  '/about': {
    title: 'About Us — QR Se Print | Cyber Cafe Print Automation',
    desc: 'QR Se Print ke baare mein — cyber cafe aur print shop ke liye banaya gaya QR se auto print system. Team, mission aur kahani.'
  },
  '/contact': {
    title: 'Contact Us — QR Se Print | Support & Business Inquiry',
    desc: 'QR Se Print se sampark karein — support, demo, pricing ya business inquiry ke liye call, WhatsApp ya email karein.'
  },
  '/setup-guide': {
    title: 'Setup Guide — QR Se Print Kaise Setup Karein (Step by Step)',
    desc: 'QR Se Print setup karne ka poora step-by-step guide: shop register, print agent install, printer connect aur payment setup.'
  },
  '/partner': {
    title: 'Partner & White Label — QR Se Print Reseller Program',
    desc: 'QR Se Print ke saath partner banein — agent commission ya apne brand se white label reselling. Zero investment se shuruaat.'
  },
  '/terms': {
    title: 'Terms & Conditions — QR Se Print',
    desc: 'QR Se Print ke Terms & Conditions — service ka upyog, shop owner ki zimmedari, payment aur account niyam.'
  },
  '/privacy': {
    title: 'Privacy Policy — QR Se Print',
    desc: 'QR Se Print Privacy Policy — customer ki file aur data kaise store hota hai, kitne samay tak rehta hai aur kaise delete hota hai.'
  },
  '/refund': {
    title: 'Refund & Cancellation Policy — QR Se Print',
    desc: 'QR Se Print ki Refund & Cancellation Policy — print job, subscription aur payment refund ke niyam.'
  },
  '/disclaimer': {
    title: 'Disclaimer & FAQ — QR Se Print',
    desc: 'QR Se Print ka disclaimer aur aksar puche jane wale sawal (FAQ) — service ki seema aur zimmedari ki jankari.'
  }
};

let _indexHtmlCache = null;
// Canonical hamesha asli domain ka hona chahiye (BASE_URL default onrender.com hai,
// use canonical me daalna SEO ke liye galat hoga)
const SITE_URL = (process.env.SITE_URL || 'https://qrseprint.in').replace(/\/+$/, '');
function loadIndexHtml() {
  if (_indexHtmlCache === null) {
    try {
      _indexHtmlCache = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    } catch (e) {
      console.error('index.html read fail:', e.message);
      _indexHtmlCache = '';
    }
  }
  return _indexHtmlCache;
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
Object.keys(SEO_PAGES).forEach(function (route) {
  app.get(route, function (req, res) {
    const meta = SEO_PAGES[route];
    let html = loadIndexHtml();
    // index.html padh nahi paaye to normal file bhej do (site kabhi na toote)
    if (!html) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    const url = SITE_URL + route;
    const t = esc(meta.title), d = esc(meta.desc);
    html = html
      .replace(/<title>[\s\S]*?<\/title>/i, '<title>' + t + '</title>')
      .replace(/<meta name="description" content="[^"]*">/i,
               '<meta name="description" content="' + d + '">')
      .replace(/<link rel="canonical" href="[^"]*">/i,
               '<link rel="canonical" href="' + url + '">')
      .replace(/<meta property="og:url" content="[^"]*">/i,
               '<meta property="og:url" content="' + url + '">')
      .replace(/<meta property="og:title" content="[^"]*">/i,
               '<meta property="og:title" content="' + t + '">')
      .replace(/<meta property="og:description" content="[^"]*">/i,
               '<meta property="og:description" content="' + d + '">')
      .replace(/<meta name="twitter:title" content="[^"]*">/i,
               '<meta name="twitter:title" content="' + t + '">')
      .replace(/<meta name="twitter:description" content="[^"]*">/i,
               '<meta name="twitter:description" content="' + d + '">');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
});
// Purane / alternate path — asli URL par 301 bhej do (link juice na tootey)
const SEO_ALIASES = { '/feature': '/features', '/guide': '/setup-guide', '/faq': '/disclaimer', '/declaration': '/disclaimer' };
Object.keys(SEO_ALIASES).forEach(function (from) {
  app.get(from, function (req, res) { res.redirect(301, SEO_ALIASES[from]); });
});

// ═══ SEO: robots.txt + sitemap.xml + private-page noindex ═══
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (p.startsWith('/admin') || p.startsWith('/superadmin') || p.startsWith('/dashboard')
      || p.startsWith('/success') || p.startsWith('/setup-payment') || p.startsWith('/print/')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
});

// Homepage social-proof — ASLI numbers, 5 min cache
let _statsCache = { t: 0, data: null };
let _hpCfgCache = { t: 0, data: null };
app.get('/api/homepage-config', async (req, res) => {
  try {
    if (Date.now() - _hpCfgCache.t < 60000 && _hpCfgCache.data) return res.json(_hpCfgCache.data);
    const r = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
    const cfg = r.rows.length ? JSON.parse(r.rows[0].value) : {};
    _hpCfgCache = { t: Date.now(), data: cfg };
    res.json(cfg);
  } catch(e) { res.json({}); }
});

app.get('/api/public-stats', async (req, res) => {
  try {
    if (Date.now() - _statsCache.t < 300000 && _statsCache.data) return res.json(_statsCache.data);
    const shops = await pool.query("SELECT COUNT(*) FROM shops WHERE setup_paid=true AND (demo IS NULL OR demo=false)");
    const prints = await pool.query("SELECT COUNT(*) FROM print_jobs WHERE status='printed'");
    _statsCache = { t: Date.now(), data: {
      shops: parseInt(shops.rows[0].count) || 0,
      prints: parseInt(prints.rows[0].count) || 0
    }};
    res.json(_statsCache.data);
  } catch(e) { res.json({ shops: 0, prints: 0 }); }
});


app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin
Disallow: /superadmin
Disallow: /dashboard
Disallow: /wl-admin
Disallow: /print/
Disallow: /resume/
Disallow: /setup-payment/
Disallow: /print-success

Sitemap: ${SITE_URL}/sitemap.xml
`);
});

app.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain').send(`Contact: mailto:qrseprint@gmail.com
Expires: 2027-08-04T00:00:00.000Z
Preferred-Languages: hi, en
Canonical: https://qrseprint.in/.well-known/security.txt
`);
});

app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    ['/', 'weekly', '1.0'],
    ['/features', 'monthly', '0.9'],
    ['/register', 'monthly', '0.9'],
    ['/setup-guide', 'monthly', '0.8'],
    ['/about', 'monthly', '0.7'],
    ['/contact', 'monthly', '0.7'],
    ['/agent', 'monthly', '0.7'],
    ['/whitelabel', 'monthly', '0.7'],
    ['/partner', 'monthly', '0.6'],
    ['/terms', 'yearly', '0.3'],
    ['/privacy', 'yearly', '0.3'],
    ['/refund', 'yearly', '0.3'],
    ['/disclaimer', 'yearly', '0.3']
  ].map(u =>
    `  <url><loc>${SITE_URL}${u[0]}</loc><lastmod>${today}</lastmod>` +
    `<changefreq>${u[1]}</changefreq><priority>${u[2]}</priority></url>`
  ).join('\n');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
  );
});

app.get('/setup-payment/:shopId', (req,res) => res.sendFile(path.join(__dirname,'public','setup-payment.html')));
app.get('/resume/:shopId', (req,res) => res.sendFile(path.join(__dirname,'public','resume.html')));

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`QR Se Print - Port ${PORT}`);
    console.log(`${BASE_URL}`);
    console.log(`Cloudinary: ${CLOUD_NAME}`);
    console.log(`Payment: Per-shop gateway (Razorpay/Cashfree), Counter always available unless online_only`);
  });
});
