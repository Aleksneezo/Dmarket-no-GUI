import { DMarketLogger } from './logger.js';

export function decodeAndValidateJwt(token) {
    if (!token || typeof token !== 'string') return null;
    const clean = token.trim().replace(/^Bearer\s+/i, '');
    const parts = clean.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(atob(parts[1]));
        const isExpired = payload.exp && (payload.exp * 1000 < Date.now());
        return {
            valid: !isExpired,
            expired: Boolean(isExpired),
            expDate: payload.exp ? new Date(payload.exp * 1000) : null,
            payload
        };
    } catch (e) {
        return null;
    }
}

// Глобальные состояния, которые раньше были в классе
let _bgRefreshPromise = null;
let _lastBgRefresh = 0;

export async function getDMarketAuth() {
    let jwt = null;
    let cookieStr = '';

    // 1. Проверяем chrome.storage.local
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
            const st = await new Promise((resolve) => {
                chrome.storage.local.get(['dmJwt', 'dmToken', 'dmUserToken', 'dmCookies', 'dmUserProfile'], (res) => resolve(res || {}));
            });
            const cand = st.dmJwt || st.dmToken || st.dmUserToken || null;
            if (cand) {
                const valRes = decodeAndValidateJwt(cand);
                if (valRes && valRes.valid) {
                    jwt = cand;
                } else if (valRes && valRes.expired) {
                    DMarketLogger.logDebug(`[Auth] Сохраненный JWT токен истек (${valRes.expDate.toLocaleTimeString()}), обновляем...`);
                    chrome.storage.local.remove(['dmJwt', 'dmToken', 'dmUserToken']);
                }
            }
            if (st.dmCookies) cookieStr = st.dmCookies;
        } catch (e) {}
    }

    // 2. Если токена нет, извлекаем напрямую из открытой вкладки dmarket.com
    if (!jwt && typeof chrome !== 'undefined' && chrome.tabs && chrome.scripting) {
        try {
            const allTabs = await new Promise(resolve => chrome.tabs.query({}, res => resolve(res || [])));
            const tabs = allTabs.filter(t => t.url && (t.url.includes('dmarket.com') || t.url.includes('dmarket')));
            if (tabs && tabs.length > 0) {
                const tabId = tabs[0].id;
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 4000));
                const results = await Promise.race([
                    chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        func: () => {
                            // 1. Проверяем Redux store
                            try {
                                const root = localStorage.getItem('persist:root');
                                if (root) {
                                    const p = JSON.parse(root);
                                    for (const sk of Object.keys(p)) {
                                        const sec = typeof p[sk] === 'string' ? JSON.parse(p[sk]) : p[sk];
                                        if (sec && typeof sec === 'object') {
                                            for (const k of Object.keys(sec)) {
                                                const val = sec[k];
                                                if (typeof val === 'string' && val.startsWith('eyJ') && val.split('.').length === 3) {
                                                    return val;
                                                }
                                            }
                                        }
                                    }
                                }
                            } catch (e) {}

                            // 2. Проверяем ключи localStorage
                            for (const k of ['token', 'dmarket-jwt', 'jwt', 'auth_token', 'accessToken', 'idToken']) {
                                const v = localStorage.getItem(k) || sessionStorage.getItem(k);
                                if (v && typeof v === 'string' && v.length > 20 && v.includes('.')) {
                                    return v.replace(/^["']|["']$/g, '');
                                }
                            }

                            // 3. Сканируем все ключи
                            for (let i = 0; i < localStorage.length; i++) {
                                const v = localStorage.getItem(localStorage.key(i));
                                if (v && typeof v === 'string') {
                                    const m = v.match(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/);
                                    if (m) return m[0];
                                }
                            }
                            return null;
                        }
                    }),
                    timeoutPromise
                ]);
                if (results && results[0] && results[0].result) {
                    const extracted = results[0].result;
                    const vRes = decodeAndValidateJwt(extracted);
                    if (vRes && vRes.valid) {
                        jwt = extracted;
                        chrome.storage.local.set({ dmJwt: jwt, dmUserToken: jwt });
                        DMarketLogger.logDebug(`[Auth] Свежий JWT токен успешно извлечен из вкладки dmarket.com!`);
                    }
                }
            }
        } catch (e) {
            console.log('[getDMarketAuth] Scripting extract error:', e);
        }
    }

    // 3. Проверяем куки браузера
    if (typeof chrome !== 'undefined' && chrome.cookies) {
        try {
            const cookieList = await new Promise((resolve) => {
                chrome.cookies.getAll({}, (res) => resolve(res || []));
            });
            const dmCookies = cookieList.filter(c => c.domain && c.domain.includes('dmarket'));
            const parts = [];
            const seenNames = new Set();
            for (const c of dmCookies) {
                if (!seenNames.has(c.name)) {
                    seenNames.add(c.name);
                    parts.push(`${c.name}=${c.value}`);
                }
                const nameLow = c.name.toLowerCase();
                if (!jwt && (nameLow === 'dmarket-jwt' || nameLow === 'jwt' || nameLow === 'token' || nameLow === 'session' || nameLow === 'auth_token')) {
                    if (c.value && c.value.length > 20 && c.value.includes('.')) {
                        const vRes = decodeAndValidateJwt(c.value);
                        if (vRes && vRes.valid) {
                            jwt = c.value;
                        }
                    }
                }
            }
            if (parts.length > 0 && !cookieStr) cookieStr = parts.join('; ');
        } catch (e) {}
    }
    // 4. Если токена все еще нет, пытаемся открыть фоновую вкладку для обновления (раз в 2 минуты)
    if (!jwt && typeof chrome !== 'undefined' && chrome.tabs && chrome.scripting) {
        const now = Date.now();
        // Блокировка от одновременных вызовов
        if (_bgRefreshPromise) {
            await _bgRefreshPromise;
            const st = await new Promise((resolve) => chrome.storage.local.get(['dmJwt'], res => resolve(res || {})));
            if (st.dmJwt) jwt = st.dmJwt;
        } else if (!_lastBgRefresh || (now - _lastBgRefresh > 120000)) {
            _bgRefreshPromise = (async () => {
                _lastBgRefresh = now;
                DMarketLogger.logDebug("[Auth] Токен не найден или истек. Открываем фоновую вкладку DMarket для обновления сессии...");
                
                try {
                    const bgTab = await new Promise(resolve => chrome.tabs.create({ url: 'https://dmarket.com', active: false }, t => resolve(t)));
                    
                    // Ждем 6 секунд загрузки страницы и работы JS сайта
                    await new Promise(r => setTimeout(r, 6000));
                    
                    let results = null;
                    try {
                        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000));
                        results = await Promise.race([
                            chrome.scripting.executeScript({
                                target: { tabId: bgTab.id },
                                func: () => {
                                    for (const key of ['token', 'dmarket-jwt', 'jwt', 'auth_token', 'accessToken', 'idToken']) {
                                        try {
                                            const val = localStorage.getItem(key) || sessionStorage.getItem(key);
                                            if (val && typeof val === 'string' && val.length > 20) {
                                                const cleaned = val.replace(/^["']|["']$/g, '');
                                                if (cleaned.startsWith('eyJ')) return cleaned;
                                            }
                                        } catch (e) {}
                                    }
                                    
                                    try {
                                        const root = localStorage.getItem('persist:root');
                                        if (root) {
                                            const p = JSON.parse(root);
                                            for (const sk of Object.keys(p)) {
                                                const sec = typeof p[sk] === 'string' ? JSON.parse(p[sk]) : p[sk];
                                                if (sec && typeof sec === 'object') {
                                                    for (const k of Object.keys(sec)) {
                                                        const val = sec[k];
                                                        if (typeof val === 'string' && val.startsWith('eyJ') && val.split('.').length === 3) {
                                                            return val;
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    } catch (e) {}
                                    return null;
                                }
                            }),
                            timeoutPromise
                        ]);
                    } catch (err) {
                        DMarketLogger.logDebug("[Auth] executeScript failed or timed out: " + err.message);
                    } finally {
                        try {
                            chrome.tabs.remove(bgTab.id);
                        } catch (e) {}
                    }
                    
                    if (results && results[0] && results[0].result) {
                        const extracted = results[0].result;
                        const vRes = decodeAndValidateJwt(extracted);
                        if (vRes && vRes.valid) {
                            jwt = extracted;
                            chrome.storage.local.set({ dmJwt: jwt, dmUserToken: jwt });
                            DMarketLogger.logDebug("[Auth] Успешно извлечен свежий токен из фоновой вкладки!");
                        } else {
                            DMarketLogger.logDebug("[Auth] Извлеченный из фоновой вкладки токен недействителен.");
                        }
                    } else {
                        DMarketLogger.logDebug("[Auth] Не удалось получить токен из фоновой вкладки (пользователь не авторизован).");
                    }
                } catch (e) {
                    DMarketLogger.logDebug("[Auth] Ошибка работы с фоновой вкладкой: " + e.message);
                }
            })();
            await _bgRefreshPromise;
            _bgRefreshPromise = null;
        }
    }

    return { jwt, cookieStr };
}
