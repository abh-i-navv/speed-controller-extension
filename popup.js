const $ = id => document.getElementById(id);

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
    normal:    { bands: [0,0,0,0,0,0,0,0,0,0], bass: 0, treble: 0, eqEnabled: false },
    flat:      { bands: [0,0,0,0,0,0,0,0,0,0], bass: 0, treble: 0, eqEnabled: true },
    bass:      { bands: [4,3,2,1,0,0,0,0,0,0], bass: 6, treble: 0 },
    treble:    { bands: [0,0,0,0,0,0,1,2,4,5], bass: 0, treble: 5 },
    vocal:     { bands: [-2,-1,0,2,4,4,3,1,-1,-2], bass: 0, treble: 1 },
    rock:      { bands: [3,2,-1,-2,1,2,3,2,3,2], bass: 2, treble: 2 },
    pop:       { bands: [1,2,2,1,-1,-1,1,2,2,2], bass: 2, treble: 2 },
    movie:     { bands: [4,3,2,0,-1,-1,1,3,4,3], bass: 4, treble: 3 },
    classical: { bands: [3,2,1,0,-1,-1,0,1,2,3], bass: 1, treble: 2 },
    electronic:{ bands: [4,3,1,0,-1,1,2,3,4,4], bass: 4, treble: 4, eqEnabled: true }
};

let tab = null;
let site = null;
let scope = "site";
let siteProfile = null;
let tabOverride = null;
let current = null;
let infoTimer = null;
let initializedEq = false;
let saveTimer = null;

function defaultProfile(configured = false) {
    return {
        speed: 1,
        enabled: false,
        floating: false,
        floatX: null,
        floatY: null,
        collapsed: true,
        configured,
        volumeBoostEnabled: false,
        volumeBoost: 100,
        eqEnabled: false,
        bassBoost: 0,
        trebleBoost: 0,
        compressorEnabled: false,
        eqBands: Array(10).fill(0)
    };
}

function siteKey(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch (_) {
        return null;
    }
}

function clampBoost(value) {
    return Math.min(600, Math.max(100, Number(value) || 100));
}

function clampTone(value) {
    return Math.min(20, Math.max(0, Number(value) || 0));
}

function clampBand(value) {
    return Math.min(12, Math.max(-12, Number(value) || 0));
}

function normalizedCurrent() {
    const next = { ...defaultProfile(true), ...(current || {}) };
    next.eqBands = EQ_FREQUENCIES.map((_, i) => clampBand(next.eqBands?.[i]));
    next.volumeBoost = clampBoost(next.volumeBoost);
    next.bassBoost = clampTone(next.bassBoost);
    next.trebleBoost = clampTone(next.trebleBoost);
    return next;
}


function getEqPresetName(profile = current) {
    if (!profile) return "normal";
    if (!profile.eqEnabled) return "normal";

    const bands = Array.isArray(profile.eqBands) ? profile.eqBands.map(Number) : Array(10).fill(0);
    const bass = clampTone(profile.bassBoost);
    const treble = clampTone(profile.trebleBoost);

    for (const [name, preset] of Object.entries(EQ_PRESETS)) {
        if (name === "normal") continue;
        if (bass === preset.bass && treble === preset.treble &&
            bands.length === preset.bands.length &&
            preset.bands.every((value, index) => Number(value) === Number(bands[index]))) {
            return name;
        }
    }
    return "custom";
}

function syncEqPresetSelect() {
    const select = $("eqPreset");
    if (select) select.value = getEqPresetName(current);
}

function hasAudioProcessing(profile = current) {
    // Volume Booster is the master switch for the entire Web Audio path.
    return Boolean(profile?.volumeBoostEnabled);
}

