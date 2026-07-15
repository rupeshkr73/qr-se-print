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
CHECK_INTERVAL     = 5          # Print jobs check karne ka interval (seconds)
UPDATE_CHECK_INTERVAL = 3600    # Auto-update check karne ka interval (1 ghanta)
VERSION            = 12           # Integer version number — server ke agent_version se compare hota hai

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

def get_machine_id():
    """Windows MachineGuid — demo machine-lock ke liye. Fail par hostname."""
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
    """Counter jobs par owner-approval popup — default ON."""
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
    "running": True
}

def log(msg, level="INFO"):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] [{level}] {msg}"
    try:
        print(line)
    except Exception:
        pass  # .exe windowed mode mein console hi nahi hota, print() fail ho sakta hai
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except:
        pass

def is_running_as_exe():
    """
    PyInstaller se bana .exe chal raha hai ya normal Python script?
    .exe mode mein sab dependencies already bundled hoti hain.
    """
    return getattr(sys, 'frozen', False)

def show_shop_id_prompt():
    """
    .exe ka first-run setup: ek chhota Tkinter window kholo jisme
    customer apna Shop ID paste kar sake. Confirm hone par config
    file mein save ho jaata hai, future runs mein yeh popup nahi aayega.

    Agar Tkinter kisi reason se available na ho (rare), console input
    fallback use karte hain (sirf agar console attached hai, warna fail).
    """
    try:
        import tkinter as tk
        from tkinter import messagebox
    except ImportError:
        log("⚠️  Tkinter nahi hai — console input try kar rahe hain", "WARN")
        try:
            return input("Apna Shop ID daalo: ").strip().upper()
        except Exception:
            log("❌ Shop ID nahi le paaye — Tkinter aur console dono available nahi", "ERROR")
            return None

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
        status_lbl.config(text="⏳ Shop ID verify ho raha hai...")
        root.update()
        try:
            r = requests.get(f"{SERVER_URL}/api/shop/{value}", timeout=30)
            if r.status_code == 404:
                status_lbl.config(text="❌ Yeh Shop ID server pe nahi mila — check karo")
                return
            # 200/403/500 sab pe aage badho — shop exist karta hai ya
            # server issue hai, dono case mein ID save karna theek hai
        except requests.exceptions.Timeout:
            status_lbl.config(text="⏳ Server jaag raha hai — 30 sec baad dobara dabao")
            return
        except Exception:
            # Offline/net issue — verify skip, save kar do (fail-open)
            pass
        result["shop_id"] = value
        root.destroy()

    root = tk.Tk()
    root.title("QR Se Print - Setup")
    root.geometry("420x260")
    root.resizable(False, False)
    try:
        root.attributes('-topmost', True)
    except Exception:
        pass

    tk.Label(root, text="QR Se Print Setup", font=("Segoe UI", 16, "bold"), pady=10).pack()
    tk.Label(root, text="Apna Shop ID paste karo\n(Dashboard pe register karne ke baad mila tha)",
             font=("Segoe UI", 10), pady=5).pack()

    entry = tk.Entry(root, font=("Segoe UI", 12), justify="center", width=28)
    entry.pack(pady=10)
    entry.focus()

    tk.Button(root, text="Shuru Karo", font=("Segoe UI", 11, "bold"),
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

# ─── SINGLE INSTANCE LOCK ─────────────────────────────────────────────
# Startup-registry + owner ka manually exe kholna = 2 agents ek saath =
# dono same pending jobs poll karke DOUBLE PRINT nikaalte — customer ka
# paisa ek copy ka, paper/ink do ka. Mutex se sirf pehla instance chalta
# hai, baaki chupchaap exit ho jaate hain.
# NOTE: yeh check module-level pe hai (resolve_shop_id se PEHLE) taaki
# duplicate instance Shop ID popup tak bhi na pahunche.
_mutex_handle = [None]

def _ensure_single_instance():
    try:
        import ctypes
        ERROR_ALREADY_EXISTS = 183
        handle = ctypes.windll.kernel32.CreateMutexW(
            None, False, "Global\\QRSePrint_Agent_SingleInstance")
        if ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            return False
        _mutex_handle[0] = handle
        return True
    except Exception as e:
        log(f"⚠️  Mutex check fail (fail-open): {e}", "WARN")
        return True

def _release_mutex():
    try:
        import ctypes
        if _mutex_handle[0]:
            ctypes.windll.kernel32.ReleaseMutex(_mutex_handle[0])
            ctypes.windll.kernel32.CloseHandle(_mutex_handle[0])
            _mutex_handle[0] = None
    except Exception:
        pass

if not _ensure_single_instance():
    log("⛔ Agent already chal raha hai — duplicate instance exit ho raha hai")
    sys.exit(0)

SHOP_ID = resolve_shop_id()

# ─── AUTO STARTUP (PC restart pe tray mein khud start ho) ─────────────
def add_to_startup():
    """HKCU Run key mein register — admin rights ki zaroorat nahi."""
    try:
        import winreg
        if is_running_as_exe():
            cmd = f'"{sys.executable}"'
        else:
            py = sys.executable.replace('python.exe', 'pythonw.exe')
            if not os.path.exists(py):
                py = sys.executable
            cmd = f'"{py}" "{os.path.abspath(__file__)}"'
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(key, "QRSePrintAgent", 0, winreg.REG_SZ, cmd)
        winreg.CloseKey(key)
        log("✅ Windows startup mein register ho gaya (restart pe khud chalega)")
    except Exception as e:
        log(f"⚠️  Startup register nahi hua: {e}", "WARN")

def show_banner():
    # CRITICAL FIX: yahan bare print() tha — try ke bahar. --noconsole exe
    # mein sys.stdout None hota hai, print() AttributeError deta, aur yeh
    # main() ki PEHLI line hai — matlab exe har launch pe turant FATAL
    # CRASH ho jaata tha (log mein "'NoneType' object has no attribute
    # 'write'" dikhta hai). log() already guarded hai, isliye usi se bhejo.
    log(f"QR Se Print - Local Agent v{VERSION} | Tray + Auto-Update + Fit-A4")

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
        log("❌ Printer nahi mila!", "ERROR")
        return False, None
    except ImportError:
        log("⚠️  Mock mode (win32print nahi hai)", "WARN")
        return True, "MockPrinter"
    except Exception as e:
        log(f"❌ Printer error: {e}", "ERROR")
        return False, None

def list_all_printers():
    """System pe installed sab printers ki list — Dashboard dropdown ke liye"""
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
    """Apni printer list server ko bhejo, taaki Dashboard dropdown mein dikhe"""
    try:
        printers = list_all_printers()
        if not printers:
            return
        requests.post(
            f"{SERVER_URL}/api/agent/printers/{SHOP_ID}",
            json={"printers": printers},
            timeout=15
        )
        log(f"📋 Printer list server ko bheji: {printers}")
    except Exception as e:
        log(f"⚠️  Printer list report fail: {e}", "WARN")

def download_file(url, ext):
    """Cloudinary se file download karo"""
    try:
        log(f"⬇️  Downloading...")
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        if len(resp.content) < 100:
            log(f"❌ Downloaded file bahut choti hai: {len(resp.content)} bytes", "ERROR")
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
        log(f"🔄 Image → A4 PDF convert ho raha hai...")

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
            log("ℹ️  Image already A4-ratio mein hai (Canvas Editor output) — seedha use kar rahe hain")
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
        log("❌ Pillow install nahi hai! Run: pip install Pillow", "ERROR")
        return None
    except Exception as e:
        log(f"❌ Image convert error: {e}", "ERROR")
        return None

# ─── Page Range: Specific pages extract karo PDF se ────────
def extract_selected_pages(pdf_path, selected_pages_str):
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

    # PyPDF2/pypdf import
    PdfReader = None
    PdfWriter = None
    try:
        from PyPDF2 import PdfReader, PdfWriter
    except ImportError:
        try:
            from pypdf import PdfReader, PdfWriter
        except ImportError:
            log("⚠️  PyPDF2/pypdf nahi hai! Install kar raha hai...", "WARN")
            os.system("pip install PyPDF2 pycryptodome --quiet")
            try:
                from PyPDF2 import PdfReader, PdfWriter
            except Exception as e:
                log(f"❌ PyPDF2 install bhi fail hua: {e}", "ERROR")
                return None

    # PyCryptodome missing hone se aane wala specific error pre-emptively fix karo
    try:
        import Crypto  # noqa
    except ImportError:
        log("⚠️  PyCryptodome nahi hai — install kar raha hai (encrypted PDF ke liye zaroori)", "WARN")
        os.system("pip install pycryptodome --quiet")

    try:
        page_numbers = [int(p.strip()) for p in selected_pages_str.split(',') if p.strip()]
        if not page_numbers:
            log("⚠️  Page list empty hai — original PDF print hoga", "WARN")
            return pdf_path

        log(f"📑 Specific pages extract ho rahe hain: {page_numbers}")

        reader = PdfReader(pdf_path)
        writer = PdfWriter()
        total_pdf_pages = len(reader.pages)

        added_count = 0
        for pnum in page_numbers:
            idx = pnum - 1  # 1-indexed se 0-indexed
            if 0 <= idx < total_pdf_pages:
                writer.add_page(reader.pages[idx])
                added_count += 1
            else:
                log(f"⚠️  Page {pnum} PDF mein nahi hai (PDF mein {total_pdf_pages} pages hain)", "WARN")

        if added_count == 0:
            log("❌ Koi valid page extract nahi hua! Print ROK rahe hain (safety ke liye)", "ERROR")
            return None

        extracted_path = pdf_path + '_extracted.pdf'
        with open(extracted_path, 'wb') as f:
            writer.write(f)

        # Verify extracted file properly bani hai
        verify_size = os.path.getsize(extracted_path)
        if verify_size < 50:
            log(f"❌ Extracted PDF khaali/corrupt hai ({verify_size} bytes)!", "ERROR")
            return None

        log(f"✅ {added_count} page(s) extract ho gaye: {extracted_path} ({verify_size} bytes)")
        return extracted_path

    except Exception as e:
        log(f"❌ Page extract error: {e}", "ERROR")
        log(f"⚠️  SAFETY: Print ROK rahe hain taaki galat (zyada) pages print na ho", "WARN")
        return None

def get_bundled_resource_path(filename):
    """
    PyInstaller --add-binary se bundle kiye gaye files (jaise SumatraPDF.exe)
    runtime par ek temporary extraction folder mein hote hain — uska path
    sys._MEIPASS mein milta hai (sirf .exe mode mein available hota hai).
    .py script mode mein yeh attribute exist hi nahi karta.
    """
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, filename)
    return None

