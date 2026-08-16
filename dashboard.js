import { DMarketAPI, DMarketLogger } from './api/index.js';
import { fetchAndAnalyzeAllOffers, analyzeSingleOffer } from './tracker_service.js';

// DMarket Float Tracker Standalone Dashboard Controller (Manifest V3 - Strict CSP Compliant)

let allItems = [];
let currentFilter = 'all';
let currentSort = 'rank_asc';
let activeModalOfferId = null;
let currentAbortController = null;
let isScanning = false;
let pendingBuyOffer = null;

document.addEventListener('DOMContentLoaded', () => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['dmInterceptedItems'], (res) => {
            if (res.dmInterceptedItems && Array.isArray(res.dmInterceptedItems)) {
                const cleaned = res.dmInterceptedItems.filter(item => {
                    const title = item.title || (item.attributes && item.attributes.title) || item.name || '';
                    const hasId = item.offerId || item.itemId || item.id || item.assetId;
                    return (title.includes('|') || title.includes('★')) && hasId;
                });
                if (cleaned.length !== res.dmInterceptedItems.length) {
                    chrome.storage.local.set({ dmInterceptedItems: cleaned });
                }
            }
        });
    }
    initEvents();
    checkSession();

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && (changes.dmJwt || changes.dmUserProfile)) {
                checkSession();
            }
        });
    }
});

function initEvents() {
    const scanBtn = document.getElementById('scanBtn');
    const emptyScanBtn = document.getElementById('emptyScanBtn');
    const stopBtn = document.getElementById('stopBtn');

    if (scanBtn) scanBtn.addEventListener('click', startScan);
    if (emptyScanBtn) emptyScanBtn.addEventListener('click', startScan);
    if (stopBtn) stopBtn.addEventListener('click', stopScan);

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', applyFiltersAndRender);
    }

    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            currentSort = e.target.value;
            applyFiltersAndRender();
        });
    }

    document.querySelectorAll('.filter-group .filter-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-group .filter-tab').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            applyFiltersAndRender();
        });
    });

    const debugBtn = document.getElementById('debugBtn');
    const debugModal = document.getElementById('debugModal');
    const debugCloseBtn = document.getElementById('debugCloseBtn');

    if (debugBtn) {
        debugBtn.addEventListener('click', () => {
            if (debugModal) {
                const logsBox = document.getElementById('debugLogsContainer');
                if (logsBox) {
                    const logs = DMarketLogger.getLogs() || [];
                    if (logs.length === 0) {
                        logsBox.textContent = 'Logs are empty. Click "Scan Offers" or refresh the token.';
                    } else {
                        logsBox.innerHTML = logs.map(l => `<span style="color:#5c6370;">${l.time}</span> ${l.msg} ${l.data ? '\n' + JSON.stringify(l.data, null, 2) : ''}`).join('\n\n');
                    }
                    setTimeout(() => logsBox.scrollTop = logsBox.scrollHeight, 10);
                }
                debugModal.classList.remove('hidden');
            }
        });
    }

    if (debugCloseBtn && debugModal) {
        debugCloseBtn.addEventListener('click', () => debugModal.classList.add('hidden'));
        debugModal.addEventListener('click', (e) => {
            if (e.target === debugModal) debugModal.classList.add('hidden');
        });
    }

    const modalCloseBtn = document.getElementById('modalCloseBtn');
    if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);

    const modalRefreshBtn = document.getElementById('modalRefreshBtn');
    if (modalRefreshBtn) modalRefreshBtn.addEventListener('click', refreshCurrentModalItem);

    const modal = document.getElementById('competitorsModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    const buyConfirmCloseBtn = document.getElementById('buyConfirmCloseBtn');
    if (buyConfirmCloseBtn) buyConfirmCloseBtn.addEventListener('click', closeBuyConfirmModal);

    const buyCancelBtn = document.getElementById('buyCancelBtn');
    if (buyCancelBtn) buyCancelBtn.addEventListener('click', closeBuyConfirmModal);

    const buyConfirmCheckbox = document.getElementById('buyConfirmCheckbox');
    const buyExecuteBtn = document.getElementById('buyExecuteBtn');
    if (buyConfirmCheckbox && buyExecuteBtn) {
        buyConfirmCheckbox.addEventListener('change', (e) => {
            buyExecuteBtn.disabled = !e.target.checked;
        });
    }
    if (buyExecuteBtn) buyExecuteBtn.addEventListener('click', executeBuyOffer);

    const buyConfirmModal = document.getElementById('buyConfirmModal');
    if (buyConfirmModal) {
        buyConfirmModal.addEventListener('click', (e) => {
            if (e.target === buyConfirmModal) closeBuyConfirmModal();
        });
    }

    // Event delegation for items table (no inline onclick)
    const itemsContainer = document.getElementById('itemsContainer');
    if (itemsContainer) {
        itemsContainer.addEventListener('click', (e) => {
            const quickOutbidBtn = e.target.closest('[data-action="quick-outbid"]');
            if (quickOutbidBtn) {
                const offerId = quickOutbidBtn.dataset.offerId;
                const lowestPrice = parseFloat(quickOutbidBtn.dataset.lowestPrice);
                if (offerId && !isNaN(lowestPrice)) {
                    outbidCompetitor(offerId, lowestPrice);
                }
                return;
            }

            const compBtn = e.target.closest('[data-action="open-competitors"]');
            if (compBtn) {
                const offerId = compBtn.dataset.offerId;
                if (offerId) openCompetitorsModal(offerId);
                return;
            }
        });
    }

    // Event delegation for competitors modal
    const modalBody = document.getElementById('modalBody');
    if (modalBody) {
        modalBody.addEventListener('click', (e) => {
            const buyBtn = e.target.closest('[data-action="prompt-buy"]');
            if (buyBtn) {
                const offerId = buyBtn.dataset.offerId;
                const title = buyBtn.dataset.title;
                const priceUsd = parseFloat(buyBtn.dataset.price);
                const floatStr = buyBtn.dataset.float;
                const seedStr = buyBtn.dataset.seed;
                promptBuyOffer(offerId, title, priceUsd, floatStr, seedStr);
                return;
            }

            const saveBtn = e.target.closest('[data-action="save-modal-price"]');
            if (saveBtn) {
                const offerId = saveBtn.dataset.offerId;
                const input = document.getElementById(`modal-price-${offerId}`);
                if (offerId && input) {
                    const price = parseFloat(input.value);
                    if (!isNaN(price) && price > 0) {
                        saveItemPrice(offerId, price);
                    } else {
                        showToast('Please enter a valid price above $0.00', 'error', 3000);
                    }
                }
                return;
            }

            const outbidBtn = e.target.closest('[data-action="outbid"]');
            if (outbidBtn) {
                const compPrice = parseFloat(outbidBtn.dataset.compPrice);
                const userOfferId = outbidBtn.dataset.userOfferId;
                if (!isNaN(compPrice) && userOfferId) {
                    outbidCompetitor(userOfferId, compPrice);
                }
                return;
            }

            // Outbid with picker popup (multiple user offers)
            const outbidPickBtn = e.target.closest('[data-action="outbid-pick"]');
            if (outbidPickBtn) {
                const compPrice = parseFloat(outbidPickBtn.dataset.compPrice);
                if (!isNaN(compPrice)) {
                    showOutbidPicker(compPrice);
                }
                return;
            }

            // Pick a specific offer from the outbid picker
            const pickOfferBtn = e.target.closest('[data-action="pick-outbid-offer"]');
            if (pickOfferBtn) {
                const compPrice = parseFloat(pickOfferBtn.dataset.compPrice);
                const userOfferId = pickOfferBtn.dataset.userOfferId;
                if (!isNaN(compPrice) && userOfferId) {
                    hideOutbidPicker();
                    outbidCompetitor(userOfferId, compPrice);
                }
                return;
            }

            // Close the picker if clicking its backdrop
            const pickerBackdrop = e.target.closest('.outbid-picker-backdrop');
            if (pickerBackdrop && e.target === pickerBackdrop) {
                hideOutbidPicker();
                return;
            }

            const delistBtn = e.target.closest('[data-action="delist-lot"]');
            if (delistBtn) {
                const offerId = delistBtn.dataset.offerId;
                if (offerId) {
                    cancelOfferLot(offerId);
                }
                return;
            }
        });

        modalBody.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.classList.contains('input-user-price')) {
                const offerId = e.target.dataset.offerId;
                if (offerId) {
                    const price = parseFloat(e.target.value);
                    if (!isNaN(price) && price > 0) {
                        saveItemPrice(offerId, price);
                    } else {
                        showToast('Please enter a valid price above $0.00', 'error', 3000);
                    }
                }
            }
        });
    }
}