function renderEqBands() {
    if (!initializedEq) return;
    const container = $("eqBands");
    container.innerHTML = "";

    const bands = current?.eqBands || Array(10).fill(0);
    EQ_FREQUENCIES.forEach((frequency, index) => {
        const row = document.createElement("label");
        row.className = "eq-row";

        const freq = document.createElement("span");
        freq.className = "freq";
        freq.textContent = frequency >= 1000 ? `${frequency / 1000}k` : `${frequency}`;

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = -12;
        slider.max = 12;
        slider.step = 1;
        slider.value = bands[index] ?? 0;
        slider.dataset.eqIndex = String(index);

        const db = document.createElement("span");
        db.className = "db";
        db.textContent = `${Number(slider.value) > 0 ? "+" : ""}${slider.value} dB`;

        slider.addEventListener("input", () => {
            current.eqBands[index] = clampBand(slider.value);
            db.textContent = `${current.eqBands[index] > 0 ? "+" : ""}${current.eqBands[index]} dB`;
            $("eqPreset").value = "custom";
            renderAudioControlsOnly();
            // Persist EQ changes immediately so closing the popup cannot lose the last setting.
            void sendCurrentState();
        });

        row.append(freq, slider, db);
        container.appendChild(row);
    });
}

function renderAudioControlsOnly() {
    if (!current) return;
    $("volumeBoostEnabled").checked = Boolean(current.volumeBoostEnabled);
    $("volumeBoost").value = clampBoost(current.volumeBoost);
    $("volumeBoostValue").textContent = `${Math.round(clampBoost(current.volumeBoost))}%`;
    $("compressorEnabled").checked = Boolean(current.compressorEnabled);
    $("bassBoost").value = clampTone(current.bassBoost);
    $("bassBoostValue").textContent = `${Math.round(clampTone(current.bassBoost))} dB`;
    $("trebleBoost").value = clampTone(current.trebleBoost);
    $("trebleBoostValue").textContent = `${Math.round(clampTone(current.trebleBoost))} dB`;
    syncEqPresetSelect();

    const audioDisabled = !current.volumeBoostEnabled;
    $("volumeBoost").disabled = false;
    $("eqPreset").disabled = audioDisabled;
    $("bassBoost").disabled = audioDisabled;
    $("trebleBoost").disabled = audioDisabled;
    $("compressorEnabled").disabled = audioDisabled;
    $("eqDetails").style.opacity = audioDisabled ? ".62" : "1";
    $("eqBands").querySelectorAll("input").forEach(input => {
        input.disabled = audioDisabled;
    });
}

function render() {
    if (!current) return;

    current = normalizedCurrent();

    $("enabled").checked = Boolean(current.enabled);
    $("slider").value = current.speed;
    $("value").textContent = `${Number(current.speed).toFixed(2)}×`;
    $("state").textContent = current.enabled ? "On" : "Off";
    $("status").textContent = current.configured
        ? `${scope === "tab" ? "This Tab" : "Site Default"} • ${current.enabled ? `${Number(current.speed).toFixed(2)}×` : "Speed Off"}`
        : scope === "tab"
            ? "Using Site Default — change a control to create an override"
            : "New site — Speed Off by default";

    $("dot").classList.toggle("on", Boolean(current.enabled || hasAudioProcessing(current)));

    document.querySelectorAll("[data-speed]").forEach(button => {
        button.classList.toggle(
            "active",
            Math.abs(Number(button.dataset.speed) - Number(current.speed)) < 0.0001
        );
    });

    $("siteMode").classList.toggle("active", scope === "site");
    $("tabMode").classList.toggle("active", scope === "tab");

    if (scope === "site") {
        $("scopeTitle").textContent = "Site Default";
        $("scopeDescription").textContent = "Saved for this website and reused in its tabs.";
        $("scopeNote").textContent = tabOverride
            ? "This tab has a temporary override, so site changes will not affect playback here until you clear it."
            : "Changes here become the permanent default for this domain.";
        $("resetTab").style.display = tabOverride ? "block" : "none";
    } else {
        $("scopeTitle").textContent = "This Tab";
        $("scopeDescription").textContent = "Temporary override for this tab only.";
        $("scopeNote").textContent = "Changes here affect only this tab. The site default stays unchanged.";
        $("resetTab").style.display = "block";
    }

    $("float").textContent = current.floating ? "Hide Floating Controls" : "Floating Controls";
    renderAudioControlsOnly();
    renderEqBands();
}

