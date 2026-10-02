chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type === "setSpeed" && sender.tab?.id != null) {
        chrome.tabs.sendMessage(sender.tab.id, {
            type: "setSpeed",
            speed: message.speed
        }).catch(() => {});
    }
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get("speed", data => {
        if (typeof data.speed !== "number") {
            chrome.storage.local.set({ speed: 1 });
        }
    });
});