# ─── Problem 5: B&W / Color Print + Fit-to-A4 ────────────────────────
def print_pdf_sumatra(filepath, copies=1, color_mode="bw", printer_name=None, extra=""):
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
    if color_mode == "bw":
        print_settings = f"copies={copies},monochrome,fit"
        log(f"🖨️  B&W (Monochrome) + Fit-to-Page print karenge")
    else:
        print_settings = f"copies={copies},fit"
        log(f"🖨️  Color + Fit-to-Page print karenge")
    if extra:
        print_settings += f",{extra}"
        log(f"🖨️  Extra print settings: {extra}")

    use_specific_printer = bool(printer_name and printer_name.strip())
    if use_specific_printer:
        log(f"🎯 Specific printer route: '{printer_name}' ({color_mode.upper()} ke liye configured)")
    else:
        log(f"ℹ️  Koi specific printer set nahi hai {color_mode.upper()} ke liye — system Default Printer use hoga")

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
                    log(f"⚠️  '{printer_name}' pe print fail hua, default printer try kar rahe hain...", "WARN")
                    try:
                        fallback_cmd = [sumatra, "-print-to-default", "-silent", "-print-settings", print_settings, filepath]
                        fb_result = subprocess.run(fallback_cmd, timeout=120, capture_output=True)
                        if fb_result.returncode == 0:
                            log(f"✅ Default printer se print ho gaya (fallback)")
                            return True
                    except Exception:
                        pass
        except Exception as runErr:
            log(f"⚠️  SumatraPDF subprocess error: {runErr}", "WARN")

    # Fallback
    log("⚠️  SumatraPDF nahi mila, Windows shell se try kar raha hai...", "WARN")
    try:
        os.startfile(filepath, "print")
        time.sleep(5)
        log("✅ Windows shell se print hua (fit/B&W setting aur specific printer apply nahi hogi)")
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
                log(f"⚠️  ActivePrinter set nahi ho paaya, default use hoga: {ape}", "WARN")
        doc = word.Documents.Open(os.path.abspath(filepath))
        doc.PrintOut(Copies=copies)
        time.sleep(5)
        doc.Close(False)
        word.Quit()
        log("✅ Word print hua!")
        return True
    except:
        try:
            os.startfile(filepath, "print")
            time.sleep(3)
            return True
        except Exception as e:
            log(f"❌ Word print failed: {e}", "ERROR")
            return False