async function loadState() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
    if (!tab?.id || !tab.url) return;

    site = siteKey(tab.url);
    $("site").textContent = site || "Current site";

    const response = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: "getEffectiveProfile", tabId: tab.id, url: tab.url }, resolve);
    });

    if (!response?.ok) {
        siteProfile = defaultProfile(false);
        tabOverride = null;
    } else {
        siteProfile = response.siteProfile || defaultProfile(false);
        tabOverride = response.tabOverride || null;
    }

    current = scope === "tab" && tabOverride ? { ...tabOverride } : { ...siteProfile };
    render();
    queryInfo();
    startInfoPolling();
    loadSites();
}

async function sendCurrentState() {
    if (!tab?.id || !tab.url || !current) return;

    current.configured = true;
    current = normalizedCurrent();
    render();

    const type = scope === "tab" ? "setTabState" : "setSiteState";
    const response = await new Promise(resolve => {
        chrome.runtime.sendMessage({
            type,
            tabId: tab.id,
            url: tab.url,
            state: current
        }, resolve);
    });

    if (scope === "tab") tabOverride = { ...current };
    else siteProfile = { ...current };

    render();
    queryInfo();

    if (!response?.ok) {
        $("status").textContent = "Saved, but the page may need a reload";
    }
}

function queueSave(delay = 45) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        sendCurrentState();
    }, delay);
}

function setSpeed(value) {
    current.speed = Math.min(Math.max(Number(value), 0.25), 5);
    current.configured = true;
    render();
    sendCurrentState();
}

async function setScope(nextScope) {
    if (nextScope === scope) return;
    scope = nextScope;
    if (scope === "site") {
        current = { ...(siteProfile || defaultProfile(false)) };
    } else {
        current = tabOverride ? { ...tabOverride } : { ...(siteProfile || defaultProfile(false)), configured: false };
    }
    render();
}

function resetTab() {
    if (!tab?.id || !tab.url) return;
    chrome.runtime.sendMessage({ type: "clearTabState", tabId: tab.id, url: tab.url }, () => {
        tabOverride = null;
        scope = "site";
        current = { ...(siteProfile || defaultProfile(false)) };
        render();
        queryInfo();
    });
}

function applyPreset(name) {
    const preset = EQ_PRESETS[name];
    if (!preset || !current.volumeBoostEnabled) return;
    current.eqEnabled = name !== "normal";
    current.eqBands = [...preset.bands];
    current.bassBoost = preset.bass;
    current.trebleBoost = preset.treble;
    $("eqPreset").value = name;
    renderEqBands();
    renderAudioControlsOnly();
    // Preset selection must survive closing the popup immediately.
    void sendCurrentState();
}

function initEqUi() {
    initializedEq = true;
    renderEqBands();
    $("eqPreset").addEventListener("change", event => {
        if (event.target.value === "custom") return;
        applyPreset(event.target.value);
    });

    $("resetEq").addEventListener("click", () => {
        // Reset EQ atomically. Do not apply the Flat preset first and then
        // turn EQ off: that used to generate an intermediate audio state and
        // could interrupt playback on players such as YouTube.
        current.eqEnabled = false;
        current.eqBands = Array(EQ_FREQUENCIES.length).fill(0);
        current.bassBoost = 0;
        current.trebleBoost = 0;
        $("eqPreset").value = "normal";
        current.configured = true;
        render();
        sendCurrentState();
    });
}

$("siteMode").addEventListener("click", () => setScope("site"));
$("tabMode").addEventListener("click", () => setScope("tab"));
$("resetTab").addEventListener("click", resetTab);

$("enabled").addEventListener("change", event => {
    current.enabled = Boolean(event.target.checked);
    current.configured = true;
    render();
    // No debounce for toggles: state is pushed immediately.
    sendCurrentState();
});

$("slider").addEventListener("input", event => {
    current.speed = Number(event.target.value);
    render();
    queueSave(25);
});

$("minus").addEventListener("click", () => setSpeed(current.speed - 0.25));
$("plus").addEventListener("click", () => setSpeed(current.speed + 0.25));
$("applyCustom").addEventListener("click", () => {
    const value = Number($("custom").value);
    if (Number.isFinite(value) && value >= 0.25 && value <= 5) setSpeed(value);
});

