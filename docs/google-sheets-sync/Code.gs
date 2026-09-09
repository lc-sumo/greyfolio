const SYNC = 'Greystone Sync';
const URL_KEY = 'GREYSTONE_PORTAL_URL';
const SECRET_KEY = 'GREYSTONE_SHEETS_SYNC_SECRET';

function onOpen() {
  SpreadsheetApp.getUi().createMenu(SYNC)
    .addItem('Set up / update connection', 'setupSync')
    .addItem('Pull Master Deals', 'pullMasterDeals')
    .addItem('Push Master Deals', 'pushMasterDeals')
    .addItem('Push new remittance', 'pushRemittance')
    .addItem('Sync both tabs', 'syncBoth')
    .addItem('Install hourly sync', 'installTimedSync').addToUi();
}
function setupSync() {
  const ui = SpreadsheetApp.getUi(), p = PropertiesService.getScriptProperties();
  const url = ui.prompt('Portal URL', p.getProperty(URL_KEY) || 'https://folio.greystoneus.com', ui.ButtonSet.OK_CANCEL);
  if (url.getSelectedButton() !== ui.Button.OK) return;
  const secret = ui.prompt('Sheets sync shared key', '', ui.ButtonSet.OK_CANCEL);
  if (secret.getSelectedButton() !== ui.Button.OK || !secret.getResponseText()) throw new Error('A shared key is required');
  p.setProperties({[URL_KEY]: url.getResponseText().replace(/\/$/, ''), [SECRET_KEY]: secret.getResponseText()});
}
function connection_() {
  const p = PropertiesService.getScriptProperties(), url = p.getProperty(URL_KEY), key = p.getProperty(SECRET_KEY);
  if (!url || !key) throw new Error('Run Greystone Sync > Set up / update connection first');
  return {url: url, key: key};
}
function request_(path, method, body) {
  const c = connection_(), opts = {method: method || 'get', headers: {'X-Sheets-Sync-Secret': c.key, 'X-Sheets-Spreadsheet-Id': SpreadsheetApp.getActive().getId()}, muteHttpExceptions: true};
  if (body !== undefined) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  const r = UrlFetchApp.fetch(c.url + '/api/sync' + path, opts), code = r.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Portal sync failed (' + code + '): ' + r.getContentText().slice(0, 300));
  return JSON.parse(r.getContentText());
}
function sheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name) || SpreadsheetApp.getActive().insertSheet(name); }
function ensureHeaders_(name, headers) {
  const s = sheet_(name);
  if (!s.getLastRow() && headers.length) s.getRange(1, 1, 1, headers.length).setValues([headers]);
  return s;
}
function pullMasterDeals() {
  const lock = LockService.getDocumentLock(); lock.waitLock(30000);
  try { return pullMasterDealsLocked_(); } finally { lock.releaseLock(); }
}
function pullMasterDealsLocked_() {
  const d = request_('/master-deals'), s = sheet_('Master Deals'), headers = d.headers, editableNames = d.editableColumns || ['Deal Status', 'Lender Paid Date'];
  const localHeaders = s.getLastRow() ? s.getRange(1, 1, 1, Math.max(1, s.getLastColumn())).getValues()[0] : [];
  headers.forEach(h => { if (localHeaders.indexOf(h) < 0) { localHeaders.push(h); s.getRange(1, localHeaders.length).setValue(h); } });
  if (!s.getLastRow()) s.getRange(1, 1, 1, localHeaders.length).setValues([localHeaders]);
  PropertiesService.getScriptProperties().setProperty('GREYSTONE_MASTER_HEADERS', JSON.stringify(headers));
  const idCol = localHeaders.indexOf('Deal ID'), byId = {};
  if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, localHeaders.length).getValues().forEach((r, i) => { if (r[idCol]) byId[String(r[idCol]).trim().toUpperCase()] = i + 2; });
  d.rows.forEach(serverRow => {
    const id = String(serverRow[headers.indexOf('Deal ID')]).trim().toUpperCase(), existingRow = byId[id];
    if (!existingRow) {
      const out = localHeaders.map(h => { const i = headers.indexOf(h); return i < 0 ? '' : serverRow[i]; });
      s.appendRow(out); byId[id] = s.getLastRow(); return;
    }
    headers.forEach((h, i) => { if (editableNames.indexOf(h) < 0) s.getRange(existingRow, localHeaders.indexOf(h) + 1).setValue(serverRow[i]); });
  });
  const newInputs = d.newDealInputColumns || [];
  headers.forEach(h => s.getRange(1, localHeaders.indexOf(h) + 1).setNote((editableNames.indexOf(h) >= 0 ? 'EXISTING EDITABLE — pushed safely' : newInputs.indexOf(h) >= 0 ? 'NEW ROW INPUT — used only when Deal ID is blank' : 'PORTAL OWNED — do not edit')));
}
function csv_(s) {
  return s.getDataRange().getValues().map(r => r.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\n');
}
function key_(prefix, text) { return prefix + '-' + Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join(''); }
function pushMasterDeals() {
  const lock = LockService.getDocumentLock(); lock.waitLock(30000);
  try { return pushMasterDealsLocked_(); } finally { lock.releaseLock(); }
}
function pushMasterDealsLocked_() {
  const s = sheet_('Master Deals'), all = s.getDataRange().getValues();
  if (!all.length) return;
  const localHeaders = all[0], stored = PropertiesService.getScriptProperties().getProperty('GREYSTONE_MASTER_HEADERS');
  const canonical = stored ? JSON.parse(stored) : request_('/master-deals').headers;
  const idCol = localHeaders.indexOf('Deal ID');
  const seenIds = {};
  all.slice(1).forEach((r, i) => {
    const nonblank = canonical.some(h => h !== 'Deal ID' && String(r[localHeaders.indexOf(h)] || '').trim());
    if (nonblank && !String(r[idCol] || '').trim()) { const id = ('GS-' + Utilities.getUuid()).toUpperCase(); s.getRange(i + 2, idCol + 1).setValue(id); r[idCol] = id; }
    const normalized = String(r[idCol] || '').trim().toUpperCase();
    if (normalized) { if (seenIds[normalized]) throw new Error('Duplicate Deal ID ' + normalized + ' on rows ' + seenIds[normalized] + ' and ' + (i + 2)); seenIds[normalized] = i + 2; r[idCol] = normalized; }
  });
  const table = [canonical].concat(all.slice(1).map(r => canonical.map(h => r[localHeaders.indexOf(h)] || '')));
  const text = table.map(r => r.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\n');
  if (text.split(/\r?\n/).filter(x => x.trim()).length <= 1) return;
  request_('/master-deals', 'post', {csv: text, operationKey: key_('master-deals', text)});
}
function pushRemittance() {
  const lock = LockService.getDocumentLock(); lock.waitLock(30000);
  try { return pushRemittanceLocked_(); } finally { lock.releaseLock(); }
}
function pushRemittanceLocked_() {
  const s = ensureHeaders_('Lender Remittance', ['Receipt ID', 'Deal ID', 'Date', 'Amount', 'Applied']);
  let values = s.getDataRange().getValues(), header = values[0];
  ['Receipt ID', 'Applied'].forEach(h => { if (header.indexOf(h) < 0) { s.getRange(1, header.length + 1).setValue(h); header.push(h); } });
  values = s.getDataRange().getValues(); header = values[0];
  if (values.length < 2) return;
  const applied = header.indexOf('Applied'), receipt = header.indexOf('Receipt ID');
  values.slice(1).forEach((r, i) => {
    const rowIndex = i + 2, dataCols = header.map((_, n) => n).filter(n => n !== applied);
    if (!dataCols.some(n => n !== receipt && String(r[n] == null ? '' : r[n]).trim()) || r[applied]) return;
    if (!r[receipt]) { r[receipt] = Utilities.getUuid(); s.getRange(rowIndex, receipt + 1).setValue(r[receipt]); }
    const text = [dataCols.map(n => header[n]), dataCols.map(n => r[n])].map(x => x.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\n');
    const fingerprint = key_('', text), operationKey = 'remittance-' + r[receipt];
    request_('/remittance', 'post', {csv: text, operationKey: operationKey});
    const current = s.getRange(rowIndex, 1, 1, header.length).getValues()[0];
    const currentText = [dataCols.map(n => header[n]), dataCols.map(n => current[n])].map(x => x.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\n');
    if (key_('', currentText) === fingerprint && !current[applied]) s.getRange(rowIndex, applied + 1).setValue(new Date());
  });
}
function syncBoth() { const lock = LockService.getDocumentLock(); lock.waitLock(30000); try { pullMasterDealsLocked_(); pushRemittanceLocked_(); } finally { lock.releaseLock(); } }
function installTimedSync() { ScriptApp.newTrigger('syncBoth').timeBased().everyHours(1).create(); }