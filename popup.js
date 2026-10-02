const slider = document.getElementById("slider");
const speedValue = document.getElementById("speedValue");
const statusText = document.getElementById("statusText");
const presetButtons = [...document.querySelectorAll("[data-speed]")];

function formatSpeed(speed) {
    return `${Number(speed).toFixed(2)}×`;
}

async function getCurrentSpeed() {
    const data = await chrome.storage.local.get({ speed: 1 });
    return Number(data.speed);
}

async function sendSpeed(speed) {
    speed = Math.min(Math.max(Number(speed), 0.25), 5);

    await chrome.storage.local.set({ speed });

    slider.value = speed;
    speedValue.textContent = formatSpeed(speed);

    presetButtons.forEach(button => {
        button.classList.toggle(
            "active",
            Number(button.dataset.speed) === speed
        );
    });

    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    if (tabs[0]?.id != null) {
        try {
            await chrome.tabs.sendMessage(tabs[0].id, {
                type: "setSpeed",
                speed
            });
            statusText.textContent = "Speed applied";
        } catch (_) {
            statusText.textContent = "Open a video page";
        }
    }
}

slider.addEventListener("input", () => {
    sendSpeed(slider.value);
});

document.getElementById("minus").addEventListener("click", async () => {
    const speed = await getCurrentSpeed();
    sendSpeed(speed - 0.25);
});

document.getElementById("plus").addEventListener("click", async () => {
    const speed = await getCurrentSpeed();
    sendSpeed(speed + 0.25);
});

presetButtons.forEach(button => {
    button.addEventListener("click", () => {
        sendSpeed(button.dataset.speed);
    });
});

(async () => {
    const speed = await getCurrentSpeed();
    slider.value = speed;
    speedValue.textContent = formatSpeed(speed);
    presetButtons.forEach(button => {
        button.classList.toggle(
            "active",
            Number(button.dataset.speed) === speed
        );
    });
})();