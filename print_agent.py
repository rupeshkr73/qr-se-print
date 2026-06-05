import requests
import time
import os
import sys
import base64
import tempfile
import subprocess
from datetime import datetime
from pathlib import Path

SHOP_ID = "SHOP_90781A5C"
SERVER_URL = "https://qr-se-print.onrender.com"
CHECK_INTERVAL = 5
LOG_FILE = "print_agent_log.txt"
VERSION = "3.0.0"

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
        printers = win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)
        if printers:
            default = win32print.GetDefaultPrinter()
            log(f"✅ Printer ready: {default}")
            return True, default
        else:
            log("❌ Koi printer nahi mila!", "ERROR")
            return False, None
    except ImportError:
        log("⚠️  Mock mode", "WARN")
        return True, "MockPrinter"
    except Exception as e:
        log(f"❌ Printer error: {e}", "ERROR")
        return False, None

def save_file_from_base64(file_data, ext):
    try:
        suffix = f".{ext}" if ext else ".pdf"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(base64.b64decode(file_data))
        tmp.close()
        return tmp.name
    except Exception as e:
        log(f"❌ File save error: {e}", "ERROR")
        return None

def print_file(filepath, copies=1, color_mode="bw"):
    ext = Path(filepath).suffix.lower()
    log(f"🖨️  Printing: {filepath} | {copies} copies | {color_mode}")
    try:
        if ext == ".pdf":
            return print_pdf(filepath, copies)
        elif ext in [".jpg",".jpeg",".png",".bmp"]:
            return print_image(filepath, copies)
        elif ext in [".doc",".docx"]:
            return print_word(filepath, copies)
        else:
            return print_pdf(filepath, copies)
    except Exception as e:
        log(f"❌ Print error: {e}", "ERROR")
        return False

def print_pdf(filepath, copies=1):
    sumatra_paths = [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
        os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
    ]
    for sumatra in sumatra_paths:
        if os.path.exists(sumatra):
            cmd = [sumatra, "-print-to-default", "-silent", "-print-settings", f"copies={copies}", filepath]
            result = subprocess.run(cmd, timeout=60)
            if result.returncode == 0:
                log("✅ SumatraPDF se print hua!")
                return True
    try:
        os.startfile(filepath, "print")
        log("✅ Windows shell se print hua!")
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
    except:
        try:
            os.startfile(filepath, "print")
            return True
        except:
            return False

def get_pending_jobs():
    try:
        resp = requests.get(f"{SERVER_URL}/api/jobs/pending/{SHOP_ID}", timeout=15)
        resp.raise_for_status()
        return resp.json().get("jobs", [])
    except requests.ConnectionError:
        log("⚠️  Server connect nahi hua...", "WARN")
        return []
    except Exception as e:
        log(f"❌ Jobs fetch error: {e}", "ERROR")
        return []

def mark_complete(job_id):
    try:
        requests.post(f"{SERVER_URL}/api/jobs/complete/{job_id}", timeout=10)
        log(f"✅ Job {job_id} complete!")
    except Exception as e:
        log(f"❌ Complete mark failed: {e}", "ERROR")

def mark_failed(job_id, reason=""):
    try:
        requests.post(f"{SERVER_URL}/api/jobs/failed/{job_id}", json={"reason":reason}, timeout=10)
    except:
        pass

def process_job(job):
    job_id = job.get("id","unknown")
    file_data = job.get("file_data")
    copies = job.get("copies", 1)
    color = job.get("color_mode","bw")
    ext = job.get("file_type","pdf")
    fname = job.get("file_name", f"print.{ext}")

    log(f"📄 Job: {job_id} | {fname} | {copies} copies | {color.upper()}")

    if not file_data:
        log(f"❌ File data nahi hai!", "ERROR")
        mark_failed(job_id, "No file data")
        return

    filepath = save_file_from_base64(file_data, ext)
    if not filepath:
        mark_failed(job_id, "File save failed")
        return

    success = print_file(filepath, copies, color)

    try:
        time.sleep(3)
        os.unlink(filepath)
    except:
        pass

    if success:
        mark_complete(job_id)
        log(f"🎉 Job {job_id} print ho gaya!")
    else:
        mark_failed(job_id, "Print failed")

def main():
    show_banner()
    log(f"🚀 Agent start | Shop: {SHOP_ID}")
    log(f"🌐 Server: {SERVER_URL}")

    printer_ok, printer_name = check_printer()
    if not printer_ok:
        log("❌ Printer nahi mila!", "ERROR")
        input("Enter dabao...")
        sys.exit(1)

    log(f"✅ Ready! Printer: {printer_name}")
    log("=" * 50)
    log(f"Har {CHECK_INTERVAL} second mein check ho raha hai...")
    log("Band karne ke liye Ctrl+C dabao")
    log("=" * 50)

    errors = 0
    check_count = 0

    while True:
        try:
            jobs = get_pending_jobs()
            check_count += 1
            if jobs:
                log(f"📬 {len(jobs)} naya job!")
                for job in jobs:
                    process_job(job)
                errors = 0
            else:
                if check_count % 60 == 0:
                    log(f"👀 Waiting... ({check_count} checks)")
            time.sleep(CHECK_INTERVAL)
        except KeyboardInterrupt:
            log("\n👋 Agent band ho raha hai...")
            break
        except Exception as e:
            errors += 1
            log(f"❌ Error: {e}", "ERROR")
            if errors > 10:
                time.sleep(60)
                errors = 0
            else:
                time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    main()