async function checkSession() {
    const badge = document.getElementById('sessionStatusBadge');
    const dot = document.getElementById('sessionDot');
    const text = document.getElementById('sessionStatusText');

    try {
        const profile = await DMarketAPI.getUserProfile();
        if (profile) {
            dot.className = 'dot active';
            const username = profile.username || profile.email || 'DMarket User';
            let balStr = '';
            if (profile.balance && profile.balance.usd !== undefined) {
                const balUsd = parseFloat(profile.balance.usd) > 1000 ? parseFloat(profile.balance.usd) / 100.0 : parseFloat(profile.balance.usd);
                balStr = ` ($${balUsd.toFixed(2)})`;
            }
            text.textContent = `${username}${balStr}`;
            badge.style.borderColor = 'var(--green-border)';
            badge.title = 'Authorized via browser session';

            if (allItems.length === 0 && !isScanning) {
                startScan();
            }
        } else {
            dot.className = 'dot';
            text.textContent = 'Refresh dmarket.com';
            badge.style.borderColor = 'var(--red-border)';
            badge.title = 'Open or refresh (F5) dmarket.com to transfer a fresh token';
        }
    } catch (e) {
        dot.className = 'dot';
        text.textContent = 'Session check error';
    }
}

async function startScan() {
    if (isScanning) return;
    isScanning = true;

    currentAbortController = new AbortController();

    const scanBtn = document.getElementById('scanBtn');
    const scanBtnText = document.getElementById('scanBtnText');
    const progressBanner = document.getElementById('progressBanner');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const emptyState = document.getElementById('emptyState');
    const tableWrap = document.getElementById('itemsListSection') || document.getElementById('tableWrap');

    if (scanBtn) scanBtn.disabled = true;
    if (scanBtnText) scanBtnText.textContent = 'Scanning...';
    if (progressBanner) progressBanner.classList.remove('hidden');
    if (progressBar) progressBar.style.width = '5%';
    if (progressText) progressText.textContent = 'Connecting to DMarket session...';

    try {
        const items = await fetchAndAnalyzeAllOffers(
            (current, total, msg) => {
                if (progressText) progressText.textContent = msg;
                if (total > 0 && progressBar) {
                    const pct = Math.min(100, Math.round((current / total) * 100));
                    progressBar.style.width = `${pct}%`;
                }
            },
            currentAbortController.signal
        );

        allItems = items || [];

        if (allItems.length > 0) {
            if (emptyState) emptyState.classList.add('hidden');
            if (tableWrap) tableWrap.classList.remove('hidden');
        } else {
            if (emptyState) emptyState.classList.remove('hidden');
            if (tableWrap) tableWrap.classList.add('hidden');
        }

        applyFiltersAndRender();
        if (allItems.length > 0) {
            showToast(`Scan completed! Analyzed items: ${allItems.length}`, 'success', 3500);
        } else {
            showToast('No offers found. Click "API Log" for details.', 'info', 4000);
        }

    } catch (err) {
        if (err.name === 'AbortError') {
            showToast('Scan stopped by user', 'info', 3000);
        } else {
            showToast('Scan error: ' + err.message, 'error', 4500);
        }
    } finally {
        isScanning = false;
        if (scanBtn) scanBtn.disabled = false;
        if (scanBtnText) scanBtnText.textContent = 'Scan Offers';
        if (progressBanner) progressBanner.classList.add('hidden');
        if (progressBar) progressBar.style.width = '0%';
    }
}

