"""
QR Se Print - Local Print Agent
Windows 10/11 ke liye
Payment hone ke baad automatically print karta hai
"""

import requests
import time
import os
import sys
import json
import tempfile
import subprocess
from datetime import datetime
from pathlib import Path

# ============================================================
#  ⚙️  YAHAN APNI SETTINGS DAALO
# ============================================================
SHOP_ID    = "AAPKA_SHOP_ID"        # Dashboard se Shop ID copy karo
SERVER_URL = "https://qr-se-print-production.up.railway.app"
CHECK_INTERVAL = 5                   # Har 5 second mein check
LOG_FILE   = "print_agent_log.txt"
# ============================================================

VERSION = "2.0.0"

def log(msg, level="INFO"):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] [{level}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except:
        pass

def show_banner():
    print("""
╔══════════════════════════════════════════════╗
║         QR Se Print - Local Agent            ║
║              Version """ + VERSION + """                   ║
║     Payment hone ke baad auto print!         ║
╚══════════════════════════════════════════════╝
    """)

def check_printer():
    try:
        import win32print
        printers = win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        )
        if printers:
            default = win32print.GetDefaultPrinter()
            log(f"✅ Printer ready: {default}")
            return True, default
        else:
            log("❌ Koi printer nahi mila!", "ERROR")
            return False, None
    except ImportError:
        log("⚠️  win32print nahi hai — mock mode chal raha hai", "WARN")
        return True, "MockPrinter"
    except Exception as e:
        log(f"❌ Printer error: {e}", "ERROR")
        return False, None

def download_file(url, ext):
    try:
        log(f"⬇️  File download: {url}")
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        suffix = f".{ext}" if ext else ".pdf"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(response.content)
        tmp.close()
        log(f"✅ File downloaded: {tmp.name}")
        return tmp.name
    except Exception as e:
        log(f"❌ Download failed: {e}", "ERROR")
        return None

def print_file(filepath, copies=1, color_mode="bw"):
    ext = Path(filepath).suffix.lower()
    log(f"🖨️  Printing: {filepath} | Copies: {copies} | Mode: {color_mode}")
    try:
        if ext == ".pdf":
            return print_pdf(filepath, copies)
        elif ext in [".jpg", ".jpeg", ".png", ".bmp"]:
            return print_image(filepath, copies)
        elif ext in [".doc", ".docx"]:
            return print_word(filepath, copies)
        else:
            return print_pdf(filepath, copies)
    except Exception as e:
        log(f"❌ Print error: {e}", "ERROR")
        return False

def print_pdf(filepath, copies=1):
    # SumatraPDF paths
    sumatra_paths = [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
        os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
    ]
    for sumatra in sumatra_paths:
        if os.path.exists(sumatra):
            cmd = [sumatra, "-print-to-default", "-silent",
                   "-print-settings", f"copies={copies}", filepath]
            result = subprocess.run(cmd, timeout=60)
            if result.returncode == 0:
                log(f"✅ SumatraPDF se print hua!")
                return True

    # Adobe Reader
    adobe_paths = [
        r"C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe",
        r"C:\Program Files (x86)\Adobe\Acrobat Reader DC\Reader\AcroRd32.exe",
        r"C:\Program Files\Adobe\Acrobat Reader DC\Reader\AcroRd32.exe",
    ]
    for adobe in adobe_paths:
        if os.path.exists(adobe):
            subprocess.Popen([adobe, "/t", filepath])
            time.sleep(5)
            log(f"✅ Adobe Reader se print hua!")
            return True

    # Windows shell fallback
    try:
        os.startfile(filepath, "print")
        log(f"✅ Windows shell se print hua!")
        return True
    except Exception as e:
        log(f"❌ Print failed: {e}", "ERROR")
        return False

def print_image(filepath, copies=1):
    try:
        import win32api
        for _ in range(copies):
            win32api.ShellExecute(0, "print", filepath, None, ".", 0)
            time.sleep(2)
        log("✅ Image print hua!")
        return True
    except:
        try:
            os.startfile(filepath, "print")
            return True
        except Exception as e:
            log(f"❌ Image print failed: {e}", "ERROR")
            return False