def print_file(filepath, copies=1, color_mode="bw", selected_pages="", printer_name=None, duplex_on=False, duplex_mode="", duplex_pages=1):
    """Main print function — sab file types handle karta hai"""
    ext = Path(filepath).suffix.lower()
    log(f"🖨️  Printing: {os.path.basename(filepath)}")
    log(f"   Copies: {copies} | Mode: {color_mode.upper()} | Type: {ext}")
    if selected_pages:
        log(f"   Selected Pages: {selected_pages}")

    converted_pdf = None
    extracted_pdf = None

    try:
        # Problem 1: Image files ko pehle A4-fit PDF mein convert karo
        if ext in ['.jpg', '.jpeg', '.png', '.bmp', '.gif']:
            log(f"🔄 Image file detect hua — A4 PDF mein convert kar raha hai...")
            converted_pdf = convert_image_to_pdf(filepath)
            if not converted_pdf:
                log("❌ Image to PDF conversion failed!", "ERROR")
                return False
            print_path = converted_pdf
        elif ext == '.pdf':
            print_path = filepath
            # Page Range: agar specific pages selected hain to extract karo
            if selected_pages:
                extracted_pdf = extract_selected_pages(filepath, selected_pages)
                if extracted_pdf is None:
                    log("❌ Page extraction fail hua — SAFETY ke liye print ROK rahe hain (taaki poora document galti se print na ho)", "ERROR")
                    return False
                print_path = extracted_pdf
        elif ext in ['.doc', '.docx']:
            return print_word(filepath, copies, color_mode, printer_name)
        else:
            print_path = filepath

        # ── DUPLEX ──
        # duplex_on / duplex_mode / duplex_pages ab parameters hain —
        # v9 me yahan job.get() tha par is function me 'job' hota hi nahi
        # (NameError se HAR print fail ho raha tha)
        total_pgs = duplex_pages

        if duplex_on and duplex_mode == "auto":
            # Printer khud duplex karta hai — driver ko duplexlong flag
            log("📄 AUTO duplex — printer dono side khud chhapega")
            return print_pdf_sumatra(print_path, copies, color_mode, printer_name, extra="duplexlong")

        if duplex_on and duplex_mode == "manual" and total_pgs > 1:
            # Do-pass manual duplex: pehle ODD pages (1,3,5...), phir owner
            # pages palat ke lagaye, phir EVEN pages (2,4,6...).
            # Server manual-duplex par copies=1 force karta hai.
            # NOTE: 3+ sheets par even-pass ka order printer ke output
            # stacking par depend karta hai (face-down laser = seedha sahi;
            # face-up par owner stack palat le). 1-2 page docs par hamesha sahi.
            log("📄 MANUAL duplex — pass 1: front (odd pages)")
            ok1 = print_pdf_sumatra(print_path, 1, color_mode, printer_name, extra="odd")
            if not ok1:
                return False
            update_tray_status("📄 Back side ka wait — pages palto!")
            if ask_backside():
                log("📄 MANUAL duplex — pass 2: back (even pages)")
                return print_pdf_sumatra(print_path, 1, color_mode, printer_name, extra="even")
            else:
                log("📄 Owner ne back side skip kiya — sirf front print hua")
                return True  # front print hua tha, job done

        if duplex_on and total_pgs <= 1:
            log("📄 Duplex select tha par 1 hi page hai — normal print")

        # PDF print karo with fit-to-page (image bhi ab already A4-fitted PDF hai)
        success = print_pdf_sumatra(print_path, copies, color_mode, printer_name)
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

