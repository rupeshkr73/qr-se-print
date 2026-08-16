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
      'QR-based automatic printing software for cyber cafes and print shops. The customer scans the QR, sends a file, pays, and the print comes out automatically.',

    /* ─────────── SERVER — validation & login ─────────── */
    'Bahut zyada galat koshish. %d minute baad try karo.':
      'Too many failed attempts. Please try again in %d minutes.',
    'Is network se %d demo ho chuke hain. %d minute baad try karo, ya seedha register kar lo.':
      '%d demos have already been created from this network. Try again in %d minutes, or register directly.',
    'Shop ID aur Password dono chahiye': 'Both Shop ID and Password are required',
    'Shop ID nahi mila': 'Shop ID not found',
    'Is shop ka password set nahi hai. Pehle Set Password karo.':
      'No password is set for this shop. Please set a password first.',
    'Password galat hai': 'Incorrect password',
    'ID ya Password galat hai': 'Incorrect ID or password',
    'Bahut zyada koshish — 1 ghante baad try karo':
      'Too many attempts — please try again in 1 hour',
    'Is shop par bahut zyada koshish — 1 ghante baad try karo':
      'Too many attempts on this shop — please try again in 1 hour',
    'Shop ID, registered mobile aur 4+ character password — teeno chahiye':
      'Shop ID, registered mobile number and a password of 4+ characters — all three are required',
    'Mobile number match nahi hua — wahi number daalo jo registration me diya tha':
      'The mobile number does not match — enter the same number you used at registration',
    'Password kam se kam 4 character ka hona chahiye': 'The password must be at least 4 characters',
    'Naya password kam se kam 4 character ka hona chahiye':
      'The new password must be at least 4 characters',
    'Current password galat hai': 'The current password is incorrect',
    'Password bahut lamba hai': 'The password is too long',
    'Super Admin abhi configure nahi hua hai. Render environment variables check karo.':
      'Super Admin is not configured yet. Please check your Render environment variables.',
    'Confirm karne ke liye DELETE likhna zaroori hai': 'You must type DELETE to confirm',
    'up boolean chahiye': '"up" must be a boolean',
    'shop_id chahiye': 'shop_id is required',
    'shopId aur publicId chahiye': 'shopId and publicId are required',
    'printers array chahiye': 'A printers array is required',
    'Galat id': 'Invalid id',

    /* ─────────── SERVER — shop, plan & payment ─────────── */
    'Email zaroori hai — payment ki receipt isi par aayegi':
      'Email is required — the payment receipt will be sent to it',
    'Online payment ke liye Razorpay ya Cashfree ki details zaroori hain':
      'Razorpay or Cashfree details are required for online payment',
    'Ye partner abhi payment setup complete nahi kiya hai. Thodi der baad try kariye.':
      'This partner has not completed their payment setup yet. Please try again shortly.',
    'Setup fee already paid hai': 'The setup fee has already been paid',
    'Is shop ka partner account link nahi hua. Apne partner se sampark kariye.':
      'This shop is not linked to a partner account. Please contact your partner.',
    'Partner ka payment setup adhoora hai. Unse sampark kariye.':
      'The partner’s payment setup is incomplete. Please contact them.',
    'Ye partner account abhi active nahi hai.': 'This partner account is not active yet.',
    'Setup fee order create nahi hua:': 'Could not create the setup fee order:',
    'Owner Razorpay configured nahi': 'The owner’s Razorpay is not configured',
    'Ye shop one-time plan par hai — renewal ki zaroorat nahi':
      'This shop is on the one-time plan — no renewal is needed',
    'Renewal order create nahi hua': 'Could not create the renewal order',
    'Razorpay ne order reject kiya': 'Razorpay rejected the order',
    'Setup fee pehle complete karo': 'Please complete the setup fee first',
    'Paid shop delete nahi ho sakti': 'A paid shop cannot be deleted',
    'Paid/Active shop delete nahi ho sakti': 'A paid or active shop cannot be deleted',
    'Ye shop protected hai — delete nahi ho sakti': 'This shop is protected — it cannot be deleted',
    '🏪 Shop abhi band hai — baad mein try karo':
      '🏪 The shop is closed right now — please try later',
    '⏸️ Shop inactive hai — owner ko subscription renew karni hai':
      '⏸️ The shop is inactive — the owner needs to renew the subscription',
    'Yeh shop sirf Counter payment accept karta hai': 'This shop accepts counter payment only',
    'Yeh shop sirf Online payment accept karta hai': 'This shop accepts online payment only',
    'Is shop ne abhi online payment setup nahi kiya hai':
      'This shop has not set up online payment yet',
    'Shop ki Razorpay keys set nahi hain': 'The shop’s Razorpay keys are not set',
    'Shop ki Cashfree keys set nahi hain': 'The shop’s Cashfree keys are not set',
    'Cashfree order nahi bana — shop ki keys check karo':
      'The Cashfree order could not be created — check the shop’s keys',
    'Cashfree ka jawab samajh nahi aaya (HTTP': 'Could not read Cashfree’s response (HTTP',
    'Webhook secret configured nahi': 'The webhook secret is not configured',
    'Customer ne payment complete nahi kiya': 'The customer did not complete the payment',
    'white-label shop (paisa reseller ko)': 'white-label shop (money goes to the reseller)',

    /* ─────────── SERVER — agent, printer & files ─────────── */
    'Agent ab apna price set nahi kar sakta. Har shop par flat ₹':
      'Agents can no longer set their own price. A flat ₹',
    'commission milta hai.': 'commission is paid on every shop.',
    'Withdrawal ke liye kam se kam ₹500 chahiye (abhi ₹%d)':
      'A minimum of ₹500 is required to withdraw (currently ₹%d)',
    'Agent code load nahi hua:': 'Could not load the agent code:',
    'Naya installer .exe abhi upload nahi hua hai server pe':
      'The new installer .exe has not been uploaded to the server yet',
    'Installer load nahi hua:': 'Could not load the installer:',
    'Easy Installer abhi available nahi hai. ZIP wala (Python+INSTALL.bat) version use karo neeche se, ya thodi der baad try karo.':
      'The Easy Installer is not available yet. Use the ZIP version (Python + INSTALL.bat) below, or try again shortly.',
    'Package banane mein error:': 'Error while building the package:',
    'Shop Login → Settings → "Disconnect Computer" se purana PC hata kar dobara try karein.':
      'Go to Shop Login → Settings → "Disconnect Computer", remove the old PC and try again.',
    'Cloudinary configure nahi hai': 'Cloudinary is not configured',
    'File Cloudinary par nahi mili': 'The file was not found on Cloudinary',
    'Upload token match nahi hua': 'The upload token did not match',
    'Public ID match nahi hua': 'The public ID did not match',
    'Logo 50 KB se chhota hona chahiye (abhi %d KB hai)':
      'The logo must be smaller than 50 KB (it is currently %d KB)',
    'Sirf PNG/JPG/WEBP/SVG': 'Only PNG, JPG, WEBP or SVG is allowed',
    'QR Se Print — aapke account ka poora data. Ise sambhal kar rakhein.':
      'QR Se Print — the complete data for your account. Please keep it safe.',

    /* ─────────── SERVER — pricing & version (superadmin) ─────────── */
    'se kam nahi ho sakta': 'cannot be lower than',
    'Price ₹%d se kam nahi ho sakta': 'The price cannot be lower than ₹%d',
    'Price ₹9999 se zyada nahi ho sakta': 'The price cannot be higher than ₹9999',
    'Valid Offer Price daalo (0 ya zyada)': 'Enter a valid Offer Price (0 or more)',
    'Valid Actual Price daalo (0 ya zyada)': 'Enter a valid Actual Price (0 or more)',
    'Actual Price, Offer Price se kam nahi ho sakta':
      'The Actual Price cannot be lower than the Offer Price',
    'Valid Monthly Actual Price daalo': 'Enter a valid Monthly Actual Price',
    'Monthly Actual Price, Monthly Fee se kam nahi ho sakta':
      'The Monthly Actual Price cannot be lower than the Monthly Fee',
    'Valid Advanced Actual Price daalo': 'Enter a valid Advanced Actual Price',
    'Advanced Actual Price, Advanced Fee se kam nahi ho sakta':
      'The Advanced Actual Price cannot be lower than the Advanced Fee',
    'Valid White Label license fee daalo': 'Enter a valid White Label licence fee',
    'Valid White Label actual price daalo': 'Enter a valid White Label actual price',
    'Actual Price, License Fee se kam nahi ho sakta':
      'The Actual Price cannot be lower than the Licence Fee',
    'Valid White Label base price daalo': 'Enter a valid White Label base price',
    'White Label base price, Offer Price se kam nahi ho sakta':
      'The White Label base price cannot be lower than the Offer Price',
    'Valid Agent Base Price daalo': 'Enter a valid Agent Base Price',
    'Agent Base Price, Offer Price se kam nahi ho sakta':
      'The Agent Base Price cannot be lower than the Offer Price',
    'Version format galat hai. Aise likho: 2.0, 2.1, 2.10, 3.0':
      'Invalid version format. Write it like this: 2.0, 2.1, 2.10, 3.0',
    'Version %s current %s se aage hona chahiye. Suggested: %s':
      'Version %s must be ahead of the current %s. Suggested: %s',
    'Valid URL daalo (https:// se shuru honi chahiye)':
      'Enter a valid URL (it must start with https://)',
    'Superadmin sirf "Counter par payment" set kar sakta hai. Online/Both ke liye shop owner ko khud login karke apni payment keys daalni hongi.':
      'A superadmin can only set "Counter payment". For Online or Both, the shop owner must log in and enter their own payment keys.',
    'OLD_DATABASE_URL env set nahi hai': 'The OLD_DATABASE_URL environment variable is not set',

    /* ─────────── SERVER — reviews & email alerts ─────────── */
    'Review likho': 'Please write a review',
    'Review nahi mila': 'Review not found',
    'Sahi sender email daalo': 'Enter a valid sender email',
    'Pehle alert email save karo': 'Save your alert email first',
    'Pehle apna email save karo': 'Save your email first',
    'email set nahi hai': 'no email is set',
    'Email setup nahi hai — Brevo API key daalo (ya SMTP)':
      'Email is not set up — add a Brevo API key (or SMTP)',
    'Email setup nahi hai — Brevo API key daalo (recommended) ya SMTP bharo':
      'Email is not set up — add a Brevo API key (recommended) or fill in SMTP',
    'SMTP connect nahi hua:': 'Could not connect to SMTP:',
    'Bheja nahi ja saka:': 'Could not be sent:',
    'Server ne reject kiya:': 'The server rejected it:',
    '— lagta hai hosting ne SMTP port block kiya hai. Brevo API key use karo (upar wala option).':
      '— it looks like your hosting has blocked the SMTP port. Use a Brevo API key instead (the option above).',

    /* ─────────── CUSTOMER PAGE ─────────── */
    'Shop Abhi Active Nahi Hai': 'This Shop Is Not Active Yet',
    'Shop Nahi Mila': 'Shop Not Found',
    '❌ %s load nahi hui:': '❌ Could not load %s:',
    '❌ %s load nahi hua:': '❌ Could not load %s:',
    '✅ %d files load ho gayi!': '✅ %d files loaded!',
    '⏳ Page %d / %d load ho raha hai...': '⏳ Loading page %d of %d...',
    '⚠️ Page %d load nahi hui, baaki pages continue ho rahe hain...':
      '⚠️ Page %d failed to load, continuing with the rest...',
    '✅ %d pages load ho gaye!': '✅ %d pages loaded!',
    '✅ %d pages isi canvas par add ho gaye': '✅ %d pages added to this canvas',
    'Kitni photos chahiye?': 'How many photos do you need?',
    'Ek 4×6 sheet par — har option ka size neeche likha hai':
      'On one 4×6 sheet — each option’s size is shown below',
    '✂️ Photo Crop Karo': '✂️ Crop the Photo',
    'Photo ko ungli se ghumao, do ungli/slider se zoom karo':
      'Drag with one finger to move, pinch or use the slider to zoom',
    '— abhi ke rate se': '— at the current rate',
    'Bachat:': 'You save:',

    /* ─────────── RESUME PAGE ─────────── */
    'Resume Maker Available Nahi': 'Resume Maker Not Available',
    'Is shop par ye feature abhi active nahi hai.': 'This feature is not active at this shop yet.',
    'Counter par baat karo.': 'Please ask at the counter.',
    '← Document Print Karo': '← Print a Document',

    /* ─────────── SETUP PAYMENT PAGE ─────────── */
    'Setup fee complete karo aur QR Code + Print Agent download karo':
      'Complete the setup fee and download your QR Code + Print Agent',
    'Apni shop ka unique QR Code': 'Your shop’s own unique QR Code',
    'Print Agent software (PC ke liye)': 'Print Agent software (for your PC)',
    'Unlimited print orders, koi commission nahi': 'Unlimited print orders, no commission',
    'Pay Karke Setup Complete Karo': 'Pay and Complete Setup',
    'Karke Setup Complete Karo': 'and Complete Setup',
    'Pay ₹%s Karke Setup Complete Karo': 'Pay ₹%s and Complete Setup',
    'Aapki shop ab ready hai. Niche se sab download karo':
      'Your shop is ready. Download everything below',
    '✅ Aapka Shop ID': '✅ Your Shop ID',
    '🎬 Setup Kaise Karein — Dekh Lo': '🎬 How to Set It Up — Watch This',
    '⬇️ Easy Installer Download Karo (.exe)': '⬇️ Download the Easy Installer (.exe)',
    'Recommended — Python ya SumatraPDF alag se install karne ki zaroorat nahi':
      'Recommended — no need to install Python or SumatraPDF separately',
    '📋 Easy Installer Ke Liye:': '📋 For the Easy Installer:',
    '1. Downloaded .exe file pe double-click karo': '1. Double-click the downloaded .exe file',
    '2. "Next, Next, Install" karo': '2. Click "Next, Next, Install"',
    '3. Pehli baar khulte hi Shop ID poochega — daalo':
      '3. The first time it opens it will ask for your Shop ID — enter it',
    '4. Tray mein icon dikhega (neeche right corner)':
      '4. An icon will appear in the tray (bottom-right corner)',
    '5. QR-Code.png alag se download/print karo dashboard se':
      '5. Download and print QR-Code.png separately from the dashboard',
    '📅 Monthly Plan — Pehla Mahina': '📅 Monthly Plan — First Month',
    'har mahine — service active rakhne ke liye time par renew karna hoga.':
      'per month — you must renew on time to keep the service active.',
    'Ye one-time/lifetime NAHI hai.': 'This is NOT a one-time or lifetime plan.',
    'Lifetime access — No renewal, koi monthly charge nahi':
      'Lifetime access — no renewal, no monthly charge',
    '⏳ Payment shuru ho raha hai...': '⏳ Starting the payment...',
    'Payment create nahi hua': 'The payment could not be created',
    '❌ Payment verify nahi hua. Support se contact karo.':
      '❌ The payment could not be verified. Please contact support.',
    '❌ Payment failed! Dobara try karo.': '❌ Payment failed! Please try again.',

    /* ─────────── AGENT LANDING PAGE ─────────── */
    'Ek baar agent bano — phir jitni dukaanein jodoge, utna kamate raho. Har successful shop onboard hone par':
      'Become an agent once — then the more shops you bring in, the more you keep earning. For every shop you successfully onboard you get',
    '— seedha aapke UPI par.': '— straight to your UPI.',
    'Login karo ›': 'Log in ›',
    'Abhi tak plan nahi liya? Pehle apna plan lo — Shop ID aur software milega, phir agent ban sakte ho.':
      'Haven’t bought a plan yet? Get your plan first — you’ll receive a Shop ID and the software, and then you can become an agent.',
    'Plan lene par aapko apna Shop ID aur print software bhi milta hai — bilkul normal shop owner ki tarah.':
      'With a plan you also get your own Shop ID and the print software — exactly like any other shop owner.',
    'Agent tab se join karo': 'Join from the Agent tab',
    'Login karke Agent tab kholo, ek click me apna Agent Code mil jayega (jaise QRA-4821).':
      'Log in and open the Agent tab — one click gives you your Agent Code (for example QRA-4821).',
    'UPI ID save karo': 'Save your UPI ID',
    'Commission isi UPI par bheja jayega — isliye sahi ID daalna.':
      'Your commission is sent to this UPI, so enter the correct ID.',
    'Apna link share karo': 'Share your link',
    'Aapke link se jo bhi register karega wo shop aapki list me aa jayegi. Price sabke liye ek hi rehta hai.':
      'Any shop that registers through your link is added to your list. The price stays the same for everyone.',
    'Ya khud shop onboard karo': 'Or onboard a shop yourself',
    'Agent tab se Shop ID + password bana kar seedha kisi ki dukaan set kar do.':
      'Create a Shop ID and password from the Agent tab and set up someone’s shop directly.',
    'Kamai ka hisaab': 'How earnings work',
    'Commission tabhi milta hai jab onboard ki hui shop apni payment poori kar de. Withdrawal request Agent tab se karo — approve hone ke baad aapke UPI par bhej diya jayega.':
      'Commission is paid only once the shop you onboarded completes its payment. Request a withdrawal from the Agent tab — once approved, it is sent to your UPI.',

    /* ─────────── HOMEPAGE — about / legal / guide ─────────── */
    'QR Se Print ek software hai jo aapki dukaan ke printer ko customer ke phone se jodta hai. Ye niyam batate hain ki account, plan, referral aur payment kaise chalte hain, aur kya karna mana hai.':
      'QR Se Print is software that connects your shop’s printer to your customer’s phone. These terms explain how accounts, plans, referrals and payments work, and what is not allowed.',
    '— server par kuch nahi bachta. Shop owner apne admin panel ke logs me dekh sakta hai ki job print hua aur file hat gayi. Card ya UPI PIN hum kabhi store nahi karte, wo Razorpay ke paas jata hai.':
      '— nothing is left on the server. The shop owner can see in their admin panel logs that the job printed and the file was removed. We never store card details or UPI PINs; those go to Razorpay.',
    'Paise dene se pehle free demo se poora software try karo. Payment ke baad refund nahi milta. Par install nahi kar pa rahe to tension mat lo — WhatsApp ya AnyDesk se hum khud setup karke denge, jab tak chalu na ho jaye.':
      'Try the full software with the free demo before you pay. There is no refund after payment. But if you cannot install it, don’t worry — we will set it up for you over WhatsApp or AnyDesk until it is running.',
    'QR Se Print sirf software deta hai — printer, paper, ink aur dukaan shop owner ki apni hai. Customer jo file bhejta hai uski zimmedari customer ki. Kamai ke jo example website par dikhte hain wo sirf samajhne ke liye hain, guarantee nahi.':
      'QR Se Print only provides software — the printer, paper, ink and shop belong to the shop owner. Whatever file a customer sends is the customer’s own responsibility. Any earnings examples shown on the website are for illustration only, not a guarantee.',
    'ek modern Smart Printing Platform hai jo Cyber Cafes, Print Shops, CSC Centers aur Digital Service Businesses ke liye specially design kiya gaya hai. Hamara mission simple hai — printing ko fast, automated aur hassle-free banana.':
      'is a modern smart printing platform built specially for cyber cafes, print shops, CSC centres and digital service businesses. Our mission is simple — to make printing fast, automated and hassle-free.',
    'Customer ko sirf QR scan karna hai, document upload karna hai, payment complete karni hai — aur print automatically start ho jata hai. Na pendrive ki zarurat, na WhatsApp par file bhejne ka jhanjhat, na manual file handling.':
      'The customer only has to scan the QR, upload the document and complete the payment — and printing starts automatically. No pen drive, no hassle of sending files over WhatsApp, and no manual file handling.',
    'Hum believe karte hain ki technology ka asli purpose logon ka kaam easy banana hai. Isi soch ke saath QR Se Print develop kiya gaya hai, taaki har print shop bina expensive hardware ya complicated setup ke ek modern self-service printing experience de sake.':
      'We believe the real purpose of technology is to make people’s work easier. QR Se Print was built with exactly that in mind, so that every print shop can offer a modern self-service printing experience without expensive hardware or a complicated setup.',
    'Setup ya software use karte waqt koi problem aaye to support kisi third-party team se nahi milta — seedha WhatsApp par personally diya jata hai, taaki har user bina confusion ke QR Se Print ka poora fayda le sake.':
      'If you hit any problem during setup or while using the software, support does not come from some third-party team — it is given personally over WhatsApp, so every user can get the full benefit of QR Se Print without confusion.',
    'Hamara vision hai ki QR Se Print India ka sabse trusted Smart Printing Platform bane — jahan har print shop bina expensive infrastructure ke smart aur automated printing service de sake.':
      'Our vision is for QR Se Print to become India’s most trusted smart printing platform — where every print shop can offer smart, automated printing without expensive infrastructure.',
    'Hum lagatar naye features, better security, faster performance aur reliable technology par kaam kar rahe hain, taaki har business confidently digital printing ka future apna sake.':
      'We keep working on new features, better security, faster performance and reliable technology, so every business can confidently step into the future of digital printing.',
    'dikhayega ki payment complete karne ke baad Shop ID milne se lekar pehla test print nikalne tak kya-kya karna hai. Har step ko order me follow karo — kahin atko to sabse neeche Support section me contact ka tarika bhi diya hai.':
      'shows you everything from receiving your Shop ID after payment through to your first test print. Follow each step in order — and if you get stuck, the Support section at the bottom tells you how to reach us.',
    'Haan, dobara upload karna padega. Hamari policy hai ki koi file store nahi ki jaati — chahe print ho ya cancel. Ye aap khud verify kar sakte ho: System Tray me QR Se Print icon par right-click karke':
      'Yes, it will have to be uploaded again. Our policy is that no file is ever stored — whether it printed or was cancelled. You can verify this yourself: right-click the QR Se Print icon in the System Tray and open',
    '"📋 Logs Dekho"': '"📋 View Logs"',
    'ke through aaye ho — aapke liye special price':
      'referred you — here’s a special price for you',
    'B&W aur color printer': 'Black & white and colour printer',
    'karo.': '.',
    'aur': 'and',

    /* ─────────── WHITE-LABEL PUBLIC PAGE ─────────── */
    'Ruko…': 'Please wait…',

    /* ─────────── SHOP ADMIN PANEL — dashboard, QR, downloads ─────────── */
    'Guide dekho ya support se baat karo': 'Read the guide or talk to support',
    'Demo khatam hone me bacha time': 'Time left before the demo ends',
    'Overall Total Kamai': 'Overall Total Earnings',
    'e.g. "Aaj sirf B&W" ya "Holi offer: sab ₹2"':
      'e.g. "Black & white only today" or "Holi offer: everything ₹2"',
    'Aapki Shop Ka QR Code': 'Your Shop’s QR Code',
    'Ye QR customer ko dikhao. Wo scan karke apni file upload karega aur print nikal jayega.':
      'Show this QR to your customer. They scan it, upload their file, and the print comes out.',
    'Share karo': 'Share',
    'Latest Software Download Karo': 'Download the Latest Software',
    'Naye features aur bug fixes — hamesha latest version chalao':
      'New features and bug fixes — always run the latest version',
    'Naye version me kya-kya aaya hai, dekh lo': 'See what’s new in this version',
    'Step-by-step — software setup aur use karne ka poora tarika':
      'Step by step — how to set up and use the software',
    'A4 poster — print karke shop me laga do, customer khud scan kar lega':
      'A4 poster — print it and put it up in your shop; customers will scan it themselves',
    '⏳ File ban rahi hai…': '⏳ Preparing the file…',
    'Download nahi ho paya': 'The download failed',
    '✅ Download ho gaya — file aapke Downloads folder me hai':
      '✅ Downloaded — the file is in your Downloads folder',

    /* ─────────── SHOP ADMIN — agent / referral ─────────── */
    'Apna referral code, apna dashboard, apni price — sab milta hai. Koi investment nahi, sirf shops jodne hain. Agent banne ke liye pehle apna plan lena zaroori hai.':
      'Your own referral code, your own dashboard, your own pricing — you get it all. No investment, you only need to bring in shops. To become an agent you must buy your own plan first.',
    'hai — ye sabke liye ek hi rehta hai. Aapko har paid shop par':
      'is the same for everyone. On every paid shop you get',
    'Is link se jo bhi register karega wo shop': 'Any shop that registers through this link',
    'aapki list': 'your list',
    'me aa jayegi, aur paid hote hi aapko': 'is added to, and as soon as it pays you get',
    'mil jayega.': '.',
    'Kisi ki dukaan khud register kar do — Shop ID aur password turant ban jayega. Payment aap online kar do, dukaan se cash le lena.':
      'Register someone’s shop yourself — the Shop ID and password are created instantly. You pay online and collect the cash from the shop.',
    '✅ Shop ban gayi!': '✅ Shop created!',
    '⚠️ Ye Shop ID aur password abhi note kar lo — dobara nahi dikhega.':
      '⚠️ Note down this Shop ID and password now — they will not be shown again.',
    '💳 Ab Payment Karo ›': '💳 Now Make the Payment ›',
    '❌ Withdrawal ke liye kam se kam ₹500 chahiye. Abhi aapke paas ₹%s hai.':
      '❌ A minimum of ₹500 is required to withdraw. You currently have ₹%s.',
    'Withdraw kar sakte ho ✅': 'You can withdraw ✅',
    '₹%s aur chahiye': '₹%s more needed',
    'Abhi koi shop onboard nahi hui. Apna link share karo ya upar se shop banao.':
      'No shops onboarded yet. Share your link or create a shop above.',
    'Kamai: %s': 'Earnings: %s',
    'Load nahi hua': 'Could not load',
    'KAMAI': 'EARNINGS',
    'Abhi koi kamai nahi hui.': 'No earnings yet.',

    /* ─────────── SHOP ADMIN — printers, computer, payment setup ─────────── */
    'ℹ️ Yeh list aapke PC pe chal rahe Print Agent se aati hai. Agar list khaali hai ya naya printer nahi dikh raha, agent ko ek baar restart karo ya kuch der wait karo (agent har 30 min mein update karta hai). "System Default Printer" select karne ka matlab — Windows mein jo bhi default set hai, wahi use hoga.':
      'ℹ️ This list comes from the Print Agent running on your PC. If the list is empty or a new printer is missing, restart the agent once or wait a little (the agent refreshes every 30 minutes). Choosing "System Default Printer" means whatever is set as default in Windows will be used.',
    'Aapki Shop ID sirf': 'Your Shop ID can run on only',
    'par chal sakti hai — taaki koi aur aapka Shop ID apne PC me daal kar aapke customer ki files na le sake.':
      '— so that nobody else can enter your Shop ID on their PC and take your customers’ files.',
    'Naya computer lena ho ya Windows dobara install kiya ho, to yahan se purana PC hata dijiye. Uske baad naye PC me Shop ID daal sakte hain.':
      'If you get a new computer or reinstall Windows, remove the old PC here. After that you can enter your Shop ID on the new PC.',
    'Abhi koi computer juda nahi hai —': 'No computer is connected yet —',
    'Abhi koi computer juda nahi hai': 'No computer is connected yet',
    'software me Shop ID daalte hi jud jayega.':
      'it connects as soon as you enter the Shop ID in the software.',
    'Purana computer hata dein? Us PC par printing turant band ho jayegi. Naye PC me Shop ID daal kar dobara shuru kar sakte hain.':
      'Remove the old computer? Printing on that PC will stop immediately. You can start again by entering the Shop ID on the new PC.',
    '⏳ Hata rahe hain…': '⏳ Removing…',
    'Nahi ho paya': 'That didn’t work',
    '✅ Computer hata diya — ab naye PC me Shop ID daal sakte hain':
      '✅ Computer removed — you can now enter the Shop ID on the new PC',
    'Agent kabhi connect nahi hua — shop PC par Print Agent chalu karo':
      'The agent has never connected — start the Print Agent on the shop PC',
    'Agent Offline — shop PC check karo (prints nahi niklenge)':
      'Agent offline — check the shop PC (prints will not come out)',
    '⚠️ Pehli baar Live keys banane se pehle Razorpay aapki shop/business details verify kar sakta hai (1-3 din lag sakte hain). Tab tak "Sirf Counter Payment" mode use kar sakte ho.':
      '⚠️ Before issuing Live keys for the first time, Razorpay may verify your shop or business details (this can take 1–3 days). Until then you can use "Counter Payment Only" mode.',

    /* ─────────── SHOP ADMIN — data export & account deletion ─────────── */
    'Aapke account ka': 'The',
    'poora data': 'complete data',
    'ek file me — shop details, registration, saare print orders, earnings, reviews, withdrawals aur activity logs. Account delete karne se pehle ye zaroor download kar lijiye.':
      'for your account in a single file — shop details, registration, every print order, earnings, reviews, withdrawals and activity logs. Do download this before deleting your account.',
    'Ye kaam': 'This',
    'wapas nahi hota': 'cannot be undone',
    '. Delete karte hi hamesha ke liye mit jayega:':
      '. The moment you delete, this is gone forever:',
    'Aapki shop aur Shop ID': 'Your shop and Shop ID',
    'Saare print orders aur unka hisaab': 'Every print order and its record',
    'Cloudinary par padi baaki files': 'Any remaining files on Cloudinary',
    'QR code kaam karna band kar dega': 'Your QR code will stop working',
    'Confirm karne ke liye niche': 'To confirm, type',
    'likhiye': 'below',
    'Sirf kuch settings badalni hain?': 'Just want to change some settings?',
    'Pehle DELETE likhiye': 'Please type DELETE first',
    'Account HAMESHA ke liye delete ho jayega. Saare orders, earnings aur aapka QR code — sab mit jayega. Ye wapas nahi aayega. Aage badhein?':
      'Your account will be deleted FOREVER. Every order, all earnings and your QR code will be gone. This cannot be undone. Continue?',
    'Aakhri baar puchh rahe hain. Data download kar liya hai? OK dabate hi account delete ho jayega.':
      'Asking one last time. Have you downloaded your data? Pressing OK will delete the account.',
    '⏳ Delete ho raha hai…': '⏳ Deleting…',
    'Account delete ho gaya': 'Account deleted',
    'Aapka data server se hata diya gaya hai.': 'Your data has been removed from the server.',
    'QR Se Print use karne ke liye shukriya.': 'Thank you for using QR Se Print.',

    /* ─────────── SHOP ADMIN — reviews, status, subscription, orders ─────────── */
    'Aapka review QR Se Print ke homepage par dikhega. Bhejne ke baad ek baar check hota hai, phir live ho jaata hai. Kabhi bhi badal sakte ho.':
      'Your review will appear on the QR Se Print homepage. After you send it we check it once, then it goes live. You can change it any time.',
    '✅ Aapka review homepage par live hai.': '✅ Your review is live on the homepage.',
    'Badal ke dobara bhejoge to phir se check hoga.':
      'If you edit and resend it, it will be checked again.',
    'Thoda edit karke lagaya gaya hai.': 'It was published with a small edit.',
    '⏳ Review check ho raha hai.': '⏳ Your review is being checked.',
    'Approve hote hi homepage par dikhne lagega.':
      'It will appear on the homepage as soon as it is approved.',
    '✅ Status: sab theek': '✅ Status: all good',
    '🟡 Customers ko "ink kam" warning dikhegi': '🟡 Customers will see a "low ink" warning',
    '🔴 Customers ko "paper khatam" warning dikhegi':
      '🔴 Customers will see an "out of paper" warning',
    'Is hafte koi paid order nahi': 'No paid orders this week',
    '6 designs — customer khud banayega': '6 designs — the customer builds it themselves',
    '⚠️ Sab band — customer ko sirf': '⚠️ All off — the customer will only see',
    'dikhega.': '.',
    'dikhenge': 'will be shown',
    'dikhega': 'will be shown',
    'Is hafte ka offer — %s din %s ghante baaki': 'This week’s offer — %s days %s hours left',
    'Is hafte ka offer — %s:%s:%s baaki': 'This week’s offer — %s:%s:%s left',
    '🔄 Abhi Renew Karo': '🔄 Renew Now',
    '❌ Subscription Khatam — Prints BAND Hain': '❌ Subscription Ended — Printing Is OFF',
    'Customers abhi order nahi kar sakte. Pay karte hi turant chalu.':
      'Customers cannot order right now. It resumes the moment you pay.',
    '💳 Pay Now — Activate Karo': '💳 Pay Now — Activate',
    '📋 Link copy ho gaya!': '📋 Link copied!',
    'hamari shop': 'our shop',
    '%s me print nikalna hai? Ye link kholo, file bhejo, print ready:':
      'Need a print at %s? Open this link, send your file, and your print is ready:',
    'Yahan se print nikalo': 'Print from here',
    '✨ aaj shuru': '✨ started today',
    '→ kal jitna hi': '→ same as yesterday',
    'Abhi koi order nahi aaya.': 'No orders yet.',
    '❌ Payment nahi hua': '❌ Payment not completed',
    '❌ Aapne DENY kiya — print cancel': '❌ You denied it — print cancelled',
    '✅ Aapne APPROVE kiya — print nikla': '✅ You approved it — the print came out',
    '⏳ Approval ka wait ho raha hai': '⏳ Waiting for approval',
    '🚫 Customer ne payment complete nahi kiya — aapko koi popup nahi aaya, print nahi nikla':
      '🚫 The customer did not complete the payment — no popup came to you and nothing was printed',
    '🗑️ File delete ho chuki hai — koi copy store nahi (privacy safe)':
      '🗑️ The file has been deleted — no copy is stored (privacy safe)',
    '⏳ File 90 minute mein automatic delete ho jaayegi — chahe print ho ya na ho':
      '⏳ The file is deleted automatically within 90 minutes — whether it prints or not',
    '(likha nahi)': '(not written)',
    '🖨️ *QR Se Print* — cyber cafe ke liye automatic print software':
      '🖨️ *QR Se Print* — automatic print software for cyber cafes',
    '🖨️ *%s* — cyber cafe ke liye automatic print software':
      '🖨️ *%s* — automatic print software for cyber cafes',
    /* Share message TL() se line-by-line translate hota hai —
       isliye har LINE ki apni key chahiye, poore block ki nahi. */
    'Dukaan me QR chipkao — customer apne phone se scan karke file bhejta hai, payment karta hai, aur print aapke printer se KHUD nikal jata hai.':
      'Put the QR up in your shop — the customer scans it from their phone, sends the file, pays, and the print comes out of your printer ALL BY ITSELF.',
    '✅ 0% commission — paisa seedha aapke account me':
      '✅ 0% commission — money straight into your account',
    '✅ Na WhatsApp pe file mangna, na pendrive ka virus':
      '✅ No asking for files on WhatsApp, no pen-drive viruses',
    '🎯 %d ghante FREE demo — bina payment ke': '🎯 %d-hour FREE demo — no payment needed',
    'Namaste, main QR Se Print ka shop owner hoon%s. White Label program ke baare me jaanna hai.':
      'Hello, I am a QR Se Print shop owner%s. I would like to know about the White Label programme.',

    /* ─────────── WHITE-LABEL PARTNER PANEL (wl-admin) ─────────── */
    'par dikhega — unka WhatsApp aur email seedha':
      'will be shown — their WhatsApp and email go straight',
    '✅ Message your shops ko dikhne laga': '✅ Your shops can now see the message',
    '⚠️ Ye abhi note kar lo — dobara nahi dikhega.':
      '⚠️ Note this down now — it will not be shown again.',
    'Ya cash liya ho to': 'Or, if you took cash,',
    'me jaakar': 'go to',
    '✅ PC se mili printer list (%s)': '✅ Printer list received from the PC (%s)',
    '⚠️ Is shop ke PC se abhi tak printer list nahi aayi. Agent chalu hone ke 30 min me aati hai — tab tak naam khud type kar sakte ho.':
      '⚠️ No printer list has come from this shop’s PC yet. It arrives within 30 minutes of the agent starting — until then you can type the name yourself.',

    /* ─────────── DATABASE MIGRATION PAGE ─────────── */
    'Railway database ka data Supabase me copy karo':
      'Copy data from the Railway database into Supabase',
    '⚠️ Ye button Railway (purana) se Supabase (naya) me sab data copy karega. Ek se zyada baar dabana safe hai — dobara wahi data copy nahi hoga (skip ho jayega).':
      '⚠️ This button copies all data from Railway (old) into Supabase (new). Pressing it more than once is safe — the same data is not copied twice (it is skipped).',
    '✅ Login ho gaya': '✅ Logged in',
    '📦 Data Copy Karo (Railway → Supabase)': '📦 Copy the Data (Railway → Supabase)',
    '🔍 Check Karo — Supabase me kitna data aaya': '🔍 Check — how much data reached Supabase',
    '⏳ Supabase me count check ho raha hai...': '⏳ Checking the counts in Supabase...',
    '✅ Supabase (naya database) me abhi itna data hai:':
      '✅ Supabase (the new database) currently holds:',
    '⏳ Data copy ho raha hai... 1-2 minute lag sakte hain, page band mat karo.':
      '⏳ Copying data... this can take 1–2 minutes, please don’t close the page.',
    '✅ Data copy ho gaya! Neeche dekho kitne rows aaye:':
      '✅ Data copied! See below how many rows arrived:',

    /* ─────────── REDIRECT PAGE ─────────── */
    'QR Se Print naye address par shift ho gaya hai…': 'QR Se Print has moved to a new address…',
    'Yahan click karo agar khud na khule': 'Click here if it doesn’t open on its own',

    /* ─────────── SUPERADMIN — tools, agent version, QR ─────────── */
    'Aaj ka kaam': 'Today’s work',
    'Jin shops ke QR purane URL (onrender.com) se bane hain, unhe current domain se naya bana deta hai. Jinke QR pehle se sahi hain, unka QR same rahega — koi nuksaan nahi.':
      'Regenerates the QR for any shop whose QR was built from the old URL (onrender.com), using the current domain. Shops whose QR is already correct keep the same QR — nothing is lost.',
    'Shop owner ke panel me download button ke paas yahi dikhega. Khali chhoda to wahan button dikhega hi nahi.':
      'This is what appears next to the download button in the shop owner’s panel. Leave it empty and no button is shown there at all.',
    '"Naya Update Push Karo" button dabao — sab customers ke PC apne aap (1 ghante ke andar, jab unka agent check karega) naya code download karke restart ho jayenge. Kisiko call/WhatsApp karne ki zaroorat nahi.':
      'Press the "Push New Update" button — every customer’s PC downloads the new code and restarts on its own (within an hour, when their agent checks in). No need to call or WhatsApp anyone.',
    '2.0 → 2.1 → 2.2 … 2.10, uske baad 3.0 → 3.1 … Box mein agla version apne aap bhar jaata hai; chaaho to badal sakte ho. Peeche wala version daalne par server reject kar dega.':
      '2.0 → 2.1 → 2.2 … 2.10, then 3.0 → 3.1 … The box fills in the next version automatically; you can change it if you want. If you enter an older version the server will reject it.',
    '❌ Version format galat hai. Aise likho: 2.0, 2.1, 2.10, 3.0':
      '❌ Invalid version format. Write it like this: 2.0, 2.1, 2.10, 3.0',
    '❌ v%s current v%s se aage hona chahiye.': '❌ v%s must be ahead of the current v%s.',
    '📝 "What\'s in Update" me %s line jayegi.': '📝 %s lines will go into "What\'s in Update".',
    '⚠️ "What\'s in the Update" khali hai — shop owner ko koi update note nahi dikhega, aur purana note bhi hat jayega.':
      '⚠️ "What\'s in the Update" is empty — shop owners will see no update note, and the old note will be removed too.',
    'Pakka? Version v%s push hoga aur sab customers ke Print Agent naya code download karenge. Pehle confirm karo GitHub/Render pe naya agent-template/print_agent.py deploy ho chuka hai.%s':
      'Are you sure? Version v%s will be pushed and every customer’s Print Agent will download the new code. First confirm that the new agent-template/print_agent.py has been deployed on GitHub/Render.%s',
    '✅ Version v%s push ho gaya! Sab customers ke PC 1 ghante ke andar auto-update ho jayenge.':
      '✅ Version v%s pushed! Every customer’s PC will auto-update within an hour.',
    'Purana version — latest v%s hai. Agent 1 ghante me khud update ho jayega.':
      'Old version — the latest is v%s. The agent updates itself within an hour.',
    '✅ %s/%s shops ke QR naye ban gaye (%s se)': '✅ QR regenerated for %s of %s shops (from %s)',
    'Koi shop nahi mila': 'No shops found',
    'Pehla page': 'First page',
    'Shop ka naam, ID ya number…': 'Shop name, ID or number…',
    'Shop ka naam, ID, number ya address…': 'Shop name, ID, number or address…',
    'Shop ID, naam ya payment ID se dhoondo…': 'Search by Shop ID, name or payment ID…',
    'Kuch nahi mila — dusra shabd try karo': 'Nothing found — try a different word',
    'Kuch nahi mila.': 'Nothing found.',

    /* ─────────── SUPERADMIN — pricing & festival offer ─────────── */
    '🎉 Festival Offer ON karo': '🎉 Turn the Festival Offer ON',
    'ON karne par One-Time price ke': 'When switched on, the One-Time price gets',
    'ek banner (jaise "Independence Day Offer") aur price ke':
      'a banner (such as "Independence Day Offer") and, ',
    'neeche': 'below the price,',
    'ek ulta countdown timer ("Offer Ending in 6d 12h") dikhega. OFF rakhoge to homepage abhi jaisa dikhta hai waisa hi rahega.':
      'a countdown timer ("Offer Ending in 6d 12h"). Leave it OFF and the homepage stays exactly as it looks now.',
    'jaise: Independence Day Offer': 'e.g. Independence Day Offer',
    'Offer kis date ko khatam': 'The date the offer ends',
    'Agents ke liye alag floor price. Khaali/0 rakho to agent ka price bhi normal Offer Price (upar wala) se hi shuru hoga. Yahan value dogi (jaise 699) to har agent ka':
      'A separate floor price for agents. Leave it empty or 0 and an agent’s price also starts from the normal Offer Price (above). Put a value here (say 699) and every agent’s',
    'apna link isi price se start hoga': 'own link starts from this price',
    '— agent apna price isse upar hi badha sakta hai, apna margin ban jata hai. Registration ka charge bhi isi price se hoga.':
      '— an agent can only raise their price above it, which becomes their margin. Registration is charged from this price too.',
    '0 = Offer Price jaisa hi': '0 = same as the Offer Price',
    'Yeh prices homepage, dashboard, aur payment page pe turant reflect honge. Naye registrations isi naye Offer Price pe honge. Purani shops ka price change nahi hota.':
      'These prices take effect immediately on the homepage, dashboard and payment page. New registrations use this new Offer Price. Prices for existing shops do not change.',
    'Har agent ka link kam se kam': 'Every agent’s link will show at least',
    'dikhayega (agent chahe to isse zyada rakh sakta hai)':
      '(an agent may keep it higher if they wish)',
    'Abhi khaali hai — agent ka floor bhi normal':
      'Currently empty — the agent floor is also the normal',
    '(Offer Price) hi rahega': '(Offer Price)',
    '✅ Price update ho gaya — naye registrations ₹%s (katega) → ₹%s pe honge':
      '✅ Price updated — new registrations will be ₹%s (struck through) → ₹%s',
    'Saare text default par wapas le jaayein? (Save dabane ke baad hi live hoga)':
      'Reset all text back to the defaults? (It only goes live once you press Save)',
    '%s text dikh rahe · %s badle hue': '%s texts shown · %s changed',
    'yahan hai — homepage, Contact/About/Partner/Setup Guide jaise har button ka page, plans, table, popups, aur chaaron legal pages. Har box me':
      'is here — the homepage, the page behind every button such as Contact/About/Partner/Setup Guide, the plans, the table, the popups, and all four legal pages. In each box',
    '📊 Stats Banner (Hero ke niche colorful strip)':
      '📊 Stats banner (the colourful strip below the hero)',
    'Koi FAQ nahi — "+ Naya Sawal" dabao': 'No FAQs — press "+ New Question"',
    '— aur print aapke printer se': '— and the print comes out of your printer',

    /* ─────────── SUPERADMIN — earnings, payments, white-label ─────────── */
    '💰 Kamai (source ke hisaab se)': '💰 Earnings (by source)',
    '💰 Earnings (zyada pehle)': '💰 Earnings (highest first)',
    '🧾 Saare payments dekho': '🧾 View all payments',
    'shop owner ka customer se aaya paisa hai — wo hamari kamai':
      'is money the shop owner received from their customer — that is',
    'nahi': 'not',
    'hai, isliye upar wale total me nahi juda. White-label shops ka setup fee bhi partner ka hai, hamara nahi.':
      'our earning, so it is not added to the total above. The setup fee of white-label shops belongs to the partner too, not to us.',
    'HAMARA TOTAL': 'OUR TOTAL',
    'Hamari kamai': 'Our earnings',
    'Koi payment nahi mila': 'No payments found',
    'partner ka paisa': 'partner’s money',
    'paisa partner ko': 'money goes to the partner',
    'License se hamari kamai': 'Our earnings from licences',
    'Unki kamai (hamare paas nahi)': 'Their earnings (not held by us)',
    'Unki kamai': 'Their earnings',
    'Abhi koi white label partner nahi hai.': 'There are no white-label partners yet.',
    'Abhi koi white-label shop nahi hai': 'There are no white-label shops yet',
    '💳 Razorpay nahi lagaya': '💳 Razorpay not connected',
    '→ bech raha': '→ selling at',
    'Base price = ye partner isse neeche shop ko nahi bech sakta. Badalne par agar iska price base se neeche ho, wo bhi upar utha diya jaayega.':
      'Base price = this partner cannot sell to a shop below it. If you change it and their price is below the base, their price is raised to match.',
    'Is partner ko pause karein? Unka link band ho jayega aur nayi shops register nahi kar payengi.':
      'Pause this partner? Their link will stop working and new shops will not be able to register.',
    'me jaata hai. Humein sirf ek baar ka license fee milta hai.':
      'goes to them. We only receive the one-time licence fee.',
    'par jata hai, aapke paas nahi — kyunki wo unka business hai.':
      'goes to them, not to you — because it is their business.',
    'Ye shops partner (reseller) ne onboard ki hain. Inka paisa':
      'These shops were onboarded by a partner (reseller). Their money',
    'me jaata hai — isliye ye aapke Active Shops aur Total Earnings me nahi ginti.':
      'goes to them — which is why they are not counted in your Active Shops or Total Earnings.',
    '🗑️ Saare Pending Payment delete karo': '🗑️ Delete all pending-payment shops',
    '🧹 Saare Expired Demo delete karo': '🧹 Delete all expired demos',
    'Saari PENDING PAYMENT shops (register hui, paisa nahi aaya) delete ho jayengi. Demo aur white-label shops ko haath nahi lagega. Pakka?':
      'All PENDING PAYMENT shops (registered but never paid) will be deleted. Demo and white-label shops are left untouched. Are you sure?',
    'pending shop delete ho gayi': 'pending shops deleted',
    'Saare EXPIRED DEMO accounts delete ho jayenge. Jo demo abhi chal rahe hain wo safe rahenge. Pakka?':
      'All EXPIRED DEMO accounts will be deleted. Demos that are still running stay safe. Are you sure?',
    'expired demo delete ho gaye': 'expired demos deleted',

    /* ─────────── SUPERADMIN — shops, demos, blocks ─────────── */
    '. Har column me seedha WhatsApp button.': '. Every column has a direct WhatsApp button.',
    'hain — permanent ban kabhi nahi hota. Koi genuine customer galti se atak jaye to "Clear All Blocks" dabao, wo turant chalu ho jayega. Logs 7 din baad apne aap saaf ho jaate hain.':
      'are — a ban is never permanent. If a genuine customer gets stuck by mistake, press "Clear All Blocks" and they are unblocked instantly. Logs clear themselves after 7 days.',
    'karte hi demo shop ban jaati hai aur timer shuru hota hai — phir WhatsApp button se Shop ID bhej do.':
      'creates the demo shop and starts the timer — then send the Shop ID with the WhatsApp button.',
    'karne par request hat jaati hai aur wo number dobara demo le sakta hai.':
      'removes the request and that number can take a demo again.',
    'Clear ALL temporary blocks? Sab blocked IP/shop turant chalu ho jayenge.':
      'Clear ALL temporary blocks? Every blocked IP and shop is unblocked immediately.',
    'Koi demo account nahi.': 'No demo accounts.',
    'Shuru: %s | %s': 'Started: %s | %s',
    'Demo chal rahe': 'Demos running',
    '🔌 PC Hatao': '🔌 Remove PC',
    'Hatao': 'Remove',
    'hataye': 'removed',
    'Abhi juda hai:': 'Currently connected:',
    'Is shop ka computer hata dein?': 'Remove this shop’s computer?',
    'Us PC par printing turant band ho jayegi.': 'Printing on that PC stops immediately.',
    'Shop owner naye PC me apni Shop ID daal kar dobara shuru kar sakega.':
      'The shop owner can start again by entering their Shop ID on the new PC.',
    '✅ PC hata diya': '✅ PC removed',
    'Ab shop owner naye computer me apni Shop ID daal sakta hai.':
      'The shop owner can now enter their Shop ID on a new computer.',
    'PC: %s — hatane par naye PC me Shop ID lag sakegi':
      'PC: %s — remove it and the Shop ID can be used on a new PC',
    'Agent ne onboard ki hai': 'Onboarded by an agent',
    '%s ko Advance Feature FREE unlock karein? (4x6/A3/Duplex/Resume — bina ₹199 payment ke, lifetime)':
      'Unlock Advance Features FREE for %s? (4x6/A3/Duplex/Resume — without the ₹199 payment, for life)',
    '%s ko +30 din extend karein? (Cash/offline payment mila ho tabhi)':
      'Extend %s by 30 days? (Only if you received a cash or offline payment)',
    '%s ka password RESET karein? Owner ka purana password kaam nahi karega.':
      'RESET the password for %s? The owner’s old password will stop working.',
    '%s ko ACTIVATE karein? Iska matlab: aapne Razorpay me payment verify kar liya hai.':
      'ACTIVATE %s? This means you have verified the payment in Razorpay.',
    '"%s" (%s) delete karein? Ye shop wapas nahi aayegi.':
      'Delete "%s" (%s)? This shop cannot be brought back.',

    /* ─────────── SUPERADMIN — printers & payment mode ─────────── */
    '✅ PC se mili printer list (%s)%s': '✅ Printer list received from the PC (%s)%s',
    '⚠️ Is shop ke PC se abhi tak printer list nahi aayi.':
      '⚠️ No printer list has come from this shop’s PC yet.',
    'Agent chalu hone ke baad 30 min me apne aap aati hai. Tab tak naam khud type kar sakte ho (bilkul waise hi jaise Windows me dikhta hai).':
      'It arrives on its own within 30 minutes of the agent starting. Until then you can type the name yourself (exactly as it appears in Windows).',
    '— customer dukaan par cash dega%s': '— the customer pays cash at the shop%s',
    '(abhi yahi set hai)': '(this is what is set now)',
    '🔒 Aap sirf': '🔒 You can only set',
    'set kar sakte ho.': '.',
    'shop owner ko khud apne login se karna hoga — usme uski apni Razorpay/Cashfree key chahiye hoti hai. %s':
      'must be done by the shop owner from their own login — it needs their own Razorpay/Cashfree key. %s',
    'Abhi is shop par set hai:': 'Currently set on this shop:',
    '— ise counter par lane ke liye upar wala box tick karke Save karo.':
      '— to move it to counter payment, tick the box above and press Save.',
    'agent nahi': 'no agent',
    'Data nahi': 'No data',

    /* ─────────── SUPERADMIN — reviews, alerts, analytics, withdrawals ─────────── */
    'Abhi koi review nahi. Upar se add karo.': 'No reviews yet. Add one above.',
    'Abhi koi translation nahi. Upar se add karo.': 'No translations yet. Add one above.',
    '⏳ APPROVAL BAAKI': '⏳ AWAITING APPROVAL',
    '⏳ %s review approval ka intezaar kar rahe hain': '⏳ %s reviews are waiting for approval',
    'review approval baaki': 'reviews awaiting approval',
    '↩ Wapas pending': '↩ Back to pending',
    'Dikhao': 'Show',
    'location nahi': 'no location',
    'ne bheja': 'sent it',
    'edit kiya hua': 'edited',
    'Sab clear hai': 'All clear',
    'Aaj koi cheez atki hui nahi hai.': 'Nothing is stuck today.',
    '✅ Mail accept ho gayi': '✅ The mail was accepted',
    'Bheja:': 'Sent:',
    'Gaya:': 'Delivered to:',
    'kholo. Inbox me na mile to': 'Open it. If it isn’t in the inbox, do check',
    'zaroor dekho — pehli baar aksar wahan jaata hai.': '— the first one often lands there.',
    'deta hai (port block). Ye sirf tab bharo jab aapki hosting SMTP allow karti ho.':
      '(port block). Only fill this in if your hosting allows SMTP.',
    'me likha hai — wahi "original" hai. Har language ke liye uska tarjuma yahan daalo. Jo tarjuma nahi hoga, wahan Hinglish hi dikhega (kuch tootega nahi).':
      'is the "original". Put the translation for each language here. Anything left untranslated simply shows the Hinglish text (nothing breaks).',
    'Purane database (OLD_DATABASE_URL) se saara data is naye DB me copy karein? Safe hai — duplicate rows skip ho jaayengi.':
      'Copy all data from the old database (OLD_DATABASE_URL) into this new one? It is safe — duplicate rows are skipped.',
    '⏳ Copy ho raha hai... ruko, band mat karo': '⏳ Copying... please wait, don’t close this',
    '❌ Cloudinary list nahi ho payi': '❌ Could not list Cloudinary files',
    '⚠️ %s file 90+ min purani — sweep hona chahiye tha':
      '⚠️ %s files are over 90 minutes old — the sweep should have removed them',
    '✅ Sab fresh hain (abhi active jobs ki) — koi leak nahi':
      '✅ All fresh (they belong to active jobs) — no leak',
    '✅ Notification bheja — agent 30 sec me dikhayega':
      '✅ Notification sent — the agent will show it within 30 seconds',
    'kamai (is range me)': 'earnings (in this range)',
    'Abhi is range me koi visit nahi hai.': 'There are no visits in this range yet.',
    'Abhi source data nahi hai. Naya tracking deploy hone ke baad Google / Facebook / Instagram alag-alag dikhne lagenge.':
      'There is no source data yet. Once the new tracking is deployed, Google / Facebook / Instagram will show separately.',
    'setup fee se kamai — %s': 'earnings from setup fees — %s',
    'Abhi data nahi. Naya tracking deploy hone ke baad bharna shuru hoga.':
      'No data yet. It starts filling in once the new tracking is deployed.',
    'Koi utm_source wala link abhi track nahi hua.': 'No utm_source link has been tracked yet.',
    'abhi track shuru hua': 'tracking has just started',
    'Abhi dena hai': 'Currently owed',
    'Abhi koi agent nahi hai.': 'There are no agents yet.',
    '= ₹%s liya': '= ₹%s taken',
    'Abhi koi shop onboard nahi': 'No shops onboarded yet',
    '₹%s dena hai': '₹%s owed',
    'Koi withdrawal request nahi.': 'No withdrawal requests.',
    '✅ Paid Mark Karo': '✅ Mark as Paid',
    '₹%s apne UPI app se bhej diya? Confirm karne par shop owner ko "Paid" dikhega.':
      'Have you sent ₹%s from your UPI app? Once you confirm, the shop owner will see it as "Paid".',

    /* ─────────── SUPERADMIN — WhatsApp follow-up templates ─────────── */
    'Namaste': 'Hello',
    ', QR Se Print par aapka registration ho gaya hai. Setup fee pending hai — activate karne me koi dikkat aa rahi hai kya?':
      ', your registration on QR Se Print is done. The setup fee is still pending — are you having any trouble activating it?',
    ', aapka QR Se Print demo khatam ho chuka hai. Full version chalu kar dein? Setup wahi ka wahi rahega.':
      ', your QR Se Print demo has ended. Shall we switch on the full version? Your setup stays exactly as it is.',
    ', aapka QR Se Print demo khatam hone wala hai. Kaisa laga? Full version chalu kar dein?':
      ', your QR Se Print demo is about to end. How did you find it? Shall we switch on the full version?',
    ', aapka QR Se Print agent offline dikh raha hai. PC band hai ya koi dikkat aa rahi hai?':
      ', your QR Se Print agent is showing as offline. Is the PC switched off, or is something not working?',
    ', kaafi din se QR Se Print par koi order nahi dikha. Sab theek hai? Koi help chahiye to bataiye.':
      ', we haven’t seen any orders on QR Se Print for a while. Is everything all right? Let us know if you need any help.'
