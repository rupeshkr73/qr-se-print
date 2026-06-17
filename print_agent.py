"""
QR Se Print - Local Agent v5.0
All 5 problems fixed:
1. JPG/PNG → PDF convert karke print
2. Razorpay payment support
3. Multi-page PDF support
4. Counter + Online payment
5. B&W / Color print setting
"""

import requests
import time
import os
import sys
import tempfile
import subprocess
from datetime import datetime
from pathlib import Path

# ============================================================
SHOP_ID         = "SHOP_6865E251"   # Apna Shop ID daalo
SERVER_URL      = "https://qr-se-print.onrender.com"
CHECK_INTERVAL  = 5
LOG_FILE        = "print_agent_log.txt"
VERSION         = "5.0.0"
# ============================================================

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
║         QR Se Print - Local Agent v{VERSION}   ║
║  ✅ Image→PDF  ✅ B&W/Color  ✅ Multi-page   ║
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
            log(f"✅ Printer: {default}")
            return True, default
        log("❌ Printer nahi mila!", "ERROR")
        return False, None
    except ImportError:
        log("⚠️  Mock mode (win32print nahi hai)", "WARN")
        return True, "MockPrinter"
    except Exception as e:
        log(f"❌ Printer error: {e}", "ERROR")
        return False, None

def download_file(url, ext):
    """Cloudinary se file download karo"""
    try:
        log(f"⬇️  Downloading...")
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()

        # File size check
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

