import subprocess
import sys
import webbrowser
import time

if __name__ == "__main__":
    print("[*] Запуск DMarket Float Rank Tracker (dm-tracker2)...")
    proc = subprocess.Popen([sys.executable, "app.py"])
    time.sleep(1.5)
    webbrowser.open("http://127.0.0.1:5001")
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
