document.addEventListener("DOMContentLoaded", () => {
    checkDMarketSession();

    const openBtn = document.getElementById("openDashboardBtn");
    if (openBtn) {
        openBtn.addEventListener("click", () => {
            const url = chrome.runtime.getURL("src/pages/dashboard.html");
            chrome.tabs.create({ url: url });
        });
    }
});

async function checkDMarketSession() {
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const userText = document.getElementById("userText");

    try {
        const resp = await fetch("https://api.dmarket.com/account/v1/user", {
            credentials: "include"
        });

        if (resp.ok) {
            const profile = await resp.json();
            if (statusDot) statusDot.className = "dot active";
            if (statusText) {
                statusText.textContent = "Active";
                statusText.style.color = "#34d399";
            }
            if (userText) {
                userText.textContent = profile.username || profile.email || "Authorized";
            }
        } else {
            if (statusDot) statusDot.className = "dot";
            if (statusText) {
                statusText.textContent = "Unauthorized";
                statusText.style.color = "#fb7185";
            }
            if (userText) userText.textContent = "Login on dmarket.com";
        }
    } catch (e) {
        if (statusDot) statusDot.className = "dot";
        if (statusText) {
            statusText.textContent = "Network Error";
            statusText.style.color = "#fb7185";
        }
    }
}
