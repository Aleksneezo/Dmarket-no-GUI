let allItems = [];
let currentFilter = 'all';
let currentSort = 'rank_asc';
let pollInterval = null;
let activeModalOfferId = null;

document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    checkSessionStatus();
    checkScanStatus();
});

function initEvents() {
    const scanBtn = document.getElementById('scanBtn');
    const emptyScanBtn = document.getElementById('emptyScanBtn');
    const stopBtn = document.getElementById('stopBtn');
    
    if (scanBtn) scanBtn.addEventListener('click', startScan);
    if (emptyScanBtn) emptyScanBtn.addEventListener('click', startScan);
    if (stopBtn) stopBtn.addEventListener('click', stopScan);

    // Auto-detect buttons
    const autoDetectBtn = document.getElementById('autoDetectBtn');
    const emptyAutoDetectBtn = document.getElementById('emptyAutoDetectBtn');
    const modalAutoDetectBtn = document.getElementById('modalAutoDetectBtn');
    if (autoDetectBtn) autoDetectBtn.addEventListener('click', triggerAutoDetect);
    if (emptyAutoDetectBtn) emptyAutoDetectBtn.addEventListener('click', triggerAutoDetect);
    if (modalAutoDetectBtn) modalAutoDetectBtn.addEventListener('click', triggerAutoDetect);

    // Settings Modal
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsCloseBtn = document.getElementById('settingsCloseBtn');
    const settingsModal = document.getElementById('settingsModal');
    if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);
    if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettingsModal);
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) closeSettingsModal();
        });
    }

    const saveManualCookiesBtn = document.getElementById('saveManualCookiesBtn');
    if (saveManualCookiesBtn) saveManualCookiesBtn.addEventListener('click', saveManualCookies);

    const testSessionBtn = document.getElementById('testSessionBtn');
    if (testSessionBtn) testSessionBtn.addEventListener('click', testSession);
    
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

    const modalCloseBtn = document.getElementById('modalCloseBtn');
    if (modalCloseBtn) {
        modalCloseBtn.addEventListener('click', closeModal);
    }

    const modal = document.getElementById('competitorsModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    const buyConfirmCloseBtn = document.getElementById('buyConfirmCloseBtn');
    if (buyConfirmCloseBtn) {
        buyConfirmCloseBtn.addEventListener('click', closeBuyConfirmModal);
    }

    const buyCancelBtn = document.getElementById('buyCancelBtn');
    if (buyCancelBtn) {
        buyCancelBtn.addEventListener('click', closeBuyConfirmModal);
    }

    const buyConfirmCheckbox = document.getElementById('buyConfirmCheckbox');
    const buyExecuteBtn = document.getElementById('buyExecuteBtn');
    if (buyConfirmCheckbox && buyExecuteBtn) {
        buyConfirmCheckbox.addEventListener('change', (e) => {
            buyExecuteBtn.disabled = !e.target.checked;
        });
    }

    const buyConfirmModal = document.getElementById('buyConfirmModal');
    if (buyConfirmModal) {
        buyConfirmModal.addEventListener('click', (e) => {
            if (e.target === buyConfirmModal) closeBuyConfirmModal();
        });
    }
}

async function checkSessionStatus() {
    try {
        const resp = await fetch('/api/auth/status');
        const data = await resp.json();
        const badge = document.getElementById('sessionStatusBadge');
        const dot = document.getElementById('sessionDot');
        const text = document.getElementById('sessionStatusText');

        if (data.is_authenticated) {
            dot.className = 'dot active';
            const balStr = data.balance_usd !== null ? ` ($${data.balance_usd.toFixed(2)})` : '';
            text.textContent = `${data.username || data.browser_source}${balStr}`;
            badge.style.borderColor = 'var(--green-border)';
            badge.title = `Авторизован через ${data.browser_source}`;
        } else if (data.has_cookies) {
            dot.className = 'dot active';
            text.textContent = `Сессия (${data.browser_source || 'Cookies'})`;
            badge.style.borderColor = 'var(--amber-border)';
        } else {
            dot.className = 'dot';
            text.textContent = `Сессия не найдена`;
            badge.style.borderColor = 'var(--red-border)';
            badge.title = 'Нажмите для авто-поиска сессии браузера';
        }
    } catch (e) {
        console.error('Ошибка проверки сессии:', e);
    }
}

