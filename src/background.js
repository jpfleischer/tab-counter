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


// ---- Action alias (MV2/MV3 safe) ----
const action = (browser.action || browser.browserAction);
// Make text ~18% taller and ~12% narrower (so it still fits)
const TALL = { scaleX: 0.88, scaleY: 1.18 };
function makeCanvas(size) { const c=document.createElement('canvas'); c.width=size; c.height=size; return c; }

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

  // NEW: aim to show ~3 digits in the frame at once
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
  maxWpct: 0.98,   // let text use almost full width
  maxHpct: 0.90,
  scaleX: 1.06,    // widen glyphs
  scaleY: 1.12,    // still a bit tall, but not too skinny
  fontWeight: 900, // heaviest available
  strokePct: 0.12, // thicker outline
  fg: '#ffffff',
  bg: '#000000',
  fontFamily: FONT_STACK_WIDE,
  boldPasses: 4,       // extra fills to fake-bold
  boldOffsetPct: 0.02  // offset per pass (~2% of icon size)
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

const focusHandler = (winId) => {
  if (winId === browser.windows.WINDOW_ID_NONE) {
    // Firefox lost focus → pause animations
    pauseAllPans();
  } else {
    // Refocused → resume the active tab's pan and refresh the icon
    resumeCurrentTabPan();
    update(); // optional but nice to refresh counts immediately
  }
};


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
  const probeStr = isDigits ? '8'.repeat(targetN) : text.slice(0, targetN); // “8” is widest digit

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


// draw one frame at a given horizontal offset (0..maxOffset)
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

  const cx = pad - offset;                       // pan: shift left by offset
  const cy = pad + contentH / 2;                 // vertical center
  ctx.translate(Math.round(cx), Math.round(cy));
  ctx.scale(scaleX, scaleY);

  // draw text once; stroke gives a crisp edge
  ctx.fillText(text, 0, 0);
  ctx.strokeText(text, 0, 0);

  ctx.restore();
  return ctx.getImageData(0, 0, size, size);
}

