import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeDocument, inlineScript, raidFixture } from './verify-ui-architecture.mjs';

const page = readFileSync('web/combatlog.html', 'utf8');
function runtime(source = page) {
  const document = new FakeDocument(source), requests = [];
  let listener;
  const window = { document, location: { hash: '' }, history: { replaceState() {} },
    setTimeout() { return 1; }, clearTimeout() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {},
    overlay: { on(channel, callback) { if (channel === 'stats') listener = callback; }, send() {},
      request(channel, key) {
        let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        requests.push({ channel, key, resolve, reject }); return promise;
      } },
  };
  document.defaultView = window;
  const context = vm.createContext({ window, document, console, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout });
  new vm.Script(readFileSync('web/mannequin.js', 'utf8')).runInContext(context);
  window.CombatMannequin = { ...window.CombatMannequin, create() { return { update() {}, highlight() {}, view() {}, rotate() {}, zoom() {}, destroy() {} }; } };
  new vm.Script(readFileSync('web/records.js', 'utf8')).runInContext(context);
  new vm.Script(inlineScript(source)).runInContext(context);
  return { document, requests, hooks: window.__combatLogTest, push(data) { listener(JSON.stringify(data)); },
    el(id) { return document.getElementById(id); }, settle: async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); } };
}

const history = Array.from({ length: 400 }, (_, index) => ({ ts: 1000 + index,
  date: '2026-09-' + String(index % 20 + 1).padStart(2, '0') + ' 18:24',
  location: index % 2 ? 'Customs' : 'Factory', outcome: index % 3 ? 'SURVIVED' : 'KILLED IN ACTION',
  kills: index % 5, damageDealt: index * 2, weapons: [] }));
const details = history.slice(-50).map(row => row.ts);
const frame = raidFixture(2000, 'Current report', history, true);
frame.historyDetailIds = details;
frame.weapons = [
  { id: 'weapon-b', templateId: 'aks74', name: 'AKS-74', cartridgesFired: 20, cartridgesHit: 5, damage: 90, kills: 1 },
  { id: 'weapon-a', templateId: 'aks74', name: 'AKS-74', cartridgesFired: 40, cartridgesHit: 10, damage: 180, kills: 2 },
  { id: 'weapon-c', templateId: 'aks74', name: 'AKS-74', cartridgesFired: 12, cartridgesHit: 0, damage: 0, kills: 0 },
];

