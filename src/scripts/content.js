// Content script running in world: "ISOLATED"
// Native Auth works via background and popup scripts. This script just manages the floating button.

(function () {
    console.log("[DMarket Content] Float Tracker UI initialized.");

    // Floating button
    function injectFloatingButton() {
        if (document.getElementById("dm-tracker-floating-btn")) return;

        const btn = document.createElement("div");
        btn.id = "dm-tracker-floating-btn";
        btn.innerHTML = `
            <div style="
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 999999;
                background: #111722;
                border: 1px solid #3b82f6;
                border-radius: 8px;
                padding: 10px 14px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.6);
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                color: #f3f4f6;
                font-size: 12px;
                font-weight: 600;
                transition: transform 0.2s, background 0.2s;
            ">
                <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#34d399; box-shadow:0 0 6px #34d399;"></span>
                <span>Float Tracker</span>
            </div>
        `;

        btn.addEventListener("click", () => {
            try {
                if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
                    chrome.runtime.sendMessage({ action: "OPEN_DASHBOARD" });
                }
            } catch (e) { }
        });

        btn.addEventListener("mouseenter", () => {
            if (btn.firstElementChild) {
                btn.firstElementChild.style.transform = "scale(1.05)";
                btn.firstElementChild.style.background = "#161e2e";
            }
        });

        btn.addEventListener("mouseleave", () => {
            if (btn.firstElementChild) {
                btn.firstElementChild.style.transform = "scale(1)";
                btn.firstElementChild.style.background = "#111722";
            }
        });

        document.body.appendChild(btn);
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        injectFloatingButton();
    } else {
        window.addEventListener("DOMContentLoaded", injectFloatingButton);
    }
})();
