"""
QR Se Print - Local Agent v6.0
NEW: System Tray (background mein chalta hai, koi CMD window nahi)
NEW: Auto-Update (naya version aane par khud download + restart)
"""

import requests
import time
import os
import sys
import tempfile
import subprocess
import threading
import shutil
import secrets
import re
import json
from datetime import datetime
from pathlib import Path

# SAFETY FIX: Jab Windows Startup se .exe automatically chalता hai (PC
# restart ke baad), default working directory C:\Windows\System32 hoti
# hai — agent ka apna installation folder NAHI. Agar kahin bhi relative
# path use ho (ya future mein use ho), yeh galat jagah resolve hoga.
# Yahan explicitly apne exe/script ke folder mein switch karte hain.
try:
    if getattr(sys, 'frozen', False):
        _app_dir = os.path.dirname(sys.executable)
    else:
        _app_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(_app_dir)
except Exception:
    pass  # agar yeh fail ho bhi jaaye, baaki sab APPDATA-based paths use karte hain to safe hai

# ============================================================
# SHOP_ID_TEMPLATE: .py source mode mein yahan seedha Shop ID daala jaata hai
# (server download-package banate waqt isko replace karta hai). .exe mode mein
# yeh hamesha unconfigured marker hi rahega — asli Shop ID config file se aata hai.
#
# NOTE: UNCONFIGURED_MARKER ko is naam se isliye rakha hai (alag string) taaki
# server.js ka text-replace operation sirf SHOP_ID_TEMPLATE ki line ko hi
# touch kare, comparison check ko corrupt na kare.
UNCONFIGURED_MARKER = "AAPKA" + "_SHOP_ID"
SHOP_ID_TEMPLATE   = "AAPKA_SHOP_ID"
SERVER_URL         = "https://qrseprint.in"
# ── POLLING KI TEEN SPEED ──
# Dukaan busy ho to 5s, thodi der khaali ho to 10s, kaafi der se
# khaali ho to 12s. Job aate hi turant 5s par wapas aa jata hai,
# isliye print me deri kabhi nahi hoti.
CHECK_INTERVAL     = 5          # Abhi job aaya tha — sabse tez
IDLE_INTERVAL_1    = 10         # 2 min se khaali
IDLE_INTERVAL_2    = 12         # 10 min se khaali
# Kitni der baad agli speed par jayen (second me)
IDLE_STEP_1_SEC    = 120        # 2 min  -> 10s
IDLE_STEP_2_SEC    = 600        # 10 min -> 12s
# Purane build se compatibility ke liye naam rakha hai
IDLE_INTERVAL_3    = 12
# Lambi idle ke baad TCP socket aksar mar chuka hota hai (NAT/ISP
# timeout, ya Render ka sleep). Us mari hui socket par pehla poll
# fail hota hai. Isliye khaali baithe rehne par har itni der me
# session KHUD refresh kar dete hain — job aane se PEHLE.
IDLE_SOCKET_REFRESH_SEC = 300   # 5 min
# Offline hone par kitne second ka ulta counter dikhe, phir khud
# reconnect ho jaye.
AUTO_RECONNECT_SECONDS  = 10
# Lambi outage me notification kitni der me ek baar (reconnect ki
# koshish phir bhi chalti rehti hai — sirf notification rukti hai).
AUTO_RECONNECT_NOTIFY_GAP = 600  # 10 min
# Dukaan din bhar me sirf kuch der busy rehti hai. Har 5 second poll karne se
# roz lakhon request jaati hain aur server ka bandwidth khatam ho jaata hai.
# Isliye khaali waqt me dheere check karo — par job aate hi turant 5s par
# wapas aa jao, taaki print me deri na ho.
UPDATE_CHECK_INTERVAL = 3600    # Auto-update check karne ka interval (1 ghanta)
VERSION            = 33           # INTERNAL counter — server ke agent_version se compare hota hai.
                                  # Ye sirf badhta hai (29 → 30 → 31...). Isko kabhi
                                  # "2.0" mat banao: purane v27/v28/v29 agents integer
                                  # compare karte hain, warna woh update lena band kar denge.
VERSION_LABEL      = "2.3"        # Jo sab jagah DIKHTA hai: 2.0 → 2.1 ... 2.10 → 3.0
REMOTE_VERSION_LABEL = None       # Server ka latest label — update check par bhar jaata hai
REMOTE_VERSION_INT = 0            # Server ka internal build number (integer compare ke liye)
SUPPORT_WA         = "918404832414"  # Admin WhatsApp (shop-login Support jaisa) — Contact Admin isi par khulega

# Log/temp files hamesha user-writable folder (%APPDATA%) mein rakhte hain —
# kyunki .exe install hone par Program Files mein likhna permission-denied
# de sakta hai. Yeh dono mode (.py script aur .exe) ke liye safe hai.
_APPDATA_DIR = os.path.join(os.environ.get('APPDATA', tempfile.gettempdir()), 'QRSePrint')
os.makedirs(_APPDATA_DIR, exist_ok=True)
LOG_FILE           = os.path.join(_APPDATA_DIR, "print_agent_log.txt")

# ══════════════════════════════════════════════════════════════════
# TLS CA BUNDLE PIN — PyInstaller --onefile ka _MEIxxxxx temp folder
# Windows Storage Sense / temp cleaners 8-12 ghante chalte agent ke
# neeche se uda dete hain. Uske baad har HTTPS request "Could not find
# a suitable TLS CA certificate bundle" se fail hoti hai — agent tray
# mein "Running" dikhta hai par server tak kuch nahi pahunchta.
# Fix: startup par cacert.pem ko APPDATA mein copy karke env se wahi
# point karo — _MEI ude to bhi HTTPS zinda rahega.
# ══════════════════════════════════════════════════════════════════
def _pin_ca_bundle():
    try:
        import certifi
        src = certifi.where()
        dst = os.path.join(_APPDATA_DIR, "cacert.pem")
        try:
            if (not os.path.exists(dst)
                    or os.path.getsize(dst) != os.path.getsize(src)):
                shutil.copy2(src, dst)
        except Exception:
            pass  # copy fail ho to purani pinned copy chalegi (agar hai)
        if os.path.exists(dst) and os.path.getsize(dst) > 10000:
            os.environ["REQUESTS_CA_BUNDLE"] = dst
            os.environ["SSL_CERT_FILE"] = dst
    except Exception:
        pass  # certifi hi nahi mila — requests apne default par chalega

_pin_ca_bundle()
LOCAL_VERSION_FILE = os.path.join(_APPDATA_DIR, "agent_version.txt")
SHOP_CONFIG_FILE   = os.path.join(_APPDATA_DIR, "shop_config.txt")
APPROVAL_CONFIG    = os.path.join(_APPDATA_DIR, "approval_mode.txt")
AGENT_TOKEN_FILE   = os.path.join(_APPDATA_DIR, "agent_token.txt")
# Jab owner exe par dobara double-click kare, doosra instance yahan ek
# chhoti file chhod jaata hai. CHALU agent use dekh kar apna panel khol
# deta hai. (Iske bina doosra instance chup-chaap band ho jaata tha aur
# owner ko lagta tha "kuch hua hi nahi".)
PANEL_REQUEST_FILE = os.path.join(_APPDATA_DIR, "show_panel.request")


def _machine_name():
    """PC ka naam — sirf dikhane ke liye ("kis computer par juda hai")."""
    try:
        import socket
        return (os.environ.get("COMPUTERNAME") or socket.gethostname() or "")[:100]
    except Exception:
        return ""

def load_or_create_agent_token():
    """
    Secret that proves this really is the shop's own agent.

    Why: /api/jobs/pending/<shop_id> used to be open to anyone. A Shop ID is
    printed on the QR poster, so anybody could poll it, read customers'
    uploaded files and steal print jobs. Now every request carries this token.

    The token is created once on this PC and reused forever. The first agent
    that sends a token claims that shop on the server, so nobody else can.
    """
    try:
        if os.path.exists(AGENT_TOKEN_FILE):
            with open(AGENT_TOKEN_FILE, "r", encoding="utf-8") as f:
                tok = f.read().strip()
            if 16 <= len(tok) <= 64:
                return tok
        tok = secrets.token_urlsafe(24)[:40]
        with open(AGENT_TOKEN_FILE, "w", encoding="utf-8") as f:
            f.write(tok)
        return tok
    except Exception:
        # Even if the file cannot be written, keep printing (server allows
        # a missing token until the admin enforces it).
        return ""


AGENT_TOKEN = load_or_create_agent_token()


def auth_headers():
    """Header sent with every agent request."""
    return {"X-Agent-Token": AGENT_TOKEN} if AGENT_TOKEN else {}

def get_machine_id():
    """Windows MachineGuid — used for demo machine-lock. Falls back to hostname."""
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                             r"SOFTWARE\Microsoft\Cryptography",
                             0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY)
        val, _ = winreg.QueryValueEx(key, "MachineGuid")
        winreg.CloseKey(key)
        return str(val)[:80]
    except Exception:
        try:
            import socket
            return "host_" + socket.gethostname()[:70]
        except Exception:
            return ""

MACHINE_ID = get_machine_id()

def approval_enabled():
    """Owner-approval popup for counter jobs — ON by default."""
    try:
        if os.path.exists(APPROVAL_CONFIG):
            return open(APPROVAL_CONFIG).read().strip() != "off"
    except Exception:
        pass
    return True

def set_approval(on):
    try:
        with open(APPROVAL_CONFIG, "w") as f:
            f.write("on" if on else "off")
    except Exception:
        pass
# ============================================================

# Tray icon ke liye global state — taaki tray menu se live status dikhaya ja sake
agent_state = {
    "status": "Starting...",
    "printer": "Unknown",
    "tray_icon": None,
    "running": True,
    # "online" | "connecting" | "offline" — tray aur desktop panel dono
    # isi se apna status dot dikhate hain.
    "connection": "connecting",
    # Reconnect to Server button set karta hai; print_loop ise consume karta hai.
    "reconnect_requested": False,
}

# Log file kabhi rotate nahi hoti thi — mahino chalne wale PC par ye
# badhti hi rehti thi. Ab 2 MB par ek baar .old me chali jaati hai.
# Sirf 1 backup rakhte hain: purani log itni purani ho jaati hai ki
# uska koi kaam nahi bachta, aur disk bharna is se bada problem hai.
LOG_MAX_BYTES = 2 * 1024 * 1024


def _rotate_log_if_big():
    """2 MB se badi ho to log ko .old bana kar nayi shuru karo."""
    try:
        if os.path.getsize(LOG_FILE) < LOG_MAX_BYTES:
            return
    except OSError:
        return          # file hai hi nahi — kuch karne ki zaroorat nahi
    old = LOG_FILE + ".old"
    try:
        if os.path.exists(old):
            os.remove(old)
        os.replace(LOG_FILE, old)
    except Exception:
        # Rotation fail ho jaye to bhi logging ruknI nahi chahiye
        pass


def log(msg, level="INFO"):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] [{level}] {msg}"
    try:
        print(line)
    except Exception:
        pass  # .exe windowed mode mein console hi nahi hota, print() fail ho sakta hai
    try:
        _rotate_log_if_big()
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except:
        pass

# ─── BACKGROUND THREAD KA CRASH BHI LOG ME AAYE ──────────────────────
# Python by default background thread ka traceback stderr par bhejta hai.
# Windowed .exe me stderr hai hi nahi — wo traceback kahin nahi jaata.
# Isi wajah se "na tray icon, na panel, aur log bilkul saaf" wali halat
# banti thi: pystray apna tray window ek alag thread me banata hai, wahan
# koi exception aata to wo thread chup-chaap mar jaata aur kisi ko pata
# hi nahi chalta ki hua kya.
def _thread_excepthook(args):
    try:
        import traceback as _tb
        tname = getattr(getattr(args, "thread", None), "name", "?")
        log(f"💥 Background thread '{tname}' crash: "
            f"{args.exc_type.__name__}: {args.exc_value}", "ERROR")
        log("".join(_tb.format_exception(
            args.exc_type, args.exc_value, args.exc_traceback)), "ERROR")
    except Exception:
        pass          # logging khud fail ho jaye to bhi process na ruke


try:
    threading.excepthook = _thread_excepthook          # Python 3.8+
except Exception:
    pass


def is_running_as_exe():
    """
    PyInstaller se bana .exe chal raha hai ya normal Python script?
    .exe mode mein sab dependencies already bundled hoti hain.
    """
    return getattr(sys, 'frozen', False)

# ─── SAFE CHILD PROCESS ENVIRONMENT (PyInstaller onefile fix) ─────────
# PyInstaller ka --onefile bootloader apne aap ko batane ke liye kuch env
# variables set karta hai (_MEIPASS2 / _PYI_APPLICATION_HOME_DIR). Agar hum
# subprocess.Popen se naya .exe launch karein to ye variables CHILD ko
# inherit ho jaate hain. Tab naya .exe sochta hai "main already unpacked
# hoon" aur apna alag temp folder extract NAHI karta — wahi purana
# _MEIxxxxxx use karta hai. Purana process exit hote hi uska bootloader
# us folder ko DELETE kar deta hai, aur naya process beech import mein hi
# mar jaata hai:
#     [Errno 2] No such file or directory: ...\Temp\_MEIxxxxx\base_library.zip
# Isliye har child launch se pehle ye variables hata do.
# Version label format check: "2.0", "2.10", "3.1" — teen digit tak allowed.
_VERSION_LABEL_RE = re.compile(r'^\d{1,3}\.\d{1,3}$')

_PYI_BOOTLOADER_VARS = (
    '_MEIPASS2',
    '_PYI_APPLICATION_HOME_DIR',
    '_PYI_ARCHIVE_FILE',
    '_PYI_PARENT_PROCESS_LEVEL',
    '_PYI_SPLASH_IPC',
)

def _child_env():
    """A clean copy of the environment, safe to hand to a new .exe/process."""
    env = os.environ.copy()
    for var in _PYI_BOOTLOADER_VARS:
        env.pop(var, None)
    return env

def _spawn_detached(args, cwd=None):
    """
    Launch a fully independent process that survives this one exiting.
    Uses a sanitised environment so a PyInstaller onefile child always
    extracts its own temp folder.
    """
    kwargs = {'env': _child_env(), 'close_fds': True}
    if cwd:
        kwargs['cwd'] = cwd
    if os.name == 'nt':
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — parent ke marne par
        # child bhi na mare, aur Ctrl+C signals share na hon.
        kwargs['creationflags'] = 0x00000008 | 0x00000200
    return subprocess.Popen(args, **kwargs)

def _powershell_input(prompt, title="QR Se Print"):
    """
    Ask for one line of text WITHOUT tkinter.

    Some .exe builds ship without the Tcl/Tk runtime, so any tkinter window
    dies with "Tcl data directory ... not found". PowerShell's InputBox is
    part of Windows itself and always works.
    """
    try:
        ps = (
            "Add-Type -AssemblyName Microsoft.VisualBasic;"
            "[Microsoft.VisualBasic.Interaction]::InputBox("
            f"'{prompt}','{title}','')"
        )
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=300,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return (out.stdout or "").strip()
    except Exception as e:
        log(f"⚠️  PowerShell input failed: {e}", "WARN")
        return ""


def _shop_id_without_tkinter():
    """Fallback first-run setup when tkinter is unusable."""
    for _ in range(3):
        value = _powershell_input(
            "Paste your Shop ID (you got it after registering on the dashboard)"
        ).strip().upper()
        if not value:
            break
        try:
            # CLAIM — ek Shop ID sirf EK PC par chal sakti hai.
            # Pehle sirf /api/shop/<id> se check hota tha, jo public hai aur
            # PC ka koi hisaab nahi rakhta — isliye koi bhi QR poster se
            # Shop ID padh kar apne PC me daal deta aur "verified" ho jaata.
            r = requests.post(
                f"{SERVER_URL}/api/agent/claim/{value}",
                headers=auth_headers(), timeout=30,
                json={"machine": _machine_name()})

            if r.status_code == 404:
                # Do tarah ke 404 hote hain:
                #   a) HAMARA JSON  -> Shop ID sach me galat hai
                #   b) Express ka HTML -> server purana hai, endpoint hai hi nahi
                # Dono ko ek jaisa maan lena galat tha — purane server par
                # sahi Shop ID par bhi "not found" dikh jaata tha.
                is_our_404 = False
                try:
                    is_our_404 = bool(r.json().get("error"))
                except Exception:
                    is_our_404 = False

                if is_our_404:
                    _msgbox("This Shop ID was not found on the server. Please check it.",
                            "QR Se Print", 0x10)
                    continue

                # Purana server — purane tarike se check karke aage badho
                log("Server par claim endpoint nahi hai (purana server) — basic check", "WARN")
                try:
                    r2 = requests.get(f"{SERVER_URL}/api/shop/{value}", timeout=20)
                    if r2.status_code == 404:
                        _msgbox("This Shop ID was not found on the server. Please check it.",
                                "QR Se Print", 0x10)
                        continue
                except Exception:
                    pass
                return value

            if r.status_code == 409:
                # Kisi doosre PC par pehle se juda hua hai
                try:
                    msg = r.json().get("error", "")
                except Exception:
                    msg = ""
                _msgbox(msg or
                        "This Shop ID is already in use on another computer.\n\n"
                        "Shop Login → Settings → \"Disconnect Computer\" se purana PC "
                        "hata kar dobara try karein.",
                        "QR Se Print", 0x10)
                continue

            if r.status_code == 400:
                # Purana agent / token missing — batao par rukо mat
                log("Claim rejected (old agent build?)", "WARN")

        except Exception as e:
            # Server so raha hai ya net nahi hai — ID accept kar lo, warna
            # user phansa reh jayega. Job polling waise bhi token check
            # karti hai, isliye chori phir bhi nahi ho sakti.
            log(f"Shop ID claim check skipped: {e}", "WARN")
        return value
    try:
        return input("Enter your Shop ID: ").strip().upper()
    except Exception:
        log("❌ Could not read Shop ID — no window and no console available", "ERROR")
        return None