async function verifyArchive(source) {
  const app = runtime(source); app.push(frame);
  const { hooks, el, requests } = app;
  const full = hooks.historyPickerRows(frame, '', '', true);
  assert.equal(full.length, details.length + 1, 'full report list must use actual file IDs plus the in-memory current report');
  assert(full.every(row => details.includes(row.ts) || row.ts === frame.ts), 'wrong detail file surfaced');
  assert.equal(hooks.historyPickerRows(frame, '', '', false).length, history.length + 1);
  const matches = hooks.historyPickerRows(frame, '  FACTORY survived ', '', false);
  assert(matches.length > 0 && matches.every(row => row.location === 'Factory' && row.outcome === 'SURVIVED'));
  assert(hooks.historyPickerRows(frame, '', '2026-09-12', false).every(row => row.date.startsWith('2026-09-12')));
  assert.equal(hooks.historyPickerRows(frame, 'NoSuchMap', '', false).length, 0);
  const unknown = { ...frame }; delete unknown.historyDetailIds;
  assert.equal(hooks.historyDetailStatus(unknown, 1000), null, 'legacy absence is not evidence of pruning');
  assert.equal(hooks.historyPickerRows(unknown, '', '', true).length, history.length + 1);
  assert.equal(hooks.historyPickerRows({ ...frame, historyDetailIds: [1000, 1399] }, '', '', true).length, 3,
    'availability must support gaps and older files rather than newest-N assumptions');
  assert.equal(hooks.historyPickerRows({ ...frame, historyDetailIds: [] }, '', '', true).length, 1);
  const summary = el('raid-selector').options.find(option => option.value === '1000');
  assert(summary.disabled && summary.textContent.includes('summary only'), 'summary-only option is not labelled and disabled upfront');
  const totalBefore = JSON.stringify(hooks.deriveOverall(frame));
  el('archive-query').value = 'Factory'; el('archive-query').oninput();
  assert(el('archive-results').innerHTML.includes('Factory') && !el('archive-results').innerHTML.includes('Customs'));
  el('archive-date').value = '2026-09-02'; el('archive-date').onchange();
  assert(el('archive-results').innerHTML.includes('No matching raids'), 'search and date must compose');
  el('archive-clear').onclick();
  assert.equal(el('archive-query').value, '');
  el('archive-availability').value = 'all'; el('archive-availability').onchange();
  assert.equal(el('archive-results').querySelectorAll('[data-archive-raid]').length, history.length + 1);
  const pruned = el('archive-results').querySelector('[data-archive-raid="1000"]');
  assert(pruned.disabled);
  pruned.click(); assert.equal(requests.length, 0, 'disabled search result loaded a pruned raid');
  el('raid-selector').value = '1000'; el('raid-selector').onchange();
  assert.equal(requests.length, 0, 'programmatic select bypassed availability guard');
  assert(!el('history-notice').hidden && el('history-notice').textContent.includes('Overall'));
  assert.equal(JSON.stringify(hooks.deriveOverall(frame)), totalBefore, 'search changed Overall aggregation');

  el('archive-results').querySelector('[data-archive-raid="1399"]').click();
  assert.equal(requests.length, 1); assert.equal(requests[0].key, '1399');
  assert(el('raid-selector').disabled && !el('history-notice').hidden);
  requests[0].resolve(null); await app.settle();
  assert.equal(el('where').textContent, 'Current report');
  assert(!el('history-notice').hidden && el('history-notice').textContent.includes('previous report'));
  assert(!el('raid-selector').disabled);
  el('raid-selector').value = '1399'; el('raid-selector').onchange();
  requests[1].resolve(JSON.stringify(raidFixture(1399, 'Loaded Customs', [], true))); await app.settle();
  assert.equal(el('where').textContent, 'Loaded Customs'); assert(el('history-notice').hidden);
  const second = el('archive-results').querySelector('[data-archive-raid="1397"]');
  assert(!second.disabled, 'successful load left the search results disabled');
  second.click(); assert.equal(requests[2].key, '1397', 'second search result did not load');
  requests[2].resolve(JSON.stringify(raidFixture(1397, 'Second archived raid', [], true))); await app.settle();
  app.push({ ...frame, historyDetailIds: details.filter(id => id !== 1398) });
  assert.equal(el('where').textContent, 'Second archived raid', 'availability refresh replaced the archived report');
  assert.equal(el('raid-selector').value, '1397', 'availability refresh lost archive selection');
  assert(el('raid-selector').options.find(option => option.value === '1398').disabled,
    'archive availability stayed stale when reopening an archived report');
  hooks.showLive(); assert(el('history-notice').hidden);
  return app;
}

