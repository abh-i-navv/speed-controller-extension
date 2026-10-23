const MIN_SPEED = 0.25;
const MAX_SPEED = 5;
const MIN_BOOST = 100;
const MAX_BOOST = 600;
const EQ_MIN = -12;
const EQ_MAX = 12;
const EQ_BANDS = 10;

const DEFAULT_PROFILE = {
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
    eqBands: Array(EQ_BANDS).fill(0)
};

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function normalizeEqBands(bands) {
    const source = Array.isArray(bands) ? bands : [];
    return Array.from({ length: EQ_BANDS }, (_, i) =>
        clampNumber(source[i], EQ_MIN, EQ_MAX, 0)
    );
}

function normalizeProfile(profile = {}) {
    return {
        speed: clampNumber(profile.speed, MIN_SPEED, MAX_SPEED, 1),
        enabled: Boolean(profile.enabled),
        floating: Boolean(profile.floating),
        floatX: Number.isFinite(profile.floatX) ? profile.floatX : null,
        floatY: Number.isFinite(profile.floatY) ? profile.floatY : null,
        collapsed: profile.collapsed !== false,
        configured: Boolean(profile.configured),
        volumeBoostEnabled: Boolean(profile.volumeBoostEnabled),
        volumeBoost: clampNumber(profile.volumeBoost, MIN_BOOST, MAX_BOOST, 100),
        eqEnabled: Boolean(profile.eqEnabled),
        bassBoost: clampNumber(profile.bassBoost, 0, 20, 0),
        trebleBoost: clampNumber(profile.trebleBoost, 0, 20, 0),
        compressorEnabled: Boolean(profile.compressorEnabled),
        eqBands: normalizeEqBands(profile.eqBands)
    };
}

function siteKey(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch (_) {
        return null;
    }
}

function needsAudioInjection(profile) {
    // Volume Booster is the master switch for the Web Audio path.
    return Boolean(profile?.volumeBoostEnabled);
}

function needsContentInjection(profile) {
    return Boolean(profile?.enabled || profile?.floating || needsAudioInjection(profile));
}

async function getSiteProfile(site) {
    if (!site) return normalizeProfile(DEFAULT_PROFILE);
    const data = await chrome.storage.local.get("profiles");
    return normalizeProfile(data.profiles?.[site] || DEFAULT_PROFILE);
}

async function getTabOverride(tabId) {
    const data = await chrome.storage.session.get("tabOverrides");
    return data.tabOverrides?.[String(tabId)] || null;
}

async function getEffectiveForTab(tabId, url) {
    const site = siteKey(url);
    const siteProfile = await getSiteProfile(site);
    const tabOverride = await getTabOverride(tabId);

    return {
        site,
        siteProfile,
        tabOverride: tabOverride ? normalizeProfile(tabOverride) : null,
        effective: tabOverride ? normalizeProfile(tabOverride) : siteProfile,
        scope: tabOverride ? "tab" : "site"
    };
}

async function getFrameIds(tabId) {
    try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        return [...new Set((frames || []).map(frame => frame.frameId))];
    } catch (_) {
        return [0];
    }
}

async function injectContentIntoFrame(tabId, frameId = 0) {
    if (tabId == null || frameId == null) return false;

    try {
        await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            files: ["content.js"]
        });
        return true;
    } catch (_) {
        return false;
    }
}

async function ensureContentForTab(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.url) return false;

        const effective = await getEffectiveForTab(tabId, tab.url);
        const profile = effective.effective;
        if (!needsContentInjection(profile)) return false;

        const frameIds = await getFrameIds(tabId);
        if (!frameIds.length) return false;

        const needsPlayerFrames = Boolean(profile.enabled || needsAudioInjection(profile));
        const targets = needsPlayerFrames ? frameIds : [0];
        const results = await Promise.all(
            targets.map(frameId => injectContentIntoFrame(tabId, frameId))
        );

        return results.some(Boolean);
    } catch (_) {
        return false;
    }
}

async function ensureSpecificFrame(tabId, frameId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.url) return false;
        const effective = await getEffectiveForTab(tabId, tab.url);
        const profile = effective.effective;
        if (!needsContentInjection(profile)) return false;
        const needsPlayerFrames = Boolean(profile.enabled || needsAudioInjection(profile));
        if (!needsPlayerFrames && frameId !== 0) return false;
        return injectContentIntoFrame(tabId, frameId);
    } catch (_) {
        return false;
    }
}

async function broadcastToFrames(tabId, message) {
    const frameIds = await getFrameIds(tabId);
    const results = [];

    for (const frameId of frameIds) {
        try {
            const result = await chrome.tabs.sendMessage(tabId, message, { frameId });
            results.push({ frameId, result });
        } catch (_) {
            // Frame may not have the runtime content script.
        }
    }

    return results;
}

