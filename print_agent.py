import requests
import time
import os
import sys
import tempfile
import subprocess
from datetime import datetime
from pathlib import Path

SHOP_ID = "SHOP_6865E251"
SERVER_URL = "https://qr-se-print.onrender.com"
CHECK_INTERVAL = 5
LOG_FILE = "print_agent_log.txt"
VERSION = "4.0.0"

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
    print(f"""
╔══════════════════════════════════════════════╗
║         QR Se Print - Local Agent            ║
║              Version {VERSION}                  ║
║   Cloudinary → Download → Print → Delete!    ║
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
        log("⚠️  Mock mode", "WARN")
        return True, "MockPrinter"
    except Exception as e:
        log(f"❌ Printer error: {e}", "ERROR")
        return False, None

def download_file(url, ext):
    """Cloudinary se file download karo"""
    try:
        log(f"⬇️  Downloading from Cloudinary...")
        response = requests.get(url, timeout=60)
        response.raise_for_status()
        suffix = f".{ext}" if ext else ".pdf"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(response.content)
        tmp.close()
        log(f"✅ File downloaded: {tmp.name} ({len(response.content)} bytes)")
        return tmp.name
    except Exception as e:
        log(f"❌ Download failed: {e}", "ERROR")
        return None

def print_file(filepath, copies=1, color_mode="bw"):
    ext = Path(filepath).suffix.lower()
    log(f"🖨️  Printing: {os.path.basename(filepath)} | {copies} copies | {color_mode.upper()}")
    try:
        if ext == ".pdf":
            return print_pdf(filepath, copies, color_mode)
        elif ext in [".jpg",".jpeg",".png",".bmp"]:
            return print_image(filepath, copies)
        elif ext in [".doc",".docx"]:
            return print_word(filepath, copies)
        else:
            return print_pdf(filepath, copies, color_mode)
    except Exception as e:
        log(f"❌ Print error: {e}", "ERROR")
        return False

def print_pdf(filepath, copies=1, color_mode="bw"):
    sumatra_paths = [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
        os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
    ]
    
    # Color mode setting
    color_setting = "color" if color_mode == "color" else "monochrome"
    
    for sumatra in sumatra_paths:
        if os.path.exists(sumatra):
            cmd = [
                sumatra,
                "-print-to-default",
                "-silent",
                "-print-settings", f"copies={copies},{color_setting}",
                filepath
            ]
            result = subprocess.run(cmd, timeout=60)
            if result.returncode == 0:
                log(f"✅ SumatraPDF print hua! ({color_mode.upper()})")
                return True

    # Fallback
    try:
        os.startfile(filepath, "print")
        time.sleep(3)
        log(f"✅ Windows shell print hua!")
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
    """Job complete mark karo — server Cloudinary se delete karega"""
    try:
        resp = requests.post(f"{SERVER_URL}/api/jobs/complete/{job_id}", timeout=15)
        log(f"✅ Job {job_id} complete! Cloudinary se file delete ho rahi hai...")
    except Exception as e:
        log(f"❌ Complete mark failed: {e}", "ERROR")

def mark_failed(job_id, reason=""):
    try:
        requests.post(
            f"{SERVER_URL}/api/jobs/failed/{job_id}",
            json={"reason": reason},
            timeout=10
        )
    except:
        pass

def process_job(job):
    job_id   = job.get("id", "unknown")
    file_url = job.get("file_url")
    copies   = job.get("copies", 1)
    color    = job.get("color_mode", "bw")
    ext      = job.get("file_type", "pdf")
    fname    = job.get("file_name", f"print.{ext}")
    pages    = job.get("total_pages", 1)
    amount   = job.get("amount", 0)

    log(f"📄 Job: {job_id}")
    log(f"   File: {fname} | Pages: {pages} | Copies: {copies} | {color.upper()} | ₹{amount}")

    if not file_url:
        log(f"❌ File URL nahi hai!", "ERROR")
        mark_failed(job_id, "No file URL")
        return

    # Cloudinary se download karo
    filepath = download_file(file_url, ext)
    if not filepath:
        mark_failed(job_id, "Download failed")
        return

    # Print karo
    success = print_file(filepath, copies, color)

    # Local temp file delete karo
    try:
        time.sleep(3)
        os.unlink(filepath)
        log(f"🗑️  Local temp file deleted")
    except:
        pass

    if success:
        # Server ko batao — wo Cloudinary se bhi delete karega
        mark_complete(job_id)
        log(f"🎉 Job {job_id} done! File Cloudinary se bhi delete ho gayi!")
    else:
        mark_failed(job_id, "Print failed")
        log(f"❌ Job {job_id} fail hua", "ERROR")

def main():
    show_banner()
    log(f"🚀 Agent start | Shop: {SHOP_ID}")
    log(f"🌐 Server: {SERVER_URL}")
    log(f"☁️  Cloudinary: File print hone ke baad auto-delete!")

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
                    log(f"👀 Waiting... ({check_count * CHECK_INTERVAL // 60} min)")
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