function stopScan() {
    if (currentAbortController) {
        currentAbortController.abort();
    }
}

function applyFiltersAndRender() {
    const searchVal = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();

    let filtered = allItems.filter(item => {
        if (searchVal && !item.title.toLowerCase().includes(searchVal)) {
            return false;
        }

        if (currentFilter === 'rank1') return item.rank === 1;
        if (currentFilter === 'top3') return item.rank >= 2 && item.rank <= 3;
        if (currentFilter === 'rank4') return item.rank >= 4;

        return true;
    });

    filtered.sort((a, b) => {
        if (currentSort === 'rank_asc') {
            if (a.rank !== b.rank) return a.rank - b.rank;
            return b.price_diff_usd - a.price_diff_usd;
        }
        if (currentSort === 'profit_desc') {
            const pA = a.profit_usd !== null ? a.profit_usd : -99999;
            const pB = b.profit_usd !== null ? b.profit_usd : -99999;
            return pB - pA;
        }
        if (currentSort === 'price_desc') return b.price_usd - a.price_usd;
        if (currentSort === 'price_asc') return a.price_usd - b.price_usd;
        if (currentSort === 'float_asc') {
            const fA = a.float_val !== null ? a.float_val : 999;
            const fB = b.float_val !== null ? b.float_val : 999;
            return fA - fB;
        }
        if (currentSort === 'diff_desc') return b.price_diff_usd - a.price_diff_usd;
        return 0;
    });

    updateSummaryStats(allItems);
    renderItems(filtered);
}

function updateSummaryStats(items) {
    const totalCount = items.length;
    let rank1Count = 0;
    let top3Count = 0;
    let rank4Count = 0;
    let totalPortfolio = 0;
    let totalProfit = 0;

    items.forEach(it => {
        totalPortfolio += it.price_usd;
        if (it.rank === 1) rank1Count++;
        else if (it.rank <= 3) top3Count++;
        else rank4Count++;

        if (it.profit_usd !== null && it.profit_usd !== undefined) {
            totalProfit += it.profit_usd;
        }
    });

    const elTotal = document.getElementById('statTotalItems');
    const elRank1 = document.getElementById('statRank1Items');
    const elTop3 = document.getElementById('statTop3Items');
    const elRank4 = document.getElementById('statRank4Items');
    const elPort = document.getElementById('statPortfolioVal');
    const elProf = document.getElementById('statProfitVal');

    if (elTotal) elTotal.textContent = totalCount;
    if (elRank1) elRank1.textContent = rank1Count;
    if (elTop3) elTop3.textContent = top3Count;
    if (elRank4) elRank4.textContent = rank4Count;
    if (elPort) elPort.textContent = `$${totalPortfolio.toFixed(2)}`;
    if (elProf) {
        elProf.textContent = (totalProfit >= 0 ? '+$' : '-$') + Math.abs(totalProfit).toFixed(2);
        elProf.className = totalProfit >= 0 ? 'metric-value font-mono text-green' : 'metric-value font-mono text-red';
    }

    const cAll = document.getElementById('countAll');
    const cRank1 = document.getElementById('countRank1');
    const cTop3 = document.getElementById('countTop3');
    const cRank4 = document.getElementById('countRank4');
    if (cAll) cAll.textContent = totalCount;
    if (cRank1) cRank1.textContent = rank1Count;
    if (cTop3) cTop3.textContent = top3Count;
    if (cRank4) cRank4.textContent = rank4Count;
}

