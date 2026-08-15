import os
import sys
import time
import json
import threading
from flask import Flask, render_template, request, jsonify

if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

from dmarket_client import DMarketWebClient, RateLimitException
from cookie_extractor import BrowserCookieExtractor
from tracker_service import scan_all_user_offers

app = Flask(__name__)
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "data", "config.json")


def load_config() -> dict:
    """Загружает сохраненную конфигурацию куки и настроек."""
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"cookies": "", "bearer_token": "", "browser_source": "auto"}


def save_config(cfg: dict):
    """Сохраняет конфигурацию в data/config.json."""
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[x] Ошибка сохранения config.json: {e}")


# Инициализация веб-клиента DMarket
cfg = load_config()
client = DMarketWebClient(
    cookies=cfg.get("cookies") or None,
    bearer_token=cfg.get("bearer_token") or None
)
if cfg.get("browser_source"):
    client.browser_source = cfg["browser_source"]

# Состояние сканирования и кэш
scan_state = {
    "is_scanning": False,
    "progress": 0,
    "total": 0,
    "message": "",
    "last_scanned_at": None,
    "items": []
}
current_stop_event = threading.Event()


def update_progress(current: int, total: int, msg: str):
    global scan_state
    scan_state["progress"] = current
    scan_state["total"] = total
    scan_state["message"] = msg


def run_background_scan():
    global scan_state, current_stop_event
    scan_state["is_scanning"] = True
    current_stop_event.clear()
    try:
        items = scan_all_user_offers(client, progress_cb=update_progress, stop_event=current_stop_event)
        scan_state["items"] = items
        scan_state["last_scanned_at"] = time.strftime("%H:%M:%S (%d.%m.%Y)")
        if not items and not current_stop_event.is_set():
            scan_state["message"] = "Лоты не найдены. Убедитесь, что сессия DMarket активна в браузере."
    except Exception as e:
        print(f"[x] Ошибка фонового сканирования: {e}")
        scan_state["message"] = f"Ошибка: {e}"
    finally:
        scan_state["is_scanning"] = False


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/auth/status")
def auth_status():
    """Возвращает статус авторизации и профиль пользователя."""
    global client
    test_res = client.test_connection()
    return jsonify({
        "success": True,
        "is_authenticated": test_res["is_authenticated"],
        "username": test_res["username"],
        "balance_usd": test_res["balance_usd"],
        "browser_source": client.browser_source or "Авто-детект",
        "cookies_count": len(client.session.cookies),
        "has_cookies": bool(client.raw_cookie_str or len(client.session.cookies) > 0)
    })


@app.route("/api/cookies/auto-detect", methods=["POST"])
def auto_detect_cookies():
    """Автоматически сканирует установленные браузеры на ПК и загружает куки DMarket."""
    global client
    success = client.auto_load_cookies()
    if success:
        cfg = load_config()
        cfg["cookies"] = client.raw_cookie_str
        cfg["browser_source"] = client.browser_source
        save_config(cfg)

        test_res = client.test_connection()
        return jsonify({
            "success": True,
            "message": f"Куки успешно найдены в {client.browser_source}!",
            "browser": client.browser_source,
            "is_authenticated": test_res["is_authenticated"],
            "username": test_res["username"],
            "balance_usd": test_res["balance_usd"]
        })
    else:
        return jsonify({
            "success": False,
            "message": "Не удалось автоматически найти активную сессию DMarket в браузерах. Убедитесь, что вы залогинены на dmarket.com в Chrome, Edge, Brave или Opera, или установите расширение."
        }), 404


