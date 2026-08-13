"""
QR Se Print — Desktop Control Panel
====================================
Ye module SIRF UI layer hai. Printing, tray, Shop ID verification, update —
sab kuch print_agent.py me jaisa tha waisa hi chalta rahega. Panel unhi
functions ko call karta hai, apna alag logic nahi rakhta.

Design rules (jaan-boojh kar):

1. Panel FAIL karta hai to printing kabhi nahi rukti.
   WebView2 na ho, pywebview install na ho, window crash ho — agent
   background me chalta rehta hai. Panel optional hai, zaroori nahi.

2. Business logic duplicate nahi.
   Settings wahi server APIs se aati/jaati hain jo website ka dashboard
   use karta hai. Agent apne agent_token ko short-lived admin token se
   exchange karta hai (/api/jobs/<shop>/panel-session).

3. Token kabhi JavaScript me nahi jaata.
   Panel ka JS sirf pywebview.api.* call karta hai; asli HTTP request
   Python karta hai. Panel ke HTML me koi secret nahi hota.

4. Close (X) = tray me chhupao. Sirf Exit se agent band hota hai.
"""

import os
import sys
import json
import time
import threading
import webbrowser

# ── Ye print_agent.py se inject hote hain (circular import se bachne ke liye) ──
_AGENT = None          # print_agent module reference


def bind(agent_module):
    """print_agent.py startup par ye call karta hai."""
    global _AGENT
    _AGENT = agent_module


def _log(msg, level="INFO"):
    try:
        _AGENT.log(f"[panel] {msg}", level)
    except Exception:
        print(f"[panel] {msg}")


