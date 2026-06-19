"""
QR Se Print - Local Agent v5.1
Fix: Chhote size documents bhi A4 page mein properly fit/scale hote hain print karte waqt
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
SHOP_ID         = "AAPKA_SHOP_ID"   # Apna Shop ID daalo
SERVER_URL      = "https://qr-se-print.onrender.com"
CHECK_INTERVAL  = 5
LOG_FILE        = "print_agent_log.txt"
VERSION         = "5.1.0"
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
║  ✅ Image→PDF  ✅ B&W/Color  ✅ Auto Fit-A4  ║
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
    Chhota photo ho to A4 page ke center mein zoom karke fit karte hain
    taaki print A4 jaisa bada aaye, chhota corner mein na rahe.
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

        # Create a full white A4 canvas
        a4_canvas = Image.new('RGB', (a4_width_px, a4_height_px), (255, 255, 255))

        # Image ko A4 canvas ke andar MAXIMUM size mein fit karo (zoom karke)
        # taaki chhota image bhi bada print ho, chhota corner mein na rahe
        img_ratio = img.width / img.height
        a4_ratio = a4_width_px / a4_height_px

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
        log(f"✅ A4 PDF ready: {pdf_path} ({new_width}x{new_height} fitted on {a4_width_px}x{a4_height_px})")
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
    """
    if not selected_pages_str or not selected_pages_str.strip():
        return pdf_path  # All pages — kuch nahi karna

    try:
        from PyPDF2 import PdfReader, PdfWriter
    except ImportError:
        try:
            from pypdf import PdfReader, PdfWriter
        except ImportError:
            log("⚠️  PyPDF2/pypdf nahi hai! Sab pages print honge.", "WARN")
            os.system("pip install PyPDF2 --quiet")
            try:
                from PyPDF2 import PdfReader, PdfWriter
            except:
                return pdf_path

    try:
        page_numbers = [int(p.strip()) for p in selected_pages_str.split(',') if p.strip()]
        if not page_numbers:
            return pdf_path

        log(f"📑 Specific pages extract ho rahe hain: {page_numbers}")

        reader = PdfReader(pdf_path)
        writer = PdfWriter()
        total_pdf_pages = len(reader.pages)

        for pnum in page_numbers:
            idx = pnum - 1  # 1-indexed se 0-indexed
            if 0 <= idx < total_pdf_pages:
                writer.add_page(reader.pages[idx])
            else:
                log(f"⚠️  Page {pnum} PDF mein nahi hai (PDF mein {total_pdf_pages} pages hain)", "WARN")

        if len(writer.pages) == 0:
            log("⚠️  Koi valid page nahi mila, original PDF print hoga", "WARN")
            return pdf_path

        extracted_path = pdf_path + '_extracted.pdf'
        with open(extracted_path, 'wb') as f:
            writer.write(f)

        log(f"✅ {len(writer.pages)} page(s) extract ho gaye: {extracted_path}")
        return extracted_path

    except Exception as e:
        log(f"❌ Page extract error: {e} — original PDF print hoga", "ERROR")
        return pdf_path

# ─── Problem 5: B&W / Color Print + Fit-to-A4 ────────────────────────
def print_pdf_sumatra(filepath, copies=1, color_mode="bw"):
    """
    SumatraPDF se print — B&W/Color setting ke saath
    'fit' flag use karte hain taaki chhota PDF/page bhi A4 paper
    ke hisaab se properly scale ho jaye, corner mein chhota na rahe.
    """
    sumatra_paths = [
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
                log(f"✅ SumatraPDF print success! ({color_mode.upper()}, fit-to-page)")
                return True
            else:
                err = result.stderr.decode(errors='ignore') if result.stderr else ''
                log(f"⚠️  SumatraPDF error: {err}", "WARN")

    # Fallback
    log("⚠️  SumatraPDF nahi mila, Windows shell se try kar raha hai...", "WARN")
    try:
        os.startfile(filepath, "print")
        time.sleep(5)
        log("✅ Windows shell se print hua (fit/B&W setting apply nahi hogi)")
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

def print_file(filepath, copies=1, color_mode="bw", selected_pages=""):
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
                print_path = extracted_pdf
        elif ext in ['.doc', '.docx']:
            return print_word(filepath, copies, color_mode)
        else:
            print_path = filepath

        # PDF print karo with fit-to-page (image bhi ab already A4-fitted PDF hai)
        success = print_pdf_sumatra(print_path, copies, color_mode)
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
    selected_pages = job.get("selected_pages", "")

    log(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log(f"📄 Job: {job_id}")
    log(f"   File: {fname}")
    log(f"   Pages: {pages} | Copies: {copies} | {color.upper()} | ₹{amount}")
    if selected_pages:
        log(f"   Specific Pages Requested: {selected_pages}")

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

    success = print_file(filepath, copies, color, selected_pages)

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
