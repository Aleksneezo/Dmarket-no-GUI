import os
import sys
import time
import threading
import json
import requests
from typing import Dict, Any, List, Optional, Union
from cookie_extractor import BrowserCookieExtractor, parse_cookie_string


class RateLimitException(Exception):
    def __init__(self, marketplace: str = "DMarket"):
        super().__init__(f"Rate Limit exceeded on {marketplace}")


class DMarketWebClient:
    """
    Чистый браузерный клиент DMarket (Browser Native Web Client).
    Работает через веб-сессии, Cookies и JWT-токены без API-ключей.
    Полностью совместим с браузерными расширениями (Chrome Manifest V3).
    """
    BASE_URL = "https://api.dmarket.com"

    DEFAULT_BROWSER_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
        "Origin": "https://dmarket.com",
        "Referer": "https://dmarket.com/",
        "sec-ch-ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "Connection": "keep-alive"
    }

    def __init__(self, cookies: Optional[Union[str, Dict[str, str]]] = None, bearer_token: Optional[str] = None):
        self.session = requests.Session()
        self.session.headers.update(self.DEFAULT_BROWSER_HEADERS)
        self.consecutive_rate_limits = 0
        self.last_request_time = 0.0
        self.min_interval = 0.12  # ~8 RPS для безопасности
        self._lock = threading.Lock()
        self.raw_cookie_str = ""
        self.bearer_token = ""
        self.browser_source = ""

        if cookies:
            self.set_cookies(cookies)
        else:
            # Автоматическая попытка извлечь куки из установленных браузеров
            self.auto_load_cookies()

        if bearer_token:
            self.set_bearer_token(bearer_token)

    def auto_load_cookies(self) -> bool:
        """Автоматически обнаруживает и загружает куки DMarket из установленных браузеров."""
        cookies_dict, cookie_str, browser_name = BrowserCookieExtractor.auto_detect_dmarket_cookies()
        if cookies_dict:
            self.set_cookies(cookies_dict)
            self.raw_cookie_str = cookie_str
            self.browser_source = browser_name
            return True
        return False

    def set_cookies(self, cookies: Union[str, Dict[str, str]], source_name: str = ""):
        """Устанавливает куки для веб-сессии."""
        if isinstance(cookies, str):
            self.raw_cookie_str = cookies.strip()
            cookies_dict = parse_cookie_string(self.raw_cookie_str)
        else:
            cookies_dict = cookies
            self.raw_cookie_str = "; ".join([f"{k}={v}" for k, v in cookies_dict.items()])

        if source_name:
            self.browser_source = source_name

        self.session.cookies.clear()
        for k, v in cookies_dict.items():
            self.session.cookies.set(k, v, domain=".dmarket.com")

        # Если в куках есть JWT/токен, настраиваем заголовок Authorization
        jwt_candidate = cookies_dict.get("dmarket-jwt") or cookies_dict.get("token") or cookies_dict.get("session")
        if jwt_candidate and not self.bearer_token and len(jwt_candidate) > 20:
            self.set_bearer_token(jwt_candidate)

    def set_bearer_token(self, token: str):
        """Устанавливает Bearer JWT токен."""
        token = token.strip()
        if token.startswith("Bearer "):
            token = token[7:].strip()
        self.bearer_token = token
        if token:
            self.session.headers["Authorization"] = f"Bearer {token}"
        elif "Authorization" in self.session.headers:
            del self.session.headers["Authorization"]

    def _throttle(self):
        """Потокобезопасный ограничитель скорости браузерных запросов."""
        with self._lock:
            now = time.time()
            elapsed = now - self.last_request_time
            if elapsed < self.min_interval:
                time.sleep(self.min_interval - elapsed)
            self.last_request_time = time.time()

    def get_user_profile(self) -> Dict[str, Any]:
        """Получает данные профиля текущего авторизованного пользователя DMarket."""
        self._throttle()
        url = f"{self.BASE_URL}/account/v1/user"
        try:
            resp = self.session.get(url, timeout=10)
            if resp.status_code == 200:
                return resp.json()
            # Фоллбек на детали баланса
            bal_url = f"{self.BASE_URL}/account/v1/balance"
            bal_resp = self.session.get(bal_url, timeout=10)
            if bal_resp.status_code == 200:
                return bal_resp.json()
            return {}
        except Exception as e:
            return {}

    def test_connection(self) -> Dict[str, Any]:
        """
        Проверяет статус авторизации через браузерные куки.
        Возвращает информацию об аккаунте, балансе и статусе сессии.
        """
        profile = self.get_user_profile()
        offers = self.get_user_offers(limit=1)

        is_authenticated = bool(profile or offers)
        username = profile.get("username") or profile.get("email") or "Авторизован через сессию"
        balance_data = profile.get("balance", {})
        balance_usd = None
        if isinstance(balance_data, dict):
            usd_val = balance_data.get("usd")
            if usd_val is not None:
                try:
                    balance_usd = float(usd_val) / 100.0 if float(usd_val) > 1000 else float(usd_val)
                except Exception:
                    pass

        return {
            "is_authenticated": is_authenticated,
            "username": username if is_authenticated else None,
            "balance_usd": balance_usd,
            "browser_source": self.browser_source or "Browser Session",
            "cookies_count": len(self.session.cookies),
            "has_bearer_token": bool(self.bearer_token)
        }

    def get_user_offers(self, game_id: str = "a8db", limit: int = 100) -> List[Dict[str, Any]]:
        """Получает список активных лотов пользователя на DMarket через браузерный запрос."""
        self._throttle()
        url = f"{self.BASE_URL}/marketplace-api/v2/user/offers"
        params = {
            "game_id": game_id,
            "limit": str(limit),
            "status": "OfferStatusDefault"
        }
        try:
            resp = self.session.get(url, params=params, timeout=12)

            if resp.status_code == 429:
                self.consecutive_rate_limits += 1
                if self.consecutive_rate_limits >= 2:
                    raise RateLimitException("DMarket")
                time.sleep(1.0)
                return []

            self.consecutive_rate_limits = 0
            if resp.status_code == 200:
                data = resp.json()
                return data.get("items", [])
            elif resp.status_code in (401, 403):
                # Фоллбек на user-inventory
                inv_url = f"{self.BASE_URL}/marketplace-api/v1/user-inventory"
                inv_resp = self.session.get(inv_url, params={"gameId": game_id, "BasicFilters.Status": "OfferStatusDefault", "Limit": limit}, timeout=12)
                if inv_resp.status_code == 200:
                    data = inv_resp.json()
                    return data.get("Items", []) or data.get("items", [])
                return []
            else:
                return []
        except requests.exceptions.RequestException as e:
            return []

    def get_user_closed_targets(self, max_pages: int = 5, limit: int = 100) -> List[Dict[str, Any]]:
        """Получает историю завершенных покупок пользователя для расчета P&L."""
        trades = []
        cursor = ""
        for _ in range(max_pages):
            self._throttle()
            path = f"/marketplace-api/v1/user-targets/closed?limit={limit}"
            if cursor:
                path += f"&cursor={cursor}"
            url = f"{self.BASE_URL}{path}"
            try:
                resp = self.session.get(url, timeout=12)
                if resp.status_code == 429:
                    time.sleep(1.0)
                    break
                if resp.status_code == 200:
                    data = resp.json()
                    t_list = data.get("Trades", [])
                    trades.extend(t_list)
                    cursor = data.get("Cursor", "")
                    if not cursor or len(t_list) < limit:
                        break
                else:
                    break
            except Exception:
                break
        return trades

    def get_market_offers(
            self,
            title: str,
            exterior: Optional[str] = None,
            phase: Optional[str] = None,
            tree_filters_extra: Optional[str] = None,
            limit: int = 100,
            cursor: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Публичный браузерный поиск предложений на рынке DMarket.
        Не требует авторизации, работает как нативный GET-запрос браузера.
        """
        self._throttle()
        url = f"{self.BASE_URL}/marketplace-api/v2/offers"
        params = {
            "gameId": "a8db",
            "title": title,
            "orderBy": "price",
            "orderDir": "asc",
            "limit": limit
        }
        filters = []
        if exterior:
            filters.append(f"exterior[]={exterior}")
        if phase:
            filters.append(f"phase[]={phase}")
        if tree_filters_extra:
            filters.append(tree_filters_extra)

        if filters:
            params["treeFilters"] = ",".join(filters)

        if cursor:
            params["cursor"] = cursor

        try:
            resp = self.session.get(url, params=params, timeout=12)

            rem_sec = resp.headers.get("X-RateLimit-Remaining-Second")
            if rem_sec and int(rem_sec) <= 1:
                time.sleep(0.3)

            if resp.status_code == 429:
                self.consecutive_rate_limits += 1
                if self.consecutive_rate_limits >= 2:
                    raise RateLimitException("DMarket")
                time.sleep(1.5)
                return {}

            self.consecutive_rate_limits = 0
            if resp.status_code == 200:
                return resp.json()
            return {}
        except Exception as e:
            return {}

    def edit_offer_price(self, offer_id: str, price_usd: float) -> Dict[str, Any]:
        """Изменяет цену лота на DMarket через нативный exchange/v1/offers PATCH запрос."""
        self._throttle()
        price_cents = int(round(price_usd * 100))
        headers = {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest"
        }

        # 1. Основной современный метод: PATCH /exchange/v1/offers
        url_exchange = f"{self.BASE_URL}/exchange/v1/offers"
        payload_exchange = {
            "force": True,
            "objects": [
                {
                    "offerId": offer_id,
                    "price": {
                        "amount": str(price_cents),
                        "currency": "USD"
                    },
                    "selectedPricePreset": "custom"
                }
            ]
        }
        try:
            resp = self.session.patch(url_exchange, json=payload_exchange, headers=headers, timeout=12)
            if resp.status_code in (200, 201, 204):
                try:
                    data = resp.json()
                    return {"success": True, "data": data}
                except Exception:
                    return {"success": True, "data": {}}

            # 2. Фоллбек: v2 batchUpdate
            url_v2 = f"{self.BASE_URL}/marketplace-api/v2/offers:batchUpdate"
            payload_v2 = {
                "requests": [
                    {
                        "offerId": offer_id,
                        "price_cents": price_cents
                    }
                ]
            }
            resp_v2 = self.session.post(url_v2, json=payload_v2, headers=headers, timeout=12)
            if resp_v2.status_code in (200, 201):
                try:
                    data = resp_v2.json()
                    failed_list = data.get("failed", [])
                    if failed_list and isinstance(failed_list, list):
                        first_fail = failed_list[0]
                        msg = first_fail.get("message", "") or first_fail.get("code", "")
                        if "NewOfferHasSamePriceAndFees" in msg or msg == "NewOfferHasSamePriceAndFees":
                            return {"success": True, "data": data, "message": "Цена уже установлена на этот уровень"}
                        return {"success": False, "error": msg or "Ошибка обновления лота"}
                    return {"success": True, "data": data}
                except Exception:
                    return {"success": True, "data": {}}

            # 3. Фоллбек: v1 user-offers/edit
            url_v1 = f"{self.BASE_URL}/marketplace-api/v1/user-offers/edit"
            payload_v1 = {
                "Offers": [
                    {
                        "OfferId": offer_id,
                        "Price": {
                            "Currency": "USD",
                            "Amount": price_usd
                        }
                    }
                ]
            }
            resp_v1 = self.session.post(url_v1, json=payload_v1, headers=headers, timeout=12)
            if resp_v1.status_code in (200, 201):
                return {"success": True, "data": resp_v1.json()}

            err_msg = ""
            try:
                err_data = resp.json()
                err_msg = err_data.get("message") or err_data.get("error") or err_data.get("code")
            except Exception:
                pass
            return {"success": False, "error": err_msg or resp.text or f"HTTP {resp.status_code}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def buy_market_offer(self, offer_id: str, price_usd: float) -> Dict[str, Any]:
        """Покупает лот конкурента с DMarket через браузерную сессию."""
        self._throttle()
        url = f"{self.BASE_URL}/exchange/v1/offers-buy"
        price_cents = int(round(price_usd * 100))
        payload = {
            "offers": [
                {
                    "offerId": offer_id,
                    "price": {
                        "currency": "USD",
                        "amount": price_cents
                    }
                }
            ]
        }
        headers = {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest"
        }
        try:
            resp = self.session.patch(url, json=payload, headers=headers, timeout=15)
            if resp.status_code in (200, 201):
                try:
                    return {"success": True, "data": resp.json()}
                except Exception:
                    return {"success": True, "data": {}}

            if resp.status_code == 405:
                resp_post = self.session.post(url, json=payload, headers=headers, timeout=15)
                if resp_post.status_code in (200, 201):
                    try:
                        return {"success": True, "data": resp_post.json()}
                    except Exception:
                        return {"success": True, "data": {}}
                resp = resp_post

            # Фоллбек на marketplace-api v1
            if resp.status_code in (400, 404, 422):
                url_fb = f"{self.BASE_URL}/marketplace-api/v1/offers-buy"
                resp_fb = self.session.post(url_fb, json=payload, headers=headers, timeout=15)
                if resp_fb.status_code in (200, 201):
                    try:
                        return {"success": True, "data": resp_fb.json()}
                    except Exception:
                        return {"success": True, "data": {}}

            err_text = ""
            try:
                err_json = resp.json()
                err_text = err_json.get("message") or err_json.get("error") or err_json.get("code") or str(err_json)
                if "insufficient" in err_text.lower() or "balance" in err_text.lower():
                    err_text = "Недостаточно средств на балансе DMarket"
                elif "not found" in err_text.lower() or "already" in err_text.lower() or "sold" in err_text.lower():
                    err_text = "Лот уже выкуплен или снят с продажи продавцом"
                elif "price" in err_text.lower():
                    err_text = "Цена лота изменилась, обновите список предложений"
            except Exception:
                err_text = resp.text or f"HTTP {resp.status_code}"

            return {"success": False, "error": err_text}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def delete_user_offers(self, offer_ids: List[str]) -> Dict[str, Any]:
        """Снимает выставленные лоты с продажи на DMarket."""
        self._throttle()
        if not offer_ids:
            return {"success": False, "error": "Не указаны offer_id для снятия"}

        headers = {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest"
        }

        # v2 DELETE
        url_v2 = f"{self.BASE_URL}/marketplace-api/v2/offers"
        payload_v2 = {"offerIds": offer_ids}
        try:
            resp = self.session.delete(url_v2, json=payload_v2, headers=headers, timeout=12)
            if resp.status_code in (200, 204):
                return {"success": True, "message": "Лот успешно снят с продажи"}

            # Фоллбек на v1 delete
            url_v1 = f"{self.BASE_URL}/marketplace-api/v1/user-offers/delete"
            payload_v1 = {"objects": [{"offerId": oid} for oid in offer_ids]}
            resp_v1 = self.session.post(url_v1, json=payload_v1, headers=headers, timeout=12)
            if resp_v1.status_code in (200, 204):
                return {"success": True, "message": "Лот успешно снят с продажи"}

            err_text = resp.text or f"HTTP {resp.status_code}"
            return {"success": False, "error": err_text}
        except Exception as e:
            return {"success": False, "error": str(e)}


# Обратная совместимость для модулей
DMarketClient = DMarketWebClient