def get_pending_jobs():
    global _demo_expired_shown
    try:
        url = f"{SERVER_URL}/api/jobs/pending/{SHOP_ID}"
        if MACHINE_ID:
            url += f"?m={MACHINE_ID}"
        resp = requests.get(url, timeout=15)
        if resp.status_code != 200:
            return []
        d = resp.json()
        if d.get("demo_expired"):
            update_tray_status("⏰ Demo khatam — register karo!")
            if not _demo_expired_shown:
                _demo_expired_shown = True
                log("⏰ Demo period khatam — register karke naya Shop ID lo")
                threading.Thread(target=_show_demo_expired_popup, daemon=True).start()
            return []
        return d.get("jobs", [])
    except Exception:
        return []

_demo_expired_shown = False

def _show_demo_expired_popup():
    try:
        import ctypes
        r = ctypes.windll.user32.MessageBoxW(None,
            "Aapka 2 ghante ka demo khatam ho gaya!\n\n"
            "Pasand aaya? Register karke apna permanent Shop ID lo:\n"
            f"{SERVER_URL}/register\n\n"
            "OK dabane par register page khulega.",
            "QR Se Print — Demo Khatam", 0x40 | 0x1)  # OK/Cancel + info icon
        if r == 1:  # OK
            os.startfile(f"{SERVER_URL}/register")
    except Exception:
        pass

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
                    log(f"✅ {what} report {attempt}vi koshish me pahuncha ({job_id})")
                return True
            log(f"⚠️ {what} report HTTP {r.status_code} (koshish {attempt}/6)", "WARN")
        except Exception as e:
            log(f"⚠️ {what} report fail (koshish {attempt}/6): {e}", "WARN")
        if attempt < 6:
            time.sleep(10)
    log(f"❌ {what} report 6 koshish ke baad bhi nahi pahuncha — job {job_id} "
        f"server par atka rahega (10 min me server khud sambhal lega)", "ERROR")
    return False

def mark_complete(job_id):
    log(f"✅ Job {job_id} complete! Server ko report ho raha hai...")
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
        tk.Label(root, text="📄 Front Side Print Ho Gaya!", font=("Segoe UI", 13, "bold"),
                 bg="white").pack(pady=(18, 4))
        tk.Label(root, text="Ab printed pages ko printer ki tray mein\n"
                            "WAPAS lagao (blank side print hone wali taraf).\n"
                            "Phir neeche button dabao — back side chhapega.",
                 font=("Segoe UI", 10), bg="white", fg="#444", justify="center").pack(pady=4)
        btns = tk.Frame(root, bg="white"); btns.pack(pady=12)
        def _ok(): result["ok"] = True; root.destroy()
        def _no(): result["ok"] = False; root.destroy()
        tk.Button(btns, text="🖨️ Ab Back Side Print Karo", font=("Segoe UI", 10, "bold"),
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
                "Front side print ho gaya!\n\nPages printer mein WAPAS lagao,\n"
                "phir OK dabao — back side print hoga.\n(Cancel = back side skip)",
                "QR Se Print — Back Side", 0x40 | 0x1)
            return r == 1
        except Exception:
            log("⚠️ Back-side popup + MessageBox dono fail — evens seedha print", "WARN")
            return True