async function triggerAutoDetect() {
    showToast('Поиск активной сессии DMarket в установленных браузерах...', 'info', 2500);
    const statusText = document.getElementById('autoDetectResultStatus');
    if (statusText) {
        statusText.innerHTML = '<span class="spinner-tiny"></span> Сканирование браузеров...';
        statusText.className = 'detect-status-text text-amber';
    }

    try {
        const resp = await fetch('/api/cookies/auto-detect', { method: 'POST' });
        const data = await resp.json();

        if (data.success) {
            showToast(data.message, 'success', 4000);
            if (statusText) {
                statusText.innerHTML = `Найдено в <strong>${data.browser}</strong>! ${data.username || ''}`;
                statusText.className = 'detect-status-text text-green';
            }
            checkSessionStatus();
        } else {
            showToast(data.message, 'error', 5000);
            if (statusText) {
                statusText.innerHTML = `Сессия не найдена. Убедитесь, что залогинены на dmarket.com`;
                statusText.className = 'detect-status-text text-red';
            }
        }
    } catch (e) {
        showToast('Ошибка обращения к серверу: ' + e.message, 'error', 4000);
        if (statusText) {
            statusText.textContent = 'Ошибка сети';
            statusText.className = 'detect-status-text text-red';
        }
    }
}

function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    fetch('/api/settings')
        .then(r => r.json())
        .then(data => {
            const input = document.getElementById('manualCookiesInput');
            if (input && data.cookie_preview) {
                input.placeholder = `Текущие: ${data.cookie_preview}`;
            }
        })
        .catch(console.error);
}

function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.add('hidden');
}

async function saveManualCookies() {
    const input = document.getElementById('manualCookiesInput');
    const cookiesVal = input ? input.value.trim() : '';

    if (!cookiesVal) {
        showToast('Введите строку Cookies для сохранения', 'error', 3000);
        return;
    }

    try {
        const resp = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: cookiesVal })
        });
        const data = await resp.json();
        if (data.success) {
            showToast('Куки успешно сохранены!', 'success', 3500);
            checkSessionStatus();
            testSession();
        } else {
            showToast(data.message || 'Ошибка сохранения', 'error', 3500);
        }
    } catch (e) {
        showToast('Ошибка сохранения: ' + e.message, 'error', 3500);
    }
}

async function testSession() {
    const out = document.getElementById('sessionTestOutput');
    if (out) {
        out.classList.remove('hidden');
        out.innerHTML = '<span class="spinner-tiny"></span> Проверка веб-сессии DMarket...';
    }

    try {
        const resp = await fetch('/api/settings/test', { method: 'POST' });
        const res = await resp.json();
        const d = res.data || {};

        if (out) {
            if (d.is_authenticated) {
                out.innerHTML = `
                    <span class="text-green font-mono">Авторизация успешна!</span><br>
                    <span>Пользователь: <strong>${d.username || 'Активен'}</strong></span><br>
                    <span>Баланс: <strong class="text-green">${d.balance_usd !== null ? '$' + d.balance_usd.toFixed(2) : '—'}</strong></span><br>
                    <span class="text-slate">Источник: ${d.browser_source} | Кук в сессии: ${d.cookies_count}</span>
                `;
            } else {
                out.innerHTML = `
                    <span class="text-red font-mono">Сессия не подтверждена DMarket</span><br>
                    <span class="text-secondary">Убедитесь, что вы залогинены на dmarket.com в браузере или используйте браузерное расширение.</span>
                `;
            }
        }
        checkSessionStatus();
    } catch (e) {
        if (out) {
            out.innerHTML = `<span class="text-red">Ошибка проверки: ${e.message}</span>`;
        }
    }
}