def print_word(filepath, copies=1):
    try:
        import win32com.client
        word = win32com.client.Dispatch("Word.Application")
        word.Visible = False
        doc = word.Documents.Open(os.path.abspath(filepath))
        doc.PrintOut(Copies=copies)
        time.sleep(5)
        doc.Close(False)
        word.Quit()
        log("✅ Word print hua!")
        return True
    except Exception as e:
        log(f"⚠️  Word COM failed: {e}", "WARN")
        try:
            os.startfile(filepath, "print")
            return True
        except:
            return False

def get_pending_jobs():
    try:
        url = f"{SERVER_URL}/api/jobs/pending/{SHOP_ID}"
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json().get("jobs", [])
    except requests.ConnectionError:
        log("⚠️  Server se connect nahi hua, retry...", "WARN")
        return []
    except Exception as e:
        log(f"❌ Jobs fetch error: {e}", "ERROR")
        return []

def mark_complete(job_id):
    try:
        requests.post(f"{SERVER_URL}/api/jobs/complete/{job_id}", timeout=10)
        log(f"✅ Job {job_id} complete mark hua!")
    except Exception as e:
        log(f"❌ Complete mark failed: {e}", "ERROR")

def mark_failed(job_id, reason=""):
    try:
        requests.post(f"{SERVER_URL}/api/jobs/failed/{job_id}",
                     json={"reason": reason}, timeout=10)
    except:
        pass

def process_job(job):
    job_id  = job.get("id", "unknown")
    file_url = job.get("file_url")
    copies  = job.get("copies", 1)
    color   = job.get("color_mode", "bw")
    ext     = job.get("file_type", "pdf")
    fname   = job.get("file_name", f"print.{ext}")

    log(f"📄 Naya Job: {job_id} | {fname} | {copies} copies | {color.upper()}")

    if not file_url:
        log(f"❌ File URL nahi hai job {job_id}", "ERROR")
        mark_failed(job_id, "No file URL")
        return

    filepath = download_file(file_url, ext)
    if not filepath:
        mark_failed(job_id, "Download failed")
        return

    success = print_file(filepath, copies, color)

    # Cleanup temp file
    try:
        time.sleep(3)
        os.unlink(filepath)
    except:
        pass

    if success:
        mark_complete(job_id)
        log(f"🎉 Job {job_id} successfully print hua!")
    else:
        mark_failed(job_id, "Print failed")
        log(f"❌ Job {job_id} fail hua", "ERROR")

def main():
    show_banner()

    if SHOP_ID == "AAPKA_SHOP_ID":
        print("\n" + "="*50)
        print("⚠️  SHOP ID SET NAHI HAI!")
        print("   1. Dashboard pe jao")
        print("   2. Shop register karo")
        print("   3. Shop ID copy karo")
        print("   4. Is file mein SHOP_ID update karo")
        print("="*50 + "\n")

    log(f"🚀 Agent start | Shop: {SHOP_ID} | Server: {SERVER_URL}")

    printer_ok, printer_name = check_printer()
    if not printer_ok:
        log("❌ Printer nahi mila. Agent band ho raha hai.", "ERROR")
        input("Enter dabao...")
        sys.exit(1)

    log(f"✅ Ready! Printer: {printer_name}")
    log("=" * 50)
    log(f"Har {CHECK_INTERVAL} second mein server check ho raha hai...")
    log("Band karne ke liye Ctrl+C dabao")
    log("=" * 50)

    errors = 0
    check_count = 0

    while True:
        try:
            jobs = get_pending_jobs()
            check_count += 1

            if jobs:
                log(f"📬 {len(jobs)} naya job mila!")
                for job in jobs:
                    process_job(job)
                errors = 0
            else:
                if check_count % 60 == 0:  # Har 5 min ek message
                    log(f"👀 Koi job nahi abhi... ({check_count} checks done)")

            time.sleep(CHECK_INTERVAL)

        except KeyboardInterrupt:
            log("\n👋 Agent band ho raha hai...")
            break
        except Exception as e:
            errors += 1
            log(f"❌ Error: {e}", "ERROR")
            if errors > 10:
                log("⚠️  Zyada errors — 60 sec wait...", "WARN")
                time.sleep(60)
                errors = 0
            else:
                time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    main()
