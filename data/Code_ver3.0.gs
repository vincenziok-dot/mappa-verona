/**
 * SpG Verona - DB condiviso per mappa Leaflet (index_ver2.2.6+)
 *
 * Funziona senza autenticazione per chi usa la mappa:
 * - Web App: "Esegui come" = proprietario script
 * - Accesso: "Chiunque"
 *
 * Endpoint:
 *  GET  .../exec?action=getAll&callback=cb   -> cb({ok:true, status:{...}, refs:{...}})
 *  GET  .../exec?action=ping&callback=cb     -> cb({ok:true, ...})
 *  POST .../exec  (form fields: kind, payload, k)
 *        kind=status payload={farmacia_id, stato, chiusa, incaricati, note, poster, boicotta, promo, info, deviceId}
 *        kind=ref    payload={comune, referenti:[...], deviceId}
 *
 * Backup:
 * - crea una copia del foglio ogni 5 giorni
 * - mantiene solo le ultime 3 copie
 *
 * Report settimanale:
 * - genera un report in "REPORTS"
 * - invia email (consigliato)
 * - per WhatsApp gruppo: vedi note sotto (non esiste API ufficiale semplice per gruppi consumer)
 */

// ====== NOMI SHEET (non cambiare) ======
var SH_STATUS    = 'STATUS';
var SH_REF       = 'REFERENTI';
var SH_CONFIG    = 'CONFIG';
var SH_REPORTS   = 'REPORTS';
var SH_LOG       = 'LOG';

// ====== HEADER ======
var STATUS_HEADER = ['farmacia_id','updated_at','stato','chiusa','incaricati','note','poster','boicotta','promo','info','deviceId'];
var REF_HEADER    = ['comune','updated_at','referenti','deviceId'];
var CONFIG_HEADER = ['key','value'];
var REPORT_HEADER = ['ts','summary','details'];
var LOG_HEADER    = ['ts','kind','msg','deviceId'];

// ====== VERSION ======
var CODE_VERSION = '2.2.10';

// ====== HEADER COMPAT (per vecchie versioni) ======
// Se in passato avevi intestazioni diverse, qui le mappiamo.
// Inoltre, se manca una colonna, lo script la aggiunge automaticamente.
var STATUS_ALIASES = {
  farmacia_id: ['id','farmaciaId','farmaciaID'],
  updated_at:  ['updatedAt','updatedAtISO','updatedAtUtc','updated'],
  stato:       ['state','status'],
  chiusa:      ['closed'],
  incaricati:  ['owners','incaricati_str'],
  note:        ['notes'],
  poster:      ['hasPoster'],
  boicotta:    ['boycott'],
  promo:       ['promotion'],
  info:        ['hasInfo'],
  deviceId:    ['device_id','deviceID']
};
var REF_ALIASES = {
  comune:      ['Comune','city','municipality'],
  updated_at:  ['updatedAt','updated'],
  referenti:   ['ref','refs','referenti_str'],
  deviceId:    ['device_id','deviceID']
};

// ====== CONFIG KEYS ======
var CFG_WRITE_KEY        = 'WRITE_KEY';           // opzionale. se vuoto -> scrittura aperta
var CFG_BACKUP_FOLDER_ID = 'BACKUP_FOLDER_ID';    // cartella Drive per backup (opz.)
var DEFAULT_BACKUP_FOLDER_ID = '17Cl-kZsHnbNxVhlmIM6UvLZFmDoc4Lx1'; // cartella Drive 'backup' (preimpostata)    // cartella Drive dove mettere i backup
var CFG_MAP_URL          = 'MAP_URL';             // link GitHub Pages della mappa
var CFG_DIGEST_EMAIL_TO  = 'DIGEST_EMAIL_TO';     // email report settimanale
var CFG_DIGEST_WEBHOOK_URL = 'DIGEST_WEBHOOK_URL'; // opzionale: webhook (Make/Zapier) per inoltro su WhatsApp/altro
var CFG_FARMACIE_CSV_URL = 'FARMACIE_CSV_URL';    // (opz) raw GitHub del farmacie.csv per calcolare totale

// ====== UTIL ======
function nowIso_(){ return new Date().toISOString(); }

function parseBool_(v){
  if(v === true) return true;
  if(v === false) return false;
  var s = String(v||'').trim().toLowerCase();
  if(!s) return false;
  return (s === 'true' || s === '1' || s === 'yes' || s === 'si' || s === 'y');
}

