// ═══════════════════════════════════════════════════════════════════
// QR Se Print — REDIRECT-ONLY SERVER (purane onrender.com ke liye)
// ═══════════════════════════════════════════════════════════════════
// Kaam sirf ek: purane QR se aane wale har request ko naye domain
// (qrseprint.in) par bhej dena — path aur query ke saath.
//
// Na database, na koi npm library, na kuch — isliye ye:
//   • ~1 second me boot hota hai (sleep se bhi jaldi jagta hai)
//   • na ke barabar RAM/hours khaata hai (free tier kabhi khatam nahi)
//
// PURANE Render service par isse chalana hai:
//   Settings → Start Command:  node redirect.js
//   (Build Command khali/waise hi chhod do)
// ═══════════════════════════════════════════════════════════════════

const http = require('http');

const TARGET = process.env.REDIRECT_TARGET || 'https://qrseprint.in';
const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  // Health check (agar kabhi zaroorat pade) — bina redirect ke jawab
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // Path + query jaisa hai waisa hi naye domain par bhejo
  // e.g. /print/SHOP_ECB1AB8A  →  https://qrseprint.in/print/SHOP_ECB1AB8A
  const location = TARGET + req.url;

  // 302 (temporary) — taaki browser/phone is redirect ko permanently
  // cache na kare; agar kabhi domain phir badla to purane QR phir bhi
  // hamare control me rahenge.
  res.writeHead(302, {
    'Location': location,
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(`<html><body style="font-family:sans-serif;text-align:center;padding-top:40px">
    <p>QR Se Print naye address par shift ho gaya hai…</p>
    <p><a href="${location}">Yahan click karo agar khud na khule</a></p>
  </body></html>`);
});

server.listen(PORT, () => {
  console.log(`Redirect server chalu — sab traffic ${TARGET} par ja raha hai (port ${PORT})`);
});