function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast-item toast-${type}`;

    let iconSvg = '';
    if (type === 'success') {
        iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    } else if (type === 'error') {
        iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    } else {
        iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }

    toast.innerHTML = `
        <div class="toast-icon">${iconSvg}</div>
        <div class="toast-msg">${message}</div>
    `;

    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-show');
    }, 10);

    setTimeout(() => {
        toast.classList.remove('toast-show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function startScan() {
    fetch('/api/scan/start', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                document.getElementById('progressBanner').classList.remove('hidden');
                document.getElementById('emptyState').classList.add('hidden');
                startPollingStatus();
                showToast('Сканирование предложений запущено', 'info');
            } else {
                showToast(data.message || 'Ошибка запуска сканирования', 'error');
            }
        })
        .catch(err => {
            console.error('Ошибка запуска сканирования:', err);
            showToast('Ошибка подключения к серверу', 'error');
        });
}

function stopScan() {
    fetch('/api/scan/stop', { method: 'POST' })
        .then(r => r.json())
        .then(() => {
            document.getElementById('progressBanner').classList.add('hidden');
            stopPollingStatus();
            loadItems();
            showToast('Сканирование остановлено', 'info');
        })
        .catch(err => console.error('Ошибка остановки:', err));
}

function startPollingStatus() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(checkScanStatus, 1200);
}

function stopPollingStatus() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

function checkScanStatus() {
    fetch('/api/scan/status')
        .then(r => r.json())
        .then(data => {
            if (data.is_scanning) {
                document.getElementById('progressBanner').classList.remove('hidden');
                document.getElementById('emptyState').classList.add('hidden');
                const pct = data.total > 0 ? Math.round((data.progress / data.total) * 100) : 0;
                document.getElementById('progressBar').style.width = pct + '%';
                document.getElementById('progressText').textContent = data.message || `Обработано ${data.progress} из ${data.total}`;
            } else {
                document.getElementById('progressBanner').classList.add('hidden');
                stopPollingStatus();
                if (data.items_count > 0 && allItems.length === 0) {
                    loadItems();
                }
            }

            // Update stats
            document.getElementById('statTotalItems').textContent = data.items_count || 0;
            document.getElementById('statRank1Items').textContent = data.rank_1_count || 0;
            document.getElementById('statPortfolioVal').textContent = '$' + (data.portfolio_val || 0).toFixed(2);
        })
        .catch(err => console.error('Ошибка проверки статуса:', err));
}

function loadItems() {
    fetch('/api/items')
        .then(r => r.json())
        .then(data => {
            if (data.success && data.items && data.items.length > 0) {
                allItems = data.items;
                document.getElementById('emptyState').classList.add('hidden');
                document.getElementById('itemsListSection').classList.remove('hidden');
                updateCountsAndMetrics();
                applyFiltersAndRender();
            } else {
                document.getElementById('emptyState').classList.remove('hidden');
                document.getElementById('itemsListSection').classList.add('hidden');
            }
        })
        .catch(err => console.error('Ошибка загрузки предметов:', err));
}

function updateCountsAndMetrics() {
    const total = allItems.length;
    const rank1Count = allItems.filter(x => x.rank === 1).length;
    const top3Count = allItems.filter(x => x.rank >= 2 && x.rank <= 3).length;
    const rank4Count = allItems.filter(x => x.rank >= 4).length;
    const portfolioVal = allItems.reduce((acc, x) => acc + (x.price_usd || 0), 0);
    const totalProfit = allItems.reduce((acc, x) => acc + (x.profit_usd || 0), 0);

    // Tab counts
    const cAll = document.getElementById('countAll');
    const cR1 = document.getElementById('countRank1');
    const cT3 = document.getElementById('countTop3');
    const cR4 = document.getElementById('countRank4');

    if (cAll) cAll.textContent = total;
    if (cR1) cR1.textContent = rank1Count;
    if (cT3) cT3.textContent = top3Count;
    if (cR4) cR4.textContent = rank4Count;

    // Metrics cards
    document.getElementById('statTotalItems').textContent = total;
    document.getElementById('statRank1Items').textContent = rank1Count;
    document.getElementById('statTop3Items').textContent = top3Count;
    document.getElementById('statRank4Items').textContent = rank4Count;
    document.getElementById('statPortfolioVal').textContent = '$' + portfolioVal.toFixed(2);

    const profitEl = document.getElementById('statProfitVal');
    if (profitEl) {
        const sign = totalProfit >= 0 ? '+' : '';
        profitEl.textContent = `${sign}$${totalProfit.toFixed(2)}`;
        profitEl.className = `metric-value font-mono ${totalProfit >= 0 ? 'text-green' : 'text-red'}`;
    }
}

const WEAR_RANGES = {
    'FN': { min: 0.00, max: 0.07, name: 'Factory New' },
    'MW': { min: 0.07, max: 0.15, name: 'Minimal Wear' },
    'FT': { min: 0.15, max: 0.38, name: 'Field-Tested' },
    'WW': { min: 0.38, max: 0.45, name: 'Well-Worn' },
    'BS': { min: 0.45, max: 1.00, name: 'Battle-Scarred' }
};

function getDMarketSearchUrl(item) {
    const fullTitle = item.title || item.base_title || '';
    const wearInfo = WEAR_RANGES[item.wear_short] || { min: 0, max: 1, name: 'Field-Tested' };
    const fromVal = (item.cat_min !== undefined && item.cat_min !== null) ? Number(item.cat_min).toFixed(2) : Number(wearInfo.min).toFixed(2);
    const toVal = (item.cat_max !== undefined && item.cat_max !== null) ? Number(item.cat_max).toFixed(2) : Number(wearInfo.max).toFixed(2);

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

function applyFiltersAndRender() {
    const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();

    let filtered = allItems.filter(item => {
        if (search && !item.title.toLowerCase().includes(search)) return false;

        if (currentFilter === 'rank1') return item.rank === 1;
        if (currentFilter === 'top3') return item.rank >= 2 && item.rank <= 3;
        if (currentFilter === 'rank4') return item.rank >= 4;
        return true;
    });

    // Sorting
    filtered.sort((a, b) => {
        if (currentSort === 'rank_asc') return a.rank - b.rank || a.price_usd - b.price_usd;
        if (currentSort === 'rank_desc') return b.rank - a.rank || b.price_usd - a.price_usd;
        if (currentSort === 'profit_desc') return (b.profit_usd ?? -999999) - (a.profit_usd ?? -999999);
        if (currentSort === 'price_desc') return b.price_usd - a.price_usd;
        if (currentSort === 'price_asc') return a.price_usd - b.price_usd;
        if (currentSort === 'float_asc') return (a.float_val || 1) - (b.float_val || 1);
        return 0;
    });

    renderItems(filtered);
}

function renderItems(items) {
    const container = document.getElementById('itemsContainer');
    if (!container) return;

    if (items.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px; font-size: 13px;">Нет предметов, соответствующих заданному фильтру.</div>`;
        return;
    }

    container.innerHTML = items.map(item => {
        let rowClass = 'is-rank-other';
        let rankBadgeClass = 'rank-other';
        let rankText = `${item.rank} из ${item.total_in_category}`;

        if (item.rank === 1) {
            rowClass = 'is-rank-1';
            rankBadgeClass = 'rank-1';
        } else if (item.rank <= 3) {
            rowClass = 'is-rank-top3';
            rankBadgeClass = 'rank-top3';
        }

        // Buy price & P&L
        let profitBadgeHtml = '';
        if (item.profit_usd !== null && item.profit_usd !== undefined) {
            const isPos = item.profit_usd >= 0;
            const badgeCls = isPos ? 'profit-pos' : 'profit-neg';
            const sign = isPos ? '+' : '';
            profitBadgeHtml = `<span class="profit-badge ${badgeCls}">${sign}${item.profit_pct}% (${sign}$${item.profit_usd.toFixed(2)})</span>`;
        }

        // Price difference tag
        let diffHtml = '';
        if (item.rank === 1) {
            diffHtml = `<span class="price-diff-tag diff-cheapest">Мин. цена (#1)</span>`;
        } else if (item.price_diff_usd > 0) {
            diffHtml = `<span class="price-diff-tag diff-over">+${item.price_diff_usd.toFixed(2)}$ к #1 (+${item.price_diff_pct}%)</span>`;
        }

        const marketUrl = getDMarketSearchUrl(item);
        const floatDisplay = item.float_val !== null ? item.float_str : 'N/A';
        const seedDisplay = item.paint_seed !== undefined && item.paint_seed !== null ? `Seed: ${item.paint_seed}` : '';
        const catLabel = item.category_label || (item.cat_min !== undefined && item.cat_max !== undefined ? `${item.cat_min} - ${item.cat_max}` : '');

        return `
            <div class="item-row ${rowClass}" id="itemRow_${item.offer_id}">
                <!-- Column 1: Item Thumbnail & Name -->
                <div class="col-item">
                    <div class="item-thumb">
                        <img src="${item.image_url || ''}" alt="" loading="lazy" onerror="this.style.display='none'">
                    </div>
                    <div class="item-meta">
                        <span class="item-name" title="${item.title}">${item.title}</span>
                        <div class="item-tags">
                            <span class="wear-chip">${item.wear_short}</span>
                            ${item.phase_display ? `<span class="phase-chip">${item.phase_display}</span>` : ''}
                            ${seedDisplay ? `<span class="seed-chip">${seedDisplay}</span>` : ''}
                        </div>
                    </div>
                </div>

                <!-- Column 2: Float & Subrange -->
                <div class="col-float">
                    <span class="float-num">${floatDisplay}</span>
                    ${catLabel ? `<span class="wear-range-hint">[${catLabel}]</span>` : ''}
                </div>

                <!-- Column 3: Rank in Category -->
                <div class="col-rank">
                    <span class="rank-pill ${rankBadgeClass}">${rankText}</span>
                </div>

                <!-- Column 4: Buy Price -->
                <div class="col-buy">
                    <span class="buy-price">${item.buy_price_str || '—'}</span>
                </div>

                <!-- Column 5: Sell Price & Profit (-2%) -->
                <div class="col-price">
                    <div class="price-row-top">
                        <span class="price-main">${item.price_str}</span>
                        ${profitBadgeHtml}
                    </div>
                    <div class="price-sub">
                        <span>Мин: ${item.lowest_cat_price_str}</span>
                        ${diffHtml}
                    </div>
                </div>

                <!-- Column 6: Actions -->
                <div class="col-actions">
                    ${(item.rank > 1 && item.lowest_cat_price > 0) ? `
                        <button class="btn-quick-outbid" onclick="outbidCompetitor('${item.offer_id}', ${item.lowest_cat_price})" title="Снизить цену до $${Math.max(0.01, item.lowest_cat_price - 0.01).toFixed(2)} (на $0.01 ниже #1)">
                            Outbid #1 ($${Math.max(0.01, item.lowest_cat_price - 0.01).toFixed(2)})
                        </button>
                    ` : ''}
                    <button class="btn-competitors" onclick="openCompetitorsModal('${item.offer_id}')" title="Посмотреть список предложений в этой категории">
                        Конкуренты (${item.total_in_category})
                    </button>
                    <a href="${marketUrl}" target="_blank" rel="noopener noreferrer" class="btn-dmarket" title="Открыть листинги скина в диапазоне [${catLabel}] на DMarket">
                        DMarket ↗
                    </a>
                </div>
            </div>
        `;
    }).join('');
}