,

    /* ─────────── RUNTIME-ASSEMBLED — superadmin Action Center (T() se guzarte hain) ─────────── */
    'Namaste %s, QR Se Print par aapka registration ho gaya hai. Setup fee pending hai — activate karne me koi dikkat aa rahi hai kya?':
      'Hello %s, your registration on QR Se Print is complete. The setup fee is still pending — are you having any trouble activating it?',
    'Namaste %s, QR Se Print ka plan khatam ho gaya hai. Renew kar dein?':
      'Hello %s, your QR Se Print plan has expired. Shall we renew it?',
    'Namaste %s, QR Se Print ka plan khatam hone wala hai. Renew kar dein?':
      'Hello %s, your QR Se Print plan is about to expire. Shall we renew it?',
    'Namaste %s, aapka QR Se Print demo khatam ho chuka hai. Full version chalu kar dein? Setup wahi ka wahi rahega.':
      'Hello %s, your QR Se Print demo has ended. Shall we switch on the full version? Your setup stays exactly as it is.',
    'Namaste %s, aapka QR Se Print demo khatam hone wala hai. Kaisa laga? Full version chalu kar dein?':
      'Hello %s, your QR Se Print demo is about to end. How did you find it? Shall we switch on the full version?',
    'Namaste %s, aapka QR Se Print agent offline dikh raha hai. PC band hai ya koi dikkat aa rahi hai?':
      'Hello %s, your QR Se Print agent is showing as offline. Is the PC switched off, or is something not working?',
    'Namaste %s, kaafi din se QR Se Print par koi order nahi dikha. Sab theek hai? Koi help chahiye to bataiye.':
      'Hello %s, we haven’t seen any orders on QR Se Print for a while. Is everything all right? Let us know if you need any help.',
    '%d din pehle register': 'registered %d days ago',
    'Renewal %d din pehle EXPIRE': 'Renewal EXPIRED %d days ago',
    'Renewal — %d din baaki': 'Renewal — %d days left',
    'EXPIRED — %d din pehle': 'EXPIRED — %d days ago',
    'Demo — %d din baaki': 'Demo — %d days left',
    '%d din se offline': 'offline for %d days',
    '%d ghante se offline': 'offline for %d hours',
    '%d din se offline · v%s': 'offline for %d days · v%s',
    '%d ghante se offline · v%s': 'offline for %d hours · v%s',
    '%d din se print nahi': 'no print for %d days'