function verifyTimeline(source) {
  const app = runtime(source); app.push(frame); const h = app.hooks;
  h.setReportView('combat'); h.selectCombatHit(2);
  const selected = h.recordState().hit, initial = h.tapeRange();
  const click = action => app.el('tape').querySelector('[data-tape="' + action + '"]').click();
  click('zoom-in'); const zoomed = h.tapeRange();
  assert.equal(zoomed.end - zoomed.start, (initial.end - initial.start) / 2, 'zoom-in failed');
  assert.equal(h.recordState().hit, selected, 'zoom changed event identity');
  assert(zoomed.start <= selected.t && zoomed.end >= selected.t);
  for (let i = 0; i < 20; i++) h.zoomTape(2);
  assert.equal(h.tapeRange().end - h.tapeRange().start, 1, 'zoom exceeded one-second minimum');
  for (let i = 0; i < 90; i++) h.panTape(1);
  assert(h.tapeRange().end <= initial.end && h.tapeRange().start >= 0, 'pan escaped raid bounds');
  assert(!h.recordState().hit, 'off-window event left a misleading selected cursor');
  for (let i = 0; i < 90; i++) h.panTape(-1);
  assert.equal(h.tapeRange().start, 0);
  click('reset'); assert.equal(h.tapeRange().end, initial.end); assert.equal(h.recordState().focus, null);
  const scrub = app.el('tape-scrub'); scrub.value = initial.end; scrub.dispatchEvent('input');
  assert(h.recordState().hit && h.recordState().hit.t < initial.end, 'silent-tail control must select a preceding hit');
  for (let i = 0; i < 4; i++) h.zoomTape(2);
  assert.equal(h.recordState().hit, null, 'zoom into a silent tail kept an off-window event selected');
  click('reset');
  h.openHitExplorer({ dir: 'taken' }); const filters = JSON.stringify(h.recordState().filters);
  h.zoomTape(2); h.panTape(1); h.zoomTape(.5);
  assert.equal(JSON.stringify(h.recordState().filters), filters, 'time navigation changed combat filters');
  h.showOverall(); h.showRaidReport();
  assert.equal(JSON.stringify(h.recordState().filters), filters, 'Overall round trip lost filters');
  const prior = JSON.stringify(h.tapeRange()); h.zoomTape(NaN); h.panTape(Infinity);
  assert.equal(JSON.stringify(h.tapeRange()), prior);
  app.push(raidFixture(2001, 'New raid', [], true)); assert.equal(h.recordState().focus, null);
  assert(!/viewBox=/.test(app.el('tape').innerHTML), 'zoom must not distort round SVG markers');
}

function verifyWeapons(source) {
  const app = runtime(source); app.push(frame); const h = app.hooks;
  const before = JSON.stringify(frame.weapons), labels = h.weaponInstanceLabels(frame.weapons);
  assert.equal(labels['weapon-a'], 'Instance 1 of 3');
  assert.equal(labels['weapon-b'], 'Instance 2 of 3');
  assert.equal(labels['weapon-c'], 'Instance 3 of 3');
  assert.equal(JSON.stringify(h.weaponInstanceLabels([...frame.weapons].reverse())), JSON.stringify(labels), 'labels change with damage/card sorting');
  assert.equal(JSON.stringify(frame.weapons), before, 'labelling changed weapon counters');
  for (const label of Object.values(labels)) assert(app.el('weapons').innerHTML.includes(label), 'instance label is hidden from compact card');
  assert.equal(Object.keys(h.weaponInstanceLabels([{ ...frame.weapons[0], legacy: true }, frame.weapons[1]])).length, 0);
  assert.equal(Object.keys(h.weaponInstanceLabels([{ ...frame.weapons[0], templateId: 'different' }, frame.weapons[1]])).length, 0);
  assert.equal(Object.keys(h.weaponInstanceLabels([{ ...frame.weapons[0], id: 'unknown' }, frame.weapons[1]])).length, 0);
  assert.equal(Object.keys(h.weaponInstanceLabels([frame.weapons[0], frame.weapons[0]])).length, 0, 'same ID counted twice');
}

await verifyArchive(page); verifyTimeline(page); verifyWeapons(page);
await assert.rejects(verifyArchive(page.replace('if (detailsOnly && row.detailAvailable === false)', 'if (false)')));
assert.throws(() => verifyTimeline(page.replace('(range.end - range.start) / factor', '(range.end - range.start)')));
assert.throws(() => verifyWeapons(page.replace('var ids = groups[model].sort();', 'var ids = groups[model];')));
console.log('COMBATLOG ARCHIVE USABILITY VERIFIED');