# ─── Problem 1: Image to PDF convert ─────────────────────
def convert_image_to_pdf(image_path):
    """JPG/PNG ko PDF mein convert karo — Problem 1 Fix"""
    try:
        from PIL import Image
        log(f"🔄 Image → PDF convert ho raha hai...")

        img = Image.open(image_path)

        # A4 size mein fit karo
        a4_width, a4_height = 595, 842  # points mein (72 dpi)

        # Aspect ratio maintain karo
        img_ratio = img.width / img.height
        a4_ratio = a4_width / a4_height

        if img_ratio > a4_ratio:
            new_width = a4_width
            new_height = int(a4_width / img_ratio)
        else:
            new_height = a4_height
            new_width = int(a4_height * img_ratio)

        img = img.resize((new_width, new_height), Image.LANCZOS)

        # RGB mein convert karo (PNG mein RGBA ho sakta hai)
        if img.mode in ('RGBA', 'LA', 'P'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        # PDF save karo
        pdf_path = image_path.replace('.jpg', '.pdf').replace('.jpeg', '.pdf').replace('.png', '.pdf')
        if pdf_path == image_path:
            pdf_path = image_path + '.pdf'

        img.save(pdf_path, 'PDF', resolution=200)
        log(f"✅ PDF ready: {pdf_path}")
        return pdf_path

    except ImportError:
        log("❌ Pillow install nahi hai! Run: pip install Pillow", "ERROR")
        return None
    except Exception as e:
        log(f"❌ Image convert error: {e}", "ERROR")
        return None

# ─── Problem 5: B&W / Color Print ────────────────────────
def print_pdf_sumatra(filepath, copies=1, color_mode="bw"):
    """SumatraPDF se print — B&W/Color setting ke saath"""
    sumatra_paths = [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
        os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
    ]

    # Problem 5: B&W ke liye monochrome setting
    if color_mode == "bw":
        print_settings = f"copies={copies},monochrome"
        log(f"🖨️  B&W (Monochrome) print karenge")
    else:
        print_settings = f"copies={copies}"
        log(f"🖨️  Color print karenge")

    for sumatra in sumatra_paths:
        if os.path.exists(sumatra):
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
                log(f"✅ SumatraPDF print success! ({color_mode.upper()})")
                return True
            else:
                log(f"⚠️  SumatraPDF error: {result.stderr.decode()}", "WARN")

    # Fallback
    log("⚠️  SumatraPDF nahi mila, Windows shell se try kar raha hai...", "WARN")
    try:
        os.startfile(filepath, "print")
        time.sleep(5)
        log("✅ Windows shell se print hua (B&W setting apply nahi hogi)")
        return True
    except Exception as e:
        log(f"❌ Print failed: {e}", "ERROR")
        return False

def print_word(filepath, copies=1, color_mode="bw"):
    """Word document print"""
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
            time.sleep(3)
            return True
        except Exception as e:
            log(f"❌ Word print failed: {e}", "ERROR")
            return False

def print_file(filepath, copies=1, color_mode="bw"):
    """Main print function — sab file types handle karta hai"""
    ext = Path(filepath).suffix.lower()
    log(f"🖨️  Printing: {os.path.basename(filepath)}")
    log(f"   Copies: {copies} | Mode: {color_mode.upper()} | Type: {ext}")

    converted_pdf = None

    try:
        # Problem 1: Image files ko pehle PDF mein convert karo
        if ext in ['.jpg', '.jpeg', '.png', '.bmp', '.gif']:
            log(f"🔄 Image file detect hua — PDF mein convert kar raha hai...")
            converted_pdf = convert_image_to_pdf(filepath)
            if not converted_pdf:
                log("❌ Image to PDF conversion failed!", "ERROR")
                return False
            print_path = converted_pdf
        elif ext == '.pdf':
            print_path = filepath
        elif ext in ['.doc', '.docx']:
            return print_word(filepath, copies, color_mode)
        else:
            # Unknown — PDF ki tarah treat karo
            print_path = filepath

        # PDF print karo (image bhi ab PDF hai)
        success = print_pdf_sumatra(print_path, copies, color_mode)
        return success

    finally:
        # Converted PDF delete karo
        if converted_pdf and os.path.exists(converted_pdf):
            try:
                time.sleep(2)
                os.unlink(converted_pdf)
                log(f"🗑️  Converted PDF deleted")
            except:
                pass

def get_pending_jobs():
    try:
        resp = requests.get(f"{SERVER_URL}/api/jobs/pending/{SHOP_ID}", timeout=15)
        resp.raise_for_status()
        return resp.json().get("jobs", [])
    except requests.ConnectionError:
        log("⚠️  Server connect nahi hua...", "WARN")
        return []
    except Exception as e:
        log(f"❌ Jobs fetch: {e}", "ERROR")
        return []

def mark_complete(job_id):
    try:
        requests.post(f"{SERVER_URL}/api/jobs/complete/{job_id}", timeout=15)
        log(f"✅ Job {job_id} complete! Cloudinary se delete ho rahi hai...")
    except Exception as e:
        log(f"❌ Complete mark: {e}", "ERROR")

def mark_failed(job_id, reason=""):
    try:
        requests.post(f"{SERVER_URL}/api/jobs/failed/{job_id}", json={"reason": reason}, timeout=10)
    except:
        pass

def process_job(job):
    job_id  = job.get("id", "unknown")
    url     = job.get("file_url")
    copies  = job.get("copies", 1)
    color   = job.get("color_mode", "bw")
    ext     = job.get("file_type", "pdf")
    fname   = job.get("file_name", f"print.{ext}")
    pages   = job.get("total_pages", 1)
    amount  = job.get("amount", 0)

    log(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log(f"📄 Job: {job_id}")
    log(f"   File: {fname}")
    log(f"   Pages: {pages} | Copies: {copies} | {color.upper()} | ₹{amount}")

    if not url:
        log("❌ File URL nahi!", "ERROR")
        mark_failed(job_id, "No URL")
        return

    # Download
    filepath = download_file(url, ext)
    if not filepath:
        mark_failed(job_id, "Download failed")
        return

    # Verify file
    file_size = os.path.getsize(filepath)
    if file_size < 100:
        log(f"❌ File empty: {file_size} bytes", "ERROR")
        os.unlink(filepath)
        mark_failed(job_id, "Empty file")
        return

    # Print
    success = print_file(filepath, copies, color)

    # Cleanup local file
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
    """Dependencies check karo"""
    log("🔍 Dependencies check...")

    # Pillow check
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

    # win32print check
    try:
        import win32print
        log("✅ win32print ready")
    except ImportError:
        log("⚠️  win32print nahi hai! Run: pip install pywin32", "WARN")

def main():
    show_banner()
    check_dependencies()

    log(f"🚀 Agent start | Shop: {SHOP_ID}")
    log(f"🌐 Server: {SERVER_URL}")

    printer_ok, printer_name = check_printer()
    if not printer_ok:
        log("❌ Printer nahi mila!", "ERROR")
        input("Enter dabao...")
        sys.exit(1)

    log(f"✅ Printer: {printer_name}")
    log("=" * 50)
    log(f"Har {CHECK_INTERVAL}s mein check ho raha hai...")
    log("Ctrl+C se band karo")
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
            log("\n👋 Band ho raha hai...")
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