def show_shop_id_prompt():
    """
    .exe ka first-run setup: ek chhota Tkinter window kholo jisme
    customer apna Shop ID paste kar sake. Confirm hone par config
    file mein save ho jaata hai, future runs mein yeh popup nahi aayega.

    Agar Tkinter kisi reason se available na ho (rare), console input
    fallback use karte hain (sirf agar console attached hai, warna fail).
    """
    # NOTE: catching Exception, not just ImportError. When the .exe is built
    # without the Tcl runtime, "import tkinter" SUCCEEDS and the failure only
    # appears later as TclError. ImportError alone would miss that and crash.
    try:
        import tkinter as tk
        from tkinter import messagebox
        _probe = tk.Tk()          # prove Tcl really works before relying on it
        _probe.destroy()
    except Exception as e:
        log(f"⚠️  Tkinter unusable ({e}) — using the PowerShell prompt instead", "WARN")
        return _shop_id_without_tkinter()

    result = {"shop_id": None}

    def on_submit():
        value = entry.get().strip().upper()
        if not value:
            messagebox.showerror("Error", "Shop ID daalo!")
            return
        # Server se verify karo — typo waala Shop ID save ho gaya to agent
        # hamesha nonexistent shop poll karta rahega, "waiting" dikhata
        # rahega, aur kabhi print nahi karega — debug karna nightmare.
        # timeout 30s: Render free tier sleep se 30-60s mein jaagta hai.
        status_lbl.config(text="⏳ Verifying Shop ID...")
        root.update()
        try:
            r = requests.get(f"{SERVER_URL}/api/shop/{value}", timeout=30)
            if r.status_code == 404:
                status_lbl.config(text="❌ This Shop ID was not found on the server — please check it")
                return
            # 200/403/500 sab pe aage badho — shop exist karta hai ya
            # server issue hai, dono case mein ID save karna theek hai
        except requests.exceptions.Timeout:
            status_lbl.config(text="⏳ Server is waking up — try again in 30 seconds")
            return
        except Exception:
            # Offline/net issue — verify skip, save kar do (fail-open)
            pass
        result["shop_id"] = value
        root.destroy()

    root = tk.Tk()
    root.title("QR Se Print - Setup")
    root.geometry("420x290")
    root.resizable(False, False)
    try:
        root.attributes('-topmost', True)
    except Exception:
        pass

    tk.Label(root, text="QR Se Print Setup", font=("Segoe UI", 16, "bold"), pady=10).pack()
    tk.Label(root, text="Paste your Shop ID\n(you received it after registering on the dashboard)",
             font=("Segoe UI", 10), pady=5).pack()

    entry = tk.Entry(root, font=("Segoe UI", 12), justify="center", width=29)
    entry.pack(pady=10)
    entry.focus()

    tk.Button(root, text="Start", font=("Segoe UI", 11, "bold"),
              bg="#ff4d1c", fg="white", padx=20, pady=8, command=on_submit).pack(pady=6)

    status_lbl = tk.Label(root, text="", font=("Segoe UI", 9), fg="#b45309")
    status_lbl.pack(pady=(0, 8))

    root.bind('<Return>', lambda e: on_submit())
    root.mainloop()

    return result["shop_id"]

def resolve_shop_id():
    """
    Shop ID kahan se aaye, priority order:
    1. SHOP_ID_TEMPLATE agar already replace hui hai (.py source download wala flow)
    2. Saved config file (%APPDATA%/QRSePrint/shop_config.txt) — pehle se setup ho chuka hai
    3. GUI popup se naya Shop ID poocho (sirf pehli baar, .exe mode mein)
    """
    if SHOP_ID_TEMPLATE != UNCONFIGURED_MARKER:
        # .py source mode — Shop ID already baked hai is file mein
        return SHOP_ID_TEMPLATE

    if os.path.exists(SHOP_CONFIG_FILE):
        try:
            with open(SHOP_CONFIG_FILE, 'r', encoding='utf-8') as f:
                saved_id = f.read().strip()
                if saved_id:
                    return saved_id
        except Exception:
            pass

    # Pehli baar chal raha hai aur Shop ID kahin nahi mila — GUI se poocho
    shop_id = show_shop_id_prompt()
    if not shop_id:
        # User ne window band kar di bina Shop ID daale — agent chal nahi sakta
        sys.exit(1)

    try:
        with open(SHOP_CONFIG_FILE, 'w', encoding='utf-8') as f:
            f.write(shop_id)
    except Exception:
        pass

    return shop_id

# ─── SINGLE INSTANCE LOCK (crash-safe, PID based) ─────────────────────
# Purana Windows Mutex crash/sleep/force-kill pe orphan reh jaata tha —
# phir naya agent "already exists" samajh ke chupchaap exit ho jaata,
# tray me kuch nahi aata. Ab PID lockfile use karte hain: agar lock file
# me likha process ZINDA hai tabhi exit karo; warna (crash ho chuka hai)
# lock ko apne naam kar lo. Isse double-print bhi rukta hai aur silent
# exit wala bug bhi khatam.
_LOCK_FILE = os.path.join(_APPDATA_DIR, "agent.lock")

def _pid_alive(pid):
    """Is the process with this PID still running?"""
    try:
        import ctypes
        PROCESS_QUERY = 0x1000
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY, False, pid)
        if not h:
            return False
        exit_code = ctypes.c_ulong(0)
        ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(exit_code))
        ctypes.windll.kernel32.CloseHandle(h)
        return exit_code.value == 259  # STILL_ACTIVE
    except Exception:
        return False

_MUTEX_HANDLE = None          # process khatam hone tak zinda rakhna zaroori hai
_MUTEX_NAME = "Local\\QRSePrintAgent_SingleInstance"


def _single_instance_by_pidfile():
    """Fallback (non-Windows / mutex fail). Race-prone, isliye sirf backup."""
    try:
        if os.path.exists(_LOCK_FILE):
            try:
                with open(_LOCK_FILE, "r", encoding="utf-8") as f:
                    old_pid = int(f.read().strip() or "0")
            except Exception:
                old_pid = 0
            if old_pid and old_pid != os.getpid() and _pid_alive(old_pid):
                return False
        with open(_LOCK_FILE, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
        return True
    except Exception as e:
        log(f"⚠️  Lock check failed (fail-open): {e}", "WARN")
        return True


def _ensure_single_instance():
    """
    Only ONE agent may run at a time.

    The old check read a .lock file that held the previous PID. That has a
    race: at login the agent is launched twice within the same moment (once
    from the registry Run key, once from the Startup folder). Both copies
    read the file before either had written to it, both saw "nobody running",
    and both kept going — which is why several tray icons piled up.

    A Windows named mutex is created by the kernel atomically, so exactly one
    process can ever win, no matter how close together they start. It is also
    released automatically if the agent crashes, so no stale lock is left
    behind.
    """
    global _MUTEX_HANDLE
    if os.name != "nt":
        return _single_instance_by_pidfile()
    try:
        import ctypes
        from ctypes import wintypes
        ERROR_ALREADY_EXISTS = 183
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        handle = kernel32.CreateMutexW(None, False, _MUTEX_NAME)
        last_error = kernel32.GetLastError()
        if not handle:
            log("⚠️  Could not create the single-instance mutex — using the lock file", "WARN")
            return _single_instance_by_pidfile()
        if last_error == ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(handle)
            return False
        _MUTEX_HANDLE = handle          # keep it open for the whole process
        try:
            with open(_LOCK_FILE, "w", encoding="utf-8") as f:
                f.write(str(os.getpid()))     # only for support/debugging
        except Exception:
            pass
        return True
    except Exception as e:
        log(f"⚠️  Mutex check failed ({e}) — using the lock file", "WARN")
        return _single_instance_by_pidfile()


def _release_mutex():
    global _MUTEX_HANDLE
    try:
        if _MUTEX_HANDLE:
            import ctypes
            ctypes.windll.kernel32.ReleaseMutex(_MUTEX_HANDLE)
            ctypes.windll.kernel32.CloseHandle(_MUTEX_HANDLE)
            _MUTEX_HANDLE = None
    except Exception:
        pass
    try:
        if os.path.exists(_LOCK_FILE):
            with open(_LOCK_FILE, "r", encoding="utf-8") as f:
                if f.read().strip() == str(os.getpid()):
                    os.remove(_LOCK_FILE)
    except Exception:
        pass

if not _ensure_single_instance():
    # ── PEHLE YAHAN SIRF sys.exit(0) THA ──
    # Owner exe par double-click karta, kuch nahi hota, aur log me bas ek
    # line aati thi jo wo dekhta hi nahi. Usse lagta tha "software chalta
    # hi nahi hai" — jabki agent pehle se background me chal raha hota tha.
    #
    # Ab do kaam karte hain:
    #   1. Chalu agent ke liye ek request file chhod dete hain -- wo apna
    #      panel khol lega (yahi owner double-click se chahta hai).
    #   2. Owner ko saaf batate hain ki hua kya.
    log("⛔ Agent is already running — asking the running copy to show its panel")
    try:
        with open(PANEL_REQUEST_FILE, "w", encoding="utf-8") as _f:
            _f.write(str(int(time.time())))
    except Exception as _e:
        log(f"Panel request file nahi bani: {_e}", "WARN")

    # Chalu agent ko file dekhne ka mauka do, phir hi message dikhao —
    # warna panel khulne se pehle hi popup aa jaata hai.
    time.sleep(2.5)
    try:
        import ctypes as _ct
        _still_pending = os.path.exists(PANEL_REQUEST_FILE)
        if _still_pending:
            _txt = ("QR Se Print pehle se chal raha hai.\n\n"
                    "Panel kholne ke liye niche dayein taraf tray me (^ wale "
                    "chhote arrow par click karke) QR Se Print ke icon par "
                    "DOUBLE-CLICK karo.\n\n"
                    "Aapki printing background me chalti rahi hai — kuch ruka nahi hai.")
        else:
            _txt = ("QR Se Print pehle se chal raha hai — uska panel khol diya gaya hai.\n\n"
                    "Agla baar tray icon (niche dayein ^ ke andar) par double-click "
                    "karke seedha panel khol sakte ho.")
        _ct.windll.user32.MessageBoxW(0, _txt, "QR Se Print", 0x40 | 0x00010000 | 0x00040000)
    except Exception:
        pass
    sys.exit(0)

SHOP_ID = resolve_shop_id()

# ─── AUTO STARTUP (PC restart pe tray mein khud start ho) ─────────────
STARTUP_VBS_NAME = "QRSePrintAgent.vbs"


def _startup_command():
    """The exact command Windows must run at login (current paths, quoted)."""
    if is_running_as_exe():
        return f'"{sys.executable}"'
    py = sys.executable.replace('python.exe', 'pythonw.exe')
    if not os.path.exists(py):
        py = sys.executable
    return f'"{py}" "{os.path.abspath(__file__)}"'


def _startup_folder():
    """%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"""
    appdata = os.environ.get('APPDATA', '')
    if not appdata:
        return ""
    return os.path.join(appdata, "Microsoft", "Windows",
                        "Start Menu", "Programs", "Startup")


def _register_run_key(cmd):
    """Layer 1 — HKCU Run key. Written and then READ BACK to confirm."""
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0, winreg.KEY_SET_VALUE | winreg.KEY_QUERY_VALUE)
        winreg.SetValueEx(key, "QRSePrintAgent", 0, winreg.REG_SZ, cmd)
        saved, _ = winreg.QueryValueEx(key, "QRSePrintAgent")
        winreg.CloseKey(key)
        return saved == cmd
    except Exception as e:
        log(f"⚠️  Startup registry entry failed: {e}", "WARN")
        return False


def _register_startup_folder(cmd):
    """
    Layer 2 — a .vbs in the Startup folder.

    Why a second method: the Run key alone is not reliable. Antivirus and
    "PC cleaner" tools delete it, some office PCs block it by policy, and
    after an update the old entry can point at a path that no longer exists.
    The Startup folder keeps working in all of those cases. VBS is used
    instead of BAT so no black console window flashes at login.
    """
    folder = _startup_folder()
    if not folder:
        return False
    try:
        os.makedirs(folder, exist_ok=True)
        vbs_path = os.path.join(folder, STARTUP_VBS_NAME)
        # In VBS a quote inside a string is written as two quotes
        vbs_cmd = cmd.replace('"', '""')
        content = (
            'Set WshShell = CreateObject("WScript.Shell")\r\n'
            'WshShell.Run "' + vbs_cmd + '", 0, False\r\n'
        )
        # newline="" is important: without it Windows turns each \r\n into
        # \r\r\n and the .vbs can fail to run.
        with open(vbs_path, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return os.path.exists(vbs_path) and os.path.getsize(vbs_path) > 0
    except Exception as e:
        log(f"⚠️  Startup folder entry failed: {e}", "WARN")
        return False


def add_to_startup():
    """
    Make sure the agent starts by itself after a Windows restart.

    Shop owners reported the agent not starting after a restart. Reasons found:
    the registry entry gets removed by antivirus/cleaner tools, and after an
    update it can still point to the old file path. So now:

      * both methods are used (registry + Startup folder), either one is enough
      * both are rewritten on EVERY launch with the CURRENT path, so an entry
        left over from an older version repairs itself automatically
      * the registry value is read back to confirm it was really saved
    """
    if os.name != "nt":
        return
    cmd = _startup_command()
    ok_reg = _register_run_key(cmd)
    ok_folder = _register_startup_folder(cmd)

    if ok_reg and ok_folder:
        log("✅ Auto-start is set (registry + Startup folder) — the agent will "
            "start by itself after a restart")
    elif ok_reg or ok_folder:
        which = "registry" if ok_reg else "Startup folder"
        log(f"✅ Auto-start is set via {which} — the agent will start by itself "
            f"after a restart")
    else:
        log("❌ Auto-start could NOT be set. The agent will not start on its own "
            "after a restart — please start it manually, or contact support.",
            "ERROR")

def show_banner():
    # CRITICAL FIX: yahan bare print() tha — try ke bahar. --noconsole exe
    # mein sys.stdout None hota hai, print() AttributeError deta, aur yeh
    # main() ki PEHLI line hai — matlab exe har launch pe turant FATAL
    # CRASH ho jaata tha (log mein "'NoneType' object has no attribute
    # 'write'" dikhta hai). log() already guarded hai, isliye usi se bhejo.
    log(f"QR Se Print - Local Agent v{VERSION_LABEL} | Tray + Auto-Update + Fit-A4")
    # Bundle me kya hai kya nahi - guess mat karo, log me likho.
    try:
        bundle_selfcheck()
    except Exception as _bse:
        log(f"Bundle self-check fail: {_bse}", "WARN")

def check_printer():
    """
    NOTE: Agent hamesha Windows ke "Default Printer" ko use karta hai —
    yeh wahi printer hai jo dashboard mein "🔍 Auto Detect" option ka matlab hai.
    Agar shop owner ne dashboard mein specific model bhi select kiya ho (jaise
    "Canon PIXMA G2010"), woh sirf record/display ke liye hai — actual printing
    isi system default printer se hoti hai. Isliye PC mein sahi printer ko
    "Set as Default Printer" karna zaroori hai (Windows Settings > Printers).
    """
    try:
        import win32print
        printers = win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        )
        if printers:
            default = win32print.GetDefaultPrinter()
            log(f"✅ System Default Printer (Auto Detected): {default}")
            return True, default
        log("❌ No printer found!", "ERROR")
        return False, None
    except ImportError:
        log("⚠️  Mock mode (win32print not available)", "WARN")
        return True, "MockPrinter"
    except Exception as e:
        log(f"❌ Printer error: {e}", "ERROR")
        return False, None

def list_all_printers():
    """List of all printers installed on this system — for the dashboard dropdown"""
    try:
        import win32print
        printers = win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        )
        return [p[2] for p in printers]  # index 2 = printer name
    except ImportError:
        return []
    except Exception as e:
        log(f"⚠️  Printer list error: {e}", "WARN")
        return []

def report_printers_to_server():
    """Send the printer list to the server so it appears in the dashboard dropdown"""
    try:
        printers = list_all_printers()
        if not printers:
            return
        requests.post(
            f"{SERVER_URL}/api/agent/printers/{SHOP_ID}",
            json={"printers": printers},
            headers=auth_headers(),
            timeout=15
        )
        log(f"📋 Printer list sent to server: {printers}")
    except Exception as e:
        log(f"⚠️  Printer list report fail: {e}", "WARN")

# ═══════════════════════════════════════════════
# IDEMPOTENCY — ek job kabhi do baar print na ho
# ═══════════════════════════════════════════════
# Server 'printing' claim karke duplicate rokta hai, par agent ke restart /
# stuck-job requeue ke baad wahi job dobara aa sakta hai. Ye local record
# usko bhi rok deta hai. Disk par isliye taaki restart ke baad bhi yaad rahe.
_PROCESSED_PATH = os.path.join(_APPDATA_DIR, "processed_jobs.json")
_processed_jobs = {}

def _load_processed():
    global _processed_jobs
    try:
        with open(_PROCESSED_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        cutoff = time.time() - 7 * 24 * 3600          # 7 din se purane bhool jao
        _processed_jobs = {k: v for k, v in data.items() if isinstance(v, (int, float)) and v > cutoff}
    except Exception:
        _processed_jobs = {}

def _save_processed():
    # Atomic write — beech me power chali jaye to file corrupt na ho
    try:
        tmp = _PROCESSED_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_processed_jobs, f)
        os.replace(tmp, _PROCESSED_PATH)
    except Exception as e:
        log(f"Could not save processed-job list: {e}", "WARN")

_inflight_jobs = set()          # abhi is waqt print ho rahe job IDs

def already_processed(job_id):
    return job_id in _processed_jobs

def mark_processed(job_id):
    _processed_jobs[job_id] = time.time()
    if len(_processed_jobs) > 500:                    # sabse purane hata do
        for k in sorted(_processed_jobs, key=_processed_jobs.get)[:200]:
            _processed_jobs.pop(k, None)
    _save_processed()