function getDMarketSearchUrl(item) {
    const fullTitle = item.title || item.base_title || '';
    let fromVal = '0.00';
    let toVal = '1.00';

    if (item.cat_min !== undefined && item.cat_min !== null) {
        fromVal = Number(item.cat_min).toFixed(2);
    } else if (item.category_label && item.category_label.includes('-')) {
        const parts = item.category_label.split('-');
        fromVal = Number(parts[0]).toFixed(2);
    }

    if (item.cat_max !== undefined && item.cat_max !== null) {
        toVal = Number(item.cat_max).toFixed(2);
    } else if (item.category_label && item.category_label.includes('-')) {
        const parts = item.category_label.split('-');
        toVal = Number(parts[1]).toFixed(2);
    }

    const params = new URLSearchParams();
    params.set('sort-type', '5');
    params.set('floatValueFrom', fromVal);
    params.set('floatValueTo', toVal);
    params.set('title', fullTitle);

    const treeFilters = [];
    if (fullTitle.toLowerCase().includes('fade') && !fullTitle.toLowerCase().includes('marble')) {
        treeFilters.push('collection=Fade skins');
    }
    if (item.phase) {
        treeFilters.push(`phase[]=${item.phase}`);
    }

    if (treeFilters.length > 0) {
        params.set('treeFilters', treeFilters.join(','));
    }

    return `https://dmarket.com/ingame-items/item-list/csgo-skins?${params.toString()}`;
}

function renderItems(items) {
    const container = document.getElementById('itemsContainer');
    if (!container) return;

    if (items.length === 0) {
        container.innerHTML = `<div style="padding: 30px; text-align: center; color: var(--text-secondary);">No items found for the selected filters</div>`;
        return;
    }

    container.innerHTML = items.map(item => {
        const rankClass = item.rank === 1 ? 'is-rank-1' : (item.rank <= 3 ? 'is-rank-top3' : 'is-rank-other');
        const rankBadgeClass = item.rank === 1 ? 'badge-rank-1' : (item.rank <= 3 ? 'badge-rank-top3' : 'badge-rank-other');
        const rankText = `${item.rank} of ${item.total_in_category}`;

        let diffHtml = '';
        if (item.rank === 1) {
            diffHtml = `<span class="price-diff-tag diff-cheapest">Min. price (#1)</span>`;
        } else if (item.price_diff_usd > 0) {
            diffHtml = `<span class="price-diff-tag diff-over">+${item.price_diff_usd.toFixed(2)}$ to #1 (+${item.price_diff_pct}%)</span>`;
        }

        let profitHtml = '';
        if (item.profit_usd !== null && item.profit_usd !== undefined) {
            const isPos = item.profit_usd >= 0;
            const badgeCls = isPos ? 'profit-pos' : 'profit-neg';
            const sign = isPos ? '+' : '';
            profitHtml = `<span class="profit-badge ${badgeCls}">${sign}${item.profit_pct}% (${sign}$${item.profit_usd.toFixed(2)})</span>`;
        }

        const phaseHtml = item.phase_display ? `<span class="phase-chip">${item.phase_display}</span>` : '';
        const seedHtml = item.paint_seed ? `<span class="seed-chip">Seed: ${item.paint_seed}</span>` : '';
        const marketUrl = getDMarketSearchUrl(item);

        return `
            <div class="item-row ${rankClass}" id="item-row-${item.offer_id}">
                <div class="col-item">
                    <div class="item-thumb">
                        <img src="${item.image_url || ''}" alt="${item.title}" loading="lazy">
                    </div>
                    <div class="item-meta">
                        <span class="item-name" title="${item.title}">${item.title}</span>
                        <div class="item-tags">
                            <span class="wear-chip">${item.wear_short || 'FT'}</span>
                            ${phaseHtml}
                            ${seedHtml}
                        </div>
                    </div>
                </div>

                <div class="col-float">
                    <span class="float-val font-mono">${item.float_str}</span>
                    <span class="float-range-badge font-mono">${item.category_label}</span>
                </div>

                <div class="col-rank">
                    <span class="rank-pill ${rankBadgeClass}">${rankText}</span>
                </div>

                <div class="col-buy font-mono">
                    <span class="buy-price-text">${item.buy_price_str}</span>
                </div>

                <div class="col-price">
                    <div class="price-row-top">
                        <span class="price-main font-mono">${item.price_str}</span>
                        ${profitHtml}
                    </div>
                    <div class="price-sub">
                        <span>Min: ${item.lowest_cat_price_str}</span>
                        ${diffHtml}
                    </div>
                </div>

                <div class="col-actions">
                    ${(item.rank > 1 && item.lowest_cat_price > 0) ? `
                        <button class="btn-quick-outbid" data-action="quick-outbid" data-offer-id="${item.offer_id}" data-lowest-price="${item.lowest_cat_price}" title="Reduce price to $${Math.max(0.01, item.lowest_cat_price - 0.01).toFixed(2)} ($0.01 below #1)">
                            Outbid #1 ($${Math.max(0.01, item.lowest_cat_price - 0.01).toFixed(2)})
                        </button>
                    ` : ''}
                    <button class="btn-competitors" data-action="open-competitors" data-offer-id="${item.offer_id}" title="View competitors">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        <span>Listings (${item.total_in_category})</span>
                    </button>
                    <a href="${marketUrl}" target="_blank" rel="noopener noreferrer" class="btn-dmarket" title="Open category on DMarket">
                        <span>DMarket</span>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                </div>
            </div>
        `;
    }).join('');
}

