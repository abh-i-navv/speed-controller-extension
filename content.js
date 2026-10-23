(() => {
"use strict";

// The top-level page gets this file from the manifest. Child frames are injected
// on demand only after the user opens the extension or enables speed control.
// Guard against duplicate programmatic injections.
if (window.__UVSC_CONTENT_LOADED__) return;
window.__UVSC_CONTENT_LOADED__ = true;

const MIN_SPEED = 0.25;
const MAX_SPEED = 5;
const REAPPLY_MS = 250;
const FLOAT_IDLE_MS = 5000;
const FLOAT_MARGIN = 10;
const FLOAT_COMPACT_SIZE = 38;
const FLOAT_EXPANDED_WIDTH = 304;
const FLOAT_EXPANDED_HEIGHT = 116;

let state = {
    speed: 1,
    enabled: false,
    floating: false,
    floatX: null,
    floatY: null,
    collapsed: true,
    configured: false,
    volumeBoostEnabled: false,
    volumeBoost: 100,
    eqEnabled: false,
    bassBoost: 0,
    trebleBoost: 0,
    compressorEnabled: false,
    eqBands: Array(10).fill(0)
};

let scope = "site";
let initialized = false;

let floatingRoot = null;
let floatingHost = null;
let floatingShadow = null;
let floatingPanel = null;
let floatIdleTimer = null;
let dragState = null;
let floatExpanded = false;
let floatHidden = false;
let collapsedAnchor = null;
let lastFloatMouseActivity = 0;
const hookedVideos = new WeakSet();
const hookedAudios = new WeakSet();
const trackedVideos = new Set();
const trackedAudios = new Set();
let videoScanTimer = null;
let enforcementTimer = null;
let trackingActive = false;
let shadowDiscoveryScheduled = false;
const VIDEO_SCAN_INTERVAL = 1200;
const ENFORCE_INTERVAL = 350;
const AUDIO_EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const FLOAT_EQ_PRESETS = {
    normal:     { label: 'Normal (EQ Off)', bands: [0,0,0,0,0,0,0,0,0,0], bass: 0, treble: 0 },
    flat:       { label: 'Flat',         bands: [0,0,0,0,0,0,0,0,0,0], bass: 0, treble: 0 },
    bass:       { label: 'Bass Boost',   bands: [4,3,2,1,0,0,0,0,0,0], bass: 6, treble: 0 },
    treble:     { label: 'Treble',       bands: [0,0,0,0,0,0,1,2,4,5], bass: 0, treble: 5 },
    vocal:      { label: 'Vocal',        bands: [-2,-1,0,2,4,4,3,1,-1,-2], bass: 0, treble: 1 },
    rock:       { label: 'Rock',         bands: [3,2,-1,-2,1,2,3,2,3,2], bass: 2, treble: 2 },
    pop:        { label: 'Pop',          bands: [1,2,2,1,-1,-1,1,2,2,2], bass: 2, treble: 2 },
    movie:      { label: 'Movie',        bands: [4,3,2,0,-1,-1,1,3,4,3], bass: 4, treble: 3 },
    classical:  { label: 'Classical',    bands: [3,2,1,0,-1,-1,0,1,2,3], bass: 1, treble: 2 },
    electronic: { label: 'Electronic',   bands: [4,3,1,0,-1,1,2,3,4,4], bass: 4, treble: 4 }
};

function getEqPresetNameForFloating(profile = state) {
    if (!profile || !profile.eqEnabled) return 'normal';
    const bands = Array.isArray(profile.eqBands) ? profile.eqBands.map(Number) : Array(10).fill(0);
    const bass = Number(profile.bassBoost) || 0;
    const treble = Number(profile.trebleBoost) || 0;
    for (const [name, preset] of Object.entries(FLOAT_EQ_PRESETS)) {
        if (name === 'normal') continue;
        if (bass === preset.bass && treble === preset.treble &&
            preset.bands.every((value, index) => Number(value) === Number(bands[index]))) {
            return name;
        }
    }
    return 'custom';
}

function applyFloatingEqPreset(name) {
    if (!state.volumeBoostEnabled) return;
    const preset = FLOAT_EQ_PRESETS[name];
    if (!preset) return;
    updateLocalState({
        eqEnabled: name !== 'normal',
        eqBands: [...preset.bands],
        bassBoost: preset.bass,
        trebleBoost: preset.treble,
        configured: true
    });
    noteFloatActivity();
}
const audioGraphs = new WeakMap();
let activeAudioVideo = null;

// Keep the playback rate that was active before VideoTune took control.
// This lets YouTube return to the speed selected in its own player settings
// when our Speed Control toggle is turned off. Other sites intentionally
// restore to 1×.
const nativePlaybackRates = new WeakMap();

const site = location.hostname.replace(/^www\./, "").toLowerCase();

function isYouTubeSite() {
    return site === "youtube.com" || site.endsWith(".youtube.com") ||
           site === "youtu.be" || site.endsWith(".youtu.be");
}

function rememberNativePlaybackRate(video) {
    if (!video || nativePlaybackRates.has(video)) return;

    let playbackRate = 1;
    let defaultPlaybackRate = 1;

    try {
        const value = Number(video.playbackRate);
        if (Number.isFinite(value) && value > 0) playbackRate = value;
    } catch (_) {}

    try {
        const value = Number(video.defaultPlaybackRate);
        if (Number.isFinite(value) && value > 0) defaultPlaybackRate = value;
    } catch (_) {}

    nativePlaybackRates.set(video, { playbackRate, defaultPlaybackRate });
}

function restoreNativePlaybackRates() {
    const youtube = isYouTubeSite();

    for (const video of trackedVideos) {
        try {
            if (!video.isConnected) {
                nativePlaybackRates.delete(video);
                trackedVideos.delete(video);
                continue;
            }

            const baseline = nativePlaybackRates.get(video);

            // YouTube should return to the rate that was active before
            // VideoTune took control. Other sites use their normal 1× rate.
            const playbackRate = youtube
                ? (baseline?.playbackRate || 1)
                : 1;
            const defaultPlaybackRate = youtube
                ? (baseline?.defaultPlaybackRate || playbackRate)
                : 1;

            try { video.defaultPlaybackRate = defaultPlaybackRate; } catch (_) {}
            try { video.playbackRate = playbackRate; } catch (_) {}

            nativePlaybackRates.delete(video);
        } catch (_) {}
    }
}

function setState(nextState) {
    const wasEnabled = Boolean(state.enabled);
    state = { ...state, ...(nextState || {}) };

    // Restore the site's/player's own playback speed immediately when Speed
    // Control is switched off. The saved speed itself remains unchanged, so
    // re-enabling the feature resumes the user's chosen VideoTune speed.
    if (wasEnabled && !state.enabled) {
        restoreNativePlaybackRates();
    }

    applyState();
}

function registerVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    if (state.enabled) rememberNativePlaybackRate(video);
    trackedVideos.add(video);
    hookVideo(video);
}

function registerAudio(audio) {
    if (!(audio instanceof HTMLAudioElement)) return;
    trackedAudios.add(audio);
    hookAudio(audio);
}

function scanVideos() {
    if (!trackingActive) return;

    try {
        // Keep the scan direct and event-driven. Audio elements are included only
        // while audio enhancement is actually enabled.
        for (const video of document.querySelectorAll("video")) {
            registerVideo(video);
        }
        if (audioProcessingRequested()) {
            for (const audio of document.querySelectorAll("audio")) {
                registerAudio(audio);
            }
        }
    } catch (_) {}

    pruneVideos();
    pruneAudios();
}

function pruneVideos() {
    for (const video of trackedVideos) {
        try {
            if (!video.isConnected) trackedVideos.delete(video);
        } catch (_) {
            trackedVideos.delete(video);
        }
    }
}

function pruneAudios() {
    for (const audio of trackedAudios) {
        try {
            if (!audio.isConnected) trackedAudios.delete(audio);
        } catch (_) {
            trackedAudios.delete(audio);
        }
    }
}

function scanOpenShadowRoots() {
    if (!trackingActive) return;

    const root = document.body || document.documentElement;
    if (!root?.querySelectorAll) return;

    try {
        // Shadow DOM discovery happens only after the user enables speed
        // control. It is deliberately off the critical page-load path.
        for (const host of root.querySelectorAll("*")) {
            const shadow = host.shadowRoot;
            if (!shadow) continue;
            for (const video of shadow.querySelectorAll("video")) {
                registerVideo(video);
            }
            if (audioProcessingRequested()) {
                for (const audio of shadow.querySelectorAll("audio")) {
                    registerAudio(audio);
                }
            }
            for (const nestedHost of shadow.querySelectorAll("*")) {
                const nested = nestedHost.shadowRoot;
                if (!nested) continue;
                for (const video of nested.querySelectorAll("video")) {
                    registerVideo(video);
                }
                if (audioProcessingRequested()) {
                    for (const audio of nested.querySelectorAll("audio")) {
                        registerAudio(audio);
                    }
                }
            }
        }
    } catch (_) {}
}

function scheduleShadowDiscovery() {
    if (!trackingActive || shadowDiscoveryScheduled) return;
    shadowDiscoveryScheduled = true;

    const run = () => {
        shadowDiscoveryScheduled = false;
        scanOpenShadowRoots();
    };

    if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(run, { timeout: 1200 });
    } else {
        setTimeout(run, 200);
    }
}