def get_download_url(job_id, fallback_url):
    """
    Server se is job ka authorized download URL maango.
    Server sirf URL deta hai — PDF uske through NAHI jaati; agent Cloudinary
    se seedha download karta hai.
    Purana server ye endpoint nahi jaanta, to job me aaya file_url use karo.
    """
    try:
        resp = requests.get(
            f"{SERVER_URL}/api/jobs/{SHOP_ID}/{job_id}/download-url",
            headers=auth_headers(), timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("downloadUrl"):
                return data["downloadUrl"], None
        elif resp.status_code in (403, 409, 410):
            # Job ab printable nahi (dusri shop ka / paid nahi / file delete)
            try:
                msg = resp.json().get("error", "not available")
            except Exception:
                msg = "not available"
            return None, msg
        elif resp.status_code == 404:
            log("Server does not support authorized download yet — using job URL", "WARN")
    except Exception as e:
        log(f"Download-url lookup failed ({e}) — using job URL", "WARN")
    return fallback_url, None

def report_download(job_id, ok, bytes_count=None, err=None):
    """Sirf status message — koi file wapas server ko nahi jaati."""
    try:
        requests.post(
            f"{SERVER_URL}/api/jobs/{SHOP_ID}/{job_id}/downloaded",
            headers=auth_headers(), timeout=10,
            json={"ok": bool(ok), "bytes": bytes_count, "error": (str(err)[:180] if err else "")})
    except Exception:
        pass          # best-effort, print kabhi na ruke

def download_file(url, ext):
    """Download the file from Cloudinary"""
    try:
        log(f"⬇️  Downloading...")
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        if len(resp.content) < 100:
            log(f"❌ Downloaded file is too small: {len(resp.content)} bytes", "ERROR")
            return None
        suffix = f".{ext}" if ext else ".pdf"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(resp.content)
        tmp.close()
        log(f"✅ Downloaded: {tmp.name} ({len(resp.content):,} bytes)")
        return tmp.name
    except Exception as e:
        log(f"❌ Download failed: {e}", "ERROR")
        return None

# ─── Problem 1: Image to PDF convert — A4 page banake usme image fit karo ─────
def convert_image_to_pdf(image_path):
    """
    JPG/PNG ko A4-size PDF page mein convert karo.

    Do scenarios handle karte hain:
    1. Image already A4 ratio mein hai (Canvas Editor se aaya — customer ne
       khud A4 page pe drag/resize/position set kiya tha) — is case mein
       hum SEEDHA wahi image PDF mein wrap karte hain, DOBARA zoom-fit nahi
       karte, warna customer ki careful positioning distort ho jayegi.
    2. Normal photo/scan hai (chhota ya alag ratio) — A4 page ke center
       mein zoom karke fit karte hain jaisa pehle se ho raha tha.
    """
    try:
        from PIL import Image
        log(f"🔄 Converting image to A4 PDF...")

        img = Image.open(image_path)

        # RGB mein convert karo (PNG mein RGBA ho sakta hai)
        if img.mode in ('RGBA', 'LA', 'P'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        # A4 ka size 300 DPI pe (print quality ke liye)
        dpi = 300
        a4_width_px = int(8.27 * dpi)   # 210mm
        a4_height_px = int(11.69 * dpi)  # 297mm
        a4_ratio = a4_width_px / a4_height_px

        img_ratio = img.width / img.height
        ratio_diff = abs(img_ratio - a4_ratio)

        # Agar image ka ratio A4 se bahut close hai (Canvas Editor se aaya hai),
        # to seedha resize karke wrap karo — koi extra zoom/margin nahi
        if ratio_diff < 0.01:
            log("ℹ️  Image is already A4 ratio (Canvas Editor output) — using it as is")
            a4_canvas = img.resize((a4_width_px, a4_height_px), Image.LANCZOS)
        else:
            # Create a full white A4 canvas
            a4_canvas = Image.new('RGB', (a4_width_px, a4_height_px), (255, 255, 255))

            # Image ko A4 canvas ke andar MAXIMUM size mein fit karo (zoom karke)
            # taaki chhota image bhi bada print ho, chhota corner mein na rahe
            # 95% margin rakhte hain thoda safe area ke liye
            target_w = int(a4_width_px * 0.95)
            target_h = int(a4_height_px * 0.95)

            if img_ratio > (target_w / target_h):
                new_width = target_w
                new_height = int(target_w / img_ratio)
            else:
                new_height = target_h
                new_width = int(target_h * img_ratio)

            # High quality upscale/downscale
            resample_method = Image.LANCZOS
            img_resized = img.resize((new_width, new_height), resample_method)

            # Center mein paste karo
            paste_x = (a4_width_px - new_width) // 2
            paste_y = (a4_height_px - new_height) // 2
            a4_canvas.paste(img_resized, (paste_x, paste_y))

        # PDF save karo with correct DPI metadata
        pdf_path = image_path + '_converted.pdf'
        a4_canvas.save(pdf_path, 'PDF', resolution=dpi)
        log(f"✅ A4 PDF ready: {pdf_path}")
        return pdf_path

    except ImportError:
        log("❌ Pillow is not installed! Run: pip install Pillow", "ERROR")
        return None
    except Exception as e:
        log(f"❌ Image convert error: {e}", "ERROR")
        return None

# ─── Page Range: Specific pages extract karo PDF se ────────
def extract_selected_pages(pdf_path, selected_pages_str, total_pages=None):
    """
    Agar customer ne specific pages select kiye hain (jaise "5" ya "1,3,5-8")
    to PyPDF2 se sirf wahi pages ka naya PDF banao.
    Agar selected_pages_str empty hai to original PDF wapas bhejo (sab pages print karo).

    IMPORTANT: Agar yeh function kisi bhi reason se fail ho jaye,
    hum None return karte hain (original PDF nahi) — taaki kabhi
    accidentally poora document print na ho jab customer ne sirf
    kuch pages select kiye the. Yeh galat-billing print se zyada
    safe hai.
    """
    if not selected_pages_str or not selected_pages_str.strip():
        return pdf_path  # All pages selected — kuch extract nahi karna

    # pypdf/PyPDF2 import — pypdf (actively maintained fork) ko priority
    # dete hain kyunki ye real-world "ajeeb" PDFs (scanner apps, govt
    # portals, non-UTF8 metadata) ko zyada gracefully handle karta hai.
    # PyPDF2 3.x abhi bhi kaam karta hai isliye fallback rakha hai.
    PdfReader = None
    PdfWriter = None
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        try:
            from PyPDF2 import PdfReader, PdfWriter
        except ImportError:
            log("⚠️  pypdf/PyPDF2 not found! Installing...", "WARN")
            os.system("pip install pypdf pycryptodome --quiet")
            try:
                from pypdf import PdfReader, PdfWriter
            except Exception as e:
                log(f"❌ pypdf installation also failed: {e}", "ERROR")
                return None

    # PyCryptodome missing hone se aane wala specific error pre-emptively fix karo
    try:
        import Crypto  # noqa
    except ImportError:
        log("⚠️  PyCryptodome not found — installing (required for encrypted PDFs)", "WARN")
        os.system("pip install pycryptodome --quiet")

    try:
        page_numbers = [int(p.strip()) for p in selected_pages_str.split(',') if p.strip()]
        if not page_numbers:
            log("⚠️  Page list is empty — the original PDF will be printed", "WARN")
            return pdf_path

        # ── KOI FAST-PATH NAHI ── hamesha extract karo.
        #
        # Pehle yahan do shortcut the aur DONO galat the:
        #   1) "page_numbers == [1]"  -> 2-page PDF me page 1 chunne par bhi
        #      poora document print ho jata tha.
        #   2) "len(page_numbers) >= total_pages" -> ye bhi kaam nahi karta,
        #      kyunki total_pages BILLING ka count hai (kitne page ka paisa
        #      liya), PDF ka asli page count NAHI. Page 1 chuno to
        #      total_pages=1 aata hai, isliye check hamesha TRUE ho jata tha.
        #
        # Ab pycryptodome .exe me sahi bundle hai (v20+), isliye PDF kholna
        # safe hai. Saare page chune ho tab bhi extract karna nuksan nahi —
        # wahi PDF wapas banta hai, bas thoda CPU lagta hai.

        log(f"📑 Extracting specific pages: {page_numbers}")

        try:
            reader = PdfReader(pdf_path, strict=False)
        except Exception as e1:
            # Kuch "ajeeb" PDFs (galat-encoded metadata waale) pypdf ke
            # strict-mode se crash ho jaate hain — dusri library se retry.
            log(f"⚠️  PDF read attempt 1 failed ({e1}) — retrying with another library", "WARN")
            try:
                from PyPDF2 import PdfReader as _AltReader
                reader = _AltReader(pdf_path, strict=False)
            except Exception:
                try:
                    from pypdf import PdfReader as _AltReader2
                    reader = _AltReader2(pdf_path, strict=False)
                except Exception:
                    raise e1

        # Encrypted na ho to crypto touch hi na ho — try/except safety
        try:
            if getattr(reader, 'is_encrypted', False):
                reader.decrypt('')
        except Exception:
            pass
        writer = PdfWriter()
        total_pdf_pages = len(reader.pages)

        added_count = 0
        for pnum in page_numbers:
            idx = pnum - 1  # 1-indexed se 0-indexed
            if 0 <= idx < total_pdf_pages:
                writer.add_page(reader.pages[idx])
                added_count += 1
            else:
                log(f"⚠️  Page {pnum} is not in the PDF (the PDF has {total_pdf_pages} pages)", "WARN")

        if added_count == 0:
            log("❌ No valid page could be extracted! Stopping the print for safety", "ERROR")
            return None

        extracted_path = pdf_path + '_extracted.pdf'
        with open(extracted_path, 'wb') as f:
            writer.write(f)

        # Verify extracted file properly bani hai
        verify_size = os.path.getsize(extracted_path)
        if verify_size < 50:
            log(f"❌ Extracted PDF is empty or corrupt ({verify_size} bytes)!", "ERROR")
            return None

        log(f"✅ Extracted {added_count} page(s): {extracted_path} ({verify_size} bytes)")
        return extracted_path

    except Exception as e:
        # Crypto/native-module error = packaging issue, PDF ka dosh nahi.
        # Aise me poori file print karo (fail+requeue+DOUBLE print se behtar).
        emsg = str(e).lower()
        if 'crypto' in emsg or 'cpuid' in emsg or 'native module' in emsg:
            # Poora document print karna yahan GALAT hai — customer ne shayad
            # sirf 1 page ka paisa diya ho aur 10 page nikal jayein.
            # Print rokna hi sahi hai: shop bata dega, customer dobara bhej dega.
            log(f"❌ Crypto module missing ({e}) — cannot extract specific pages", "ERROR")
            log("⚠️  Print stopped so that extra pages are not printed.", "WARN")
            log("👉 Update the agent to v20 or newer — this is fixed there.", "WARN")
            return None
        log(f"❌ Page extract error: {e}", "ERROR")
        log(f"⚠️  SAFETY: Stopping the print so that wrong (extra) pages are not printed", "WARN")
        return None

def get_bundled_resource_path(filename):
    """
    Bundle kiye gaye file (jaise SumatraPDF.exe) ka path dhoondho.
    Teen tarah ke build support karta hai:
      1. PyInstaller --onefile : temp extraction folder -> sys._MEIPASS
      2. Nuitka --standalone / PyInstaller --onedir : exe ke saath wale folder me
      3. Normal .py script : script ke folder me
    Pehle sirf (1) tha, isliye Nuitka ka build SumatraPDF dhoondh hi nahi paata tha.
    """
    candidates = []

    # 1. PyInstaller onefile
    meipass = getattr(sys, '_MEIPASS', None)
    if meipass:
        candidates.append(os.path.join(meipass, filename))

    # 2. Compiled exe ke saath wala folder (Nuitka standalone / PyInstaller onedir)
    #    Nuitka __compiled__ set karta hai, PyInstaller sys.frozen
    if globals().get('__compiled__') is not None or getattr(sys, 'frozen', False):
        candidates.append(os.path.join(os.path.dirname(sys.executable), filename))

    # 3. Script mode
    try:
        candidates.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), filename))
    except NameError:
        pass

    for p in candidates:
        if p and os.path.exists(p):
            return p
    return None

# ─── Problem 5: B&W / Color Print + Fit-to-A4 ────────────────────────
def _sumatra_page_range(selected_pages):
    """
    "1,3,4,5" -> "1,3-5"  (SumatraPDF -print-settings ka format).

    Sirf tabhi use hota hai jab PDF library se page extract na ho paye.
    Galat/khali input par "" lautata hai, taaki galti se poora document
    print na ho jaye.
    """
    try:
        nums = sorted({int(x.strip()) for x in str(selected_pages).split(',') if x.strip()})
        nums = [x for x in nums if x >= 1]
        if not nums:
            return ""
        parts, start, prev = [], nums[0], nums[0]
        for cur in nums[1:] + [None]:
            if cur == prev + 1:
                prev = cur
                continue
            parts.append(str(start) if start == prev else f"{start}-{prev}")
            if cur is None:
                break
            start = prev = cur
        return ",".join(parts)
    except Exception:
        return ""


def print_pdf_sumatra(filepath, copies=1, color_mode="bw", printer_name=None, extra="", scale_mode="fit"):
    """
    SumatraPDF se print — B&W/Color setting ke saath
    'fit' flag use karte hain taaki chhota PDF/page bhi A4 paper
    ke hisaab se properly scale ho jaye, corner mein chhota na rahe.

    printer_name: agar diya gaya hai, usi SPECIFIC printer pe print hoga
    (system default ko IGNORE karke) — taaki B&W aur Color jobs alag-alag
    physical printers pe route ho sakein (jaise HP M1005 sirf B&W ke liye,
    Canon G2010 sirf Color ke liye). Agar None/empty hai, purana default-
    printer wala behavior chalega (backward compatible).
    """
    sumatra_paths = []

    # CRITICAL FIX: .exe build mein SumatraPDF.exe PyInstaller se BUNDLE
    # kiya gaya tha (--add-binary), lekin yahan kabhi check hi nahi ho raha
    # tha — sirf system-installed paths check ho rahe the. Isi wajah se
    # print agent ko bundled SumatraPDF kabhi mil hi nahi raha tha; agar
    # system pe pehle se SumatraPDF install tha (purane .py-based INSTALL.bat
    # se) to print chal jaata, warna (jaisa fresh installs ya restart ke
    # baad clean state mein) print fail ho jaata — "tray mein dikhता hai
    # lekin print nahi nikalta" exactly yehi symptom hai.
    bundled = get_bundled_resource_path('SumatraPDF.exe')
    if bundled:
        sumatra_paths.append(bundled)

    sumatra_paths += [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
        os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
    ]

    # "fit" — page ko printer paper size ke hisaab se scale karta hai
    # (chhota document A4 paper mein bada hoke print hoga, corner mein nahi rahega)
    # ⚠️ COPIES KA SAHI SYNTAX ⚠️
    # SumatraPDF me copies "Nx" se aate hain (jaise "3x" = 3 copies).
    # "copies=3" naam ka koi option Sumatra me HAI HI NAHI — wo use unknown
    # token samajh ke CHUPCHAP ignore kar deta tha. Isi wajah se customer
    # 2-3 copies chunta tha, paisa bhi 2-3 copy ka katta tha, par print
    # sirf 1 hi nikalta tha.
    # Docs: sumatrapdfreader.org/docs/Command-line-arguments -> -print-settings "3x"
    try:
        _n_copies = int(copies)
    except (TypeError, ValueError):
        _n_copies = 1
    _n_copies = max(1, min(50, _n_copies))     # server par bhi 50 ka cap hai
    copies_token = f"{_n_copies}x"

    if color_mode == "bw":
        print_settings = f"{copies_token},monochrome,{scale_mode}"
        log(f"🖨️  B&W (Monochrome) + {scale_mode} print karenge | {_n_copies} copy")
    else:
        # EXPLICIT 'color' flag — pehle kuch nahi bhejte the, to printer
        # driver ka DEFAULT chalta tha. Driver default Grayscale ho (Canon/HP
        # par common) to color job bhi B&W nikalta tha. Ab job ke hisaab se
        # force hota hai, driver default jo bhi ho.
        print_settings = f"{copies_token},color,{scale_mode}"
        log(f"🖨️  Color (explicit) + {scale_mode} print karenge | {_n_copies} copy")
    if extra:
        print_settings += f",{extra}"
        log(f"🖨️  Extra print settings: {extra}")

    use_specific_printer = bool(printer_name and printer_name.strip())
    if use_specific_printer:
        log(f"🎯 Specific printer route: '{printer_name}' (configured for {color_mode.upper()})")
    else:
        log(f"ℹ️  No specific printer set for {color_mode.upper()} — the system default printer will be used")

    log(f"SumatraPDF paths to try: {sumatra_paths}")
    for sumatra in sumatra_paths:
        try:
            path_exists = os.path.exists(sumatra)
        except Exception as pathErr:
            log(f"⚠️  Path check error for {sumatra}: {pathErr}", "WARN")
            continue
        if not path_exists:
            log(f"   ❌ Not found: {sumatra}")
            continue
        log(f"   ✅ Found: {sumatra}, trying print...")
        try:
            if use_specific_printer:
                # -print-to specific printer ko target karta hai, default
                # printer ko bypass karke — yahi is feature ki core hai
                cmd = [
                    sumatra,
                    "-print-to", printer_name,
                    "-silent",
                    "-print-settings", print_settings,
                    filepath
                ]
            else:
                cmd = [
                    sumatra,
                    "-print-to-default",
                    "-silent",
                    "-print-settings", print_settings,
                    filepath
                ]
            log(f"CMD: {' '.join(cmd)}")
            result = subprocess.run(cmd, timeout=120, capture_output=True)
            if result.returncode == 0:
                log(f"✅ SumatraPDF print success! ({color_mode.upper()}, fit-to-page, printer={printer_name or 'default'})")
                return True
            else:
                err = result.stderr.decode(errors='ignore') if result.stderr else ''
                log(f"⚠️  SumatraPDF error (return code {result.returncode}): {err}", "WARN")
                # Agar specific printer name galat/disconnected ho, default
                # printer pe fallback try karte hain (taaki print bilkul
                # ruk na jaaye — kam se kam kahin to nikal jaaye)
                if use_specific_printer:
                    log(f"⚠️  Printing on '{printer_name}' failed, trying the default printer...", "WARN")
                    try:
                        fallback_cmd = [sumatra, "-print-to-default", "-silent", "-print-settings", print_settings, filepath]
                        fb_result = subprocess.run(fallback_cmd, timeout=120, capture_output=True)
                        if fb_result.returncode == 0:
                            log(f"✅ Printed on the default printer (fallback)")
                            return True
                    except Exception:
                        pass
        except Exception as runErr:
            log(f"⚠️  SumatraPDF subprocess error: {runErr}", "WARN")

    # Fallback
    log("SumatraPDF kahin nahi mila (na bundle me, na is PC par) - Windows "
        "shell se try kar rahe hain. Is tarike me B&W / fit / specific-"
        "printer setting LAGU NAHI hoti.", "WARN")
    try:
        os.startfile(filepath, "print")
        time.sleep(5)
        log("✅ Printed via the Windows shell (fit/B&W settings and specific printer will not apply)")
        return True
    except Exception as e:
        log(f"❌ Print failed: {e}", "ERROR")
        return False