// Normalizza lo stato in uno dei 4 valori attesi dalla mappa.
// (Compat con versioni vecchie: "in trattativa", "In_trattativa", ecc.)
function normalizeStato_(v){
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if(!s) return 'contattare';
  s = s.replace(/_/g,' ').replace(/\s+/g,' ').trim();
  if(s.indexOf('tratt') !== -1) return 'trattativa';
  if(s.indexOf('ader') !== -1) return 'aderisce';
  if(s.indexOf('rifiu') !== -1) return 'rifiuta';
  if(s.indexOf('contat') !== -1) return 'contattare';
  // fallback: se già uno dei valori
  var allowed = { contattare:true, trattativa:true, aderisce:true, rifiuta:true };
  if(allowed[s]) return s;
  return 'contattare';
}

// ====== CONFIG RAPIDA (utile se il progetto Apps Script e' "standalone") ======
// Se vedi errori tipo "SPREADSHEET_ID mancante" o ss=null,
// prendi l'ID del foglio dall'URL (tra /d/ e /edit) e incollalo qui:
// Esegui setSpreadsheetId('...') UNA VOLTA, poi esegui setup().
function setSpreadsheetId(id){
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', String(id||'').trim());
  return 'SPREADSHEET_ID_OK';
}

function getSpreadsheetId(){
  try{ return PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || ''; }
  catch(e){ return ''; }
}

// Se il progetto e' CONTAINER-BOUND (creato da un Google Sheet), questa funzione
// salva automaticamente l'ID del foglio nelle Script Properties.
// Eseguila 1 volta, poi esegui setup() e fai il Deploy.
function bindToActiveSpreadsheet(){
  var ss = null;
  try{ ss = SpreadsheetApp.getActiveSpreadsheet(); }catch(e){ ss = null; }
  if(!ss){
    throw new Error('Nessun foglio attivo. Apri il Google Sheet SpG_Verona_DB e vai su Estensioni > Apps Script, poi esegui bindToActiveSpreadsheet() da li. ' +
                    'Se invece il progetto e\' standalone, imposta SPREADSHEET_ID in Impostazioni progetto > Proprietà script.');
  }
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  return 'BIND_OK: ' + ss.getId();
}

function ss_(){
  // In Web App (doGet/doPost) e/o progetti NON "bound" al foglio,
  // getActiveSpreadsheet() puo' essere null.
  // Strategia robusta:
  // 1) Se disponibile, usa getActiveSpreadsheet() e salva l'ID in Script Properties
  // 2) Altrimenti apri lo Spreadsheet via Script Properties (SPREADSHEET_ID)
  // 3) Se manca anche quello, lancia un errore "a prova di scemo".

  var ss = null;
  try{ ss = SpreadsheetApp.getActiveSpreadsheet(); }catch(e){ ss = null; }

  if(ss){
    try{
      var props = PropertiesService.getScriptProperties();
      if(!props.getProperty('SPREADSHEET_ID')){
        props.setProperty('SPREADSHEET_ID', ss.getId());
      }
    }catch(_e){}
    return ss;
  }

  var id = '';
  try{ id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || ''; }catch(e){ id=''; }
  if(id){
    return SpreadsheetApp.openById(id);
  }

  throw new Error(
    'SPREADSHEET_ID mancante. Soluzione: apri il Google Sheet (SpG_Verona_DB) > Estensioni > Apps Script, incolla questo codice, poi ESEGUI la funzione setup(). ' +
    'Se invece hai creato un progetto Apps Script standalone, vai su Impostazioni progetto (icona ingranaggio) > Proprietà script e aggiungi SPREADSHEET_ID con l\'ID del foglio (la stringa tra /d/ e /edit nell\'URL).'
  );
}

function sheet_(name){
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
  }
  return sh;
}

