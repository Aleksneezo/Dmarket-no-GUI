import { WEAR_CONFIGS, getFloatCategory } from './wear_configs.js';
import { DMarketAPI } from './api/endpoints.js';
import { DMarketLogger } from './api/logger.js';

// DMarket Float Tracker Core Analysis Service (Pure JS)


function isExactDMarketMatch(itemTitle, targetSkinName) {
    if (!itemTitle || !targetSkinName) return false;
    const tClean = targetSkinName.replace(/^[★*]\s*/, '').trim().toLowerCase();
    const iClean = itemTitle.replace(/^[★*]\s*/, '').trim().toLowerCase();

    // StatTrak check
    const isTargetSt = tClean.includes("stattrak");
    const isItemSt = iClean.includes("stattrak");
    if (isTargetSt !== isItemSt) return false;

    // Fade vs Marble Fade check
    if (tClean.includes("fade") && !tClean.includes("marble") && iClean.includes("marble")) return false;
    if (tClean.includes("marble") && !iClean.includes("marble")) return false;

    // Gamma Doppler vs Doppler check
    if (tClean.includes("gamma doppler") && !iClean.includes("gamma doppler")) return false;
    if (!tClean.includes("gamma doppler") && iClean.includes("gamma doppler")) return false;

    if (tClean === iClean) return true;

    const tBase = tClean.replace(/\s*\([^)]+\)\s*$/, '').trim();
    const iBase = iClean.replace(/\s*\([^)]+\)\s*$/, '').trim();

    return tBase === iBase;
}