window.openCompetitorsModal = function(offerId) {
    activeModalOfferId = offerId;
    const item = allItems.find(x => x.offer_id === offerId);
    if (!item) return;

    const rangeTitle = item.category_label || (item.cat_min !== undefined ? `${item.cat_min} - ${item.cat_max}` : (item.wear_name || item.wear_short));
    const phaseText = item.phase_display ? ` · ${item.phase_display}` : '';
    document.getElementById('modalTitle').textContent = item.title;
    document.getElementById('modalSubtitle').textContent = `Диапазон: [${rangeTitle}]${phaseText} · Всего предложений: ${item.total_in_category}`;
    
    // Set Header DMarket Search URL
    const dmarketCategoryUrl = getDMarketSearchUrl(item);
    const dmarketLinkEl = document.getElementById('modalDMarketLink');
    if (dmarketLinkEl) {
        dmarketLinkEl.href = dmarketCategoryUrl;
        dmarketLinkEl.title = `Открыть страницу скина в категории [${rangeTitle}] на DMarket`;
    }

    const competitors = item.competitors || [];
    const titleLow = (item.title || '').toLowerCase();
    const isDoppler = titleLow.includes('doppler');
    const isMarbleFade = titleLow.includes('marble fade');
    const isFade = titleLow.includes('fade') && !isMarbleFade;
    const isCaseHardened = titleLow.includes('case hardened');

    const hasAnySpecial = competitors.some(c => c.phase || c.fade_pct || c.tier) || item.phase || item.phase_display;

    let showSpecialCol = false;
    let specialColTitle = 'ФАЗА';

    if (isDoppler) {
        showSpecialCol = true;
        specialColTitle = 'ФАЗА';
    } else if (isMarbleFade) {
        showSpecialCol = true;
        specialColTitle = 'ТИР';
    } else if (isFade) {
        showSpecialCol = true;
        specialColTitle = '% ФЕЙДА';
    } else if (isCaseHardened) {
        showSpecialCol = true;
        specialColTitle = 'ТИР';
    } else if (hasAnySpecial) {
        showSpecialCol = true;
        specialColTitle = 'ФАЗА / ТИР';
    }

    const tbody = competitors.map((c, i) => {
        const isUser = c.is_user_offer || c.offer_id === offerId;
        const rowClass = isUser ? 'user-row' : '';
        const rankNum = i + 1;
        
        let specialChipHtml = '';
        if (showSpecialCol) {
            if (isFade && c.fade_pct) {
                specialChipHtml = `<span class="phase-chip">${c.fade_pct}%</span>`;
            } else if (c.phase) {
                specialChipHtml = `<span class="phase-chip">${c.phase.replace(/-/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())}</span>`;
            } else if (c.tier) {
                specialChipHtml = `<span class="phase-chip">${c.tier}</span>`;
            } else {
                specialChipHtml = '<span style="color: var(--text-muted);">—</span>';
            }
        }

        let priceColHtml = '';
        let actionColHtml = '';

        if (isUser) {
            priceColHtml = `
                <div class="user-price-edit-group">
                    <span class="price-input-prefix">$</span>
                    <input type="number" step="0.01" min="0.01" class="input-user-price" id="userPriceInput_${c.offer_id}" value="${c.price_usd.toFixed(2)}" onkeydown="if(event.key==='Enter') saveUserLotPrice('${item.offer_id}', '${c.offer_id}')">
                    <button class="btn-save-price" id="btnSavePrice_${c.offer_id}" onclick="saveUserLotPrice('${item.offer_id}', '${c.offer_id}')" title="Сохранить цену на DMarket">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        <span>OK</span>
                    </button>
                </div>
            `;
            actionColHtml = `
                <div class="user-action-group">
                    <span class="tag-user-badge">Ваш лот</span>
                    <button class="btn-delist-lot" onclick="cancelOfferLot('${item.offer_id}', '${item.title.replace(/'/g, "\\'")}')" title="Снять этот лот с продажи на DMarket">
                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        <span>Снять</span>
                    </button>
                </div>
            `;
        } else {
            priceColHtml = `<span class="font-mono text-price-bold">$${(c.price_usd || 0).toFixed(2)}</span>`;
            actionColHtml = `
                <div class="comp-action-group">
                    <button class="btn-outbid-lot" onclick="outbidCompetitor('${item.offer_id}', ${c.price_usd})" title="Снизить цену вашего лота на 1¢ ниже конкурента (до $${(Math.max(0.01, c.price_usd - 0.01)).toFixed(2)})">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                        <span>Outbid</span>
                    </button>
                    <button class="btn-buy-lot" onclick="confirmBuyCompetitorLot('${item.offer_id}', '${c.offer_id}', ${c.price_usd}, ${c.float || 0}, '${c.paint_seed || ''}')" title="Выкупить этот лот с DMarket">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
                        <span>Купить</span>
                    </button>
                    <a href="${c.url}" target="_blank" rel="noopener noreferrer" class="btn-dmarket-link" title="Открыть лот на DMarket">
                        Открыть ↗
                    </a>
                </div>
            `;
        }

        return `
            <tr class="${rowClass}">
                <td style="font-weight: 700;">${rankNum}</td>
                <td>${priceColHtml}</td>
                <td style="font-family: var(--font-mono);">${c.float ? c.float.toFixed(4) : '—'}</td>
                <td>${c.paint_seed || '—'}</td>
                ${showSpecialCol ? `<td>${specialChipHtml}</td>` : ''}
                <td>${actionColHtml}</td>
            </tr>
        `;
    }).join('');

    const colCount = showSpecialCol ? 6 : 5;
    document.getElementById('modalBody').innerHTML = `
        <table class="comp-table">
            <thead>
                <tr>
                    <th style="width: 38px;">№</th>
                    <th style="width: 165px;">Цена</th>
                    <th style="width: 80px;">Float</th>
                    <th style="width: 55px;">Seed</th>
                    ${showSpecialCol ? `<th style="width: 85px;">${specialColTitle}</th>` : ''}
                    <th style="min-width: 220px;">Действие</th>
                </tr>
            </thead>
            <tbody>
                ${tbody || `<tr><td colspan="${colCount}" style="text-align: center; color: var(--text-muted);">Нет данных</td></tr>`}
            </tbody>
        </table>
    `;

    document.getElementById('competitorsModal').classList.remove('hidden');
};

