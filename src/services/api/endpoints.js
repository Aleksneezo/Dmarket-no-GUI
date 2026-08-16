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
                name: "exchange/v1/user/offers/v2",
                url: `${this.BASE_URL}/exchange/v1/user/offers/v2?orderBy=updated&orderDir=desc&title=&priceFrom=0&priceTo=0&treeFilters=&gameId=${gameId}&currency=USD&platform=browser&pageSize=${pageSize}&pageToken=`
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

        if (!auth.jwt) {
            this.logDebug("WARNING: JWT token not found. Please open the dmarket.com tab and refresh it (F5).");
        } else {
            this.logDebug("All endpoints returned 0 offers. Make sure you have active offers (On Sale) on DMarket.");
        }

        return [];
    }

    // Closed trades (purchase history for P&L) via fetchWithAuth
    static async getUserClosedTargets(maxPages = 5, limit = 1000) {
        const trades = [];

        try {
            let offset = 0;
            const newLimit = 1000;
            for (let i = 0; i < maxPages; i++) {
                const path = `/exchange/v1/history?version=V3&limit=${newLimit}&statuses=success,trade_protected&activities=purchase,target_closed&sortBy=updatedAt&offset=${offset}`;
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

        this.logDebug(`Successfully received  records from purchase history.`);
        return trades;
    }

    // Search competitor offers on market
    static async getMarketOffers(fullTitle, treeFiltersString, limit = 100) {
        // Primary and only endpoint: exchange/v1/market/items/v2
        const titleStr = encodeURIComponent(fullTitle);
        let url1 = `${this.BASE_URL}/exchange/v1/market/items/v2?title=${titleStr}&orderBy=price&orderDir=asc&isLoggedIn=true&gameId=a8db&pageSize=${limit}&side=market&currency=USD&platform=browser&pageToken=`;

        if (treeFiltersString) {
            url1 += `&treeFilters=${treeFiltersString}`;
        }

        try {
            const res = await fetch(url1);
            const text = await res.text();
            let data = null;
            try { data = JSON.parse(text); } catch (e) { data = text; }
            if (res.ok && data) {
                const list = data.objects || data.items || data.offers || data.Items || data.Offers || [];
                if (list.length > 0) return data;
            }
        } catch (e) { }

        return {};
    }
    // Change offer price (Reprice) via native PATCH /exchange/v1/offers
    static async editOfferPrice(offerId, priceUsd, altIds = []) {
        const priceCents = Math.round(priceUsd * 100);
        const priceCentsStr = String(priceCents);
        const idsToTry = Array.from(new Set([offerId, ...altIds].filter(Boolean)));

        this.logDebug(`[editOfferPrice] Price update request to $${priceUsd.toFixed(2)} (offerId=${offerId})`);

        // Main native web method DMarket: PATCH /exchange/v1/offers
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
                    if (res.data && res.data.success && res.data.success.length > 0) {
                        this.logDebug(`[editOfferPrice] Price successfully updated!`);
                        return { success: true, data: res.data || {} };
                    }
                    if (res.data && res.data.failReason && res.data.failReason.length > 0) {
                        const reason = res.data.failReason[0];
                        const errStr = `${reason.Code}: ${reason.Message}`;
                        this.logDebug(`[editOfferPrice] PATCH failed with reason: ${errStr}`);
                        return { success: false, error: errStr };
                    }
                }
            } catch (e) {
                this.logDebug(`[editOfferPrice] PATCH error: ${e.message}`);
            }
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

        const urlExchange = `${this.BASE_URL}/exchange/v1/offers`;
        const payload = {
            force: true,
            objects: offerIds.map(oid => ({ offerId: oid }))
        };

        try {
            const res = await fetchWithAuth(urlExchange, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (res.ok || res.status === 204 || (res.data && res.data.success)) {
                return { success: true, message: "Offer successfully delisted" };
            }

            return { success: false, error: res.text || `HTTP ${res.status}` };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }
}

export { DMarketAPI };
