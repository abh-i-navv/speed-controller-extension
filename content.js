(() => {
    let speed = 1;
    let initialized = false;

    function applySpeed() {
        document.querySelectorAll("video").forEach(video => {
            try {
                video.defaultPlaybackRate = speed;
                video.playbackRate = speed;
            } catch (_) {}
        });
    }

    function setSpeed(value) {
        speed = Math.min(Math.max(Number(value) || 1, 0.25), 5);
        applySpeed();
        chrome.storage.local.set({ speed });
    }

    chrome.storage.local.get("speed", data => {
        if (typeof data.speed === "number") speed = data.speed;
        initialized = true;
        applySpeed();
    });

    chrome.runtime.onMessage.addListener(message => {
        if (message.type === "setSpeed") {
            setSpeed(message.speed);
        }
    });

    // Reapply as a safety net for players that replace their video element.
    setInterval(() => {
        if (initialized) applySpeed();
    }, 500);

    const observer = new MutationObserver(applySpeed);
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    document.addEventListener("keydown", event => {
        const target = event.target;
        if (
            target &&
            (target.tagName === "INPUT" ||
             target.tagName === "TEXTAREA" ||
             target.isContentEditable)
        ) return;

        if (event.key === "]") {
            setSpeed(speed + 0.25);
        } else if (event.key === "[") {
            setSpeed(speed - 0.25);
        } else if (event.key === "\\") {
            setSpeed(1);
        }
    });

    window.videoSpeed = setSpeed;
})();