window.refreshCurrentModalItem = function() {
    if (!activeModalOfferId) return;

    const btn = document.getElementById('modalRefreshBtn');
    const icon = document.getElementById('modalRefreshIcon');
    const text = document.getElementById('modalRefreshText');

    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('icon-spin');
    if (text) text.textContent = 'Обновление...';

    fetch('/api/offers/refresh-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer_id: activeModalOfferId })
    })
    .then(r => r.json())
    .then(data => {
        if (btn) btn.disabled = false;
        if (icon) icon.classList.remove('icon-spin');
        if (text) text.textContent = 'Обновить';

        if (data.success && data.item) {
            const idx = allItems.findIndex(x => x.offer_id === activeModalOfferId);
            if (idx !== -1) {
                allItems[idx] = data.item;
            }
            updateCountsAndMetrics();
            applyFiltersAndRender();
            openCompetitorsModal(activeModalOfferId);
            showToast(data.message || 'Список предложений успешно обновлен', 'success');
        } else {
            showToast(data.message || 'Ошибка обновления предложений', 'error');
        }
    })
    .catch(err => {
        console.error('Ошибка обновления:', err);
        if (btn) btn.disabled = false;
        if (icon) icon.classList.remove('icon-spin');
        if (text) text.textContent = 'Обновить';
        showToast('Сетевая ошибка при обновлении', 'error');
    });
};