async function analyzeSingleOffer(rawOffer, buyHistoryMap = {}, closedTrades = [], abortSignal = null) {
    if (abortSignal && abortSignal.aborted) return null;

    const cs2Data = rawOffer.cs2 || (rawOffer.extra && rawOffer.extra.cs2) || (rawOffer.attributes && rawOffer.attributes.cs2) || {};
    const attrs = rawOffer.attributes || rawOffer.Attributes || {};
    const extraData = rawOffer.extra || {};

    const rawOfferId = rawOffer.offerId || rawOffer.OfferId || (rawOffer.offer && (rawOffer.offer.offerId || rawOffer.offer.id)) || null;
    const rawItemId = rawOffer.itemId || rawOffer.ItemId || rawOffer.id || (rawOffer.attributes && rawOffer.attributes.id) || null;
    const rawAssetId = rawOffer.assetId || rawOffer.AssetId || (rawOffer.attributes && rawOffer.attributes.id) || rawItemId || null;
    const offerId = rawOfferId || rawItemId || rawAssetId || "item-" + Math.random().toString(36).substr(2, 9);
    const fullTitle = rawOffer.title || attrs.title || attrs.name || rawOffer.name || rawOffer.Title || extraData.name || "Unknown Skin";
    
    // Вычисление цены лота
    let priceUsd = 0;
    if (rawOffer.priceCents !== undefined && rawOffer.priceCents !== null) {
        priceUsd = parseInt(rawOffer.priceCents, 10) / 100.0;
    } else if (rawOffer.price && typeof rawOffer.price === 'object') {
        if (rawOffer.price.USD !== undefined) priceUsd = parseFloat(rawOffer.price.USD) / 100.0;
        else if (rawOffer.price.amount !== undefined) priceUsd = parseFloat(rawOffer.price.amount) / 100.0;
        else if (rawOffer.price.usd !== undefined) priceUsd = parseFloat(rawOffer.price.usd);
    } else if (rawOffer.Price && rawOffer.Price.Amount) {
        priceUsd = parseFloat(rawOffer.Price.Amount);
    } else if (rawOffer.price && rawOffer.price.amount) {
        priceUsd = parseFloat(rawOffer.price.amount) / 100.0;
    } else if (rawOffer.price_usd) {
        priceUsd = parseFloat(rawOffer.price_usd);
    }

    // Извлечение оригинального изображения со Steam Akamai CDN
    let imageUrl = rawOffer.image || rawOffer.imageUri || rawOffer.imageUrl || extraData.image || extraData.imageUri || attrs.imageUri || attrs.imageUrl || "";

    // Doppler / Gamma Doppler Phase
    const rawPhase = cs2Data.phase || attrs.phase || extraData.phase || rawOffer.phase;
    const itemPhase = (rawPhase && rawPhase !== "PHASE_TITLE_UNSPECIFIED" && rawPhase !== "") ? rawPhase : null;
    const phaseDisplay = itemPhase ? itemPhase.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null;

    // Buy Price from trade history
    const assetId = rawOffer.assetId || rawOffer.AssetId || rawOffer.itemId || attrs.id;
    let buyTrade = null;
    if (buyHistoryMap && assetId && buyHistoryMap[assetId]) {
        buyTrade = buyHistoryMap[assetId];
    } else if (closedTrades && closedTrades.length > 0) {
        for (const tr of closedTrades) {
            const tTitle = tr.Title || tr.title || (tr.Attributes && tr.Attributes.title) || "";
            if (isExactDMarketMatch(tTitle, fullTitle)) {
                buyTrade = tr;
                break;
            }
        }
    }

    // Profit calculation (2% DMarket commission)
    const FEE_RATE = 0.02;
    const netPayout = Math.round(priceUsd * (1.0 - FEE_RATE) * 100) / 100.0;
    let buyPrice = null;
    let buyPriceStr = "—";
    let profitUsd = null;
    let profitPct = null;

    if (buyTrade) {
        if (buyTrade.Price && buyTrade.Price.Amount) {
            buyPrice = parseFloat(buyTrade.Price.Amount);
        } else if (buyTrade.price && buyTrade.price.amount) {
            buyPrice = parseFloat(buyTrade.price.amount) / 100.0;
        } else if (buyTrade.price && buyTrade.price.USD) {
            buyPrice = parseFloat(buyTrade.price.USD) / 100.0;
        } else if (buyTrade.price_usd) {
            buyPrice = parseFloat(buyTrade.price_usd);
        }

        if (buyPrice !== null && buyPrice > 0) {
            buyPriceStr = `$${buyPrice.toFixed(2)}`;
            profitUsd = Math.round((netPayout - buyPrice) * 100) / 100.0;
            profitPct = Math.round(((profitUsd / buyPrice) * 100) * 10) / 10.0;
        }
    }

    // Float parsing
    let floatVal = null;
    if (cs2Data.floatValue !== undefined && cs2Data.floatValue !== null && cs2Data.floatValue !== "") {
        floatVal = parseFloat(cs2Data.floatValue);
    } else if (cs2Data.float !== undefined && cs2Data.float !== null) {
        floatVal = parseFloat(cs2Data.float);
    } else if (extraData.floatValue !== undefined && extraData.floatValue !== null && extraData.floatValue !== "") {
        floatVal = parseFloat(extraData.floatValue);
    } else if (extraData.float !== undefined && extraData.float !== null) {
        floatVal = parseFloat(extraData.float);
    } else if (attrs.floatValue !== undefined && attrs.floatValue !== null) {
        floatVal = parseFloat(attrs.floatValue);
    } else if (attrs.float !== undefined && attrs.float !== null) {
        floatVal = parseFloat(attrs.float);
    } else if (rawOffer.floatValue !== undefined && rawOffer.floatValue !== null) {
        floatVal = parseFloat(rawOffer.floatValue);
    } else if (rawOffer.float !== undefined && rawOffer.float !== null) {
        floatVal = parseFloat(rawOffer.float);
    }

    const { wearShort, catLabel, minF, maxF, dmarket_exterior, floatPartValue } = getFloatCategory(fullTitle, floatVal);
    const paintSeed = cs2Data.paintSeed || extraData.paintSeed || attrs.paintSeed || rawOffer.paintSeed || null;

    // Search Market Offers for competitors
    const baseTitle = fullTitle.replace(/\s*\([^)]+\)\s*$/, '').trim();
    const searchTitle = baseTitle.replace(/^[★*]\s*/, '').trim();

    let extraTree = null;
    if (searchTitle.toLowerCase().includes("stattrak")) {
        extraTree = "categoryPath[]=csgo/weapons/stattrak";
    }

    let marketData = await DMarketAPI.getMarketOffers(searchTitle, dmarket_exterior, itemPhase, extraTree, 100, floatPartValue, fullTitle);
    let marketOffers = [];
    if (marketData) {
        if (Array.isArray(marketData.objects)) marketOffers = marketData.objects;
        else if (Array.isArray(marketData.items)) marketOffers = marketData.items;
        else if (Array.isArray(marketData.offers)) marketOffers = marketData.offers;
        else if (Array.isArray(marketData.Items)) marketOffers = marketData.Items;
        else if (Array.isArray(marketData.Offers)) marketOffers = marketData.Offers;
    }

    // Filter competitors strictly within the float category
    let categoryMatchedOffers = [];
    for (const mOffer of marketOffers) {
        const mAttrs = mOffer.extra || mOffer.attributes || {};
        const mCs2 = mOffer.cs2 || mAttrs.cs2 || mAttrs.CS2 || mAttrs.extra || {};
        const mTitle = mOffer.title || mAttrs.title || mOffer.name || "";

        if (!isExactDMarketMatch(mTitle, fullTitle)) continue;

        if (itemPhase) {
            const mPhase = mCs2.phase || mAttrs.phase || mOffer.phase;
            if (mPhase && mPhase !== itemPhase) continue;
        }

        let mFloat = null;
        if (mCs2.floatValue !== undefined && mCs2.floatValue !== null && mCs2.floatValue !== "") {
            mFloat = parseFloat(mCs2.floatValue);
        } else if (mCs2.float !== undefined && mCs2.float !== null) {
            mFloat = parseFloat(mCs2.float);
        } else if (mAttrs.floatValue !== undefined && mAttrs.floatValue !== null && mAttrs.floatValue !== "") {
            mFloat = parseFloat(mAttrs.floatValue);
        } else if (mAttrs.float !== undefined && mAttrs.float !== null) {
            mFloat = parseFloat(mAttrs.float);
        } else if (mOffer.float !== undefined && mOffer.float !== null) {
            mFloat = parseFloat(mOffer.float);
        }

        let isMatch = false;
        if (minF === null && maxF === null) {
            isMatch = true;
        } else if (mFloat !== null) {
            isMatch = (mFloat >= minF && mFloat <= maxF);
        } else {
            // Фоллбек при отсутствии флоата на листинге маркета
            const [, cWear] = detectWearFromTitle(mTitle);
            const [, uWear] = detectWearFromTitle(fullTitle);
            if (cWear === uWear) {
                isMatch = true;
            }
        }

        if (isMatch) {
            let mPriceUsd = 0;
            if (mOffer.price && typeof mOffer.price === 'object') {
                if (mOffer.price.USD !== undefined) mPriceUsd = parseFloat(mOffer.price.USD) / 100.0;
                else if (mOffer.price.amount !== undefined) mPriceUsd = parseFloat(mOffer.price.amount) / 100.0;
                else if (mOffer.price.usd !== undefined) mPriceUsd = parseFloat(mOffer.price.usd);
            } else if (mOffer.priceCents !== undefined && mOffer.priceCents !== null) {
                mPriceUsd = parseInt(mOffer.priceCents, 10) / 100.0;
            }

            const mSeed = mCs2.paintSeed || mAttrs.paintSeed || (mOffer.extra && mOffer.extra.paintSeed) || null;
            const mPh = mCs2.phase || mAttrs.phase || (mOffer.extra && mOffer.extra.phase) || null;

            categoryMatchedOffers.push({
                offer_id: mOffer.itemId || mOffer.id || mOffer.offerId || "comp-" + Math.random(),
                title: mTitle,
                price_usd: mPriceUsd,
                float: mFloat,
                paint_seed: mSeed,
                phase: mPh,
                is_user_offer: (mOffer.itemId === offerId || mOffer.id === offerId || mOffer.offerId === offerId)
            });
        }
    }

    // Include current user offer if not returned in public market query
    const userFoundInMarket = categoryMatchedOffers.some(o => o.is_user_offer || o.offer_id === offerId);
    if (!userFoundInMarket) {
        categoryMatchedOffers.push({
            offer_id: offerId,
            title: fullTitle,
            price_usd: priceUsd,
            float: floatVal,
            paint_seed: paintSeed,
            phase: itemPhase,
            is_user_offer: true
        });
    }

    categoryMatchedOffers.sort((a, b) => a.price_usd - b.price_usd);

    let userCatRank = 1;
    for (let idx = 0; idx < categoryMatchedOffers.length; idx++) {
        if (categoryMatchedOffers[idx].is_user_offer || categoryMatchedOffers[idx].offer_id === offerId) {
            userCatRank = idx + 1;
            break;
        }
    }

    const totalInCategory = categoryMatchedOffers.length;
    const lowestPrice = totalInCategory > 0 ? categoryMatchedOffers[0].price_usd : priceUsd;
    const priceDiffUsd = Math.round((priceUsd - lowestPrice) * 100) / 100.0;
    const priceDiffPct = lowestPrice > 0 ? Math.round(((priceUsd - lowestPrice) / lowestPrice) * 1000) / 10.0 : 0.0;

    const fromVal = (minF !== null && minF !== undefined) ? Number(minF).toFixed(2) : "0.00";
    const toVal = (maxF !== null && maxF !== undefined) ? Number(maxF).toFixed(2) : "1.00";

    const marketParams = new URLSearchParams();
    marketParams.set("sort-type", "5");
    marketParams.set("floatValueFrom", fromVal);
    marketParams.set("floatValueTo", toVal);
    marketParams.set("title", fullTitle);

    const marketFilters = [];
    if (fullTitle.toLowerCase().includes("fade") && !fullTitle.toLowerCase().includes("marble")) {
        marketFilters.push("collection=Fade skins");
    }
    if (itemPhase) {
        marketFilters.push(`phase[]=${itemPhase}`);
    }
    if (marketFilters.length > 0) {
        marketParams.set("treeFilters", marketFilters.join(","));
    }

    const marketUrl = `https://dmarket.com/ingame-items/item-list/csgo-skins?${marketParams.toString()}`;

    return {
        offer_id: offerId,
        raw_offer_id: rawOfferId,
        item_id: rawItemId,
        asset_id: rawAssetId,
        title: fullTitle,
        image_url: imageUrl,
        price_usd: priceUsd,
        price_str: `$${priceUsd.toFixed(2)}`,
        buy_price: buyPrice,
        buy_price_str: buyPriceStr,
        profit_usd: profitUsd,
        profit_pct: profitPct,
        float_val: floatVal,
        float_str: floatVal !== null ? floatVal.toFixed(4) : "—",
        category_label: catLabel,
        cat_min: minF,
        cat_max: maxF,
        wear_short: wearShort,
        phase: itemPhase,
        phase_display: phaseDisplay,
        paint_seed: paintSeed,
        rank: userCatRank,
        rank_display: `${userCatRank} из ${totalInCategory}`,
        is_best_price: (userCatRank === 1),
        lowest_cat_price: lowestPrice,
        lowest_cat_price_str: `$${lowestPrice.toFixed(2)}`,
        price_diff_usd: priceDiffUsd,
        price_diff_pct: priceDiffPct,
        total_in_category: totalInCategory,
        competitors: categoryMatchedOffers.slice(0, 15),
        market_url: marketUrl,
        offer_url: marketUrl
    };
}