def ask_approval(job):
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
        tk.Label(root, text="Customer counter par cash dega — print approve karein?",
                 font=("Segoe UI", 9), bg="white", fg="#666").pack()

        box = tk.Frame(root, bg="#f6f4ff", padx=14, pady=10)
        box.pack(fill="x", padx=16, pady=10)
        mode_txt = "🌈 COLOR" if color == "color" else "⚫ B&W"
        pages_txt = f"{pages} page" + ("s" if pages != 1 else "")
        if sel:
            pages_txt += f" (pages: {sel})"
        rows = [
            ("Print", f"{mode_txt}  •  {pages_txt}  •  {copies} cop{'ies' if copies!=1 else 'y'}"),
            ("Amount", f"₹{amount}  (counter par lena hai)"),
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
                  bg="#dc2626", fg="white", padx=22, pady=8, bd=0,
                  cursor="hand2", command=_no).pack(side="left", padx=6)
        tk.Label(root, text="Deny karne par order cancel + file delete ho jayegi",
                 font=("Segoe UI", 8), bg="white", fg="#999").pack()

        root.mainloop()

        if result["ok"] is None:
            # Window band ki bina choose kiye (X) — kuch mat karo abhi,
            # job 'printing' claim mein hai; 10-min cleanup requeue karega
            # aur agla poll dobara popup dikhayega
            return None
        return result["ok"]
    except Exception as e:
        log(f"⚠️ Approval popup fail ({e}) — fail-open, print jaari", "WARN")
        return True

def process_job(job):
    job_id  = job.get("id", "unknown")
    url     = job.get("file_url")
    copies  = job.get("copies", 1)
    color   = job.get("color_mode", "bw")
    ext     = job.get("file_type", "pdf")
    fname   = job.get("file_name", f"print.{ext}")
    pages   = job.get("total_pages", 1)
    amount  = job.get("amount", 0)
    selected_pages = job.get("selected_pages", "")

    # Shop ne agar specific B&W/Color printer set kiya hai (Super Admin/
    # Dashboard se), to job ke color_mode ke hisaab se sahi printer select
    # karte hain — system default printer ko IGNORE karke. Agar set nahi
    # hai (khali string), to None pass hoga aur purana default-printer
    # wala behavior chalega (backward compatible, kuch nahi tootega).
    printer_name_bw = job.get("printer_name_bw", "") or None
    printer_name_color = job.get("printer_name_color", "") or None
    target_printer = printer_name_bw if color == "bw" else printer_name_color

    # ── COUNTER APPROVAL GATE ── online-paid jobs seedha print (paisa aa
    # chuka); sirf counter jobs par owner se pucho
    log(f"📄 Job {job_id}: {color.upper()} | copies={job.get('copies',1)} | "
        f"BW-printer='{printer_name_bw or 'default'}' | Color-printer='{printer_name_color or 'default'}' | "
        f"target='{target_printer or 'DEFAULT PRINTER'}'")

    if job.get("payment_method") == "counter" and approval_enabled():
        update_tray_status("Counter order — approval ka wait")
        ans = ask_approval(job)
        if ans is None:
            log(f"⏸️ Approval window band hui bina jawab ke — job {job_id} baad mein dobara aayega")
            return
        if ans is False:
            log(f"❌ Owner ne DENY kiya — job {job_id} cancel")
            mark_failed(job_id, "Shop owner ne counter order deny kiya")
            return
        log(f"✅ Owner ne approve kiya — job {job_id} print ho raha hai")

    log(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log(f"📄 Job: {job_id}")
    log(f"   File: {fname}")
    log(f"   Pages: {pages} | Copies: {copies} | {color.upper()} | ₹{amount}")
    if selected_pages:
        log(f"   Specific Pages Requested: {selected_pages}")
    if target_printer:
        log(f"   🎯 Target Printer ({color.upper()}): {target_printer}")

    if not url:
        log("❌ File URL nahi!", "ERROR")
        mark_failed(job_id, "No URL")
        return

    filepath = download_file(url, ext)
    if not filepath:
        mark_failed(job_id, "Download failed")
        return

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
                         duplex_on=_dup_on, duplex_mode=_dup_mode, duplex_pages=_dup_pages)

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
        log("🔍 Dependencies check... (.exe mode — sab bundled hai)")
        log("✅ Pillow, win32print, PyPDF2, PyCryptodome, pystray — sab ready (bundled)")
        return

    log("🔍 Dependencies check...")
    try:
        from PIL import Image
        log("✅ Pillow (image→PDF) ready")
    except ImportError:
        log("⚠️  Pillow nahi hai! Installing...", "WARN")
        os.system("pip install Pillow --quiet")
        try:
            from PIL import Image
            log("✅ Pillow install ho gaya!")
        except:
            log("❌ Pillow install nahi hua — JPG/PNG print nahi hoga!", "ERROR")
    try:
        import win32print
        log("✅ win32print ready")
    except ImportError:
        log("⚠️  win32print nahi hai! Run: pip install pywin32", "WARN")
    try:
        from PyPDF2 import PdfReader
        log("✅ PyPDF2 (page range) ready")
    except ImportError:
        log("⚠️  PyPDF2 nahi hai! Installing...", "WARN")
        os.system("pip install PyPDF2 --quiet")
    try:
        import Crypto  # noqa
        log("✅ PyCryptodome (encrypted PDF) ready")
    except ImportError:
        log("⚠️  PyCryptodome nahi hai! Installing...", "WARN")
        os.system("pip install pycryptodome --quiet")
        try:
            import Crypto  # noqa
            log("✅ PyCryptodome install ho gaya!")
        except:
            log("❌ PyCryptodome install nahi hua — kuch PDFs page-extract fail ho sakte hain!", "ERROR")
    try:
        import pystray
        log("✅ pystray (System Tray) ready")
    except ImportError:
        log("⚠️  pystray nahi hai! Installing...", "WARN")
        os.system("pip install pystray --quiet")
        try:
            import pystray
            log("✅ pystray install ho gaya!")
        except:
            log("⚠️  pystray install nahi hua — Tray mode kaam nahi karega, console mode use hoga", "WARN")