function pauseAllPans() {
  const now = performance.now();
  for (const s of panStates.values()) {
    if (s.timer) {
      // save where we are in the cycle (0..1), then stop
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
    if (s && !s.timer) {
      // resume from saved phase
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
    if (prev.timer) return; // already running this exact animation
    // if paused, we'll fall through to re-arm below
  }

  stopPan(tabId);

  // geometry for both sizes
  const geom16 = computeGeom(16, text, opts);
  const geom32 = computeGeom(32, text, opts);

  // if text already fits → draw once, no animation
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
    const u  = (t % cycleMs) / cycleMs;          // 0..1
    const e  = easeCos(u);                        // 0..1..0 (smooth)
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

  // background square (almost full-bleed)
  const pad = Math.round(size * padPct);
  const r   = Math.round(size * cornerRadiusPct);
  const contentW = size - 2*pad;
  const contentH = size - 2*pad;

  ctx.fillStyle = bg;
  roundRect(ctx, pad, pad, contentW, contentH, r);
  ctx.fill();

  const digitsOnly = /^[0-9]+$/.test(text);
  const len = text.length;

  // If too many digits, abbreviate so it's readable
  if (digitsOnly && len >= 7) {
    text = abbreviate(text);
    return drawSingleLine(ctx, text, size, { pad, contentW, contentH, scaleX, scaleY, maxWpct, maxHpct, fontWeight, strokePct, fg, fontFamily });
  }

  // 1–3 digits: single line (tall)
  if (!digitsOnly || len <= 3) {
    return drawSingleLine(ctx, text, size, { pad, contentW, contentH, scaleX, scaleY, maxWpct, maxHpct, fontWeight, strokePct, fg, fontFamily });
  }

  // 4–6 digits: two rows, grid cells
  // 4 → 2x2, 5–6 → 2 rows with 3 columns (last cell may be empty)
  const rows = 2;
  const cols = (len === 4) ? 2 : 3;
  const topCount = Math.min(Math.ceil(len / 2), cols);
  const top = text.slice(0, topCount).padEnd(cols, ' ');
  const bottom = text.slice(topCount).padEnd(cols, ' ');
  const cells = (top + bottom).split(''); // length = rows*cols

  // Fit a single character to cell size (use “8” as widest digit)
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


  // draw digits in their grid cells
  ctx.save();
  ctx.translate(pad, pad);
  const baselineOffset = cellH * 0.64; // a bit below center looks taller
  const lineW = Math.max(1, Math.round(size * strokePct) / Math.max(scaleX, scaleY));

  for (let rIdx = 0; rIdx < rows; rIdx++) {
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const ch = cells[rIdx * cols + cIdx];
      if (ch === ' ') continue;
      // per-cell draw (centered), inside your rIdx/cIdx loop
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

// single-line tall text helper (centered, crisp)
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
  // draw: fill then a light stroke for crisp edges
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


// remember last text+style per tab so we don't redraw unnecessarily
const lastIconTextByTab = new Map();

async function setIconIfChanged(text, tabId, opts = {}) {
  const styleKey = opts.styleKey || '';                   // identify the style
  const key = `${text}|${styleKey}`;
  const prev = lastIconTextByTab.get(tabId);
  if (prev === key) return;                               // no change → skip
  await setIconWithText(text, tabId, opts);               // draw
  lastIconTextByTab.set(tabId, key);                      // remember
}

browser.tabs.onRemoved.addListener(tabId => lastIconTextByTab.delete(tabId));


const updateIcon = async function updateIcon () {
  // Get settings
  const settings = await browser.storage.local.get();
  const counterPreference = settings.counter || 0;

  // Stop if badge disabled
  if (counterPreference === 3) return;

  // Active tab
  const currentTab = (await browser.tabs.query({ currentWindow: true, active: true }))[0];
  if (!currentTab) return;

  // Counts
  const currentWindow = (await browser.tabs.query({ currentWindow: true })).length.toString();
  const allTabs       = (await browser.tabs.query({})).length.toString();
  const allWindows    = (await browser.windows.getAll({ populate: false, windowTypes: ['normal'] })).length.toString();

  // Decide text (default to currentWindow)
  let text = currentWindow;
  if (counterPreference === 1) text = allTabs;
  else if (counterPreference === 2) text = `${currentWindow}/${allTabs}`;
  else if (counterPreference === 4) text = allWindows;

  const digitsOnly = /^[0-9]+$/.test(text);

  const period = typeof settings.panPeriodMs === 'number' ? settings.panPeriodMs : 2400;

  if (digitsOnly && text.length >= 4) {
    await action.setBadgeText({ text: '', tabId: currentTab.id });
    await startOrUpdatePan(text, currentTab.id, { ...READABLE, panPeriodMs: period });
  } else {
    stopPan(currentTab.id);
    await setIconIfChanged(text, currentTab.id, READABLE);
    await action.setBadgeText({ text: '', tabId: currentTab.id });
  }


  await action.setTitle({
    title: `Tab Counter\nTabs in this window:  ${currentWindow}\nTabs in all windows: ${allTabs}\nNumber of windows: ${allWindows}`,
    tabId: currentTab.id
  });

};


// Prevent from firing too frequently or flooding at a window or restore
const lazyUpdateIcon = debounce(updateIcon, 250)

// Prioritize active leading edge of every 1 second on tab switch (fluid update for new tabs)
const lazyActivateUpdateIcon = debounce(updateIcon, 1000, { leading: true })

// Will be error if tab has been removed, so wait 150ms;
// onActivated fires slightly before onRemoved,
// but tab is gone during onActivated.
// Must be a function to avoid event parameter errors
const update = function update () { setTimeout(lazyUpdateIcon, 150) }

// Init badge for when addon starts and not yet loaded tabs
action.setBadgeText({ text: 'wait' })
action.setBadgeBackgroundColor({ color: '#000000' })

// Handler for when current tab changes
const tabOnActivatedHandler = function tabOnActivatedHandler () {
  // Run normal update for most events
  update()

  // Prioritize active (fluid update for new tabs)
  lazyActivateUpdateIcon()
}

// Load and apply icon and badge color settings
const checkSettings = async function checkSettings (settingsUpdate) {
  // Get settings object
  let settings = await browser.storage.local.get()
  // Get the browser name and version
  let browserInfo
  if (browser.runtime.hasOwnProperty('getBrowserInfo')) browserInfo = await browser.runtime.getBrowserInfo()
  else {
    browserInfo = { // polyfill doesn't seem to support this method, but we're only concerned with FF at the moment
      version: '0',
      vendor: '',
      name: ''
    }
  }
  const browserVersionSplit = browserInfo.version.split('.').map((n) => parseInt(n))

  // Set base defaults if new insall
  if (!settings.hasOwnProperty('version')) {
    settings = {
      version: '0.0.0',
      icon: 'tabcounter.plain.min.svg',
      counter: 0,
      badgeColor: '#999999',
      panPeriodMs: 2400              // ⬅️ NEW: full left→right→left loop duration
    }
  }

  // Perform settings upgrade
  if (settings.version !== browser.runtime.getManifest().version) {
    let versionSplit = settings.version.split('.').map((n) => parseInt(n))
    // Upgrade

    // since v0.3.0, icons now adapt to theme so reset icon setting
    if (versionSplit[0] === 0 && versionSplit[1] < 3) settings.icon = 'tabcounter.plain.min.svg'

    // disable the "both" counter option in version v0.3.0 due to the four-character badge limit (renders the feature uselss)
    if (versionSplit[0] === 0 && versionSplit[1] < 3) {
      if (settings.hasOwnProperty('counter')) {
        if (settings.counter === 2) settings.counter = 0
      }
    }

    // add badgeTextColor support if at least v0.4.0 and FF 63
    if (versionSplit[0] === 0 && versionSplit[1] < 4 && browserInfo.vendor === 'Mozilla' && browserInfo.name === 'Firefox' && browserVersionSplit[0] >= 63) {
      settings.badgeTextColorAuto = true
      settings.badgeTextColor = '#000000'
    }
  }
  browser.storage.local.set(Object.assign(settings, {
    version: browser.runtime.getManifest().version
  }))

  // Apply badge color or use default
  if (settings.hasOwnProperty('badgeColor')) action.setBadgeBackgroundColor({ color: settings.badgeColor })
  else action.setBadgeBackgroundColor({ color: '#000000' })

  // Apply badge text color or use default if not set or not supported
  if (settings.hasOwnProperty('badgeTextColor')) {
    if (settings.badgeTextColorAuto !== true) action.setBadgeTextColor({ color: settings.badgeTextColor })
    else action.setBadgeTextColor({ color: null })
  }

  // Apply icon selection or use default
  if (settings.hasOwnProperty('icon')) action.setIcon({ path: `icons/${settings.icon}` })
  else action.setIcon({ path: 'icons/tabcounter.plain.min.svg' })

  // Get counter preference
  let counterPreference
  if (!settings.hasOwnProperty('counter')) counterPreference = 0
  else counterPreference = settings.counter

  // Either add badge update events or don't if not set to
  if (counterPreference !== 3) {
    // Watch for tab and window events five seconds after browser startup
    setTimeout(() => {
      browser.tabs.onActivated.addListener(tabOnActivatedHandler)
      browser.tabs.onAttached.addListener(update)
      browser.tabs.onCreated.addListener(update)
      browser.tabs.onDetached.addListener(update)
      browser.tabs.onMoved.addListener(update)
      browser.tabs.onReplaced.addListener(update)
      browser.tabs.onRemoved.addListener(update)
      browser.tabs.onUpdated.addListener(update)
      browser.windows.onCreated.addListener(update)
      browser.windows.onRemoved.addListener(update)
      if (!browser.windows.onFocusChanged.hasListener(focusHandler)) {
        browser.windows.onFocusChanged.addListener(focusHandler);
      }


    }, settingsUpdate ? 1 : 5000) // add listeners immeadietly if not browser startup
  } else {
    // remove the listeners that were added
    browser.tabs.onActivated.removeListener(tabOnActivatedHandler)
    browser.tabs.onAttached.removeListener(update)
    browser.tabs.onCreated.removeListener(update)
    browser.tabs.onDetached.removeListener(update)
    browser.tabs.onMoved.removeListener(update)
    browser.tabs.onReplaced.removeListener(update)
    browser.tabs.onRemoved.removeListener(update)
    browser.tabs.onUpdated.removeListener(update)
    browser.windows.onCreated.removeListener(update)
    browser.windows.onRemoved.removeListener(update)
    browser.windows.onFocusChanged.removeListener(focusHandler)

    // hide the "wait" badge if set not to show a badge
    action.setBadgeText({ text: '' })
    action.setTitle({ title: 'Tab Counter' })

    // check each tab that was overriden with a counter badge
    let allTabs = await browser.tabs.query({})
    allTabs.forEach((tab) => {
      action.setBadgeText({
        text: '',
        tabId: tab.id
      })
      action.setTitle({
        title: 'Tab Counter',
        tabId: tab.id
      })
    })
  }
}

// Load settings and update badge at app start
const applyAll = async function applyAll (settingsUpdate) {
  await checkSettings(settingsUpdate) // Icon and badge color
  await update() // Badge text options
}
applyAll()

// Listen for settings changes and update color, icon, and badge text instantly
// Bug: this listener run nonstop
// browser.storage.onChanged.addListener(applyAll)

// Listen for internal addon messages
const messageHandler = async function messageHandler (request, sender, sendResponse) {
  // Check for a settings update
  if (request.hasOwnProperty('updateSettings')) if (request.updateSettings) applyAll(true)
}
browser.runtime.onMessage.addListener(messageHandler)