@app.route("/api/sync-cookies", methods=["POST", "OPTIONS"])
def sync_cookies():
    """Принимает сессионные куки от браузерного расширения."""
    global client
    if request.method == "OPTIONS":
        # CORS preflight
        resp = jsonify({"success": True})
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        return resp

    data = request.get_json() or {}
    cookies = data.get("cookies")
    source = data.get("source", "Browser Extension")
    bearer_token = data.get("bearer_token", "")

    if not cookies and not bearer_token:
        resp = jsonify({"success": False, "message": "Нет куки или токена для синхронизации"})
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return resp, 400

    if cookies:
        client.set_cookies(cookies, source_name=source)
    if bearer_token:
        client.set_bearer_token(bearer_token)

    cfg = load_config()
    cfg["cookies"] = client.raw_cookie_str
    cfg["bearer_token"] = client.bearer_token
    cfg["browser_source"] = source
    save_config(cfg)

    test_res = client.test_connection()
    resp = jsonify({
        "success": True,
        "message": f"Куки успешно синхронизированы из {source}!",
        "is_authenticated": test_res["is_authenticated"],
        "username": test_res["username"],
        "balance_usd": test_res["balance_usd"]
    })
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@app.route("/api/settings", methods=["GET", "POST"])
def handle_settings():
    """Получение и ручное сохранение настроек куки."""
    global client
    if request.method == "GET":
        cfg = load_config()
        # Маскируем куки для отображения
        cookie_preview = ""
        if cfg.get("cookies"):
            c_str = cfg["cookies"]
            cookie_preview = c_str[:25] + "..." + c_str[-15:] if len(c_str) > 40 else c_str

        return jsonify({
            "success": True,
            "has_cookies": bool(cfg.get("cookies")),
            "cookie_preview": cookie_preview,
            "bearer_token": cfg.get("bearer_token", ""),
            "browser_source": client.browser_source or cfg.get("browser_source", "")
        })

    data = request.get_json() or {}
    new_cookies = data.get("cookies", "").strip()
    new_token = data.get("bearer_token", "").strip()

    cfg = load_config()
    if new_cookies:
        cfg["cookies"] = new_cookies
        client.set_cookies(new_cookies, source_name="Ручной ввод / Web")
    if new_token:
        cfg["bearer_token"] = new_token
        client.set_bearer_token(new_token)

    save_config(cfg)
    test_res = client.test_connection()

    return jsonify({
        "success": True,
        "message": "Настройки сохранены",
        "is_authenticated": test_res["is_authenticated"],
        "username": test_res["username"],
        "balance_usd": test_res["balance_usd"]
    })


@app.route("/api/settings/test", methods=["POST"])
def test_connection_endpoint():
    """Тестирует текущее соединение."""
    global client
    res = client.test_connection()
    return jsonify({
        "success": True,
        "data": res
    })


@app.route("/api/scan/start", methods=["POST"])
def start_scan():
    global scan_state
    if scan_state["is_scanning"]:
        return jsonify({"success": False, "message": "Сканирование уже выполняется"}), 400

    thread = threading.Thread(target=run_background_scan, daemon=True)
    thread.start()
    return jsonify({"success": True, "message": "Сканирование запущено"})


@app.route("/api/scan/stop", methods=["POST"])
def stop_scan():
    global current_stop_event, scan_state
    current_stop_event.set()
    scan_state["is_scanning"] = False
    return jsonify({"success": True, "message": "Сканирование остановлено"})


@app.route("/api/scan/status")
def scan_status():
    global scan_state
    total_val = sum(x.get("price_usd", 0) for x in scan_state["items"])
    rank_1_count = sum(1 for x in scan_state["items"] if x.get("rank") == 1)

    return jsonify({
        "is_scanning": scan_state["is_scanning"],
        "progress": scan_state["progress"],
        "total": scan_state["total"],
        "message": scan_state["message"],
        "last_scanned_at": scan_state["last_scanned_at"],
        "items_count": len(scan_state["items"]),
        "portfolio_val": round(total_val, 2),
        "rank_1_count": rank_1_count
    })


@app.route("/api/items")
def get_items():
    global scan_state
    return jsonify({
        "success": True,
        "items": scan_state["items"],
        "last_scanned_at": scan_state["last_scanned_at"]
    })