async function saveSiteProfile(site, state) {
    const data = await chrome.storage.local.get("profiles");
    const profiles = data.profiles || {};
    profiles[site] = normalizeProfile({ ...profiles[site], ...state, configured: true });
    await chrome.storage.local.set({ profiles });
    return profiles[site];
}

async function saveTabProfile(tabId, state) {
    const data = await chrome.storage.session.get("tabOverrides");
    const tabOverrides = data.tabOverrides || {};
    tabOverrides[String(tabId)] = normalizeProfile({
        ...tabOverrides[String(tabId)],
        ...state,
        configured: true
    });
    await chrome.storage.session.set({ tabOverrides });
    return tabOverrides[String(tabId)];
}

async function broadcastEffectiveState(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return null;
    const effective = await getEffectiveForTab(tabId, tab.url);

    await broadcastToFrames(tabId, {
        type: "state",
        state: effective.effective
    });

    chrome.runtime.sendMessage({
        type: "profileChanged",
        tabId,
        state: effective.effective,
        scope: effective.scope
    }).catch(() => {});

    return effective;
}

async function applySavedState(tabId, url, state, targetScope) {
    const normalized = normalizeProfile({ ...state, configured: true });
    let saved;

    if (targetScope === "tab") {
        saved = await saveTabProfile(tabId, normalized);
    } else {
        const site = siteKey(url);
        if (!site) throw new Error("Unable to determine site.");
        saved = await saveSiteProfile(site, normalized);
    }

    // First push to whatever frames are already injected. This makes ON/OFF
    // and audio controls feel immediate instead of waiting for injection.
    await broadcastToFrames(tabId, { type: "state", state: saved });

    // If the new state requires player access, inject as needed and push once
    // more so newly injected frames receive the same state.
    await ensureContentForTab(tabId);
    const effective = await broadcastEffectiveState(tabId);
    return effective?.effective || saved;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        if (message.type === "getEffectiveProfile") {
            const tabId = message.tabId ?? sender.tab?.id;
            let url = message.url;
            if (!url && tabId != null) {
                try { url = (await chrome.tabs.get(tabId)).url; } catch (_) {}
            }

            if (tabId == null || !url) {
                sendResponse({ ok: false });
                return;
            }

            const result = await getEffectiveForTab(tabId, url);
            sendResponse({ ok: true, ...result });
            return;
        }

        if (message.type === "getProfiles") {
            const data = await chrome.storage.local.get("profiles");
            sendResponse({ ok: true, profiles: data.profiles || {} });
            return;
        }

        if (message.type === "setSiteState" || message.type === "setTabState") {
            const tabId = message.tabId ?? sender.tab?.id;
            if (tabId == null || !message.url) {
                sendResponse({ ok: false, error: "Missing tab or URL." });
                return;
            }

            const targetScope = message.type === "setTabState" ? "tab" : "site";
            const effectiveState = await applySavedState(tabId, message.url, message.state || {}, targetScope);
            sendResponse({ ok: true, state: effectiveState });
            return;
        }

        if (message.type === "updateFromPage") {
            const tabId = sender.tab?.id ?? message.tabId;
            if (tabId == null) {
                sendResponse({ ok: false });
                return;
            }

            let url = sender.tab?.url;
            if (!url) {
                try { url = (await chrome.tabs.get(tabId)).url; } catch (_) {}
            }
            if (!url) {
                sendResponse({ ok: false });
                return;
            }

            const targetScope = message.scope === "tab" ? "tab" : "site";
            const effectiveState = await applySavedState(
                tabId,
                url,
                message.state || {},
                targetScope
            );
            sendResponse({ ok: true, state: effectiveState });
            return;
        }

        if (message.type === "saveFloatingPosition") {
            const tabId = sender.tab?.id ?? message.tabId;
            if (tabId == null) {
                sendResponse({ ok: false });
                return;
            }

            let url = sender.tab?.url;
            if (!url) {
                try { url = (await chrome.tabs.get(tabId)).url; } catch (_) {}
            }

            if (!url) {
                sendResponse({ ok: false });
                return;
            }

            const targetScope = message.scope === "tab" ? "tab" : "site";
            const patch = {
                floatX: Number.isFinite(Number(message.floatX)) ? Number(message.floatX) : null,
                floatY: Number.isFinite(Number(message.floatY)) ? Number(message.floatY) : null
            };

            let saved;
            if (targetScope === "tab") {
                saved = await saveTabProfile(tabId, patch);
            } else {
                saved = await saveSiteProfile(siteKey(url), patch);
            }

            // Position is UI state. Push only the position so an open floating
            // controller does not get recreated/collapsed.
            await broadcastToFrames(tabId, {
                type: "floatingPosition",
                floatX: saved.floatX,
                floatY: saved.floatY
            });
            sendResponse({ ok: true });
            return;
        }

        if (message.type === "getStatusAllFrames") {
            const tabId = message.tabId ?? sender.tab?.id;
            if (tabId == null) {
                sendResponse({ ok: false });
                return;
            }

            const tab = await chrome.tabs.get(tabId);
            const effective = await getEffectiveForTab(tabId, tab.url);
            if (!needsContentInjection(effective.effective)) {
                sendResponse({ ok: false, inactive: true, status: null });
                return;
            }

            await ensureContentForTab(tabId);
            const results = await broadcastToFrames(tabId, { type: "getStatus" });
            const detected = results.map(x => x.result).filter(Boolean).filter(x => x.detected);
            const status = detected[0] || results.map(x => x.result).find(Boolean) || null;
            sendResponse({ ok: Boolean(status), status });
            return;
        }

        if (message.type === "skipAllFrames") {
            const tabId = message.tabId ?? sender.tab?.id;
            if (tabId == null) {
                sendResponse({ ok: false });
                return;
            }
            await ensureContentForTab(tabId);
            const results = await broadcastToFrames(tabId, {
                type: "skip",
                seconds: Number(message.seconds) || 0
            });
            sendResponse({ ok: results.some(x => x.result?.ok) });
            return;
        }

        if (message.type === "pipAllFrames") {
            const tabId = message.tabId ?? sender.tab?.id;
            if (tabId == null) {
                sendResponse({ ok: false });
                return;
            }
            await ensureContentForTab(tabId);
            const results = await broadcastToFrames(tabId, { type: "pip" });
            sendResponse({ ok: results.some(x => x.result?.ok) });
            return;
        }

        if (message.type === "toggleFloatingAllFrames") {
            const results = await broadcastToFrames(message.tabId, { type: "toggleFloating" });
            sendResponse({ ok: results.some(x => x.result?.ok) });
            return;
        }

        if (message.type === "setFloatingAllFrames") {
            const floating = Boolean(message.floating);
            const results = await broadcastToFrames(message.tabId, { type: "setFloating", floating });
            sendResponse({ ok: results.some(x => x.result?.ok) });
            return;
        }

        if (message.type === "pipStateChanged") {
            const tabId = sender.tab?.id;
            if (tabId != null) {
                await broadcastToFrames(tabId, {
                    type: "pipState",
                    active: Boolean(message.active)
                });
                chrome.runtime.sendMessage({
                    type: "pipStateChanged",
                    tabId,
                    active: Boolean(message.active)
                }).catch(() => {});
            }
            sendResponse({ ok: true });
            return;
        }

        if (message.type === "deleteProfile") {
            const data = await chrome.storage.local.get("profiles");
            const profiles = data.profiles || {};
            delete profiles[message.site];
            await chrome.storage.local.set({ profiles });

            if (sender.tab?.id != null && message.site) {
                await ensureContentForTab(sender.tab.id);
            }
            sendResponse({ ok: true });
            return;
        }

        if (message.type === "clearTabState") {
            const tabId = message.tabId ?? sender.tab?.id;
            if (tabId == null) {
                sendResponse({ ok: false });
                return;
            }

            const data = await chrome.storage.session.get("tabOverrides");
            const tabOverrides = data.tabOverrides || {};
            delete tabOverrides[String(tabId)];
            await chrome.storage.session.set({ tabOverrides });

            const effective = await broadcastEffectiveState(tabId);
            await ensureContentForTab(tabId);
            sendResponse({ ok: true, state: effective?.effective || null });
            return;
        }
    })().catch(error => {
        try { sendResponse({ ok: false, error: String(error?.message || error) }); } catch (_) {}
    });

    return true;
});

async function injectIfNeeded(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.url) return;
        const effective = await getEffectiveForTab(tabId, tab.url);
        if (needsContentInjection(effective.effective)) {
            await ensureContentForTab(tabId);
        }
    } catch (_) {}
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
        injectIfNeeded(tabId);
    }
});

chrome.webNavigation.onDOMContentLoaded.addListener(details => {
    ensureSpecificFrame(details.tabId, details.frameId).catch(() => {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
    if (details.frameId === 0) injectIfNeeded(details.tabId);
});

chrome.tabs.onRemoved.addListener(async tabId => {
    const data = await chrome.storage.session.get("tabOverrides");
    const tabOverrides = data.tabOverrides || {};
    delete tabOverrides[String(tabId)];
    await chrome.storage.session.set({ tabOverrides });
});

chrome.runtime.onInstalled.addListener(async () => {
    const existing = await chrome.storage.local.get("profiles");
    if (!existing.profiles) {
        await chrome.storage.local.set({ profiles: {} });
    }
});
