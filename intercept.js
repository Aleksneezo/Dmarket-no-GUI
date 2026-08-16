// Interceptor injected in world: "MAIN" at document_start (cyberbebebe architecture)

(function() {
    console.log("[DMarket Interceptor] Network interceptor active in MAIN world.");

    function notify(url, data) {
        if (!data) return;
        try {
            window.postMessage({
                source: 'DMARKET_INTERCEPT',
                url: String(url),
                data: data
            }, '*');
        } catch (e) {}
    }

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
        console.log(`[DMarket In-Page Request] URL: ${url}`);

        const opts = args[1] || {};
        if (opts.headers) {
            let auth = '';
            if (typeof opts.headers.get === 'function') {
                auth = opts.headers.get('Authorization') || opts.headers.get('authorization');
            } else if (Array.isArray(opts.headers)) {
                for (const [k, v] of opts.headers) {
                    if (k && k.toLowerCase() === 'authorization') { auth = v; break; }
                }
            } else if (typeof opts.headers === 'object') {
                auth = opts.headers['Authorization'] || opts.headers['authorization'] || opts.headers['AUTHORIZATION'];
            }
            if (auth && String(auth).includes('.')) {
                const token = String(auth).replace(/^Bearer\s+/i, '').trim();
                notify('AUTH_TOKEN', { token: token });
            }
        }

        const response = await originalFetch.apply(this, args);
        try {
            if (url && (url.includes('dmarket.com') || url.includes('/marketplace-api/') || url.includes('/account/') || url.includes('/exchange/') || url.includes('/user/'))) {
                const clone = response.clone();
                clone.text().then(text => {
                    console.log(`[DMarket In-Page Response] URL: ${url} | Code: ${response.status} | Text:`, text);
                    try {
                        const data = JSON.parse(text);
                        notify(url, data);
                    } catch (e) {}
                }).catch(() => {});
            }
        } catch (e) {}
        return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        if (header && header.toLowerCase() === 'authorization' && String(value).startsWith('Bearer ')) {
            notify('AUTH_TOKEN', { token: String(value).replace('Bearer ', '').trim() });
        }
        return originalSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._interceptUrl = url;
        console.log(`[DMarket In-Page XHR Request] URL: ${url}`);
        return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            try {
                const url = this._interceptUrl || '';
                if (url && (url.includes('dmarket.com') || url.includes('/marketplace-api/') || url.includes('/account/') || url.includes('/exchange/') || url.includes('/user/'))) {
                    console.log(`[DMarket In-Page XHR Response] URL: ${url} | Code: ${this.status} | Text:`, this.responseText);
                    const data = JSON.parse(this.responseText);
                    notify(url, data);
                }
            } catch (e) {}
        });
        return originalSend.apply(this, args);
    };

    // Active user data collection directly from MAIN world
    async function triggerUserDataFetch() {
        const endpoints = [
            "https://api.dmarket.com/marketplace-api/v2/user/offers?game_id=a8db&limit=100&status=OfferStatusDefault",
            "https://api.dmarket.com/marketplace-api/v2/user/offers?game_id=a8db&limit=100",
            "https://api.dmarket.com/marketplace-api/v2/user/inventory?game_id=a8db&limit=100",
            "https://api.dmarket.com/marketplace-api/v1/user-targets/closed?limit=100",
            "https://api.dmarket.com/account/v1/user",
            "https://api.dmarket.com/account/v1/balance"
        ];

        for (const ep of endpoints) {
            try {
                console.log(`[DMarket In-Page Active Request] URL: ${ep}`);
                const resp = await originalFetch(ep, {
                    method: "GET",
                    credentials: "include",
                    headers: { "Accept": "application/json" }
                });
                const text = await resp.text();
                console.log(`[DMarket In-Page Active Response] URL: ${ep} | Code: ${resp.status} | Text:`, text);
                try {
                    const data = JSON.parse(text);
                    notify(ep, data);
                } catch (e) {}
            } catch (e) {
                console.error(`[DMarket In-Page Active Error] URL: ${ep} | Error:`, e.message);
            }
        }
    }

    function extractDMarketToken() {
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
                const parsed = JSON.parse(root);
                for (const sectionKey of Object.keys(parsed)) {
                    try {
                        const sec = typeof parsed[sectionKey] === 'string' ? JSON.parse(parsed[sectionKey]) : parsed[sectionKey];
                        if (sec && typeof sec === 'object') {
                            for (const k of Object.keys(sec)) {
                                const val = sec[k];
                                if (typeof val === 'string' && val.startsWith('eyJ') && val.split('.').length === 3) {
                                    return val;
                                }
                            }
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}

        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                const v = localStorage.getItem(k);
                if (v && typeof v === 'string') {
                    const match = v.match(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/);
                    if (match) return match[0];
                }
            }
        } catch (e) {}

        try {
            const match = document.cookie.match(/dmarket-jwt=([^;]+)/);
            if (match && match[1]) return decodeURIComponent(match[1]);
        } catch (e) {}

        return null;
    }

    function checkAndNotifyToken() {
        const token = extractDMarketToken();
        if (token) {
            notify('AUTH_TOKEN', { token: token });
        }
    }

    function init() {
        checkAndNotifyToken();
        setInterval(checkAndNotifyToken, 3000);

        const nextScript = document.getElementById('__NEXT_DATA__');
        if (nextScript) {
            try {
                const nextJson = JSON.parse(nextScript.textContent);
                notify(window.location.href, nextJson);
            } catch (e) {}
        }

        setTimeout(triggerUserDataFetch, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