async function saveItemPrice(offerId, explicitPrice = null) {
    let newPrice = explicitPrice;
    let input = null;

    if (newPrice === null) {
        input = document.getElementById(`input-price-${offerId}`);
        if (!input) return;
        newPrice = parseFloat(input.value);
    } else {
        input = document.getElementById(`modal-price-${offerId}`) || document.getElementById(`input-price-${offerId}`);
    }

    if (isNaN(newPrice) || newPrice <= 0) {
        showToast('Enter a valid price above $0.00', 'error', 3000);
        return;
    }

    if (input) input.disabled = true;

    const item = allItems.find(x => x.offer_id === offerId || x.raw_offer_id === offerId || x.item_id === offerId);
    const altIds = [offerId];
    if (item) {
        if (item.raw_offer_id && !altIds.includes(item.raw_offer_id)) altIds.push(item.raw_offer_id);
        if (item.item_id && !altIds.includes(item.item_id)) altIds.push(item.item_id);
        if (item.asset_id && !altIds.includes(item.asset_id)) altIds.push(item.asset_id);
    }

    try {
        const res = await DMarketAPI.editOfferPrice(offerId, newPrice, altIds);
        if (res.success) {
            showToast(`Price successfully updated to $${newPrice.toFixed(2)}!`, 'success', 3500);

            const item = allItems.find(x => x.offer_id === offerId);
            if (item) {
                item.price_usd = newPrice;
                item.price_str = `$${newPrice.toFixed(2)}`;

                const FEE_RATE = 0.02;
                const netPayout = Math.round(newPrice * (1.0 - FEE_RATE) * 100) / 100.0;
                if (item.buy_price !== null) {
                    item.profit_usd = Math.round((netPayout - item.buy_price) * 100) / 100.0;
                    item.profit_pct = item.buy_price > 0 ? Math.round(((item.profit_usd / item.buy_price) * 100) * 10) / 10.0 : 0.0;
                }

                if (item.competitors) {
                    item.competitors.forEach(c => {
                        if (c.is_user_offer || c.offer_id === offerId) {
                            c.price_usd = newPrice;
                        }
                    });
                    item.competitors.sort((a, b) => a.price_usd - b.price_usd);
                    let userRank = 1;
                    for (let i = 0; i < item.competitors.length; i++) {
                        if (item.competitors[i].is_user_offer || item.competitors[i].offer_id === offerId) {
                            userRank = i + 1;
                            break;
                        }
                    }
                    item.rank = userRank;
                    item.rank_display = `#${userRank} of ${item.total_in_category}`;
                    item.is_best_price = (userRank === 1);
                    const lowestPrice = item.competitors.length > 0 ? item.competitors[0].price_usd : newPrice;
                    item.lowest_cat_price = lowestPrice;
                    item.lowest_cat_price_str = `$${lowestPrice.toFixed(2)}`;
                    item.price_diff_usd = Math.round((newPrice - lowestPrice) * 100) / 100.0;
                    item.price_diff_pct = lowestPrice > 0 ? Math.round(((newPrice - lowestPrice) / lowestPrice) * 1000) / 10.0 : 0.0;
                }

                applyFiltersAndRender();

                if (activeModalOfferId === offerId || allItems.some(x => x.offer_id === offerId && x.title === item.title && x.wear_short === item.wear_short)) {
                    const siblingItems = allItems.filter(x =>
                        x.title === item.title && x.wear_short === item.wear_short
                    );
                    const subEl = document.getElementById('modalSubtitle');
                    if (subEl) {
                        const subText = siblingItems.length > 1
                            ? `Float category: ${item.category_label} | ${siblingItems.length} of your offers in this range`
                            : `Float category: ${item.category_label} | Rank: ${item.rank_display}`;
                        subEl.textContent = subText;
                    }
                    const bodyEl = document.getElementById('modalBody');
                    if (bodyEl) renderCompetitorsTable(item, bodyEl, siblingItems);
                }
            }
        } else {
            showToast(`DMarket error: ${res.error || 'Failed to update price'}`, 'error', 4000);
        }
    } catch (e) {
        showToast(`Update error: ${e.message}`, 'error', 4000);
    } finally {
        if (input) input.disabled = false;
    }
}

function outbidCompetitor(userOfferId, compPrice) {
    const newPrice = Math.max(0.01, Math.round((compPrice - 0.01) * 100) / 100);
    showToast(`Outbidding competitor by 1¢: $${newPrice.toFixed(2)}...`, 'info', 2000);
    saveItemPrice(userOfferId, newPrice);
}