async function fetchAndAnalyzeAllOffers(progressCb = null, abortSignal = null) {
    if (progressCb) progressCb(0, 0, "Загрузка активных лотов пользователя...");

    let rawOffers = await DMarketAPI.getUserOffers("a8db", 100);
    if (rawOffers && !Array.isArray(rawOffers)) {
        if (rawOffers.offers) rawOffers = rawOffers.offers;
        else if (rawOffers.objects) rawOffers = rawOffers.objects;
        else if (rawOffers.items) rawOffers = rawOffers.items;
    }
    console.log("[Tracker Service] Получено лотов для сканирования:", rawOffers ? rawOffers.length : 0, rawOffers);

    if (!rawOffers || rawOffers.length === 0) {
        if (progressCb) progressCb(0, 0, "Активные лоты не найдены. Убедитесь, что у вас есть выставленные предметы на DMarket.");
        return [];
    }

    if (progressCb) progressCb(0, rawOffers.length, "Загрузка истории покупок для расчета P&L...");

    const closedTrades = await DMarketAPI.getUserClosedTargets(5, 100);
    const buyHistoryMap = {};
    for (const tr of closedTrades) {
        const tAssetId = tr.AssetId || tr.assetId || (tr.Attributes && tr.Attributes.id);
        if (tAssetId && !buyHistoryMap[tAssetId]) {
            buyHistoryMap[tAssetId] = tr;
        }
    }

    const total = rawOffers.length;
    const analyzedItems = [];

    for (let i = 0; i < total; i++) {
        if (abortSignal && abortSignal.aborted) break;
        const offer = rawOffers[i];
        const title = offer.title || (offer.attributes && offer.attributes.title) || offer.name || "Скин";
        if (progressCb) progressCb(i + 1, total, `Анализ ${i + 1}/${total}: ${title}`);

        try {
            const item = await analyzeSingleOffer(offer, buyHistoryMap, closedTrades, abortSignal);
            if (item) analyzedItems.push(item);
        } catch (e) {
            console.error(`Ошибка анализа ${title}:`, e);
        }
    }

    return analyzedItems;
}

export { fetchAndAnalyzeAllOffers, fetchAndAnalyzeAllOffers as scanAllUserOffers };