@app.route("/api/offers/edit-price", methods=["POST"])
def edit_offer_price():
    global scan_state
    data = request.get_json() or {}
    offer_id = str(data.get("offer_id", "")).strip()
    try:
        new_price = float(data.get("price", 0))
    except (ValueError, TypeError):
        return jsonify({"success": False, "message": "Некорректная цена"}), 400

    if not offer_id:
        return jsonify({"success": False, "message": "Не указан offer_id"}), 400

    if new_price <= 0:
        return jsonify({"success": False, "message": "Цена должна быть больше 0"}), 400

    new_price = round(new_price, 2)
    res = client.edit_offer_price(offer_id, new_price)
    if not res.get("success"):
        return jsonify({
            "success": False,
            "message": f"Ошибка DMarket: {res.get('error', 'Не удалось обновить цену')}"
        }), 400

    # Обновляем состояние в памяти
    updated_item = None
    for item in scan_state["items"]:
        if item.get("offer_id") == offer_id:
            item["price_usd"] = new_price
            item["price_str"] = f"${new_price:.2f}"

            # Пересчет P&L с учетом 2% комиссии
            FEE_RATE = 0.02
            net_payout = round(new_price * (1.0 - FEE_RATE), 2)
            if item.get("buy_price") is not None:
                item["profit_usd"] = round(net_payout - item["buy_price"], 2)
                item["profit_pct"] = round((item["profit_usd"] / item["buy_price"]) * 100, 1) if item["buy_price"] > 0 else 0.0

            # Обновление лота внутри списка competitors
            if "competitors" in item and item["competitors"]:
                for c in item["competitors"]:
                    if c.get("is_user_offer") or c.get("offer_id") == offer_id:
                        c["price_usd"] = new_price
                # Пересортировка конкурентов по цене
                item["competitors"].sort(key=lambda x: x["price_usd"])

                # Пересчет ранга
                user_rank = 1
                for idx, c in enumerate(item["competitors"]):
                    if c.get("is_user_offer") or c.get("offer_id") == offer_id:
                        user_rank = idx + 1
                        break
                item["rank"] = user_rank
                item["rank_display"] = f"#{user_rank} из {item.get('total_in_category', len(item['competitors']))}"
                item["is_best_price"] = (user_rank == 1)

                lowest_price = item["competitors"][0]["price_usd"] if item["competitors"] else new_price
                item["lowest_cat_price"] = lowest_price
                item["lowest_cat_price_str"] = f"${lowest_price:.2f}"
                item["price_diff_usd"] = round(new_price - lowest_price, 2)
                item["price_diff_pct"] = round(((new_price - lowest_price) / lowest_price) * 100, 1) if lowest_price > 0 else 0.0

            updated_item = item
            break

    return jsonify({
        "success": True,
        "message": f"Цена успешно обновлена на ${new_price:.2f}",
        "item": updated_item
    })


@app.route("/api/offers/buy", methods=["POST"])
def buy_offer():
    data = request.get_json() or {}
    offer_id = str(data.get("offer_id", "")).strip()
    try:
        price = float(data.get("price", 0))
    except (ValueError, TypeError):
        return jsonify({"success": False, "message": "Некорректная цена"}), 400

    if not offer_id:
        return jsonify({"success": False, "message": "Не указан offer_id"}), 400

    if price <= 0:
        return jsonify({"success": False, "message": "Цена должна быть больше 0"}), 400

    price = round(price, 2)
    res = client.buy_market_offer(offer_id, price)
    if res.get("success"):
        return jsonify({
            "success": True,
            "message": f"Лот успешно выкуплен за ${price:.2f}!",
            "data": res.get("data")
        })
    else:
        return jsonify({
            "success": False,
            "message": f"Ошибка покупки на DMarket: {res.get('error', 'Неизвестная ошибка')}"
        }), 400