function scheduleVideoScan() {
    if (!trackingActive || videoScanTimer != null) return;

    videoScanTimer = setTimeout(() => {
        videoScanTimer = null;
        scanVideos();
    }, 100);
}

function startTracking() {
    if (trackingActive) return;
    trackingActive = true;
    scanVideos();
    scheduleShadowDiscovery();

    clearInterval(enforcementTimer);
    enforcementTimer = setInterval(() => {
        if (!trackingActive || !initialized) return;

        if (state.enabled) {
            for (const video of trackedVideos) {
                try {
                    if (video.isConnected) applyPlaybackRate(video);
                    else trackedVideos.delete(video);
                } catch (_) {}
            }
        }

        if (audioProcessingRequested()) {
            applyAudioState();
        }
    }, ENFORCE_INTERVAL);
}

function stopTracking() {
    trackingActive = false;
    clearTimeout(videoScanTimer);
    videoScanTimer = null;
    clearInterval(enforcementTimer);
    enforcementTimer = null;
    disableAudioProcessing();
    trackedVideos.clear();
    trackedAudios.clear();
}

function syncTracking() {
    if (initialized && (state.enabled || audioProcessingRequested())) startTracking();
    else stopTracking();
}

function activeVideos() {
    pruneVideos();

    const all = [...trackedVideos];
    const visible = all.filter(video => {
        try {
            const rect = video.getBoundingClientRect();
            const style = getComputedStyle(video);

            return rect.width > 0 &&
                   rect.height > 0 &&
                   style.display !== "none" &&
                   style.visibility !== "hidden";
        } catch (_) {
            return true;
        }
    });

    return visible.length ? visible : all;
}

function primaryVideo() {
    const videos = activeVideos();

    if (!videos.length) return null;

    return videos.find(v => !v.paused && v.readyState >= 2) || videos[0];
}

function primaryAudioTarget() {
    const video = primaryVideo();
    if (video) return video;

    pruneAudios();
    const audios = [...trackedAudios];
    if (!audios.length) return null;
    return audios.find(a => !a.paused && a.readyState >= 2) || audios[0];
}

function applyPlaybackRate(video) {
    if (!video) return;

    if (state.enabled) rememberNativePlaybackRate(video);
    const rate = state.enabled ? state.speed : 1;

    // Some OTT players repeatedly write 1× back to playbackRate. Apply both
    // properties and let the direct per-element hooks below immediately put
    // our value back whenever the player changes it.
    try {
        if (Math.abs(Number(video.defaultPlaybackRate) - rate) > 0.001) {
            video.defaultPlaybackRate = rate;
        }
    } catch (_) {}

    try {
        if (Math.abs(Number(video.playbackRate) - rate) > 0.001) {
            video.playbackRate = rate;
        }
    } catch (_) {}
}

function hookVideo(video) {
    if (!video || hookedVideos.has(video)) return;
    hookedVideos.add(video);

    const enforce = () => {
        if (!initialized) return;
        if (state.enabled) applyPlaybackRate(video);
        // OTT players sometimes schedule a second write on the next task.
        if (state.enabled) {
            setTimeout(() => applyPlaybackRate(video), 0);
            setTimeout(() => applyPlaybackRate(video), 80);
        }
        if (audioProcessingRequested()) {
            applyAudioState();
        } else {
            const graph = audioGraphs.get(video);
            if (graph) neutralizeAudioGraph(video, graph);
        }
    };

    for (const eventName of [
        "loadedmetadata", "loadeddata", "canplay", "play", "playing",
        "durationchange", "progress", "emptied", "ratechange", "volumechange"
    ]) {
        video.addEventListener(eventName, enforce, true);
    }
}

function hookAudio(audio) {
    if (!audio || hookedAudios.has(audio)) return;
    hookedAudios.add(audio);
    const refresh = () => {
        if (!initialized || !audioProcessingRequested()) return;
        if (!trackedAudios.has(audio)) trackedAudios.add(audio);
        applyAudioState();
    };
    for (const eventName of [
        "loadedmetadata", "loadeddata", "canplay", "play", "playing",
        "durationchange", "progress", "emptied", "volumechange"
    ]) {
        audio.addEventListener(eventName, refresh, true);
    }
}

function audioProcessingRequested() {
    // Volume Booster is the master switch for all Web Audio processing.
    // EQ/compressor settings remain saved while it is off.
    return Boolean(state.volumeBoostEnabled);
}

function normalizedEqBands() {
    const bands = Array.isArray(state.eqBands) ? state.eqBands : [];
    return AUDIO_EQ_FREQUENCIES.map((_, index) => {
        const value = Number(bands[index]);
        return Number.isFinite(value) ? Math.min(12, Math.max(-12, value)) : 0;
    });
}