window.outbidCompetitor = function(parentOfferId, competitorPriceUsd, offset = 0.01) {
    const item = allItems.find(x => x.offer_id === parentOfferId);
    if (!item) return;

    let userOfferId = parentOfferId;
    if (item.competitors) {
        const userComp = item.competitors.find(c => c.is_user_offer || c.offer_id === parentOfferId);
        if (userComp) userOfferId = userComp.offer_id;
    }

    const newTargetPrice = Math.max(0.01, parseFloat((competitorPriceUsd - offset).toFixed(2)));
    
    const input = document.getElementById(`userPriceInput_${userOfferId}`);
    if (input) {
        input.value = newTargetPrice.toFixed(2);
    }

    showToast(`Outbid: снижаем цену вашего лота до $${newTargetPrice.toFixed(2)} (–$${offset.toFixed(2)})...`, 'info', 2500);
    saveUserLotPrice(parentOfferId, userOfferId);
};

window.saveUserLotPrice = function(parentOfferId, offerId) {
    const input = document.getElementById(`userPriceInput_${offerId}`);
    const btn = document.getElementById(`btnSavePrice_${offerId}`);
    if (!input) return;

    const newPriceVal = parseFloat(input.value);
    if (isNaN(newPriceVal) || newPriceVal <= 0) {
        showToast('Введите корректную цену (больше $0.00)', 'error');
        input.focus();
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<div class="spinner-tiny"></div>`;
    }

    fetch('/api/offers/edit-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            offer_id: offerId,
            price: newPriceVal
        })
    })
    .then(r => r.json())
    .then(data => {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg><span>OK</span>`;
        }

        if (data.success && data.item) {
            // Update in allItems
            const idx = allItems.findIndex(x => x.offer_id === parentOfferId || x.offer_id === offerId);
            if (idx !== -1) {
                allItems[idx] = data.item;
            }

            updateCountsAndMetrics();
            applyFiltersAndRender();

            // Re-render modal to reflect new ranking and price
            if (activeModalOfferId) {
                openCompetitorsModal(activeModalOfferId);
            }

            showToast(data.message || `Цена успешно изменена на $${newPriceVal.toFixed(2)}`, 'success');
        } else {
            showToast(data.message || 'Ошибка обновления цены', 'error');
        }
    })
    .catch(err => {
        console.error('Ошибка изменения цены:', err);
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg><span>OK</span>`;
        }
        showToast('Сетевая ошибка при изменении цены', 'error');
    });
};

let pendingBuyParams = null;

window.confirmBuyCompetitorLot = function(parentOfferId, competitorOfferId, priceUsd, floatVal, seedVal) {
    const parentItem = allItems.find(x => x.offer_id === parentOfferId);
    const itemTitle = parentItem ? parentItem.title : 'Выбранный скин';

    pendingBuyParams = {
        parentOfferId,
        competitorOfferId,
        priceUsd
    };

    document.getElementById('buyConfirmItemTitle').textContent = itemTitle;
    document.getElementById('buyConfirmPrice').textContent = `$${priceUsd.toFixed(2)}`;
    document.getElementById('buyConfirmFloat').textContent = floatVal ? floatVal.toFixed(4) : '—';
    document.getElementById('buyConfirmSeed').textContent = seedVal || '—';

    const checkbox = document.getElementById('buyConfirmCheckbox');
    if (checkbox) checkbox.checked = false;

    const executeBtn = document.getElementById('buyExecuteBtn');
    const executeBtnText = document.getElementById('buyExecuteBtnText');
    if (executeBtn) {
        executeBtn.disabled = true;
        executeBtn.onclick = () => executeBuyCompetitorLot();
    }
    if (executeBtnText) {
        executeBtnText.textContent = 'Купить лот';
    }

    document.getElementById('buyConfirmModal').classList.remove('hidden');
};

function closeBuyConfirmModal() {
    const modal = document.getElementById('buyConfirmModal');
    if (modal) modal.classList.add('hidden');
    pendingBuyParams = null;
}

function executeBuyCompetitorLot() {
    if (!pendingBuyParams) return;

    const checkbox = document.getElementById('buyConfirmCheckbox');
    if (checkbox && !checkbox.checked) {
        showToast('Пожалуйста, подтвердите согласие на списание средств', 'error');
        return;
    }

    const { competitorOfferId, priceUsd } = pendingBuyParams;
    const executeBtn = document.getElementById('buyExecuteBtn');
    const executeBtnText = document.getElementById('buyExecuteBtnText');
    
    if (executeBtn) executeBtn.disabled = true;
    if (executeBtnText) executeBtnText.textContent = 'Покупка...';

    fetch('/api/offers/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            offer_id: competitorOfferId,
            price: priceUsd
        })
    })
    .then(r => r.json())
    .then(data => {
        if (executeBtn) executeBtn.disabled = false;
        if (executeBtnText) executeBtnText.textContent = 'Купить лот';
        closeBuyConfirmModal();

        if (data.success) {
            showToast(data.message || `Лот успешно выкуплен за $${priceUsd.toFixed(2)}!`, 'success');
        } else {
            showToast(data.message || 'Не удалось выкупить лот', 'error');
        }
    })
    .catch(err => {
        console.error('Ошибка покупки лота:', err);
        if (executeBtn) executeBtn.disabled = false;
        if (executeBtnText) executeBtnText.textContent = 'Купить лот';
        closeBuyConfirmModal();
        showToast('Сетевая ошибка при покупке лота', 'error');
    });
}

function closeModal() {
    const modal = document.getElementById('competitorsModal');
    if (modal) modal.classList.add('hidden');
    activeModalOfferId = null;
}

window.cancelOfferLot = function(offerId, itemTitle) {
    if (!confirm(`Вы действительно хотите снять с продажи «${itemTitle || 'этот скин'}»?`)) return;

    showToast('Снятие лота с продажи на DMarket...', 'info', 2500);
    fetch('/api/offers/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer_id: offerId })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            allItems = allItems.filter(x => x.offer_id !== offerId);
            updateCountsAndMetrics();
            applyFiltersAndRender();
            if (activeModalOfferId === offerId) {
                closeModal();
            }
            showToast(data.message || 'Лот успешно снят с продажи', 'success');
        } else {
            showToast(data.message || 'Ошибка снятия с продажи', 'error');
        }
    })
    .catch(err => {
        console.error('Ошибка снятия лота:', err);
        showToast('Сетевая ошибка при снятии лота', 'error');
    });
};


