/* ══════════════════════════════════════════════════════════════
   QR Se Print — i18n engine (saare pages ke liye ek hi file)

   Kaise kaam karta hai:
   - HTML me jo Hinglish text likha hai wahi "source" hai (koi key nahi).
   - Server se us language ki dictionary aati hai: { source: translation }.
   - Har text node ka original yaad rakha jaata hai, isliye language
     wapas badalne par sab theek ho jaata hai.
   - MutationObserver naye elements ko bhi translate karta hai — yahi
     purane system ki sabse badi kami thi (JS se bana content chhoot jaata tha).
   - placeholder / title / aria-label / button value bhi translate hote hain.
   - Translation na mile to source hi dikhta hai — kuch tootta nahi.
   ══════════════════════════════════════════════════════════════ */
(function (w, d) {
  'use strict';

  var SRC_LANG = 'hin';                 // HTML me jo likha hai wo Hinglish hai
  var STORE_KEY = 'qsp_lang';
  var LANGS = {
    hin: 'Hinglish', hi: 'हिंदी', en: 'English',
    bn: 'বাংলা', ta: 'தமிழ்', te: 'తెలుగు', kn: 'ಕನ್ನಡ'
  };
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  var dict = {};
  var lang = SRC_LANG;
  var origText = new WeakMap();         // text node -> original string
  var origAttr = new WeakMap();         // element   -> { attr: original }
  var observer = null;

  function getLang() {
    try { return localStorage.getItem(STORE_KEY) || SRC_LANG; } catch (e) { return SRC_LANG; }
  }
  function saveLang(l) {
    try { localStorage.setItem(STORE_KEY, l); } catch (e) {}
  }

  // Kuch jagah translate nahi karna — warna code/URL tak badal jaata hai
  function skip(node) {
    var p = node.parentNode;
    while (p && p.nodeType === 1) {
      var t = p.tagName;
      if (t === 'SCRIPT' || t === 'STYLE' || t === 'TEXTAREA' || t === 'CODE' || t === 'PRE') return true;
      if (p.hasAttribute && p.hasAttribute('data-no-i18n')) return true;
      p = p.parentNode;
    }
    return false;
  }

  function translateText(node) {
    if (skip(node)) return;
    var raw = origText.get(node);
    if (raw === undefined) {
      raw = node.nodeValue;
      if (!raw || !raw.trim()) return;
      origText.set(node, raw);
    }
    var key = raw.trim();
    if (!key) return;
    var hit = dict[key];
    if (hit) {
      // Aage-peeche ka space/newline waisa hi rakho (layout na bigde)
      node.nodeValue = raw.replace(key, hit);
    } else if (node.nodeValue !== raw) {
      node.nodeValue = raw;               // wapas original
    }
  }

  function translateAttrs(el) {
    if (!el.getAttribute) return;
    var store = origAttr.get(el);
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var cur = el.getAttribute(a);
      if (cur === null) continue;
      if (!store) { store = {}; origAttr.set(el, store); }
      if (store[a] === undefined) store[a] = cur;
      var key = (store[a] || '').trim();
      if (!key) continue;
      var hit = dict[key];
      el.setAttribute(a, hit || store[a]);
    }
  }

  function walk(root) {
    if (!root) return;
    // Text nodes
    try {
      var tw = d.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
      var n, list = [];
      while ((n = tw.nextNode())) list.push(n);
      for (var i = 0; i < list.length; i++) translateText(list[i]);
    } catch (e) {}
    // Attributes
    try {
      if (root.nodeType === 1) translateAttrs(root);
      var els = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (var j = 0; j < els.length; j++) translateAttrs(els[j]);
    } catch (e) {}
  }

  // Badalte waqt observer BAND rakhte hain. Sirf ek flag kaafi nahi tha —
  // MutationObserver ka callback baad me (microtask) chalta hai, tab tak
  // flag false ho chuka hota tha aur apne hi badlaav par loop chal jaata tha.
  function withoutObserver(fn) {
    var was = observer;
    if (was) was.disconnect();
    try { fn(); } finally {
      if (was) was.observe(d.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function applyAll() {
    withoutObserver(function () { walk(d.body); });
  }

  function startObserver() {
    if (observer || !w.MutationObserver) return;
    observer = new MutationObserver(function (muts) {
      withoutObserver(function () {
        try {
          for (var i = 0; i < muts.length; i++) {
            var m = muts[i];
            if (m.type === 'childList') {
              for (var j = 0; j < m.addedNodes.length; j++) {
                var nd = m.addedNodes[j];
                if (nd.nodeType === 3) translateText(nd);
                else if (nd.nodeType === 1) walk(nd);
              }
            } else if (m.type === 'characterData') {
              // Sirf tab naya original maano jab ye humara kiya hua na ho
              var known = origText.get(m.target);
              var now = m.target.nodeValue;
              if (known !== undefined) {
                var t = (known || '').trim();
                if (dict[t] && now === (known || '').replace(t, dict[t])) continue;
              }
              origText.delete(m.target);
              translateText(m.target);
            }
          }
        } catch (e) {}
      });
    });
    observer.observe(d.body, { childList: true, subtree: true, characterData: true });
  }

  function fetchDict(l) {
    if (l === SRC_LANG) return Promise.resolve({});
    return fetch('/api/i18n/' + encodeURIComponent(l))
      .then(function (r) { return r.json(); })
      .then(function (x) { return (x && x.dict) || {}; })
      .catch(function () { return {}; });
  }

  function setLang(l) {
    if (!LANGS[l]) l = SRC_LANG;
    lang = l;
    saveLang(l);
    d.documentElement.setAttribute('lang', l === 'hin' ? 'hi' : l);
    return fetchDict(l).then(function (dc) {
      dict = dc;
      applyAll();
      startObserver();
      // Sabhi language selectors sync
      var sels = d.querySelectorAll('select[data-i18n-select], #langSel');
      for (var i = 0; i < sels.length; i++) sels[i].value = l;
      try { w.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: l } })); } catch (e) {}
      return l;
    });
  }

  // Language selector jahan bhi mile, use bhar do
  function fillSelectors() {
    var sels = d.querySelectorAll('select[data-i18n-select], #langSel');
    for (var i = 0; i < sels.length; i++) {
      var s = sels[i];
      if (s.getAttribute('data-i18n-ready')) continue;
      s.innerHTML = '';
      for (var k in LANGS) {
        if (!LANGS.hasOwnProperty(k)) continue;
        var o = d.createElement('option');
        o.value = k; o.textContent = LANGS[k];
        s.appendChild(o);
      }
      s.value = lang;
      s.setAttribute('data-i18n-ready', '1');
      s.addEventListener('change', function (e) { setLang(e.target.value); });
    }
  }

  function init() {
    lang = getLang();
    fillSelectors();
    if (lang !== SRC_LANG) setLang(lang);
    else startObserver();
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init);
  else init();

  // Bahar se bhi use ho sake
  w.QSPi18n = {
    setLang: setLang,
    getLang: function () { return lang; },
    langs: LANGS,
    refresh: applyAll
  };
  // Purana naam bhi chalta rahe (kahin call ho raha ho to na toote)
  if (!w.setLang) w.setLang = setLang;
})(window, document);