function setGraphRouting(graph) {
    try { graph.treble.disconnect(); } catch (_) {}
    try { graph.compressor.disconnect(); } catch (_) {}
    if (state.compressorEnabled) {
        graph.treble.connect(graph.compressor);
        graph.compressor.connect(graph.ctx.destination);
    } else {
        graph.treble.connect(graph.ctx.destination);
    }
}

function createAudioGraph(video) {
    if (audioGraphs.has(video)) return audioGraphs.get(video);

    let ctx;
    try {
        ctx = new AudioContext();
        const source = ctx.createMediaElementSource(video);
        const gain = ctx.createGain();
        const bass = ctx.createBiquadFilter();
        const bands = AUDIO_EQ_FREQUENCIES.map(frequency => {
            const filter = ctx.createBiquadFilter();
            filter.type = 'peaking';
            filter.frequency.value = frequency;
            filter.Q.value = 1.05;
            filter.gain.value = 0;
            return filter;
        });
        const treble = ctx.createBiquadFilter();
        const compressor = ctx.createDynamicsCompressor();

        bass.type = 'lowshelf';
        bass.frequency.value = 100;

        treble.type = 'highshelf';
        treble.frequency.value = 8000;

        compressor.threshold.value = -10;
        compressor.knee.value = 16;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.004;
        compressor.release.value = 0.18;

        source.connect(gain);
        gain.connect(bass);
        let previous = bass;
        for (const filter of bands) {
            previous.connect(filter);
            previous = filter;
        }
        previous.connect(treble);

        const graph = {
            ctx, source, gain, bass, bands, treble, compressor,
            connected: true
        };

        setGraphRouting(graph);
        audioGraphs.set(video, graph);
        return graph;
    } catch (error) {
        try { ctx?.close(); } catch (_) {}
        showToast('Audio processing is unavailable for this player');
        return null;
    }
}

function updateAudioGraph(video, graph) {
    if (!graph) return;

    const boostMultiplier = state.volumeBoostEnabled
        ? Math.max(1, Math.min(6, Number(state.volumeBoost || 100) / 100))
        : 1;

    // The media element already applies its own volume/mute level. The booster
    // is only the additional multiplier: current audio × boost.
    graph.gain.gain.value = boostMultiplier;
    const eqActive = state.volumeBoostEnabled && state.eqEnabled;
    graph.bass.gain.value = eqActive ? Math.max(0, Math.min(20, Number(state.bassBoost) || 0)) : 0;
    graph.treble.gain.value = eqActive ? Math.max(0, Math.min(20, Number(state.trebleBoost) || 0)) : 0;

    const bands = normalizedEqBands();
    graph.bands.forEach((filter, index) => {
        filter.gain.value = eqActive ? bands[index] : 0;
    });

    setGraphRouting(graph);

    try {
        if (graph.ctx.state === 'suspended') graph.ctx.resume();
    } catch (_) {}
}

function neutralizeAudioGraph(video, graph) {
    if (!video || !graph) return;

    // IMPORTANT: once createMediaElementSource(video) has been used, the
    // media element's audio is routed through that MediaElementSourceNode.
    // Disconnecting the source on EQ reset can leave YouTube/other players
    // effectively silent and can trigger their buffering/recovery path.
    // Keep the graph connected and make it acoustically transparent instead.
    // Unity gain is the transparent/bypass state. Do not copy the player's
    // volume here because HTMLMediaElement already owns that level.
    try { graph.gain.gain.value = 1; } catch (_) {}
    try { graph.bass.gain.value = 0; } catch (_) {}
    try { graph.treble.gain.value = 0; } catch (_) {}
    for (const filter of graph.bands) {
        try { filter.gain.value = 0; } catch (_) {}
    }

    try {
        if (graph.treble.numberOfOutputs > 0) {
            graph.treble.disconnect();
        }
    } catch (_) {}
    try { graph.compressor.disconnect(); } catch (_) {}
    try { graph.treble.connect(graph.ctx.destination); } catch (_) {}

    graph.connected = true;
    try {
        if (graph.ctx.state === 'suspended') graph.ctx.resume();
    } catch (_) {}
}

function disableAudioProcessing() {
    // Do not disconnect a MediaElementSourceNode. Keep any existing graph
    // transparent so resetting/disabling EQ never interrupts media playback.
    if (!activeAudioVideo) return;
    const graph = audioGraphs.get(activeAudioVideo);
    if (graph) neutralizeAudioGraph(activeAudioVideo, graph);
    activeAudioVideo = null;
}

function applyAudioState() {
    if (!initialized || !audioProcessingRequested()) {
        disableAudioProcessing();
        return;
    }

    const video = primaryAudioTarget();
    if (!video) {
        disableAudioProcessing();
        return;
    }

    if (activeAudioVideo && activeAudioVideo !== video) {
        const old = audioGraphs.get(activeAudioVideo);
        if (old) neutralizeAudioGraph(activeAudioVideo, old);
    }

    const graph = createAudioGraph(video);
    if (!graph) return;

    if (!graph.connected) {
        try { graph.source.connect(graph.gain); graph.connected = true; } catch (_) {}
    }

    activeAudioVideo = video;
    updateAudioGraph(video, graph);
}

function applyState() {
    if (!initialized) return;

    syncTracking();

    if (state.enabled || audioProcessingRequested()) {
        for (const video of activeVideos()) {
            hookVideo(video);
            if (state.enabled) applyPlaybackRate(video);
        }
    }

    applyAudioState();
    updateFloating();
}

function persistPageState() {
    chrome.runtime.sendMessage({
        type: "updateFromPage",
        scope,
        state
    }).catch(() => {});
}

function persistFloatingPosition() {
    if (!Number.isFinite(state.floatX) || !Number.isFinite(state.floatY)) return;
    chrome.runtime.sendMessage({
        type: "saveFloatingPosition",
        scope,
        floatX: state.floatX,
        floatY: state.floatY
    }).catch(() => {});
}

function updateLocalState(patch, persist = true) {
    const next = {
        ...state,
        ...patch
    };

    next.speed = Math.min(
        Math.max(Number(next.speed) || 1, MIN_SPEED),
        MAX_SPEED
    );

    setState(next);

    if (floatingRoot) renderFloating();

    if (persist) {
        persistPageState();
    }
}

function skip(seconds) {
    const video = primaryVideo();

    if (!video) {
        showToast("No video player detected");
        return false;
    }

    try {
        video.currentTime = Math.max(
            0,
            Math.min(
                Number.isFinite(video.duration) ? video.duration : Infinity,
                video.currentTime + seconds
            )
        );

        noteFloatActivity();
        return true;
    } catch (_) {
        return false;
    }
}

async function enterPiP() {
    const video = primaryVideo();

    if (!video) {
        showToast("No video player detected");
        return false;
    }

    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
            handlePipState(false);
            notifyPipState();
            return true;
        }

        if (!video.requestPictureInPicture) {
            showToast("PiP is not supported by this player");
            return false;
        }

        await video.requestPictureInPicture();
        handlePipState(true);
        notifyPipState();
        noteFloatActivity();

        return true;
    } catch (error) {
        console.warn("[Video Control] PiP error:", error);
        showToast("PiP was blocked by the player/browser");
        return false;
    }
}