def print_word(filepath, copies=1, color_mode="bw", printer_name=None):
    """Word document print"""
    try:
        import win32com.client
        word = win32com.client.Dispatch("Word.Application")
        word.Visible = False
        if printer_name and printer_name.strip():
            try:
                word.ActivePrinter = printer_name
                log(f"🎯 Word ActivePrinter set: {printer_name}")
            except Exception as ape:
                log(f"⚠️  Could not set ActivePrinter, the default will be used: {ape}", "WARN")
        doc = word.Documents.Open(os.path.abspath(filepath))
        doc.PrintOut(Copies=copies)
        time.sleep(5)
        doc.Close(False)
        word.Quit()
        log("✅ Word document printed!")
        return True
    except:
        try:
            os.startfile(filepath, "print")
            time.sleep(3)
            return True
        except Exception as e:
            log(f"❌ Word print failed: {e}", "ERROR")
            return False

def print_file(filepath, copies=1, color_mode="bw", selected_pages="", printer_name=None, duplex_on=False, duplex_mode="", duplex_pages=1, paper_size="a4", total_pages=None):
    """Main print function — handles all file types"""
    ext = Path(filepath).suffix.lower()
    log(f"🖨️  Printing: {os.path.basename(filepath)}")
    log(f"   Copies: {copies} | Mode: {color_mode.upper()} | Type: {ext}")
    if selected_pages:
        log(f"   Selected Pages: {selected_pages}")

    converted_pdf = None
    extracted_pdf = None

    try:
        sumatra_page_extra = ""   # sirf extraction-fail wale fallback me bharta hai

        # Problem 1: Image files ko pehle A4-fit PDF mein convert karo
        if ext in ['.jpg', '.jpeg', '.png', '.bmp', '.gif']:
            log(f"🔄 Image file detected — converting to A4 PDF...")
            converted_pdf = convert_image_to_pdf(filepath)
            if not converted_pdf:
                log("❌ Image to PDF conversion failed!", "ERROR")
                return False
            print_path = converted_pdf
        elif ext == '.pdf':
            print_path = filepath
            # Page Range: agar specific pages selected hain to extract karo
            if selected_pages:
                extracted_pdf = extract_selected_pages(filepath, selected_pages, total_pages)
                if extracted_pdf is None:
                    # Extraction fail hua (aksar .exe me PyCryptodome ka native
                    # module missing hone se: "Cannot load native module
                    # Crypto.Util._cpuid_c"). Pehle yahan print ROK diya jaata
                    # tha — shop ka kaam ruk jaata tha.
                    # Ab SumatraPDF ko seedha page range de dete hain. Sumatra
                    # khud PDF ka page range print karta hai, koi Python PDF
                    # library nahi chahiye — aur extra page bhi nahi nikalta.
                    page_range = _sumatra_page_range(selected_pages)
                    if page_range:
                        log(f"⚠️  Page extraction failed — printing pages {page_range} "
                            f"directly through SumatraPDF instead", "WARN")
                        sumatra_page_extra = page_range
                        print_path = filepath
                    else:
                        log("❌ Page extraction failed and the page list is unusable — "
                            "stopping the print for safety", "ERROR")
                        return False
                else:
                    print_path = extracted_pdf
        elif ext in ['.doc', '.docx']:
            return print_word(filepath, copies, color_mode, printer_name)
        else:
            print_path = filepath

        # ── DUPLEX ──
        # ── PAPER TOKEN ── Sumatra jo sizes samajhta hai unke liye paper=
        # flag; baaki (4x6, A1) par flag skip — PDF khud sahi size ki hai,
        # driver default+fit sambhal lega. Galat/unknown token Sumatra
        # chupchaap ignore karta hai, par hum sirf known hi bhejte hain.
        _PAPER_TOKENS = {"a4": "A4", "a3": "A3", "a5": "A5", "a2": "A2",
                         "letter": "letter", "legal": "legal"}
        _ptok = _PAPER_TOKENS.get((paper_size or "a4").lower(), "")
        # Sab sizes par 'fit'. PDF ab KHUD sahi paper-size ki banti hai
        # (customer side), to 'fit' usko us kagaz par poora bhar deta hai
        # bina stretch (aspect match). Pehle 4x6 par 'noscale' tha jisse
        # chhoti image chhoti hi rehti thi (size/quality complaint).
        _scale = "fit"
        _paper_extra = f"paper={_ptok}" if _ptok else ""
        def _mix(dup_extra=""):
            # sumatra_page_extra sirf tab bharta hai jab PDF se page extract
            # nahi ho paya — tab Sumatra ko khud page range dena padta hai.
            return ",".join([t for t in (_paper_extra, dup_extra, sumatra_page_extra) if t])

        # duplex_on / duplex_mode / duplex_pages ab parameters hain —
        # v9 me yahan job.get() tha par is function me 'job' hota hi nahi
        # (NameError se HAR print fail ho raha tha)
        total_pgs = duplex_pages

        if duplex_on and duplex_mode == "auto":
            # Printer khud duplex karta hai — driver ko duplexlong flag
            log("📄 AUTO duplex — printer dono side khud chhapega")
            return print_pdf_sumatra(print_path, copies, color_mode, printer_name, extra=_mix("duplexlong"), scale_mode=_scale)

        if duplex_on and duplex_mode == "manual" and total_pgs > 1:
            # Do-pass manual duplex: pehle ODD pages (1,3,5...), phir owner
            # pages palat ke lagaye, phir EVEN pages (2,4,6...).
            # Server manual-duplex par copies=1 force karta hai.
            # NOTE: 3+ sheets par even-pass ka order printer ke output
            # stacking par depend karta hai (face-down laser = seedha sahi;
            # face-up par owner stack palat le). 1-2 page docs par hamesha sahi.
            log("📄 MANUAL duplex — pass 1: front (odd pages)")
            ok1 = print_pdf_sumatra(print_path, 1, color_mode, printer_name, extra=_mix("odd"), scale_mode=_scale)
            if not ok1:
                return False
            update_tray_status("📄 Waiting for the back side — flip the pages!")
            if ask_backside():
                log("📄 MANUAL duplex — pass 2: back (even pages)")
                return print_pdf_sumatra(print_path, 1, color_mode, printer_name, extra=_mix("even"), scale_mode=_scale)
            else:
                log("📄 Owner skipped the back side — only the front was printed")
                return True  # front print hua tha, job done

        if duplex_on and total_pgs <= 1:
            log("📄 Duplex was selected but there is only 1 page — printing normally")

        # PDF print karo with fit-to-page (image bhi ab already A4-fitted PDF hai)
        success = print_pdf_sumatra(print_path, copies, color_mode, printer_name, extra=_mix(), scale_mode=_scale)
        return success

    finally:
        if converted_pdf and os.path.exists(converted_pdf):
            try:
                time.sleep(2)
                os.unlink(converted_pdf)
                log(f"🗑️  Converted PDF deleted")
            except:
                pass
        if extracted_pdf and extracted_pdf != filepath and os.path.exists(extracted_pdf):
            try:
                time.sleep(2)
                os.unlink(extracted_pdf)
                log(f"🗑️  Extracted PDF deleted")
            except:
                pass

_http = None

def http():
    """
    Ek hi Session, jisme chhoti network dikkat par apne aap retry hota hai.
    Connection reuse hota hai, isliye idle ke baad wala pehla request
    fail hone ka chance bahut kam ho jaata hai.
    """
    global _http
    if _http is not None:
        return _http
    sess = requests.Session()
    try:
        from requests.adapters import HTTPAdapter
        try:
            from urllib3.util.retry import Retry
        except Exception:
            from requests.packages.urllib3.util.retry import Retry
        retry = Retry(
            total=2, connect=2, read=2, backoff_factor=0.6,
            status_forcelist=(502, 503, 504),
            allowed_methods=frozenset(["GET", "POST"])
        )
        ad = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=8)
        sess.mount("https://", ad)
        sess.mount("http://", ad)
    except Exception as e:
        log(f"HTTP retry setup skipped: {e}", "WARN")
    _http = sess
    return _http

def reset_http():
    """Reconnect par purana session poori tarah phenk do — naye socket banenge."""
    global _http
    try:
        if _http is not None:
            _http.close()
    except Exception:
        pass
    _http = None

class PollError(Exception):
    """Server tak poll pahunch hi nahi paya (socket/network/server)."""
    pass


_poll_last_logged = 0.0


def _log_poll_problem(msg):
    """
    Poll fail har baar log karein to 10 second me ek line — file
    bhar jaati hai aur asli baat dab jaati hai. Isliye: pehli fail
    turant, uske baad har 60s me ek baar.
    """
    global _poll_last_logged
    now = time.time()
    if now - _poll_last_logged >= 60:
        _poll_last_logged = now
        log(msg, "WARN")


def _reset_poll_log():
    """Connection wapas aane par counter reset — agli dikkat turant log ho."""
    global _poll_last_logged
    _poll_last_logged = 0.0


def get_pending_jobs():
    """
    Returns:
        list  -- server ne jawab diya (khaali list = sach me koi job nahi)
        None  -- poll FAIL hua

    Ye farak sabse zaroori hai. Pehle dono case me [] lautta tha,
    isliye print_loop() network failure ko "koi job nahi" samajh
    leta tha aur saari recovery band ho jaati thi.
    """
    global _demo_expired_shown
    try:
        url = f"{SERVER_URL}/api/jobs/pending/{SHOP_ID}"
        if MACHINE_ID:
            url += f"?m={MACHINE_ID}&v={VERSION}&vl={VERSION_LABEL}"
        else:
            url += f"?v={VERSION}&vl={VERSION_LABEL}"
        resp = http().get(url, headers=auth_headers(), timeout=20)
        if resp.status_code == 403:
            # Purana message "use 'Re-link agent'" kehta tha — dashboard me
            # us naam ka koi button hai hi nahi, isliye shop owner dhoondta
            # reh jaata tha. Asli jagah ye hai:
            #   Dashboard -> Settings -> "Connected Computer" ->
            #   "Disconnect Computer"
            # Uske baad agent khud dobara link ho jaata hai.
            log("❌ Server ne is PC ka agent token reject kar diya. "
                "Shop dashboard kholo -> Settings -> 'Connected Computer' -> "
                "'Disconnect Computer' dabao, phir ye agent band karke dobara "
                "chalao. Wo apne aap link ho jayega.", "ERROR")
            update_tray_status("Token reject — dashboard se 'Disconnect Computer' dabao")
            return []
        if resp.status_code != 200:
            # Server ne jawab to diya par galat status (502/503 =
            # Render abhi jag raha hai). Ise "koi job nahi" maan
            # lena galat hai — retry/backoff chalna chahiye.
            _log_poll_problem(f"Server ne {resp.status_code} bheja — dobara koshish karenge")
            return None
        d = resp.json()
        if d.get("demo_expired"):
            update_tray_status("⏰ Demo has ended — please register!")
            if not _demo_expired_shown:
                _demo_expired_shown = True
                log("⏰ Demo period has ended — register to get a new Shop ID")
                threading.Thread(target=_show_demo_expired_popup, daemon=True).start()
            return []
        return d.get("jobs", [])
    except Exception as e:
        # YAHI WO JAGAH THI jahan bug baitha tha: pehle yahan
        # `return []` tha, bina kisi log ke. Dead socket, timeout,
        # DNS fail — sab chup-chaap "koi job nahi" ban jaate the.
        _log_poll_problem(f"Server se baat nahi ho paayi: {type(e).__name__} — {e}")
        return None

_demo_expired_shown = False

def _show_demo_expired_popup():
    try:
        import ctypes
        r = ctypes.windll.user32.MessageBoxW(None,
            "Your 2-hour demo has ended!\n\n"
            "Liked it? Register to get your own permanent Shop ID:\n"
            f"{SERVER_URL}/register\n\n"
            "Pressing OK will open the registration page.",
            "QR Se Print — Demo Ended", 0x40 | 0x1)  # OK/Cancel + info icon
        if r == 1:  # OK
            os.startfile(f"{SERVER_URL}/register")
    except Exception:
        pass

# ══════════════════════════════════════════════════════════════════
# DEMO UPGRADE REMINDER
# Demo shop ID par agent chal raha ho to subah 9 baje se raat 8 baje
# tak 4 baar yaad dilata hai — Monthly ya Lifetime plan lo. Popup me
# dono plan ke button + Dismiss. Plan button dabate hi browser me
# nayi shop registration khul jati hai.
# Har slot ek hi baar dikhta hai (state file me likha jata hai), isliye
# agent restart hone par bhi dobara spam nahi hota.
# ══════════════════════════════════════════════════════════════════
DEMO_REMINDER_FILE = os.path.join(_APPDATA_DIR, "demo_reminder.txt")
DEMO_SLOTS = [(9, 0), (12, 40), (16, 20), (20, 0)]   # 4 baar, 9AM–8PM
DEMO_CHECK_INTERVAL = 300                             # har 5 min slot check


def _demo_status():
    """Server se poochho: ye shop demo hai ya nahi. Naya halka endpoint
    use karte hain; purana server ho to /api/shop/<id> par fallback."""
    try:
        r = requests.get(f"{SERVER_URL}/api/shop/{SHOP_ID}/demo-status", timeout=12)
        if r.status_code == 200:
            d = r.json()
            return bool(d.get("demo")), bool(d.get("expired"))
    except Exception:
        pass
    try:
        r = requests.get(f"{SERVER_URL}/api/shop/{SHOP_ID}", timeout=12)
        if r.status_code == 200:
            return bool(r.json().get("demo")), False
    except Exception:
        pass
    return False, False


def _demo_slot_index(now=None):
    """Which slot is active right now (0-3), or None if outside the window."""
    n = now or datetime.now()
    cur = None
    for i, (h, m) in enumerate(DEMO_SLOTS):
        if (n.hour, n.minute) >= (h, m):
            cur = i
    # 8 baje ke baad wala slot agle din tak valid, par raat 11 ke baad nahi
    if cur is not None and n.hour >= 22:
        return None
    return cur


def _demo_reminder_done(tag):
    try:
        if os.path.exists(DEMO_REMINDER_FILE):
            with open(DEMO_REMINDER_FILE, "r", encoding="utf-8") as f:
                return f.read().strip() == tag
    except Exception:
        pass
    return False


def _demo_reminder_mark(tag):
    try:
        with open(DEMO_REMINDER_FILE, "w", encoding="utf-8") as f:
            f.write(tag)
    except Exception:
        pass


def _open_register(plan):
    url = f"{SERVER_URL}/register?plan={plan}&from=agent"
    try:
        os.startfile(url)
    except Exception:
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass


def _show_demo_upgrade_popup():
    """Two plan buttons + Dismiss. Falls back to MessageBox if tkinter fails."""
    try:
        import tkinter as tk
        root = tk.Tk()
        root.title("QR Se Print — Demo")
        root.attributes("-topmost", True)
        root.resizable(False, False)
        w, h = 430, 330
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        root.geometry(f"{w}x{h}+{sw - w - 20}+{sh - h - 70}")
        root.configure(bg="white")

        head = tk.Frame(root, bg="#ff3b6b", height=76)
        head.pack(fill="x")
        head.pack_propagate(False)
        tk.Label(head, text="\u23f3  Demo Is Running", bg="#ff3b6b", fg="white",
                 font=("Segoe UI", 14, "bold")).pack(pady=(14, 0))
        tk.Label(head, text="Choose a plan — otherwise printing will stop",
                 bg="#ff3b6b", fg="white", font=("Segoe UI", 9)).pack()

        tk.Label(root, text="Your shop is currently running on a demo Shop ID.\n"
                            "Choose one plan to continue:",
                 bg="white", fg="#2b2b31", font=("Segoe UI", 10), justify="center").pack(pady=(16, 12))

        btns = tk.Frame(root, bg="white")
        btns.pack(pady=(0, 6))

        def pick(plan):
            _open_register(plan)
            try:
                root.destroy()
            except Exception:
                pass

        tk.Button(btns, text="\U0001F4C5  Monthly Plan", width=17, height=2,
                  bg="#ffffff", fg="#2b2b31", font=("Segoe UI", 10, "bold"),
                  relief="solid", bd=1, cursor="hand2",
                  command=lambda: pick("monthly")).grid(row=0, column=0, padx=6)
        tk.Button(btns, text="\u297E  Lifetime Plan", width=17, height=2,
                  bg="#ff3b6b", fg="white", font=("Segoe UI", 10, "bold"),
                  relief="flat", bd=0, cursor="hand2",
                  command=lambda: pick("onetime")).grid(row=0, column=1, padx=6)

        tk.Label(root, text="Pressing the button opens new shop registration in your browser",
                 bg="white", fg="#9b9690", font=("Segoe UI", 8)).pack(pady=(10, 0))

        tk.Button(root, text="Not now — Dismiss", bg="white", fg="#9b9690",
                  font=("Segoe UI", 9), relief="flat", bd=0, cursor="hand2",
                  command=root.destroy).pack(pady=(12, 0))

        root.after(120000, lambda: root.destroy())   # 2 min baad khud band
        root.mainloop()
    except Exception:
        try:
            import ctypes
            r = ctypes.windll.user32.MessageBoxW(
                None,
                "Your shop is currently running on a DEMO Shop ID.\n\n"
                "Choose the Monthly or Lifetime plan to continue.\n\n"
                "Pressing OK will open the registration page.",
                "QR Se Print — Demo", 0x40 | 0x1)
            if r == 1:
                _open_register("onetime")
        except Exception:
            pass


def demo_reminder_loop():
    """Background thread — checks every 5 minutes whether a slot is due."""
    last_status_check = 0
    is_demo, expired = False, False
    while agent_state["running"]:
        try:
            now = time.time()
            # Demo status har 30 min me ek baar refresh (server par halka)
            if now - last_status_check > 1800:
                is_demo, expired = _demo_status()
                last_status_check = now
            if is_demo and not expired:
                slot = _demo_slot_index()
                if slot is not None:
                    tag = f"{datetime.now().strftime('%Y-%m-%d')}#{slot}"
                    if not _demo_reminder_done(tag):
                        _demo_reminder_mark(tag)
                        log(f"\u23f0 Demo upgrade reminder ({slot + 1}/4 aaj)")
                        threading.Thread(target=_show_demo_upgrade_popup, daemon=True).start()
        except Exception:
            pass
        time.sleep(DEMO_CHECK_INTERVAL)