function ensureSheetHeaders_(name, canonicalHeader, aliases){
  var sh = sheet_(name);

  // Se sheet vuoto, crea header canonico
  if(sh.getLastRow() === 0){
    sh.appendRow(canonicalHeader);
  }

  var lastCol = sh.getLastColumn();
  if(lastCol === 0){
    sh.getRange(1,1,1,canonicalHeader.length).setValues([canonicalHeader]);
    lastCol = canonicalHeader.length;
  }

  var row1 = sh.getRange(1,1,1,lastCol).getValues()[0]
    .map(function(v){ return String(v||'').trim(); });

  var any = false;
  for(var i=0;i<row1.length;i++){ if(row1[i]){ any=true; break; } }
  if(!any){
    sh.getRange(1,1,1,canonicalHeader.length).setValues([canonicalHeader]);
    row1 = canonicalHeader.slice();
  }

  function findCol_(name){
    for(var k=0;k<row1.length;k++) if(row1[k] === name) return k;
    return -1;
  }
  function findAny_(names){
    for(var j=0;j<names.length;j++){
      var idx = findCol_(names[j]);
      if(idx !== -1) return idx;
    }
    return -1;
  }

  var idxMap = {};
  for(var h=0; h<canonicalHeader.length; h++){
    var key = canonicalHeader[h];
    var al = (aliases && aliases[key]) ? aliases[key] : [];
    var idx = findAny_([key].concat(al));
    if(idx === -1){
      // colonna mancante: la aggiungiamo in coda
      sh.getRange(1, row1.length + 1).setValue(key);
      row1.push(key);
      idx = row1.length - 1;
    }
    idxMap[key] = idx;
  }

  return { sh: sh, idx: idxMap, header: row1 };
}

function statusInfo_(){ return ensureSheetHeaders_(SH_STATUS, STATUS_HEADER, STATUS_ALIASES); }
function refInfo_(){ return ensureSheetHeaders_(SH_REF, REF_HEADER, REF_ALIASES); }
function configInfo_(){ return ensureSheetHeaders_(SH_CONFIG, CONFIG_HEADER, {}); }
function reportsInfo_(){ return ensureSheetHeaders_(SH_REPORTS, REPORT_HEADER, {}); }
function logInfo_(){ return ensureSheetHeaders_(SH_LOG, LOG_HEADER, {}); }

function ensureHeaders_(){
  statusInfo_();
  refInfo_();
  configInfo_();
  reportsInfo_();
  logInfo_();
}

function cfgGet_(key){
  ensureHeaders_();
  var sh = sheet_(SH_CONFIG);
  var rng = sh.getDataRange().getValues();
  for(var i=1;i<rng.length;i++){
    if(String(rng[i][0]||'') === key) return String(rng[i][1]||'');
  }
  return '';
}

function cfgSet_(key, value){
  ensureHeaders_();
  var sh = sheet_(SH_CONFIG);
  var rng = sh.getDataRange().getValues();
  for(var i=1;i<rng.length;i++){
    if(String(rng[i][0]||'') === key){
      sh.getRange(i+1,2).setValue(value);
      return;
    }
  }
  sh.appendRow([key, value]);
}

function log_(kind, msg, deviceId){
  try{
    ensureHeaders_();
    sheet_(SH_LOG).appendRow([nowIso_(), kind, msg, deviceId||'']);
  }catch(e){}
}