function showToast(message) {
    if (!document.body) return;

    let toast = document.getElementById("vsc-toast");

    if (!toast) {
        toast = document.createElement("div");
        toast.id = "vsc-toast";

        toast.style.cssText = `
            position: fixed;
            left: 50%;
            bottom: 100px;
            transform: translateX(-50%);
            z-index: 2147483647;
            padding: 9px 13px;
            border-radius: 8px;
            background: rgba(20,20,24,.95);
            color: white;
            font: 12px Arial,sans-serif;
            box-shadow: 0 7px 25px rgba(0,0,0,.3);
            pointer-events: none;
        `;

        document.body.appendChild(toast);
    }

    toast.textContent = message;

    clearTimeout(window.__vscToastTimer);

    window.__vscToastTimer = setTimeout(() => {
        toast.remove();
    }, 1800);
}

function scheduleFloatIdleTimer() {
    if (!state.floating || !floatingRoot || floatHidden) return;

    clearTimeout(floatIdleTimer);
    floatIdleTimer = setTimeout(() => {
        floatIdleTimer = null;
        hideFloatingForIdle();
    }, FLOAT_IDLE_MS);
}

function resetFloatIdleTimer() {
    scheduleFloatIdleTimer();
}

function hideFloatingForIdle() {
    if (!floatingRoot || !state.floating) return;

    clearTimeout(floatIdleTimer);
    floatIdleTimer = null;
    dragState = null;
    floatExpanded = false;
    floatHidden = true;
    state.collapsed = true;

    if (floatingPanel) {
        floatingPanel.classList.remove('expanded');
        floatingPanel.classList.add('collapsed');
    }
    floatingRoot.style.display = 'none';
}

function revealFloating() {
    if (!state.floating) return;

    if (!floatingRoot) {
        createFloating();
        if (!floatingRoot) return;
    }

    floatHidden = false;
    floatExpanded = false;
    state.collapsed = true;
    floatingRoot.style.display = 'block';
    renderFloating();
    scheduleFloatIdleTimer();
}

function noteFloatActivity() {
    if (!state.floating) return;

    if (floatHidden) {
        revealFloating();
        return;
    }

    scheduleFloatIdleTimer();
}

function handleGlobalFloatMouseMove() {
    if (!state.floating) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Mousemove can fire hundreds of times per second. Throttle timer refreshes
    // while still revealing the hidden controller on the first movement.
    if (floatHidden) {
        revealFloating();
        lastFloatMouseActivity = now;
        return;
    }

    if (now - lastFloatMouseActivity < 250) return;
    lastFloatMouseActivity = now;
    scheduleFloatIdleTimer();
}

function getFloatingRect() {
    return floatingRoot?.getBoundingClientRect?.() || null;
}

function clampPosition(x, y) {
    const rect = getFloatingRect();
    const w = Math.max(42, rect?.width || 42);
    const h = Math.max(42, rect?.height || 42);

    const maxX = Math.max(FLOAT_MARGIN, window.innerWidth - w - FLOAT_MARGIN);
    const maxY = Math.max(FLOAT_MARGIN, window.innerHeight - h - FLOAT_MARGIN);

    return {
        x: Math.max(FLOAT_MARGIN, Math.min(Number.isFinite(Number(x)) ? Number(x) : maxX, maxX)),
        y: Math.max(FLOAT_MARGIN, Math.min(Number.isFinite(Number(y)) ? Number(y) : maxY, maxY))
    };
}

function setFloatingPosition(x, y, persist = false) {
    if (!floatingRoot) return;

    const p = clampPosition(x, y);
    floatingRoot.style.left = `${p.x}px`;
    floatingRoot.style.top = `${p.y}px`;
    floatingRoot.style.right = 'auto';
    floatingRoot.style.bottom = 'auto';

    state.floatX = p.x;
    state.floatY = p.y;

    if (persist) persistPageState();
}

function applyPosition() {
    if (!floatingRoot) return;

    if (Number.isFinite(state.floatX) && Number.isFinite(state.floatY)) {
        setFloatingPosition(state.floatX, state.floatY, false);
    } else {
        const rect = getFloatingRect();
        const w = Math.max(42, rect?.width || 42);
        const h = Math.max(42, rect?.height || 42);
        setFloatingPosition(
            window.innerWidth - w - 18,
            window.innerHeight - h - 18,
            false
        );
    }
}

function syncFloatingHostSize() {
    if (!floatingHost) return;
    // The host remains the compact avatar size in both states. The expanded
    // panel is positioned outside the host so opening/closing never changes
    // the saved anchor or drag geometry.
    floatingHost.style.width = `${FLOAT_COMPACT_SIZE}px`;
    floatingHost.style.height = `${FLOAT_COMPACT_SIZE}px`;
}

function collapseFloating() {
    if (!floatingRoot || !floatExpanded) return;

    clearTimeout(floatIdleTimer);
    dragState = null;

    // Return the compact avatar to exactly the same anchor it had before
    // expansion. This prevents the close -> reopen -> shift effect.
    const anchor = collapsedAnchor || {
        x: floatingRoot.getBoundingClientRect().left,
        y: floatingRoot.getBoundingClientRect().top
    };

    floatExpanded = false;
    syncFloatingHostSize();
    floatingPanel.classList.remove('expanded');
    floatingPanel.classList.add('collapsed');

    state.collapsed = true;
    setFloatingPosition(anchor.x, anchor.y, false);
    collapsedAnchor = { x: state.floatX, y: state.floatY };
    renderFloating();
    floatHidden = false;
    scheduleFloatIdleTimer();
}

function expandFloating() {
    if (!floatingRoot || floatExpanded) return;

    floatHidden = false;
    floatingRoot.style.display = 'block';

    const compactRect = getFloatingRect();
    collapsedAnchor = {
        x: compactRect?.left ?? state.floatX,
        y: compactRect?.top ?? state.floatY
    };

    floatExpanded = true;
    floatingPanel.classList.remove('collapsed');
    floatingPanel.classList.add('expanded');

    state.collapsed = false;

    // Keep the compact avatar exactly where it is. renderFloating() positions
    // the larger panel visually left/up when needed to keep it on-screen.
    renderFloating();
    resetFloatIdleTimer();
}

