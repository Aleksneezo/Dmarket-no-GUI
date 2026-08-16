// Background Service Worker for DMarket Float Tracker (cyberbebebe architecture)

// On extension icon click — open dashboard in a new tab
chrome.action.onClicked.addListener((tab) => {
    const dashboardUrl = chrome.runtime.getURL("dashboard.html");
    chrome.tabs.create({ url: dashboardUrl });
});

// Content script message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "OPEN_DASHBOARD") {
        const dashboardUrl = chrome.runtime.getURL("dashboard.html");
        chrome.tabs.create({ url: dashboardUrl });
        sendResponse({ success: true });
        return true;
    }
});