def _report_with_retry(url, payload, job_id, what):
    """Result report SERVER tak pahunchna hi chahiye — ek attempt fail hone
    par job server par 'printing' me atka rehta hai aur 10 min baad requeue
    hokar DUBARA print ho jata hai (duplicate paper!). Isliye 6 koshish,
    10s gap — kamzor network par bhi ~1 min me pahunch jata hai."""
    for attempt in range(1, 7):
        try:
            r = requests.post(url, json=payload, timeout=15)
            if r.status_code == 200:
                if attempt > 1:
                    log(f"✅ {what} report delivered on attempt {attempt} ({job_id})")
                return True
            log(f"⚠️ {what} report HTTP {r.status_code} (koshish {attempt}/6)", "WARN")
        except Exception as e:
            log(f"⚠️ {what} report fail (koshish {attempt}/6): {e}", "WARN")
        if attempt < 6:
            time.sleep(10)
    log(f"❌ {what} report failed after 6 attempts — job {job_id} "
        f"will stay stuck on the server (the server clears it in 10 minutes)", "ERROR")
    return False

def mark_complete(job_id):
    # Pehle local record, phir server report. Agar report ke beech me
    # agent crash ho jaye to bhi ye job dobara print nahi hoga.
    try:
        mark_processed(job_id)
    except Exception as e:
        log(f"Could not record processed job: {e}", "WARN")
    log(f"✅ Job {job_id} complete! Reporting to the server...")
    _report_with_retry(f"{SERVER_URL}/api/jobs/complete/{job_id}", {}, job_id, "Complete")

def mark_failed(job_id, reason=""):
    _report_with_retry(f"{SERVER_URL}/api/jobs/failed/{job_id}", {"reason": reason}, job_id, "Failed")


# ══════════════════════════════════════════════════════════════════
# COUNTER-PAYMENT APPROVAL POPUP
# Counter (cash) wale jobs mein customer ne abhi paisa NAHI diya hota —
# system turant print nikal deta tha. Ab owner ke PC par popup: details
# dekho, cash lo, Approve karo — tab print. Deny = job cancel + file delete.
# FAIL-OPEN: popup kisi wajah se na ban paye to print ho jata hai —
# popup ki technical dikkat business nahi rokni chahiye.
# ══════════════════════════════════════════════════════════════════
def ask_backside():
    """Manual duplex: front pages print ho gaye — owner se pucho back side
    ready hai? tkinter popup, fail par ctypes MessageBox (win32 core,
    virtually kabhi fail nahi hota). Dono fail (impossible-adjacent) to
    True — evens print karo, worst case alag sheets par niklenge."""
    if not tk_usable():
        return _ask_backside_native()
    try:
        import tkinter as tk
        result = {"ok": None}
        root = tk.Tk()
        root.title("QR Se Print — Back Side")
        root.attributes("-topmost", True)
        root.resizable(False, False)
        w, h = 380, 240
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        root.geometry(f"{w}x{h}+{sw - w - 20}+{sh - h - 80}")
        root.configure(bg="white")
        tk.Label(root, text="📄 Front Side Printed!", font=("Segoe UI", 13, "bold"),
                 bg="white").pack(pady=(18, 4))
        tk.Label(root, text="Now put the printed pages back into the printer tray\n"
                            "(with the blank side facing the print head).\n"
                            "Then press the button below — the back side will print.",
                 font=("Segoe UI", 10), bg="white", fg="#444", justify="center").pack(pady=4)
        btns = tk.Frame(root, bg="white"); btns.pack(pady=12)
        def _ok(): result["ok"] = True; root.destroy()
        def _no(): result["ok"] = False; root.destroy()
        tk.Button(btns, text="🖨️ Print The Back Side Now", font=("Segoe UI", 10, "bold"),
                  bg="#16a34a", fg="white", padx=14, pady=8, bd=0, cursor="hand2",
                  command=_ok).pack(side="left", padx=6)
        tk.Button(btns, text="❌ Rehne Do", font=("Segoe UI", 10, "bold"),
                  bg="#9ca3af", fg="white", padx=14, pady=8, bd=0, cursor="hand2",
                  command=_no).pack(side="left", padx=6)
        root.mainloop()
        if result["ok"] is None:
            return False  # X se band = back side cancel
        return result["ok"]
    except Exception:
        try:
            import ctypes
            r = ctypes.windll.user32.MessageBoxW(None,
                "Front side printed!\n\nPut the pages back into the printer,\n"
                "then press OK — the back side will print.\n(Cancel = skip the back side)",
                "QR Se Print — Back Side", 0x40 | 0x1)
            return r == 1
        except Exception:
            log("⚠️ Back-side popup + MessageBox dono fail — evens seedha print", "WARN")
            return True

def ask_approval(job):
    # Tcl kaam hi nahi kar raha to bekar me Tk() banane ki koshish
    # mat karo - seedha Windows ke apne dialog par jao.
    if not tk_usable():
        return _ask_approval_native(job)
    try:
        import tkinter as tk

        color  = job.get("color_mode", "bw")
        copies = job.get("copies", 1)
        pages  = job.get("total_pages", 1)
        sel    = job.get("selected_pages", "")
        amount = job.get("amount", 0)
        fname  = job.get("file_name", "file")
        # Server ka created_at (ISO/UTC) -> local time
        tstr = ""
        try:
            from datetime import datetime, timezone
            raw = job.get("created_at", "")
            if raw:
                dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                tstr = dt.astimezone().strftime("%I:%M %p")
        except Exception:
            tstr = ""

        result = {"ok": None}
        root = tk.Tk()
        root.title("QR Se Print — Counter Order")
        root.attributes("-topmost", True)
        root.resizable(False, False)
        # Bottom-right corner (tray ke paas)
        w, h = 360, 300
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        root.geometry(f"{w}x{h}+{sw - w - 20}+{sh - h - 80}")
        root.configure(bg="white")

        tk.Label(root, text="🪙 Counter Payment Order", font=("Segoe UI", 13, "bold"),
                 bg="white").pack(pady=(16, 2))
        tk.Label(root, text="The customer will pay cash at the counter — approve this print?",
                 font=("Segoe UI", 9), bg="white", fg="#666").pack()

        box = tk.Frame(root, bg="#f6f4ff", padx=14, pady=10)
        box.pack(fill="x", padx=16, pady=10)
        mode_txt = "🌈 COLOR" if color == "color" else "⚫ B&W"
        pages_txt = f"{pages} page" + ("s" if pages != 1 else "")
        if sel:
            pages_txt += f" (pages: {sel})"
        rows = [
            ("Print", f"{mode_txt}  •  {pages_txt}  •  {copies} cop{'ies' if copies!=1 else 'y'}"),
            ("Amount", f"₹{amount}  (to be collected at the counter)"),
            ("File", fname[:38]),
        ]
        if tstr:
            rows.append(("Time", tstr))
        for k, v in rows:
            r = tk.Frame(box, bg="#f6f4ff"); r.pack(fill="x", pady=2)
            tk.Label(r, text=k, font=("Segoe UI", 9, "bold"), bg="#f6f4ff",
                     width=8, anchor="w").pack(side="left")
            tk.Label(r, text=v, font=("Segoe UI", 9), bg="#f6f4ff",
                     anchor="w", wraplength=240, justify="left").pack(side="left")

        btns = tk.Frame(root, bg="white"); btns.pack(pady=6)
        def _ok():
            result["ok"] = True; root.destroy()
        def _no():
            result["ok"] = False; root.destroy()
        tk.Button(btns, text="✅ Approve & Print", font=("Segoe UI", 10, "bold"),
                  bg="#16a34a", fg="white", padx=16, pady=8, bd=0,
                  cursor="hand2", command=_ok).pack(side="left", padx=6)
        tk.Button(btns, text="❌ Deny", font=("Segoe UI", 10, "bold"),
                  bg="#dc2929", fg="white", padx=22, pady=8, bd=0,
                  cursor="hand2", command=_no).pack(side="left", padx=6)
        tk.Label(root, text="Denying will cancel the order and delete the file",
                 font=("Segoe UI", 8), bg="white", fg="#999").pack()

        root.mainloop()

        if result["ok"] is None:
            # Window band ki bina choose kiye (X) — kuch mat karo abhi,
            # job 'printing' claim mein hai; 10-min cleanup requeue karega
            # aur agla poll dobara popup dikhayega
            return None
        return result["ok"]
    except Exception as e:
        # PEHLE yahan seedha `return True` tha - popup fail hote hi
        # job chup-chaap approve ho jaata tha aur log me "Owner
        # approved" likh jaata tha. Paise ka gate aise hi bina kisi
        # ko pata chale mar gaya tha.
        log(f"Approval popup fail ({e}) - Windows dialog par ja rahe hain", "WARN")
        return _ask_approval_native(job)

def process_job(job):
    """
    In-flight guard ke saath wrapper. Asli kaam _process_job_inner karta hai.
    finally me cleanup — chahe print safal ho, fail ho, ya exception aaye —
    job ID kabhi "abhi chal raha hai" list me atki nahi rahegi.
    """
    job_id = job.get("id", "unknown")
    try:
        return _process_job_inner(job)
    except Exception as e:
        log(f"❌ Job {job_id} crashed: {e}", "ERROR")
        try:
            mark_failed(job_id, str(e)[:180])
        except Exception:
            pass
    finally:
        _inflight_jobs.discard(job_id)


def _process_job_inner(job):
    job_id  = job.get("id", "unknown")
    # DUPLICATE PRINT GUARD — server ne claim to kar liya hai, par agent
    # restart ya stuck-job requeue ke baad wahi job dobara aa sakta hai.
    # Customer ka paisa ek print ka hai, do nahi.
    if already_processed(job_id):
        log(f"⏭️  Job {job_id} already printed earlier — skipping (duplicate)")
        try:
            mark_complete(job_id)
        except Exception:
            pass
        return
    # Server ne isi job ko dobara bhej diya jabki ye abhi print ho raha hai
    # (bada PDF 45s se zyada le raha ho). Chhod do — do baar nahi nikalna.
    if job_id in _inflight_jobs:
        log(f"⏭️  Job {job_id} abhi print ho raha hai — dobara nahi lenge")
        return
    _inflight_jobs.add(job_id)
    url     = job.get("file_url")
    copies  = job.get("copies", 1)
    color   = job.get("color_mode", "bw")
    ext     = job.get("file_type", "pdf")
    fname   = job.get("file_name", f"print.{ext}")
    pages   = job.get("total_pages", 1)
    paper   = job.get("paper_size", "a4")
    amount  = job.get("amount", 0)
    selected_pages = job.get("selected_pages", "")

    # Shop ne agar specific B&W/Color printer set kiya hai (Super Admin/
    # Dashboard se), to job ke color_mode ke hisaab se sahi printer select
    # karte hain — system default printer ko IGNORE karke. Agar set nahi
    # hai (khali string), to None pass hoga aur purana default-printer
    # wala behavior chalega (backward compatible, kuch nahi tootega).
    printer_name_bw = job.get("printer_name_bw", "") or None
    printer_name_color = job.get("printer_name_color", "") or None
    printer_name_4x6 = job.get("printer_name_4x6", "") or None
    printer_name_a3 = job.get("printer_name_a3", "") or None
    printer_name_duplex = job.get("printer_name_duplex", "") or None
    # ── ROUTING PRECEDENCE ──
    # 1. Paper-special printer (4x6 photo / A3-A2-A1 large) agar shop ne set kiya
    # 2. Duplex printer — dono side wala job, aur shop ne alag printer diya ho
    # 3. Warna color/bw routing (jaisa pehle)
    #
    # Kagaz ka size printer ki MAJBOORI hai, duplex sirf ek suvidha —
    # isliye A3/4x6 wala printer duplex se JEETTA hai. A3 ki sheet chhote
    # printer me jaayegi hi nahi, chahe usme duplex ho.
    _paper = (job.get("paper_size", "a4") or "a4").lower()
    if _paper == "4x6" and printer_name_4x6:
        target_printer = printer_name_4x6
        log(f"   📷 4x6 photo job — special printer: {printer_name_4x6}")
    elif _paper in ("a3", "a2", "a1") and printer_name_a3:
        target_printer = printer_name_a3
        log(f"   📐 {_paper.upper()} large job — special printer: {printer_name_a3}")
    elif bool(job.get("duplex")) and printer_name_duplex:
        target_printer = printer_name_duplex
        log(f"   📄 Duplex job — duplex printer: {printer_name_duplex}")
    else:
        target_printer = printer_name_bw if color == "bw" else printer_name_color

    # ── COUNTER APPROVAL GATE ── online-paid jobs seedha print (paisa aa
    # chuka); sirf counter jobs par owner se pucho
    log(f"📄 Job {job_id}: {color.upper()} | copies={job.get('copies',1)} | "
        f"BW-printer='{printer_name_bw or 'default'}' | Color-printer='{printer_name_color or 'default'}' | "
        f"target='{target_printer or 'DEFAULT PRINTER'}'")

    if job.get("payment_method") == "counter" and approval_enabled():
        update_tray_status("Counter order — waiting for approval")
        ans = ask_approval(job)
        if ans is None:
            log(f"⏸️ Approval window closed without a response — job {job_id} will come back later")
            return
        if ans is False:
            log(f"❌ Owner ne DENY kiya — job {job_id} cancel")
            mark_failed(job_id, "Shop owner ne counter order deny kiya")
            return
        log(f"✅ Owner approved — job {job_id} is printing")

    log(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log(f"📄 Job: {job_id}")
    log(f"   File: {fname}")
    log(f"   Pages: {pages} | Copies: {copies} | {color.upper()} | ₹{amount}")
    if selected_pages:
        log(f"   Specific Pages Requested: {selected_pages}")
    if target_printer:
        log(f"   🎯 Target Printer ({color.upper()}): {target_printer}")

    # Server se authorized download URL lo. Server sirf URL deta hai —
    # PDF Cloudinary se SEEDHA is PC par aati hai, Render se hoke nahi.
    signed_url, blocked = get_download_url(job_id, url)
    if blocked:
        log(f"❌ Server refused this job: {blocked}", "ERROR")
        mark_failed(job_id, blocked)
        return
    url = signed_url or url

    if not url:
        log("❌ No file URL!", "ERROR")
        mark_failed(job_id, "No URL")
        return

    filepath = download_file(url, ext)
    if not filepath:
        report_download(job_id, False, err="download failed")
        mark_failed(job_id, "Download failed")
        return
    report_download(job_id, True, os.path.getsize(filepath))

    file_size = os.path.getsize(filepath)
    if file_size < 100:
        log(f"❌ File empty: {file_size} bytes", "ERROR")
        os.unlink(filepath)
        mark_failed(job_id, "Empty file")
        return

    _dup_on   = bool(job.get("duplex"))
    _dup_mode = job.get("duplex_mode", "") or ""
    if selected_pages:
        _dup_pages = len([p for p in str(selected_pages).replace(' ', '').split(',') if p])
    else:
        _dup_pages = int(job.get("total_pages", 1) or 1)
    success = print_file(filepath, copies, color, selected_pages, target_printer,
                         duplex_on=_dup_on, duplex_mode=_dup_mode, duplex_pages=_dup_pages,
                         paper_size=job.get("paper_size", "a4") or "a4",
                         total_pages=job.get("total_pages", 0))

    try:
        time.sleep(3)
        if os.path.exists(filepath):
            os.unlink(filepath)
            log("🗑️  Local file deleted")
    except:
        pass

    if success:
        mark_complete(job_id)
        log(f"🎉 Job {job_id} DONE!")
    else:
        mark_failed(job_id, "Print failed")
        log(f"❌ Job {job_id} failed!", "ERROR")

def check_dependencies():
    if is_running_as_exe():
        # .exe build mein sab kuch already bundled hai (PyInstaller ne pack kiya hai)
        log("🔍 Checking dependencies... (.exe mode — everything is bundled)")
        log("✅ Pillow, win32print, PyPDF2, PyCryptodome, pystray — sab ready (bundled)")
        return

    log("🔍 Dependencies check...")
    try:
        from PIL import Image
        log("✅ Pillow (image→PDF) ready")
    except ImportError:
        log("⚠️  Pillow not found! Installing...", "WARN")
        os.system("pip install Pillow --quiet")
        try:
            from PIL import Image
            log("✅ Pillow installed!")
        except:
            log("❌ Pillow could not be installed — JPG/PNG printing will not work!", "ERROR")
    try:
        import win32print
        log("✅ win32print ready")
    except ImportError:
        log("⚠️  win32print not found! Run: pip install pywin32", "WARN")
    try:
        from PyPDF2 import PdfReader
        log("✅ PyPDF2 (page range) ready")
    except ImportError:
        log("⚠️  PyPDF2 not found! Installing...", "WARN")
        os.system("pip install PyPDF2 --quiet")
    try:
        import Crypto  # noqa
        log("✅ PyCryptodome (encrypted PDF) ready")
    except ImportError:
        log("⚠️  PyCryptodome not found! Installing...", "WARN")
        os.system("pip install pycryptodome --quiet")
        try:
            import Crypto  # noqa
            log("✅ PyCryptodome installed!")
        except:
            log("❌ PyCryptodome could not be installed — page extraction may fail for some PDFs!", "ERROR")
    try:
        import pystray
        log("✅ pystray (System Tray) ready")
    except ImportError:
        log("⚠️  pystray not found! Installing...", "WARN")
        os.system("pip install pystray --quiet")
        try:
            import pystray
            log("✅ pystray installed!")
        except:
            log("⚠️  pystray could not be installed — tray mode will not work, using console mode", "WARN")

# ─── DESKTOP CONTROL PANEL (optional UI layer) ──────────────────────
# Panel na khule to bhi agent poori tarah kaam karta hai — printing, tray,
# auto-update sab pehle jaisa. Isliye import failure yahan swallow karte hain.
PANEL = None
try:
    import agent_panel as PANEL
    PANEL.bind(sys.modules[__name__])
except Exception as _panel_err:
    PANEL = None

def switch_shop_id_live(new_shop_id):
    """
    Shop ID ko CHALTE-CHALTE badlo — process restart ke bina.

    Restart kyun nahi: purana restart flow hi wo _MEI crash deta tha
    (Phase 0). Conversion ke waqt customer ko wo crash dikhana sabse
    kharab experience hoga. SHOP_ID module-level variable hai, isliye
    globals() se update karte hain aur config file atomically likhte hain.
    """
    global SHOP_ID
    old = SHOP_ID

    # IMPORTANT: server par conversion ho chuki hai — agent token already
    # paid shop par move ho gaya hai. Ab agar hum yahan ruk gaye to PC purane
    # demo ID par atka rahega aur printing band ho jaayegi.
    # Isliye: MEMORY me switch pehle karo (printing turant chal jaaye),
    # file write baad me — file fail ho to sirf "restart ke baad yaad nahi
    # rahega" wali problem hoti hai, printing nahi rukti.
    SHOP_ID = new_shop_id

    saved = False
    try:
        # Atomic write — beech me power gayi to config corrupt na ho
        tmp = SHOP_CONFIG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new_shop_id)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, SHOP_CONFIG_FILE)
        saved = True
    except Exception as e:
        log(f"Shop ID switched in memory but could not be saved to disk: {e}", "ERROR")
        log(f"   After a restart this PC may ask for the Shop ID again — enter: {new_shop_id}", "WARN")
    # Purane demo ke processed-job records ab bekaar hain
    try:
        _processed_jobs.clear()
        _save_processed()
    except Exception:
        pass

    agent_state["connection"] = "connecting"
    agent_state["reconnect_requested"] = True      # turant naye shop se poll karo
    log(f"✅ Shop switched: {old} → {new_shop_id}" + ("" if saved else " (not saved to disk)"))
    try:
        report_printers_to_server()
    except Exception:
        pass
    update_tray_status("Running — waiting for jobs")
    return True if saved else "memory-only"


