import time
import re
import threading
import urllib.parse
from typing import List, Dict, Any, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from data.wear_configs import WEAR_CONFIGS, detect_wear_from_title, get_float_category
from dmarket_client import DMarketClient, RateLimitException


def is_exact_dmarket_match(item_title: str, target_skin_name: str) -> bool:
    """Проверяет строгое совпадение названия скина без лишних подмешиваний."""
    t_clean = re.sub(r'^[★*]\s*', '', target_skin_name).strip().lower()
    i_clean = re.sub(r'^[★*]\s*', '', item_title).strip().lower()

    # Проверка на StatTrak: не смешивать StatTrak и обычные версии
    is_target_st = "stattrak" in t_clean
    is_item_st = "stattrak" in i_clean
    if is_target_st != is_item_st:
        return False

    # Строгая проверка на исключение смешивания Fade и Marble Fade
    if "fade" in t_clean and "marble" not in t_clean and "marble" in i_clean:
        return False
    if "marble" in t_clean and "marble" not in i_clean:
        return False

    if t_clean == i_clean:
        return True

    # Базовая очистка износа в скобках для точного сравнения
    t_base = re.sub(r'\s*\([^)]+\)\s*$', '', t_clean).strip()
    i_base = re.sub(r'\s*\([^)]+\)\s*$', '', i_clean).strip()

    return t_base == i_base


