// Content script running in world: "ISOLATED" (архитектура cyberbebebe)

(function () {
    console.log("[DMarket Content] Bridge active in ISOLATED world.");

    const CS2_KEYWORDS = [
        "AK-47", "M4A4", "M4A1-S", "AWP", "USP-S", "Glock-18", "Desert Eagle", "Deagle",
        "Galil AR", "FAMAS", "SSG 08", "SG 553", "AUG", "MP9", "MAC-10", "MP7",
        "MP5-SD", "UMP-45", "P90", "PP-Bizon", "Nova", "XM1014", "MAG-7",
        "Sawed-Off", "M249", "Negev", "P250", "Five-SeveN", "CZ75-Auto", "Tec-9",
        "R8 Revolver", "Dual Berettas", "Karambit", "Butterfly Knife", "Bayonet", "Flip Knife",
        "Gut Knife", "Huntsman Knife", "Falchion Knife", "Shadow Daggers", "Bowie Knife",
        "Ursus Knife", "Navaja Knife", "Stiletto Knife", "Talon Knife", "Classic Knife",
        "Skeleton Knife", "Nomad Knife", "Survival Knife", "Paracord Knife", "Kukri Knife",
        "Sport Gloves", "Specialist Gloves", "Driver Gloves", "Hand Wraps", "Moto Gloves",
        "Hydra Gloves", "Bloodhound Gloves", "Broken Fang Gloves", "Case", "Sticker",
        "Capsule", "Music Kit", "Patch", "Pin", "★"
    ];

    function isRealSkin(str) {
        if (!str || typeof str !== 'string') return false;
        const low = str.toLowerCase();
        if (low.includes("marketplace") || low.includes("dmarket") || low.includes("buy cs2") || low.includes("privacy") || low.includes("terms") || low.includes("cookie") || low.includes("copyright")) {
            return false;
        }
        return str.includes("|") || str.includes("★");
    }

    function saveItems(newItems) {
        if (!Array.isArray(newItems) || newItems.length === 0) return;

        chrome.storage.local.get(["dmInterceptedItems"], (res) => {
            const existing = (res.dmInterceptedItems || []).filter(x => {
                const t = x.title || (x.attributes && x.attributes.title) || x.name || '';
                return t.includes('|') || t.includes('★');
            });
            const merged = [...newItems.filter(x => {
                const t = x.title || (x.attributes && x.attributes.title) || x.name || '';
                return t.includes('|') || t.includes('★');
            })];
            const seen = new Set(merged.map(x => x.offerId || x.id || x.itemId || x.assetId || (x.title + x.price_usd)));

            existing.forEach(ex => {
                const key = ex.offerId || ex.id || ex.itemId || ex.assetId || (ex.title + ex.price_usd);
                if (!seen.has(key)) {
                    seen.add(key);
                    merged.push(ex);
                }
            });

            chrome.storage.local.set({
                dmInterceptedItems: merged,
                dmLastSync: Date.now()
            });
        });
    }

    // Слушатель перехваченных данных из MAIN world (intercept.js)
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.source !== 'DMARKET_INTERCEPT') return;

        const { url, data } = event.data;
        if (!data) return;

        // Поиск предметов в полученных данных
        const candidateItems = [];

        function scan(obj, depth = 0) {
            if (!obj || depth > 8) return;
            if (Array.isArray(obj)) {
                obj.forEach(item => scan(item, depth + 1));
                return;
            }
            if (typeof obj === 'object') {
                const title = obj.title || obj.name || obj.Title || (obj.attributes && obj.attributes.title);
                const hasId = obj.offerId || obj.itemId || obj.id || obj.assetId;
                if (title && typeof title === 'string' && isRealSkin(title) && hasId) {
                    candidateItems.push(obj);
                }
                for (const k in obj) {
                    if (typeof obj[k] === 'object') scan(obj[k], depth + 1);
                }
            }
        }

        scan(data);
        if (candidateItems.length > 0) {
            saveItems(candidateItems);
        }

        // Токен авторизации Bearer JWT
        if (url === 'AUTH_TOKEN' && data && data.token) {
            console.log("[DMarket Content] Captured active Bearer JWT token from web session");
            chrome.storage.local.set({ dmJwt: data.token, dmUserToken: data.token });
            return;
        }

        // Профиль и баланс
        if (url.includes('/account/v1/user') || (data.username && (data.id || data.userId))) {
            chrome.storage.local.set({ dmUserProfile: data });
        }
        if (url.includes('/account/v1/balance') || data.usd !== undefined) {
            chrome.storage.local.set({ dmUserBalance: data });
        }
    });

    // Плавающая кнопка
    function injectFloatingButton() {
        if (document.getElementById("dm-tracker-floating-btn")) return;

        const btn = document.createElement("div");
        btn.id = "dm-tracker-floating-btn";
        btn.innerHTML = `
            <div style="
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 999999;
                background: #111722;
                border: 1px solid #3b82f6;
                border-radius: 8px;
                padding: 10px 14px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.6);
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                color: #f3f4f6;
                font-size: 12px;
                font-weight: 600;
                transition: transform 0.2s, background 0.2s;
            ">
                <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#34d399; box-shadow:0 0 6px #34d399;"></span>
                <span>Float Tracker</span>
            </div>
        `;

        btn.addEventListener("click", () => {
            try {
                if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
                    chrome.runtime.sendMessage({ action: "OPEN_DASHBOARD" });
                }
            } catch (e) { }
        });

        btn.addEventListener("mouseenter", () => {
            if (btn.firstElementChild) {
                btn.firstElementChild.style.transform = "scale(1.05)";
                btn.firstElementChild.style.background = "#161e2e";
            }
        });

        btn.addEventListener("mouseleave", () => {
            if (btn.firstElementChild) {
                btn.firstElementChild.style.transform = "scale(1)";
                btn.firstElementChild.style.background = "#111722";
            }
        });

        document.body.appendChild(btn);
    }

    // Слушатель запросов от дашборда на получение токена
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'GET_AUTH_TOKEN' || request.action === 'SYNC_SESSION') {
                chrome.storage.local.get(['dmJwt', 'dmUserProfile', 'dmUserBalance', 'dmInterceptedItems'], (res) => {
                    sendResponse(res || {});
                });
                return true;
            }
        });
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        injectFloatingButton();
    } else {
        window.addEventListener("DOMContentLoaded", injectFloatingButton);
    }
})();