def panel_html_path():
    """
    agent_panel.html dhundo — .exe (PyInstaller _MEIPASS) aur normal
    script, dono mode me.
    """
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    for cand in (os.path.join(base, "agent_panel.html"),
                 os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_panel.html")):
        if os.path.exists(cand):
            return cand
    return None


# ══════════════════════════════════════════════════════════════
# SERVER SESSION — agent token → short-lived admin token
# ══════════════════════════════════════════════════════════════
class _Session:
    """
    Admin token cache. 2 ghante valid hota hai; expiry se pehle hi
    refresh kar lete hain taaki panel ke beech me 401 na aaye.
    """

    def __init__(self):
        self.token = None
        self.expires_at = 0
        self.shop_type = "paid"
        self.shop_name = ""
        self._lock = threading.Lock()

    def get(self, force=False):
        with self._lock:
            if not force and self.token and time.time() < self.expires_at - 300:
                return self.token
            try:
                import requests
                r = requests.post(
                    f"{_AGENT.SERVER_URL}/api/jobs/{_AGENT.SHOP_ID}/panel-session",
                    headers=_AGENT.auth_headers(), timeout=15)
                if r.status_code != 200:
                    _log(f"panel-session failed: HTTP {r.status_code}", "WARN")
                    return None
                d = r.json()
                self.token = d.get("token")
                self.expires_at = time.time() + int(d.get("expiresInSec") or 7200)
                self.shop_type = d.get("shopType") or "paid"
                self.shop_name = d.get("shopName") or ""
                return self.token
            except Exception as e:
                _log(f"panel-session error: {e}", "WARN")
                return None


_session = _Session()


def shop_type():
    """'demo' ya 'paid' — backend se. Tray menu isi se decide karta hai."""
    try:
        _session.get()
        return _session.shop_type
    except Exception:
        return "paid"


def _api(method, path, payload=None, retry_auth=True):
    """
    Existing admin API call karo, admin token ke saath.
    Wahi endpoints jo website dashboard use karta hai — koi naya API nahi.
    """
    import requests
    token = _session.get()
    if not token:
        return {"ok": False, "error": "Could not reach the server. Check your internet connection."}
    try:
        url = f"{_AGENT.SERVER_URL}{path}"
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        if method == "GET":
            r = requests.get(url, headers=headers, timeout=20)
        elif method == "PUT":
            r = requests.put(url, headers=headers, json=payload or {}, timeout=20)
        else:
            r = requests.post(url, headers=headers, json=payload or {}, timeout=20)

        if r.status_code == 401 and retry_auth:
            _session.get(force=True)                    # token expire — ek baar refresh
            return _api(method, path, payload, retry_auth=False)

        try:
            data = r.json()
        except Exception:
            data = {}
        if r.status_code >= 400:
            return {"ok": False, "error": data.get("error") or f"Server error ({r.status_code})"}
        if isinstance(data, dict):
            data.setdefault("ok", True)
            return data
        return {"ok": True, "data": data}
    except Exception as e:
        return {"ok": False, "error": f"Could not reach the server: {e}"}


# ══════════════════════════════════════════════════════════════
# JS ↔ PYTHON API
# Panel ka har button yahin aata hai.
# ══════════════════════════════════════════════════════════════
class PanelAPI:

    def __init__(self):
        self._window = None
        self._printers_cache = []
        self._printers_at = 0

    # ── window ──
    def win_minimize(self):
        try:
            self._window.minimize()
        except Exception:
            pass
        return {"ok": True}

    def win_maximize(self):
        try:
            self._window.toggle_fullscreen()
        except Exception:
            pass
        return {"ok": True}

    def win_close(self):
        """X = tray me chhupao. Agent BAND NAHI hota."""
        try:
            self._window.hide()
            _log("Panel hidden to tray — agent still running")
        except Exception as e:
            _log(f"hide failed: {e}", "WARN")
        return {"ok": True}

    # ── state ──
    def get_state(self):
        try:
            # Session pehle ensure karo — shopType/shopName wahin se aate hain.
            # Warna pehli baar panel khulte hi DEMO shop bhi "paid" dikhta hai
            # aur upgrade banner gayab ho jaata hai.
            _session.get()
            st = _AGENT.agent_state
            conn = st.get("connection", "connecting")
            remote = _AGENT.REMOTE_VERSION_LABEL
            # Compare INTEGER build numbers, labels nahi — "2.9" > "2.10"
            # string compare me galat aata hai.
            update_available = bool(getattr(_AGENT, "REMOTE_VERSION_INT", 0) > _AGENT.VERSION)
            return {
                "ok": True,
                "shopId": _AGENT.SHOP_ID,
                "shopName": _session.shop_name or _AGENT.SHOP_ID,
                "shopType": _session.shop_type,
                "connection": conn,
                "version": _AGENT.VERSION_LABEL,
                "latestVersion": remote or _AGENT.VERSION_LABEL,
                "updateAvailable": update_available,
                "printerBw": st.get("printer_bw") or st.get("printer") or "",
                "printerColor": st.get("printer_color") or st.get("printer_bw") or st.get("printer") or "",
                "printerBwReady": bool(st.get("printer_bw") or st.get("printer")),
                "printerColorReady": bool(st.get("printer_color") or st.get("printer_bw") or st.get("printer")),
                "lastSync": time.strftime("%I:%M:%S %p"),
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_stats(self):
        """Dashboard ke numbers — wahi endpoint jo website use karta hai."""
        d = _api("GET", "/api/admin/stats")
        if not d.get("ok"):
            return {"ok": False, "error": d.get("error")}
        acts = []
        for j in (d.get("recent") or [])[:4]:
            acts.append({
                "id": "#" + str(j.get("id", ""))[-4:],
                "ago": j.get("ago") or "",
                "status": (j.get("status") or "").title() or "Completed",
            })
        return {
            "ok": True,
            "todayPrints": d.get("todayPrints", d.get("today_prints", 0)) or 0,
            "todayEarnings": d.get("todayEarnings", d.get("today_earnings", 0)) or 0,
            "totalOrders": d.get("totalOrders", d.get("total_orders", 0)) or 0,
            "totalEarnings": d.get("totalEarnings", d.get("total_earnings", 0)) or 0,
            "prevPrints": d.get("prevPrints", 0) or 0,
            "prevEarnings": d.get("prevEarnings", 0) or 0,
            "shopOpen": not bool(d.get("paused")),
            "supply": d.get("supply_warning") or "ok",
            "activity": acts,
        }

    # ── settings (existing APIs) ──
    def get_settings(self):
        d = _api("GET", "/api/admin/profile")
        if not d.get("ok"):
            return {"ok": False, "error": d.get("error")}
        d["hasKeys"] = bool(d.get("has_razorpay_secret") or d.get("has_cashfree_secret"))
        # Secrets kabhi panel tak nahi jaate. Naam se nahi, SUFFIX se hataate
        # hain — kal koi naya secret column add ho to wo bhi apne aap ruk jaye.
        for k in list(d.keys()):
            lk = str(k).lower()
            if (lk.endswith("_secret") or lk.endswith("secret_key")
                    or lk.endswith("password") or lk.endswith("password_hash")
                    or lk.endswith("_token")):
                d.pop(k, None)
        return d

    def save_settings(self, payload):
        if not isinstance(payload, dict):
            return {"ok": False, "error": "Invalid data"}
        return _api("PUT", "/api/admin/settings", payload)

    def save_payment(self, payload):
        if not isinstance(payload, dict):
            return {"ok": False, "error": "Invalid data"}
        body = {"payment_mode": payload.get("payment_mode"),
                "payment_gateway": payload.get("payment_gateway")}
        gw = (payload.get("payment_gateway") or "").lower()
        key, secret = payload.get("key") or "", payload.get("secret") or ""
        # Khaali chhoda = purani value rehne do
        if key:
            body["razorpay_key_id" if gw == "razorpay" else "cashfree_app_id"] = key
        if secret:
            body["razorpay_key_secret" if gw == "razorpay" else "cashfree_secret_key"] = secret
        return _api("PUT", "/api/admin/settings", body)

    # ── printers ──
    def get_printers(self):
        try:
            now = time.time()
            if not self._printers_cache or now - self._printers_at > 20:
                self._printers_cache = _AGENT.list_all_printers() or []
                self._printers_at = now
            return {"ok": True, "printers": self._printers_cache}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def refresh_printers(self):
        self._printers_cache, self._printers_at = [], 0
        try:
            ok, name = _AGENT.check_printer()
            if ok and name:
                _AGENT.agent_state["printer"] = name
            _AGENT.report_printers_to_server()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def save_printers(self, bw, color):
        return _api("PUT", "/api/admin/settings",
                    {"printer_name_bw": bw or "", "printer_name_color": color or ""})

    def test_print(self):
        try:
            fn = getattr(_AGENT, "send_test_print", None)
            if callable(fn):
                fn()
                return {"ok": True}
            return {"ok": False, "error": "Test print is not available in this version"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── shop controls ──
    def set_shop_open(self, is_open):
        return _api("PUT", "/api/admin/settings", {"paused": (not bool(is_open))})

    def set_supply(self, status):
        if status not in ("ok", "ink", "paper"):
            return {"ok": False, "error": "Invalid status"}
        return _api("PUT", "/api/admin/settings", {"supply_warning": status})

    # ── agent actions (existing functions) ──
    def reconnect(self):
        """
        Reconnect — result TURANT.

        Ab HTTP check yahan dobara nahi hota. reconnect_to_server() khud
        socket reset karta hai, print loop ko jagata hai, server ping
        karta hai aur True/False lautata hai. Ek hi jagah logic — tray se
        dabao ya panel se, dono ka vyavhaar bilkul same.
        """
        try:
            connected = _AGENT.reconnect_to_server()
        except Exception as e:
            return {"ok": False, "error": str(e)}

        printer = _AGENT.agent_state.get("printer") or ""
        if connected:
            return {"ok": True, "connected": True, "printer": printer}
        return {"ok": True, "connected": False,
                "error": "Server tak nahi pahunch paye — internet check karo"}

    def open_logs(self):
        try:
            _AGENT.open_logs()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def contact_admin(self, message=""):
        try:
            _AGENT.contact_admin()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def change_shop_id(self):
        try:
            threading.Thread(target=_AGENT.change_shop_id, daemon=True).start()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def check_update(self):
        try:
            remote = _AGENT.get_remote_version()
            label = _AGENT.REMOTE_VERSION_LABEL or (str(remote) if remote else _AGENT.VERSION_LABEL)
            avail = bool(remote and remote > _AGENT.VERSION)
            return {"ok": True, "updateAvailable": avail, "latestVersion": label}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def do_update(self):
        try:
            fn = getattr(_AGENT, "check_and_update", None) or getattr(_AGENT, "apply_update_and_restart", None)
            if callable(fn):
                threading.Thread(target=fn, daemon=True).start()
                return {"ok": True}
            return {"ok": False, "error": "Update is not available in this build"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── QR & links ──
    def get_qr(self):
        d = _api("GET", "/api/admin/profile")
        if not d.get("ok"):
            return {"ok": False, "error": d.get("error")}
        return {"ok": True,
                "qrUrl": f"{_AGENT.SERVER_URL}/print/{_AGENT.SHOP_ID}",
                "qrCode": d.get("qr_code") or ""}

    def download_qr(self):
        try:
            d = _api("GET", "/api/admin/profile")
            data_uri = (d or {}).get("qr_code") or ""
            if not data_uri.startswith("data:image"):
                return {"ok": False, "error": "QR not available"}
            import base64
            raw = base64.b64decode(data_uri.split(",", 1)[1])
            dest = os.path.join(os.path.expanduser("~"), "Desktop",
                                f"QR_{_AGENT.SHOP_ID}.png")
            if not os.path.isdir(os.path.dirname(dest)):
                dest = os.path.join(_AGENT._APPDATA_DIR, f"QR_{_AGENT.SHOP_ID}.png")
            with open(dest, "wb") as f:
                f.write(raw)
            try:
                os.startfile(os.path.dirname(dest))
            except Exception:
                pass
            return {"ok": True, "path": dest}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def open_url(self, path=""):
        try:
            url = path if str(path).startswith("http") else f"{_AGENT.SERVER_URL}{path}"
            webbrowser.open(url)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── DEMO → PAID CONVERSION ──
    def verify_paid_shop(self, paid_shop_id, password):
        """
        Step 1: paid Shop ID + password server par verify karo.
        Yahan kuch badalta NAHI — sirf check hota hai.
        """
        import requests
        pid = str(paid_shop_id or "").strip().upper()
        pwd = str(password or "")
        if not pid:
            return {"ok": False, "error": "Please enter your paid Shop ID"}
        if not pwd:
            return {"ok": False, "error": "Please enter your shop password"}
        try:
            r = requests.post(
                f"{_AGENT.SERVER_URL}/api/agent/verify-paid-shop",
                headers=_AGENT.auth_headers(), timeout=20,
                json={"paidShopId": pid, "password": pwd, "demoShopId": _AGENT.SHOP_ID})
            d = r.json() if r.content else {}
            if r.status_code != 200 or not d.get("success"):
                return {"ok": False, "error": d.get("error") or f"Verification failed ({r.status_code})"}
            # Ticket Python me rakho — JS ko kabhi nahi dete
            self._convert_ticket = d.get("ticket")
            return {"ok": True, "shopId": d.get("shopId"), "shopName": d.get("shopName"),
                    "planType": d.get("planType"), "alreadyLinked": bool(d.get("alreadyLinked"))}
        except Exception as e:
            return {"ok": False, "error": f"Could not reach the server: {e}"}

    def convert_to_paid(self):
        """
        Step 2: switch. Server agent token transfer karta hai, phir agent
        apna Shop ID live badal leta hai — koi reinstall, koi restart nahi.
        """
        import requests
        ticket = getattr(self, "_convert_ticket", None)
        if not ticket:
            return {"ok": False, "error": "Please verify your paid Shop ID first"}
        try:
            r = requests.post(
                f"{_AGENT.SERVER_URL}/api/agent/convert-to-paid",
                headers=_AGENT.auth_headers(), timeout=25, json={"ticket": ticket})
            d = r.json() if r.content else {}
            if r.status_code != 200 or not d.get("success"):
                return {"ok": False, "error": d.get("error") or f"Switch failed ({r.status_code})"}

            new_id = d.get("shopId")
            switched = _AGENT.switch_shop_id_live(new_id)
            if not switched:
                return {"ok": False,
                        "error": "Your shop was linked on the server, but the Shop ID could not be applied "
                                 "on this PC. Use 'Change Shop ID' from the tray and enter: " + str(new_id)}
            # "memory-only" = switch ho gaya aur printing chal rahi hai, bas
            # config file save nahi hui. Customer ko batao, par fail mat karo.
            warn = None
            if switched == "memory-only":
                warn = ("Connected, but the Shop ID could not be saved on this PC. "
                        "If it asks again after a restart, enter: " + str(new_id))

            # Session reset — ab paid shop ka data aana chahiye
            self._convert_ticket = None
            _session.token = None
            _session.expires_at = 0
            _session.get(force=True)
            _log(f"Converted to paid shop {new_id}")
            out = {"ok": True, "shopId": new_id, "shopName": d.get("shopName")}
            if warn:
                out["warning"] = warn
            return out
        except Exception as e:
            return {"ok": False, "error": f"Could not reach the server: {e}"}

    def open_upgrade(self):
        """Panel ko upgrade page par le jao."""
        try:
            if self._window:
                self._window.evaluate_js("go('upgrade')")
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}


API = PanelAPI()


# ══════════════════════════════════════════════════════════════
# WINDOW LIFECYCLE
#
# ZAROORI (Windows): pywebview ka window SIRF main thread par ban sakta
# hai. Background thread se banane par ye error aata hai:
#     "pywebview must be run on a main thread"
#
# Udhar pystray (tray icon) ka icon.run() bhi main thread chahta hai.
# Dono ek hi thread nahi le sakte, isliye kaam ese baanta hai:
#
#     MAIN thread      ->  pywebview  (webview.start(), blocking)
#     Background thread->  pystray    (icon.run_detached())
#
# Window ek hi baar banti hai aur chhupi rehti hai. Tray ka "Settings"
# use sirf show/hide karta hai — har baar nayi window nahi banti.
# ══════════════════════════════════════════════════════════════
_window = None
_ui_running = False
_unavailable_reason = None
_pending_page = None


def _goto_pending_page():
    """Tray se 'upgrade' bola gaya ho to panel wahin khule."""
    global _pending_page
    if not _pending_page or _window is None:
        return
    try:
        _window.evaluate_js(f"go('{_pending_page}')")
    except Exception:
        pass
    _pending_page = None


def panel_available():
    """
    pywebview + agent_panel.html dono chahiye. Purane Windows 10 par
    WebView2 runtime na ho to panel nahi chalega — tab agent tray me
    pehle jaisa hi chalta rahega, printing par koi asar nahi.
    """
    global _unavailable_reason
    try:
        import webview  # noqa: F401
    except Exception as e:
        _unavailable_reason = f"pywebview not available ({e})"
        return False
    if not panel_html_path():
        _unavailable_reason = "agent_panel.html not found next to the agent"
        return False
    return True


def start_ui_loop(show_now=True):
    """
    MAIN THREAD se hi call karo. Window banata hai aur webview ka loop
    chalata hai — ye call block ho jaata hai (jaise pehle icon.run() hota tha).

    True  = loop theek chala aur ab band ho gaya (Exit)
    False = shuru hi nahi ho paaya (caller tray-only mode me chale)
    """
    global _window, _ui_running

    if not panel_available():
        _log(f"Panel unavailable — {_unavailable_reason}", "WARN")
        return False

    try:
        import webview
        _window = webview.create_window(
            "QR Se Print — Print Agent",
            panel_html_path(),
            js_api=API,
            width=1180, height=760,
            min_size=(940, 620),
            background_color="#12131a",
            hidden=not show_now,
            confirm_close=False,
        )
        API._window = _window

        def _on_closing():
            """X = chhupao, band mat karo. Sirf Exit se agent rukta hai."""
            try:
                _window.hide()
                _log("Panel hidden to tray — agent still running")
            except Exception:
                pass
            return False        # close cancel

        try:
            _window.events.closing += _on_closing
        except Exception:
            _log("close-to-tray hook unavailable in this pywebview build", "WARN")

        try:
            _window.events.loaded += lambda: _goto_pending_page()
        except Exception:
            pass

        _ui_running = True
        _log("Panel UI loop starting on the main thread")
        webview.start(debug=False)          # yahan block hota hai
        _log("Panel UI loop ended")
        return True

    except Exception as e:
        _log(f"Panel UI loop failed: {e} — agent continues in the tray", "ERROR")
        return False
    finally:
        _ui_running = False
        _window = None
        API._window = None


def open_panel(icon=None, item=None, page=None):
    """
    Tray ka '⚙ Settings' / double-click yahan aate hain.
    Window pehle se bani hui hai — bas dikha dete hain.
    Ye tray ke thread se call hota hai, isliye yahan window BANATE nahi.
    """
    global _pending_page
    if page:
        _pending_page = page

    if _window is None:
        _log("Panel is not available on this PC", "WARN")
        try:
            _AGENT._msgbox(
                "The desktop panel could not start on this PC.\n\n"
                "The Print Agent is still running normally and your printing is unaffected.\n\n"
                "Tip: installing the Microsoft Edge WebView2 Runtime enables the panel.",
                "QR Se Print")
        except Exception:
            pass
        return

    try:
        _window.show()
        _goto_pending_page()
        _log("Panel shown")
    except Exception as e:
        _log(f"Could not show the panel: {e}", "WARN")


def shutdown():
    """Exit ke waqt window band karo taaki main thread ka loop khatam ho."""
    try:
        if _window is not None:
            _window.destroy()
    except Exception:
        pass
