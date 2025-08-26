/* src/options.js
 * Originally created 3/11/2017 by DaAwesomeP
 * This is the options page script file
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

var domReady = false
var browserReady = false
var restored = false

async function checkBadgeColorManualSetting () {
  let autoSelect = document.querySelector('#badgeTextColorAuto').checked
  document.querySelector('#badgeTextColor').disabled = autoSelect
}

async function saveOptions () {
  checkBadgeColorManualSetting()
  let settings = await browser.storage.local.get()
  for (let setting in settings) {
    if (setting !== 'version') {
      let el = document.querySelector(`#${setting}`)
      if (el.getAttribute('type') === 'checkbox') settings[setting] = el.checked
      else settings[setting] = el.value
      let optionType = el.getAttribute('optionType')
      if (optionType === 'number' && typeof settings[setting] !== 'number') settings[setting] = parseInt(settings[setting])
      else if (optionType === 'string' && typeof settings[setting] !== 'string') settings[setting] = settings[setting].toString()
      else if (optionType === 'boolean' && typeof settings[setting] !== 'boolean') settings[setting] = (settings[setting].toLowerCase() === 'true')
    }
  }
  browser.storage.local.set(settings)
  await browser.runtime.sendMessage({ updateSettings: true })
}

async function restoreOptions () {
  restored = true;
  let settings = await browser.storage.local.get();
  for (let setting in settings) {
    if (setting !== 'version') {
      let el = document.querySelector(`#${setting}`);
      if (!el) continue;
      if (el.getAttribute('type') === 'checkbox') el.checked = settings[setting];
      else el.value = settings[setting];
      // show this control
      el.parentElement.parentElement.style.display = 'block';
    }
  }
  // keep your existing color toggle
  checkBadgeColorManualSetting();

  // NEW: update readout after restore
  const v = parseInt(document.querySelector('#panPeriodMs')?.value || '2400', 10);
  setPanReadout(v);
}

function start () {
  browserReady = true;
  if (domReady && !restored) restoreOptions();
  for (let el of document.querySelectorAll('input, select')) {
    el.addEventListener('change', saveOptions);
  }
  // NEW: live readout while sliding
  const slider = document.querySelector('#panPeriodMs');
  if (slider) {
    slider.addEventListener('input', (e) => setPanReadout(parseInt(e.target.value, 10)));
  }
}

function setPanReadout(v) {
  const out = document.querySelector('#panPeriodMs_out');
  if (out) out.textContent = `${v} ms (${(v/1000).toFixed(2)} s)`;
}


document.addEventListener('DOMContentLoaded', () => {
  domReady = true
  if (browserReady && !restored) restoreOptions()
})

if (typeof browser === 'undefined') {
  var script = document.createElement('script')
  script.addEventListener('load', () => {
    start()
  })
  script.src = '../node_modules/webextension-polyfill/dist/browser-polyfill.js'
  script.async = false
  document.head.appendChild(script)
} else start()