function jsonp_(obj, callback){
  var text = '';
  if(callback){
    text = callback + '(' + JSON.stringify(obj) + ');';
    return ContentService
      .createTextOutput(text)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  text = JSON.stringify(obj);
  return ContentService
    .createTextOutput(text)
    .setMimeType(ContentService.MimeType.JSON);
}

// ====== READ ALL ======
function getAll_(){
  ensureHeaders_();
  var out = { ok:true, serverTime: nowIso_(), version: CODE_VERSION, status:{}, refs:{} };

  // STATUS
  var infoS = statusInfo_();
  var shS = infoS.sh;
  var idx = infoS.idx;
  var rowsS = shS.getDataRange().getValues();

  for(var r=1;r<rowsS.length;r++){
    var id = String(rowsS[r][idx.farmacia_id]||'').trim();
    if(!id) continue;
    out.status[id] = {
      farmacia_id: id,
      updated_at: rowsS[r][idx.updated_at] || '',
      stato: rowsS[r][idx.stato] || 'contattare',
      chiusa: parseBool_(rowsS[r][idx.chiusa]),
      incaricati: rowsS[r][idx.incaricati] || '',
      note: rowsS[r][idx.note] || '',
      poster: parseBool_(rowsS[r][idx.poster]),
      boicotta: parseBool_(rowsS[r][idx.boicotta]),
      promo: parseBool_(rowsS[r][idx.promo]),
      info: parseBool_(rowsS[r][idx.info])
    };
  }

  // REFERENTI
  var infoR = refInfo_();
  var shR = infoR.sh;
  var idxR = infoR.idx;
  var rowsR = shR.getDataRange().getValues();

  for(var r2=1;r2<rowsR.length;r2++){
    var com = String(rowsR[r2][idxR.comune]||'').trim();
    if(!com) continue;
    var raw = String(rowsR[r2][idxR.referenti]||'');
    var arr = raw.split('|').map(function(x){return x.trim();}).filter(function(x){return x;});
    out.refs[com] = arr;
  }

  return out;
}

// ====== WRITE ======
function upsertStatus_(obj){
  ensureHeaders_();
  var infoS = statusInfo_();
  var sh = infoS.sh;
  var idx = infoS.idx;
  var rows = sh.getDataRange().getValues();

  // Accetta varianti (compat): farmacia_id / id / farmaciaId
  var id = String((obj && (obj.farmacia_id || obj.id || obj.farmaciaId || obj.farmaciaID)) || '').trim();
  if(!id) return { ok:false, error:'missing farmacia_id' };

  var rowIndex = -1;
  for(var r=1;r<rows.length;r++){
    if(String(rows[r][idx.farmacia_id]||'') === id){ rowIndex = r+1; break; }
  }
  if(rowIndex === -1){
    sh.appendRow(new Array(infoS.header.length));
    rowIndex = sh.getLastRow();
  }

  // Normalizza campi in ingresso (compat)
  var stato = normalizeStato_((obj.stato != null ? obj.stato : (obj.state != null ? obj.state : 'contattare')));
  var chiusa = (obj.chiusa != null ? obj.chiusa : (obj.closed != null ? obj.closed : false));
  var incaricati = (obj.incaricati != null ? obj.incaricati : (obj.owners != null ? obj.owners : ''));
  if(Array.isArray(incaricati)) incaricati = incaricati.map(function(x){return String(x||'').trim();}).filter(function(x){return x;}).join('|');
  var note = (obj.note != null ? obj.note : (obj.notes != null ? obj.notes : ''));
  var poster = (obj.poster != null ? obj.poster : (obj.hasPoster != null ? obj.hasPoster : false));
  var boicotta = (obj.boicotta != null ? obj.boicotta : (obj.boycott != null ? obj.boycott : false));
  var promo = (obj.promo != null ? obj.promo : (obj.promotion != null ? obj.promotion : false));
  var info = (obj.info != null ? obj.info : (obj.hasInfo != null ? obj.hasInfo : false));
  var deviceId = (obj.deviceId != null ? obj.deviceId : (obj.device_id != null ? obj.device_id : ''));

  // Write values
  sh.getRange(rowIndex, idx.farmacia_id+1).setValue(id);
  sh.getRange(rowIndex, idx.updated_at+1).setValue(nowIso_());
  sh.getRange(rowIndex, idx.stato+1).setValue(String(stato||'contattare'));
  sh.getRange(rowIndex, idx.chiusa+1).setValue(parseBool_(chiusa));
  sh.getRange(rowIndex, idx.incaricati+1).setValue(String(incaricati||''));
  sh.getRange(rowIndex, idx.note+1).setValue(String(note||''));
  sh.getRange(rowIndex, idx.poster+1).setValue(parseBool_(poster));
  sh.getRange(rowIndex, idx.boicotta+1).setValue(parseBool_(boicotta));
  sh.getRange(rowIndex, idx.promo+1).setValue(parseBool_(promo));
  sh.getRange(rowIndex, idx.info+1).setValue(parseBool_(info));
  sh.getRange(rowIndex, idx.deviceId+1).setValue(String(deviceId||''));

  return { ok:true, farmacia_id:id, serverTime: nowIso_() };
}


function upsertRef_(obj){
  ensureHeaders_();
  var infoR = refInfo_();
  var sh = infoR.sh;
  var idx = infoR.idx;
  var rows = sh.getDataRange().getValues();

  var com = String(obj.comune||'').trim();
  if(!com) return { ok:false, error:'missing comune' };

  var list = obj.referenti;
  if(!Array.isArray(list)) list = [];
  var pipe = list.map(function(x){return String(x||'').trim();}).filter(function(x){return x;}).join('|');

  var rowIndex = -1;
  for(var r=1;r<rows.length;r++){
    if(String(rows[r][idx.comune]||'') === com){ rowIndex = r+1; break; }
  }
  if(rowIndex === -1){
    sh.appendRow(new Array(infoR.header.length));
    rowIndex = sh.getLastRow();
  }

  sh.getRange(rowIndex, idx.comune+1).setValue(com);
  sh.getRange(rowIndex, idx.updated_at+1).setValue(nowIso_());
  sh.getRange(rowIndex, idx.referenti+1).setValue(pipe);
  sh.getRange(rowIndex, idx.deviceId+1).setValue(String(obj.deviceId||''));

  return { ok:true };
}

function write_(kind, payload, key){
  var requiredKey = cfgGet_(CFG_WRITE_KEY);
  if(requiredKey && String(requiredKey) !== String(key||'')){
    return { ok:false, error:'bad key' };
  }

  if(kind === 'status') return upsertStatus_(payload);
  if(kind === 'ref')    return upsertRef_(payload);

  return { ok:false, error:'unknown kind' };
}


function output_(obj, callback){
  var txt = JSON.stringify(obj);
  if(callback){
    // JSONP: callback(<json>);
    return ContentService.createTextOutput(String(callback) + '(' + txt + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(txt).setMimeType(ContentService.MimeType.JSON);
}
// ====== WEB APP HANDLERS ======
function doGet(e){
  var action = (e && e.parameter && e.parameter.action) ? String(e.parameter.action) : 'getAll';
  // normalize action (accetta varianti e URL incollati male)
  var _a = String(action||'').toLowerCase();
  var _a2 = _a.replace(/[^a-z]/g,'');
  if(_a2.indexOf('putstatus') !== -1) action = 'putStatus';
  else if(_a2.indexOf('putref') !== -1) action = 'putRef';
  else if(_a2.indexOf('getall') !== -1) action = 'getAll';
  else if(_a2.indexOf('ping') !== -1) action = 'ping';
  var cb = (e && e.parameter) ? e.parameter.callback : null;

  // Normalizza azioni (compat con versioni/typo)
  var a0 = String(action||'').trim();
  var al = a0.toLowerCase();
  if(al === 'putstatus' || al === 'put_status' || al === 'savestatus' || al === 'writestatus' || al === 'setstatus') action = 'putStatus';
  if(al === 'putref' || al === 'put_ref' || al === 'saveref' || al === 'writeref' || al === 'setref') action = 'putRef';
  if(al === 'getall' || al === 'get_all') action = 'getAll';

  try{
    // ping deve funzionare anche se chiamato "a mano" dall'editor.
    // Inoltre ci serve come diagnostica: se il foglio non e' configurato, ritorniamo ok:false con errore chiaro.
    if(action === 'ping'){
      try{ ensureHeaders_(); }
      catch(cfgErr){
        return jsonp_({ ok:false, action:'ping', version: CODE_VERSION, serverTime: nowIso_(), error:String(cfgErr) }, cb);
      }
      var hasKey = false;
      try{ hasKey = !!cfgGet_(CFG_WRITE_KEY); }catch(_e){ hasKey = false; }
      var caps = { getAll:true, ping:true, putStatus:true, putRef:true, post:true };
var ss = null; var sheetName = '';
try{ ss = ss_(); sheetName = ss.getName(); }catch(_e){}
return jsonp_({ ok:true, action:'ping', serverTime: nowIso_(), hasWriteKey: hasKey, version: CODE_VERSION, caps: caps, sheetName: sheetName }, cb);
    }

    // per tutte le altre azioni, assicuriamo i fogli
    ensureHeaders_();


    if(action === 'putStatus'){
      var payloadS = {};
      try{ payloadS = JSON.parse(String((e && e.parameter && e.parameter.payload) ? e.parameter.payload : '{}')); }catch(_pe){ payloadS = {}; }
      var keyS = (e && e.parameter && e.parameter.k) ? String(e.parameter.k) : '';
      var resS = write_('status', payloadS, keyS);
      try{ log_('GET_putStatus', (resS.ok ? 'ok' : ('fail: '+resS.error)), (payloadS && payloadS.deviceId) ? payloadS.deviceId : ''); }catch(_e){}
      return jsonp_(resS, cb);
    }

    if(action === 'putRef'){
      var payloadR = {};
      try{ payloadR = JSON.parse(String((e && e.parameter && e.parameter.payload) ? e.parameter.payload : '{}')); }catch(_pe2){ payloadR = {}; }
      var keyR = (e && e.parameter && e.parameter.k) ? String(e.parameter.k) : '';
      var resR = write_('ref', payloadR, keyR);
      try{ log_('GET_putRef', (resR.ok ? 'ok' : ('fail: '+resR.error)), (payloadR && payloadR.deviceId) ? payloadR.deviceId : ''); }catch(_e2){}
      return jsonp_(resR, cb);
    }

    if(action === 'getAll'){
      return jsonp_(getAll_(), cb);
    }

    return jsonp_({ ok:false, error:'unknown action', action: action, version: CODE_VERSION }, cb);
  }catch(err){
    try{ log_('GET_ERR', String(err), ''); }catch(_e){}
    return jsonp_({ ok:false, error:String(err) }, cb);
  }
}

function doPost(e){
  try{
    ensureHeaders_();    var kindRaw = (e && e.parameter && e.parameter.kind) ? String(e.parameter.kind) : '';
    var kind = kindRaw;
    var _k = String(kindRaw||'').toLowerCase().replace(/[^a-z]/g,'');
    if(_k.indexOf('status') !== -1) kind = 'status';
    else if(_k.indexOf('ref') !== -1) kind = 'ref';
    var kl = String(kind||'').trim().toLowerCase();
    if(kl === 'putstatus' || kl === 'put_status' || kl === 'status') kind = 'status';
    if(kl === 'putref' || kl === 'put_ref' || kl === 'ref') kind = 'ref';
    var key  = (e && e.parameter && e.parameter.k) ? String(e.parameter.k) : '';
    var payloadRaw = (e && e.parameter && e.parameter.payload) ? String(e.parameter.payload) : '{}';
    var payload = {};
    try{ payload = JSON.parse(payloadRaw); }catch(parseErr){ payload = {}; }

    var res = write_(kind, payload, key);
    log_('POST_'+kind, (res.ok ? 'ok' : ('fail: '+res.error)), payload.deviceId || '');

    // Non serve risposta al client (iframe hidden), ma ritorno JSON per debug
    return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
  }catch(err){
    log_('POST_ERR', String(err), (e && e.parameter && e.parameter.deviceId) ? e.parameter.deviceId : '');
    return ContentService.createTextOutput(JSON.stringify({ok:false, error:String(err)})).setMimeType(ContentService.MimeType.JSON);
  }
}

// ====== SETUP / TRIGGERS ======
function setup(){
  // Esegui 1 volta a mano per creare sheet + config base
  ensureHeaders_();
  if(!cfgGet_(CFG_MAP_URL)) cfgSet_(CFG_MAP_URL, '');
  if(!cfgGet_(CFG_DIGEST_EMAIL_TO)) cfgSet_(CFG_DIGEST_EMAIL_TO, '');
  if(!cfgGet_(CFG_DIGEST_WEBHOOK_URL)) cfgSet_(CFG_DIGEST_WEBHOOK_URL, '');
  if(!cfgGet_(CFG_FARMACIE_CSV_URL)) cfgSet_(CFG_FARMACIE_CSV_URL, '');
  if(!cfgGet_(CFG_BACKUP_FOLDER_ID) && DEFAULT_BACKUP_FOLDER_ID) cfgSet_(CFG_BACKUP_FOLDER_ID, DEFAULT_BACKUP_FOLDER_ID);
  // crea/aggiorna trigger (backup ogni 5 giorni + report settimanale)
  try{ installTriggers(); }catch(e){}

  return 'OK';
}

function installTriggers(){
  // cancella trigger duplicati e ricrea
  var all = ScriptApp.getProjectTriggers();
  all.forEach(function(t){
    var f = t.getHandlerFunction();
    if(f === 'backupRotate' || f === 'weeklyDigest'){
      ScriptApp.deleteTrigger(t);
    }
  });

  // Backup ogni 5 giorni
  ScriptApp.newTrigger('backupRotate').timeBased().everyDays(5).atHour(3).create();

  // Report settimanale (Lunedi 09:00)
  ScriptApp.newTrigger('weeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).everyWeeks(1).create();

  return 'TRIGGERS_OK';
}

function getOrCreateBackupFolderId_(){
  var id = cfgGet_(CFG_BACKUP_FOLDER_ID);
  if(id){
    try{ DriveApp.getFolderById(id); return id; }catch(e){}
  }
  var folder = DriveApp.createFolder('SpG_Verona_DB_BACKUP');
  id = folder.getId();
  cfgSet_(CFG_BACKUP_FOLDER_ID, id);
  return id;
}

function backupRotate(){
  ensureHeaders_();
  var ss = ss_();
  var folderId = getOrCreateBackupFolderId_();
  var folder = DriveApp.getFolderById(folderId);

  var name = 'SpG_Verona_DB_backup_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');
  var file = DriveApp.getFileById(ss.getId());
  var copy = file.makeCopy(name, folder);

  // Mantieni solo le ultime 3 copie
  var files = folder.getFiles();
  var list = [];
  while(files.hasNext()){
    var f = files.next();
    if(String(f.getName()).indexOf('SpG_Verona_DB_backup_') === 0){
      list.push({id: f.getId(), name: f.getName(), created: f.getDateCreated().getTime()});
    }
  }
  list.sort(function(a,b){ return b.created - a.created; });
  for(var i=3;i<list.length;i++){
    try{ DriveApp.getFileById(list[i].id).setTrashed(true); }catch(e){}
  }

  log_('BACKUP', 'created ' + copy.getName(), '');
}

// ====== REPORT SETTIMANALE ======
function parseFarmacieCsvCount_(){
  var url = cfgGet_(CFG_FARMACIE_CSV_URL);
  if(!url) return { ok:false, total:null };
  try{
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions:true });
    var txt = res.getContentText();
    if(!txt) return { ok:false, total:null };
    var lines = txt.split(/\r?\n/).filter(function(x){return x.trim();});
    if(lines.length<=1) return { ok:false, total:null };
    return { ok:true, total: lines.length - 1 };
  }catch(e){
    return { ok:false, total:null };
  }
}

function weeklyDigest(){
  ensureHeaders_();

  var data = getAll_();
  var st = data.status || {};

  var counts = { contattare:0, trattativa:0, aderisce:0, rifiuta:0, chiusa:0 };
  Object.keys(st).forEach(function(id){
    var row = st[id] || {};
    if(row.chiusa) counts.chiusa++;
    var stato = String(row.stato || 'contattare');
    if(!counts.hasOwnProperty(stato)) counts[stato]=0;
    counts[stato]++;
  });

  var totalInfo = parseFarmacieCsvCount_();
  var total = totalInfo.total;

  var mapUrl = cfgGet_(CFG_MAP_URL) || '';
  var pct = (total && total>0) ? Math.round((counts.aderisce/total)*1000)/10 : null;

  var lines = [];
  lines.push('SpG Verona - Report settimanale');
  if(total){
    lines.push('Aderiscono: ' + counts.aderisce + '/' + total + ' (' + pct + '%)');
    lines.push('Trattativa: ' + counts.trattativa + ' · Non aderisce: ' + counts.rifiuta + ' · Da contattare: ' + counts.contattare);
  }else{
    lines.push('Aderiscono: ' + counts.aderisce + ' (totale NON configurato)');
    lines.push('Trattativa: ' + counts.trattativa + ' · Non aderisce: ' + counts.rifiuta + ' · Da contattare: ' + counts.contattare);
    lines.push('Per avere il totale, imposta CONFIG -> FARMACIE_CSV_URL (raw github del farmacie.csv)');
  }
  if(mapUrl) lines.push('Mappa: ' + mapUrl);

  var msg = lines.join('\n');

  // Salva in REPORTS
  sheet_(SH_REPORTS).appendRow([nowIso_(), msg.split('\n')[0], msg]);

  // Invia email (consigliato)

  // Webhook (opzionale): se usi Make/Zapier per inoltrare su WhatsApp/altro
  var wh = cfgGet_(CFG_DIGEST_WEBHOOK_URL);
  if(wh){
    try{
      UrlFetchApp.fetch(wh, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ text: msg, mapUrl: mapUrl, counts: counts, total: total, pct: pct, ts: nowIso_() }),
        muteHttpExceptions: true
      });
    }catch(e){
      log_('WEBHOOK_ERR', String(e), '');
    }
  }
  var to = cfgGet_(CFG_DIGEST_EMAIL_TO);
  if(to){
    try{ GmailApp.sendEmail(to, 'SpG Verona - Report settimanale', msg); }
    catch(e){ log_('MAIL_ERR', String(e), ''); }
  }

  log_('DIGEST', 'ok', '');
}