@app.route("/api/offers/refresh-single", methods=["POST"])
def refresh_single_offer():
    global scan_state
    data = request.get_json() or {}
    offer_id = str(data.get("offer_id", "")).strip()

    if not offer_id:
        return jsonify({"success": False, "message": "Не указан offer_id"}), 400

    target_item = next((x for x in scan_state["items"] if x.get("offer_id") == offer_id), None)
    if not target_item:
        return jsonify({"success": False, "message": "Лот не найден"}), 404

    try:
        from data.wear_configs import WEAR_CONFIGS, detect_wear_from_title, get_float_category
        from tracker_service import is_exact_dmarket_match
        import re

        full_title = target_item.get("title", "")
        base_title, wear_name = detect_wear_from_title(full_title)
        wear_cfg = WEAR_CONFIGS.get(wear_name, WEAR_CONFIGS["Field-Tested"])
        exterior_api = wear_cfg["dmarket_exterior"]
        float_val = target_item.get("float_val")
        item_phase = target_item.get("phase")
        price_usd = target_item.get("price_usd", 0)
        paint_seed = target_item.get("paint_seed")

        float_cat = get_float_category(wear_name, float_val)
        cat_min = float_cat["min"]
        cat_max = float_cat["max"]

        search_title = re.sub(r'^[★*]\s*', '', base_title).strip()
        market_data = client.get_market_offers(
            title=search_title,
            exterior=exterior_api,
            phase=item_phase,
            limit=100
        )
        raw_market_items = market_data.get("items", []) if isinstance(market_data, dict) else []

        category_matched_offers = []
        for itm in raw_market_items:
            i_attrs = itm.get("attributes", {})
            i_cs2 = i_attrs.get("cs2", {})
            i_title = i_attrs.get("title") or i_attrs.get("name", "")

            if not is_exact_dmarket_match(i_title, full_title):
                continue

            i_phase = i_cs2.get("phase")
            if item_phase and i_phase != item_phase:
                continue

            i_price_cents = int(itm.get("priceCents", 0))
            i_price_usd = i_price_cents / 100.0
            i_float_raw = i_cs2.get("float")
            i_float = float(i_float_raw) if i_float_raw is not None and str(i_float_raw).strip() != "" else None
            i_oid = itm.get("offerId")

            info = {
                "offer_id": i_oid,
                "price_usd": i_price_usd,
                "float": i_float,
                "paint_seed": i_cs2.get("paintSeed"),
                "phase": i_phase,
                "is_user_offer": (i_oid == offer_id),
                "url": f"https://dmarket.com/ingame-items/item-list/csgo-skins?userOfferId={i_oid}"
            }

            if i_float is not None and (cat_min <= i_float <= (cat_max + 1e-6)):
                category_matched_offers.append(info)

        if not any(x["offer_id"] == offer_id for x in category_matched_offers):
            category_matched_offers.append({
                "offer_id": offer_id,
                "price_usd": price_usd,
                "float": float_val,
                "paint_seed": paint_seed,
                "phase": item_phase,
                "is_user_offer": True,
                "url": f"https://dmarket.com/ingame-items/item-list/csgo-skins?userOfferId={offer_id}"
            })

        category_matched_offers.sort(key=lambda x: x["price_usd"])

        user_cat_rank = 1
        for idx, it in enumerate(category_matched_offers):
            if it["is_user_offer"] or it["offer_id"] == offer_id:
                user_cat_rank = idx + 1
                break

        total_in_category = len(category_matched_offers)
        lowest_cat_price = category_matched_offers[0]["price_usd"] if category_matched_offers else price_usd
        price_diff_usd = round(price_usd - lowest_cat_price, 2)
        price_diff_pct = round(((price_usd - lowest_cat_price) / lowest_cat_price) * 100, 1) if lowest_cat_price > 0 else 0.0

        target_item["rank"] = user_cat_rank
        target_item["total_in_category"] = total_in_category
        target_item["rank_display"] = f"#{user_cat_rank} из {total_in_category}"
        target_item["is_best_price"] = (user_cat_rank == 1)
        target_item["lowest_cat_price"] = lowest_cat_price
        target_item["lowest_cat_price_str"] = f"${lowest_cat_price:.2f}"
        target_item["price_diff_usd"] = price_diff_usd
        target_item["price_diff_pct"] = price_diff_pct
        target_item["competitors"] = category_matched_offers[:10]

        import urllib.parse
        market_params = {
            "sort-type": "5",
            "floatValueFrom": f"{cat_min:.2f}",
            "floatValueTo": f"{cat_max:.2f}",
            "title": full_title
        }
        tree_filters = []
        if "fade" in full_title.lower() and "marble" not in full_title.lower():
            tree_filters.append("collection=Fade skins")
        if item_phase:
            tree_filters.append(f"phase[]={item_phase}")

        if tree_filters:
            market_params["treeFilters"] = ",".join(tree_filters)
        target_item["market_url"] = f"https://dmarket.com/ingame-items/item-list/csgo-skins?{urllib.parse.urlencode(market_params)}"
        target_item["offer_url"] = target_item["market_url"]

        return jsonify({
            "success": True,
            "item": target_item,
            "message": f"Предложения обновлены (всего {total_in_category} лотов)"
        })
    except Exception as e:
        return jsonify({"success": False, "message": f"Ошибка обновления: {e}"}), 500


@app.route("/api/offers/delete", methods=["POST"])
def delete_offer():
    global scan_state
   
    data = request.get_json() or {}
    offer_id = str(data.get("offer_id", "")).strip()

    if not offer_id:
        return jsonify({"success": False, "message": "Не указан offer_id"}), 400

    res = client.delete_user_offers([offer_id])
    if res.get("success"):
        # Удаляем из локального кэша предметов
        scan_state["items"] = [x for x in scan_state["items"] if x.get("offer_id") != offer_id]
        return jsonify({
            "success": True,
            "message": "Лот успешно снят с продажи на DMarket",
            "offer_id": offer_id
        })
    else:
        return jsonify({
            "success": False,
            "message": f"Ошибка DMarket: {res.get('error', 'Не удалось снять лот с продажи')}"
        }), 400


if __name__ == "__main__":
    print("[*] Запуск DMarket Float Category Tracker на http://127.0.0.1:5001")
    app.run(host="0.0.0.0", port=5001, debug=True, use_reloader=False)