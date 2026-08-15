/* ═══════════════════════════════════════════════════════════════
   i18n-extra.js — WO strings jo dictionary me chhoot gayi thi.

   Kyun chahiye: English chun-ne par bhi kai jagah Hinglish dikh raha
   tha — khaas kar customer wale page par aur server ke error message
   me. Wajah do thi:
     1) String dictionary me thi hi nahi.
     2) String runtime par banti thi ("3 files load ho gayi") isliye
        exact match kabhi milta hi nahi tha.

   Doosri wajah ke liye i18n.js me "%d" wala number-aware lookup add
   kiya gaya hai — yahan bas "%d" wali key likh do, number apne aap
   sahi jagah bhar jaata hai.

   i18n.js ke BAAD load hona chahiye.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  var EXTRA = {

    /* ─────────── CUSTOMER PAGE — upload / editor ─────────── */
    'Sab theek hai / Edit karna hai': 'All good / Want to edit',
    'pehle file upload karo': 'please upload a file first',
    'File padhi ja rahi hai…': 'Reading file…',
    'File padhi nahi ja saki': 'Could not read the file',
    'File load nahi hui': 'File did not load',
    'Preview ban raha hai…': 'Building preview…',
    'Preview nahi ban paya — dobara try karo': 'Preview failed — please try again',
    '⏳ Sheets ban rahi hain…': '⏳ Preparing sheets…',
    '⏳ Document load ho raha hai...': '⏳ Loading document...',
    'ho gaya': 'done',
    '). JPG ya PNG photo try karo.': '). Try a JPG or PNG photo.',
    '🗑️ Document hata diya': '🗑️ Document removed',
    'Aap sirf': 'You only pay for',
    'sheet</b> ka paisa denge': 'sheet</b>',
    '— abhi ke rate se <b>₹': '— at the current rate <b>₹',

    /* Number-wale toast — %d se number apne aap bhar jaata hai */
    '✅ %d files load ho gayi!': '✅ %d files loaded!',
    '✅ %d pages load ho gaye!': '✅ %d pages loaded!',
    '✅ %d pages isi canvas par add ho gaye': '✅ %d pages added to this canvas',
    '⏳ Page %d / %d load ho raha hai...': '⏳ Loading page %d of %d...',
    '⚠️ Page %d load nahi hui, baaki pages continue ho rahe hain...':
      '⚠️ Page %d failed to load, continuing with the rest...',
    '⏳ File %d/%d:': '⏳ File %d/%d:',

    /* ─────────── RESUME ─────────── */
    '⚠️ Preview nahi ban paya, par resume theek hai — print kar sakte ho':
      '⚠️ Preview failed, but your resume is fine — you can still print it',
    'Developed by Rupesh Kumar Mahato | QR Se Resume Banao':
      'Developed by Rupesh Kumar Mahato | Build your resume with QR',

    /* ─────────── SERVER ERRORS — login / session ─────────── */
    'Login zaroori hai': 'Login required',
    'Session expire ho gaya, dobara login karo': 'Session expired, please log in again',
    'ID ya password galat hai': 'Incorrect ID or password',
    'Purana password galat hai': 'Old password is incorrect',
    'Naya password kam se kam 6 akshar ka ho': 'New password must be at least 6 characters',
    'Bahut zyada galat koshish. %d minute baad try karo.':
      'Too many failed attempts. Please try again in %d minutes.',
    'Ye whitelabel token nahi hai': 'This is not a white-label token',
    'Account nahi mila': 'Account not found',
    'Account paused hai': 'Account is paused',
    'Aapka account abhi paused hai': 'Your account is currently paused',
    'Aapka account abhi paused hai. Admin se baat kariye.':
      'Your account is currently paused. Please contact the admin.',

    /* ─────────── SERVER ERRORS — shop / demo ─────────── */
    'Shop nahi mila': 'Shop not found',
    'Shop ka naam zaroori hai': 'Shop name is required',
    'Shop pehle se active hai': 'Shop is already active',
    'Sahi 10-digit mobile number daalo': 'Enter a valid 10-digit mobile number',
    'Sahi 10 digit mobile number daalo': 'Enter a valid 10-digit mobile number',
    'Demo abhi band hai — thodi der baad try karo ya seedha register karo':
      'Demo is closed right now — try again shortly or register directly',
    'Is number par demo pehle liya ja chuka hai. Pasand aaya tha? Ab register karo 🙂':
      'A demo has already been taken on this number. Liked it? Register now 🙂',
    'Is number par demo pehle liya ja chuka hai. Ab register karo 🙂':
      'A demo has already been taken on this number. Please register now 🙂',
    'Is number par demo pehle se hai': 'This number already has a demo',
    'Aaj ke liye demo limit ho gayi — kal try karo ya abhi register karo':
      'Today’s demo limit is reached — try tomorrow or register now',
    'Is network se %d demo ho chuke hain. %d minute baad try karo, ya seedha register kar lo.':
      '%d demos have already been created from this network. Try again in %d minutes, or register directly.',
    'Login password = aapka mobile number': 'Login password = your mobile number',

    /* ─────────── SERVER ERRORS — advance / module ─────────── */
    'Advance feature unlock nahi hai': 'Advance feature is not unlocked',
    'Advanced already unlocked hai': 'Advanced is already unlocked',
    'Galat module': 'Invalid module',

    /* ─────────── SERVER ERRORS — agent ─────────── */
    'Aap agent nahi ho': 'You are not an agent',
    'Agent nahi mila': 'Agent not found',
    'Aapka agent account abhi paused hai': 'Your agent account is currently paused',
    'Agent banne ke liye pehle plan lena zaroori hai. Demo account agent nahi ban sakta.':
      'You must purchase a plan before becoming an agent. Demo accounts cannot become agents.',
    'Sahi UPI ID daalo (jaise name@bank)': 'Enter a valid UPI ID (e.g. name@bank)',
    'Agent token galat hai': 'Invalid agent token',
    'Agent purana hai — naya print agent install karo':
      'Your agent is outdated — please install the latest print agent',

    /* ─────────── SERVER ERRORS — withdrawal ─────────── */
    'Withdrawal ke liye kam se kam ₹500 chahiye (abhi ₹%d)':
      'A minimum of ₹500 is required to withdraw (currently ₹%d)',
    'Ek withdrawal request pehle se pending hai': 'A withdrawal request is already pending',
    'Pending withdrawal nahi mili': 'No pending withdrawal found',

    /* ─────────── SERVER ERRORS — payment / gateway ─────────── */
    'Payment reference/ID daalo (Razorpay dashboard se)':
      'Enter the payment reference/ID (from your Razorpay dashboard)',
    'Payment reference daalo (cash ho to "CASH" likh do)':
      'Enter the payment reference (write "CASH" if paid in cash)',
    'Payment gateway configure nahi hai.': 'Payment gateway is not configured.',
    'Payment verification failed': 'Payment verification failed',
    'Order create nahi hua': 'Could not create the order',
    'Order create nahi hua:': 'Could not create the order:',
    'Order match nahi hua': 'Order did not match',
    'Key ID aur Secret dono daalo': 'Enter both the Key ID and the Secret',
    'Key ID rzp_ se shuru honi chahiye': 'Key ID must start with rzp_',
    'Secret key bhi daalo': 'Please enter the secret key as well',
    'App ID bhi daalo': 'Please enter the App ID as well',
    'Gateway razorpay ya cashfree hi ho sakta hai': 'Gateway must be either razorpay or cashfree',
    'Pehle Razorpay keys save karo': 'Save your Razorpay keys first',
    'Pehle Cashfree keys save karo': 'Save your Cashfree keys first',
    'Pehle apna Razorpay ya Cashfree set karo — warna shop payment nahi kar payegi':
      'Set up your Razorpay or Cashfree first — otherwise the shop cannot take payments',
    'Sahi price daalo': 'Enter a valid price',
    'Monthly price number me daalo': 'Enter the monthly price as a number',
    'Monthly price bahut zyada hai': 'Monthly price is too high',
    'Valid base price daalo': 'Enter a valid base price',

    /* ─────────── SERVER ERRORS — white label ─────────── */
    'White label nahi mila': 'White label not found',
    'Registration nahi mila': 'Registration not found',
    'License already paid hai': 'The license is already paid',
    'License payment abhi complete nahi hua': 'License payment is not complete yet',
    'Slug kam se kam 3 akshar ka ho (sirf a-z, 0-9, dash)':
      'Slug must be at least 3 characters (only a-z, 0-9, dash)',
    'Ye slug reserved hai, dusra chuno': 'This slug is reserved, please choose another',
    'Ye slug already liya jaa chuka hai': 'This slug is already taken',
    'Sahi support email daalo': 'Enter a valid support email',
    'Sahi 10 digit support number daalo': 'Enter a valid 10-digit support number',
    'Instagram link https:// se shuru hona chahiye': 'The Instagram link must start with https://',
    'YouTube link https:// se shuru hona chahiye': 'The YouTube link must start with https://',
    'Facebook link https:// se shuru hona chahiye': 'The Facebook link must start with https://',

    /* ─────────── SERVER ERRORS — upload / logo ─────────── */
    'Koi file nahi': 'No file provided',
    'Koi file nahi mili': 'No file found',
    'Sirf PNG file chalegi (transparent background wali)':
      'Only PNG files are allowed (with a transparent background)',
    'Sirf PNG ya JPG file chalegi': 'Only PNG or JPG files are allowed',
    'PNG transparent background wali honi chahiye (abhi solid background hai)':
      'The PNG must have a transparent background (this one has a solid background)',
    'Logo %d KB se chhota hona chahiye (abhi %d KB hai)':
      'The logo must be smaller than %d KB (it is currently %d KB)',
    'Cloudinary configured nahi': 'Cloudinary is not configured',
    'Cloudinary keys set nahi hain': 'Cloudinary keys are not set',
    'Cloudinary configured nahi hai — Render environment variables check karo (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)':
      'Cloudinary is not configured — check your Render environment variables (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)',

    /* ─────────── SERVER ERRORS — misc ─────────── */
    'Ye shop aapki nahi hai': 'This shop does not belong to you',
    'Shop ya order match nahi hua': 'The shop or order did not match',
    'Shop ka setup abhi incomplete hai. Shop owner ko setup fee complete karna hoga.':
      'This shop’s setup is still incomplete. The shop owner needs to complete the setup fee.',
    'Ye shop kisi aur ke PC se jud chuki hai': 'This shop is already linked to another PC',
    'fix nahi hua': 'not fixed',
    'abhi saaf karo': 'clean up now',

    /* ─────────── HOMEPAGE — short bits ─────────── */
    '— har shop par ₹100': '— ₹100 for every shop',
    'Har shop onboard karne par flat ₹100 commission':
      'A flat ₹100 commission for every shop you onboard',
    'Cyber cafe / print shop free register karo': 'Register your cyber cafe / print shop free',
    'Apne brand se resell karo': 'Resell it under your own brand',
    'Cyber cafe aur print shop ke liye QR-based automatic print software. Customer QR scan karke file bhejta hai, payment karta hai, print automatic nikalta hai.':
      'QR-based automatic printing software for cyber cafes and print shops. The customer scans the QR, sends a file, pays, and the print comes out automatically.'
  };

  /* ── alert / confirm ko apne aap translate karo ──
     Ye DOM nahi hote, isliye MutationObserver inhe kabhi nahi pakadta —
     English chunne par bhi inme Hinglish hi dikhta tha (khaas kar server
     ke error message). Yahan ek baar wrap kar dene se HAR call site
     apne aap theek ho jaati hai, kisi file me haath lagaye bina.

     Multi-line message (jaise confirm ke andar \n) ki har line alag
     translate hoti hai — poora block dictionary me na ho tab bhi jitna
     mil jaye utna English ho jaata hai. */
  function wrapDialogs() {
    if (window.__qspDialogsWrapped) return;
    var T = (window.QSPi18n && window.QSPi18n.t) || function (s) { return s; };
    function tr(msg) {
      if (msg == null) return msg;
      return String(msg).split('\n').map(function (line) {
        var m = line.match(/^(\s*)([\s\S]*?)(\s*)$/);
        return m ? m[1] + T(m[2]) + m[3] : T(line);
      }).join('\n');
    }
    ['alert', 'confirm', 'prompt'].forEach(function (fn) {
      var orig = window[fn];
      if (typeof orig !== 'function') return;
      window[fn] = function (msg) {
        var args = Array.prototype.slice.call(arguments);
        args[0] = tr(msg);
        return orig.apply(window, args);
      };
    });
    window.__qspDialogsWrapped = true;
  }

  function install() {
    if (window.QSPi18n && typeof window.QSPi18n.addDict === 'function') {
      window.QSPi18n.addDict(EXTRA);
      wrapDialogs();
    } else {
      // i18n.js abhi load nahi hua — dict me pehle se daal do,
      // wo start hote hi ise utha lega.
      window.QSP_EN_DICT = window.QSP_EN_DICT || {};
      for (var k in EXTRA) if (EXTRA.hasOwnProperty(k)) window.QSP_EN_DICT[k] = EXTRA[k];
    }
  }
  install();
  // defer/async ke order ke liye — agar i18n baad me aaya to dobara laga do
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  }
})();