def analyze_single_offer(
        client: DMarketClient,
        raw_offer: Dict[str, Any],
        stop_event: Optional[threading.Event] = None,
        buy_history_map: Optional[Dict[str, Any]] = None,
        buy_history_title: Optional[Dict[str, Any]] = None
) -> Optional[Dict[str, Any]]:
    """
    Анализирует один выставленный предмет:
    1. Извлекает параметры (название, флоат, фазу допплера, цену, сид, изображение).
    2. Извлекает цену покупки из истории покупок и считает P&L с учетом 2% комиссии.
    3. Определяет категорию флота.
    4. Запрашивает рынок DMarket и считает точную позицию (ранг) в своей категории с учетом фазы и StatTrak.
    """
    if stop_event and stop_event.is_set():
        return None

    attrs = raw_offer.get("attributes", {})
    cs2_data = attrs.get("cs2", {})

    offer_id = raw_offer.get("offerId")
    full_title = attrs.get("title") or attrs.get("name", "Unknown Skin")
    # Вычисление цены лота
    price_cents_raw = raw_offer.get("priceCents")
    price_obj = raw_offer.get("price") or raw_offer.get("Price") or {}
    price_usd = 0.0

    if price_cents_raw is not None:
        price_usd = int(price_cents_raw) / 100.0
    elif isinstance(price_obj, dict):
        if "amount" in price_obj and price_obj["amount"] is not None:
            price_usd = float(price_obj["amount"]) / 100.0
        elif "Amount" in price_obj and price_obj["Amount"] is not None:
            price_usd = float(price_obj["Amount"])
        elif "USD" in price_obj and price_obj["USD"] is not None:
            price_usd = float(price_obj["USD"]) / 100.0
        elif "usd" in price_obj and price_obj["usd"] is not None:
            u = float(price_obj["usd"])
            price_usd = u / 100.0 if u > 1000 else u
    elif raw_offer.get("price_usd") is not None:
        price_usd = float(raw_offer["price_usd"])

    # Определение фазы для Doppler / Gamma Doppler скинов
    raw_phase = cs2_data.get("phase") or attrs.get("phase")
    item_phase = raw_phase if raw_phase and raw_phase not in ["PHASE_TITLE_UNSPECIFIED", ""] else None
    phase_display = item_phase.replace('-', ' ').title() if item_phase else None

    # Поиск цены покупки из истории закрытых покупок/таргетов
    asset_id = attrs.get("id") or raw_offer.get("assetId") or raw_offer.get("AssetId")
    buy_trade = None
    if buy_history_map and asset_id in buy_history_map:
        buy_trade = buy_history_map[asset_id]
    elif buy_history_title and full_title in buy_history_title:
        buy_trade = buy_history_title[full_title]

    # Расчет чистой прибыли с учетом 2% комиссии DMarket
    FEE_RATE = 0.02
    net_payout = round(price_usd * (1.0 - FEE_RATE), 2)

    if buy_trade and "Price" in buy_trade and "Amount" in buy_trade["Price"]:
        buy_price = round(float(buy_trade["Price"]["Amount"]), 2)
        profit_usd = round(net_payout - buy_price, 2)
        profit_pct = round((profit_usd / buy_price) * 100, 1) if buy_price > 0 else 0.0
        buy_price_str = f"${buy_price:.2f}"
    else:
        buy_price = None
        profit_usd = None
        profit_pct = None
        buy_price_str = "—"

    raw_float = cs2_data.get("float") or cs2_data.get("floatValue") or attrs.get("floatValue") or attrs.get("float") or raw_offer.get("floatValue")
    float_val = None
    if raw_float is not None and str(raw_float).strip() != "":
        try:
            float_val = float(raw_float)
        except (ValueError, TypeError):
            float_val = None

    paint_seed = cs2_data.get("paintSeed") or attrs.get("paintSeed")
    image_url = attrs.get("imageUri") or attrs.get("imageUrl") or raw_offer.get("image") or raw_offer.get("imageUri")
    item_type = attrs.get("categoryPath", "")

    # Определение базового названия и износа
    base_title, wear_name = detect_wear_from_title(full_title)
    wear_cfg = WEAR_CONFIGS.get(wear_name, WEAR_CONFIGS["Field-Tested"])
    exterior_api = wear_cfg["dmarket_exterior"]

    # Определение диапазона флота предмета
    float_cat = get_float_category(wear_name, float_val)
    cat_min = float_cat["min"]
    cat_max = float_cat["max"]
    cat_label = float_cat["label"]

    # Запрос рынка DMarket для этого скина с учетом фазы (поиск конкурентов)
    search_title = re.sub(r'^[★*]\s*', '', base_title).strip()
    market_data = client.get_market_offers(
        title=search_title,
        exterior=exterior_api,
        phase=item_phase,
        limit=100
    )
    raw_market_items = market_data.get("items", []) if isinstance(market_data, dict) else []

    # Парсинг и фильтрация всех рыночных предложений этого скина
    all_matched_offers = []
    category_matched_offers = []

    for item in raw_market_items:
        i_attrs = item.get("attributes", {})
        i_cs2 = i_attrs.get("cs2", {})
        i_title = i_attrs.get("title") or i_attrs.get("name", "")

        if not is_exact_dmarket_match(i_title, full_title):
            continue

        # Строгая проверка фазы Doppler
        i_phase = i_cs2.get("phase")
        if item_phase and i_phase != item_phase:
            continue

        i_price_cents = int(item.get("priceCents", 0))
        i_price_usd = i_price_cents / 100.0
        i_float_raw = i_cs2.get("float")
        i_float = float(i_float_raw) if i_float_raw is not None and str(i_float_raw).strip() != "" else None
        i_oid = item.get("offerId")

        item_info = {
            "offer_id": i_oid,
            "price_usd": i_price_usd,
            "float": i_float,
            "paint_seed": i_cs2.get("paintSeed"),
            "phase": i_phase,
            "is_user_offer": (i_oid == offer_id),
            "url": f"https://dmarket.com/ingame-items/item-list/csgo-skins?userOfferId={i_oid}"
        }

        all_matched_offers.append(item_info)

        # Проверка принадлежности к поддиапазону флота
        if i_float is not None and (cat_min <= i_float <= (cat_max + 1e-6)):
            category_matched_offers.append(item_info)

    # Если собственный лот не найден в выдаче рынка (например, свежий оффер), добавляем его для точного ранжирования
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

    # Сортировка предложений в категории по возрастанию цены
    category_matched_offers.sort(key=lambda x: x["price_usd"])

    # Определение позиции (ранга)
    user_cat_rank = 1
    for idx, it in enumerate(category_matched_offers):
        if it["is_user_offer"] or it["offer_id"] == offer_id:
            user_cat_rank = idx + 1
            break

    total_in_category = len(category_matched_offers)
    lowest_cat_price = category_matched_offers[0]["price_usd"] if category_matched_offers else price_usd
    price_diff_usd = round(price_usd - lowest_cat_price, 2)
    price_diff_pct = round(((price_usd - lowest_cat_price) / lowest_cat_price) * 100, 1) if lowest_cat_price > 0 else 0.0

    # Топ-6 предложений в категории
    competitors = category_matched_offers[:6]

    # Формирование URL на рынок DMarket для всей категории флота с сортировкой по цене (дешевые первыми)
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
    market_url = f"https://dmarket.com/ingame-items/item-list/csgo-skins?{urllib.parse.urlencode(market_params)}"

    return {
        "offer_id": offer_id,
        "title": full_title,
        "base_title": base_title,
        "wear_name": wear_name,
        "wear_short": wear_cfg["short"],
        "phase": item_phase,
        "phase_display": phase_display,
        "float_val": float_val,
        "float_str": f"{float_val:.4f}" if float_val is not None else "N/A",
        "paint_seed": paint_seed,
        "image_url": image_url,
        "price_usd": price_usd,
        "price_str": f"${price_usd:.2f}",
        "category_key": float_cat["key"],
        "category_label": cat_label,
        "cat_min": cat_min,
        "cat_max": cat_max,
        "rank": user_cat_rank,
        "total_in_category": total_in_category,
        "rank_display": f"#{user_cat_rank} из {total_in_category}",
        "is_best_price": (user_cat_rank == 1),
        "lowest_cat_price": lowest_cat_price,
        "lowest_cat_price_str": f"${lowest_cat_price:.2f}",
        "price_diff_usd": price_diff_usd,
        "price_diff_pct": price_diff_pct,
        "buy_price": buy_price,
        "buy_price_str": buy_price_str,
        "profit_usd": profit_usd,
        "profit_pct": profit_pct,
        "competitors": competitors,
        "market_url": market_url,
        "offer_url": market_url  # По умолчанию открывает категорию флота
    }


def scan_all_user_offers(
        client: DMarketClient,
        progress_cb=None,
        stop_event: Optional[threading.Event] = None
) -> List[Dict[str, Any]]:
    """
    Сканирует все активные лоты пользователя и считает позиции.
    """
    if progress_cb:
        progress_cb(0, 100, "Загрузка истории покупок...")

    # Предзагрузка истории покупок/таргетов пользователя для определения цен покупки
    try:
        closed_targets = client.get_user_closed_targets(max_pages=5, limit=100)
        buy_history_map = {t['AssetID']: t for t in closed_targets if 'AssetID' in t}
        buy_history_title = {}
        for t in reversed(closed_targets):
            if t.get('Title'):
                buy_history_title[t.get('Title')] = t
    except Exception as e:
        print(f"[x] Ошибка загрузки истории покупок: {e}")
        buy_history_map = {}
        buy_history_title = {}

    if progress_cb:
        progress_cb(0, 100, "Загрузка активных лотов...")

    raw_offers = client.get_user_offers(game_id="a8db", limit=100)
    total_offers = len(raw_offers)

    if progress_cb:
        progress_cb(0, total_offers, f"Найдено {total_offers} активных лотов")

    results = []
    # Параллельный сбор по 4 потока для соблюдения лимитов DMarket 10 RPS
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(analyze_single_offer, client, raw, stop_event, buy_history_map, buy_history_title): raw 
            for raw in raw_offers
        }

        completed_count = 0
        for future in as_completed(futures):
            if stop_event and stop_event.is_set():
                break
            completed_count += 1
            try:
                res = future.result()
                if res:
                    results.append(res)
            except Exception as e:
                print(f"[x] Ошибка обработки лота: {e}")

            if progress_cb:
                progress_cb(completed_count, total_offers, f"Обработано {completed_count} из {total_offers} лотов")

    # Сортировка результатов по позиции (1, 2, 3...)
    results.sort(key=lambda x: (x["rank"], x["price_usd"]))
    return results
