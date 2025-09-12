/* src/background.js
 * Originally created 3/10/2017 by DaAwesomeP
 * This is the background task file of the extension
 * https://github.com/DaAwesomeP/tab-counter
 *
 * Copyright 2017-present DaAwesomeP
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// drop-in debounce (supports { leading: true } like underscore)
const debounce = (fn, wait, opts = {}) => {
  let t;
  const leading = !!opts.leading;
  let led = false;
  return function (...args) {
    if (leading && !led) { led = true; fn.apply(this, args); }
    clearTimeout(t);
    t = setTimeout(() => { led = false; fn.apply(this, args); }, wait);
  };
};

const log = (...a) => console.log('[tab-counter]', ...a);
log('background loaded', browser.runtime.getManifest().version);

// ---- Action alias (MV2/MV3 safe) ----
const action = (browser.action || browser.browserAction);

// Make text ~18% taller and ~12% narrower (so it still fits)
const TALL = { scaleX: 0.88, scaleY: 1.18 };


function makeCanvas(size) {
  // Works in MV2 background pages and MV3 service workers
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(size, size);
    c.width = size; c.height = size;
    return c;
  }
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}


const FONT_STACK = `"Arial Narrow","Roboto Condensed","Noto Sans Condensed",
                    system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;

const XL = {
  styleKey: 'XLv2',
  padPct: 0.02,
  cornerRadiusPct: 0.10,
  maxWpct: 0.96,
  maxHpct: 0.90,
  scaleX: 0.86,
  scaleY: 1.28,
  fontWeight: 900,
  strokePct: 0.05,
  fg: '#ffffff',
  bg: '#000000',
  fontFamily: FONT_STACK
};

const READABLE = {
  styleKey: 'PANREADv2',
  padPct: 0.05,
  cornerRadiusPct: 0.08,
  maxWpct: 0.94,
  maxHpct: 0.84,
  scaleX: 1.04,
  scaleY: 1.18,
  fontWeight: 800,
  strokePct: 0.08,
  fg: '#ffffff',
  bg: '#000000',
  fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif',
  // aim to show ~3 digits in the frame at once
  visibleDigitsStart: 2
};

// Wide, heavy faces first; then decent fallbacks
const FONT_STACK_WIDE = `"Arial Black","Segoe UI Black","Impact",
                          "Roboto Black","Helvetica Neue",Arial,sans-serif`;

// Wider & thicker settings
const WIDE = {
  styleKey: 'WIDEv1',
  padPct: 0.02,
  cornerRadiusPct: 0.06,
  maxWpct: 0.98,
  maxHpct: 0.90,
  scaleX: 1.06,
  scaleY: 1.12,
  fontWeight: 900,
  strokePct: 0.12,
  fg: '#ffffff',
  bg: '#000000',
  fontFamily: FONT_STACK_WIDE,
  boldPasses: 4,
  boldOffsetPct: 0.02
};

const abbreviate = n => {
  n = Number(n);
  if (!Number.isFinite(n)) return String(n);
  if (n < 1000) return String(n);
  if (n < 10000) return (Math.round(n/100)/10).toFixed(1).replace(/\.0$/,'') + 'k';
  if (n < 1_000_000) return Math.round(n/1000) + 'k';
  if (n < 10_000_000) return (Math.round(n/100_000)/10).toFixed(1).replace(/\.0$/,'') + 'M';
  if (n < 1_000_000_000) return Math.round(n/1_000_000) + 'M';
  return Math.round(n/1_000_000_000) + 'B';
};

// ====== ICON / BADGE HELPERS ======
function clearActionIcon(tabId) {
  const makeClear = (size) => {
    const c = document.createElement('canvas');
    c.width = size; c.height = size; // transparent by default
    return c.getContext('2d').getImageData(0, 0, size, size);
  };
  return action.setIcon({ imageData: { 16: makeClear(16), 32: makeClear(32) }, tabId });
}

async function showBadgeText(text, tabId, settings) {
  // fully stop any animation & forget prior renders
  stopPan(tabId);
  panStates.delete(tabId);
  lastIconTextByTab.delete(tabId);

  // clear icon so native badge is dominant
  await clearActionIcon(tabId);

  try {
    await action.setBadgeBackgroundColor({ color: settings.badgeColor || '#000000' });
    if (settings.badgeTextColorAuto !== true && settings.badgeTextColor) {
      await action.setBadgeTextColor({ color: settings.badgeTextColor });
    } else {
      await action.setBadgeTextColor({ color: null }); // theme-auto if supported
    }
  } catch {}

  await action.setBadgeText({ text, tabId });
  log('badge set', text);
}

// per-tab pan state
const panStates = new Map(); // tabId -> {timer, text, styleKey, geom16, geom32, off, dir}

function computeGeom(size, text, opts) {
  const pad = Math.round(size * (opts.padPct ?? 0.05));
  const r   = Math.round(size * (opts.cornerRadiusPct ?? 0.08));
  const contentW = size - 2*pad;
  const contentH = size - 2*pad;

  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const scaleX = opts.scaleX ?? 1;
  const scaleY = opts.scaleY ?? 1;
  const maxH   = contentH * (opts.maxHpct ?? 0.84);
  const maxW   = contentW * (opts.maxWpct ?? 0.94);

  let fontSize = Math.floor(size * 0.92);

  // 1) Fit to height
  while (fontSize > 6) {
    ctx.font = `${opts.fontWeight ?? 700} ${fontSize}px ${opts.fontFamily ?? 'sans-serif'}`;
    const m = ctx.measureText(text);
    const ascent  = (m.actualBoundingBoxAscent  || fontSize * 0.8) * scaleY;
    const descent = (m.actualBoundingBoxDescent || fontSize * 0.2) * scaleY;
    const h = ascent + descent;
    if (h <= maxH) break;
    fontSize--;
  }

  // 2) Constrain so N digits fit in the frame width
  const isDigits = /^[0-9]+$/.test(text);
  const targetN  = Math.min(Math.max(1, opts.visibleDigitsStart ?? 3), text.length);
  const probeStr = isDigits ? '8'.repeat(targetN) : text.slice(0, targetN);

  while (fontSize > 6) {
    ctx.font = `${opts.fontWeight ?? 700} ${fontSize}px ${opts.fontFamily ?? 'sans-serif'}`;
    const probeW = ctx.measureText(probeStr).width * scaleX;
    if (probeW <= maxW) break;
    fontSize--;
  }

  // Final width of the FULL string (may overflow; that's what we pan)
  ctx.font = `${opts.fontWeight ?? 700} ${fontSize}px ${opts.fontFamily ?? 'sans-serif'}`;
  const fullW = ctx.measureText(text).width * scaleX;

  // How far we can pan inside the content rect
  const maxOffset = Math.max(0, Math.ceil(fullW - contentW));

  const lineW = Math.max(1, Math.round(size * (opts.strokePct ?? 0.08)) / Math.max(scaleX, scaleY));

  return { size, pad, r, contentW, contentH, fontSize, w: fullW, maxOffset, lineW, scaleX, scaleY };
}

function renderPannedFrame(text, geom, offset, opts) {
  const { size, pad, r, contentW, contentH, fontSize, lineW, scaleX, scaleY } = geom;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // background
  ctx.fillStyle = opts.bg || '#000';
  roundRect(ctx, pad, pad, contentW, contentH, r);
  ctx.fill();

  // clip to content rect
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad, pad, contentW, contentH);
  ctx.clip();

  // centered vertically, panned horizontally
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = opts.fg || '#fff';
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lineW;
  ctx.font = `${opts.fontWeight ?? 700} ${fontSize}px ${opts.fontFamily ?? 'sans-serif'}`;

  const cx = pad - offset;
  const cy = pad + contentH / 2;
  ctx.translate(Math.round(cx), Math.round(cy));
  ctx.scale(scaleX, scaleY);

  ctx.fillText(text, 0, 0);
  ctx.strokeText(text, 0, 0);

  ctx.restore();
  return ctx.getImageData(0, 0, size, size);
}

function pauseAllPans() {
  const now = performance.now();
  for (const s of panStates.values()) {
    if (s.timer) {
      s.phaseU = ((now - s.t0) % s.cycleMs) / s.cycleMs;
      clearInterval(s.timer);
      s.timer = null;
    }
  }
}

function resumeCurrentTabPan() {
  browser.tabs.query({ currentWindow: true, active: true }).then(([tab]) => {
    if (!tab) return;
    const s = panStates.get(tab.id);
    if (s && !s.timer && /^\d{4,}$/.test(s.text)) {
      const opts = { ...(s.opts || READABLE), startPhaseU: s.phaseU ?? 0 };
      startOrUpdatePan(s.text, tab.id, opts);
    }
  }).catch(() => {});
}

function stopPan(tabId) {
  const s = panStates.get(tabId);
  if (!s) return;
  clearInterval(s.timer);
  panStates.delete(tabId);
}
browser.tabs.onRemoved.addListener(stopPan);

// helper easing (0..1 → 0..1 with zero slope at 0,1 and fast mid)
const easeCos = (u) => (1 - Math.cos(2 * Math.PI * u)) / 2;

async function startOrUpdatePan(text, tabId, opts = READABLE) {
  const prev = panStates.get(tabId);
  if (prev &&
      prev.text === text &&
      prev.styleKey === (opts.styleKey || '') &&
      (prev.opts?.panPeriodMs ?? 2400) === (opts.panPeriodMs ?? 2400) &&
      (prev.opts?.fps ?? 30) === (opts.fps ?? 30)) {
    if (prev.timer) return;
  }

  stopPan(tabId);

  const geom16 = computeGeom(16, text, opts);
  const geom32 = computeGeom(32, text, opts);

  if (geom16.maxOffset === 0 && geom32.maxOffset === 0) {
    await setIconWithText(text, tabId, opts);
    return;
  }

  const fps      = opts.fps || 30;
  const cycleMs  = opts.panPeriodMs || 2400;
  const startU   = typeof opts.startPhaseU === 'number' ? opts.startPhaseU : 0;
  const t0       = performance.now() - startU * cycleMs;

  const timer = setInterval(async () => {
    const t  = performance.now() - t0;
    const u  = (t % cycleMs) / cycleMs;
    const e  = easeCos(u);
    const o32 = geom32.maxOffset * e;
    const o16 = geom16.maxOffset * e;

    const img16 = renderPannedFrame(text, geom16, o16, opts);
    const img32 = renderPannedFrame(text, geom32, o32, opts);
    await action.setIcon({ imageData: { 16: img16, 32: img32 }, tabId });
  }, Math.round(1000 / fps));

  panStates.set(tabId, {
    timer, text, styleKey: opts.styleKey || '', opts, geom16, geom32,
    t0, cycleMs, phaseU: startU
  });
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

function drawIconText(text, size, opts = {}) {
  const {
    padPct = 0.08, cornerRadiusPct = 0.20,
    maxWpct = 0.86, maxHpct = 0.70,
    scaleX = 1.0,  scaleY = 1.0,
    fontWeight = 700, strokePct = 0.08,
    fg = '#ffffff', bg = 'rgba(0,0,0,0.85)',
    fontFamily = 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
  } = opts;

  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);

  const pad = Math.round(size * padPct);
  const r   = Math.round(size * cornerRadiusPct);
  const contentW = size - 2*pad;
  const contentH = size - 2*pad;

  ctx.fillStyle = bg;
  roundRect(ctx, pad, pad, contentW, contentH, r);
  ctx.fill();

  const digitsOnly = /^[0-9]+$/.test(text);
  const len = text.length;

  if (digitsOnly && len >= 7) {
    text = abbreviate(text);
    return drawSingleLine(ctx, text, size, { pad, contentW, contentH, scaleX, scaleY, maxWpct, maxHpct, fontWeight, strokePct, fg, fontFamily });
  }

  if (!digitsOnly || len <= 3) {
    return drawSingleLine(ctx, text, size, { pad, contentW, contentH, scaleX, scaleY, maxWpct, maxHpct, fontWeight, strokePct, fg, fontFamily });
  }

  const rows = 2;
  const cols = (len === 4) ? 2 : 3;
  const topCount = Math.min(Math.ceil(len / 2), cols);
  const top = text.slice(0, topCount).padEnd(cols, ' ');
  const bottom = text.slice(topCount).padEnd(cols, ' ');
  const cells = (top + bottom).split('');

  const cellW = contentW / cols;
  const cellH = contentH / rows;
  const maxW = cellW * 0.94;
  const maxH = cellH * 0.82;
  let fontSize = Math.floor(size * 0.92);
  while (fontSize > 6) {
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily || 'sans-serif'}`;
    const m = ctx.measureText('8');
    const w = m.width * scaleX;
    const h = ((m.actualBoundingBoxAscent || fontSize*0.8) +
              (m.actualBoundingBoxDescent || fontSize*0.2)) * scaleY;
    if (w <= maxW && h <= maxH) break;
    fontSize--;
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fg;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineJoin = 'round';

  ctx.save();
  ctx.translate(pad, pad);

  for (let rIdx = 0; rIdx < rows; rIdx++) {
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const ch = cells[rIdx * cols + cIdx];
      if (ch === ' ') continue;
      const cx = (cIdx + 0.5) * cellW;
      const cy = (rIdx + 0.5) * cellH;

      ctx.save();
      ctx.translate(Math.round(cx), Math.round(cy));
      ctx.scale(scaleX, scaleY);
      ctx.lineWidth = Math.max(1, Math.round(size * (strokePct ?? 0.08)) / Math.max(scaleX, scaleY));
      ctx.fillText(ch, 0, 0);
      ctx.strokeText(ch, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();

  return ctx.getImageData(0, 0, size, size);
}

function drawSingleLine(ctx, text, size, p) {
  const { pad, contentW, contentH, scaleX, scaleY, maxWpct, maxHpct, fontWeight, strokePct, fg, fontFamily } = p;

  const maxW = contentW * (maxWpct ?? 0.94);
  const maxH = contentH * (maxHpct ?? 0.82);

  let fontSize = Math.floor(size * 0.92);
  while (fontSize > 6) {
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily || 'sans-serif'}`;
    const m = ctx.measureText(text);
    const w = m.width * scaleX;
    const ascent  = (m.actualBoundingBoxAscent  || fontSize * 0.8) * scaleY;
    const descent = (m.actualBoundingBoxDescent || fontSize * 0.2) * scaleY;
    const h = ascent + descent;
    if (w <= maxW && h <= maxH) break;
    fontSize--;
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fg;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineJoin = 'round';

  const cx = pad + contentW / 2;
  const cy = pad + contentH / 2;

  ctx.save();
  ctx.translate(Math.round(cx), Math.round(cy));
  ctx.scale(scaleX, scaleY);
  ctx.lineWidth = Math.max(1, Math.round(size * (strokePct ?? 0.08)) / Math.max(scaleX, scaleY));
  ctx.fillText(text, 0, 0);
  ctx.strokeText(text, 0, 0);
  ctx.restore();

  return ctx.getImageData(0, 0, size, size);
}

async function setIconWithText(text, tabId, opts = {}) {
  const img16 = drawIconText(text, 16, opts);
  const img32 = drawIconText(text, 32, opts);
  await action.setIcon({ imageData: { 16: img16, 32: img32 }, tabId });
}

const lastIconTextByTab = new Map();

async function setIconIfChanged(text, tabId, opts = {}) {
  const styleKey = opts.styleKey || '';
  const key = `${text}|${styleKey}`;
  const prev = lastIconTextByTab.get(tabId);
  if (prev === key) return;
  await setIconWithText(text, tabId, opts);
  lastIconTextByTab.set(tabId, key);
}

browser.tabs.onRemoved.addListener(tabId => lastIconTextByTab.delete(tabId));

// ====== INCREMENTAL COUNTS (O(1) PER EVENT) ======
const winCounts = new Map();   // winId -> { visible: 0, total: 0 }
const tabHidden = new Map();   // tabId -> boolean
let activeWinId = null;

function ensureWin(winId) {
  if (!winCounts.has(winId)) winCounts.set(winId, { visible: 0, total: 0 });
  return winCounts.get(winId);
}

async function initCounts() {
  winCounts.clear(); tabHidden.clear();
  const wins = await browser.windows.getAll({ windowTypes: ['normal'] });
  for (const w of wins) ensureWin(w.id);

  const tabs = await browser.tabs.query({ windowType: 'normal' });
  for (const t of tabs) {
    const w = ensureWin(t.windowId);
    w.total++;
    if (!t.hidden) w.visible++;
    tabHidden.set(t.id, !!t.hidden);
  }
  const [active] = await browser.tabs.query({ currentWindow: true, active: true });
  activeWinId = active?.windowId ?? wins[0]?.id ?? null;
}

function readCounts() {
  const curr = String(winCounts.get(activeWinId)?.visible ?? 0);
  const all  = String([...winCounts.values()].reduce((s,w)=>s+w.visible,0));
  const wins = String(winCounts.size);
  return { currentWindow: curr, allTabs: all, allWindows: wins };
}

// ====== EVENT DELTA HANDLERS ======
function tabOnActivatedHandler({ windowId }) {
  if (windowId && windowId !== browser.windows.WINDOW_ID_NONE) activeWinId = windowId;
  schedulePaint();
}

function tabsOnCreatedHandler(tab) {
  const w = ensureWin(tab.windowId);
  w.total++; if (!tab.hidden) w.visible++;
  tabHidden.set(tab.id, !!tab.hidden);
  schedulePaint();
}

function tabsOnRemovedHandler(tabId, info) {
  const wasHidden = tabHidden.get(tabId) ?? true;
  const w = winCounts.get(info.windowId);
  if (w) { w.total--; if (!wasHidden) w.visible--; }
  tabHidden.delete(tabId);
  schedulePaint();
}

function tabsOnUpdatedHandler(tabId, changeInfo, tab) {
  if ('hidden' in changeInfo) {
    const prevHidden = tabHidden.get(tabId);
    if (prevHidden !== changeInfo.hidden) {
      const w = ensureWin(tab.windowId);
      if (changeInfo.hidden) w.visible--; else w.visible++;
      tabHidden.set(tabId, !!tab.hidden);
      schedulePaint();
    }
  }
}

function tabsOnDetachedHandler(tabId, { oldWindowId }) {
  const wasHidden = tabHidden.get(tabId) ?? true;
  const w = winCounts.get(oldWindowId);
  if (w) { w.total--; if (!wasHidden) w.visible--; }
  schedulePaint();
}

async function tabsOnAttachedHandler(tabId, { newWindowId }) {
  ensureWin(newWindowId);
  let hidden = tabHidden.get(tabId);
  if (hidden === undefined) {
    try {
      const t = await browser.tabs.get(tabId);
      hidden = !!t.hidden;
    } catch { hidden = true; }
  }
  const w = winCounts.get(newWindowId);
  w.total++; if (!hidden) w.visible++;
  tabHidden.set(tabId, hidden);
  schedulePaint();
}

function tabsOnReplacedHandler(addedTabId, removedTabId) {
  const wasHidden = tabHidden.get(removedTabId);
  if (wasHidden !== undefined) {
    tabHidden.set(addedTabId, wasHidden);
    tabHidden.delete(removedTabId);
    schedulePaint();
  }
}

function windowsOnCreatedHandler(w) {
  ensureWin(w.id);
  schedulePaint();
}

function windowsOnRemovedHandler(winId) {
  winCounts.delete(winId);
  if (activeWinId === winId) {
    // best-effort: pick any remaining window as active
    const first = winCounts.keys().next().value ?? null;
    activeWinId = first;
  }
  schedulePaint();
}

// Also handle focus (pause/resume pan + update active window)
const focusHandler = (winId) => {
  if (winId === browser.windows.WINDOW_ID_NONE) {
    pauseAllPans();
  } else {
    activeWinId = winId;
    resumeCurrentTabPan();
    update(); // wrapper → schedulePaint()
  }
};

// ====== BADGE PAINT (READS CACHED COUNTS) ======
let _paintGen = 0;
async function paintBadge() {
  const myGen = ++_paintGen;

  const settings = await browser.storage.local.get();
  const counterPreference = settings.counter || 0;

  // If user disabled counter UI entirely, make sure the global badge is blank.
  if (counterPreference === 3) {
    try { await action.setBadgeText({ text: '' }); } catch {}
    return;
  }

  // Compute counts from cached state
  const { currentWindow, allTabs, allWindows } = readCounts();
  let text = currentWindow;
  if (counterPreference === 1) text = allTabs;
  else if (counterPreference === 2) text = `${currentWindow}/${allTabs}`;
  else if (counterPreference === 4) text = allWindows;

  const digitsOnly = /^[0-9]+$/.test(text);
  const animate = digitsOnly && text.length >= 4;

  // IMPORTANT:
  // - If animating (4+ digits), keep the GLOBAL/default badge BLANK so the panel
  //   doesn’t show a static number over the animated icon.
  // - Otherwise, keep the global badge in sync with the short text.
  try { await action.setBadgeText({ text: animate ? '' : text }); } catch {}

  // Now update the active tab (per-tab) badge/icon
  const [activeTab] = await browser.tabs.query({ currentWindow: true, active: true });
  if (!activeTab) return; // no tab to paint; global is already correct

  // If another paint was scheduled while we awaited, bail out
  if (myGen !== _paintGen) return;

  if (animate) {
    // Blank the per-tab badge and run the panning icon animation
    await action.setBadgeText({ text: '', tabId: activeTab.id });
    const period = Number(settings.panPeriodMs) || 2400;
    await startOrUpdatePan(text, activeTab.id, { ...READABLE, panPeriodMs: period });
  } else {
    // Short numbers use the native badge text
    await showBadgeText(text, activeTab.id, settings);
  }

  await action.setTitle({
    title: `Tab Counter\nTabs in this window:  ${currentWindow}\nTabs in all windows: ${allTabs}\nNumber of windows: ${allWindows}`,
    tabId: activeTab.id
  });
}



// Coalesce paints slightly to skip transient N-1 states
const schedulePaint = debounce(() => {
  paintBadge().catch(e => console.error('[tab-counter] paintBadge failed', e));
}, 60);

// Legacy wrapper so existing calls still work
const update = function update () { setTimeout(schedulePaint, 120) };

// Init badge for when addon starts and not yet loaded tabs
action.setBadgeText({ text: 'wait' });
action.setBadgeBackgroundColor({ color: '#000000' });

// ====== SETTINGS / WIRING ======
const checkSettings = async function checkSettings (settingsUpdate) {
  // Get settings object
  let settings = await browser.storage.local.get();

  // Get the browser name and version
  let browserInfo;
  if (browser.runtime.hasOwnProperty('getBrowserInfo')) browserInfo = await browser.runtime.getBrowserInfo();
  else {
    browserInfo = { version: '0', vendor: '', name: '' };
  }
  const browserVersionSplit = browserInfo.version.split('.').map((n) => parseInt(n));

  // Set base defaults if new install
  if (!settings.hasOwnProperty('version')) {
    settings = {
      version: '0.0.0',
      icon: 'tabcounter.plain.min.svg',
      counter: 0,
      badgeColor: '#999999',
      panPeriodMs: 2400
    };
  }

  // Perform settings upgrade
  if (settings.version !== browser.runtime.getManifest().version) {
    let versionSplit = settings.version.split('.').map((n) => parseInt(n));
    if (versionSplit[0] === 0 && versionSplit[1] < 3) settings.icon = 'tabcounter.plain.min.svg';
    if (versionSplit[0] === 0 && versionSplit[1] < 3) {
      if (settings.hasOwnProperty('counter')) {
        if (settings.counter === 2) settings.counter = 0;
      }
    }
    if (versionSplit[0] === 0 && versionSplit[1] < 4 && browserInfo.vendor === 'Mozilla' && browserInfo.name === 'Firefox' && browserVersionSplit[0] >= 63) {
      settings.badgeTextColorAuto = true;
      settings.badgeTextColor = '#000000';
    }
  }
  browser.storage.local.set(Object.assign(settings, {
    version: browser.runtime.getManifest().version
  }));

  // Apply badge colors (hardened)
  try {
    if (settings.hasOwnProperty('badgeColor')) {
      await action.setBadgeBackgroundColor({ color: settings.badgeColor });
    } else {
      await action.setBadgeBackgroundColor({ color: '#000000' });
    }

    if (settings.hasOwnProperty('badgeTextColor')) {
      if (settings.badgeTextColorAuto !== true) {
        await action.setBadgeTextColor({ color: settings.badgeTextColor });
      } else {
        await action.setBadgeTextColor({ color: null });
      }
    }
  } catch (e) {
    console.warn('[tab-counter] badge color setup skipped', e);
  }

  // Apply icon selection
  if (settings.hasOwnProperty('icon')) action.setIcon({ path: `icons/${settings.icon}` });
  else action.setIcon({ path: 'icons/tabcounter.plain.min.svg' });

  // Get counter preference
  let counterPreference;
  if (!settings.hasOwnProperty('counter')) counterPreference = 0;
  else counterPreference = settings.counter;

  // Wire listeners / init
  if (counterPreference !== 3) {
    setTimeout(async () => {
      // Ensure fresh init (once per startup or settings update)
      await initCounts();

      // Remove any previous listeners to avoid dupes
      browser.tabs.onActivated.removeListener(tabOnActivatedHandler);
      browser.tabs.onCreated.removeListener(tabsOnCreatedHandler);
      browser.tabs.onRemoved.removeListener(tabsOnRemovedHandler);
      browser.tabs.onUpdated.removeListener(tabsOnUpdatedHandler);
      browser.tabs.onDetached.removeListener(tabsOnDetachedHandler);
      browser.tabs.onAttached.removeListener(tabsOnAttachedHandler);
      browser.tabs.onReplaced.removeListener(tabsOnReplacedHandler);
      browser.windows.onCreated.removeListener(windowsOnCreatedHandler);
      browser.windows.onRemoved.removeListener(windowsOnRemovedHandler);
      browser.windows.onFocusChanged.removeListener(focusHandler);

      // Add optimized delta listeners
      browser.tabs.onActivated.addListener(tabOnActivatedHandler);
      browser.tabs.onCreated.addListener(tabsOnCreatedHandler);
      browser.tabs.onRemoved.addListener(tabsOnRemovedHandler);
      browser.tabs.onUpdated.addListener(tabsOnUpdatedHandler);
      browser.tabs.onDetached.addListener(tabsOnDetachedHandler);
      browser.tabs.onAttached.addListener(tabsOnAttachedHandler);
      browser.tabs.onReplaced.addListener(tabsOnReplacedHandler);
      browser.windows.onCreated.addListener(windowsOnCreatedHandler);
      browser.windows.onRemoved.addListener(windowsOnRemovedHandler);
      if (!browser.windows.onFocusChanged.hasListener(focusHandler)) {
        browser.windows.onFocusChanged.addListener(focusHandler);
      }

      // Kick the first paint; your step #1 keeps global badge in sync
      schedulePaint();

      // Step #2: clear the default "wait" once things are wired (harmless if already repainted)
      try { await action.setBadgeText({ text: '' }); } catch {}
    }, settingsUpdate ? 1 : 500); // Step #4: faster cold start (was 5000ms)
  } else {
    // Remove listeners and clear UI
    browser.tabs.onActivated.removeListener(tabOnActivatedHandler);
    browser.tabs.onCreated.removeListener(tabsOnCreatedHandler);
    browser.tabs.onRemoved.removeListener(tabsOnRemovedHandler);
    browser.tabs.onUpdated.removeListener(tabsOnUpdatedHandler);
    browser.tabs.onDetached.removeListener(tabsOnDetachedHandler);
    browser.tabs.onAttached.removeListener(tabsOnAttachedHandler);
    browser.tabs.onReplaced.removeListener(tabsOnReplacedHandler);
    browser.windows.onCreated.removeListener(windowsOnCreatedHandler);
    browser.windows.onRemoved.removeListener(windowsOnRemovedHandler);
    browser.windows.onFocusChanged.removeListener(focusHandler);

    action.setBadgeText({ text: '' });
    action.setTitle({ title: 'Tab Counter' });

    let allTabs = await browser.tabs.query({});
    allTabs.forEach((tab) => {
      action.setBadgeText({ text: '', tabId: tab.id });
      action.setTitle({ title: 'Tab Counter', tabId: tab.id });
    });
  }
};


// Load settings and update badge at app start
const applyAll = async function applyAll (settingsUpdate) {
  await checkSettings(settingsUpdate);
  await update();
  // Clear the startup "wait" only on cold start (not during settings updates)
  if (!settingsUpdate) {
    try { await action.setBadgeText({ text: '' }); } catch {}
  }
};

applyAll();

// Listen for internal addon messages
const messageHandler = async function messageHandler (request, sender, sendResponse) {
  if (request.hasOwnProperty('updateSettings')) if (request.updateSettings) applyAll(true);
};
browser.runtime.onMessage.addListener(messageHandler);