# ─── AUTO-UPDATE: Server se check karo naya version hai ya nahi ──────
def get_remote_version():
    """Server se latest agent version number fetch karo"""
    try:
        resp = requests.get(f"{SERVER_URL}/api/agent/version", timeout=15)
        resp.raise_for_status()
        v = resp.json().get("version")
        # Server string bhej de ("7") to int(6) se compare TypeError deta —
        # update silently kabhi trigger nahi hota. Int coerce karo.
        return int(v) if v is not None else None
    except Exception as e:
        log(f"⚠️  Version check failed: {e}", "WARN")
        return None

def download_latest_agent():
    """Naya print_agent.py code download karo server se"""
    try:
        resp = requests.get(f"{SERVER_URL}/api/agent/download-latest", timeout=30)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        log(f"❌ Naya agent download nahi hua: {e}", "ERROR")
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

        log("✅ Naya code install ho gaya! Agent restart ho raha hai...")

        # Khud ko restart karo — naye Python process mein same script chalao.
        # pythonw.exe force karte hain taaki restart ke baad bhi koi console
        # window na khule (chahe yeh process pythonw ya python se shuru hua ho)
        python_exe = sys.executable
        pythonw_exe = python_exe.replace('python.exe', 'pythonw.exe')
        if not os.path.exists(pythonw_exe):
            pythonw_exe = python_exe  # fallback agar pythonw nahi mila

        subprocess.Popen([pythonw_exe, current_file], cwd=os.path.dirname(current_file))

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
        return None, "Server par naya installer upload nahi hua hai (Super Admin ko batao)"
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
        return None, "Download hui file installer nahi lagti (bahut chhoti hai) — installer URL check karo"
    return installer_path, None

