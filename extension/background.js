// Background Service Worker для DMarket Float Tracker (по архитектуре cyberbebebe)

// При клике на иконку расширения — открываем дашборд в новой вкладке
chrome.action.onClicked.addListener((tab) => {
    const dashboardUrl = chrome.runtime.getURL("dashboard.html");
    chrome.tabs.create({ url: dashboardUrl });
});

// Слушатель сообщений от контентного скрипта
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "OPEN_DASHBOARD") {
        const dashboardUrl = chrome.runtime.getURL("dashboard.html");
        chrome.tabs.create({ url: dashboardUrl });
        sendResponse({ success: true });
        return true;
    }
});