function setupFloatingDrag(handle) {
    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        if (!floatingRoot || !floatingPanel) return;

        const rect = floatingRoot.getBoundingClientRect();
        dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            dx: event.clientX - rect.left,
            dy: event.clientY - rect.top,
            moved: false
        };

        try { handle.setPointerCapture(event.pointerId); } catch (_) {}
        event.preventDefault();
        event.stopPropagation();
        noteFloatActivity();
    });

    handle.addEventListener('pointermove', event => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;

        const movedX = event.clientX - dragState.startX;
        const movedY = event.clientY - dragState.startY;
        if (!dragState.moved && Math.hypot(movedX, movedY) < 4) return;
        dragState.moved = true;

        const next = clampPosition(
            event.clientX - dragState.dx,
            event.clientY - dragState.dy
        );

        floatingRoot.style.left = `${next.x}px`;
        floatingRoot.style.top = `${next.y}px`;
        floatingRoot.style.right = 'auto';
        floatingRoot.style.bottom = 'auto';
        state.floatX = next.x;
        state.floatY = next.y;
        if (!floatExpanded) collapsedAnchor = { x: next.x, y: next.y };
        noteFloatActivity();

        event.preventDefault();
        event.stopPropagation();
    });

    const finish = event => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;

        const wasDragged = dragState.moved;
        dragState = null;

        try { handle.releasePointerCapture?.(event.pointerId); } catch (_) {}

        if (wasDragged) {
            const rect = floatingRoot.getBoundingClientRect();
            setFloatingPosition(rect.left, rect.top, false);
            collapsedAnchor = { x: state.floatX, y: state.floatY };
            persistFloatingPosition();
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        // A clean click on the collapsed avatar expands it. Clicking the
        // expanded header does nothing, so it cannot accidentally collapse or
        // resize during a drag/click transition.
        if (!floatExpanded) {
            expandFloating();
        } else {
            noteFloatActivity();
        }

        event.preventDefault();
        event.stopPropagation();
    };

    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}

function floatQuery(selector) {
    return floatingShadow?.querySelector(selector) || null;
}