,

    /* ─────────── PLACEHOLDERS jo reh gaye the ─────────── */
    'aapka@email.com': 'you@email.com',
    'aapka@gmail.com': 'you@gmail.com',
    'Is update me kya naya hai — har point nayi line me likho:\n\nSync Now button add hua\nConnection ka green/red dot\nPrint speed tez ki gayi':
      'What is new in this update — write each point on its own line:\n\nAdded a Sync Now button\nGreen/red connection dot\nFaster printing'
,

    /* ─────────── SINGULAR forms — "1 days left" na dikhe (exact match %d se pehle chalta hai) ─────────── */
    'Renewal — 1 din baaki': 'Renewal — 1 day left',
    'Demo — 1 din baaki': 'Demo — 1 day left',
    'Renewal 1 din pehle EXPIRE': 'Renewal EXPIRED 1 day ago',
    'EXPIRED — 1 din pehle': 'EXPIRED — 1 day ago',
    '1 din pehle register': 'registered 1 day ago',
    '1 din se offline': 'offline for 1 day',
    '1 ghante se offline': 'offline for 1 hour',
    '1 din se offline · v%s': 'offline for 1 day · v%s',
    '1 ghante se offline · v%s': 'offline for 1 hour · v%s',
    '1 din se print nahi': 'no print for 1 day'

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
    // line-by-line translate ab i18n.js me hai — dono jagah alag copy
    // rakhne se ek ko theek karke doosri bhool jaane ka khatra tha
    var tr = (window.QSPi18n && window.QSPi18n.tLines) || function (s) { return s; };
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