document.querySelectorAll("[data-speed]").forEach(button => {
    button.addEventListener("click", () => setSpeed(Number(button.dataset.speed)));
});

document.querySelectorAll("[data-skip]").forEach(button => {
    button.addEventListener("click", () => {
        chrome.runtime.sendMessage({
            type: "skipAllFrames",
            tabId: tab.id,
            seconds: Number(button.dataset.skip)
        });
    });
});

$("volumeBoostEnabled").addEventListener("change", event => {
    current.volumeBoostEnabled = Boolean(event.target.checked);
    current.configured = true;
    render();
    sendCurrentState();
});

$("volumeBoost").addEventListener("input", event => {
    current.volumeBoost = clampBoost(event.target.value);
    current.volumeBoostEnabled = true;
    renderAudioControlsOnly();
    current.configured = true;
    void sendCurrentState();
});

$("compressorEnabled").addEventListener("change", event => {
    if (!current.volumeBoostEnabled) return;
    current.compressorEnabled = Boolean(event.target.checked);
    current.configured = true;
    render();
    sendCurrentState();
});

$("bassBoost").addEventListener("input", event => {
    current.bassBoost = clampTone(event.target.value);
    if (!current.volumeBoostEnabled) return;
    current.eqEnabled = true;
    $("eqPreset").value = "custom";
    renderAudioControlsOnly();
    current.configured = true;
    void sendCurrentState();
});

$("trebleBoost").addEventListener("input", event => {
    current.trebleBoost = clampTone(event.target.value);
    if (!current.volumeBoostEnabled) return;
    current.eqEnabled = true;
    $("eqPreset").value = "custom";
    renderAudioControlsOnly();
    current.configured = true;
    void sendCurrentState();
});

$("float").addEventListener("click", () => {
    current.floating = !current.floating;
    current.collapsed = true;
    current.configured = true;
    sendCurrentState();
});

$("pip").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "pipAllFrames", tabId: tab.id }, response => {
        if (chrome.runtime.lastError || !response?.ok) {
            $("status").textContent = "PiP unavailable for this player";
        }
    });
});

