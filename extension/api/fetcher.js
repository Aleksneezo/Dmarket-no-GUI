import { DMarketLogger } from './logger.js';
import { getDMarketAuth } from './auth.js';

let _tabBroken = false;

export async function fetchViaDMarketTab(fullUrl, options = {}) {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) {
        return null;
    }
    try {
        const allTabs = await new Promise(resolve => chrome.tabs.query({}, res => resolve(res || [])));
        const dmarketTab = allTabs.find(t => t.url && (t.url.includes('dmarket.com') || t.url.includes('dmarket')));
        if (!dmarketTab) {
            return null;
        }

        const serializedOptions = {
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body || null
        };

        const results = await chrome.scripting.executeScript({
            target: { tabId: dmarketTab.id },
            func: async (url, opts) => {
                try {
                    const reqHeaders = { 'Accept': 'application/json, text/plain, */*', ...(opts.headers || {}) };
                    if (opts.body && !reqHeaders['Content-Type']) {
                        reqHeaders['Content-Type'] = 'application/json';
                    }

                    let token = null;
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
                                            token = val;
                                            break;
                                        }
                                    }
                                }
                                if (token) break;
                            }
                        }
                    } catch (e) {}

                    if (!token) {
                        for (const k of ['token', 'dmarket-jwt', 'jwt', 'auth_token', 'accessToken']) {
                            const v = localStorage.getItem(k) || sessionStorage.getItem(k);
                            if (v && typeof v === 'string' && v.includes('.')) {
                                token = v.replace(/^["']|["']$/g, '');
                                break;
                            }
                        }
                    }

                    if (token && !reqHeaders['Authorization']) {
                        reqHeaders['Authorization'] = `Bearer ${token.replace(/^Bearer\s+/i, '')}`;
                    }

                    const res = await fetch(url, {
                        method: opts.method || 'GET',
                        headers: reqHeaders,
                        credentials: 'include',
                        body: opts.body || undefined
                    });

                    const text = await res.text();
                    let data = null;
                    try { data = JSON.parse(text); } catch (e) { data = text; }

                    return {
                        ok: res.ok,
                        status: res.status,
                        data: data,
                        text: text,
                        tokenFound: Boolean(token)
                    };
                } catch (err) {
                    return {
                        ok: false,
                        status: 0,
                        error: err.message,
                        data: null,
                        text: ''
                    };
                }
            },
            args: [fullUrl, serializedOptions]
        });

        if (results && results[0] && results[0].result) {
            return results[0].result;
        }
        return null;
    } catch (e) {
        return null;
    }
}

export async function fetchWithAuth(url, options = {}) {
    const method = options.method || 'GET';
    const fullUrl = url.startsWith('http') ? url : `https://api.dmarket.com${url}`;

    // 1. Выполняем нативный запрос прямо через открытую вкладку dmarket.com
    if (!_tabBroken) {
        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 4000));
        const inTabRes = await Promise.race([fetchViaDMarketTab(fullUrl, options), timeoutPromise]);
        
        if (inTabRes === 'TIMEOUT') {
            DMarketLogger.logDebug(`[fetchViaTab] Ошибка: таймаут скрипта, вкладка dmarket.com недоступна.`);
            _tabBroken = true;
        } else if (inTabRes && inTabRes.status > 0) {
            const logMsg = `[fetchViaTab] ${method} ${fullUrl.split('?')[0]} -> HTTP ${inTabRes.status}`;
            DMarketLogger.logDebug(logMsg, inTabRes.status !== 200 ? { status: inTabRes.status, text: (inTabRes.text || '').slice(0, 200) } : null);
            if (inTabRes.ok) {
                return inTabRes;
            }
        }
    }

    // 2. Фоллбек: прямой fetch из контекста расширения
    const auth = await getDMarketAuth();
    const headers = {
        'Accept': 'application/json, text/plain, */*',
        ...(options.headers || {})
    };

    if (auth.jwt) {
        const cleanJwt = auth.jwt.trim().replace(/^Bearer\s+/i, '');
        headers['Authorization'] = `Bearer ${cleanJwt}`;
    }

    const config = {
        method: method,
        headers: headers
    };

    if (options.body) {
        config.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        if (!headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
    }

    try {
        let response = await fetch(fullUrl, config);
        let text = await response.text();

        // Если получаем 401 с токеном, вероятно токен отозван сервером (хоть и не истек локально)
        if (response.status === 401 && auth.jwt) {
            DMarketLogger.logDebug(`[fetchDirect] 401 Unauthorized. Токен устарел или отозван сервером. Удаляем...`);
            if (typeof chrome !== 'undefined' && chrome.storage) {
                chrome.storage.local.remove(['dmJwt', 'dmToken', 'dmUserToken']);
            }
            // Делаем retry без JWT (fallback на cookies, которые браузер шлет сам)
            const retryConfig = { ...config };
            delete retryConfig.headers['Authorization'];
            response = await fetch(fullUrl, retryConfig);
            text = await response.text();
            DMarketLogger.logDebug(`[fetchDirect] Retry без JWT -> HTTP ${response.status}`);
        }

        let data = null;
        try {
            data = JSON.parse(text);
        } catch (e) {
            data = text;
        }

        const logMsg = `[fetchDirect] ${method} ${fullUrl.split('?')[0]} -> HTTP ${response.status} (JWT: ${auth.jwt ? 'OK' : 'НЕТ'})`;
        DMarketLogger.logDebug(logMsg, response.status !== 200 ? { status: response.status, text: text.slice(0, 200) } : null);

        return {
            ok: response.ok,
            status: response.status,
            data: data,
            text: text
        };
    } catch (error) {
        DMarketLogger.logDebug(`[fetchDirect Error] ${method} ${fullUrl}: ${error.message}`);
        return {
            ok: false,
            status: 0,
            error: error.message,
            data: null,
            text: ''
        };
    }
}