function openCompetitorsModal(offerId) {
    const item = allItems.find(x => x.offer_id === offerId);
    if (!item) return;

    activeModalOfferId = offerId;

    // Find all sibling items: same title + same float category
    const siblingItems = allItems.filter(x =>
        x.title === item.title && x.wear_short === item.wear_short
    );

    const modal = document.getElementById('competitorsModal');
    const titleEl = document.getElementById('modalTitle');
    const subEl = document.getElementById('modalSubtitle');
    const linkEl = document.getElementById('modalDMarketLink');
    const bodyEl = document.getElementById('modalBody');

    if (titleEl) titleEl.textContent = item.title;
    const siblingCount = siblingItems.length;
    const subText = siblingCount > 1
        ? `Float category: ${item.category_label} | ${siblingCount} of your offers in this range`
        : `Float category: ${item.category_label} | Rank: ${item.rank} of ${item.total_in_category}`;
    if (subEl) subEl.textContent = subText;
    if (linkEl) {
        linkEl.href = getDMarketSearchUrl(item);
        linkEl.title = `Open skin page in category [${item.category_label}] on DMarket`;
    }

    if (bodyEl) {
        renderCompetitorsTable(item, bodyEl, siblingItems);
    }

    if (modal) modal.classList.remove('hidden');
}