async function queryInfo() {
    if (!tab?.id) return;

    if (!current?.enabled && !current?.floating && !hasAudioProcessing(current)) {
        $("playerDot").classList.remove("on");
        $("infoBannerText").textContent = "Player inspection is inactive while controls are off";
        ["iResolution","iTime","iSpeed","iVolume","iBoost","iEq","iPlayers","iPip","iBuffer","iDropped","iPlayback"]
            .forEach(id => $(id).textContent = "—");
        return;
    }

    chrome.runtime.sendMessage({ type: "getStatusAllFrames", tabId: tab.id }, response => {
        const playerStatus = response?.status;
        if (chrome.runtime.lastError || !response?.ok || !playerStatus) {
            $("playerDot").classList.remove("on");
            $("infoBannerText").textContent = "Player not available in this page";
            ["iResolution","iTime","iSpeed","iVolume","iBoost","iEq","iPlayers","iPip","iBuffer","iDropped","iPlayback"]
                .forEach(id => $(id).textContent = "—");
            return;
        }

        const detected = Boolean(playerStatus.detected);
        $("playerDot").classList.toggle("on", detected || hasAudioProcessing(current));
        $("infoBannerText").textContent = detected
            ? `${playerStatus.videoCount} video player${playerStatus.videoCount === 1 ? "" : "s"} detected`
            : "No standard HTML5 video player detected";

        $("iResolution").textContent = playerStatus.width && playerStatus.height ? `${playerStatus.width} × ${playerStatus.height}` : "—";
        $("iTime").textContent = detected ? `${formatTime(playerStatus.currentTime)} / ${formatTime(playerStatus.duration)}` : "—";
        $("iSpeed").textContent = detected ? `${Number(playerStatus.playbackRate).toFixed(2)}×` : "—";
        $("iVolume").textContent = detected ? `${Math.round(playerStatus.volume * 100)}%` : "—";
        $("iBoost").textContent = playerStatus.volumeBoostEnabled ? `${Math.round(playerStatus.volumeBoost)}%` : "Off";
        $("iEq").textContent = playerStatus.volumeBoostEnabled ? (playerStatus.eqEnabled ? "On" : "Normal") : "Off";
        $("iPlayers").textContent = String(playerStatus.videoCount || 0);
        $("iBuffer").textContent = detected ? `${Number(playerStatus.buffered || 0).toFixed(1)}s` : "—";
        $("iDropped").textContent = playerStatus.droppedFrames != null
            ? `${playerStatus.droppedFrames}${playerStatus.totalFrames != null ? ` / ${playerStatus.totalFrames}` : ""}`
            : "Unavailable";
        $("iPip").textContent = !detected ? "—" : playerStatus.pipActive ? "Active" : playerStatus.pipSupported ? "Available" : "Unavailable";
        $("pip").classList.toggle("active", Boolean(playerStatus.pipActive));
        $("pip").textContent = playerStatus.pipActive ? "Exit Picture-in-Picture" : "Picture-in-Picture";
        $("iPlayback").textContent = detected ? (playerStatus.paused ? "Paused" : "Playing") : "No player";
        $("debugNote").textContent = detected
            ? `Ready state: ${playerStatus.readyState} • ${playerStatus.scope === "tab" ? "This Tab" : "Site Default"}`
            : "No standard HTML5 video detected.";
    });
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "--:--";
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function startInfoPolling() {
    clearInterval(infoTimer);
    infoTimer = setInterval(() => {
        if ($("infoTab").classList.contains("active")) queryInfo();
    }, 700);
}

async function loadSites() {
    const response = await new Promise(resolve => chrome.runtime.sendMessage({ type: "getProfiles" }, resolve));
    const list = $("sitesList");
    const empty = $("sitesEmpty");
    list.innerHTML = "";

    const entries = Object.entries(response?.profiles || {}).sort(([a], [b]) => a.localeCompare(b));
    empty.style.display = entries.length ? "none" : "block";

    for (const [domain, profile] of entries) {
        const card = document.createElement("div");
        card.className = "site-card";
        const row = document.createElement("div");
        row.className = "site-row";
        const info = document.createElement("div");
        const domainEl = document.createElement("div");
        domainEl.className = "site-domain";
        domainEl.textContent = domain;
        const meta = document.createElement("div");
        meta.className = "site-meta";
        const audio = profile.volumeBoostEnabled ? ` • ${Math.round(profile.volumeBoost)}% boost` : "";
        meta.textContent = `${profile.enabled ? "On" : "Speed Off"} • ${Number(profile.speed).toFixed(2)}×${audio}`;
        info.append(domainEl, meta);
        const reset = document.createElement("button");
        reset.className = "site-delete";
        reset.textContent = "Reset";
        reset.addEventListener("click", async () => {
            await new Promise(resolve => chrome.runtime.sendMessage({ type: "deleteProfile", site: domain, tabId: tab?.id }, resolve));
            if (domain === site) await loadState();
            else await loadSites();
        });
        row.append(info, reset);
        card.appendChild(row);
        list.appendChild(card);
    }
}

$("refreshSites").addEventListener("click", loadSites);
document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(section => section.classList.remove("active"));
        button.classList.add("active");
        $(`${button.dataset.tab}Tab`).classList.add("active");
        if (button.dataset.tab === "info") queryInfo();
        if (button.dataset.tab === "sites") loadSites();
    });
});

chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "profileChanged" && tab?.id === message.tabId) {
        const incoming = { ...(message.state || {}) };
        if (message.scope === "tab") {
            tabOverride = incoming;
            if (scope === "tab") current = { ...incoming };
        } else {
            siteProfile = incoming;
            if (scope === "site" && !tabOverride) current = { ...incoming };
        }
        render();
    }

    if (message?.type === "pipStateChanged" && tab?.id === message.tabId) {
        const active = Boolean(message.active);
        $("pip").classList.toggle("active", active);
        $("pip").textContent = active ? "Exit Picture-in-Picture" : "Picture-in-Picture";
    }
});

initEqUi();
loadState();
