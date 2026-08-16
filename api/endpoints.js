import { DMarketLogger } from './logger.js';
import { getDMarketAuth } from './auth.js';
import { fetchWithAuth } from './fetcher.js';

class DMarketAPI {
    static BASE_URL = "https://api.dmarket.com";
    static cachedProfile = null;

    static logDebug(msg, data = null) {
        DMarketLogger.logDebug(msg, data);
    }

    // Get user profile
    static async getUserProfile() {
        if (this.cachedProfile) return this.cachedProfile;

        try {
            const res = await fetchWithAuth(`${this.BASE_URL}/account/v1/user`);
            if (res.ok && res.data && (res.data.username || res.data.email || res.data.id || res.data.userId)) {
                this.cachedProfile = res.data;
                this.logDebug("Profile successfully fetched:", res.data.username || res.data.email);
                return res.data;
            }
            const balRes = await fetchWithAuth(`${this.BASE_URL}/account/v1/balance`);
            if (balRes.ok && balRes.data) {
                return balRes.data;
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    // Get user active offers
    static async getUserOffers(gameId = "a8db", pageSize = 100) {
        const auth = await getDMarketAuth();
        this.logDebug(`Fetching active user offers (JWT: )...`);

        // Endpoints to check
        const endpoints = [
            {
                name: "marketplace-api/v2/user/offers",
                url: `${this.BASE_URL}/marketplace-api/v2/user/offers?game_id=${gameId}&limit=${pageSize}&status=OfferStatusDefault`
            },
            {
                name: "exchange/v1/user/offers/v2",
                url: `${this.BASE_URL}/exchange/v1/user/offers/v2?orderBy=updated&orderDir=desc&title=&priceFrom=0&priceTo=0&treeFilters=&gameId=${gameId}&currency=USD&platform=browser&pageSize=${pageSize}&pageToken=`
            },
            {
                name: "marketplace-api/v2/user/inventory",
                url: `${this.BASE_URL}/marketplace-api/v2/user/inventory?gameId=${gameId}&BasicFilters.Status=OfferStatusDefault&limit=${pageSize}`
            },
            {
                name: "exchange/v1/user/inventory",
                url: `${this.BASE_URL}/exchange/v1/user/inventory?gameId=${gameId}&status=OfferStatusDefault&limit=${pageSize}`
            }
        ];

        for (const ep of endpoints) {
            try {
                const res = await fetchWithAuth(ep.url);
                if (res.ok && res.data) {
                    const list = res.data.items || res.data.offers || res.data.objects || res.data.Items || res.data.Offers || (Array.isArray(res.data) ? res.data : []);
                    if (Array.isArray(list) && list.length > 0) {
                        this.logDebug(`Successfully received  items via !`);
                        return list;
                    }
                }
            } catch (e) {
                this.logDebug(`Request error : `);
            }
        }

        // Fallback: saved interceptor cache (only valid skins with ID)
        try {
            let stored = await chrome.storage.local.get(["dmInterceptedItems"]);
            if (stored.dmInterceptedItems && Array.isArray(stored.dmInterceptedItems)) {
                const validItems = stored.dmInterceptedItems.filter(item => {
                    const title = item.title || (item.attributes && item.attributes.title) || item.name || '';
                    const hasId = item.offerId || item.itemId || item.id || item.assetId;
                    return (title.includes('|') || title.includes('★')) && hasId;
                });
                if (validItems.length > 0) {
                    this.logDebug(`Used saved cache:  items`);
                    return validItems;
                }
            }
        } catch (e) {}

        if (!auth.jwt) {
            this.logDebug("WARNING: JWT token not found. Please open the dmarket.com tab and refresh it (F5).");
        } else {
            this.logDebug("All endpoints returned 0 offers. Make sure you have active offers (On Sale) on DMarket.");
        }

        return [];
    }

    // Closed trades (purchase history for P&L) via fetchWithAuth
    static async getUserClosedTargets(maxPages = 5, limit = 100) {
        const trades = [];
        
        // Main method: get history via general history endpoint (including direct buys and targets)
        try {
            let offset = 0;
            const newLimit = 500;
            for (let i = 0; i < maxPages; i++) {
                const path = `/exchange/v1/history?activities=purchase,target_closed&statuses=success,trade_protected&sortBy=updatedAt&limit=${newLimit}&offset=${offset}`;
                const res = await fetchWithAuth(`${this.BASE_URL}${path}`);
                if (res.ok && res.data && res.data.objects) {
                    for (const obj of res.data.objects) {
                        if (obj && (obj.details?.itemId || obj.details?.assetId || obj.assetId || obj.itemId)) {
                            trades.push({
                                assetId: obj.details?.itemId || obj.details?.assetId || obj.assetId || obj.itemId,
                                Title: obj.subject || "",
                                price_usd: (obj.changes && obj.changes[0] && obj.changes[0].money) ? parseFloat(obj.changes[0].money.amount) : 0 
                            });
                        }
                    }
                    if (res.data.objects.length < newLimit) break;
                    offset += newLimit;
                } else {
                    break;
                }
            }
        } catch (e) {
            this.logDebug("Error fetching new purchase history: " + e.message);
        }

        // Fallback: old endpoint (only closed targets), if new returned nothing
        if (trades.length === 0) {
            let cursor = "";
            for (let i = 0; i < maxPages; i++) {
                let path = `/marketplace-api/v1/user-targets/closed?limit=${limit}`;
                if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
                try {
                    const res = await fetchWithAuth(`${this.BASE_URL}${path}`);
                    if (res.ok && res.data) {
                        const list = res.data.Trades || res.data.trades || [];
                        trades.push(...list);
                        cursor = res.data.Cursor || res.data.cursor || "";
                        if (!cursor || list.length < limit) break;
                    } else {
                        break;
                    }
                } catch (e) {
                    break;
                }
            }
        }
        
        this.logDebug(`Successfully received  records from purchase history.`);
        return trades;
    }

    // Search competitor offers on market (like v1, plus Orderbook API)
    static async getMarketOffers(title, exterior = null, phase = null, treeFiltersExtra = null, limit = 100, floatPartValue = null, exactFullTitle = null) {
        const cleanTitle = title.replace(/^[★*]\s*/, '').trim();

        if (exactFullTitle) {
            const depthParams = new URLSearchParams({
                gameId: "a8db",
                title: exactFullTitle,
                currency: "USD"
            });
            const depthFilters = [];
            if (floatPartValue) depthFilters.push(`floatPartValue[]=${floatPartValue}`);
            depthFilters.push("paintSeed[]=any");
            if (phase) depthFilters.push(`phase[]=${phase}`);
            
            depthParams.set("filters", depthFilters.join(","));
            
            const depthUrl = `${this.BASE_URL}/exchange/v1/market/depth/v2?${depthParams.toString()}`;
            try {
                const res = await fetch(depthUrl);
                const text = await res.text();
                let data = null;
                try { data = JSON.parse(text); } catch (e) { data = text; }
                if (res.ok && data) {
                    return data;
                }
            } catch (e) {}
        }

        const filters = [];
        if (exterior) filters.push(`exterior[]=${exterior}`);
        if (phase) filters.push(`phase[]=${phase}`);
        if (treeFiltersExtra) filters.push(treeFiltersExtra);

        // 1. Main endpoint v2 like in Python (most reliable for treeFilters)
        const params1 = new URLSearchParams({
            gameId: "a8db",
            title: cleanTitle,
            orderBy: "price",
            orderDir: "asc",
            limit: String(limit)
        });
        if (filters.length > 0) {
            params1.set("treeFilters", filters.join(","));
        }

        const url1 = `${this.BASE_URL}/marketplace-api/v2/offers?${params1.toString()}`;
        try {
            const res = await fetch(url1);
            const text = await res.text();
            let data = null;
            try { data = JSON.parse(text); } catch (e) { data = text; }
            if (res.ok && data) {
                const list = data.objects || data.items || data.offers || data.Items || data.Offers || [];
                if (list.length > 0) return data;
            }
        } catch (e) {}

        // 2. Fallback to new endpoint exchange/v1 (sometimes works better without treeFilters)
        const params2 = new URLSearchParams({
            gameId: "a8db",
            title: cleanTitle,
            currency: "USD",
            orderBy: "price",
            orderDir: "asc",
            limit: String(limit)
        });
        if (filters.length > 0) {
            params2.set("treeFilters", filters.join(","));
        }
        
        const url2 = `${this.BASE_URL}/exchange/v1/market/items?${params2.toString()}`;
        try {
            const res = await fetch(url2);
            const text = await res.text();
            let data = null;
            try { data = JSON.parse(text); } catch (e) { data = text; }
            if (res.ok && data) {
                const list = data.objects || data.items || data.offers || data.Items || data.Offers || [];
                if (list.length > 0) return data;
            }
        } catch (e) {}

        // 3. Search without exterior/phase filters entirely (broadest fallback)
        const params3 = new URLSearchParams({
            gameId: "a8db",
            title: cleanTitle,
            orderBy: "price",
            orderDir: "asc",
            limit: String(limit)
        });
        const url3 = `${this.BASE_URL}/marketplace-api/v2/offers?${params3.toString()}`;
        try {
            const res = await fetch(url3);
            const text = await res.text();
            let data = null;
            try { data = JSON.parse(text); } catch (e) { data = text; }
            if (res.ok && data) {
                return data;
            }
            return null;
        } catch (e) {
            return null;
        }
        return {};
    }
    // Change offer price (Reprice) via native PATCH /exchange/v1/offers
    static async editOfferPrice(offerId, priceUsd, altIds = []) {
        const priceCents = Math.round(priceUsd * 100);
        const priceCentsStr = String(priceCents);
        const idsToTry = Array.from(new Set([offerId, ...altIds].filter(Boolean)));

        this.logDebug(`[editOfferPrice] Price update request to {priceUsd.toFixed(2)} (¢, offerId=)`);

        // 1. Main native web method DMarket: PATCH /exchange/v1/offers
        for (const targetId of idsToTry) {
            const urlExchange = `${this.BASE_URL}/exchange/v1/offers`;
            const payload = {
                force: true,
                objects: [
                    {
                        offerId: targetId,
                        price: {
                            amount: priceCentsStr,
                            currency: "USD"
                        },
                        selectedPricePreset: "custom"
                    }
                ]
            };

            try {
                const res = await fetchWithAuth(urlExchange, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                const respText = res.text ? res.text.trim() : '';
                this.logDebug(`[editOfferPrice] PATCH /exchange/v1/offers (${targetId}) -> HTTP ${res.status}: ${respText}`);

                if (res.ok || res.status === 200 || res.status === 201 || res.status === 204) {
                    if (!res.data || !res.data.error || res.data.success) {
                        this.logDebug(`[editOfferPrice] Price successfully updated via PATCH /exchange/v1/offers!`);
                        return { success: true, data: res.data || {} };
                    }
                }
            } catch (e) {
                this.logDebug(`[editOfferPrice] PATCH error: `);
            }
        }

        // 2. Fallback: v2 batchUpdate
        for (const tid of idsToTry) {
            const urlV2 = `${this.BASE_URL}/marketplace-api/v2/offers:batchUpdate`;
            try {
                const resV2 = await fetchWithAuth(urlV2, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        requests: [{ offerId: tid, price_cents: priceCents }]
                    })
                });
                const respTextV2 = resV2.text ? resV2.text.trim() : '';
                this.logDebug(`[editOfferPrice] v2 batchUpdate (${tid}) -> HTTP ${resV2.status}: ${respTextV2}`);
                if (resV2.ok && resV2.data) {
                    const failed = resV2.data.failed || [];
                    if (failed.length > 0) {
                        const firstFail = failed[0];
                        const msg = firstFail.message || firstFail.code || "";
                        if (msg.includes("NewOfferHasSamePriceAndFees") || msg === "NewOfferHasSamePriceAndFees") {
                            return { success: true, data: resV2.data, message: "Price is already set to this level" };
                        }
                    } else {
                        return { success: true, data: resV2.data };
                    }
                }
            } catch (e) {}
        }

        // 3. Fallback: v1 user-offers/edit
        for (const tid of idsToTry) {
            const urlV1 = `${this.BASE_URL}/marketplace-api/v1/user-offers/edit`;
            try {
                const resV1 = await fetchWithAuth(urlV1, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        Offers: [{ OfferId: tid, Price: { Currency: "USD", Amount: priceUsd } }]
                    })
                });
                const respTextV1 = resV1.text ? resV1.text.trim() : '';
                this.logDebug(`[editOfferPrice] v1 user-offers/edit (${tid}) -> HTTP ${resV1.status}: ${respTextV1}`);
                if (resV1.ok && resV1.data) {
                    return { success: true, data: resV1.data };
                }
            } catch (e) {}
        }

        return { success: false, error: "Failed to update offer price. Details in 'API Log'." };
    }

    // Buy competitor offer via fetchWithAuth
    static async buyMarketOffer(offerId, priceUsd) {
        const url = `${this.BASE_URL}/exchange/v1/offers-buy`;
        const priceCents = Math.round(priceUsd * 100);
        const payload = {
            offers: [
                {
                    offerId: offerId,
                    price: { currency: "USD", amount: priceCents }
                }
            ]
        };

        try {
            let res = await fetchWithAuth(url, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (res.status === 405) {
                res = await fetchWithAuth(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
            }

            if (res.ok && res.data) {
                return { success: true, data: res.data };
            }

            return { success: false, error: res.text || `HTTP ${res.status}` };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }

    // Delist offers via fetchWithAuth
    static async deleteUserOffers(offerIds) {
        if (!offerIds || offerIds.length === 0) return { success: false, error: "No offers specified for delisting" };
        const urlV2 = `${this.BASE_URL}/marketplace-api/v2/offers`;
        try {
            const res = await fetchWithAuth(urlV2, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ offerIds: offerIds })
            });

            if (res.ok || res.status === 204) {
                return { success: true, message: "Offer successfully delisted" };
            }

            // Fallback to v1
            const urlV1 = `${this.BASE_URL}/marketplace-api/v1/user-offers/delete`;
            const resV1 = await fetchWithAuth(urlV1, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objects: offerIds.map(oid => ({ offerId: oid })) })
            });

            if (resV1.ok || resV1.status === 204) {
                return { success: true, message: "Offer successfully delisted" };
            }

            return { success: false, error: res.text || `HTTP ${res.status}` };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }
}

export { DMarketAPI };