function renderCompetitorsTable(item, container, siblingItems = []) {
    // Collect all user offer IDs from siblings
    const userOfferIds = new Set();
    if (siblingItems.length > 0) {
        siblingItems.forEach(s => userOfferIds.add(s.offer_id));
    } else {
        userOfferIds.add(item.offer_id);
    }

    // Merge competitors from all siblings, dedup by offer_id
    const seenIds = new Set();
    let mergedCompetitors = [];

    const allSiblings = siblingItems.length > 0 ? siblingItems : [item];
    for (const sib of allSiblings) {
        for (const c of (sib.competitors || [])) {
            const cId = c.offer_id || ('anon-' + Math.random());
            if (!seenIds.has(cId)) {
                seenIds.add(cId);
                // Mark as user offer if it belongs to any of our siblings
                const isUserOffer = c.is_user_offer || userOfferIds.has(cId);
                mergedCompetitors.push({ ...c, is_user_offer: isUserOffer });
            }
        }
    }

    // Sort by price ascending
    mergedCompetitors.sort((a, b) => (a.price_usd || 0) - (b.price_usd || 0));

    if (mergedCompetitors.length === 0) {
        container.innerHTML = `<div style="padding: 30px; text-align: center; color: var(--text-muted); font-size: 13px;">No active competitor offers in this float category</div>`;
        return;
    }

    const titleLow = (item.title || '').toLowerCase();
    const isDoppler = titleLow.includes('doppler');
    const isMarbleFade = titleLow.includes('marble fade');
    const isFade = titleLow.includes('fade') && !isMarbleFade;
    const isCaseHardened = titleLow.includes('case hardened');

    const hasAnySpecial = mergedCompetitors.some(c => c.phase || c.fade_pct || c.tier) || item.phase || item.phase_display;

    let showSpecialCol = false;
    let specialColTitle = 'PHASE';

    if (isDoppler) {
        showSpecialCol = true;
        specialColTitle = 'PHASE';
    } else if (isMarbleFade) {
        showSpecialCol = true;
        specialColTitle = 'TIER';
    } else if (isFade) {
        showSpecialCol = true;
        specialColTitle = 'FADE %';
    } else if (isCaseHardened) {
        showSpecialCol = true;
        specialColTitle = 'TIER';
    } else if (hasAnySpecial) {
        showSpecialCol = true;
        specialColTitle = 'PHASE / TIER';
    }

    // Find all user offer IDs that exist in the merged list for the outbid dropdown
    const userOffersInList = mergedCompetitors.filter(c => c.is_user_offer);

    const rowsHtml = mergedCompetitors.map((c, idx) => {
        const isUser = c.is_user_offer;
        const rowClass = isUser ? 'user-row' : '';
        const rankNum = idx + 1;
        const rankBadge = isUser ? `<span class="tag-user-badge">Your offer</span>` : `<span style="font-family: var(--font-mono); font-weight: 700; color: var(--text-secondary);">${rankNum}</span>`;
        const floatStr = (c.float !== null && c.float !== undefined) ? c.float.toFixed(4) : '—';
        const seedStr = c.paint_seed || '—';

        let specialChipHtml = '';
        if (showSpecialCol) {
            if (isFade && c.fade_pct) {
                specialChipHtml = `<span class="phase-chip">${c.fade_pct}%</span>`;
            } else if (c.phase) {
                specialChipHtml = `<span class="phase-chip">${c.phase.replace(/-/g, ' ').replace(/\\b\\w/g, ch => ch.toUpperCase())}</span>`;
            } else if (c.tier) {
                specialChipHtml = `<span class="phase-chip">${c.tier}</span>`;
            } else {
                specialChipHtml = '<span style="color: var(--text-muted); font-size: 11px;">—</span>';
            }
        }

        let priceHtml = '';
        let actionHtml = '';

        if (isUser) {
            priceHtml = `
                <div class="user-price-edit-group">
                    <span class="price-input-prefix">$</span>
                    <input type="number" step="0.01" min="0.01" class="input-user-price" id="modal-price-${c.offer_id}" value="${c.price_usd.toFixed(2)}" data-offer-id="${c.offer_id}">
                    <button class="btn-save-price" data-action="save-modal-price" data-offer-id="${c.offer_id}" title="Save new offer price on DMarket">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        <span>OK</span>
                    </button>
                </div>
            `;
            actionHtml = `
                <div class="user-action-group">
                    <span style="color: var(--green-text); font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px;">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> 
                        Listed by you
                    </span>
                    <button class="btn-delist-lot" data-action="delist-lot" data-offer-id="${c.offer_id}" title="Delist this offer from DMarket">
                        Delist
                    </button>
                </div>
            `;
        } else {
            priceHtml = `<span class="font-mono text-price-bold" style="color: var(--green-text); font-size: 13px;">$${c.price_usd.toFixed(2)}</span>`;

            let outbidHtml = '';
            if (userOffersInList.length > 1) {
                outbidHtml = `
                    <button class="btn-outbid-lot" data-action="outbid-pick" data-comp-price="${c.price_usd}" title="Choose which of your offers to outbid by 1¢ ($${Math.max(0.01, c.price_usd - 0.01).toFixed(2)})">
                        <span>Outbid</span>
                    </button>
                `;
            } else {
                const targetOfferId = userOffersInList.length === 1 ? userOffersInList[0].offer_id : item.offer_id;
                outbidHtml = `
                    <button class="btn-outbid-lot" data-action="outbid" data-comp-price="${c.price_usd}" data-user-offer-id="${targetOfferId}" title="Lower your offer price by 1¢ below this offer (to $${Math.max(0.01, c.price_usd - 0.01).toFixed(2)})">
                        <span>Outbid</span>
                    </button>
                `;
            }

            actionHtml = `
                <div class="comp-action-group">
                    ${outbidHtml}
                    <button class="btn-buy-lot" data-action="prompt-buy" data-offer-id="${c.offer_id}" data-title="${encodeURIComponent(item.title)}" data-price="${c.price_usd}" data-float="${floatStr}" data-seed="${seedStr}" title="Buy this competitor offer from DMarket">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
                        <span>Buy $${c.price_usd.toFixed(2)}</span>
                    </button>
                </div>
            `;
        }

        return `
            <tr class="${rowClass}">
                <td style="font-weight: 700; width: 65px;">${rankBadge}</td>
                <td style="width: 145px;">${priceHtml}</td>
                <td class="font-mono" style="font-size: 12px; font-weight: 600; width: 85px;">${floatStr}</td>
                <td class="font-mono" style="font-size: 12px; color: var(--text-secondary); width: 60px;">${seedStr}</td>
                ${showSpecialCol ? `<td style="width: 85px;">${specialChipHtml}</td>` : ''}
                <td style="min-width: 200px;">${actionHtml}</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="comp-table">
            <thead>
                <tr>
                    <th style="width: 65px;">RANK</th>
                    <th style="width: 145px;">PRICE</th>
                    <th style="width: 85px;">FLOAT</th>
                    <th style="width: 60px;">SEED</th>
                    ${showSpecialCol ? `<th style="width: 85px;">${specialColTitle}</th>` : ''}
                    <th style="min-width: 200px;">ACTION</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml}
            </tbody>
        </table>
    `;
}

async function cancelOfferLot(offerId) {
    if (!confirm('Are you sure you want to delist this offer from DMarket?')) {
        return;
    }
    showToast('Delisting offer...', 'info', 2000);
    try {
        const res = await DMarketAPI.deleteUserOffers([offerId]);
        if (res.success) {
            showToast('Offer successfully delisted!', 'success', 3500);
            allItems = allItems.filter(x => x.offer_id !== offerId);
            applyFiltersAndRender();
            closeModal();
        } else {
            showToast(`Error: ${res.error || 'Failed to delist offer'}`, 'error', 4000);
        }
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error', 4000);
    }
}

async function refreshCurrentModalItem() {
    if (!activeModalOfferId) return;
    const item = allItems.find(x => x.offer_id === activeModalOfferId);
    if (!item) return;

    const refreshText = document.getElementById('modalRefreshText');
    const refreshIcon = document.getElementById('modalRefreshIcon');
    if (refreshText) refreshText.textContent = 'Refreshing...';
    if (refreshIcon) refreshIcon.style.animation = 'spin 0.6s linear infinite';

    try {
        const rawOffer = { attributes: { title: item.title, id: item.offer_id, cs2: { float: item.float_val, paintSeed: item.paint_seed, phase: item.phase } }, offerId: item.offer_id, priceCents: Math.round(item.price_usd * 100) };
        
        const baseTitle = item.title.replace(/\s*\([^)]+\)\s*$/, '').trim().toLowerCase();
        const groupKey = baseTitle + "_" + item.wear_short;
        const groupMaxFMap = { [groupKey]: item.cat_max };
        
        const updated = await analyzeSingleOffer(rawOffer, window.buyHistoryMap || {}, window.closedTrades || [], null, groupMaxFMap);
        if (updated) {
            Object.assign(item, updated);
            const siblingItems = allItems.filter(x =>
                x.title === item.title && x.wear_short === item.wear_short
            );
            const subEl = document.getElementById('modalSubtitle');
            if (subEl) {
                const subText = siblingItems.length > 1
                    ? `Float category: ${item.category_label} | ${siblingItems.length} of your offers in this range`
                    : `Float category: ${item.category_label} | Rank: ${item.rank_display}`;
                subEl.textContent = subText;
            }
            const bodyEl = document.getElementById('modalBody');
            if (bodyEl) renderCompetitorsTable(item, bodyEl, siblingItems);
            applyFiltersAndRender();
            showToast('Offers refreshed in real-time!', 'success', 2500);
        }
    } catch (e) {
        showToast('Update error: ' + e.message, 'error', 3000);
    } finally {
        if (refreshText) refreshText.textContent = 'Refresh';
        if (refreshIcon) refreshIcon.style.animation = '';
    }
}

function closeModal() {
    const modal = document.getElementById('competitorsModal');
    if (modal) modal.classList.add('hidden');
    activeModalOfferId = null;
}

function promptBuyOffer(offerId, encodedTitle, priceUsd, floatStr, seedStr) {
    const title = decodeURIComponent(encodedTitle);
    pendingBuyOffer = { offerId, priceUsd };

    const modal = document.getElementById('buyConfirmModal');
    const titleEl = document.getElementById('buyConfirmItemTitle');
    const priceEl = document.getElementById('buyConfirmPrice');
    const floatEl = document.getElementById('buyConfirmFloat');
    const seedEl = document.getElementById('buyConfirmSeed');
    const checkEl = document.getElementById('buyConfirmCheckbox');
    const execBtn = document.getElementById('buyExecuteBtn');

    if (titleEl) titleEl.textContent = title;
    if (priceEl) priceEl.textContent = `$${priceUsd.toFixed(2)}`;
    if (floatEl) floatEl.textContent = floatStr;
    if (seedEl) seedEl.textContent = seedStr;
    if (checkEl) checkEl.checked = false;
    if (execBtn) execBtn.disabled = true;

    if (modal) modal.classList.remove('hidden');
}

function closeBuyConfirmModal() {
    const modal = document.getElementById('buyConfirmModal');
    if (modal) modal.classList.add('hidden');
    pendingBuyOffer = null;
}

async function executeBuyOffer() {
    if (!pendingBuyOffer) return;
    const { offerId, priceUsd } = pendingBuyOffer;

    const execBtn = document.getElementById('buyExecuteBtn');
    const execBtnText = document.getElementById('buyExecuteBtnText');
    if (execBtn) execBtn.disabled = true;
    if (execBtnText) execBtnText.textContent = 'Buying...';

    try {
        const res = await DMarketAPI.buyMarketOffer(offerId, priceUsd);
        if (res.success) {
            showToast(`Successful purchase for $${priceUsd.toFixed(2)}!`, 'success', 4000);
            closeBuyConfirmModal();
            closeModal();
            startScan();
        } else {
            showToast(`Purchase error: ${res.error || 'DMarket rejected the purchase'}`, 'error', 4500);
        }
    } catch (e) {
        showToast('Purchase exception: ' + e.message, 'error', 4500);
    } finally {
        if (execBtn) execBtn.disabled = false;
        if (execBtnText) execBtnText.textContent = 'Confirm and buy';
    }
}
function showOutbidPicker(compPrice) {
    const item = allItems.find(x => x.offer_id === activeModalOfferId);
    if (!item) return;

    const siblingItems = allItems.filter(x =>
        x.title === item.title && x.wear_short === item.wear_short
    );

    if (siblingItems.length <= 1) {
        outbidCompetitor(item.offer_id, compPrice);
        return;
    }

    const newPrice = Math.max(0.01, Math.round((compPrice - 0.01) * 100) / 100);

    const buttonsHtml = siblingItems.map(s => {
        const sFloat = (s.float_val !== null && s.float_val !== undefined) ? s.float_val.toFixed(4) : '?';
        const sSeed = s.paint_seed || '?';
        return `
            <button class="outbid-picker-item" data-action="pick-outbid-offer" data-comp-price="${compPrice}" data-user-offer-id="${s.offer_id}">
                <span class="font-mono" style="color: var(--green-text); font-weight: 700;">$${s.price_usd.toFixed(2)}</span>
                <span style="color: var(--text-secondary); font-size: 11px;">Float: ${sFloat} | Seed: ${sSeed}</span>
                <span style="color: var(--text-muted); font-size: 10px;">\u2192 $${newPrice.toFixed(2)}</span>
            </button>
        `;
    }).join('');

    hideOutbidPicker();

    const pickerEl = document.createElement('div');
    pickerEl.className = 'outbid-picker-backdrop';
    pickerEl.innerHTML = `
        <div class="outbid-picker-panel">
            <div style="font-size: 13px; font-weight: 700; margin-bottom: 10px; color: var(--text-primary);">
                Which offer to outbid to $${newPrice.toFixed(2)}?
            </div>
            <div class="outbid-picker-list">
                ${buttonsHtml}
            </div>
            <button class="outbid-picker-cancel" onclick="document.querySelector('.outbid-picker-backdrop')?.remove()">Cancel</button>
        </div>
    `;

    document.getElementById('modalBody')?.appendChild(pickerEl);
}

function hideOutbidPicker() {
    document.querySelector('.outbid-picker-backdrop')?.remove();
}

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