function ensureFloatingHost() {
    if (floatingRoot || !state.floating) return;
    if (window.top !== window.self) return;

    const mount = document.body || document.documentElement;
    if (!mount) return;

    floatingHost = document.createElement('div');
    floatingHost.id = 'uvsc-floating-host';
    floatingHost.style.cssText = [
        'position:fixed!important',
        'display:block!important',
        `width:${FLOAT_COMPACT_SIZE}px!important`,
        `height:${FLOAT_COMPACT_SIZE}px!important`,
        'left:0',
        'top:0',
        'margin:0',
        'padding:0',
        'border:0',
        'background:transparent',
        'z-index:2147483647!important',
        'pointer-events:auto!important',
        'overflow:visible!important',
        'contain:layout style',
        'isolation:isolate'
    ].join(';');

    floatingShadow = floatingHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel {
            position: relative;
            left: 0;
            top: 0;
            width: 38px;
            height: 38px;
            margin: 0;
            padding: 0;
            border-radius: 50%;
            overflow: hidden;
            background: linear-gradient(145deg, rgba(13,18,27,.97), rgba(10,13,21,.98));
            border: 1px solid rgba(99,232,255,.18);
            box-shadow: 0 7px 24px rgba(0,0,0,.42), 0 0 18px rgba(99,232,255,.08);
            color: #fff;
            font-family: Arial, sans-serif;
            user-select: none;
            pointer-events: auto;
            isolation: isolate;
        }
        .panel::after { content:''; position:absolute; inset:0; pointer-events:none; border-radius:inherit; box-shadow:inset 0 1px 0 rgba(255,255,255,.05); }
        .panel.expanded {
            width: 304px;
            height: 116px;
            border-radius: 14px;
            overflow: hidden;
            position: absolute;
            left: 0;
            top: 0;
            background: linear-gradient(145deg, rgba(12,17,26,.985), rgba(9,12,19,.99));
            border-color: rgba(99,232,255,.22);
            box-shadow: 0 16px 42px rgba(0,0,0,.52), 0 0 28px rgba(123,108,255,.10);
            backdrop-filter: blur(16px) saturate(125%);
        }
        .handle {
            width: 100%;
            height: 38px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: grab;
            touch-action: none;
            -webkit-user-select: none;
            user-select: none;
        }
        .panel.expanded .handle {
            height: 34px;
            justify-content: flex-start;
            padding: 0 7px;
            cursor: grab;
            border-bottom: 1px solid rgba(255,255,255,.075);
            background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.01));
        }
        .panel.expanded .handle:active { cursor: grabbing; }
        .avatar {
            position: relative;
            width: 22px;
            height: 22px;
            flex: none;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #5ee9ff, #7b6cff);
            color: #fff;
            font: 700 13px/1 Arial, sans-serif;
            box-shadow: inset 0 0 0 1px rgba(255,255,255,.12), 0 0 14px rgba(99,232,255,.12);
        }
        .panel.expanded .avatar {
            width: 24px;
            height: 24px;
            font-size: 13px;
            margin-right: 6px;
        }
        .heading {
            min-width: 0;
            display: flex;
            align-items: center;
            gap: 5px;
            white-space: nowrap;
            overflow: hidden;
            flex: 1 1 auto;
        }
        .brand { color:#e8eaf0; font-size:10px; font-weight:700; }
        .speed { color:#aeb3ff; font-size:10px; font-weight:700; }
        .dot { width:6px; height:6px; border-radius:50%; background:#5bd47a; flex:none; }
        .panel:not(.expanded) .heading { display:none; }
        .collapse {
            margin-left: 5px;
            width:24px;
            height:24px;
            flex:none;
            border:1px solid rgba(255,255,255,.08);
            border-radius:6px;
            background:rgba(255,255,255,.055);
            color:#d9dbe1;
            cursor:pointer;
            padding:0;
            font:14px/1 Arial,sans-serif;
        }
        .panel:not(.expanded) .collapse { display:none; }
        .controls {
            display: grid;
            grid-template-columns: 34px 72px 34px 68px;
            gap: 6px;
            align-items: center;
            padding: 8px 8px 6px;
        }
        .eq-float-row {
            display: flex;
            align-items: center;
            gap: 7px;
            height: 34px;
            padding: 0 8px 8px;
        }
        .eq-float-label {
            width: 24px;
            color: #8f95a3;
            font-size: 9px;
            font-weight: 800;
            letter-spacing: .04em;
            text-transform: uppercase;
            flex: none;
        }
        .eq-float-select {
            color-scheme: light;
            min-width: 0;
            flex: 1;
            height: 28px;
            appearance: none;
            -webkit-appearance: none;
            border: 1px solid rgba(255,255,255,.1);
            border-radius: 8px;
            background: linear-gradient(180deg, #262a33, #20232a);
            color: #e9ebf0;
            padding: 0 28px 0 10px;
            font: 600 10px Arial,sans-serif;
            cursor: pointer;
            outline: none;
            background-image: linear-gradient(45deg, transparent 50%, #9da3b1 50%), linear-gradient(135deg, #9da3b1 50%, transparent 50%);
            background-position: calc(100% - 12px) 11px, calc(100% - 8px) 11px;
            background-size: 4px 4px, 4px 4px;
            background-repeat: no-repeat;
            transition: border-color .12s ease, background .12s ease, opacity .12s ease;
        }
        .eq-float-select:hover:not(:disabled) {
            border-color: rgba(122,128,255,.8);
            background-color: #2b2f39;
        }
        .eq-float-select:focus-visible {
            border-color: #6d73ff;
            box-shadow: 0 0 0 2px rgba(109,115,255,.18);
        }
        .eq-float-select:disabled {
            opacity: .42;
            cursor: not-allowed;
        }
        .eq-float-select option { background: #ffffff; color: #16181d; } .eq-float-select option:checked { background: #5d66d8; color: #ffffff; }
        .panel.expanded .heading { gap: 5px; }
        .panel.expanded .dot { box-shadow: 0 0 0 3px rgba(91,212,122,.08); }
        .panel.expanded .speed { background: rgba(104,110,255,.10); border: 1px solid rgba(104,110,255,.16); padding: 3px 6px; border-radius: 6px; }
        .panel.expanded .collapse { background: rgba(255,255,255,.055); }

        .mini-switch {
            width: 34px;
            height: 18px;
            flex: none;
            position: relative;
            display: inline-flex;
            align-items: center;
        }
        .mini-switch input {
            position: absolute;
            opacity: 0;
            width: 1px;
            height: 1px;
            pointer-events: none;
        }
        .mini-switch span {
            width: 34px;
            height: 18px;
            border-radius: 999px;
            background: #3a3d45;
            border: 1px solid rgba(255,255,255,.12);
            position: relative;
            cursor: pointer;
            transition: background .12s ease, border-color .12s ease;
        }
        .mini-switch span::after {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #fff;
            transition: transform .12s ease;
            box-shadow: 0 1px 3px rgba(0,0,0,.35);
        }
        .mini-switch input:checked + span {
            background: linear-gradient(135deg, #5ee9ff, #7b6cff);
            border-color: #757aff;
        }
        .mini-switch input:checked + span::after {
            transform: translateX(16px);
        }
        .mini-switch input:focus-visible + span {
            outline: 2px solid rgba(120,126,255,.9);
            outline-offset: 2px;
        }
        .panel:not(.expanded) .mini-switch { display:none; }
        button { appearance:none; box-sizing:border-box; font-family:Arial,sans-serif; }
        .btn {
            height:30px;
            border:1px solid rgba(255,255,255,.08);
            border-radius:7px;
            background:rgba(255,255,255,.055);
            color:#f4f5f7;
            padding:0 4px;
            font-size:11px;
            cursor:pointer;
        }
        .btn:hover { background:#30343d; }
        .btn:active { transform:translateY(1px) scale(.965); }
        .btn.active { background:linear-gradient(135deg, rgba(99,232,255,.20), rgba(123,108,255,.38)); border-color:rgba(99,232,255,.30); color:#fff; box-shadow:0 0 0 1px rgba(102,108,255,.18) inset; }
        .speed-btn { color:#aeb3ff; font-weight:700; }
        .btn:disabled { opacity:.42; cursor:default; }
        .btn:disabled:hover { background:rgba(255,255,255,.055); }
        .toggle-label { color:#aeb3ff; font-size:9px; font-weight:700; margin-left:2px; }
        .controls { display:none; }
        .panel.expanded .controls { display:grid; }
    `;
    floatingShadow.appendChild(style);

    floatingPanel = document.createElement('div');
    floatingPanel.className = 'panel collapsed';

    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.title = 'Drag to move • click to expand';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'V';

    const heading = document.createElement('div');
    heading.className = 'heading';

    const dot = document.createElement('span');
    dot.className = 'dot';
    const brand = document.createElement('span');
    brand.className = 'brand';
    brand.textContent = 'Video';
    const currentSpeed = document.createElement('span');
    currentSpeed.className = 'speed';
    currentSpeed.textContent = `${state.speed.toFixed(2)}×`;
    heading.append(dot, brand, currentSpeed);

    const speedToggle = document.createElement('label');
    speedToggle.className = 'mini-switch';
    speedToggle.title = 'Turn Speed Control on/off';
    const speedToggleInput = document.createElement('input');
    speedToggleInput.type = 'checkbox';
    speedToggleInput.className = 'float-speed-toggle';
    const speedToggleTrack = document.createElement('span');
    speedToggle.append(speedToggleInput, speedToggleTrack);
    speedToggleInput.addEventListener('pointerdown', event => {
        event.stopPropagation();
    });
    speedToggleInput.addEventListener('click', event => {
        event.stopPropagation();
    });
    speedToggleTrack.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
    });
    speedToggleTrack.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        speedToggleInput.checked = !speedToggleInput.checked;
        updateLocalState({ enabled: Boolean(speedToggleInput.checked), configured: true });
        noteFloatActivity();
    });
    speedToggleInput.addEventListener('change', event => {
        updateLocalState({ enabled: Boolean(event.target.checked), configured: true });
        noteFloatActivity();
    });

    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'collapse';
    collapseButton.textContent = '−';
    collapseButton.title = 'Collapse';
    collapseButton.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
    });
    collapseButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        collapseFloating();
    });

    handle.append(avatar, heading, speedToggle, collapseButton);
    setupFloatingDrag(handle);

    const controls = document.createElement('div');
    controls.className = 'controls';

    const button = (label, title, action, className = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn ${className}`.trim();
        b.textContent = label;
        b.title = title;
        b.addEventListener('pointerdown', event => event.stopPropagation());
        b.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            action();
        });
        return b;
    };

    const minus = button('−', 'Decrease speed', () => {
        updateLocalState({ speed: Math.max(MIN_SPEED, state.speed - 0.25) });
        noteFloatActivity();
    });
    const speedButton = button(
        `${state.speed.toFixed(2)}×`,
        'Reset speed to 1×',
        () => { updateLocalState({ speed: 1 }); noteFloatActivity(); },
        'speed-btn'
    );
    const plus = button('+', 'Increase speed', () => {
        updateLocalState({ speed: Math.min(MAX_SPEED, state.speed + 0.25) });
        noteFloatActivity();
    });
    const pip = button('PiP', 'Picture-in-Picture', () => { requestPictureInPictureAcrossFrames(); noteFloatActivity(); }, 'pip-btn');

    controls.append(minus, speedButton, plus, pip);

    const eqRow = document.createElement('div');
    eqRow.className = 'eq-float-row';

    const eqLabel = document.createElement('span');
    eqLabel.className = 'eq-float-label';
    eqLabel.textContent = 'EQ';

    const eqSelect = document.createElement('select');
    eqSelect.className = 'eq-float-select';
    eqSelect.title = 'Choose an EQ preset';
    eqSelect.setAttribute('aria-label', 'EQ preset');
    for (const [name, preset] of Object.entries(FLOAT_EQ_PRESETS)) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = preset.label;
        eqSelect.appendChild(option);
    }
    const customOption = document.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = 'Custom';
    eqSelect.appendChild(customOption);
    eqSelect.addEventListener('pointerdown', event => event.stopPropagation());
    eqSelect.addEventListener('click', event => event.stopPropagation());
    eqSelect.addEventListener('change', event => {
        applyFloatingEqPreset(event.target.value);
    });

    eqRow.append(eqLabel, eqSelect);
    floatingPanel.append(handle, controls, eqRow);
    floatingShadow.appendChild(floatingPanel);
    mount.appendChild(floatingHost);

    floatingRoot = floatingHost;
    floatExpanded = false;
    floatHidden = false;
    syncFloatingHostSize();
    floatingPanel.classList.remove('expanded');
    floatingPanel.classList.add('collapsed');

    // The host itself owns the controller's viewport position and size, so
    // pointer input and clamping stay stable in every expansion state.
    if (Number.isFinite(state.floatX) && Number.isFinite(state.floatY)) {
        setFloatingPosition(state.floatX, state.floatY, false);
    } else {
        applyPosition();
    }

    renderFloating();
    scheduleFloatIdleTimer();
}

function createFloating() {
    if (floatingRoot || !state.floating || window.top !== window.self) return;
    ensureFloatingHost();
}

if (window.top === window.self) {
    document.addEventListener('mousemove', handleGlobalFloatMouseMove, { passive: true, capture: true });
}

function renderFloating() {
    if (!floatingRoot || !floatingPanel) return;

    floatingPanel.classList.toggle('expanded', floatExpanded);
    floatingPanel.classList.toggle('collapsed', !floatExpanded);

    const speed = floatQuery('.speed');
    const speedButton = floatQuery('.speed-btn');
    const collapse = floatQuery('.collapse');
    const pipButton = floatQuery('.pip-btn');
    const speedToggle = floatQuery('.float-speed-toggle');
    const speedToggleTrack = floatQuery('.mini-switch span');
    const eqSelect = floatQuery('.eq-float-select');

    if (speed) speed.textContent = `${state.speed.toFixed(2)}×`;
    if (speedButton) {
        speedButton.textContent = `${state.speed.toFixed(2)}×`;
        speedButton.disabled = !state.enabled;
    }
    const minusButton = floatQuery('.speed-btn')?.previousElementSibling;
    const plusButton = floatQuery('.speed-btn')?.nextElementSibling;
    if (minusButton) minusButton.disabled = !state.enabled;
    if (plusButton) plusButton.disabled = !state.enabled;
    if (speedToggle) {
        speedToggle.checked = Boolean(state.enabled);
        speedToggle.setAttribute('aria-label', state.enabled ? 'Speed Control on' : 'Speed Control off');
    }
    if (collapse) collapse.textContent = '−';

    if (eqSelect) {
        eqSelect.value = getEqPresetNameForFloating(state);
        eqSelect.disabled = !state.volumeBoostEnabled;
        eqSelect.title = state.volumeBoostEnabled
            ? 'Choose an EQ preset'
            : 'Turn on Volume Booster to enable EQ';
        eqSelect.setAttribute('aria-disabled', String(!state.volumeBoostEnabled));
    }

    const pipActive = Boolean(window.__UVSC_PIP_ACTIVE || document.pictureInPictureElement);
    if (pipButton) {
        pipButton.classList.toggle('active', pipActive);
        pipButton.textContent = pipActive ? 'PiP ✓' : 'PiP';
        pipButton.title = pipActive ? 'Exit Picture-in-Picture' : 'Picture-in-Picture';
        pipButton.setAttribute('aria-pressed', String(pipActive));
    }

    syncFloatingHostSize();

    if (floatExpanded) {
        const hostRect = floatingRoot.getBoundingClientRect();
        const rightEdge = hostRect.left + FLOAT_EXPANDED_WIDTH;
        const bottomEdge = hostRect.top + FLOAT_EXPANDED_HEIGHT;
        const left = rightEdge > window.innerWidth - FLOAT_MARGIN
            ? -(FLOAT_EXPANDED_WIDTH - FLOAT_COMPACT_SIZE)
            : 0;
        const top = bottomEdge > window.innerHeight - FLOAT_MARGIN
            ? -(FLOAT_EXPANDED_HEIGHT - FLOAT_COMPACT_SIZE)
            : 0;

        floatingPanel.style.width = `${FLOAT_EXPANDED_WIDTH}px`;
        floatingPanel.style.height = `${FLOAT_EXPANDED_HEIGHT}px`;
        floatingPanel.style.left = `${left}px`;
        floatingPanel.style.top = `${top}px`;
        floatingPanel.style.borderRadius = '12px';
    } else {
        floatingPanel.style.width = `${FLOAT_COMPACT_SIZE}px`;
        floatingPanel.style.height = `${FLOAT_COMPACT_SIZE}px`;
        floatingPanel.style.left = '0px';
        floatingPanel.style.top = '0px';
        floatingPanel.style.borderRadius = '50%';
    }

    applyPosition();
}

function updateFloating() {
    if (!state.floating) {
        if (floatingRoot) floatingRoot.style.display = 'none';
        clearTimeout(floatIdleTimer);
        floatIdleTimer = null;
        floatExpanded = false;
        floatHidden = false;
        return;
    }

    if (!floatingRoot) {
        createFloating();
        if (!floatingRoot) {
            clearTimeout(window.__uvscFloatRetry);
            window.__uvscFloatRetry = setTimeout(updateFloating, 100);
            return;
        }
    }

    if (floatHidden) {
        floatingRoot.style.display = 'none';
        clearTimeout(floatIdleTimer);
        return;
    }

    floatingRoot.style.display = 'block';
    floatingRoot.style.pointerEvents = 'auto';
    if (floatingPanel) floatingPanel.style.pointerEvents = 'auto';
    renderFloating();
    if (!floatExpanded) {
        const rect = getFloatingRect();
        if (rect) collapsedAnchor = { x: rect.left, y: rect.top };
    }
    if (floatIdleTimer == null) scheduleFloatIdleTimer();
}

function requestPictureInPictureAcrossFrames() {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'pipAllFrames' }, response => {
            if (chrome.runtime.lastError || !response?.ok) {
                showToast('PiP is unavailable for this player');
                resolve(false);
                return;
            }
            resolve(true);
        });
    });
}

function notifyPipState() {
    const active = Boolean(document.pictureInPictureElement);
    window.__UVSC_PIP_ACTIVE = active;
    renderFloating();
    chrome.runtime.sendMessage({
        type: 'pipStateChanged',
        active
    }).catch(() => {});
}

function handlePipState(active) {
    window.__UVSC_PIP_ACTIVE = Boolean(active);
    renderFloating();
}

function getStatus() {
    const videos = activeVideos();
    const video = primaryVideo();

    let width = 0;
    let height = 0;
    let droppedFrames = null;
    let totalFrames = null;

    if (video) {
        try {
            width = video.videoWidth || Math.round(video.getBoundingClientRect().width);
            height = video.videoHeight || Math.round(video.getBoundingClientRect().height);
        } catch (_) {}

        try {
            if (video.getVideoPlaybackQuality) {
                const q = video.getVideoPlaybackQuality();
                droppedFrames = q.droppedVideoFrames;
                totalFrames = q.totalVideoFrames;
            }
        } catch (_) {}
    }

    return {
        detected: videos.length > 0,
        videoCount: videos.length,
        paused: video ? video.paused : true,
        currentTime: video?.currentTime ?? 0,
        duration: video?.duration ?? NaN,
        playbackRate: video?.playbackRate ?? 1,
        volume: video?.volume ?? 1,
        volumeBoost: state.volumeBoost,
        volumeBoostEnabled: Boolean(state.volumeBoostEnabled),
        eqEnabled: Boolean(state.eqEnabled),
        bassBoost: Number(state.bassBoost) || 0,
        trebleBoost: Number(state.trebleBoost) || 0,
        compressorEnabled: Boolean(state.compressorEnabled),
        width,
        height,
        buffered: video?.buffered?.length
            ? Math.max(0, video.buffered.end(video.buffered.length - 1) - (video.currentTime || 0))
            : 0,
        readyState: video?.readyState ?? 0,
        pipSupported: Boolean(document.pictureInPictureEnabled && video?.requestPictureInPicture),
        pipActive: Boolean(document.pictureInPictureElement),
        droppedFrames,
        totalFrames,
        scope,
        site
    };
}

function initialize() {
    chrome.runtime.sendMessage({
        type: "getEffectiveProfile"
    }, response => {
        if (!response?.ok) return;

        state = {
            ...state,
            ...(response.effective || {})
        };

        scope = response.scope || "site";

        initialized = true;

        // Floating is enabled as a feature but always starts compact.
        floatExpanded = false;
        state.collapsed = true;

        applyState();

        if (state.floating) updateFloating();
    });

    window.__universalVideoControl = true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "state") {
        const previousFloating = state.floating;
        setState(message.state || {});

        initialized = true;

        // Only reset the transient expanded UI when the actual floating feature
        // is externally toggled. Ordinary speed/profile updates must not close
        // an already-open controller.
        if (!state.floating || state.floating !== previousFloating) {
            floatExpanded = false;
            state.collapsed = true;
            collapsedAnchor = null;
        }

        applyState();

        sendResponse?.({ ok: true });
        return;
    }

    if (message.type === "pipState") {
        handlePipState(Boolean(message.active));
        sendResponse?.({ ok: true });
        return;
    }

    if (message.type === "getStatus") {
        sendResponse?.(getStatus());
        return;
    }

    if (message.type === "skip") {
        sendResponse?.({
            ok: skip(Number(message.seconds) || 0)
        });
        return;
    }

    if (message.type === "pip") {
        enterPiP().then(ok => sendResponse?.({ ok }));
        return true;
    }

    if (message.type === "setAudioState") {
        setState(message.state || {});
        initialized = true;
        applyState();
        sendResponse?.({ ok: true });
        return;
    }

    if (message.type === "toggleFloating") {
        if (window.top !== window.self) {
            sendResponse?.({ ok: false });
            return;
        }

        updateLocalState({
            floating: !state.floating,
            collapsed: true
        });

        sendResponse?.({
            ok: true,
            floating: state.floating
        });
        return;
    }

    if (message.type === "setFloating") {
        if (window.top !== window.self) {
            sendResponse?.({ ok: false });
            return;
        }

        updateLocalState({
            floating: Boolean(message.floating),
            collapsed: true
        });

        sendResponse?.({
            ok: true,
            floating: state.floating
        });
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (!initialized) return;

    if (area === "session" && changes.tabOverrides) {
        chrome.runtime.sendMessage({
            type: "getEffectiveProfile"
        }, response => {
            if (!response?.ok) return;

            setState(response.effective || {});

            scope = response.scope || "site";
        });
    }

    if (area === "local" && changes.profiles) {
        chrome.runtime.sendMessage({
            type: "getEffectiveProfile"
        }, response => {
            if (!response?.ok) return;

            setState(response.effective || {});

            scope = response.scope || "site";
        });
    }
});

document.addEventListener('enterpictureinpicture', () => notifyPipState(), true);
document.addEventListener('leavepictureinpicture', () => notifyPipState(), true);

initialize();

// Media events are cheap and give us immediate notification when a player is
// created or starts playing. Actual DOM scanning only happens while speed
// control is enabled, at a low frequency.

document.addEventListener("play", event => {
    if (!initialized) return;
    const video = event.target instanceof HTMLVideoElement ? event.target : null;
    const audio = event.target instanceof HTMLAudioElement ? event.target : null;
    if (video) {
        registerVideo(video);
        if (state.enabled) applyPlaybackRate(video);
        if (audioProcessingRequested()) applyAudioState();
    } else if (audio) {
        registerAudio(audio);
        if (audioProcessingRequested()) applyAudioState();
    } else if (trackingActive) {
        scheduleVideoScan();
    }
}, true);

document.addEventListener("playing", event => {
    if (!initialized) return;
    const video = event.target instanceof HTMLVideoElement ? event.target : null;
    const audio = event.target instanceof HTMLAudioElement ? event.target : null;
    if (video) {
        registerVideo(video);
        if (state.enabled) applyPlaybackRate(video);
        if (audioProcessingRequested()) applyAudioState();
    } else if (audio) {
        registerAudio(audio);
        if (audioProcessingRequested()) applyAudioState();
    } else if (trackingActive) {
        scheduleVideoScan();
    }
}, true);

for (const eventName of [
    "loadedmetadata", "loadeddata", "canplay", "durationchange",
    "emptied", "progress"
]) {
    document.addEventListener(eventName, event => {
        if (!initialized) return;
        const video = event.target instanceof HTMLVideoElement ? event.target : null;
        const audio = event.target instanceof HTMLAudioElement ? event.target : null;
        if (video) {
            registerVideo(video);
            if (state.enabled) applyPlaybackRate(video);
            if (audioProcessingRequested()) applyAudioState();
        } else if (audio) {
            registerAudio(audio);
            if (audioProcessingRequested()) applyAudioState();
        } else {
            scheduleVideoScan();
        }
    }, true);
}

document.addEventListener("ratechange", event => {
    if (!initialized) return;

    const video = event.target instanceof HTMLVideoElement
        ? event.target
        : null;

    if (video) {
        registerVideo(video);
        if (state.enabled) applyPlaybackRate(video);
        if (audioProcessingRequested()) applyAudioState();
    }
}, true);

document.addEventListener("keydown", event => {
    if (!state.enabled) return;
    const target = event.target;

    if (
        target &&
        (target.tagName === "INPUT" ||
         target.tagName === "TEXTAREA" ||
         target.isContentEditable)
    ) {
        return;
    }

    if (event.key === "]" && state.enabled) {
        updateLocalState({
            speed: Math.min(MAX_SPEED, state.speed + 0.25)
        });
    } else if (event.key === "[" && state.enabled) {
        updateLocalState({
            speed: Math.max(MIN_SPEED, state.speed - 0.25)
        });
    } else if (event.key === "\\" && state.enabled) {
        updateLocalState({ speed: 1 });
    } else if (event.key === "ArrowRight" && event.shiftKey) {
        skip(10);
    } else if (event.key === "ArrowLeft" && event.shiftKey) {
        skip(-10);
    } else if (event.key.toLowerCase() === "p" && event.altKey) {
        enterPiP();
    }
}, true);

window.videoSpeed = value => {
    if (state.enabled) {
        updateLocalState({ speed: Number(value) });
    }
};

})();