def run_installer_and_exit(installer_path):
    log("🔄 Silent update install ho raha hai...")
    subprocess.Popen([installer_path, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
    time.sleep(2)
    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    os._exit(0)

def apply_exe_update_and_restart():
    """Auto-update path (hourly loop) — silent, koi UI nahi."""
    try:
        log("⬇️  Naya installer download ho raha hai...")
        installer_path, err = download_installer()
        if err:
            log(f"❌ {err}", "ERROR")
            return
        log(f"✅ Installer download ho gaya: {installer_path}")
        run_installer_and_exit(installer_path)
    except Exception as e:
        log(f"❌ .exe update apply karne mein error: {e}", "ERROR")

# ─── MANUAL UPDATE CHECK (tray menu se) ──────────────────────────────
# Auto-loop errors chupchaap kha jata hai — yeh window sab kuch DIKHATI
# hai: server ka version, download %, aur exact error. Har shop par bina
# logs khole update-problem diagnose ho jati hai.
def manual_update_check(icon=None, item=None):
    threading.Thread(target=_manual_update_ui, daemon=True).start()

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

        title = tk.Label(frame, text="🔍 Update check ho raha hai...",
                         font=('Segoe UI', 12, 'bold'), bg='white')
        title.pack(pady=(22, 4))
        sub = tk.Label(frame, text=f"Abhi installed: v{VERSION}",
                       font=('Segoe UI', 10), bg='white', fg='#666')
        sub.pack()
        bar = ttk.Progressbar(frame, length=300, mode='determinate')
        pct_lbl = tk.Label(frame, text="", font=('Segoe UI', 10, 'bold'), bg='white')
        close_btn = tk.Button(frame, text="Band Karo", font=('Segoe UI', 10),
                              command=root.destroy)
        root.update()

        # 1) Version check
        remote = get_remote_version()
        if remote is None:
            title.config(text="⚠️ Server se version nahi mila")
            sub.config(text="Internet ya server check karo, phir dobara try karo")
            close_btn.pack(pady=14)
            root.mainloop()
            return
        if remote <= VERSION:
            title.config(text="✅ Aapke paas latest version hai")
            sub.config(text=f"Installed v{VERSION} = Server v{remote}")
            close_btn.pack(pady=14)
            root.mainloop()
            return

        # 2) Naya version mila — download with %
        title.config(text=f"🔄 Naya version mila: v{VERSION} → v{remote}")
        sub.config(text="Download ho raha hai...")
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
        title.config(text=f"✅ v{remote} install ho raha hai...")
        sub.config(text="Agent khud restart hoga — tray mein naya version dikhega")
        root.update()
        time.sleep(1.5)
        root.destroy()
        run_installer_and_exit(installer_path)
    except Exception as e:
        log(f"❌ Manual update UI error: {e}", "ERROR")
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None,
                f"Update check error: {e}", "QR Se Print", 0x10)
        except Exception:
            pass

def update_checker_loop():
    """Background thread — har UPDATE_CHECK_INTERVAL seconds mein naya version check karta hai"""
    # Pehla check thoda delay se — taaki agent properly start ho jaye pehle
    time.sleep(30)
    while agent_state["running"]:
        try:
            remote_version = get_remote_version()
            if remote_version is not None and remote_version > VERSION:
                log(f"🔄 Naya version mila: v{remote_version} (abhi v{VERSION} chal raha hai)")
                update_tray_status(f"Updating to v{remote_version}...")

                if is_running_as_exe():
                    # .exe mode — seedha naya installer download/run karo
                    apply_update_and_restart()
                else:
                    # Source (.py) mode — purana flow: naya .py code download karke replace karo
                    new_code = download_latest_agent()
                    if new_code:
                        apply_update_and_restart(new_code)
                    else:
                        log("⚠️  Update download fail hua, agle check mein phir try karenge", "WARN")
        except Exception as e:
            log(f"⚠️  Update checker error: {e}", "WARN")
        time.sleep(UPDATE_CHECK_INTERVAL)

# ─── SYSTEM TRAY ───────────────────────────────────────────────────
def update_tray_status(status_text):
    """Tray icon ka tooltip/status update karo"""
    agent_state["status"] = status_text
    if agent_state["tray_icon"]:
        try:
            agent_state["tray_icon"].title = f"QR Se Print — {status_text}"
        except Exception:
            pass

def create_tray_icon_image():
    """Simple printer-jaisa chhota icon banate hain (Pillow se draw karke)"""
    from PIL import Image, ImageDraw
    img = Image.new('RGB', (64, 64), color=(10, 10, 15))
    draw = ImageDraw.Draw(img)
    # Simple printer shape: body + paper
    draw.rectangle([12, 24, 52, 44], fill=(255, 77, 28))   # printer body
    draw.rectangle([20, 10, 44, 26], fill=(255, 255, 255)) # paper
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
            log("Log file abhi tak nahi bani")
    except Exception as e:
        log(f"Logs open karne mein error: {e}", "ERROR")

def change_shop_id(icon=None, item=None):
    """
    Tray se 'Shop ID Change Karo' click karne par config file delete karo
    aur agent ko restart karo — restart hote hi naya Shop ID popup khulega.
    """
    log("🔄 Shop ID change request — agent restart ho raha hai...")
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
            subprocess.Popen([sys.executable])
        else:
            python_exe = sys.executable
            pythonw_exe = python_exe.replace('python.exe', 'pythonw.exe')
            if not os.path.exists(pythonw_exe):
                pythonw_exe = python_exe
            subprocess.Popen([pythonw_exe, os.path.abspath(__file__)])
    except Exception as e:
        log(f"Restart error: {e}", "ERROR")

    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    os._exit(0)

def quit_agent(icon=None, item=None):
    """Tray se 'Exit' click karne par agent ko gracefully band karo"""
    log("👋 Tray se Exit dabaya gaya — agent band ho raha hai...")
    agent_state["running"] = False
    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    os._exit(0)

def run_tray_icon():
    """
    System Tray icon start karo. Yeh function tray ke event-loop mein
    block ho jaata hai — isliye print-checking loop ko alag thread mein chalate hain.
    """
    try:
        import pystray
        from pystray import MenuItem as Item

        def status_label(item):
            return f"Status: {agent_state['status']}"

        def shop_label(item):
            return f"Shop: {SHOP_ID}"

        def printer_label(item):
            return f"Printer: {agent_state['printer']}"

        def version_label(item):
            return f"Version: v{VERSION}"

        menu = pystray.Menu(
            Item(status_label, None, enabled=False),
            Item(shop_label, None, enabled=False),
            Item(printer_label, None, enabled=False),
            Item(version_label, None, enabled=False),
            pystray.Menu.SEPARATOR,
            Item(lambda item: f"🔔 Counter Approval: {'ON' if approval_enabled() else 'OFF'}", toggle_approval),
            Item("📋 Logs Dekho", open_logs),
            Item("⬆️ Check for Update", manual_update_check),
            Item("🔄 Shop ID Change Karo", change_shop_id),
            Item("❌ Exit", quit_agent),
        )

        icon_image = create_tray_icon_image()
        icon = pystray.Icon("qr_se_print", icon_image, "QR Se Print — Starting...", menu)
        agent_state["tray_icon"] = icon
        icon.run()
    except ImportError:
        log("⚠️  pystray/Pillow nahi hai — tray mode disable, normal console mode mein chal raha hai", "WARN")
        log("    Install karne ke liye: pip install pystray Pillow", "WARN")
    except Exception as e:
        log(f"❌ Tray icon start nahi hua: {e}", "ERROR")

# ─── MAIN PRINT LOOP (background thread mein chalta hai jab tray active ho) ──
def print_loop():
    log("=" * 50)
    log(f"Har {CHECK_INTERVAL}s mein print jobs check ho raha hai...")
    log("=" * 50)
    update_tray_status("Running — waiting for jobs")

    errors = 0
    check_count = 0

    while agent_state["running"]:
        try:
            jobs = get_pending_jobs()
            check_count += 1
            if jobs:
                log(f"📬 {len(jobs)} naya job!")
                update_tray_status(f"Printing {len(jobs)} job(s)...")
                for job in jobs:
                    process_job(job)
                errors = 0
                update_tray_status("Running — waiting for jobs")
            else:
                if check_count % 60 == 0:
                    log(f"👀 Waiting... ({check_count * CHECK_INTERVAL // 60} min)")
            time.sleep(CHECK_INTERVAL)
        except KeyboardInterrupt:
            log("\n👋 Band ho raha hai...")
            break
        except Exception as e:
            errors += 1
            log(f"❌ Error: {e}", "ERROR")
            update_tray_status("Error — retrying")
            if errors > 10:
                time.sleep(60)
                errors = 0
            else:
                time.sleep(CHECK_INTERVAL)

def main():
    show_banner()
    check_dependencies()

    log(f"🚀 Agent start | Shop: {SHOP_ID} | Version: v{VERSION}")
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
    # error ke. Isi wajah se "kabhi-kabhi tray se gayab ho jaata hai" wala
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
        log(f"⏳ Printer abhi ready nahi hai, {retry_count}/6 retry mein 10 sec wait kar rahe hain...", "WARN")
        time.sleep(10)
        printer_ok, printer_name = check_printer()

    if not printer_ok:
        log("⚠️  Printer abhi bhi nahi mila — tray icon phir bhi chalu rakhte hain, "
            "background mein print_loop printer ko dobara try karta rahega", "WARN")
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

    # Auto-update checker background thread mein chalao
    update_thread = threading.Thread(target=update_checker_loop, daemon=True)
    update_thread.start()
    log(f"🔄 Auto-update checker active (har {UPDATE_CHECK_INTERVAL//60} min check karega)")

    # Print loop bhi background thread mein chalao — taaki tray icon
    # foreground mein chal sake (yeh OS requirement hai tray icons ke liye)
    print_thread = threading.Thread(target=print_loop, daemon=True)
    print_thread.start()

    # Tray icon start karo (yeh block karega jab tak Exit na dabaya jaye)
    try:
        run_tray_icon()
    except Exception as trayErr:
        log(f"⚠️  Tray icon error: {trayErr}", "WARN")

    # Agar tray fail ho jaye (pystray missing), normal console mode mein chalte raho
    if agent_state["tray_icon"] is None:
        log("ℹ️  Console mode mein chal raha hai (Ctrl+C se band karo)")
        log("=" * 50)
        try:
            while agent_state["running"]:
                time.sleep(1)
        except KeyboardInterrupt:
            log("\n👋 Band ho raha hai...")
            agent_state["running"] = False

if __name__ == "__main__":
    # CRITICAL FIX: poora main() ab try/except mein wrapped hai. Pehle agar
    # kahin bhi koi unexpected exception aati (kisi bhi function se), poora
    # process SILENTLY CRASH ho jaata — tray se gayab ho jaata bina kisi
    # trace ke. Ab har crash LOG_FILE mein likha jaata hai, taaki Tray menu
    # ke "📋 Logs Dekho" se customer/owner asal wajah dekh sake.
    try:
        main()
    except Exception as fatalErr:
        try:
            log(f"💥 FATAL CRASH: {fatalErr}", "ERROR")
            import traceback
            log(traceback.format_exc(), "ERROR")
        except Exception:
            pass  # agar logging bhi fail ho jaaye, kam se kam process clean exit kare