def is_demo_shop():
    """
    Demo hai ya paid — SERVER batata hai, Shop ID ke text se guess nahi karte
    (spec: backend is the source of truth). Server na mile to False —
    galti se paid shop ko demo dikhane se behtar hai kuch na dikhana.
    """
    try:
        if PANEL is not None:
            return PANEL.shop_type() == "demo"
    except Exception:
        pass
    return False


def open_upgrade_panel(icon=None, item=None):
    """Tray ka '⚡ Change Demo ID to Paid Shop'."""
    if PANEL is None:
        _msgbox("Please open Settings to upgrade your demo to a paid shop.", "QR Se Print")
        return
    try:
        PANEL.open_panel(page="upgrade")
    except Exception as e:
        log(f"Upgrade panel failed: {e}", "ERROR")


def open_panel(icon=None, item=None):
    """Tray ka '⚙ Settings' — desktop panel kholo."""
    if PANEL is None:
        _msgbox("The desktop panel is not available in this build.\n\n"
                "Your Print Agent is running normally and printing is unaffected.",
                "QR Se Print")
        return
    try:
        PANEL.open_panel()
    except Exception as e:
        log(f"Panel open failed: {e} — agent continues normally", "ERROR")

# ─── AUTO-UPDATE: Server se check karo naya version hai ya nahi ──────
def get_remote_version():
    """Fetch the latest agent version number from the server"""
    try:
        resp = requests.get(f"{SERVER_URL}/api/agent/version", timeout=15)
        resp.raise_for_status()
        data = resp.json()
        v = data.get("version")
        # Naya server display label bhi bhejta hai ("2.1"). Purana server nahi
        # bhejta — tab None rehne do aur apna hi label dikhate raho.
        global REMOTE_VERSION_LABEL, REMOTE_VERSION_INT
        try:
            REMOTE_VERSION_INT = int(v) if v is not None else 0
        except Exception:
            REMOTE_VERSION_INT = 0
        lbl = data.get("versionLabel") or data.get("displayVersion")
        REMOTE_VERSION_LABEL = lbl if (isinstance(lbl, str) and _VERSION_LABEL_RE.match(lbl.strip())) else None
        # Server string bhej de ("7") to int(6) se compare TypeError deta —
        # update silently kabhi trigger nahi hota. Int coerce karo.
        return int(v) if v is not None else None
    except Exception as e:
        log(f"⚠️  Version check failed: {e}", "WARN")
        return None

def remote_label_or(fallback_int):
    """Server ka label dikhao; na mile to internal number hi dikha do."""
    return REMOTE_VERSION_LABEL or f"{fallback_int}"

def download_latest_agent():
    """Download the new print_agent.py code from the server"""
    try:
        resp = requests.get(f"{SERVER_URL}/api/agent/download-latest", timeout=30)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        log(f"❌ Could not download the new agent: {e}", "ERROR")
        return None

def apply_update_and_restart(new_code=None):
    """
    Source (.py) mode mein: naya code current SHOP_ID/SERVER_URL ke saath
    fill karke print_agent.py replace karte hain, phir restart.

    .exe mode mein: .py source replace karna kaam nahi karega (exe already
    compiled hai), isliye iske jagah naya installer .exe download karke
    chalate hain — woh khud purane ko replace karke restart karega.
    """
    if is_running_as_exe():
        apply_exe_update_and_restart()
        return

    try:
        # Naya code mein placeholder ko current Shop ID/Server URL se fill karo
        new_code = new_code.replace('AAPKA_SHOP_ID', SHOP_ID)
        new_code = new_code.replace(
            'SERVER_URL         = "https://qrseprint.in"',
            f'SERVER_URL         = "{SERVER_URL}"'
        )

        current_file = os.path.abspath(__file__)
        backup_file = current_file + ".backup"

        # Purani file ka backup rakho (kuch gadbad ho jaye to wapas use kar sake)
        shutil.copy2(current_file, backup_file)

        with open(current_file, 'w', encoding='utf-8') as f:
            f.write(new_code)

        log("✅ New code installed! Restarting the agent...")

        # Khud ko restart karo — naye Python process mein same script chalao.
        # pythonw.exe force karte hain taaki restart ke baad bhi koi console
        # window na khule (chahe yeh process pythonw ya python se shuru hua ho)
        python_exe = sys.executable
        pythonw_exe = python_exe.replace('python.exe', 'pythonw.exe')
        if not os.path.exists(pythonw_exe):
            pythonw_exe = python_exe  # fallback agar pythonw nahi mila

        _spawn_detached([pythonw_exe, current_file], cwd=os.path.dirname(current_file))
        time.sleep(2.0)   # naye process ko start hone ka time do

        # Tray icon band karke is purane process ko exit karo
        if agent_state["tray_icon"]:
            agent_state["tray_icon"].stop()
        os._exit(0)
    except Exception as e:
        log(f"❌ Update apply karne mein error: {e}", "ERROR")

def download_installer(progress_cb=None):
    """
    Naya installer download karo. progress_cb(percent_or_None, mb_done)
    har chunk par call hota hai. Return: installer path ya (None, error_msg).
    """
    resp = requests.get(f"{SERVER_URL}/api/agent/download-latest-exe", timeout=120, stream=True)
    if resp.status_code == 404:
        return None, "No new installer has been uploaded to the server (inform the Super Admin)"
    resp.raise_for_status()

    total = int(resp.headers.get('content-length') or 0)
    # FIX [Errno 13]: fixed filename par purana locked/antivirus-held installer
    # har agla download fail karwata tha (auto + manual dono). Ab unique naam
    # per download + purane installers best-effort saaf.
    try:
        for old_f in os.listdir(tempfile.gettempdir()):
            if old_f.startswith("QRSePrint-Update-") and old_f.endswith(".exe"):
                try: os.remove(os.path.join(tempfile.gettempdir(), old_f))
                except Exception: pass
    except Exception:
        pass
    installer_path = os.path.join(tempfile.gettempdir(), f"QRSePrint-Update-{int(time.time())}.exe")
    done = 0
    with open(installer_path, 'wb') as f:
        for chunk in resp.iter_content(chunk_size=65536):
            if chunk:
                f.write(chunk)
                done += len(chunk)
                if progress_cb:
                    pct = int(done * 100 / total) if total else None
                    progress_cb(pct, done / 1048576)
    if done < 100_000:  # <100KB = installer nahi, koi error page hai
        return None, "The downloaded file does not look like an installer (too small) — check the installer URL"
    return installer_path, None

