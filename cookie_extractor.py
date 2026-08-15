import os
import sys
import glob
import json
import base64
import sqlite3
import shutil
import tempfile
from typing import Dict, Optional, Tuple, List

# Попытка импорта Windows DPAPI для расшифровки ключей Chromium
try:
    import win32crypt
except ImportError:
    win32crypt = None

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    AESGCM = None


class BrowserCookieExtractor:
    """
    Автоматически извлекает куки DMarket из установленных на Windows браузеров:
    Chrome, Edge, Brave, Opera, Opera GX, Firefox, Vivaldi.
    """

    @staticmethod
    def get_local_appdata() -> str:
        return os.environ.get("LOCALAPPDATA", "")

    @staticmethod
    def get_appdata() -> str:
        return os.environ.get("APPDATA", "")

    @classmethod
    def get_chromium_browsers(cls) -> List[Dict[str, str]]:
        local = cls.get_local_appdata()
        roaming = cls.get_appdata()

        browsers = [
            {
                "name": "Google Chrome",
                "user_data": os.path.join(local, "Google", "Chrome", "User Data"),
                "type": "chromium"
            },
            {
                "name": "Microsoft Edge",
                "user_data": os.path.join(local, "Microsoft", "Edge", "User Data"),
                "type": "chromium"
            },
            {
                "name": "Brave",
                "user_data": os.path.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
                "type": "chromium"
            },
            {
                "name": "Opera Stable",
                "user_data": os.path.join(roaming, "Opera Software", "Opera Stable"),
                "type": "chromium_opera"
            },
            {
                "name": "Opera GX",
                "user_data": os.path.join(roaming, "Opera Software", "Opera GX Stable"),
                "type": "chromium_opera"
            },
            {
                "name": "Vivaldi",
                "user_data": os.path.join(local, "Vivaldi", "User Data"),
                "type": "chromium"
            }
        ]
        return [b for b in browsers if os.path.exists(b["user_data"])]

    @classmethod
    def get_firefox_profiles(cls) -> List[str]:
        roaming = cls.get_appdata()
        firefox_dir = os.path.join(roaming, "Mozilla", "Firefox", "Profiles")
        if not os.path.exists(firefox_dir):
            return []
        profiles = []
        for p in glob.glob(os.path.join(firefox_dir, "*")):
            cookie_db = os.path.join(p, "cookies.sqlite")
            if os.path.exists(cookie_db):
                profiles.append(cookie_db)
        return profiles

    @classmethod
    def _get_chromium_master_key(cls, user_data_path: str) -> Optional[bytes]:
        local_state_path = os.path.join(user_data_path, "Local State")
        if not os.path.exists(local_state_path):
            return None

        try:
            with open(local_state_path, "r", encoding="utf-8") as f:
                local_state = json.load(f)

            encrypted_key = local_state.get("os_crypt", {}).get("encrypted_key")
            if not encrypted_key:
                return None

            encrypted_key_bytes = base64.b64decode(encrypted_key)
            # Убираем префикс DPAPI (первые 5 байт 'DPAPI')
            if encrypted_key_bytes.startswith(b"DPAPI"):
                encrypted_key_bytes = encrypted_key_bytes[5:]

            if win32crypt:
                master_key = win32crypt.CryptUnprotectData(encrypted_key_bytes, None, None, None, 0)[1]
                return master_key
            else:
                # Фоллбек через powershell если win32crypt не установлен
                return cls._decrypt_dpapi_powershell(encrypted_key_bytes)
        except Exception:
            return None

    @classmethod
    def _decrypt_dpapi_powershell(cls, encrypted_bytes: bytes) -> Optional[bytes]:
        try:
            import subprocess
            b64_in = base64.b64encode(encrypted_bytes).decode("ascii")
            ps_script = (
                f"$bytes = [Convert]::FromBase64String('{b64_in}');"
                f"Add-Type -AssemblyName System.Security;"
                f"$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);"
                f"[Convert]::ToBase64String($dec)"
            )
            res = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
                capture_output=True, text=True, timeout=5
            )
            if res.returncode == 0 and res.stdout.strip():
                return base64.b64decode(res.stdout.strip())
        except Exception:
            pass
        return None

    @classmethod
    def _decrypt_chromium_cookie_value(cls, encrypted_value: bytes, master_key: Optional[bytes]) -> str:
        if not encrypted_value:
            return ""

        # Префикс v10 или v11 (AES-256-GCM)
        if encrypted_value[:3] in (b"v10", b"v11"):
            if not master_key or not AESGCM:
                return ""
            try:
                nonce = encrypted_value[3:15]
                ciphertext = encrypted_value[15:]
                aesgcm = AESGCM(master_key)
                decrypted = aesgcm.decrypt(nonce, ciphertext, None)
                return decrypted.decode("utf-8", errors="ignore")
            except Exception:
                return ""

        # Старый DPAPI формат
        try:
            if win32crypt:
                decrypted = win32crypt.CryptUnprotectData(encrypted_value, None, None, None, 0)[1]
                return decrypted.decode("utf-8", errors="ignore")
            else:
                dec = cls._decrypt_dpapi_powershell(encrypted_value)
                if dec:
                    return dec.decode("utf-8", errors="ignore")
        except Exception:
            pass

        return ""

    @classmethod
    def extract_from_chromium_profile(cls, db_path: str, master_key: Optional[bytes]) -> Dict[str, str]:
        cookies = {}
        if not os.path.exists(db_path):
            return cookies

        # Копируем файл во временную директорию, чтобы избежать блокировки запущенным браузером
        temp_dir = tempfile.mkdtemp()
        temp_db = os.path.join(temp_dir, "Cookies.tmp")
        try:
            shutil.copy2(db_path, temp_db)
            conn = sqlite3.connect(temp_db)
            cursor = conn.cursor()
            query = "SELECT host_key, name, value, encrypted_value FROM cookies WHERE host_key LIKE '%dmarket.com%'"
            cursor.execute(query)

            for host_key, name, value, enc_val in cursor.fetchall():
                if value:
                    cookies[name] = value
                elif enc_val:
                    dec = cls._decrypt_chromium_cookie_value(enc_val, master_key)
                    if dec:
                        cookies[name] = dec
            conn.close()
        except Exception:
            pass
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

        return cookies

    @classmethod
    def extract_from_firefox(cls, db_path: str) -> Dict[str, str]:
        cookies = {}
        if not os.path.exists(db_path):
            return cookies

        temp_dir = tempfile.mkdtemp()
        temp_db = os.path.join(temp_dir, "cookies.tmp")
        try:
            shutil.copy2(db_path, temp_db)
            conn = sqlite3.connect(temp_db)
            cursor = conn.cursor()
            cursor.execute("SELECT name, value FROM moz_cookies WHERE host LIKE '%dmarket.com%'")
            for name, value in cursor.fetchall():
                if name and value:
                    cookies[name] = value
            conn.close()
        except Exception:
            pass
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

        return cookies

    @classmethod
    def auto_detect_dmarket_cookies(cls) -> Tuple[Dict[str, str], str, str]:
        """
        Ищет куки DMarket во всех браузерах.
        Возвращает: (cookies_dict, cookie_header_str, browser_name)
        """
        # 1. Проверяем Chromium браузеры
        for b in cls.get_chromium_browsers():
            user_data = b["user_data"]
            master_key = cls._get_chromium_master_key(user_data)

            # Проверяем Default и профили (Profile 1, Profile 2, etc.)
            search_paths = []
            if b["type"] == "chromium_opera":
                search_paths.append(os.path.join(user_data, "Network", "Cookies"))
                search_paths.append(os.path.join(user_data, "Cookies"))
            else:
                search_paths.append(os.path.join(user_data, "Default", "Network", "Cookies"))
                search_paths.append(os.path.join(user_data, "Default", "Cookies"))
                for prof in glob.glob(os.path.join(user_data, "Profile *")):
                    search_paths.append(os.path.join(prof, "Network", "Cookies"))
                    search_paths.append(os.path.join(prof, "Cookies"))

            for db_path in search_paths:
                if os.path.exists(db_path):
                    cookies = cls.extract_from_chromium_profile(db_path, master_key)
                    # Проверяем наличие ключевых авторизационных кук DMarket
                    if cookies:
                        cookie_str = "; ".join([f"{k}={v}" for k, v in cookies.items()])
                        return cookies, cookie_str, b["name"]

        # 2. Проверяем Firefox
        for ff_db in cls.get_firefox_profiles():
            cookies = cls.extract_from_firefox(ff_db)
            if cookies:
                cookie_str = "; ".join([f"{k}={v}" for k, v in cookies.items()])
                return cookies, cookie_str, "Mozilla Firefox"

        return {}, "", ""


def parse_cookie_string(raw_cookie: str) -> Dict[str, str]:
    """Парсит строку заголовка Cookie в словарь."""
    cookies = {}
    if not raw_cookie:
        return cookies

    parts = raw_cookie.strip().split(";")
    for part in parts:
        if "=" in part:
            k, v = part.strip().split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies
