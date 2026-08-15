from typing import Dict, Any, List, Optional, Tuple
import re

# Стандартные CS2 тиры флоатов (от минимального флоата качества до верхней границы тира)
WEAR_CONFIGS: Dict[str, Dict[str, Any]] = {
    "Factory New": {
        "short": "FN",
        "dmarket_exterior": "factory new",
        "total_range": (0.00, 0.07),
        "tiers": [0.01, 0.02, 0.03, 0.07]
    },
    "Minimal Wear": {
        "short": "MW",
        "dmarket_exterior": "minimal wear",
        "total_range": (0.07, 0.15),
        "tiers": [0.08, 0.09, 0.10, 0.12, 0.15]
    },
    "Field-Tested": {
        "short": "FT",
        "dmarket_exterior": "field-tested",
        "total_range": (0.15, 0.38),
        "tiers": [0.18, 0.21, 0.24, 0.27, 0.38]
    },
    "Well-Worn": {
        "short": "WW",
        "dmarket_exterior": "well-worn",
        "total_range": (0.38, 0.45),
        "tiers": [0.40, 0.42, 0.45]
    },
    "Battle-Scarred": {
        "short": "BS",
        "dmarket_exterior": "battle-scarred",
        "total_range": (0.45, 1.00),
        "tiers": [0.50, 0.60, 0.75, 0.90, 1.00]
    }
}


def detect_wear_from_title(title: str) -> Tuple[str, str]:
    """
    Извлекает базовое название скина и износ из заголовка (например, '★ M9 Bayonet | Lore (Field-Tested)').
    Возвращает (base_title, wear_name).
    """
    for wear_name in WEAR_CONFIGS.keys():
        pattern = rf"\s*\({re.escape(wear_name)}\)\s*$"
        if re.search(pattern, title, re.IGNORECASE):
            clean_title = re.sub(pattern, "", title, flags=re.IGNORECASE).strip()
            return clean_title, wear_name

    for wear_name, cfg in WEAR_CONFIGS.items():
        if f"({cfg['short']})" in title:
            clean_title = title.replace(f"({cfg['short']})", "").strip()
            return clean_title, wear_name

    return title, "Field-Tested"


def get_float_category(wear_name: str, float_val: Optional[float] = None) -> Dict[str, Any]:
    """
    Определяет диапазон от МИНИМАЛЬНОГО флоата качества до текущей верхней границы тира
    (например, для FT с float 0.225 -> диапазон 0.15 - 0.24).
    """
    cfg = WEAR_CONFIGS.get(wear_name, WEAR_CONFIGS["Field-Tested"])
    min_wear_float = cfg["total_range"][0]
    max_wear_float = cfg["total_range"][1]
    tiers = cfg.get("tiers", [max_wear_float])

    if float_val is None:
        return {
            "key": cfg["short"].lower(),
            "label": f"{min_wear_float:.2f} - {max_wear_float:.2f}",
            "min": min_wear_float,
            "max": max_wear_float
        }

    # Находим верхнюю границу тира, в которую попадает флоат
    selected_upper = max_wear_float
    for t_max in tiers:
        if float_val <= (t_max + 1e-6):
            selected_upper = t_max
            break

    label = f"{min_wear_float:.2f} - {selected_upper:.2f}"
    return {
        "key": f"{cfg['short'].lower()}_{min_wear_float}_{selected_upper}",
        "label": label,
        "min": min_wear_float,
        "max": selected_upper
    }