def run_installer_and_exit(installer_path):
    log("🔄 Installing silent update...")
    # Installer khud naya agent .exe launch karta hai — agar env saaf na ho
    # to wo bhi _MEIPASS2 inherit kar lega (installer ke through chain hoke).
    _spawn_detached([installer_path, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
    time.sleep(2)
    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    os._exit(0)

def apply_exe_update_and_restart():
    """Auto-update path (hourly loop) — silent, no UI."""
    try:
        log("⬇️  Downloading the new installer...")
        installer_path, err = download_installer()
        if err:
            log(f"❌ {err}", "ERROR")
            return
        log(f"✅ Installer downloaded: {installer_path}")
        run_installer_and_exit(installer_path)
    except Exception as e:
        log(f"❌ .exe update apply karne mein error: {e}", "ERROR")

# ─── MANUAL UPDATE CHECK (tray menu se) ──────────────────────────────
# Auto-loop errors chupchaap kha jata hai — yeh window sab kuch DIKHATI
# hai: server ka version, download %, aur exact error. Har shop par bina
# logs khole update-problem diagnose ho jati hai.
def manual_update_check(icon=None, item=None):
    threading.Thread(target=_manual_update_ui, daemon=True).start()

def _msgbox(text, title="QR Se Print", flags=0x40):
    """Windows message box via ctypes — needs no Tkinter/Tcl."""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, title, flags)
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════
#  TCL-PROOF DIALOGS
#
#  Problem jo aaya tha: exe me tkinter ka MODULE to bundle tha, par
#  uska Tcl DATA (init.tcl waghairah) nahi. Aise me `import tkinter`
#  SAFAL hota hai aur galti sirf tab dikhti hai jab tk.Tk() banate ho
#  ("Can't find a usable init.tcl"). Isliye sirf ImportError pakadna
#  kaafi nahi - poora Tk() banakar dekhna padta hai.
#
#  Ye probe EK BAAR chalta hai, phir jawab yaad rakhta hai.
# ══════════════════════════════════════════════════════════════
_TK_STATE = None          # None = check nahi hua, True/False = pata hai


def tk_usable():
    """Tcl/Tk sach me chalta hai? Ek baar probe, phir cached."""
    global _TK_STATE
    if _TK_STATE is not None:
        return _TK_STATE
    try:
        import tkinter as _tk
        _probe = _tk.Tk()          # asli test - import kaafi nahi hota
        _probe.withdraw()
        _probe.destroy()
        _TK_STATE = True
    except Exception as e:
        log(f"Tkinter/Tcl is build me kaam nahi kar raha ({e}) - "
            f"Windows ke apne dialog use honge", "WARN")
        _TK_STATE = False
    return _TK_STATE


# MessageBoxW ke flags (winuser.h)
_MB_YESNO         = 0x00000004
_MB_ICONQUESTION  = 0x00000020
_MB_SETFOREGROUND = 0x00010000
_MB_TOPMOST       = 0x00040000
_IDYES, _IDNO = 6, 7


def _native_yesno(text, title="QR Se Print"):
    """
    Yes/No poochho bina kisi Tcl ke - seedha user32.dll ka MessageBoxW.
    Ye Windows ka apna hissa hai: na bundle karna padta hai, na install.

    Returns True (Yes) / False (No) / None (dialog hi nahi bana).
    """
    try:
        import ctypes
        r = ctypes.windll.user32.MessageBoxW(
            0, text, title,
            _MB_YESNO | _MB_ICONQUESTION | _MB_SETFOREGROUND | _MB_TOPMOST)
        if r == _IDYES:
            return True
        if r == _IDNO:
            return False
        return None
    except Exception as e:
        log(f"Native MessageBox bhi fail hua: {e}", "ERROR")
        return None


def _ask_approval_native(job):
    """
    Counter order ka approval, Tcl ke bina.

    Dikhne me tkinter wale window jitna sundar nahi, par ye KABHI fail
    nahi hota - aur paise wale gate ka chup-chaap khul jaana isse bahut
    zyada bura hai.
    """
    color  = job.get("color_mode", "bw")
    copies = job.get("copies", 1)
    pages  = job.get("total_pages", 1)
    sel    = job.get("selected_pages", "")
    amount = job.get("amount", 0)
    fname  = job.get("file_name", "file")

    mode_txt  = "COLOR" if color == "color" else "B&W"
    pages_txt = f"{pages} page" + ("s" if pages != 1 else "")
    if sel:
        pages_txt += f" (pages: {sel})"
    cop_txt = "ies" if copies != 1 else "y"

    text = (
        "COUNTER PAYMENT ORDER\n"
        "The customer will pay cash at the counter.\n"
        "\n"
        f"Print   :  {mode_txt}  -  {pages_txt}  -  {copies} cop{cop_txt}\n"
        f"Amount  :  Rs {amount}   (collect at the counter)\n"
        f"File    :  {str(fname)[:44]}\n"
        "\n"
        "Yes  =  Approve and print\n"
        "No   =  Deny (order cancel, file delete)"
    )
    ans = _native_yesno(text, "QR Se Print - Counter Order")

    if ans is None:
        # Dono dialog systems fail - Windows par practically impossible.
        # Agar phir bhi ho jaye to print ROKNA bhi galat hai (dukaan band
        # ho jayegi), isliye print jaari - par LOUD, chupchaap nahi.
        log("Approval dialog kisi bhi tarike se nahi khul paya - job print "
            "ja raha hai BINA approval ke. Agent ek baar restart karke dekho.",
            "ERROR")
        try:
            update_tray_status("Approval popup nahi khul raha - bina approval print")
        except Exception:
            pass
        return True
    return ans


def _ask_backside_native():
    """Back-side prompt bina Tcl ke."""
    ans = _native_yesno(
        "FRONT SIDE PRINTED\n"
        "\n"
        "Ab chhape hue page wapas printer ki tray me rakho\n"
        "(khaali side print head ki taraf).\n"
        "\n"
        "Yes  =  Back side ab print karo\n"
        "No   =  Rehne do (sirf front side)",
        "QR Se Print - Back Side")
    if ans is None:
        log("Back-side dialog nahi khul paya - evens seedha print", "WARN")
        return True
    return ans


def bundle_selfcheck():
    """
    Startup par ek baar: kya-kya sach me bundle hua hai, log me saaf likho.

    Pehle ye guess-work tha. Exe ban jaati thi, print bhi chal jaata tha
    (kyunki us PC par SumatraPDF alag se install tha) aur kisi ko pata hi
    nahi chalta ki bundle khaali hai - jab tak kisi naye PC par sab fail
    na ho jaye.
    """
    frozen = bool(getattr(sys, 'frozen', False) or globals().get('__compiled__'))
    if not frozen:
        log("Bundle check skip - ye sirf .exe build ke liye hai (abhi script mode)")
        return

    # -- SumatraPDF --
    bundled = get_bundled_resource_path('SumatraPDF.exe')
    if bundled:
        log(f"BUNDLE  SumatraPDF : BUNDLED OK  ({bundled})")
    else:
        found_system = None
        for p in (r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
                  r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
                  os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe")):
            try:
                if os.path.exists(p):
                    found_system = p
                    break
            except Exception:
                pass
        if found_system:
            log(f"BUNDLE  SumatraPDF : BUNDLE ME NAHI - is PC par alag se install "
                f"mila ({found_system}). NAYE PC PAR PRINT FAIL HOGA. Build folder "
                f"me SumatraPDF.exe rakh kar dobara build karo.", "WARN")
        else:
            log("BUNDLE  SumatraPDF : MISSING - na bundle me, na is PC par. "
                "Print kaam nahi karega!", "ERROR")

    # -- Tcl/Tk --
    if tk_usable():
        log("BUNDLE  Tcl/Tk     : OK - popup window normal dikhenge")
    else:
        log("BUNDLE  Tcl/Tk     : BUNDLE ME NAHI - Windows ke simple dialog "
            "use honge. Kaam sab chalega, bas dikhne me basic.", "WARN")

    # -- Desktop panel --
    if get_bundled_resource_path('agent_panel.html'):
        log("BUNDLE  Panel HTML : BUNDLED OK")
    else:
        log("BUNDLE  Panel HTML : BUNDLE ME NAHI - desktop panel nahi khulega "
            "(printing normal chalegi)", "WARN")


def _manual_update_headless():
    """
    Update check without any Tkinter window.

    Needed because some builds of the .exe do not ship the Tcl/Tk runtime.
    In that case opening a Tkinter window fails with "Can't find a usable
    init.tcl", and earlier that error was simply shown to the shop owner and
    nothing else happened. Now the update still runs — only the progress
    window is missing.
    """
    try:
        remote = get_remote_version()
        if remote is None:
            _msgbox("Could not get the version from the server.\n"
                    "Check your internet or the server, then try again.",
                    "QR Se Print — Update", 0x30)
            return
        if remote <= VERSION:
            _msgbox(f"You have the latest version.\n\nInstalled: v{VERSION_LABEL}",
                    "QR Se Print — Update")
            return

        _rl = remote_label_or(remote)
        log(f"🔄 New version available: v{VERSION_LABEL} → v{_rl} (headless update)")
        _msgbox(f"New version found: v{VERSION_LABEL} -> v{_rl}\n\n"
                f"Downloading now. The agent will restart by itself.\n"
                f"This can take a few minutes on a slow connection.",
                "QR Se Print — Update")
        try:
            installer_path, err = download_installer(None)
        except Exception as e:
            installer_path, err = None, str(e)
        if not installer_path:
            log(f"❌ Manual update (headless): {err}", "ERROR")
            _msgbox(f"Update download failed.\n\n{err}",
                    "QR Se Print — Update", 0x10)
            return
        log(f"✅ Installing v{remote} (headless)...")
        run_installer_and_exit(installer_path)
    except Exception as e:
        log(f"❌ Headless update error: {e}", "ERROR")
        _msgbox(f"Update check error: {e}", "QR Se Print", 0x10)


def _manual_update_ui():
    try:
        import tkinter as tk
        from tkinter import ttk

        root = tk.Tk()
        root.title("QR Se Print — Update Check")
        root.attributes('-topmost', True)
        root.resizable(False, False)
        root.geometry("380x190")
        frame = tk.Frame(root, bg='white')
        frame.pack(fill='both', expand=True)

        title = tk.Label(frame, text="🔍 Checking for updates...",
                         font=('Segoe UI', 12, 'bold'), bg='white')
        title.pack(pady=(22, 4))
        sub = tk.Label(frame, text=f"Currently installed: v{VERSION_LABEL}",
                       font=('Segoe UI', 10), bg='white', fg='#666')
        sub.pack()
        bar = ttk.Progressbar(frame, length=300, mode='determinate')
        pct_lbl = tk.Label(frame, text="", font=('Segoe UI', 10, 'bold'), bg='white')
        close_btn = tk.Button(frame, text="Close", font=('Segoe UI', 10),
                              command=root.destroy)
        root.update()

        # 1) Version check
        remote = get_remote_version()
        if remote is None:
            title.config(text="⚠️ Could not get the version from the server")
            sub.config(text="Check your internet or the server, then try again")
            close_btn.pack(pady=14)
            root.mainloop()
            return
        if remote <= VERSION:
            title.config(text="✅ You have the latest version")
            sub.config(text=f"Installed v{VERSION_LABEL} = Server v{remote_label_or(remote)}")
            close_btn.pack(pady=14)
            root.mainloop()
            return

        # 2) Naya version mila — download with %
        title.config(text=f"🔄 New version available: v{VERSION_LABEL} → v{remote_label_or(remote)}")
        sub.config(text="Downloading...")
        bar.pack(pady=(14, 4))
        pct_lbl.pack()
        root.update()

        def on_progress(pct, mb):
            if pct is not None:
                bar['value'] = pct
                pct_lbl.config(text=f"{pct}%  ({mb:.1f} MB)")
            else:
                bar.config(mode='indeterminate')
                pct_lbl.config(text=f"{mb:.1f} MB downloaded...")
            root.update()

        try:
            installer_path, err = download_installer(on_progress)
        except Exception as e:
            installer_path, err = None, str(e)

        if err:
            title.config(text="❌ Update download fail")
            sub.config(text=err[:60])
            log(f"❌ Manual update: {err}", "ERROR")
            close_btn.pack(pady=10)
            root.mainloop()
            return

        # 3) Install + restart
        bar['value'] = 100
        pct_lbl.config(text="100%")
        title.config(text=f"✅ Installing v{remote}...")
        sub.config(text="The agent will restart itself — the new version will show in the tray")
        root.update()
        time.sleep(1.5)
        root.destroy()
        run_installer_and_exit(installer_path)
    except Exception as e:
        # Tkinter/Tcl missing in this .exe build (classic symptom:
        # "Can't find a usable init.tcl"). Do not dump that at the shop owner —
        # run the same update without a window instead.
        log(f"⚠️  Update window unavailable ({e}) — running update without UI", "WARN")
        _manual_update_headless()
        return
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None,
                f"Update check error: {e}", "QR Se Print", 0x10)
        except Exception:
            pass

def update_checker_loop():
    """Background thread — checks for a new version every UPDATE_CHECK_INTERVAL seconds"""
    # Pehla check thoda delay se — taaki agent properly start ho jaye pehle
    time.sleep(30)
    while agent_state["running"]:
        try:
            remote_version = get_remote_version()
            if remote_version is not None and remote_version > VERSION:
                _rl = remote_label_or(remote_version)
                log(f"🔄 New version available: v{_rl} (currently running v{VERSION_LABEL})")
                update_tray_status(f"Updating to v{_rl}...")

                if is_running_as_exe():
                    # .exe mode — seedha naya installer download/run karo
                    apply_update_and_restart()
                else:
                    # Source (.py) mode — purana flow: naya .py code download karke replace karo
                    new_code = download_latest_agent()
                    if new_code:
                        apply_update_and_restart(new_code)
                    else:
                        log("⚠️  Update download failed, will try again at the next check", "WARN")
        except Exception as e:
            log(f"⚠️  Update checker error: {e}", "WARN")
        time.sleep(UPDATE_CHECK_INTERVAL)

# ─── SYSTEM TRAY ───────────────────────────────────────────────────
def update_tray_status(status_text):
    """Update the tray icon tooltip/status"""
    agent_state["status"] = status_text
    if agent_state["tray_icon"]:
        try:
            agent_state["tray_icon"].title = f"QR Se Print — {status_text}"
        except Exception:
            pass

# Print loop ko turant jagane ke liye. Pehle har 1 second par flag check
# hota tha, matlab Reconnect dabane ke baad bhi 1 second tak ruk sakta tha.
# Event se ye 0 millisecond ho jaata hai.
_wake_event = threading.Event()

def wake_print_loop():
    """Print loop ko abhi jaga do — sleep beech me hi tod do."""
    _wake_event.set()

def _interruptible_sleep(seconds):
    """
    Sona, par Reconnect ya Exit par TURANT uthna.
    Event.wait() us hi pal wapas aa jaata hai jab koi wake_print_loop()
    kare — koi polling, koi deri nahi.
    """
    if seconds <= 0:
        return
    if _wake_event.wait(timeout=seconds):
        _wake_event.clear()

def reconnect_to_server(icon=None, item=None, announce=True):
    """
    'Reconnect to Server' — tray se ya desktop panel se.
    Software band karke dobara kholne ki zaroorat nahi: yeh printer dobara
    detect karta hai, server se turant check karta hai aur status reset
    kar deta hai.
    """
    log("🔌 Reconnect to Server pressed")
    # Manual click hua to chalta hua counter bekaar hai — rok do.
    # (Auto wala khud yahan aata hai, use rokne ki zaroorat nahi.)
    if announce:
        cancel_auto_reconnect()
    reset_http()          # purane mare hue socket phenk do
    agent_state["connection"] = "connecting"
    update_tray_status("Reconnecting...")
    agent_state["reconnect_requested"] = True
    wake_print_loop()     # print loop abhi jaage — sleep khatam hone ka intezaar nahi

    # Printer dobara detect karo — kai baar printer offline hone ke baad
    # default printer badal jaata hai ya handle stale ho jaata hai.
    try:
        ok, printer_name = check_printer()
        if ok and printer_name:
            agent_state["printer"] = printer_name
            log(f"🖨️  Printer re-detected: {printer_name}")
        else:
            log("⚠️  No printer found during reconnect", "WARN")
    except Exception as e:
        log(f"Printer re-detect skipped: {e}", "WARN")

    # Server ko current printer list dobara bhejo (best-effort)
    try:
        report_printers_to_server()
    except Exception as e:
        log(f"Printer report skipped: {e}", "WARN")

    # TURANT check — user ko poll ka intezaar na karna pade. Halka
    # read-only endpoint hai, koi job claim nahi hoti.
    connected = ping_server()
    if connected:
        agent_state["connection"] = "online"
        update_tray_status("Running — waiting for jobs")
        log("✅ Reconnected — server se jud gaya")
        # Success hamesha batao — chahe manual ho ya auto. Isi ka
        # to intezaar tha.
        tray_notify("Connected", "Server se jud gaya — pending print ab nikal jayenge")
        reset_auto_reconnect_notice()
    else:
        agent_state["connection"] = "offline"
        update_tray_status("Offline — click Reconnect to Server")
        log("❌ Reconnect fail — server tak nahi pahunche", "WARN")
        # Sirf manual click par batao. Auto koshish har baar
        # notification bheje to lambi outage me spam ban jaayega.
        if announce:
            tray_notify("Not connected", "Internet check karke dobara Reconnect dabao")
    return connected

def ping_server(timeout=8):
    """
    Server pahunch me hai ya nahi — bas itna. Read-only endpoint, isliye
    koi print job claim nahi hoti (get_pending_jobs yahan use MAT karo,
    warna job claim ho jayegi par print nahi hogi).
    """
    try:
        r = http().get(f"{SERVER_URL}/api/agent/version", timeout=timeout)
        return r.status_code == 200
    except Exception as e:
        log(f"Server ping failed: {e}", "WARN")
        return False

def tray_notify(title, msg):
    """Windows ka chhota notification — best effort."""
    try:
        icon = agent_state.get("tray_icon")
        if icon and hasattr(icon, "notify"):
            icon.notify(msg, f"QR Se Print — {title}")
    except Exception:
        pass

# ══════════════════════════════════════════════════════════════
#  OFFLINE -> NOTIFICATION + 10 SECOND ULTA COUNTER + AUTO RECONNECT
#
#  Pehle offline hone par sirf tray ka text badalta tha. Shop wale ka
#  dhyan tray par tabhi jaata hai jab print na nikle — tab tak customer
#  khada rehta hai. Ab Windows ka notification turant dikhta hai aur
#  10 second baad agent KHUD reconnect kar leta hai.
#
#  EK BAAT SAAF: Windows ke tray notification (Shell_NotifyIcon balloon,
#  jo pystray use karta hai) me BUTTON nahi ho sakta — wo sirf text
#  dikhata hai. Isliye ulta counter TRAY TOOLTIP me chalta hai, jahan
#  har second update hota hai:
#      "Offline — 7s me auto reconnect"
#  User chahe to tray par right-click -> Reconnect to Server dabakar
#  turant kara sakta hai; tab counter apne aap ruk jaata hai.
# ══════════════════════════════════════════════════════════════
_auto_rc_lock = threading.Lock()
_auto_rc_running = False
_auto_rc_cancel = threading.Event()
_auto_rc_last_notify = 0.0


def auto_reconnect_active():
    """Countdown chal raha hai? (print_loop tray text overwrite na kare)"""
    return _auto_rc_running


def cancel_auto_reconnect():
    """User ne khud Reconnect daba diya — counter ab bekaar hai."""
    _auto_rc_cancel.set()


def reset_auto_reconnect_notice():
    """Connection wapas aane par — agli baar notification turant aaye."""
    global _auto_rc_last_notify
    _auto_rc_last_notify = 0.0


def start_auto_reconnect_countdown():
    """
    Offline hote hi ek notification bhejo, tray me 10 se 1 tak ulta
    counter chalao, phir khud reconnect kar do.

    Alag thread me chalta hai taaki print loop ruke nahi.
    """
    global _auto_rc_running
    with _auto_rc_lock:
        if _auto_rc_running:
            return                      # ek waqt me ek hi counter
        _auto_rc_running = True
    _auto_rc_cancel.clear()

    def _run():
        global _auto_rc_running, _auto_rc_last_notify
        try:
            # Raat bhar internet band ho to har baar notification bhejna
            # torture hai. Isliye notification AUTO_RECONNECT_NOTIFY_GAP me
            # ek baar — par reconnect ki koshish tab bhi hoti rehti hai.
            now = time.time()
            if now - _auto_rc_last_notify >= AUTO_RECONNECT_NOTIFY_GAP:
                _auto_rc_last_notify = now
                tray_notify(
                    "Connection toot gaya",
                    f"Server se baat nahi ho rahi. {AUTO_RECONNECT_SECONDS} second me "
                    f"apne aap reconnect hoga.\n"
                    f"Turant karna ho to tray icon par right-click karke "
                    f"'Reconnect to Server' dabao.")

            for left in range(AUTO_RECONNECT_SECONDS, 0, -1):
                if not agent_state.get("running"):
                    return
                if agent_state.get("connection") == "online":
                    log("✅ Counter ke beech hi connection wapas aa gaya")
                    return
                update_tray_status(f"Offline — {left}s me auto reconnect")
                # wait() us hi pal wapas aa jaata hai jab user Reconnect
                # dabaye — poore 1 second ka intezaar nahi karna padta.
                if _auto_rc_cancel.wait(timeout=1.0):
                    log("🔌 User ne khud Reconnect dabaya — counter band")
                    return

            if not agent_state.get("running"):
                return
            log(f"⏱️  {AUTO_RECONNECT_SECONDS}s pura — auto reconnect chala rahe hain")
            update_tray_status("Auto reconnect ho raha hai...")
            # announce=False: fail hone par notification mat bhejo, warna
            # lambi outage me har koshish par ek notification aayegi.
            reconnect_to_server(announce=False)
        except Exception as e:
            log(f"Auto reconnect counter error: {e}", "WARN")
        finally:
            with _auto_rc_lock:
                _auto_rc_running = False

    threading.Thread(target=_run, daemon=True,
                     name="auto-reconnect").start()


def create_tray_icon_image():
    """Draw a small printer-like icon (using Pillow)"""
    from PIL import Image, ImageDraw
    img = Image.new('RGB', (64, 64), color=(10, 10, 15))
    draw = ImageDraw.Draw(img)
    # Simple printer shape: body + paper
    draw.rectangle([12, 24, 52, 44], fill=(255, 77, 29))   # printer body
    draw.rectangle([20, 10, 44, 29], fill=(255, 255, 255)) # paper
    draw.rectangle([16, 44, 48, 54], fill=(40, 40, 45))    # tray
    return img

def toggle_approval(icon=None, item=None):
    now = not approval_enabled()
    set_approval(now)
    log(f"🔔 Counter approval: {'ON' if now else 'OFF'}")
    try:
        icon.update_menu()
    except Exception:
        pass

def open_logs(icon=None, item=None):
    """Log file ko Notepad mein kholo"""
    try:
        log_path = os.path.abspath(LOG_FILE)
        if os.path.exists(log_path):
            os.startfile(log_path)
        else:
            log("The log file has not been created yet")
    except Exception as e:
        log(f"Logs open karne mein error: {e}", "ERROR")

def contact_admin(icon=None, item=None):
    """
    Tray se 'Contact Admin' — WhatsApp browser me khulta hai, Shop ID
    pehle se message me bhara hua. Bilkul shop-login ke Support button
    jaisa. Owner ko sirf apni problem type karke send karni hai.
    """
    try:
        import webbrowser, urllib.parse
        # admin.html ke sendWhatsApp() jaisa hi format
        text = (
            "Hello, QR Se Print Support \U0001F64F\n\n"
            f"Shop ID: {SHOP_ID}\n\n"
            "Problem: "
        )
        url = f"https://wa.me/{SUPPORT_WA}?text=" + urllib.parse.quote(text)
        webbrowser.open(url)
        log("\U0001F4AC Contact Admin — WhatsApp opened")
    except Exception as e:
        log(f"Contact Admin error: {e}", "ERROR")

def change_shop_id(icon=None, item=None):
    """
    Tray se 'Change Shop ID' click karne par config file delete karo
    aur agent ko restart karo — restart hote hi naya Shop ID popup khulega.
    """
    log("🔄 Shop ID change requested — restarting the agent...")
    try:
        if os.path.exists(SHOP_CONFIG_FILE):
            os.remove(SHOP_CONFIG_FILE)
    except Exception as e:
        log(f"Config delete error: {e}", "ERROR")

    try:
        # Mutex release karo warna naya instance "already running" samajh
        # ke exit ho jayega aur Shop ID popup kabhi nahi khulega
        _release_mutex()
        if is_running_as_exe():
            _spawn_detached([sys.executable])
        else:
            python_exe = sys.executable
            pythonw_exe = python_exe.replace('python.exe', 'pythonw.exe')
            if not os.path.exists(pythonw_exe):
                pythonw_exe = python_exe
            _spawn_detached([pythonw_exe, os.path.abspath(__file__)],
                            cwd=os.path.dirname(os.path.abspath(__file__)))
        # Naye process ko apna temp folder extract karne ka time do. Iske
        # bina purana bootloader apna _MEIxxxxxx folder delete kar sakta hai
        # jabki naya process abhi imports hi kar raha hota hai.
        time.sleep(2.0)
    except Exception as e:
        log(f"Restart error: {e}", "ERROR")

    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    os._exit(0)

def quit_agent(icon=None, item=None):
    """Shut the agent down gracefully when 'Exit' is clicked in the tray"""
    log("👋 Exit pressed from the tray — shutting the agent down...")
    agent_state["running"] = False
    wake_print_loop()     # sleep me atka loop turant khatam ho
    # Panel window band karo — warna main thread ka webview loop chalta
    # reh jaata hai aur process poori tarah band nahi hota.
    try:
        if PANEL is not None:
            PANEL.shutdown()
    except Exception:
        pass
    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    os._exit(0)

def _tray_action(fn):
    """
    Tray menu me function SEEDHA mat do — hamesha isse lapet kar do.

    KYUN (ye ek asli bug tha, theory nahi):
    pystray sirf 0, 1 ya 2 parameter wala callable accept karta hai. 3 ya
    usse zyada dekhte hi wo MenuItem banate waqt phenk deta hai:

        File "pystray/_base.py", in _assert_action
        ValueError: <function reconnect_to_server at 0x...>

    Aur ye exception poora `pystray.Menu(...)` banna rok deta hai — yaani
    TRAY ICON BANTA HI NAHI. v2.3 me bilkul yahi hua: auto-reconnect
    feature ne reconnect_to_server() me teesra parameter (announce=True)
    jod diya, aur us din se na tray icon aaya na panel khula. Printing
    chalti rehti thi kyunki wo apne alag thread me hai — isliye wajah
    pakadna aur mushkil ho gaya tha.

    Ye wrapper hamesha THEEK 2 parameter dikhata hai, chahe asli function
    me kitne bhi ho. Aage koi naya parameter add kare to bhi tray safe.
    """
    def _runner(icon=None, item=None):
        return fn(icon, item)
    # Log/debug me asli naam dikhe, '_runner' nahi
    try:
        _runner.__name__ = fn.__name__
    except Exception:
        pass
    return _runner


# Tray icon ko taiyaar hone ke liye itne second do. Slow PC par pystray
# ko window banane me thoda time lagta hai; 12s me aaram se ho jaata hai.
TRAY_WAIT_SEC = 12


def _tray_is_up(icon, timeout=TRAY_WAIT_SEC):
    """
    Tray icon SACH ME ban gaya?

    icon.run_detached() turant laut aata hai — uska laut jaana iska sabut
    NAHI hai ki icon ban gaya. pystray Windows par apna (chhupa hua)
    window ek alag thread me banata hai aur usi ka handle _hwnd me rakhta
    hai. Us thread me kuch fail ho to _hwnd kabhi set hi nahi hota.
    Isliye handle ka intezaar karte hain, function ke return ka nahi.
    """
    end = time.time() + timeout
    while time.time() < end:
        try:
            if getattr(icon, "_hwnd", None) or getattr(icon, "visible", False):
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def panel_request_watcher():
    """
    Owner ne exe par dobara double-click kiya? Wo doosra instance ek
    request file chhod kar band ho jaata hai — hum wahi dekh kar apna
    panel khol dete hain.
    """
    while agent_state.get("running", True):
        try:
            if os.path.exists(PANEL_REQUEST_FILE):
                try:
                    os.remove(PANEL_REQUEST_FILE)
                except Exception:
                    pass
                log("🪟 Panel request mili (exe dobara chalaya gaya) — panel khol rahe hain")
                if PANEL is not None:
                    try:
                        PANEL.open_panel()
                    except Exception as e:
                        log(f"Panel nahi khul paya: {e}", "WARN")
        except Exception:
            pass
        time.sleep(1)


def run_tray_icon():
    """
    System Tray icon start karo. Yeh function tray ke event-loop mein
    block ho jaata hai — isliye print-checking loop ko alag thread mein chalate hain.
    """
    try:
        import pystray
        from pystray import MenuItem as Item

        _CONN_DOT = {"online": "🟢", "connecting": "🟡", "offline": "🔴"}

        def status_label(item):
            dot = _CONN_DOT.get(agent_state.get("connection", "connecting"), "🟡")
            return f"{dot} Status: {agent_state['status']}"

        def shop_label(item):
            return f"Shop: {SHOP_ID}"

        def printer_label(item):
            return f"Printer: {agent_state['printer']}"

        def version_label(item):
            return f"Version: v{VERSION_LABEL}"

        menu = pystray.Menu(
            Item(status_label, None, enabled=False),
            Item(shop_label, None, enabled=False),
            Item(printer_label, None, enabled=False),
            Item(version_label, None, enabled=False),
            pystray.Menu.SEPARATOR,
            # DEMO-ONLY: conversion ke turant baad ye apne aap gayab ho
            # jaata hai — pystray har baar menu render karte waqt visible()
            # dobara call karta hai. Reinstall ki zaroorat nahi.
            # ── HAR ACTION _tray_action() SE HO KAR JAATA HAI ──
            # Ek bhi action seedha diya aur usme 2 se zyada parameter hue,
            # to pystray poora menu banane se mana kar deta hai aur TRAY
            # ICON GAYAB ho jaata hai (v2.3 me reconnect_to_server ke saath
            # yahi hua tha). Naya menu item add karo to wrapper mat bhoolna.
            Item("⚡ Change Demo ID to Paid Shop", _tray_action(open_upgrade_panel),
                 visible=lambda item: is_demo_shop()),
            Item("⚙ Settings", _tray_action(open_panel), default=True),
            Item("🔌 Reconnect to Server", _tray_action(reconnect_to_server)),
            Item(lambda item: f"🔔 Counter Approval: {'ON' if approval_enabled() else 'OFF'}",
                 _tray_action(toggle_approval)),
            Item("📋 View Logs", _tray_action(open_logs)),
            Item("💬 Contact Admin", _tray_action(contact_admin)),
            Item("⬆️ Check for Update", _tray_action(manual_update_check)),
            Item("🔄 Change Shop ID", _tray_action(change_shop_id)),
            Item("❌ Exit", _tray_action(quit_agent)),
        )

        icon_image = create_tray_icon_image()
        icon = pystray.Icon("qr_se_print", icon_image, "QR Se Print — Starting...", menu)
        agent_state["tray_icon"] = icon

        # ══════════════════════════════════════════════════════
        # THREAD BAANT
        #
        # Windows par pywebview KEVAL main thread par window bana sakta
        # hai. Background thread se ye error aata hai:
        #     "pywebview must be run on a main thread"
        # Udhar pystray ka icon.run() bhi main thread chahta hai.
        #
        # Isliye:
        #   MAIN thread       -> panel (pywebview)
        #   Background thread -> tray  (icon.run_detached())
        #
        # Panel available na ho to sab kuch pehle jaisa: tray main
        # thread par, printing bilkul waise hi chalti rahegi.
        # ══════════════════════════════════════════════════════
        use_panel = False
        if PANEL is not None:
            try:
                use_panel = PANEL.panel_available()
            except Exception as e:
                log(f"Panel check failed: {e}", "WARN")
                use_panel = False

        if not use_panel:
            log("Panel is PC par available nahi — tray main thread par chala rahe hain")
            icon.run()               # purana behaviour — tray only
            return

        try:
            icon.run_detached()      # tray background thread me
        except Exception as e:
            # Kuch systems par run_detached support nahi hota — tab panel
            # chhod do, printing zaroori hai.
            log(f"Tray detached mode unavailable ({e}) — tray-only mode", "WARN")
            icon.run()
            return

        # ── AB CONFIRM KARO KI TRAY SACH ME AAYA ──
        # Ye check isliye hai: run_detached() turant laut aata hai, par
        # icon banta hai ek doosre thread me. Wahan kuch fail ho jaye to
        # PEHLE ye hota tha — na tray icon, na koi error, aur uske turant
        # baad panel main thread le leta tha. Owner ko dikhta kuch nahi
        # tha aur log bilkul saaf rehta tha, isliye wajah pakadna
        # namumkin ho jaata tha. Ab agar tray nahi aaya to use main
        # thread par chalate hain — tray PAKKA milega (panel us halat me
        # nahi khulega, par printing par koi asar nahi).
        if not _tray_is_up(icon):
            log(f"Tray icon {TRAY_WAIT_SEC}s me nahi aaya — ab ise main thread "
                f"par chala rahe hain. Panel is baar nahi khulega; printing "
                f"aur auto-update normal chalte rahenge.", "WARN")
            try:
                icon.run()
            except Exception as e:
                import traceback as _tb
                log(f"Tray main thread par bhi start nahi hua: {e}", "ERROR")
                log(_tb.format_exc(), "ERROR")
            return

        log("✅ Tray icon ready — ab panel main thread par khul raha hai")

        # Main thread ab panel ko de do. Shop ID verify ho chuka hai,
        # isliye panel seedha khulega (spec).
        ok = PANEL.start_ui_loop(show_now=True)
        if not ok:
            log("Panel could not start — continuing in tray-only mode", "WARN")

        # Yahan tabhi pahunchte hain jab panel ka loop khatam ho gaya ho,
        # ya shuru hi na hua ho. Dono me tray aur print thread abhi chal
        # rahe hain — agar yahan se return kar diya to process mar jayega
        # aur PRINTING BAND ho jayegi. Isliye zinda raho.
        # Sirf Exit (quit_agent) hi process band karta hai — wo running=False
        # karke os._exit(0) call karta hai.
        while agent_state.get("running", True):
            time.sleep(1)
    except ImportError as e:
        # Pehle yahan sirf ek generic line jaati thi. Asli module ka naam
        # kabhi log me nahi aata tha, isliye "tray gayab" wali shikayat par
        # kuch pata hi nahi chalta tha ki kaun si cheez missing hai.
        import traceback as _tb
        log(f"⚠️  Tray ke liye zaroori module nahi mila: {e}", "WARN")
        log(_tb.format_exc(), "WARN")
        log("    Console mode me chal rahe hain — printing normal chalegi.", "WARN")
    except Exception as e:
        import traceback as _tb
        log(f"❌ Tray icon could not start: {e}", "ERROR")
        log(_tb.format_exc(), "ERROR")

# ─── MAIN PRINT LOOP (background thread mein chalta hai jab tray active ho) ──
def print_loop():
    log("=" * 50)
    log(f"Job check: {CHECK_INTERVAL}s busy | {IDLE_INTERVAL_1}s ({IDLE_STEP_1_SEC//60} min khaali) "
        f"| {IDLE_INTERVAL_2}s ({IDLE_STEP_2_SEC//60} min khaali) — job aate hi wapas {CHECK_INTERVAL}s par")
    log("=" * 50)
    update_tray_status("Running — waiting for jobs")

    errors = 0
    check_count = 0
    idle_since = time.time()      # aakhri job kab aaya tha
    cur_interval = CHECK_INTERVAL
    elapsed_min = 0.0
    last_socket_refresh = time.time()
    last_err_log = 0.0

    while agent_state["running"]:
        try:
            # Manual "Reconnect to Server" — turant fast mode par wapas aao
            if agent_state.get("reconnect_requested"):
                agent_state["reconnect_requested"] = False
                errors = 0
                idle_since = time.time()
                cur_interval = CHECK_INTERVAL
                # Manual Reconnect ka matlab hi yahi hai ki kuch atka hai —
                # isliye purana session phenk kar naya socket banao.
                reset_http()
                last_socket_refresh = time.time()
                _reset_poll_log()
                log("🔌 Reconnect requested — naya connection banakar check kar rahe hain...")

            # Lambi idle ke baad socket mar chuka hota hai. Job aane ka
            # intezaar mat karo — khaali baithe hi session refresh kar do,
            # taaki asli job aaye to pehla hi poll kaam kar jaye.
            if (time.time() - idle_since) > IDLE_STEP_1_SEC and \
               (time.time() - last_socket_refresh) >= IDLE_SOCKET_REFRESH_SEC:
                reset_http()
                last_socket_refresh = time.time()
                log("🔁 Idle socket refresh — naya connection taiyaar")

            jobs = get_pending_jobs()
            check_count += 1

            # None = poll FAIL. Ise [] (koi job nahi) se alag rakhna
            # zaroori hai. except me bhejte hain taaki wahan baithi
            # recovery — reset_http(), backoff, tray "Offline" — chale.
            if jobs is None:
                raise PollError("server se jawab nahi mila")

            # Server ne jawab de diya = connection theek hai. Chahe jobs
            # mile ya nahi, error state yahin clear kar do.
            # (Purana bug: status sirf 'if jobs' ke andar reset hota tha,
            #  isliye ek network blip ke baad tray hamesha ke liye
            #  "Error — retrying" par atak jaata tha.)
            if errors:
                log("✅ Connection restored — back to normal")
                _reset_poll_log()
                last_err_log = 0.0
                reset_auto_reconnect_notice()
            errors = 0
            agent_state["connection"] = "online"

            if jobs:
                log(f"📬 {len(jobs)} new job(s)!")
                update_tray_status(f"Printing {len(jobs)} job(s)...")
                for job in jobs:
                    process_job(job)
                update_tray_status("Running — waiting for jobs")
                # Job aaya = dukaan busy hai. Turant tez check par wapas.
                idle_since = time.time()
                if cur_interval != CHECK_INTERVAL:
                    cur_interval = CHECK_INTERVAL
                    log(f"⚡ Fast mode — har {CHECK_INTERVAL}s check")
            else:
                # v2.0: sirf do speed — 5s (abhi job aaya tha) aur 10s (khaali).
                # Pehle 45s tak chala jaata tha, jisse job aane ke baad
                # print me 45 second tak ki deri ho sakti thi.
                idle_sec = time.time() - idle_since
                if idle_sec <= IDLE_STEP_1_SEC:
                    new_interval = CHECK_INTERVAL      # 5s
                elif idle_sec <= IDLE_STEP_2_SEC:
                    new_interval = IDLE_INTERVAL_1     # 10s
                else:
                    new_interval = IDLE_INTERVAL_2     # 12s
                if new_interval != cur_interval:
                    cur_interval = new_interval
                    log(f"💤 Idle — ab har {cur_interval}s check")
                elapsed_min += cur_interval / 60.0
                if check_count % 60 == 0:
                    log(f"👀 Waiting... ({int(elapsed_min)} min)")
                # Poll safal = sab theek. Tray par jo bhi purana text bacha
                # ho (Error / Offline / Reconnecting), use hata do.
                # BUG THA: pehle sirf "Error"/"Offline" par reset hota tha,
                # isliye "Reconnecting..." hamesha ke liye atak jaata tha.
                if agent_state.get("status", "") != "Running — waiting for jobs":
                    update_tray_status("Running — waiting for jobs")

            # Sleep chhote tukdon mein — taaki Reconnect click karte hi
            # agent 60s tak so na jaaye.
            _interruptible_sleep(cur_interval)
        except KeyboardInterrupt:
            log("\n👋 Shutting down...")
            break
        except Exception as e:
            errors += 1
            # Har fail par line likhne se log file bhar jaati hai:
            # 12s polling me ~300 line/ghanta, aur asli baat dab jaati
            # hai. Pehli 3 turant likho, uske baad har 60s me ek.
            if errors <= 3 or (time.time() - last_err_log) >= 60:
                last_err_log = time.time()
                log(f"❌ Error: {e}", "ERROR")
            if errors == 2:
                # Do baar fail = socket sach me mar chuka hai. Naya session
                # banao taaki user ko khud Reconnect na dabana pade.
                # (Pehle 3 par tha — 12s polling me wo ~36s ka intezaar
                #  ban jaata tha. 2 par recovery kaafi tez ho jaati hai.)
                log("🔄 Connection reset kar rahe hain (auto)")
                reset_http()
                last_socket_refresh = time.time()
            if errors >= 3:
                was_offline = agent_state.get("connection") == "offline"
                agent_state["connection"] = "offline"
                # Counter chal raha ho to tray ka text mat chheedo —
                # warna ulta counter har second overwrite ho jayega.
                if not auto_reconnect_active():
                    update_tray_status("Offline — click Reconnect to Server")
                # Counter sirf tab shuru karo jab ABHI offline hue hain,
                # ya lambi outage me notification ka gap poora ho gaya ho.
                # Har error par shuru karte to 10s ka loop ban jaata aur
                # backoff ka koi matlab nahi rehta.
                if (not was_offline) or \
                   (time.time() - _auto_rc_last_notify) >= AUTO_RECONNECT_NOTIFY_GAP:
                    start_auto_reconnect_countdown()
            else:
                agent_state["connection"] = "connecting"
                update_tray_status("Reconnecting...")
            # Capped exponential backoff: 5s, 10s, 20s, 40s ... max 60s.
            # Pehle 10 errors ke baad seedha 60s ho jaata tha aur counter
            # reset ho jaata tha, jisse offline detection bhi reset ho jaati.
            backoff = min(CHECK_INTERVAL * (2 ** min(errors - 1, 5)), 60)
            _interruptible_sleep(backoff)

def main():
    show_banner()
    check_dependencies()

    _load_processed()
    log(f"🚀 Agent start | Shop: {SHOP_ID} | Version: v{VERSION_LABEL} (build {VERSION})")
    log(f"🌐 Server: {SERVER_URL}")

    # PC restart pe agent khud tray mein start ho — HKCU Run registry
    add_to_startup()

    # CRITICAL FIX: Pehle yahan printer na milne par input("Enter dabao...")
    # call hota tha — yeh .exe ke WINDOWED mode mein (jahan koi console/STDIN
    # hi nahi hota, kyunki yeh background tray app hai) crash ya silent hang
    # kar deta tha. Yeh exact situation PC restart ke turant baad hoti hai:
    # Windows Startup se agent turant launch hota hai, lekin printer driver/
    # USB/network printer abhi initialize nahi hua hota — check_printer()
    # fail ho jaata, aur poora process crash ho jaata bina kisi visible
    # error ke. Isi wajah se "it sometimes disappears from the tray" wala
    # symptom aata tha.
    #
    # FIX: ab hum RETRY karte hain (printer thodi der mein ready ho sakta
    # hai), aur agar baar-baar fail bhi ho, to PROCESS CRASH NAHI karte —
    # tray icon phir bhi chalta rehta hai, aur background mein printer
    # detection retry hota rehta hai (print_loop ke through).
    printer_ok, printer_name = check_printer()
    retry_count = 0
    while not printer_ok and retry_count < 6:
        retry_count += 1
        log(f"⏳ Printer is not ready yet, waiting 10s before retry {retry_count}/6...", "WARN")
        time.sleep(10)
        printer_ok, printer_name = check_printer()

    if not printer_ok:
        log("⚠️  Printer still not found — keeping the tray icon running anyway, "
            "print_loop will keep retrying the printer in the background", "WARN")
        printer_name = "Not Detected"
    else:
        log(f"✅ Printer: {printer_name}")

    agent_state["printer"] = printer_name

    # Printer list server ko report karo (startup pe) — Dashboard mein
    # dropdown se B&W/Color printer select karne ke liye zaroori hai
    try:
        report_printers_to_server()
    except Exception:
        pass

    def printer_report_loop():
        while agent_state["running"]:
            time.sleep(1800)  # 30 minute
            try:
                report_printers_to_server()
            except Exception:
                pass
    printer_report_thread = threading.Thread(target=printer_report_loop, daemon=True)
    printer_report_thread.start()

    # Demo shop par upgrade reminder (subah 9 se raat 8, 4 baar)
    demo_thread = threading.Thread(target=demo_reminder_loop, daemon=True)
    demo_thread.start()

    # Auto-update checker background thread mein chalao
    update_thread = threading.Thread(target=update_checker_loop, daemon=True)
    update_thread.start()
    log(f"🔄 Auto-update checker active (har {UPDATE_CHECK_INTERVAL//60} min check karega)")

    # Print loop bhi background thread mein chalao — taaki tray icon
    # foreground mein chal sake (yeh OS requirement hai tray icons ke liye)
    print_thread = threading.Thread(target=print_loop, daemon=True)
    print_thread.start()

    # Owner exe par dobara double-click kare to panel khul jaye
    threading.Thread(target=panel_request_watcher, daemon=True).start()

    # Purani request file (pichhli baar ki) pehle hi saaf kar do, warna
    # start hote hi bina wajah panel khul jayega.
    try:
        if os.path.exists(PANEL_REQUEST_FILE):
            os.remove(PANEL_REQUEST_FILE)
    except Exception:
        pass

    # Tray icon start karo (yeh block karega jab tak Exit na dabaya jaye)
    try:
        run_tray_icon()
    except Exception as trayErr:
        log(f"⚠️  Tray icon error: {trayErr}", "WARN")

    # Agar tray fail ho jaye (pystray missing), normal console mode mein chalte raho
    if agent_state["tray_icon"] is None:
        log("ℹ️  Running in console mode (press Ctrl+C to stop)")
        log("=" * 50)
        try:
            while agent_state["running"]:
                time.sleep(1)
        except KeyboardInterrupt:
            log("\n👋 Shutting down...")
            agent_state["running"] = False

if __name__ == "__main__":
    # CRITICAL FIX: poora main() ab try/except mein wrapped hai. Pehle agar
    # kahin bhi koi unexpected exception aati (kisi bhi function se), poora
    # process SILENTLY CRASH ho jaata — tray se gayab ho jaata bina kisi
    # trace ke. Ab har crash LOG_FILE mein likha jaata hai, taaki Tray menu
    # ke "📋 View Logs" se customer/owner asal wajah dekh sake.
    try:
        main()
    except Exception as fatalErr:
        try:
            log(f"💥 FATAL CRASH: {fatalErr}", "ERROR")
            import traceback
            log(traceback.format_exc(), "ERROR")
        except Exception:
            pass  # agar logging bhi fail ho jaaye, kam se kam process clean exit kare
