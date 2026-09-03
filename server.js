const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable } = require('stream');
const { createTicketPdf } = require('./ticket-pdf');
const { qrSvg } = require('./qr-code');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_FILE), 'uploads');
const FILE_STORAGE_BACKEND = ['local','mirror','r2'].includes(String(process.env.FILE_STORAGE_BACKEND || '').toLowerCase()) ? String(process.env.FILE_STORAGE_BACKEND).toLowerCase() : 'local';
const R2_ACCOUNT_ID = String(process.env.R2_ACCOUNT_ID || '').trim();
const R2_ACCESS_KEY_ID = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET = String(process.env.R2_BUCKET || '').trim();
const R2_PREFIX = String(process.env.R2_PREFIX || 'busops').trim().replace(/^\/+|\/+$/g, '');
const R2_JURISDICTION = String(process.env.R2_JURISDICTION || '').trim().toLowerCase().replace(/[^a-z0-9-]/g,'');
const R2_CONFIGURED = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
const BACKUP_ENCRYPTION_KEY = String(process.env.BACKUP_ENCRYPTION_KEY || '').trim();
const BACKUP_INTERVAL_HOURS = Math.max(0, Number(process.env.BACKUP_INTERVAL_HOURS || 0));
const RELEASE_ID = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local').slice(0, 12);
let lastFileStorageError = null;
const PUBLIC = path.join(__dirname, 'public');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const SESSION_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000);
const REMEMBERED_SESSION_TTL_MS = Math.max(24 * 60 * 60 * 1000, Number(process.env.REMEMBERED_SESSION_DAYS || 30) * 24 * 60 * 60 * 1000);
// Baggage photos are transported as base64 inside JSON. Keep a generous
// request-level safety ceiling without imposing a baggage-photo size limit.
const MAX_JSON_BODY_BYTES = 128 * 1024 * 1024;
const loginAttempts = new Map();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, user) {
  const candidate = crypto.scryptSync(password, user.salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(user.passwordHash, 'hex'));
}
function seed() {
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || (IS_PRODUCTION ? '' : 'admin123');
  if (!adminPassword || adminPassword.length < 12) {
    if (IS_PRODUCTION) throw new Error('INITIAL_ADMIN_PASSWORD skal være mindst 12 tegn i produktion');
  }
  const admin = hashPassword(adminPassword || 'admin123');
  const driver1 = hashPassword('chauffor123');
  const driver2 = hashPassword('chauffor123');
  const users = [
    { id: 1, name: process.env.INITIAL_ADMIN_NAME || 'Administrator', email: String(process.env.INITIAL_ADMIN_EMAIL || 'admin@albaturist.dk').toLowerCase(), role: 'admin', salt: admin.salt, passwordHash: admin.hash }
  ];
  if (!IS_PRODUCTION) users.push(
    { id: 2, name: 'Mads Chauffør', email: 'mads@albaturist.dk', role: 'driver', salt: driver1.salt, passwordHash: driver1.hash },
    { id: 3, name: 'Sara Chauffør', email: 'sara@albaturist.dk', role: 'driver', salt: driver2.salt, passwordHash: driver2.hash }
  );
  return {
    meta: { version: 28, nextId: 20, nextAccountingSequence: 0, nextBookingSequence: 0 },
    settings: { logoFile: null, logoType: null, logoName: null, ticketSigningSecret: crypto.randomBytes(32).toString('hex') },
    users,
    stops: [], buses: [],
    trips: [],
    passengers: [], baggage: [], expenses: [], cashSettlements: [], cashTransfers: [], cashBudgetEntries: [], accountingEntries: [], notificationDrafts: [], auditLog: [], sessions: [], systemEvents: [], securityEvents: [], maintenanceRuns: [], clientActions: [], offlineClients: []
  };
}
function writeLocalDb(value) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const temp = `${DB_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, DB_FILE);
}
function loadLocalDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (_) { const value = seed(); writeLocalDb(value); return value; }
}
function readLocalDbIfPresent() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (_) { return null; }
}
let db = null;
let pool = null;
let storageWriteQueue = Promise.resolve();
async function saveDb(value = db) {
  const snapshot = JSON.stringify(value);
  if (!pool) { writeLocalDb(value); return; }
  storageWriteQueue = storageWriteQueue.catch(() => {}).then(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO busops_state (id, data, revision, updated_at) VALUES (1, $1::jsonb, 1, NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, revision = busops_state.revision + 1, updated_at = NOW()`,
        [snapshot]
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
  await storageWriteQueue;
}
function migrateDb(value) {
  let migrated = false;
  value.meta = value.meta || { version: 1, nextId: 20 };
  if (!value.settings || typeof value.settings !== 'object') { value.settings = { logoFile:null,logoType:null,logoName:null }; migrated = true; }
  for (const name of ['users','stops','buses','trips','passengers','baggage','expenses','cashSettlements','cashTransfers','cashBudgetEntries','accountingEntries','notificationDrafts','auditLog','systemEvents','securityEvents','maintenanceRuns','clientActions','offlineClients']) if (!Array.isArray(value[name])) { value[name] = []; migrated = true; }
  if ((value.meta.version || 1) < 3) {
    value.stops = []; value.trips = []; value.passengers = []; value.baggage = [];
    value.meta.version = 3; migrated = true;
  }
  if ((value.meta.version || 1) < 4) { value.buses = value.buses || []; value.meta.version = 4; migrated = true; }
  if ((value.meta.version || 1) < 5) { value.expenses = value.expenses || []; value.meta.version = 5; migrated = true; }
  if ((value.meta.version || 1) < 6) { value.cashSettlements = value.cashSettlements || []; value.meta.version = 6; migrated = true; }
  if ((value.meta.version || 1) < 7) {
    for (const bus of value.buses) if (bus.type === 'double') { bus.seatCount = 84; bus.lowerDeckSeats = 22; value.trips.filter(t => t.busId === bus.id).forEach(t => t.seatCount = 84); }
    value.meta.version = 7; migrated = true;
  }
  if ((value.meta.version || 1) < 8) { for (const expense of value.expenses) if (!expense.status) expense.status = 'pending'; value.meta.version = 8; migrated = true; }
  if ((value.meta.version || 1) < 9) { for (const item of value.baggage) { item.photoName = item.photoName || null; item.photoType = item.photoType || null; item.photoFile = item.photoFile || null; } value.meta.version = 9; migrated = true; }
  if ((value.meta.version || 1) < 10 || !Array.isArray(value.sessions)) { value.sessions = []; value.meta.version = 10; migrated = true; }
  if ((value.meta.version || 1) < 11 || !Array.isArray(value.cashTransfers)) { value.cashTransfers = value.cashTransfers || []; value.meta.version = 11; migrated = true; }
  if ((value.meta.version || 1) < 12) { for (const item of value.baggage) if (item.recipientName === undefined) item.recipientName = ''; value.meta.version = 12; migrated = true; }
  if ((value.meta.version || 1) < 13) {
    for (const trip of value.trips) {
      if (!Array.isArray(trip.timetable)) {
        const departureAt = new Date(trip.departureAt);
        const arrivalAt = new Date(departureAt.getTime() + (Number(trip.durationMinutes) || 480) * 60000);
        trip.timetable = [{ stopId: trip.originId, arrivalAt: departureAt.toISOString(), departureAt: departureAt.toISOString() }];
        if (trip.destinationId !== trip.originId) trip.timetable.push({ stopId: trip.destinationId, arrivalAt: arrivalAt.toISOString(), departureAt: arrivalAt.toISOString() });
      }
      const destinationRow = trip.timetable.find(row => Number(row.stopId) === Number(trip.destinationId));
      if (!trip.destinationArrivalAt && destinationRow?.arrivalAt) trip.destinationArrivalAt = destinationRow.arrivalAt;
    }
    value.meta.version = 13; migrated = true;
  }
  if ((value.meta.version || 1) < 14) { for (const passenger of value.passengers) if (passenger.ticketNumber === undefined) passenger.ticketNumber = ''; value.meta.version = 14; migrated = true; }
  if ((value.meta.version || 1) < 15) { value.auditLog = value.auditLog || []; value.meta.version = 15; migrated = true; }
  if ((value.meta.version || 1) < 16) {
    for (const transfer of value.cashTransfers || []) {
      transfer.fromUserId = transfer.fromUserId || transfer.fromDriverId;
      transfer.toUserId = transfer.toUserId || transfer.toDriverId;
      transfer.transferType = transfer.transferType || 'driver_transfer';
    }
    value.meta.version = 16; migrated = true;
  }
  if ((value.meta.version || 1) < 17) {
    for (const passenger of value.passengers || []) {
      passenger.ticketCashAmount = passenger.ticketCashAmount ?? Number(passenger.cashAmount || 0);
      passenger.extraSeatNumber = passenger.extraSeatNumber || null;
      passenger.extraSeatAmount = Number(passenger.extraSeatAmount || 0);
      passenger.extraSeatCurrency = passenger.extraSeatCurrency || passenger.paymentCurrency || 'DKK';
      passenger.extraSeatFree = passenger.extraSeatFree === true;
    }
    value.meta.version = 17; migrated = true;
  }
  if ((value.meta.version || 1) < 18) { value.cashBudgetEntries = value.cashBudgetEntries || []; value.meta.version = 18; migrated = true; }
  if ((value.meta.version || 1) < 19) {
    for (const passenger of value.passengers || []) {
      passenger.ticketType = passenger.ticketType || 'one_way';
      passenger.journeyLeg = passenger.journeyLeg || 'outbound';
      passenger.bookingGroupId = passenger.bookingGroupId || null;
      passenger.returnStatus = passenger.returnStatus || null;
      passenger.returnTripId = passenger.returnTripId || null;
      passenger.returnPassengerId = passenger.returnPassengerId || null;
      passenger.outboundPassengerId = passenger.outboundPassengerId || null;
      passenger.openReturnValidUntil = passenger.openReturnValidUntil || null;
    }
    value.meta.version = 19; migrated = true;
  }
  if ((value.meta.version || 1) < 20) {
    for (const passenger of value.passengers || []) {
      passenger.partyBookingId = passenger.partyBookingId || null;
      passenger.partyPrimaryPassengerId = passenger.partyPrimaryPassengerId || null;
      passenger.partyRole = passenger.partyRole || null;
      passenger.partySize = Number(passenger.partySize || 0) || null;
    }
    value.meta.version = 20; migrated = true;
  }
  if ((value.meta.version || 1) < 21) {
    for (const trip of value.trips || []) trip.departureChecklist = trip.departureChecklist || {};
    for (const record of [...(value.passengers || []), ...(value.baggage || [])]) {
      record.externalPaymentConfirmedAt = record.externalPaymentConfirmedAt || null;
      record.externalPaymentConfirmedBy = record.externalPaymentConfirmedBy || null;
      record.externalPaymentAmount = Number(record.externalPaymentAmount || 0);
      record.externalPaymentCurrency = record.externalPaymentCurrency || null;
      record.externalPaymentNote = record.externalPaymentNote || '';
    }
    value.meta.version = 21; migrated = true;
  }
  if ((value.meta.version || 1) < 22) {
    for (const trip of value.trips || []) {
      trip.boardingStartedAt = trip.boardingStartedAt || null;
      trip.boardingStartedBy = trip.boardingStartedBy || null;
      trip.startedAt = trip.startedAt || null;
      trip.startedBy = trip.startedBy || null;
      trip.arrivedAt = trip.arrivedAt || null;
      trip.arrivedBy = trip.arrivedBy || null;
    }
    value.meta.version = 22; migrated = true;
  }
  if ((value.meta.version || 1) < 23) { value.notificationDrafts = value.notificationDrafts || []; value.meta.version = 23; migrated = true; }
  if ((value.meta.version || 1) < 24) { value.systemEvents = value.systemEvents || []; value.securityEvents = value.securityEvents || []; value.maintenanceRuns = value.maintenanceRuns || []; value.meta.version = 24; migrated = true; }
  if ((value.meta.version || 1) < 25) { value.accountingEntries = value.accountingEntries || []; backfillAccountingEntries(value); value.meta.version = 25; migrated = true; }
  if ((value.meta.version || 1) < 26) { backfillBookingNumbers(value); value.meta.version = 26; migrated = true; }
  if ((value.meta.version || 1) < 27) { value.clientActions = value.clientActions || []; value.offlineClients = value.offlineClients || []; value.meta.version = 27; migrated = true; }
  if ((value.meta.version || 1) < 28) {
    value.settings.ticketSigningSecret = value.settings.ticketSigningSecret || crypto.randomBytes(32).toString('hex');
    value.meta.version = 28; migrated = true;
  }
  for(const user of value.users){if(!['da','sq','de','en'].includes(user.language)){user.language='da';migrated=true}}
  for (const trip of value.trips) {
    if (!trip.seatCount) { trip.seatCount = 54; migrated = true; }
    if (!trip.durationMinutes) { trip.durationMinutes = 480; migrated = true; }
  }
  return migrated;
}
async function initializeStorage() {
  let created = false;
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    const config = { connectionString: DATABASE_URL, max: Math.max(1, Number(process.env.DATABASE_POOL_SIZE || 5)) };
    if (process.env.DATABASE_SSL === 'no-verify') config.ssl = { rejectUnauthorized: false };
    else if (process.env.DATABASE_SSL === 'require') config.ssl = true;
    pool = new Pool(config);
    pool.on('error', error => console.error('PostgreSQL-forbindelse fejlede', error));
    await pool.query('CREATE TABLE IF NOT EXISTS busops_state (id SMALLINT PRIMARY KEY CHECK (id = 1), data JSONB NOT NULL, revision BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await pool.query('ALTER TABLE busops_state ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1');
    await pool.query('CREATE TABLE IF NOT EXISTS busops_import_log (id BIGSERIAL PRIMARY KEY, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), source TEXT NOT NULL, summary JSONB NOT NULL)');
    const result = await pool.query('SELECT data FROM busops_state WHERE id = 1');
    const localData = !result.rows[0] ? readLocalDbIfPresent() : null;
    db = result.rows[0]?.data || localData || seed();
    created = !result.rows[0];
    if (created && localData) await pool.query('INSERT INTO busops_import_log (source, summary) VALUES ($1, $2::jsonb)', [DB_FILE, JSON.stringify({ trips:localData.trips?.length||0,passengers:localData.passengers?.length||0,baggage:localData.baggage?.length||0,expenses:localData.expenses?.length||0 })]);
  } else db = loadLocalDb();
  const migrated = migrateDb(db);
  if (created || migrated) await saveDb();
}
const storageReady = initializeStorage();
storageReady.catch(error => console.error('BusOps kunne ikke klargøre datalageret', error.message));
function id() { db.meta.nextId += 1; return db.meta.nextId; }
function cleanUser(user) { const { salt, passwordHash, portraitFile, ...safe } = user; return { ...safe, hasPortrait:Boolean(portraitFile) }; }
function storageError(message,statusCode=502){return Object.assign(new Error(message),{statusCode})}
function r2ObjectKey(file){return [R2_PREFIX,path.basename(String(file||''))].filter(Boolean).map(part=>encodeURIComponent(part)).join('/')}
function hmac(key,value,encoding){return crypto.createHmac('sha256',key).update(value).digest(encoding)}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex')}
async function r2Request(method,file,{bytes=null,type='application/octet-stream'}={}){
  if(!R2_CONFIGURED)throw storageError('Cloudflare R2 er ikke fuldt konfigureret',503);
  const now=new Date(),amzDate=now.toISOString().replace(/[:-]|\.\d{3}/g,''),dateStamp=amzDate.slice(0,8),host=`${R2_ACCOUNT_ID}${R2_JURISDICTION?`.${R2_JURISDICTION}`:''}.r2.cloudflarestorage.com`,canonicalUri=`/${encodeURIComponent(R2_BUCKET)}/${r2ObjectKey(file)}`,payload=bytes||Buffer.alloc(0),payloadHash=sha256(payload),signedHeaders='host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders=`host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,canonicalRequest=[method,canonicalUri,'',canonicalHeaders,signedHeaders,payloadHash].join('\n'),scope=`${dateStamp}/auto/s3/aws4_request`,stringToSign=['AWS4-HMAC-SHA256',amzDate,scope,sha256(canonicalRequest)].join('\n');
  const dateKey=hmac(`AWS4${R2_SECRET_ACCESS_KEY}`,dateStamp),regionKey=hmac(dateKey,'auto'),serviceKey=hmac(regionKey,'s3'),signingKey=hmac(serviceKey,'aws4_request'),signature=hmac(signingKey,stringToSign,'hex');
  const response=await fetch(`https://${host}${canonicalUri}`,{method,headers:{Authorization:`AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,'x-amz-content-sha256':payloadHash,'x-amz-date':amzDate,...(method==='PUT'?{'Content-Type':type}:{})},body:method==='PUT'?payload:undefined});
  return response;
}
async function storeFile(file,bytes,type){
  const safeFile=path.basename(file);
  if(FILE_STORAGE_BACKEND!=='r2'){fs.mkdirSync(UPLOAD_DIR,{recursive:true});fs.writeFileSync(path.join(UPLOAD_DIR,safeFile),bytes)}
  if(FILE_STORAGE_BACKEND!=='local'){
    try{const response=await r2Request('PUT',safeFile,{bytes,type});if(!response.ok)throw storageError(`Cloudflare R2 afviste uploaden (${response.status})`);lastFileStorageError=null}
    catch(error){lastFileStorageError={at:new Date().toISOString(),message:error.message};if(FILE_STORAGE_BACKEND==='r2')throw error;console.error('Cloudflare R2-spejling fejlede; den lokale kopi er bevaret:',error.message)}
  }
}
async function removeStoredFile(file){
  if(!file)return;
  const safeFile=path.basename(file),target=path.join(UPLOAD_DIR,safeFile);
  if(FILE_STORAGE_BACKEND!=='r2'&&fs.existsSync(target))fs.unlinkSync(target);
  if(FILE_STORAGE_BACKEND!=='local'&&R2_CONFIGURED){try{const response=await r2Request('DELETE',safeFile);if(!response.ok&&response.status!==404)throw storageError(`Cloudflare R2 kunne ikke slette ${safeFile} (${response.status})`);lastFileStorageError=null}catch(error){lastFileStorageError={at:new Date().toISOString(),message:error.message};if(FILE_STORAGE_BACKEND==='r2')throw error;console.error(error.message)}}
}
async function serveStoredFile(res,file,type,name=null){
  const safeFile=path.basename(file||'');if(!safeFile)return fail(res,404,'Filen findes ikke');
  if(FILE_STORAGE_BACKEND!=='local'&&R2_CONFIGURED){
    try{const response=await r2Request('GET',safeFile);if(response.ok){lastFileStorageError=null;res.writeHead(200,{'Content-Type':type||response.headers.get('content-type')||'application/octet-stream','Content-Disposition':name?`inline; filename*=UTF-8''${encodeURIComponent(name)}`:'inline','Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'});if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();return}if(response.status!==404)throw storageError(`Cloudflare R2 kunne ikke hente filen (${response.status})`)}
    catch(error){lastFileStorageError={at:new Date().toISOString(),message:error.message};if(FILE_STORAGE_BACKEND==='r2')throw error;console.error('Cloudflare R2-læsning fejlede; prøver lokal kopi:',error.message)}
  }
  const target=path.join(UPLOAD_DIR,safeFile);if(!fs.existsSync(target))return fail(res,404,'Filen findes ikke');
  res.writeHead(200,{'Content-Type':type||'application/octet-stream','Content-Disposition':name?`inline; filename*=UTF-8''${encodeURIComponent(name)}`:'inline','Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'});fs.createReadStream(target).pipe(res);
}
async function storeImage(data,{prefix,maxBytes=10*1024*1024}={}) {
  const type=String(data.type||''),name=path.basename(String(data.name||`${prefix}-billede`));
  if(!['image/jpeg','image/png','image/webp'].includes(type))throw Object.assign(new Error('Billedet skal være JPG, PNG eller WebP'),{statusCode:400});
  const encoded=String(data.data||'').replace(/^data:[^;]+;base64,/,'');const bytes=Buffer.from(encoded,'base64');
  if(!bytes.length||bytes.length>maxBytes)throw Object.assign(new Error('Billedet skal være mellem 1 byte og 10 MB'),{statusCode:400});
  const extension={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'}[type],file=`${prefix}-${crypto.randomBytes(18).toString('hex')}${extension}`;
  await storeFile(file,bytes,type);return{file,type,name};
}
async function storedImage(res,file,type){return serveStoredFile(res,file,type)}
function backupKey() {
  if (!BACKUP_ENCRYPTION_KEY) return null;
  let key;
  try { key = Buffer.from(BACKUP_ENCRYPTION_KEY, 'base64'); } catch (_) { return null; }
  return key.length === 32 ? key : null;
}
function referencedStoredFiles() {
  const references=[];
  const add=(file,type,name,source,entityId)=>{const safeFile=path.basename(String(file||''));if(safeFile)references.push({file:safeFile,type:type||'application/octet-stream',name:name||safeFile,source,entityId:Number(entityId)||null})};
  add(db.settings?.logoFile,db.settings?.logoType,db.settings?.logoName,'branding',null);
  for(const user of db.users||[])add(user.portraitFile,user.portraitType,user.portraitName,'user',user.id);
  for(const item of db.baggage||[])add(item.photoFile,item.photoType,item.photoName,'baggage',item.id);
  for(const expense of db.expenses||[])add(expense.receiptFile,expense.receiptType,expense.receiptName,'expense',expense.id);
  const unique=new Map();for(const reference of references){const current=unique.get(reference.file);if(current)current.references.push({source:reference.source,entityId:reference.entityId});else unique.set(reference.file,{...reference,references:[{source:reference.source,entityId:reference.entityId}]})}
  return [...unique.values()];
}
function maintenanceRun(type,status,summary={},user=null) {
  const run={id:id(),type,status,startedAt:summary.startedAt||new Date().toISOString(),finishedAt:new Date().toISOString(),createdBy:user?.id||null,createdByName:user?.name||'System',summary:{...summary}};
  delete run.summary.startedAt;db.maintenanceRuns.push(run);if(db.maintenanceRuns.length>250)db.maintenanceRuns.splice(0,db.maintenanceRuns.length-250);return run;
}
function systemEvent(level,type,message,details={}) {
  if(!db)return null;const event={id:id(),at:new Date().toISOString(),level,type,message,details,acknowledgedAt:null,acknowledgedBy:null};db.systemEvents.push(event);if(db.systemEvents.length>500)db.systemEvents.splice(0,db.systemEvents.length-500);return event;
}
async function inspectStoredFiles({verifyR2=false}={}) {
  const files=referencedStoredFiles(),items=[];
  for(const reference of files){
    const localPath=path.join(UPLOAD_DIR,reference.file),local=fs.existsSync(localPath),localBytes=local?fs.statSync(localPath).size:null;let r2=null,r2Error=null;
    if(verifyR2&&R2_CONFIGURED){try{const response=await r2Request('HEAD',reference.file);r2=response.ok;r2Error=response.ok||response.status===404?null:`HTTP ${response.status}`}catch(error){r2=false;r2Error=error.message}}
    items.push({...reference,local,localBytes,r2,r2Error});
  }
  return {backend:FILE_STORAGE_BACKEND,r2Configured:R2_CONFIGURED,total:items.length,local:items.filter(item=>item.local).length,r2:items.filter(item=>item.r2===true).length,missingLocal:items.filter(item=>!item.local).length,missingR2:verifyR2?items.filter(item=>item.r2===false).length:null,items};
}
async function migrateStoredFilesToR2({dryRun=false,user=null}={}) {
  if(!R2_CONFIGURED)throw storageError('Cloudflare R2 er ikke fuldt konfigureret',503);
  const startedAt=new Date().toISOString(),report=await inspectStoredFiles({verifyR2:true}),result={startedAt,dryRun,total:report.total,copied:0,alreadyPresent:0,missingLocal:0,failed:0,errors:[]};
  for(const item of report.items){
    if(item.r2){result.alreadyPresent++;continue}
    if(!item.local){result.missingLocal++;result.errors.push({file:item.file,error:'Den lokale original findes ikke'});continue}
    if(dryRun)continue;
    try{const bytes=fs.readFileSync(path.join(UPLOAD_DIR,item.file)),response=await r2Request('PUT',item.file,{bytes,type:item.type});if(!response.ok)throw storageError(`R2 svarede HTTP ${response.status}`);result.copied++}
    catch(error){result.failed++;result.errors.push({file:item.file,error:error.message})}
  }
  const status=result.failed||result.missingLocal?'warning':'success',run=maintenanceRun('file_migration',status,result,user);systemEvent(status==='success'?'info':'warning','file_migration',status==='success'?`Filkontrol afsluttet: ${result.copied} filer kopieret til R2`:`Filkontrol afsluttet med ${result.failed+result.missingLocal} problemer`,{runId:run.id,copied:result.copied,failed:result.failed,missingLocal:result.missingLocal});await saveDb();return run;
}
function encryptDatabaseSnapshot(value=db) {
  const key=backupKey();if(!key)throw storageError('BACKUP_ENCRYPTION_KEY skal vÃ¦re en base64-kodet nÃ¸gle pÃ¥ 32 bytes',503);
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),compressed=zlib.gzipSync(Buffer.from(JSON.stringify(value))),encrypted=Buffer.concat([cipher.update(compressed),cipher.final()]),tag=cipher.getAuthTag();
  return Buffer.concat([Buffer.from('BUSOPS1'),iv,tag,encrypted]);
}
function decryptDatabaseSnapshot(bytes) {
  const key=backupKey(),buffer=Buffer.from(bytes);if(!key)throw storageError('BACKUP_ENCRYPTION_KEY er ikke gyldig',503);if(buffer.subarray(0,7).toString()!=='BUSOPS1')throw storageError('Backupfilen har et ukendt format',400);
  const iv=buffer.subarray(7,19),tag=buffer.subarray(19,35),encrypted=buffer.subarray(35),decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);const raw=zlib.gunzipSync(Buffer.concat([decipher.update(encrypted),decipher.final()]));return JSON.parse(raw.toString('utf8'));
}
function validateDatabaseSnapshot(value) {
  if(!value||typeof value!=='object'||!value.meta||!Array.isArray(value.users)||!Array.isArray(value.trips)||!Array.isArray(value.passengers))throw storageError('Backupfilen indeholder ikke en gyldig BusOps-database',400);return value;
}
async function createDatabaseBackup({user=null,reason='manual'}={}) {
  if(!R2_CONFIGURED)throw storageError('Cloudflare R2 er ikke fuldt konfigureret',503);const startedAt=new Date().toISOString(),bytes=encryptDatabaseSnapshot(db),timestamp=startedAt.replace(/[:.]/g,'-'),file=`database-backup-${timestamp}.busops`;
  const response=await r2Request('PUT',file,{bytes,type:'application/octet-stream'});if(!response.ok)throw storageError(`R2 afviste databasebackuppen (HTTP ${response.status})`);
  const run=maintenanceRun('database_backup','success',{startedAt,reason,file,bytes:bytes.length,records:{users:db.users.length,trips:db.trips.length,passengers:db.passengers.length,baggage:db.baggage.length,expenses:db.expenses.length}},user);systemEvent('info','database_backup','Krypteret databasebackup blev oprettet',{runId:run.id,file,bytes:bytes.length});await saveDb();return run;
}
async function restoreDatabaseBackupBytes(bytes,{confirmed=false,user=null}={}) {
  if(!confirmed)throw storageError('Gendannelse krÃ¦ver en udtrykkelig bekrÃ¦ftelse',400);const restored=validateDatabaseSnapshot(decryptDatabaseSnapshot(bytes));migrateDb(restored);db=restored;const run=maintenanceRun('database_restore','success',{reason:'explicit_restore',records:{users:db.users.length,trips:db.trips.length,passengers:db.passengers.length,baggage:db.baggage.length,expenses:db.expenses.length}},user);systemEvent('warning','database_restore','Databasen blev gendannet fra en krypteret backup',{runId:run.id});await saveDb();return run;
}
function userName(userId) { return userId ? db.users.find(user => user.id === userId)?.name || 'Ukendt medarbejder' : null; }
function userHasOperationalHistory(userId) {
  return db.trips.some(trip=>[trip.primaryDriverId,trip.secondaryDriverId,trip.salesManagerId,trip.cancelledBy,trip.closedBy,trip.reopenedBy].includes(userId))
    || db.passengers.some(passenger=>[passenger.createdBy,passenger.checkedInBy,passenger.paymentRecordedBy,passenger.externalPaymentConfirmedBy,passenger.cashHolderUserId].includes(userId)||(passenger.attendanceHistory||[]).some(event=>[event.userId,event.receivedBy].includes(userId))||(passenger.editHistory||[]).some(event=>event.editedBy===userId))
    || db.baggage.some(item=>[item.createdBy,item.paymentRecordedBy,item.externalPaymentConfirmedBy,item.cashHolderUserId,item.statusUpdatedBy].includes(userId)||(item.baggageHistory||[]).some(event=>event.userId===userId)||(item.editHistory||[]).some(event=>event.editedBy===userId))
    || db.expenses.some(expense=>[expense.createdBy,expense.paidByUserId,expense.cashBoxUserId,expense.reviewedBy,expense.reimbursedBy,expense.forwardedToSalesManagerId,expense.forwardedBy].includes(userId)||(expense.editHistory||[]).some(event=>event.editedBy===userId))
    || db.cashSettlements.some(settlement=>[settlement.driverId,settlement.submittedBy,settlement.reviewedBy].includes(userId))
    || db.cashTransfers.some(transfer=>[transfer.fromUserId||transfer.fromDriverId,transfer.toUserId||transfer.toDriverId,transfer.initiatedBy,transfer.respondedBy].includes(userId))
    || (db.cashBudgetEntries||[]).some(entry=>[entry.cashHolderUserId,entry.createdBy].includes(userId))
    || db.auditLog.some(event=>event.userId===userId);
}
function isFixedStartPoint(stop) { return ['københavn', 'tetovo'].includes(String(stop?.name || '').trim().toLocaleLowerCase('da-DK')); }
function editHistoryView(history) { return (history || []).map(event => ({ ...event, editedByName:userName(event.editedBy) })); }
function passengerRecordView(passenger) { const partyPrimary=passenger.partyPrimaryPassengerId?db.passengers.find(candidate=>candidate.id===passenger.partyPrimaryPassengerId):null;return { ...passenger, partyContactName:partyPrimary?.name||null,partyContactPhone:partyPrimary?.phone||null,availableCashAmount:cashAvailableAmount({kind:'passenger',record:passenger}), checkedInByName:userName(passenger.checkedInBy), paymentRecordedByName:userName(passenger.paymentRecordedBy), externalPaymentConfirmedByName:userName(passenger.externalPaymentConfirmedBy), cashHolderUserName:userName(passenger.cashHolderUserId), attendanceHistory:(passenger.attendanceHistory||[]).map(event=>({...event,userName:userName(event.userId),receivedByName:userName(event.receivedBy)})), editHistory:editHistoryView(passenger.editHistory) }; }
function baggageRecordView(item) { return { ...item, availableCashAmount:cashAvailableAmount({kind:'baggage',record:item}), createdByName:userName(item.createdBy), paymentRecordedByName:userName(item.paymentRecordedBy), externalPaymentConfirmedByName:userName(item.externalPaymentConfirmedBy), cashHolderUserName:userName(item.cashHolderUserId), statusUpdatedByName:userName(item.statusUpdatedBy), baggageHistory:(item.baggageHistory||[]).map(event=>({...event,userName:userName(event.userId)})), editHistory:editHistoryView(item.editHistory) }; }
function expenseRecordView(expense) { return { ...expense, createdByName:userName(expense.createdBy), paidByName:userName(expense.paidByUserId||expense.createdBy), reviewedByName:userName(expense.reviewedBy), reimbursedByName:userName(expense.reimbursedBy), forwardedToSalesManagerName:userName(expense.forwardedToSalesManagerId), editHistory:editHistoryView(expense.editHistory) }; }
function cashTransferView(transfer,viewer=null) {
  const fromUserId=transfer.fromUserId||transfer.fromDriverId,toUserId=transfer.toUserId||transfer.toDriverId;
  const sourcePaymentCount=(transfer.paymentRefs||[]).length,hideBudgetSources=['trip_budget','general_driver_budget'].includes(transfer.transferType)&&viewer?.role!=='admin';
  const safe={...transfer};if(hideBudgetSources)delete safe.cashTransferAllocations;
  return { ...safe,paymentRefs:hideBudgetSources?[]:(transfer.paymentRefs||[]),sourcePaymentCount,sourceDetailsRestricted:hideBudgetSources,fromUserId,toUserId,fromDriverId:fromUserId,toDriverId:toUserId,fromUserName:userName(fromUserId),toUserName:userName(toUserId),fromDriverName:userName(fromUserId),toDriverName:userName(toUserId),initiatedByName:userName(transfer.initiatedBy),respondedByName:userName(transfer.respondedBy) };
}
function isExternalPaymentConfirmed(record) { return ['pay_dk','pay_mk'].includes(record?.paymentStatus) && Boolean(record.externalPaymentConfirmedAt); }
function isPaidPayment(record) { return record?.paymentStatus === 'cash' || isExternalPaymentConfirmed(record); }
function isPendingPayment(record) { return ['unpaid','pay_dk','pay_mk'].includes(record?.paymentStatus) && !isExternalPaymentConfirmed(record); }
function recordedRevenueAmount(record) { return record?.paymentStatus === 'cash' ? Number(record.cashAmount || 0) : isExternalPaymentConfirmed(record) ? Number(record.externalPaymentAmount || 0) : 0; }
function recordedRevenueCurrency(record) { return record?.paymentStatus === 'cash' ? (record.paymentCurrency || 'DKK') : (record.externalPaymentCurrency || record.paymentCurrency || 'DKK'); }
function recordedRevenueAmounts(records) { return ['DKK','EUR'].reduce((totals,currency)=>{totals[currency]=records.filter(record=>isPaidPayment(record)&&recordedRevenueCurrency(record)===currency).reduce((sum,record)=>sum+recordedRevenueAmount(record),0);return totals;},{}); }
function nextBookingNumber(state=db,at=new Date()) {
  state.meta.nextBookingSequence=Math.max(0,Number(state.meta.nextBookingSequence||0))+1;
  return `ALB-${new Date(at).getUTCFullYear()}-${String(state.meta.nextBookingSequence).padStart(6,'0')}`;
}
function backfillBookingNumbers(state) {
  let maximum=Math.max(0,Number(state.meta.nextBookingSequence||0));
  for(const passenger of state.passengers||[]){const match=String(passenger.bookingNumber||'').match(/-(\d{6,})$/);if(match)maximum=Math.max(maximum,Number(match[1]));}
  state.meta.nextBookingSequence=maximum;
  const partyNumbers=new Map();
  for(const passenger of [...(state.passengers||[])].sort((left,right)=>left.id-right.id)){
    if(passenger.bookingNumber){if(passenger.partyBookingId)partyNumbers.set(passenger.partyBookingId,passenger.bookingNumber);continue;}
    const outbound=passenger.outboundPassengerId?(state.passengers||[]).find(candidate=>candidate.id===passenger.outboundPassengerId):null;
    passenger.bookingNumber=outbound?.bookingNumber||(passenger.partyBookingId&&partyNumbers.get(passenger.partyBookingId))||nextBookingNumber(state,passenger.paymentRecordedAt||passenger.createdAt||new Date());
    if(passenger.partyBookingId)partyNumbers.set(passenger.partyBookingId,passenger.bookingNumber);
  }
  for(const passenger of state.passengers||[])if(passenger.outboundPassengerId){const outbound=state.passengers.find(candidate=>candidate.id===passenger.outboundPassengerId);if(outbound)passenger.bookingNumber=outbound.bookingNumber;}
}
function appendAccountingEntryTo(state,data) {
  state.accountingEntries=state.accountingEntries||[];
  state.meta.nextAccountingSequence=Math.max(0,Number(state.meta.nextAccountingSequence||0))+1;
  const at=data.at||new Date().toISOString(),sequence=state.meta.nextAccountingSequence;
  const entry={id:sequence,postingNumber:`KAS-${new Date(at).getUTCFullYear()}-${String(sequence).padStart(6,'0')}`,at,kind:data.kind||'correction',source:data.source||null,sourceId:Number(data.sourceId)||null,tripId:Number(data.tripId)||null,description:String(data.description||''),actorUserId:Number(data.actorUserId)||null,status:data.status||'booked',currency:['DKK','EUR'].includes(data.currency)?data.currency:'DKK',amount:Math.abs(Number(data.amount||0)),signedAmount:Number(data.signedAmount||0),cashDelta:Number(data.cashDelta||0),holderUserId:Number(data.holderUserId)||null,holderType:data.holderType||((Number(data.holderUserId)||null)?'employee':null),counterpartyUserId:Number(data.counterpartyUserId)||null,reversalOf:Number(data.reversalOf)||null,note:String(data.note||'')};
  state.accountingEntries.push(entry);return entry;
}
function accountingSourceExists(state,source,sourceId,kind=null,direction=null) { return (state.accountingEntries||[]).some(entry=>entry.source===source&&entry.sourceId===Number(sourceId)&&(!kind||entry.kind===kind)&&(!direction||entry.direction===direction)); }
function backfillAccountingEntries(state) {
  state.meta.nextAccountingSequence=Math.max(0,Number(state.meta.nextAccountingSequence||0),...(state.accountingEntries||[]).map(entry=>Number(entry.id||0)));
  const paid=record=>record?.paymentStatus==='cash'||Boolean(record?.externalPaymentConfirmedAt),amount=record=>record?.paymentStatus==='cash'?Number(record.cashAmount||0):Number(record.externalPaymentAmount||0),currency=record=>record?.paymentStatus==='cash'?(record.paymentCurrency||'DKK'):(record.externalPaymentCurrency||record.paymentCurrency||'DKK');
  const candidates=[];
  for(const passenger of state.passengers||[])if(passenger.journeyLeg!=='return'&&paid(passenger))candidates.push({at:passenger.paymentRecordedAt||passenger.externalPaymentConfirmedAt||passenger.createdAt,kind:'revenue',source:'passenger',sourceId:passenger.id,tripId:passenger.tripId,description:`Billet · ${passenger.name}`,actorUserId:passenger.paymentRecordedBy||passenger.externalPaymentConfirmedBy||passenger.createdBy,currency:currency(passenger),amount:amount(passenger),signedAmount:amount(passenger),cashDelta:passenger.paymentStatus==='cash'?amount(passenger):0,holderUserId:passenger.cashHolderUserId||null,holderType:passenger.paymentStatus==='cash'&&!passenger.cashHolderUserId?'office':null});
  for(const item of state.baggage||[])if(paid(item))candidates.push({at:item.paymentRecordedAt||item.externalPaymentConfirmedAt||item.createdAt,kind:'revenue',source:'baggage',sourceId:item.id,tripId:item.tripId,description:`Bagage · ${item.senderName}`,actorUserId:item.paymentRecordedBy||item.externalPaymentConfirmedBy||item.createdBy,currency:currency(item),amount:amount(item),signedAmount:amount(item),cashDelta:item.paymentStatus==='cash'?amount(item):0,holderUserId:item.cashHolderUserId||null,holderType:item.paymentStatus==='cash'&&!item.cashHolderUserId?'office':null});
  for(const expense of state.expenses||[])if(expense.status==='approved')candidates.push({at:expense.reviewedAt||expense.createdAt,kind:'expense',source:'expense',sourceId:expense.id,tripId:expense.tripId,description:`${expense.category}${expense.description?` · ${expense.description}`:''}`,actorUserId:expense.reviewedBy||expense.createdBy,currency:expense.currency||'DKK',amount:Number(expense.amount||0),signedAmount:-Number(expense.amount||0),cashDelta:expense.paymentMethod==='cash'?-Number(expense.amount||0):0,holderUserId:expense.cashBoxUserId||null});
  candidates.sort((left,right)=>new Date(left.at||0)-new Date(right.at||0));for(const candidate of candidates)if(!accountingSourceExists(state,candidate.source,candidate.sourceId,candidate.kind))appendAccountingEntryTo(state,candidate);
  for(const transfer of (state.cashTransfers||[]).filter(item=>item.status==='accepted'))postTransferEntriesTo(state,transfer,transfer.respondedBy||transfer.initiatedBy,true);
  for(const settlement of (state.cashSettlements||[]).filter(item=>item.status==='approved'))postSettlementEntriesTo(state,settlement,settlement.reviewedBy||settlement.submittedBy,true);
}
function appendAccountingEntry(data){return appendAccountingEntryTo(db,data)}
function postRevenue(record,source,label,userId) {
  if(!isPaidPayment(record)||accountingSourceExists(db,source,record.id,'revenue'))return null;
  const amount=recordedRevenueAmount(record),isCash=record.paymentStatus==='cash';
  return appendAccountingEntry({at:record.paymentRecordedAt||record.externalPaymentConfirmedAt||new Date().toISOString(),kind:'revenue',source,sourceId:record.id,tripId:record.tripId,description:label,actorUserId:userId||record.paymentRecordedBy||record.externalPaymentConfirmedBy||record.createdBy,currency:recordedRevenueCurrency(record),amount,signedAmount:amount,cashDelta:isCash?amount:0,holderUserId:record.cashHolderUserId||null,holderType:isCash&&!record.cashHolderUserId?'office':null});
}
function postRevenueCorrection(record,source,label,user,oldAmount,oldCurrency,reason) {
  if(!isPaidPayment(record))return;
  const newAmount=recordedRevenueAmount(record),newCurrency=recordedRevenueCurrency(record),base={at:new Date().toISOString(),kind:'correction',source,sourceId:record.id,tripId:record.tripId,description:`Rettelse · ${label}`,actorUserId:user.id,note:reason,holderUserId:record.cashHolderUserId||null,holderType:record.paymentStatus==='cash'&&!record.cashHolderUserId?'office':null};
  if(oldCurrency!==newCurrency){if(oldAmount)appendAccountingEntry({...base,currency:oldCurrency,amount:oldAmount,signedAmount:-oldAmount,cashDelta:record.paymentStatus==='cash'?-oldAmount:0});if(newAmount)appendAccountingEntry({...base,currency:newCurrency,amount:newAmount,signedAmount:newAmount,cashDelta:record.paymentStatus==='cash'?newAmount:0});}
  else {const delta=newAmount-oldAmount;if(delta)appendAccountingEntry({...base,currency:newCurrency,amount:Math.abs(delta),signedAmount:delta,cashDelta:record.paymentStatus==='cash'?delta:0});}
}
function postRevenueReversal(record,source,label,user,reason) {if(!isPaidPayment(record))return null;const amount=recordedRevenueAmount(record);return appendAccountingEntry({at:new Date().toISOString(),kind:'correction',source,sourceId:record.id,tripId:record.tripId,description:`Annullering · ${label}`,actorUserId:user.id,currency:recordedRevenueCurrency(record),amount,signedAmount:-amount,cashDelta:record.paymentStatus==='cash'?-amount:0,holderUserId:record.cashHolderUserId||null,holderType:record.paymentStatus==='cash'&&!record.cashHolderUserId?'office':null,note:reason});}
function postExpense(expense,userId) { const amount=Number(expense.amount||0);return appendAccountingEntry({at:expense.reviewedAt||new Date().toISOString(),kind:'expense',source:'expense',sourceId:expense.id,tripId:expense.tripId,description:`${expense.category}${expense.description?` · ${expense.description}`:''}`,actorUserId:userId||expense.reviewedBy||expense.createdBy,currency:expense.currency||'DKK',amount,signedAmount:-amount,cashDelta:expense.paymentMethod==='cash'?-amount:0,holderUserId:expense.cashBoxUserId||null}); }
function postExpenseReversal(expense,user,reason) {const amount=Number(expense.amount||0);return appendAccountingEntry({at:new Date().toISOString(),kind:'correction',source:'expense',sourceId:expense.id,tripId:expense.tripId,description:`Tilbageførsel · ${expense.category}`,actorUserId:user.id,currency:expense.currency||'DKK',amount,signedAmount:amount,cashDelta:expense.paymentMethod==='cash'?amount:0,holderUserId:expense.cashBoxUserId||null,note:reason});}
function postTransferEntriesTo(state,transfer,userId,backfill=false) {for(const currency of ['DKK','EUR']){const amount=Number(transfer.totals?.[currency]||0);if(!amount)continue;for(const direction of ['out','in']){if(backfill&&(state.accountingEntries||[]).some(entry=>entry.source==='cash_transfer'&&entry.sourceId===transfer.id&&entry.note===direction&&entry.currency===currency))continue;appendAccountingEntryTo(state,{at:transfer.respondedAt||transfer.initiatedAt,kind:'transfer',source:'cash_transfer',sourceId:transfer.id,tripId:transfer.tripId,description:`Pengeoverførsel · ${direction==='out'?'afsendt':'modtaget'}`,actorUserId:userId,currency,amount,signedAmount:0,cashDelta:direction==='out'?-amount:amount,holderUserId:direction==='out'?(transfer.fromUserId||transfer.fromDriverId):(transfer.toUserId||transfer.toDriverId),counterpartyUserId:direction==='out'?(transfer.toUserId||transfer.toDriverId):(transfer.fromUserId||transfer.fromDriverId),note:direction});}}
}
function postCashTransfer(transfer,userId){return postTransferEntriesTo(db,transfer,userId,false)}
function postSettlementEntriesTo(state,settlement,userId,backfill=false) {for(const currency of ['DKK','EUR']){const amount=Number(settlement.delivered?.[currency]||0);if(!amount)continue;for(const direction of ['out','office']){if(backfill&&(state.accountingEntries||[]).some(entry=>entry.source==='cash_settlement'&&entry.sourceId===settlement.id&&entry.note===direction&&entry.currency===currency))continue;appendAccountingEntryTo(state,{at:settlement.reviewedAt||settlement.submittedAt,kind:'settlement',source:'cash_settlement',sourceId:settlement.id,tripId:settlement.tripId,description:direction==='out'?'Kontantafstemning · afleveret':'Kontantafstemning · modtaget på kontor',actorUserId:userId,currency,amount,signedAmount:0,cashDelta:direction==='out'?-amount:amount,holderUserId:direction==='out'?settlement.driverId:null,holderType:direction==='office'?'office':'employee',note:direction});}}
}
function postSettlement(settlement,userId){return postSettlementEntriesTo(db,settlement,userId,false)}
function normalizedPassengerName(value){return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('da-DK').replace(/[^a-z0-9]+/g,' ').trim()}
function normalizedPhone(value){return String(value||'').replace(/\D/g,'')}
function possiblePassengerDuplicates(tripId,{name,phone}) {const normalizedName=normalizedPassengerName(name),phoneDigits=normalizedPhone(phone);return db.passengers.filter(passenger=>passenger.tripId===Number(tripId)&&((normalizedName&&normalizedPassengerName(passenger.name)===normalizedName)||(phoneDigits.length>=6&&normalizedPhone(passenger.phone)===phoneDigits))).slice(0,8).map(passenger=>({id:passenger.id,bookingNumber:passenger.bookingNumber||null,name:passenger.name,phone:passenger.phone,seatNumber:passenger.seatNumber,pickupStopId:passenger.pickupStopId,destinationStopId:passenger.destinationStopId}));}
function clientActionReplay(data,user,kind) {
  const key=String(data?.clientActionId||'').trim();if(!key)return null;
  return db.clientActions.find(action=>action.key===key&&action.userId===user.id&&action.kind===kind)||null;
}
function rememberClientAction(data,user,kind,status,response) {
  const key=String(data?.clientActionId||'').trim();if(!key)return response;
  if(!db.clientActions.some(action=>action.key===key&&action.userId===user.id&&action.kind===kind))db.clientActions.push({key,userId:user.id,kind,status,response,processedAt:new Date().toISOString()});
  if(db.clientActions.length>2000)db.clientActions.splice(0,db.clientActions.length-2000);
  return response;
}
function copenhagenDateTime(value) {return value?new Date(value).toLocaleString('da-DK',{timeZone:'Europe/Copenhagen',dateStyle:'medium',timeStyle:'short'}):''}
function ticketPayment(passengers) {
  const primary=passengers.find(item=>item.partyRole==='primary'&&item.journeyLeg!=='return')||passengers.find(item=>item.journeyLeg!=='return')||passengers[0];
  if(!primary)return{paid:false,label:'Ingen betaling',amount:''};
  if(primary.paymentStatus==='free')return{paid:true,label:'Gratis billet',amount:primary.freeTicketReason||'Ingen betaling'};
  if(primary.paymentStatus==='cash')return{paid:true,label:primary.paymentLocation==='bus'?'Betalt i bussen':'Betalt kontant',amount:`${Number(primary.cashAmount||0).toLocaleString('da-DK',{minimumFractionDigits:2})} ${primary.paymentCurrency||'DKK'}`};
  if(primary.paymentStatus==='return_included'||primary.paymentStatus==='group_included')return{paid:true,label:'Betaling inkluderet',amount:'Dækket af hovedbookingen'};
  if(['pay_dk','pay_mk'].includes(primary.paymentStatus)&&primary.externalPaymentConfirmedAt)return{paid:true,label:`Betalt i ${primary.paymentStatus==='pay_mk'?'MK':'DK'}`,amount:`${Number(primary.externalPaymentAmount||0).toLocaleString('da-DK',{minimumFractionDigits:2})} ${primary.externalPaymentCurrency||primary.paymentCurrency||'DKK'}`};
  return{paid:false,label:primary.paymentStatus==='pay_mk'?'Betaler i MK':primary.paymentStatus==='pay_dk'?'Betaler i DK':'Ikke betalt',amount:'Betaling afventer'};
}
function ticketDocumentData(bookingNumber,passengers,user,reprint=false,qrPayload='') {
  const primary=passengers.find(item=>item.partyRole==='primary'&&item.journeyLeg!=='return')||passengers.find(item=>item.journeyLeg!=='return')||passengers[0],journeys=[];
  const tripIds=[...new Set(passengers.map(item=>item.tripId))];
  for(const tripId of tripIds){const trip=db.trips.find(item=>item.id===tripId),records=passengers.filter(item=>item.tripId===tripId);if(!trip)continue;const sample=records[0],pickup=db.stops.find(item=>item.id===sample.pickupStopId),destination=db.stops.find(item=>item.id===sample.destinationStopId);journeys.push({legLabel:sample.journeyLeg==='return'?'RETURREJSE':'UDREJSE',from:pickup?.name||trip.origin?.name||'Ukendt',to:destination?.name||trip.destination?.name||'Ukendt',departure:copenhagenDateTime(trip.departureAt),arrival:copenhagenDateTime(trip.destinationArrivalAt),seat:records.map(item=>item.seatNumber).join(', '),extraSeat:records.map(item=>item.extraSeatNumber).filter(Boolean).join(', '),tripTitle:trip.title});}
  const outbound=passengers.filter(item=>item.journeyLeg!=='return');
  return{bookingNumber,contactName:primary?.partyContactName||primary?.name||'Passager',contactPhone:primary?.partyContactPhone||primary?.phone||'',payment:ticketPayment(passengers),journeys,passengers:outbound.map(item=>({name:item.name,seats:`Sæde ${item.seatNumber}${item.extraSeatNumber?` + ${item.extraSeatNumber}`:''}`})),note:primary?.ticketType==='return_open'?`Åben returbillet gyldig til ${copenhagenDateTime(primary.openReturnValidUntil)}. Returrejsen skal reserveres før afgang.`:'Billetten er personlig. Vis QR-koden ved check-in.',generatedAt:copenhagenDateTime(new Date()),generatedBy:user.name,reprint,qrPayload};
}
const DEPARTURE_CHECKLIST_ITEMS = {
  vehicle_ready:{roles:['admin','driver']},
  route_documents:{roles:['admin','driver']},
  passenger_list:{roles:['admin','driver','sales_manager']},
  baggage_secured:{roles:['admin','driver']},
  cash_budget:{roles:['admin','driver','sales_manager']}
};
const CHECK_IN_OPEN_LEAD_MS = 60*60*1000;
function scheduledCheckInOpenAt(trip) {
  const departureAt=new Date(trip.departureAt);
  return Number.isNaN(departureAt.getTime())?null:new Date(departureAt.getTime()-CHECK_IN_OPEN_LEAD_MS);
}
function departureChecklistComplete(trip) {
  const entries=trip.departureChecklist||{};
  return Object.keys(DEPARTURE_CHECKLIST_ITEMS).every(key=>entries[key]?.checked);
}
function tripOperationalPhase(trip) {
  if(trip.status==='cancelled')return'cancelled';
  if(trip.status==='completed')return'completed';
  if(trip.arrivedAt&&trip.passengerListClosedAt)return'finance_pending';
  if(trip.arrivedAt)return'arrived';
  if(trip.startedAt)return'underway';
  if(trip.boardingStartedAt)return'boarding';
  if(departureChecklistComplete(trip))return'ready';
  return'planned';
}
async function applyAutomaticBoardingOpenings(now=new Date()) {
  const recordedAt=now instanceof Date?now:new Date(now);
  if(Number.isNaN(recordedAt.getTime()))return[];
  const dueTrips=db.trips.filter(trip=>{
    const checkInOpenAt=scheduledCheckInOpenAt(trip);
    return trip.status==='planned'&&!trip.boardingStartedAt&&checkInOpenAt&&checkInOpenAt.getTime()<=recordedAt.getTime();
  });
  if(!dueTrips.length)return[];
  for(const trip of dueTrips){
    const checkInOpenAt=scheduledCheckInOpenAt(trip).toISOString();
    trip.boardingStartedAt=checkInOpenAt;trip.boardingStartedBy=null;trip.boardingSource='schedule';trip.automaticBoardingRecordedAt=recordedAt.toISOString();
    trip.lifecycleHistory=trip.lifecycleHistory||[];trip.lifecycleHistory.push({action:'open_check_in_automatically',at:recordedAt.toISOString(),effectiveAt:checkInOpenAt,userId:null,note:'Check-in åbnet automatisk én time før planlagt afgang'});
    audit(null,'trip.boarding_opened_automatically','trip',trip.id,trip.id,{scheduledCheckInOpenAt:checkInOpenAt,scheduledDepartureAt:new Date(trip.departureAt).toISOString(),recordedAt:recordedAt.toISOString()});
  }
  await saveDb();
  return dueTrips.map(trip=>trip.id);
}
async function applyAutomaticTripStarts(now=new Date()) {
  const recordedAt=now instanceof Date?now:new Date(now);
  if(Number.isNaN(recordedAt.getTime()))return[];
  const dueTrips=db.trips.filter(trip=>{
    const scheduledDeparture=new Date(trip.departureAt);
    return trip.status==='planned'&&!trip.startedAt&&!Number.isNaN(scheduledDeparture.getTime())&&scheduledDeparture.getTime()<=recordedAt.getTime();
  });
  if(!dueTrips.length)return[];
  for(const trip of dueTrips){
    const scheduledDeparture=new Date(trip.departureAt).toISOString(),boardingOpenedAutomatically=!trip.boardingStartedAt;
    if(boardingOpenedAutomatically){trip.boardingStartedAt=scheduledCheckInOpenAt(trip)?.toISOString()||scheduledDeparture;trip.boardingStartedBy=null;trip.boardingSource='schedule';trip.automaticBoardingRecordedAt=recordedAt.toISOString()}
    trip.startedAt=scheduledDeparture;trip.startedBy=null;trip.startSource='schedule';trip.automaticStartRecordedAt=recordedAt.toISOString();
    trip.lifecycleHistory=trip.lifecycleHistory||[];trip.lifecycleHistory.push({action:'start_trip_automatically',at:recordedAt.toISOString(),effectiveAt:scheduledDeparture,userId:null,note:'Planlagt afgangstid nået',boardingOpenedAutomatically});
    audit(null,'trip.started_automatically','trip',trip.id,trip.id,{scheduledDepartureAt:scheduledDeparture,recordedAt:recordedAt.toISOString(),boardingOpenedAutomatically});
  }
  await saveDb();
  return dueTrips.map(trip=>trip.id);
}
async function applyAutomaticTripArrivals(now=new Date()) {
  const recordedAt=now instanceof Date?now:new Date(now);
  if(Number.isNaN(recordedAt.getTime()))return[];
  const dueTrips=db.trips.filter(trip=>{
    const scheduledArrival=new Date(trip.destinationArrivalAt);
    return trip.status==='planned'&&trip.startedAt&&!trip.arrivedAt&&!Number.isNaN(scheduledArrival.getTime())&&scheduledArrival.getTime()<=recordedAt.getTime();
  });
  if(!dueTrips.length)return[];
  for(const trip of dueTrips){
    const scheduledArrival=new Date(trip.destinationArrivalAt).toISOString();
    trip.arrivedAt=scheduledArrival;trip.arrivedBy=null;trip.arrivalSource='schedule';trip.automaticArrivalRecordedAt=recordedAt.toISOString();
    trip.lifecycleHistory=trip.lifecycleHistory||[];trip.lifecycleHistory.push({action:'mark_arrived_automatically',at:recordedAt.toISOString(),effectiveAt:scheduledArrival,userId:null,note:'Planlagt ankomsttid nået'});
    audit(null,'trip.arrived_automatically','trip',trip.id,trip.id,{scheduledArrivalAt:scheduledArrival,recordedAt:recordedAt.toISOString()});
  }
  await saveDb();
  return dueTrips.map(trip=>trip.id);
}
async function applyAutomaticTripLifecycle(now=new Date()) {
  const recordedAt=now instanceof Date?now:new Date(now);
  const boardingOpened=await applyAutomaticBoardingOpenings(recordedAt),started=await applyAutomaticTripStarts(recordedAt),arrived=await applyAutomaticTripArrivals(recordedAt);
  return{boardingOpened,started,arrived};
}
function departureChecklistView(trip) {
  const entries=trip.departureChecklist||{};
  return Object.fromEntries(Object.keys(DEPARTURE_CHECKLIST_ITEMS).map(key=>{const entry=entries[key];return[key,entry?{...entry,checkedByName:userName(entry.checkedBy)}:null]}));
}
function tripActionItems(trip,user) {
  const items=[],phase=tripOperationalPhase(trip),passengers=db.passengers.filter(item=>item.tripId===trip.id),baggage=db.baggage.filter(item=>item.tripId===trip.id),expenses=db.expenses.filter(item=>item.tripId===trip.id),hoursUntil=(new Date(trip.departureAt).getTime()-Date.now())/3600000;
  const add=(key,severity,title,message,target,count)=>items.push({id:`${trip.id}:${key}`,tripId:trip.id,tripTitle:trip.title,departureAt:trip.departureAt,key,severity,title,message,target,count:Number(count||0)});
  const pendingPassengers=passengers.filter(item=>!item.checkedIn&&item.attendanceStatus!=='no_show');
  const openBaggage=baggage.filter(item=>!['delivered','unclaimed'].includes(item.status));
  const missingReceipts=expenses.filter(item=>!item.receiptFile);
  const pendingExpenses=expenses.filter(item=>(item.status||'pending')==='pending');
  const pendingTransfers=db.cashTransfers.filter(item=>item.tripId===trip.id&&item.status==='pending');
  const pendingSettlements=db.cashSettlements.filter(item=>item.tripId===trip.id&&item.status==='pending');
  const heldCash=cashBoxes(trip.id);
  const checklistMissing=Object.keys(DEPARTURE_CHECKLIST_ITEMS).filter(key=>!trip.departureChecklist?.[key]?.checked);
  if(!['completed','cancelled'].includes(phase)&&hoursUntil<=24&&checklistMissing.length)add('departure',hoursUntil<=2?'critical':'warning','Afgangskontrol mangler',`${checklistMissing.length} kontrolpunkter skal gennemføres`,'departure',checklistMissing.length);
  if(['boarding','underway','arrived'].includes(phase)&&pendingPassengers.length)add('passengers',phase==='arrived'?'critical':'warning','Passagerer mangler status',`${pendingPassengers.length} skal checkes ind eller markeres udeblevet`,'checkin',pendingPassengers.length);
  if(phase==='arrived'&&!trip.passengerListClosedAt)add('passenger-close','critical','Passagerlisten er ikke afsluttet','En tildelt chauffør skal kontrollere og afslutte listen','checkin',1);
  if(['arrived','finance_pending'].includes(phase)&&openBaggage.length)add('baggage','warning','Bagage er ikke afsluttet',`${openBaggage.length} forsendelser mangler udleveret eller ikke afhentet`,'baggage',openBaggage.length);
  if(missingReceipts.length)add('receipts','warning','Kvitteringer mangler',`${missingReceipts.length} udgifter mangler dokumentation`,'expenses',missingReceipts.length);
  if(user.role==='admin'&&pendingExpenses.length)add('expense-approval','warning','Udgifter afventer',`${pendingExpenses.length} udgifter kræver behandling`,'expenses',pendingExpenses.length);
  if(['arrived','finance_pending','completed'].includes(phase)&&pendingTransfers.length)add('transfers','warning','Pengeoverførsler afventer',`${pendingTransfers.length} overførsler mangler svar`,'settlements',pendingTransfers.length);
  if(['arrived','finance_pending','completed'].includes(phase)&&pendingSettlements.length)add('settlements','warning','Kontantafstemninger afventer',`${pendingSettlements.length} afstemninger mangler godkendelse`,'settlements',pendingSettlements.length);
  if(['arrived','finance_pending','completed'].includes(phase)&&heldCash.length)add('cash','warning','Kontanter står i personlig pengekasse',`Afregning afventer hos ${heldCash.map(box=>box.holderName).join(', ')}`,'settlements',heldCash.length);
  return items;
}
function operationalAlerts(user) {
  const alerts=[],add=(id,severity,title,message,target='operations',count=1)=>alerts.push({id,severity,title,message,target,count:Number(count||1)}),now=Date.now();
  if(user.role==='admin'){
    const backups=(db.maintenanceRuns||[]).filter(run=>run.type==='database_backup'&&run.status==='success'),latest=backups.at(-1),age=latest?now-new Date(latest.finishedAt).getTime():Infinity;
    if(!backupKey()||!R2_CONFIGURED)add('backup-config','critical','Backup er ikke fuldt konfigureret','Kontrollér R2 og BACKUP_ENCRYPTION_KEY');
    else if(age>36*60*60*1000)add('backup-old','critical','Databasebackup er for gammel',latest?`Seneste backup: ${copenhagenDateTime(latest.finishedAt)}`:'Der er endnu ikke registreret en backup');
    else if(age>26*60*60*1000)add('backup-due','warning','Databasebackup bør køre snart',`Seneste backup: ${copenhagenDateTime(latest.finishedAt)}`);
    if(lastFileStorageError)add('file-storage','critical','Fillagringen har meldt en fejl',lastFileStorageError.message);
  }
  const visibleTrips=db.trips.filter(trip=>allowedTrip(user,trip)),tripIds=new Set(visibleTrips.map(trip=>trip.id));
  const missingReceipts=db.expenses.filter(expense=>tripIds.has(expense.tripId)&&expense.status!=='rejected'&&!expense.receiptFile&&(user.role==='admin'||expense.createdBy===user.id));
  if(missingReceipts.length)add('missing-receipts','warning','Udgifter mangler kvittering',`${missingReceipts.length} udgifter mangler billed- eller PDF-dokumentation`,'expenses',missingReceipts.length);
  const cashDifferences=db.cashSettlements.filter(item=>tripIds.has(item.tripId)&&item.status==='pending'&&(Math.abs(Number(item.difference?.DKK||0))>.009||Math.abs(Number(item.difference?.EUR||0))>.009));
  if(cashDifferences.length)add('cash-differences','critical','Kontantdifferencer kræver kontrol',`${cashDifferences.length} afstemninger stemmer ikke`,'settlements',cashDifferences.length);
  const unresolvedBaggage=db.baggage.filter(item=>{const trip=db.trips.find(candidate=>candidate.id===item.tripId);return tripIds.has(item.tripId)&&trip&&['arrived','finance_pending','completed'].includes(tripOperationalPhase(trip))&&!['delivered','unclaimed'].includes(item.status)});
  if(unresolvedBaggage.length)add('unresolved-baggage','critical','Bagage er ikke afsluttet',`${unresolvedBaggage.length} forsendelser mangler udlevering eller ikke-afhentet-status`,'baggage',unresolvedBaggage.length);
  const offline=db.offlineClients.filter(client=>(user.role==='admin'||client.userId===user.id)&&(Number(client.pendingCount)>0||Number(client.conflictCount)>0)&&now-new Date(client.lastSeenAt).getTime()<7*86400000);
  const pending=offline.reduce((sum,item)=>sum+Number(item.pendingCount||0),0),conflicts=offline.reduce((sum,item)=>sum+Number(item.conflictCount||0),0);
  if(pending||conflicts)add('offline-actions',conflicts?'critical':'warning','Offlinehandlinger mangler synkronisering',`${pending} afventer${conflicts?` · ${conflicts} konflikter kræver kontrol`:''}`,'operations',pending+conflicts);
  return alerts;
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => x.trim().split('=').map(decodeURIComponent)));
}
function auth(req) {
  const sid = cookies(req).sid;
  const session = sid && db.sessions.find(candidate => candidate.id === sid && candidate.expiresAt > Date.now());
  return session && db.users.find(u => u.id === session.userId);
}
function sessionCookie(sid, maxAgeSeconds) {
  const secure = IS_PRODUCTION ? '; Secure' : '';
  const maxAge = Number.isFinite(maxAgeSeconds) ? `; Max-Age=${Math.max(0,Math.floor(maxAgeSeconds))}` : '';
  return `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/${maxAge}${secure}`;
}
function requestIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'ukendt';
}
function maskedIp(req) {
  const value=requestIp(req);if(value.includes(':'))return `${value.split(':').slice(0,4).join(':')}::`;const parts=value.split('.');return parts.length===4?`${parts[0]}.${parts[1]}.${parts[2]}.x`:'ukendt';
}
function recordSecurityEvent(req,type,{email=null,userId=null,details={}}={}) {
  if(!db)return null;const event={id:id(),at:new Date().toISOString(),type,email:email?String(email).trim().toLowerCase():null,userId:userId||null,ip:maskedIp(req),userAgent:String(req.headers['user-agent']||'Ukendt enhed').slice(0,240),details};db.securityEvents.push(event);if(db.securityEvents.length>500)db.securityEvents.splice(0,db.securityEvents.length-500);return event;
}
function loginAllowed(req) {
  const key = requestIp(req), now = Date.now(), windowMs = 15 * 60 * 1000;
  const attempts = (loginAttempts.get(key) || []).filter(time => now - time < windowMs);
  loginAttempts.set(key, attempts);
  return attempts.length < 10;
}
function recordFailedLogin(req) {
  const key = requestIp(req), attempts = loginAttempts.get(key) || [];
  attempts.push(Date.now()); loginAttempts.set(key, attempts);
}
function expectedOrigin(req) {
  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const protocol = forwarded || (req.socket.encrypted ? 'https' : 'http');
  return `${protocol}://${req.headers.host}`;
}
function ticketToken(bookingNumber) {
  const payload=Buffer.from(String(bookingNumber),'utf8').toString('base64url');
  const signature=hmac(db.settings.ticketSigningSecret,payload).subarray(0,18).toString('base64url');
  return `${payload}.${signature}`;
}
function bookingFromTicketToken(token) {
  const [payload,signature,...rest]=String(token||'').split('.');
  if(!payload||!signature||rest.length)return null;
  const expected=hmac(db.settings.ticketSigningSecret,payload).subarray(0,18);
  let supplied;try{supplied=Buffer.from(signature,'base64url')}catch(_){return null}
  if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return null;
  let bookingNumber;try{bookingNumber=Buffer.from(payload,'base64url').toString('utf8')}catch(_){return null}
  return /^ALB-\d{4}-\d{6}$/.test(bookingNumber)?bookingNumber:null;
}
function html(value) {return String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));}
function publicTicketPage(req,token) {
  const bookingNumber=bookingFromTicketToken(token),passengers=bookingNumber?db.passengers.filter(item=>item.bookingNumber===bookingNumber):[];
  if(!passengers.length)return null;
  const ticket=ticketDocumentData(bookingNumber,passengers,{name:'BusOps'},false),journey=ticket.journeys[0]||{},returnJourney=ticket.journeys[1]||null,url=`${expectedOrigin(req)}/ticket/${encodeURIComponent(token)}`,paid=ticket.payment.paid;
  const passengerSummary=ticket.passengers.map(item=>`<li><span>${html(item.name)}</span><b>${html(item.seats)}</b></li>`).join('');
  const returnCard=returnJourney?`<section class="return"><span>RETURREJSE</span><div><b>${html(returnJourney.from||'-')} → ${html(returnJourney.to||'-')}</b><small>${html(returnJourney.departure||'Åben returdato')}</small></div><strong>Sæde ${html(returnJourney.seat||'-')}</strong></section>`:'';
  return `<!doctype html>
<html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#191919"><meta name="apple-mobile-web-app-capable" content="yes"><title>${html(bookingNumber)} · Alba Turist</title><style>
*{box-sizing:border-box}body{margin:0;padding:28px 14px 44px;background:#f1f0ed;color:#171717;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}.ticket{width:min(100%,440px);margin:auto;overflow:hidden;border:1px solid #deddd8;border-radius:30px;background:#fff;box-shadow:0 26px 80px #1d1d1b20}.brand{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:20px 22px;background:#fff}.brand img{display:block;width:172px;height:auto}.brand span{padding:7px 10px;border:1px solid #e0dfda;border-radius:999px;color:#555550;font-size:8px;font-weight:850;letter-spacing:.14em;white-space:nowrap}.journey{margin:0 10px;padding:24px 18px 19px;border-radius:22px;background:radial-gradient(circle at 92% 0,#3d3d39 0,transparent 37%),linear-gradient(145deg,#151515,#242422);color:#fff}.route{display:grid;grid-template-columns:minmax(0,1fr) 72px minmax(0,1fr);align-items:end;gap:8px}.place{min-width:0}.place:last-child{text-align:right}.place small,.detail small,.identity small,.passengers>small,.qr-copy small{display:block;color:#999993;font-size:8px;font-weight:850;letter-spacing:.13em}.place strong{display:block;overflow:hidden;margin-top:5px;font-size:26px;line-height:1.05;letter-spacing:-.045em;text-overflow:ellipsis;white-space:nowrap}.route-line{display:grid;grid-template-columns:7px 1fr 7px;align-items:center;margin-bottom:8px}.route-line:before,.route-line:after{content:"";width:7px;height:7px;border:2px solid #fff;border-radius:50%}.route-line i{height:1px;background:#777773;position:relative}.route-line i:after{content:"";position:absolute;right:0;top:-3px;border-left:5px solid #fff;border-top:3.5px solid transparent;border-bottom:3.5px solid transparent}.details{display:grid;grid-template-columns:1fr 1fr 74px;gap:8px;margin-top:22px;padding-top:17px;border-top:1px solid #ffffff20}.detail{min-width:0}.detail:nth-child(2){padding-left:11px;border-left:1px solid #ffffff20}.detail:last-child{padding:0 0 0 13px;border-left:1px solid #ffffff20}.detail b{display:block;overflow:hidden;margin-top:5px;color:#fff;font-size:11px;line-height:1.35;text-overflow:ellipsis}.detail:last-child b{font-size:23px;line-height:1}.content{padding:20px 22px 0}.identity{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding-bottom:17px;border-bottom:1px solid #ecebe7}.identity strong{display:block;overflow:hidden;margin-top:5px;font-size:17px;letter-spacing:-.02em;text-overflow:ellipsis;white-space:nowrap}.identity>div:last-child{text-align:right}.identity>div:last-child b{display:block;margin-top:5px;font-size:10px;letter-spacing:.04em}.payment{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:15px;padding:11px 13px;border-radius:12px;background:${paid?'#edf8f3':'#fff6e6'};color:${paid?'#087653':'#82590b'}}.payment div{display:flex;align-items:center;gap:8px;min-width:0}.payment i{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:${paid?'#0b8b63':'#d8961d'};color:#fff;font-size:12px;font-style:normal;font-weight:900}.payment b{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.payment span{font-size:8px;font-weight:900;letter-spacing:.1em}.return{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:11px;margin-top:14px;padding:12px 13px;border:1px solid #e5e2f5;border-radius:12px;background:#f7f5ff}.return>span{color:#6855a5;font-size:7px;font-weight:900;letter-spacing:.1em}.return div{display:grid;gap:2px}.return b{font-size:10px}.return small{color:#796f91;font-size:8px}.return>strong{color:#6855a5;font-size:9px}.passengers{margin-top:18px}.passengers ul{margin:6px 0 0;padding:0;list-style:none}.passengers li{display:flex;justify-content:space-between;gap:15px;padding:9px 0;border-bottom:1px solid #efeee9;font-size:11px}.passengers li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.passengers li b{font-size:10px;white-space:nowrap}.tear{position:relative;margin:20px -22px 0;border-top:1px dashed #d8d6d0}.tear:before,.tear:after{content:"";position:absolute;top:-12px;width:22px;height:22px;border-radius:50%;background:#f1f0ed}.tear:before{left:-11px}.tear:after{right:-11px}.scan{display:grid;grid-template-columns:152px 1fr;gap:19px;align-items:center;padding:23px 0 22px}.qr{display:grid;place-items:center;padding:9px;border:1px solid #deddd7;border-radius:16px;background:#fff;box-shadow:0 8px 25px #1717170d}.qr svg{display:block;width:132px;height:132px}.qr-copy{display:grid;align-content:center}.qr-copy strong{margin-top:6px;font-size:18px;line-height:1.08;letter-spacing:-.025em}.qr-copy p{margin:8px 0 0;color:#65655f;font-size:9px;line-height:1.5}.qr-copy b{margin-top:12px;color:#44443f;font-size:8px;letter-spacing:.06em}.footer{display:flex;justify-content:space-between;gap:12px;padding:14px 22px 18px;border-top:1px solid #eeede9;background:#fafaf8;color:#777770;font-size:8px}.footer b{color:#30302d}.security{max-width:390px;margin:13px auto 0;color:#777770;font-size:9px;line-height:1.5;text-align:center}@media(max-width:390px){body{padding:8px 8px 30px}.ticket{border-radius:23px}.brand{padding:16px}.brand img{width:148px}.journey{margin:0 7px;padding:20px 15px 17px}.place strong{font-size:22px}.route{grid-template-columns:minmax(0,1fr) 55px minmax(0,1fr)}.content{padding:17px 17px 0}.tear{margin-left:-17px;margin-right:-17px}.scan{grid-template-columns:128px 1fr;gap:14px}.qr svg{width:110px;height:110px}.qr-copy strong{font-size:16px}.details{grid-template-columns:1fr 1fr 62px}.detail:last-child{padding-left:9px}}
</style></head><body><main class="ticket"><header class="brand"><img src="/assets/alba-turist-logo.jpg" alt="Alba Turist"><span>DIGITAL REJSEBILLET</span></header><section class="journey"><div class="route"><div class="place"><small>FRA</small><strong>${html(journey.from||'Afgang')}</strong></div><div class="route-line" aria-hidden="true"><i></i></div><div class="place"><small>TIL</small><strong>${html(journey.to||'Destination')}</strong></div></div><div class="details"><div class="detail"><small>AFGANG</small><b>${html(journey.departure||'-')}</b></div><div class="detail"><small>ANKOMST</small><b>${html(journey.arrival||'-')}</b></div><div class="detail"><small>SÆDE</small><b>${html(journey.seat||'-')}</b></div></div></section><section class="content"><div class="identity"><div><small>PASSAGER</small><strong>${html(ticket.contactName)}</strong></div><div><small>BOOKING</small><b>${html(bookingNumber)}</b></div></div><div class="payment"><div><i>${paid?'✓':'!'}</i><b>${html(ticket.payment.label)}</b></div><span>${paid?'BETALT':'AFVENTER'}</span></div>${returnCard}<div class="passengers"><small>REJSENDE I BOOKINGEN</small><ul>${passengerSummary}</ul></div><div class="tear"></div><div class="scan"><div class="qr">${qrSvg(url,{scale:4})}</div><div class="qr-copy"><small>Scan ved check-in</small><strong>Vis koden til chaufføren</strong><p>Koden åbner kun denne booking og indeholder ingen personoplysninger.</p><b>${html(bookingNumber)}</b></div></div></section><footer class="footer"><span>Alba Turist · Sikker digital billet</span><b>busops.albaturist.dk</b></footer></main><p class="security">Opbevar billetten sikkert. Enhver med adgang til QR-koden kan vise den ved check-in.</p></body></html>`;
}
function validRequestOrigin(req) {
  if (!IS_PRODUCTION || ['GET','HEAD','OPTIONS'].includes(req.method)) return true;
  const origin = String(req.headers.origin || '');
  const extras = String(process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  return Boolean(origin) && [expectedOrigin(req), ...extras].includes(origin);
}
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
function assignedDriver(user,trip){return user.role==='driver'&&[trip.primaryDriverId,trip.secondaryDriverId].includes(user.id)}
function salesManagerOnDuty(user,trip){return user.role==='sales_manager'&&trip.salesManagerId===user.id}
function allowedTrip(user, trip) { return user.role === 'admin' || user.role === 'sales_manager' || assignedDriver(user,trip); }
function canOperateTrip(user,trip){return user.role==='admin'||assignedDriver(user,trip)||salesManagerOnDuty(user,trip)}
function cashSaleLocation(user,trip,requestedLocation=null){
  if(user.role==='driver')return'bus';
  if(user.role==='sales_manager')return salesManagerOnDuty(user,trip)&&requestedLocation==='departure'?'departure':'shop';
  return['bus','shop'].includes(requestedLocation)?requestedLocation:'shop';
}
function salesSnapshot(user){return user.role==='sales_manager'?{salesOfficeName:String(user.salesOfficeName||''),salesOfficeCountry:String(user.salesOfficeCountry||'')}:{}}
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function fail(res, status, message) { json(res, status, { error: message }); }
function failDetails(res, status, message, details) { json(res, status, { error:message, ...details }); }
async function body(req) {
  let raw = '', receivedBytes = 0;
  for await (const chunk of req) {
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_JSON_BODY_BYTES) throw Object.assign(new Error('For meget data'),{statusCode:413});
    raw += chunk;
  }
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { throw Object.assign(new Error('Ugyldig JSON'),{statusCode:400}); }
}
function tripView(t) {
  const passengers = db.passengers.filter(p => p.tripId === t.id);
  const baggage = db.baggage.filter(b => b.tripId === t.id);
  const expenses = db.expenses.filter(expense=>expense.tripId===t.id);
  const unsettledCash = allCashItems().filter(item=>item.record.tripId===t.id&&item.record.paymentStatus==='cash'&&['bus','departure','shop','budget'].includes(item.record.paymentLocation)&&item.record.cashHolderUserId&&!item.record.cashHandedOverAt);
  return { ...t,checkInOpensAt:scheduledCheckInOpenAt(t)?.toISOString()||null,
    origin: db.stops.find(s => s.id === t.originId), destination: db.stops.find(s => s.id === t.destinationId),
    bus: db.buses.find(b => b.id === t.busId) || null,
    primaryDriver: db.users.find(u => u.id === t.primaryDriverId)?.name || null,
    secondaryDriver: db.users.find(u => u.id === t.secondaryDriverId)?.name || null,
    salesManager: db.users.find(u => u.id === t.salesManagerId)?.name || null,
    salesManagerOnDutyId:t.salesManagerId||null,salesManagerOnDuty:db.users.find(u=>u.id===t.salesManagerId)?.name||null,
    cancelledByName: userName(t.cancelledBy), closedByName:userName(t.closedBy), reopenedByName:userName(t.reopenedBy), passengerListClosedByName:userName(t.passengerListClosedBy), boardingStartedByName:userName(t.boardingStartedBy), startedByName:userName(t.startedBy), arrivedByName:userName(t.arrivedBy), operationalPhase:tripOperationalPhase(t), departureChecklist:departureChecklistView(t),
    counts: { passengers: passengers.length, checkedIn: passengers.filter(p => p.checkedIn).length, baggage: baggage.length, onboard: baggage.filter(b => b.status === 'onboard').length, unpaid: [...passengers,...baggage].filter(isPendingPayment).length, pendingExpenses:expenses.filter(expense=>(expense.status||'pending')==='pending').length, missingReceipts:expenses.filter(expense=>!expense.receiptFile).length, unsettledCash:unsettledCash.length }
  };
}
function audit(user, action, entityType, entityId, tripId = null, details = {}) {
  const event = { id:id(),at:new Date().toISOString(),userId:user?.id||null,userName:user?.name||'System',role:user?.role||'system',action,entityType,entityId:Number(entityId)||entityId||null,tripId:Number(tripId)||null,details };
  db.auditLog.push(event); return event;
}
function financialLedger() {
  if (Array.isArray(db.accountingEntries)) return db.accountingEntries.map(entry=>{const trip=db.trips.find(item=>item.id===entry.tripId);return{...entry,tripTitle:trip?.title||'Uden tur',departureAt:trip?.departureAt||null,actorName:userName(entry.actorUserId)||'System',holderName:entry.holderType==='office'?'Kontor':userName(entry.holderUserId),counterpartyName:userName(entry.counterpartyUserId)};}).sort((left,right)=>new Date(right.at||0)-new Date(left.at||0)||right.id-left.id);
  const createdAt=(entityType,entityId,fallback)=>fallback||db.auditLog.find(event=>event.entityType===entityType&&event.entityId===entityId&&event.action.endsWith('.created'))?.at||null;
  const tripInfo=tripId=>{const trip=db.trips.find(item=>item.id===tripId);return{tripId:tripId||null,tripTitle:trip?.title||'Uden tur',departureAt:trip?.departureAt||null}};
  const revenue=(record,source,label)=>({
    id:`${source}:${record.id}`,kind:'revenue',source,sourceId:record.id,...tripInfo(record.tripId),
    at:record.paymentRecordedAt||record.externalPaymentConfirmedAt||createdAt(source,record.id,null),
    description:label,actorName:userName(record.paymentRecordedBy||record.externalPaymentConfirmedBy||record.createdBy),
    status:'booked',currency:recordedRevenueCurrency(record),amount:recordedRevenueAmount(record),signedAmount:recordedRevenueAmount(record)
  });
  const entries=[
    ...db.passengers.filter(record=>record.journeyLeg!=='return'&&isPaidPayment(record)).map(record=>revenue(record,'passenger',`Billet · ${record.name}`)),
    ...db.baggage.filter(isPaidPayment).map(record=>revenue(record,'baggage',`Bagage · ${record.senderName}`)),
    ...db.expenses.filter(record=>record.status==='approved').map(record=>({id:`expense:${record.id}`,kind:'expense',source:'expense',sourceId:record.id,...tripInfo(record.tripId),at:record.reviewedAt||record.createdAt,description:`${record.category}${record.description?` · ${record.description}`:''}`,actorName:userName(record.reviewedBy||record.createdBy),status:'approved',currency:record.currency||'DKK',amount:Number(record.amount||0),signedAmount:-Number(record.amount||0)})),
    ...db.cashTransfers.filter(record=>record.status==='accepted').flatMap(record=>['DKK','EUR'].filter(currency=>Number(record.totals?.[currency]||0)>0).map(currency=>({id:`transfer:${record.id}:${currency}`,kind:'transfer',source:'cash_transfer',sourceId:record.id,...tripInfo(record.tripId),at:record.respondedAt||record.createdAt,description:`Pengeoverførsel · ${userName(record.fromUserId||record.fromDriverId)} → ${userName(record.toUserId||record.toDriverId)}`,actorName:userName(record.respondedBy||record.initiatedBy),status:'accepted',currency,amount:Number(record.totals[currency]),signedAmount:0}))),
    ...db.cashSettlements.filter(record=>record.status==='approved').flatMap(record=>['DKK','EUR'].filter(currency=>Number(record.delivered?.[currency]||0)>0).map(currency=>({id:`settlement:${record.id}:${currency}`,kind:'settlement',source:'cash_settlement',sourceId:record.id,...tripInfo(record.tripId),at:record.reviewedAt||record.submittedAt,description:`Kontantafstemning · ${userName(record.driverId)} → kontor`,actorName:userName(record.reviewedBy||record.submittedBy),status:'approved',currency,amount:Number(record.delivered[currency]),signedAmount:0})))
  ];
  return entries.sort((left,right)=>new Date(right.at||0)-new Date(left.at||0));
}
function financialCashBalances() {
  const rows=new Map();
  for(const entry of db.accountingEntries||[]){const delta=Number(entry.cashDelta||0);if(!delta||(!entry.holderUserId&&entry.holderType!=='office'))continue;const key=entry.holderType==='office'?'office':`user:${entry.holderUserId}`;if(!rows.has(key))rows.set(key,{holderId:entry.holderUserId||null,holderType:entry.holderType||'employee',holderName:entry.holderType==='office'?'Kontor':userName(entry.holderUserId),opening:{DKK:0,EUR:0},in:{DKK:0,EUR:0},out:{DKK:0,EUR:0},closing:{DKK:0,EUR:0}});const row=rows.get(key),currency=entry.currency||'DKK';if(delta>0)row.in[currency]+=delta;else row.out[currency]+=Math.abs(delta);row.closing[currency]+=delta;}
  return {byHolder:[...rows.values()].sort((left,right)=>String(left.holderName).localeCompare(String(right.holderName),'da-DK'))};
}
function queueNotificationDraft({trip,type,phone,recipientName,user,body}) {
  const normalizedPhone=String(phone||'').trim();if(!normalizedPhone)return null;
  const duplicate=type==='trip_cancelled'?db.notificationDrafts.find(item=>item.tripId===trip.id&&item.type===type&&item.phone===normalizedPhone&&item.status==='draft'):null;if(duplicate)return duplicate;
  const draft={id:id(),tripId:trip.id,type,channel:'sms',phone:normalizedPhone,recipientName:String(recipientName||'').trim(),body:String(body||'').trim(),status:'draft',createdAt:new Date().toISOString(),createdBy:user.id,archivedAt:null,archivedBy:null};
  db.notificationDrafts.push(draft);audit(user,'notification.draft_created','notification',draft.id,trip.id,{type,recipientName:draft.recipientName});return draft;
}
function bookingNotificationDraft(trip,passenger,user) {
  const origin=userName(passenger.createdBy),departure=new Date(trip.departureAt).toLocaleString('da-DK',{timeZone:'Europe/Copenhagen',dateStyle:'short',timeStyle:'short'});
  return queueNotificationDraft({trip,type:'booking_confirmation',phone:passenger.phone,recipientName:passenger.name,user,body:`Alba Turist: Booking til ${trip.title} den ${departure}. Sæde ${passenger.seatNumber}. Kontakt os ved ændringer. Registreret af ${origin}.`});
}
function cancellationNotificationDrafts(trip,user) {
  const unique=new Map();for(const passenger of db.passengers.filter(item=>item.tripId===trip.id&&item.phone)){const contact=passenger.partyBookingId?db.passengers.find(item=>item.id===passenger.partyPrimaryPassengerId)||passenger:passenger;unique.set(contact.phone,contact)}
  return [...unique.values()].map(passenger=>queueNotificationDraft({trip,type:'trip_cancelled',phone:passenger.phone,recipientName:passenger.name,user,body:`Alba Turist: Turen ${trip.title} er aflyst. Årsag: ${trip.cancellationReason}. Kontakt billetkontoret for hjælp.`})).filter(Boolean);
}
function cashBoxes(tripId) {
  const records=allCashItems().filter(item=>item.record.tripId===tripId&&item.record.paymentStatus==='cash'&&['bus','departure','shop','budget'].includes(item.record.paymentLocation)&&item.record.cashHolderUserId&&!item.record.cashHandedOverAt);
  return [...new Set(records.map(item=>item.record.cashHolderUserId))].map(holderId=>{
    const held=records.filter(item=>item.record.cashHolderUserId===holderId),isBudget=item=>item.kind==='budget'||(()=>{const history=item.record.cashTransferHistory||[],latest=history.at(-1);return['trip_budget','general_driver_budget'].includes(latest?.transferType)&&(latest.toUserId||latest.toDriverId)===holderId})(),budget=held.filter(isBudget),ordinary=held.filter(item=>!isBudget(item)),tickets=ordinary.filter(item=>item.kind==='passenger'),baggage=ordinary.filter(item=>item.kind==='baggage');
    return {holderId,holderName:userName(holderId),totals:cashAvailableAmounts(held),grossTotals:cashAmounts(held),cashExpenseTotals:cashExpenseTotalsForItems(held),ticketTotals:cashAvailableAmounts(tickets),baggageTotals:cashAvailableAmounts(baggage),budgetTotals:cashAvailableAmounts(budget),budgetPayments:budget.length,payments:held.length,paymentRefs:held.map(cashReference)};
  });
}
function tripCloseBlockers(trip) {
  const passengers=db.passengers.filter(item=>item.tripId===trip.id),baggage=db.baggage.filter(item=>item.tripId===trip.id),expenses=db.expenses.filter(item=>item.tripId===trip.id);
  return {
    passengers:passengers.filter(item=>!item.checkedIn&&item.attendanceStatus!=='no_show').map(item=>({id:item.id,name:item.name})),
    tripArrival:trip.arrivedAt?[]:[{message:'En tildelt chauffør skal markere turen som ankommet'}],
    passengerListConfirmation:trip.passengerListClosedAt?[]:[{message:'En tildelt chauffør skal afslutte passagerlisten'}],
    baggage:baggage.filter(item=>!['delivered','unclaimed'].includes(item.status)).map(item=>({id:item.id,name:item.senderName,status:item.status})),
    expenses:expenses.filter(item=>!item.receiptFile||(item.status||'pending')==='pending'||((item.paymentMethod||'cash')==='private'&&item.status==='approved'&&item.reimbursementStatus!=='paid')).map(item=>({id:item.id,category:item.category,status:item.status,missingReceipt:!item.receiptFile}))
  };
}
function hasCloseBlockers(blockers) { return Object.values(blockers).some(value=>Array.isArray(value)&&value.length); }
function createAutomaticZeroSettlements(trip,closedBy,closedAt) {
  const driverIds=[...new Set([trip.primaryDriverId,trip.secondaryDriverId].filter(Boolean))],created=[];
  for(const driverId of driverIds){
    if(unsettledCashRecords(trip.id,driverId).length)continue;
    const settlement={id:id(),tripId:trip.id,driverId,expected:{DKK:0,EUR:0},delivered:{DKK:0,EUR:0},difference:{DKK:0,EUR:0},note:'Automatisk nulafstemning ved driftsafslutning',paymentRefs:[],status:'approved',automaticZero:true,operationalCloseAt:closedAt,submittedAt:closedAt,submittedBy:closedBy.id,reviewedAt:closedAt,reviewedBy:null,reviewNote:'Ingen kontanter i chaufførens pengekasse for denne tur'};
    db.cashSettlements.push(settlement);created.push(settlement);audit(closedBy,'cash_settlement.automatic_zero','cash_settlement',settlement.id,trip.id,{driverId});
  }
  return created;
}
function reopenPassengerListForChange(trip,user,reason) {
  // Retrospective sales do not reopen the driver's signed-off operations.
  if(trip.status==='completed')return;
  if(!trip.passengerListClosedAt)return;
  const previous={closedAt:trip.passengerListClosedAt,closedBy:trip.passengerListClosedBy};
  trip.passengerListClosedAt=null;trip.passengerListClosedBy=null;trip.passengerListCloseNote='';
  audit(user,'trip.passenger_list_reopened','trip',trip.id,trip.id,{reason,previous});
}
function seatMap(tripId) {
  const trip = db.trips.find(t => t.id === tripId);
  const taken = new Map();
  for (const passenger of db.passengers.filter(p => p.tripId === tripId)) {
    taken.set(passenger.seatNumber,{ passengerId:passenger.id,reservationType:'primary' });
    if (passenger.extraSeatNumber) taken.set(passenger.extraSeatNumber,{ passengerId:passenger.id,reservationType:'extra' });
  }
  return Array.from({ length: trip?.seatCount || 54 }, (_, index) => {
    const number = index + 1;
    const assignedBus = trip?.busId ? db.buses.find(b => b.id === trip.busId) : null;
    const isDouble = assignedBus?.type === 'double' || trip?.seatCount === 84;
    const isFront = isDouble ? number >= 23 && number <= 26 : number <= 4;
    const isTable = isDouble ? number >= 1 && number <= 8 : [13,14,17,18,21,22,25,26].includes(number);
    const lowerDeckSeats = isDouble ? 22 : trip?.seatCount;
    const reservation=taken.get(number);
    return { number, deck: number <= lowerDeckSeats ? 'lower' : 'upper', type: isFront ? 'front' : isTable ? 'table' : 'standard', surcharge: isFront ? 100 : isTable ? 75 : 0, passengerId: reservation?.passengerId || null,reservationType:reservation?.reservationType||null };
  });
}
function adjacentSeatNumber(tripId,seatNumber) {
  const seats=seatMap(tripId),seat=seats.find(candidate=>candidate.number===Number(seatNumber));
  if(!seat)return null;
  const deckSeats=seats.filter(candidate=>candidate.deck===seat.deck),deckIndex=deckSeats.findIndex(candidate=>candidate.number===seat.number);
  if(deckIndex<0)return null;
  const pairIndex=deckIndex%2===0?deckIndex+1:deckIndex-1,adjacent=deckSeats[pairIndex];
  return adjacent&&Math.floor(pairIndex/4)===Math.floor(deckIndex/4)?adjacent.number:null;
}
function isAdjacentSeat(tripId,seatNumber,extraSeatNumber) { return adjacentSeatNumber(tripId,seatNumber)===Number(extraSeatNumber); }
function tripIncludesStop(trip,stopId) {
  return Number(trip.originId)===Number(stopId)||Number(trip.destinationId)===Number(stopId)||(trip.timetable||[]).some(row=>Number(row.stopId)===Number(stopId));
}
function validateReturnReservation(user,outboundTrip,pickupStopId,destinationStopId,returnTripId,returnSeatNumber) {
  const returnTrip=db.trips.find(candidate=>candidate.id===Number(returnTripId));
  if(!returnTrip||returnTrip.id===outboundTrip.id)return{error:'Vælg en anden tur til returrejsen'};
  if(!allowedTrip(user,returnTrip))return{error:'Du har ikke adgang til den valgte returtur'};
  if(['cancelled','completed'].includes(returnTrip.status))return{error:'Den valgte returtur er ikke åben for booking'};
  if(new Date(returnTrip.departureAt)<=new Date(outboundTrip.departureAt))return{error:'Returturen skal afgå efter udrejsen'};
  if(!tripIncludesStop(returnTrip,destinationStopId)||!tripIncludesStop(returnTrip,pickupStopId))return{error:'Returturen skal køre fra udrejsens destination tilbage til opsamlingsstedet'};
  const returnSeat=seatMap(returnTrip.id).find(candidate=>candidate.number===Number(returnSeatNumber));
  if(!returnSeat)return{error:'Vælg et gyldigt sæde på returturen'};
  if(returnSeat.passengerId)return{error:'Sædet på returturen er allerede reserveret'};
  return{returnTrip,returnSeat};
}
function createReturnPassenger({outbound,returnTrip,returnSeat,user,bookingGroupId}) {
  return { id:id(),tripId:returnTrip.id,name:outbound.name,bookingNumber:outbound.bookingNumber,ticketNumber:outbound.ticketNumber,phone:outbound.phone,pickupStopId:outbound.destinationStopId,destinationStopId:outbound.pickupStopId,paymentStatus:'return_included',paymentCurrency:outbound.paymentCurrency,ticketCashAmount:0,cashAmount:0,paymentLocation:null,paymentRecordedAt:outbound.paymentRecordedAt,paymentRecordedBy:outbound.paymentRecordedBy,cashHolderUserId:null,createdBy:user.id,freeTicketReason:'',seatNumber:returnSeat.number,seatType:returnSeat.type,seatSurcharge:returnSeat.surcharge,extraSeatNumber:null,extraSeatAmount:0,extraSeatCurrency:outbound.paymentCurrency,extraSeatFree:false,extraSeatReason:'',totalPrice:0,checkedIn:false,attendanceStatus:'pending',checkedInAt:null,checkedInBy:null,ticketType:'return_fixed',journeyLeg:'return',bookingGroupId,returnStatus:'booked',returnTripId:null,returnPassengerId:null,outboundPassengerId:outbound.id,openReturnValidUntil:null,returnBookedAt:new Date().toISOString(),returnBookedBy:user.id,partyBookingId:outbound.partyBookingId||null,partyPrimaryPassengerId:outbound.partyPrimaryPassengerId||null,partyRole:outbound.partyRole||null,partySize:outbound.partySize||null };
}
function unsettledCashRecords(tripId,driverId) {
  return allCashItems().filter(item=>(item.record.tripId===tripId||(item.kind==='budget'&&!item.record.tripId))&&item.record.paymentStatus==='cash'&&['bus','departure','shop','budget'].includes(item.record.paymentLocation)&&item.record.cashHolderUserId===driverId&&!item.record.cashHandedOverAt);
}
function allCashItems(){return[...db.passengers.map(record=>({record,kind:'passenger'})),...db.baggage.map(record=>({record,kind:'baggage'})),...(db.cashBudgetEntries||[]).map(record=>({record,kind:'budget'}))]}
function cashAmounts(items) { return ['DKK','EUR'].reduce((totals,currency)=>{totals[currency]=items.filter(item=>(item.record?.paymentCurrency||item.paymentCurrency||'DKK')===currency).reduce((sum,item)=>sum+Number(item.record?.cashAmount||item.cashAmount||0),0);return totals;},{}); }
function cashReference(item) { return `${item.kind}:${item.record.id}`; }
function activeCashExpenseAllocations(excludeExpenseId=null) { return db.expenses.filter(expense=>expense.id!==excludeExpenseId&&expense.status!=='rejected').flatMap(expense=>(expense.cashPaymentAllocations||[]).map(allocation=>({...allocation,expenseId:expense.id}))); }
function activeCashTransferAllocations(excludeTransferId=null){return db.cashTransfers.filter(transfer=>transfer.id!==excludeTransferId&&['pending','accepted'].includes(transfer.status)).flatMap(transfer=>(transfer.cashTransferAllocations||[]).map(allocation=>({...allocation,transferId:transfer.id})))}
function cashAvailableAmount(item,excludeExpenseId=null,excludeTransferId=null) { const reference=cashReference(item),spent=activeCashExpenseAllocations(excludeExpenseId).filter(allocation=>allocation.reference===reference).reduce((sum,allocation)=>sum+Number(allocation.amount||0),0),transferred=activeCashTransferAllocations(excludeTransferId).filter(allocation=>allocation.reference===reference).reduce((sum,allocation)=>sum+Number(allocation.amount||0),0);return Math.max(0,Number(item.record.cashAmount||0)-spent-transferred); }
function cashAvailableAmounts(items,excludeExpenseId=null) { return ['DKK','EUR'].reduce((totals,currency)=>{totals[currency]=items.filter(item=>(item.record.paymentCurrency||'DKK')===currency).reduce((sum,item)=>sum+cashAvailableAmount(item,excludeExpenseId),0);return totals;},{}); }
function allocateCashTransfer(items,currency,amount){let remaining=Number(amount),allocations=[];for(const item of items.filter(candidate=>(candidate.record.paymentCurrency||'DKK')===currency)){const available=cashAvailableAmount(item),used=Math.min(available,remaining);if(used>0)allocations.push({reference:cashReference(item),amount:used,currency});remaining-=used;if(remaining<=0)break}return remaining>0?null:allocations}
function allocateCashExpense(tripId,userId,currency,amount,excludeExpenseId=null) {
  const candidates=unsettledCashRecords(tripId,userId).filter(item=>(item.record.paymentCurrency||'DKK')===currency&&!hasPendingSettlementReference(cashReference(item))&&!hasPendingTransferReference(cashReference(item)));
  let remaining=Number(amount),allocations=[];
  for(const item of candidates){const available=cashAvailableAmount(item,excludeExpenseId),used=Math.min(available,remaining);if(used>0)allocations.push({reference:cashReference(item),amount:used,currency});remaining-=used;if(remaining<=0)break;}
  if(remaining>0)return null;return allocations;
}
function cashExpenseTotalsForItems(items) { const references=new Set(items.map(cashReference));return ['DKK','EUR'].reduce((totals,currency)=>{totals[currency]=activeCashExpenseAllocations().filter(allocation=>references.has(allocation.reference)&&allocation.currency===currency).reduce((sum,allocation)=>sum+Number(allocation.amount||0),0);return totals;},{}); }
function hasPendingCashExpenseReference(reference) { return db.expenses.some(expense=>(expense.status||'pending')==='pending'&&(expense.cashPaymentAllocations||[]).some(allocation=>allocation.reference===reference)); }
function correctionReason(data) {
  const reason = String(data.correctionReason || '').trim();
  return reason.length >= 3 ? reason : null;
}
function changedFields(record, updates) {
  return Object.fromEntries(Object.entries(updates).filter(([key,value]) => String(record[key] ?? '') !== String(value ?? '')).map(([key,value]) => [key,{ from:record[key] ?? null,to:value ?? null }]));
}
function hasPendingSettlementReference(reference) {
  return db.cashSettlements.some(settlement => settlement.status === 'pending' && settlement.paymentRefs.includes(reference));
}
function hasPendingTransferReference(reference) {
  return db.cashTransfers.some(transfer => transfer.status === 'pending' && transfer.paymentRefs.includes(reference));
}
function hasCashAuditReference(reference) {
  return db.cashSettlements.some(settlement => (settlement.paymentRefs || []).includes(reference)) || db.cashTransfers.some(transfer => (transfer.paymentRefs || []).includes(reference));
}
function recordDeletion(trip, kind, record, user, reason) {
  trip.deletionHistory = trip.deletionHistory || [];
  trip.deletionHistory.push({ kind, record: { ...record }, deletedAt: new Date().toISOString(), deletedBy: user.id, deletedByName: user.name, reason });
}
function cashItemBelongsToTrip(item,tripId) { return Boolean(item&&(item.record.tripId===tripId||(item.kind==='budget'&&!item.record.tripId))); }
function cashRecordByReference(reference, tripId) {
  const item=cashRecordByReferenceAny(reference);
  return cashItemBelongsToTrip(item,tripId)?item:null;
}
function cashRecordByReferenceAny(reference) {
  const [kind,rawId] = String(reference).split(':');
  const collection = kind === 'passenger' ? db.passengers : kind === 'baggage' ? db.baggage : kind==='budget' ? db.cashBudgetEntries : null;
  const record = collection?.find(item => item.id === Number(rawId));
  return record ? { kind,record,reference:`${kind}:${record.id}` } : null;
}
async function api(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {const latestBackup=(db.maintenanceRuns||[]).filter(run=>run.type==='database_backup'&&run.status==='success').at(-1)||null;return json(res, 200, { ok: true,release:RELEASE_ID,uptimeSeconds:Math.round(process.uptime()),storage: DATABASE_URL ? 'postgresql' : 'json',database:{ready:Boolean(db),backend:DATABASE_URL?'postgresql':'json'},fileStorage:{backend:FILE_STORAGE_BACKEND,r2Configured:R2_CONFIGURED,lastError:lastFileStorageError},backup:{configured:Boolean(backupKey()&&R2_CONFIGURED),lastSuccessAt:latestBackup?.finishedAt||null}, time: new Date().toISOString() });}
  if(pathname==='/api/branding/logo'&&req.method==='GET')return storedImage(res,db.settings?.logoFile,db.settings?.logoType);
  if (pathname === '/api/login' && req.method === 'POST') {
    if (!loginAllowed(req)) {recordSecurityEvent(req,'login_rate_limited');await saveDb();return fail(res, 429, 'For mange loginforsøg. Vent 15 minutter og prøv igen');}
    const data = await body(req); const user = db.users.find(u => u.email.toLowerCase() === String(data.email || '').toLowerCase());
    if (!user || !verifyPassword(String(data.password || ''), user)) { recordFailedLogin(req);recordSecurityEvent(req,'login_failed',{email:data.email,userId:user?.id||null});await saveDb(); return fail(res, 401, 'Forkert e-mail eller adgangskode'); }
    loginAttempts.delete(requestIp(req));
    const now = Date.now(), sid = crypto.randomBytes(32).toString('hex'),rememberMe=data.rememberMe===true||data.rememberMe==='true',ttl=rememberMe?REMEMBERED_SESSION_TTL_MS:SESSION_TTL_MS;
    db.sessions = db.sessions.filter(session => session.expiresAt > now);
    const previousSessions=db.sessions.filter(session=>session.userId===user.id).sort((left,right)=>right.createdAt-left.createdAt).slice(4);if(previousSessions.length){const removeIds=new Set(previousSessions.map(session=>session.id));db.sessions=db.sessions.filter(session=>!removeIds.has(session.id))}
    db.sessions.push({ id: sid, userId: user.id, createdAt: now, expiresAt: now + ttl, remembered:rememberMe,ip:maskedIp(req),userAgent:String(req.headers['user-agent']||'Ukendt enhed').slice(0,240) });
    recordSecurityEvent(req,'login_succeeded',{userId:user.id,email:user.email});
    await saveDb();
    return json(res, 200, { user: cleanUser(user) }, { 'Set-Cookie': sessionCookie(sid, rememberMe?ttl/1000:undefined) });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    const sid = cookies(req).sid; db.sessions = db.sessions.filter(session => session.id !== sid); await saveDb();
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  const user = auth(req); if (!user) return fail(res, 401, 'Log ind for at fortsætte');
  const ticketPdfMatch=pathname.match(/^\/api\/bookings\/([^/]+)\/ticket\.pdf$/);
  if(ticketPdfMatch&&req.method==='GET'){
    const bookingNumber=decodeURIComponent(ticketPdfMatch[1]),passengers=db.passengers.filter(item=>item.bookingNumber===bookingNumber);if(!passengers.length)return fail(res,404,'Bookingen findes ikke');
    const visible=passengers.some(item=>{const trip=db.trips.find(candidate=>candidate.id===item.tripId);return trip&&allowedTrip(user,trip)});if(!visible)return fail(res,403,'Du har ikke adgang til billetten');
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`),reprint=url.searchParams.get('reprint')==='1',qrPayload=`${expectedOrigin(req)}/ticket/${ticketToken(bookingNumber)}`,pdf=createTicketPdf(ticketDocumentData(bookingNumber,passengers,user,reprint,qrPayload)),filename=`Alba-Turist-${bookingNumber.replace(/[^a-z0-9-]+/gi,'-')}.pdf`;
    res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':pdf.length,'Content-Disposition':`${url.searchParams.get('download')==='1'?'attachment':'inline'}; filename="${filename}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Link':`<${qrPayload}>; rel="alternate"; title="Digital billet"`});return res.end(pdf);
  }
  if(pathname==='/api/offline/status'&&req.method==='POST'){
    const data=await body(req),deviceId=String(data.deviceId||'').trim().slice(0,120);if(!deviceId)return fail(res,400,'Enheds-id mangler');
    let client=db.offlineClients.find(item=>item.deviceId===deviceId&&item.userId===user.id);if(!client){client={deviceId,userId:user.id};db.offlineClients.push(client)}
    Object.assign(client,{pendingCount:Math.max(0,Number(data.pendingCount||0)),conflictCount:Math.max(0,Number(data.conflictCount||0)),lastSeenAt:new Date().toISOString(),label:String(data.label||req.headers['user-agent']||'Enhed').slice(0,180)});if(db.offlineClients.length>500)db.offlineClients.splice(0,db.offlineClients.length-500);await saveDb();return json(res,200,{ok:true});
  }
  if(pathname==='/api/admin/operations'&&req.method==='GET'){
    if(user.role!=='admin')return fail(res,403,'Kun administratoren har adgang til systemdrift');
    const fileReport=await inspectStoredFiles({verifyR2:false}),now=Date.now(),currentSid=cookies(req).sid,sessions=db.sessions.filter(session=>session.expiresAt>now).map(session=>({key:sha256(session.id).slice(0,16),userId:session.userId,userName:userName(session.userId),role:db.users.find(candidate=>candidate.id===session.userId)?.role||'ukendt',createdAt:new Date(session.createdAt).toISOString(),expiresAt:new Date(session.expiresAt).toISOString(),remembered:Boolean(session.remembered),ip:session.ip||'ukendt',userAgent:session.userAgent||'Ukendt enhed',current:session.id===currentSid})).sort((left,right)=>new Date(right.createdAt)-new Date(left.createdAt));
    const failedLogins=(db.securityEvents||[]).filter(event=>event.type==='login_failed'||event.type==='login_rate_limited').slice(-100).reverse();
    return json(res,200,{health:{release:RELEASE_ID,uptimeSeconds:Math.round(process.uptime()),database:DATABASE_URL?'postgresql':'json',fileStorage:{backend:FILE_STORAGE_BACKEND,r2Configured:R2_CONFIGURED,lastError:lastFileStorageError},backupConfigured:Boolean(backupKey()&&R2_CONFIGURED)},alerts:operationalAlerts(user),files:fileReport,maintenance:[...(db.maintenanceRuns||[])].slice(-50).reverse(),events:[...(db.systemEvents||[])].slice(-100).reverse(),security:{activeSessions:sessions,failedLogins}});
  }
  if(pathname==='/api/admin/files/migrate'&&req.method==='POST'){
    if(user.role!=='admin')return fail(res,403,'Kun administratoren kan migrere filer');const data=await body(req),run=await migrateStoredFilesToR2({dryRun:data.dryRun===true,user});audit(user,'system.files_migrated','system',run.id,null,{status:run.status,...run.summary});await saveDb();return json(res,200,{run});
  }
  if(pathname==='/api/admin/backups'&&req.method==='POST'){
    if(user.role!=='admin')return fail(res,403,'Kun administratoren kan oprette databasebackups');const run=await createDatabaseBackup({user,reason:'manual'});audit(user,'system.database_backed_up','system',run.id,null,{file:run.summary.file,bytes:run.summary.bytes});await saveDb();return json(res,201,{run});
  }
  if(pathname==='/api/admin/system-events'&&req.method==='PATCH'){
    if(user.role!=='admin')return fail(res,403,'Kun administratoren kan kvittere systemhændelser');const data=await body(req),targets=data.all===true?db.systemEvents.filter(event=>!event.acknowledgedAt):db.systemEvents.filter(event=>event.id===Number(data.id));const at=new Date().toISOString();for(const event of targets){event.acknowledgedAt=at;event.acknowledgedBy=user.id}audit(user,'system.events_acknowledged','system',null,null,{count:targets.length});await saveDb();return json(res,200,{acknowledged:targets.length});
  }
  const adminSessionMatch=pathname.match(/^\/api\/admin\/sessions\/([a-f0-9]{16})$/);
  if(adminSessionMatch&&req.method==='DELETE'){
    if(user.role!=='admin')return fail(res,403,'Kun administratoren kan afslutte andre sessioner');const currentSid=cookies(req).sid,target=db.sessions.find(session=>sha256(session.id).slice(0,16)===adminSessionMatch[1]);if(!target)return fail(res,404,'Sessionen findes ikke');if(target.id===currentSid)return fail(res,409,'Din aktuelle session skal afsluttes med Log ud');db.sessions=db.sessions.filter(session=>session!==target);audit(user,'security.session_revoked','session',adminSessionMatch[1],null,{userId:target.userId});await saveDb();return json(res,200,{ok:true});
  }
  if(pathname==='/api/audit'&&req.method==='GET'){
    if(user.role!=='admin')return fail(res,403,'Kun administratoren kan se revisionshistorikken');
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`),tripId=Number(url.searchParams.get('tripId')||0),limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit')||200)));
    const events=db.auditLog.filter(event=>!tripId||event.tripId===tripId).slice(-limit).reverse();return json(res,200,{events});
  }
  if(pathname==='/api/profile/language'&&req.method==='PATCH'){
    const data=await body(req),language=String(data.language||'');if(!['da','sq','de','en'].includes(language))return fail(res,400,'Vælg et gyldigt sprog');user.language=language;await saveDb();return json(res,200,{language});
  }
  if(pathname==='/api/profile'&&req.method==='PATCH'){
    const data=await body(req),currentPassword=String(data.currentPassword||''),email=String(data.email||'').trim().toLowerCase(),newPassword=String(data.newPassword||'');
    if(!verifyPassword(currentPassword,user))return fail(res,401,'Den nuværende adgangskode er forkert');
    if(!email||!email.includes('@'))return fail(res,400,'Indtast en gyldig e-mailadresse');
    if(db.users.some(candidate=>candidate.id!==user.id&&candidate.email.toLowerCase()===email))return fail(res,409,'E-mailadressen bruges allerede');
    if(newPassword&&newPassword.length<12)return fail(res,400,'Den nye adgangskode skal være på mindst 12 tegn');
    if(email===user.email&& !newPassword)return fail(res,400,'Der er ingen ændringer at gemme');
    user.email=email;
    if(newPassword){const credentials=hashPassword(newPassword);user.salt=credentials.salt;user.passwordHash=credentials.hash;const currentSid=cookies(req).sid;db.sessions=db.sessions.filter(session=>session.userId!==user.id||session.id===currentSid)}
    await saveDb();return json(res,200,{user:cleanUser(user)});
  }
  if(pathname==='/api/branding'&&req.method==='PATCH'){
    if(user.role!=='admin')return fail(res,403,'Kun administratoren kan ændre appens logo');
    const data=await body(req),image=await storeImage({data:data.logoData,type:data.logoType,name:data.logoName},{prefix:'app-logo'}),oldFile=db.settings?.logoFile;
    db.settings={...db.settings,logoFile:image.file,logoType:image.type,logoName:image.name};await saveDb();if(oldFile!==image.file)await removeStoredFile(oldFile);return json(res,200,{hasLogo:true,logoName:image.name});
  }
  if (pathname === '/api/me') return json(res, 200, { user: cleanUser(user) });
  if (pathname === '/api/bootstrap') {
    const trips = db.trips.filter(t => allowedTrip(user, t)).map(tripView);
    return json(res, 200, { user: cleanUser(user), branding:{hasLogo:Boolean(db.settings?.logoFile),logoName:db.settings?.logoName||null}, trips, stops: db.stops, drivers: ['admin','sales_manager'].includes(user.role) ? db.users.filter(u => u.role === 'driver').map(cleanUser) : [], salesManagers: ['admin','driver'].includes(user.role) ? db.users.filter(u => u.role === 'sales_manager').map(cleanUser) : [], buses: ['admin','sales_manager'].includes(user.role) ? db.buses : [] });
  }
  if(pathname==='/api/dashboard'&&req.method==='GET'){
    const visibleTrips=db.trips.filter(trip=>allowedTrip(user,trip)),tripIds=new Set(visibleTrips.map(trip=>trip.id)),passengers=db.passengers.filter(record=>tripIds.has(record.tripId)),baggage=db.baggage.filter(record=>tripIds.has(record.tripId)),expenses=db.expenses.filter(record=>tripIds.has(record.tripId));
    const heldAllItems=allCashItems().filter(item=>(tripIds.has(item.record.tripId)||(item.kind==='budget'&&!item.record.tripId))&&item.record.paymentStatus==='cash'&&['bus','departure','shop','budget'].includes(item.record.paymentLocation)&&item.record.cashHolderUserId&&!item.record.cashHandedOverAt),heldItems=user.role==='admin'?heldAllItems:heldAllItems.filter(item=>item.record.cashHolderUserId===user.id),holderIds=[...new Set(heldAllItems.map(item=>item.record.cashHolderUserId))];
    const isToday=value=>value&&new Date(value).toDateString()===new Date().toDateString(),receivedFilter=record=>isPaidPayment(record)&&isToday(record.paymentRecordedAt)&&(user.role==='admin'||record.cashHolderUserId===user.id||record.paymentRecordedBy===user.id),todayTickets=passengers.filter(receivedFilter),todayBaggage=baggage.filter(receivedFilter);
    const actionItems=visibleTrips.flatMap(trip=>tripActionItems(trip,user)).sort((left,right)=>({critical:0,warning:1,info:2}[left.severity]-({critical:0,warning:1,info:2}[right.severity])||new Date(left.departureAt)-new Date(right.departureAt)));
    return json(res,200,{cashHeld:{...cashAvailableAmounts(heldItems),gross:cashAmounts(heldItems),expenses:cashExpenseTotalsForItems(heldItems),payments:heldItems.length,byPerson:user.role==='admin'?holderIds.map(userId=>{const items=heldAllItems.filter(item=>item.record.cashHolderUserId===userId);return{userId,userName:userName(userId),...cashAvailableAmounts(items),gross:cashAmounts(items),expenses:cashExpenseTotalsForItems(items),payments:items.length}}):[]},todayTicketRevenue:recordedRevenueAmounts(todayTickets),todayBaggageRevenue:recordedRevenueAmounts(todayBaggage),todayTicketSales:todayTickets.length,todayBaggageSales:todayBaggage.length,pendingExpenses:expenses.filter(expense=>(expense.status||'pending')==='pending'&&(user.role==='admin'||expense.createdBy===user.id)).length,missingReceipts:expenses.filter(expense=>!expense.receiptFile&&(user.role==='admin'||expense.createdBy===user.id)).length,openBaggage:baggage.filter(item=>!['delivered'].includes(item.status)).length,unpaid:[...passengers,...baggage].filter(isPendingPayment).length,actionItems,operationalAlerts:operationalAlerts(user),actionSummary:{total:actionItems.length,critical:actionItems.filter(item=>item.severity==='critical').length,warning:actionItems.filter(item=>item.severity==='warning').length}});
  }
  if(pathname==='/api/my-cashbox'&&req.method==='GET'){
    if(!['sales_manager','driver'].includes(user.role))return fail(res,403,'Kun salgschefer og chauffører har adgang til deres personlige pengekasse');
    const heldItems=allCashItems().filter(item=>item.record.paymentStatus==='cash'&&['bus','departure','shop','budget'].includes(item.record.paymentLocation)&&item.record.cashHolderUserId===user.id&&!item.record.cashHandedOverAt);
    const ticketItems=heldItems.filter(item=>item.kind==='passenger'),baggageItems=heldItems.filter(item=>item.kind==='baggage'),budgetItems=heldItems.filter(item=>item.kind==='budget');
    const ownExpenses=db.expenses.filter(expense=>expense.createdBy===user.id&&expense.status!=='rejected');
    const ownTransfers=db.cashTransfers.filter(transfer=>[transfer.fromUserId||transfer.fromDriverId,transfer.toUserId||transfer.toDriverId].includes(user.id));
    const tripIds=new Set([...heldItems.map(item=>item.record.tripId),...ownExpenses.map(expense=>expense.tripId),...ownTransfers.map(transfer=>transfer.tripId)].filter(Boolean));
    const byTrip=[...tripIds].map(tripId=>{
      const trip=db.trips.find(candidate=>candidate.id===tripId);if(!trip)return null;
      const box=cashBoxes(tripId).find(candidate=>candidate.holderId===user.id),expenses=ownExpenses.filter(expense=>expense.tripId===tripId),transfers=ownTransfers.filter(transfer=>transfer.tripId===tripId);
      const expenseTotals=['DKK','EUR'].reduce((totals,currency)=>{totals[currency]=expenses.filter(expense=>(expense.currency||'DKK')===currency).reduce((sum,expense)=>sum+Number(expense.amount||0),0);return totals;},{});
      return {tripId,title:trip.title,departureAt:trip.departureAt,status:trip.status||'planned',available:box?.totals||{DKK:0,EUR:0},gross:box?.grossTotals||{DKK:0,EUR:0},cashExpenses:box?.cashExpenseTotals||{DKK:0,EUR:0},ticketTotals:box?.ticketTotals||{DKK:0,EUR:0},baggageTotals:box?.baggageTotals||{DKK:0,EUR:0},payments:box?.payments||0,registeredExpenseTotals:expenseTotals,registeredExpenses:expenses.length,transfers:transfers.length};
    }).filter(Boolean).sort((a,b)=>new Date(b.departureAt)-new Date(a.departureAt));
    const lockedReferences=new Set([...db.cashTransfers.filter(transfer=>transfer.status==='pending').flatMap(transfer=>transfer.paymentRefs||[]),...db.cashSettlements.filter(settlement=>settlement.status==='pending').flatMap(settlement=>settlement.paymentRefs||[])]);
    const transferable=heldItems.filter(item=>cashAvailableAmount(item)>0&&!lockedReferences.has(cashReference(item))&&!hasPendingCashExpenseReference(cashReference(item))).map(item=>({reference:cashReference(item),kind:item.kind,name:item.kind==='budget'?'Budget fra salgschef':item.record.name||item.record.senderName,amount:cashAvailableAmount(item),currency:item.record.paymentCurrency||'DKK',tripId:item.record.tripId,tripTitle:db.trips.find(trip=>trip.id===item.record.tripId)?.title||'Uden bestemt tur'}));
    const recipientRole=user.role==='sales_manager'?'driver':'sales_manager',recipients=db.users.filter(candidate=>candidate.role===recipientRole).map(candidate=>({id:candidate.id,name:candidate.name,role:candidate.role}));
    const forwardedExpenses=db.expenses.filter(expense=>user.role==='sales_manager'?expense.forwardedToSalesManagerId===user.id:expense.createdBy===user.id&&expense.forwardedToSalesManagerId).sort((a,b)=>new Date(b.forwardedAt||0)-new Date(a.forwardedAt||0)).map(expense=>({...expenseRecordView(expense),tripTitle:db.trips.find(trip=>trip.id===expense.tripId)?.title||'Ukendt tur'}));
    return json(res,200,{holder:{id:user.id,name:user.name,role:user.role},summary:{available:cashAvailableAmounts(heldItems),gross:cashAmounts(heldItems),expenses:cashExpenseTotalsForItems(heldItems),ticketTotals:cashAvailableAmounts(ticketItems),baggageTotals:cashAvailableAmounts(baggageItems),budgetTotals:cashAvailableAmounts(budgetItems),payments:heldItems.length},byTrip,transferable,recipients,forwardedExpenses,transfers:[...ownTransfers].sort((a,b)=>new Date(b.initiatedAt||b.respondedAt||0)-new Date(a.initiatedAt||a.respondedAt||0)).slice(0,25).map(transfer=>({...cashTransferView(transfer,user),tripTitle:db.trips.find(trip=>trip.id===transfer.tripId)?.title||'Uden bestemt tur'}))});
  }
  if(pathname==='/api/cash-transfers'&&req.method==='POST'){
    if(!['driver','sales_manager'].includes(user.role))return fail(res,403,'Kun chauffører og salgschefer kan overføre penge fra deres egen kasse');
    const data=await body(req),toUserId=Number(data.toUserId||data.toDriverId),toUser=db.users.find(candidate=>candidate.id===toUserId),requiredRole=user.role==='sales_manager'?'driver':'sales_manager';
    if(!toUser||toUser.role!==requiredRole)return fail(res,400,user.role==='sales_manager'?'Vælg en gyldig chauffør':'Vælg en gyldig salgschef');
    const isBudgetTransfer=user.role==='sales_manager';let items=[],totals,cashTransferAllocations=[];
    if(isBudgetTransfer){
      totals={DKK:Math.max(0,Number(data.amountDKK||0)),EUR:Math.max(0,Number(data.amountEUR||0))};if(!(totals.DKK>0||totals.EUR>0))return fail(res,400,'Indtast et budgetbeløb i DKK eller EUR');
      const candidates=allCashItems().filter(item=>item.record.paymentStatus==='cash'&&['bus','departure','shop','budget'].includes(item.record.paymentLocation)&&item.record.cashHolderUserId===user.id&&!item.record.cashHandedOverAt&&!hasPendingSettlementReference(cashReference(item))&&!hasPendingTransferReference(cashReference(item))&&!hasPendingCashExpenseReference(cashReference(item)));
      for(const currency of ['DKK','EUR'])if(totals[currency]>0){const allocations=allocateCashTransfer(candidates,currency,totals[currency]);if(!allocations)return fail(res,409,`Der er ikke nok disponibelt budget i ${currency}`);cashTransferAllocations.push(...allocations)}
      items=[...new Set(cashTransferAllocations.map(allocation=>allocation.reference))].map(cashRecordByReferenceAny);
    }else{
      const references=[...new Set((Array.isArray(data.paymentRefs)?data.paymentRefs:[]).map(String))];if(!references.length)return fail(res,400,'Vælg mindst én betaling at aflevere');
      items=references.map(cashRecordByReferenceAny);if(items.some(item=>!item))return fail(res,400,'En valgt betaling findes ikke');
      if(items.some(item=>item.record.paymentStatus!=='cash'||!['bus','departure','shop','budget'].includes(item.record.paymentLocation)||item.record.cashHolderUserId!==user.id||item.record.cashHandedOverAt))return fail(res,409,'En valgt betaling står ikke længere i din kasse');
      if(items.some(item=>hasPendingSettlementReference(item.reference)||hasPendingTransferReference(item.reference)||hasPendingCashExpenseReference(item.reference)))return fail(res,409,'En valgt betaling er allerede låst af en afstemning, overførsel eller udgift');
      totals=cashAvailableAmounts(items);if(!(totals.DKK>0||totals.EUR>0))return fail(res,409,'De valgte betalinger har ingen disponibel saldo');
    }
    const selectedTripId=Number(data.tripId)||null,selectedTrip=selectedTripId?db.trips.find(trip=>trip.id===selectedTripId):null;if(selectedTripId&&!selectedTrip)return fail(res,400,'Den valgte tur findes ikke');
    const sourceTripIds=[...new Set(items.map(item=>item.record.tripId))],tripId=selectedTrip?.id||(sourceTripIds.length===1?sourceTripIds[0]:null),transferType=user.role==='sales_manager'?(selectedTrip?'trip_budget':'general_driver_budget'):'sales_handover';
    const transfer={id:id(),tripId,sourceTripIds,fromUserId:user.id,toUserId,fromDriverId:user.id,toDriverId:toUserId,transferType,paymentRefs:items.map(item=>item.reference),cashTransferAllocations,totals,note:String(data.note||'').trim(),status:'pending',initiatedAt:new Date().toISOString(),initiatedBy:user.id,respondedAt:null,respondedBy:null,responseNote:''};
    transfer.receiptNumber=`KT-${String(tripId||0).padStart(4,'0')}-${String(transfer.id).padStart(6,'0')}`;db.cashTransfers.push(transfer);audit(user,'cash_transfer.initiated','cash_transfer',transfer.id,tripId,{receiptNumber:transfer.receiptNumber,fromUserId:user.id,toUserId,transferType,totals});await saveDb();return json(res,201,cashTransferView(transfer,user));
  }
  if(pathname==='/api/cash-transfers'&&req.method==='PATCH'){
    const data=await body(req),transfer=db.cashTransfers.find(candidate=>candidate.id===Number(data.id));if(!transfer)return fail(res,404,'Pengeoverførslen findes ikke');
    if(transfer.status!=='pending')return fail(res,409,'Pengeoverførslen er allerede behandlet');
    if(!['accepted','rejected'].includes(data.status))return fail(res,400,'Vælg modtaget eller afvist');
    const fromUserId=transfer.fromUserId||transfer.fromDriverId,toUserId=transfer.toUserId||transfer.toDriverId;if(user.role!=='admin'&&user.id!==toUserId)return fail(res,403,'Kun modtageren kan bekræfte overførslen');
    if(data.status==='accepted'){
      const items=(transfer.paymentRefs||[]).map(cashRecordByReferenceAny);if(items.some(item=>!item||item.record.cashHolderUserId!==fromUserId||item.record.cashHandedOverAt||hasPendingSettlementReference(item.reference)))return fail(res,409,'En betaling har ændret status. Overførslen kan ikke gennemføres');
      const acceptedAt=new Date().toISOString(),isBudgetTransfer=['trip_budget','general_driver_budget'].includes(transfer.transferType)&&Array.isArray(transfer.cashTransferAllocations)&&transfer.cashTransferAllocations.length;
      if(isBudgetTransfer){
        for(const allocation of transfer.cashTransferAllocations){const item=cashRecordByReferenceAny(allocation.reference);if(!item||cashAvailableAmount(item,null,transfer.id)<Number(allocation.amount))return fail(res,409,'Budgetsaldoen har ændret sig. Overførslen kan ikke gennemføres')}
        for(const currency of ['DKK','EUR'])if(Number(transfer.totals?.[currency]||0)>0)db.cashBudgetEntries.push({id:id(),transferId:transfer.id,tripId:transfer.tripId||null,name:'Budget fra salgschef',paymentStatus:'cash',paymentLocation:'budget',paymentCurrency:currency,cashAmount:Number(transfer.totals[currency]),cashHolderUserId:toUserId,cashHandedOverAt:null,createdAt:acceptedAt,createdBy:fromUserId,note:transfer.note||''});
      }else for(const item of items){item.record.cashHolderUserId=toUserId;item.record.cashTransferHistory=item.record.cashTransferHistory||[];item.record.cashTransferHistory.push({transferId:transfer.id,transferType:transfer.transferType,fromUserId,toUserId,fromDriverId:fromUserId,toDriverId:toUserId,at:acceptedAt,acceptedBy:user.id});}
    }
    transfer.status=data.status;transfer.respondedAt=new Date().toISOString();transfer.respondedBy=user.id;transfer.responseNote=String(data.responseNote||'').trim();if(data.status==='accepted')postCashTransfer(transfer,user.id);audit(user,`cash_transfer.${data.status}`,'cash_transfer',transfer.id,transfer.tripId,{receiptNumber:transfer.receiptNumber,totals:transfer.totals});await saveDb();return json(res,200,cashTransferView(transfer,user));
  }
  if (pathname === '/api/buses' && req.method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Kun administratoren kan oprette busser');
    const data = await body(req); const name = String(data.name || '').trim(); const registration = String(data.registration || '').trim().toUpperCase(); const type = data.type === 'double' ? 'double' : 'standard'; const seatCount = type === 'double' ? 84 : Number(data.seatCount);
    if (!name || !registration) return fail(res, 400, 'Udfyld bussens navn og registreringsnummer');
    if (type === 'standard' && (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > 54)) return fail(res, 400, 'En almindelig bus kan have op til 54 sæder');
    if (db.buses.some(b => b.registration === registration)) return fail(res, 409, 'Registreringsnummeret findes allerede');
    const lowerDeckSeats = type === 'double' ? 22 : seatCount;
    const bus = { id: id(), name, registration, type, seatCount, lowerDeckSeats }; db.buses.push(bus); await saveDb(); return json(res, 201, bus);
  }
  const busMatch = pathname.match(/^\/api\/buses\/(\d+)$/);
  if (busMatch) {
    if (user.role !== 'admin') return fail(res, 403, 'Kun administratoren kan ændre busser');
    const bus = db.buses.find(b => b.id === Number(busMatch[1])); if (!bus) return fail(res, 404, 'Bussen findes ikke');
    if (req.method === 'PATCH') {
      const data = await body(req); const name = String(data.name || '').trim(); const registration = String(data.registration || '').trim().toUpperCase(); const type = data.type === 'double' ? 'double' : 'standard'; const seatCount = type === 'double' ? 84 : Number(data.seatCount);
      if (!name || !registration) return fail(res, 400, 'Udfyld bussens navn og registreringsnummer');
      if (type === 'standard' && (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > 54)) return fail(res, 400, 'En almindelig bus kan have op til 54 sæder');
      if (db.buses.some(b => b.id !== bus.id && b.registration === registration)) return fail(res, 409, 'Registreringsnummeret findes allerede');
      const lowerDeckSeats = type === 'double' ? 22 : seatCount;
      const highestBooked = Math.max(0,...db.trips.filter(t => t.busId === bus.id).flatMap(t => db.passengers.filter(p => p.tripId === t.id).flatMap(p => [p.seatNumber,p.extraSeatNumber||0])));
      if (seatCount < highestBooked) return fail(res, 409, `Der er allerede booket sæde ${highestBooked} på denne bus`);
      Object.assign(bus,{ name,registration,type,seatCount,lowerDeckSeats }); db.trips.filter(t => t.busId === bus.id).forEach(t => t.seatCount = seatCount); await saveDb(); return json(res, 200, bus);
    }
    if (req.method === 'DELETE') {
      if (db.trips.some(t => t.busId === bus.id)) return fail(res, 409, 'Bussen er tildelt en tur og kan derfor ikke slettes');
      db.buses = db.buses.filter(b => b.id !== bus.id); await saveDb(); return json(res, 200, { ok: true });
    }
    return fail(res, 405, 'Handlingen er ikke tilladt');
  }
  if (pathname === '/api/reports' && req.method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Kun administratoren kan se salg og økonomi');
    const sumByCurrency = records => ['DKK','EUR'].reduce((result,currency) => {
      result[currency] = records.filter(record => isPaidPayment(record) && recordedRevenueCurrency(record) === currency).reduce((sum,record) => sum + recordedRevenueAmount(record),0); return result;
    },{});
    const sumExpensesByCurrency = records => ['DKK','EUR'].reduce((result,currency) => { result[currency]=records.filter(record=>record.currency===currency).reduce((sum,record)=>sum+Number(record.amount||0),0); return result; },{});
    const addTrip = record => { const trip = db.trips.find(t => t.id === record.tripId); return { ...record, tripTitle: trip?.title || 'Ukendt tur', departureAt: trip?.departureAt || null, createdByName: userName(record.createdBy), paidByName:userName(record.paidByUserId||record.createdBy), checkedInByName:userName(record.checkedInBy), paymentRecordedByName:userName(record.paymentRecordedBy), cashHolderUserName:userName(record.cashHolderUserId), statusUpdatedByName:userName(record.statusUpdatedBy), reviewedByName:userName(record.reviewedBy), reimbursedByName:userName(record.reimbursedBy) }; };
    const cashByDriver = db.users.filter(u => ['driver','sales_manager'].includes(u.role)).map(driver => {
      const items=allCashItems().filter(item=>item.record.paymentStatus==='cash'&&['bus','departure','shop','budget'].includes(item.record.paymentLocation)&&item.record.cashHolderUserId===driver.id&&!item.record.cashHandedOverAt),budgetItems=items.filter(item=>item.kind==='budget');
      return { driverId: driver.id, driverName: driver.name, amounts: cashAvailableAmounts(items), grossAmounts:cashAmounts(items),expenseAmounts:cashExpenseTotalsForItems(items),budgetAmounts:cashAvailableAmounts(budgetItems),payments:items.length };
    }).filter(row => row.payments > 0);
    const approvedSettlements = db.cashSettlements.filter(settlement=>settlement.status==='approved');
    const cashAtOffice = ['DKK','EUR'].reduce((totals,currency)=>{totals[currency]=approvedSettlements.reduce((sum,settlement)=>sum+Number(settlement.delivered?.[currency]||0),0);return totals;},{});
    const soldTickets=db.passengers.filter(passenger=>passenger.journeyLeg!=='return');
    const tripResults = db.trips.map(trip => {
      const passengers=db.passengers.filter(p=>p.tripId===trip.id),baggage=db.baggage.filter(b=>b.tripId===trip.id),tripExpenses=db.expenses.filter(e=>e.tripId===trip.id);
      const revenueRecords=[...passengers,...baggage].filter(isPaidPayment);
      const ticketRevenue=sumByCurrency(passengers),baggageRevenue=sumByCurrency(baggage),revenue=sumByCurrency(revenueRecords),approvedExpenses=['DKK','EUR'].reduce((totals,currency)=>{totals[currency]=tripExpenses.filter(e=>e.status==='approved'&&e.currency===currency).reduce((sum,e)=>sum+Number(e.amount||0),0);return totals;},{}),pendingExpenses=['DKK','EUR'].reduce((totals,currency)=>{totals[currency]=tripExpenses.filter(e=>e.status==='pending'&&e.currency===currency).reduce((sum,e)=>sum+Number(e.amount||0),0);return totals;},{});
      const shopCash=sumByCurrency(revenueRecords.filter(record=>record.paymentLocation==='shop'));
      const handedOverCash=sumByCurrency(revenueRecords.filter(record=>['bus','departure','shop'].includes(record.paymentLocation)&&record.cashHandedOverAt));
      const heldRecords=revenueRecords.filter(record=>['bus','departure','shop'].includes(record.paymentLocation)&&record.cashHolderUserId&&!record.cashHandedOverAt),heldItems=heldRecords.map(record=>({kind:passengers.includes(record)?'passenger':'baggage',record})),heldCash=cashAvailableAmounts(heldItems);
      const holderIds=[...new Set(heldRecords.map(record=>record.cashHolderUserId))],cashByHolder=holderIds.map(holderId=>{const records=heldRecords.filter(record=>record.cashHolderUserId===holderId),items=records.map(record=>({kind:passengers.includes(record)?'passenger':'baggage',record}));return{userId:holderId,userName:userName(holderId),amounts:cashAvailableAmounts(items),grossAmounts:sumByCurrency(records),expenseAmounts:cashExpenseTotalsForItems(items),payments:records.length};});
      const categories=[...new Set(tripExpenses.map(expense=>expense.category))].map(category=>({category,approved:sumExpensesByCurrency(tripExpenses.filter(expense=>expense.category===category&&expense.status==='approved')),pending:sumExpensesByCurrency(tripExpenses.filter(expense=>expense.category===category&&expense.status==='pending'))}));
      const settlements=db.cashSettlements.filter(settlement=>settlement.tripId===trip.id);
      return { tripId:trip.id,title:trip.title,departureAt:trip.departureAt,busName:db.buses.find(b=>b.id===trip.busId)?.name||'Ingen bus',passengers:passengers.length,seatCount:trip.seatCount,occupancy:trip.seatCount?Math.round(passengers.length/trip.seatCount*100):0,unpaid:passengers.filter(isPendingPayment).length,paidTickets:passengers.filter(isPaidPayment).length,freeTickets:passengers.filter(p=>p.paymentStatus==='free').length,baggage:baggage.length,paidBaggage:baggage.filter(isPaidPayment).length,unpaidBaggage:baggage.filter(isPendingPayment).length,ticketRevenue,baggageRevenue,revenue,approvedExpenses,pendingExpenses,expenseCategories:categories,cashFlow:{shop:shopCash,handedOver:handedOverCash,held:heldCash,byHolder:cashByHolder},settlements:{pending:settlements.filter(item=>item.status==='pending').length,approved:settlements.filter(item=>item.status==='approved').length,rejected:settlements.filter(item=>item.status==='rejected').length},net:{DKK:revenue.DKK-approvedExpenses.DKK,EUR:revenue.EUR-approvedExpenses.EUR} };
    });
    return json(res, 200, {
      summary: {
        tickets: soldTickets.length, paidTickets: soldTickets.filter(isPaidPayment).length, freeTickets: soldTickets.filter(p => p.paymentStatus === 'free').length, unpaidTickets: soldTickets.filter(isPendingPayment).length,
        ticketRevenue: sumByCurrency(soldTickets), baggage: db.baggage.length, paidBaggage: db.baggage.filter(isPaidPayment).length, unpaidBaggage: db.baggage.filter(isPendingPayment).length, baggageRevenue: sumByCurrency(db.baggage), cashByDriver, cashAtOffice, expenseTotals: ['DKK','EUR'].reduce((totals,currency)=>{ totals[currency]=db.expenses.filter(e=>e.status==='approved'&&e.currency===currency).reduce((sum,e)=>sum+Number(e.amount||0),0); return totals; },{}), pendingExpenseTotals: ['DKK','EUR'].reduce((totals,currency)=>{ totals[currency]=db.expenses.filter(e=>e.status==='pending'&&e.currency===currency).reduce((sum,e)=>sum+Number(e.amount||0),0); return totals; },{})
      },
      tickets: soldTickets.map(addTrip), baggage: db.baggage.map(addTrip), expenses: db.expenses.map(addTrip), tripResults, ledger:financialLedger(), cashLedger:financialCashBalances()
    });
  }
  if (pathname === '/api/stops' && req.method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Kun administratoren kan oprette opsamlingssteder');
    const data = await body(req); if (!data.name?.trim()) return fail(res, 400, 'Navn mangler');
    const stop = { id: id(), name: data.name.trim(), address: String(data.address || '').trim() }; db.stops.push(stop); await saveDb(); return json(res, 201, stop);
  }
  if (pathname === '/api/drivers' && req.method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Kun administratoren kan oprette chauffører');
    const data = await body(req);
    const name = String(data.name || '').trim(); const email = String(data.email || '').trim().toLowerCase(); const password = String(data.password || '');
    if (!name || !email || !email.includes('@')) return fail(res, 400, 'Udfyld chaufførens navn og en gyldig e-mail');
    if (password.length < 12) return fail(res, 400, 'Adgangskoden skal være på mindst 12 tegn');
    if (db.users.some(u => u.email.toLowerCase() === email)) return fail(res, 409, 'E-mailadressen bruges allerede');
    const credentials = hashPassword(password);let portrait={file:null,type:null,name:null};
    if(data.portraitData)portrait=await storeImage({data:data.portraitData,type:data.portraitType,name:data.portraitName},{prefix:'driver'});
    const driver = { id: id(), name, email, role: 'driver', salt: credentials.salt, passwordHash: credentials.hash, portraitFile:portrait.file,portraitType:portrait.type,portraitName:portrait.name };
    db.users.push(driver); await saveDb(); return json(res, 201, cleanUser(driver));
  }
  if (pathname === '/api/sales-managers' && req.method === 'POST') {
    if (user.role !== 'admin') return fail(res,403,'Kun administratoren kan oprette salgschefer');
    const data=await body(req);const name=String(data.name||'').trim(),email=String(data.email||'').trim().toLowerCase(),password=String(data.password||''),salesOfficeName=String(data.salesOfficeName||'').trim(),salesOfficeCountry=String(data.salesOfficeCountry||'').trim().toUpperCase();
    if(!name||!email.includes('@'))return fail(res,400,'Udfyld salgschefens navn og en gyldig e-mail');
    if(password.length<12)return fail(res,400,'Adgangskoden skal være på mindst 12 tegn');
    if(db.users.some(candidate=>candidate.email.toLowerCase()===email))return fail(res,409,'E-mailadressen bruges allerede');
    if(salesOfficeCountry&&!['DK','DE','MK','OTHER'].includes(salesOfficeCountry))return fail(res,400,'Vælg et gyldigt land for salgsbutikken');
    const credentials=hashPassword(password),salesManager={id:id(),name,email,role:'sales_manager',salesOfficeName,salesOfficeCountry,salt:credentials.salt,passwordHash:credentials.hash};db.users.push(salesManager);await saveDb();return json(res,201,cleanUser(salesManager));
  }
  const salesManagerMatch=pathname.match(/^\/api\/sales-managers\/(\d+)$/);
  if(salesManagerMatch){
    if(user.role!=='admin')return fail(res,403,'Kun administratoren kan ændre salgschefer');
    const salesManager=db.users.find(candidate=>candidate.id===Number(salesManagerMatch[1])&&candidate.role==='sales_manager');if(!salesManager)return fail(res,404,'Salgschefen findes ikke');
    if(req.method==='PATCH'){
      const data=await body(req),name=String(data.name||'').trim(),salesOfficeName=String(data.salesOfficeName??salesManager.salesOfficeName??'').trim(),salesOfficeCountry=String(data.salesOfficeCountry??salesManager.salesOfficeCountry??'').trim().toUpperCase();if(!name)return fail(res,400,'Udfyld salgschefens navn');
      if((data.email&&String(data.email).trim().toLowerCase()!==salesManager.email)||data.password)return fail(res,403,'Salgschefen skal selv ændre e-mail og adgangskode under Min konto');
      if(salesOfficeCountry&&!['DK','DE','MK','OTHER'].includes(salesOfficeCountry))return fail(res,400,'Vælg et gyldigt land for salgsbutikken');
      Object.assign(salesManager,{name,salesOfficeName,salesOfficeCountry});await saveDb();return json(res,200,cleanUser(salesManager));
    }
    if(req.method==='DELETE'){
      const hasAuditHistory=db.passengers.some(passenger=>passenger.checkedInBy===salesManager.id||passenger.paymentRecordedBy===salesManager.id||passenger.cashHolderUserId===salesManager.id||(passenger.attendanceHistory||[]).some(event=>event.userId===salesManager.id||event.receivedBy===salesManager.id))||db.baggage.some(item=>item.createdBy===salesManager.id||item.paymentRecordedBy===salesManager.id||item.cashHolderUserId===salesManager.id||item.statusUpdatedBy===salesManager.id||(item.baggageHistory||[]).some(event=>event.userId===salesManager.id))||db.cashSettlements.some(settlement=>settlement.driverId===salesManager.id||settlement.submittedBy===salesManager.id)||db.cashTransfers.some(transfer=>[transfer.fromUserId||transfer.fromDriverId,transfer.toUserId||transfer.toDriverId,transfer.initiatedBy,transfer.respondedBy].includes(salesManager.id));
      if(db.trips.some(trip=>trip.salesManagerId===salesManager.id)||hasAuditHistory)return fail(res,409,'Salgschefen er knyttet til ture eller historik og kan derfor ikke slettes');db.users=db.users.filter(candidate=>candidate.id!==salesManager.id);await saveDb();return json(res,200,{ok:true});
    }
    return fail(res,405,'Handlingen er ikke tilladt');
  }
  const driverMatch = pathname.match(/^\/api\/drivers\/(\d+)$/);
  const driverPortraitMatch=pathname.match(/^\/api\/drivers\/(\d+)\/portrait$/);
  if(driverPortraitMatch&&req.method==='GET'){
    const driver=db.users.find(candidate=>candidate.id===Number(driverPortraitMatch[1])&&candidate.role==='driver');if(!driver)return fail(res,404,'Chaufføren findes ikke');return storedImage(res,driver.portraitFile,driver.portraitType);
  }
  if (driverMatch) {
    if (user.role !== 'admin') return fail(res, 403, 'Kun administratoren kan ændre chauffører');
    const driver = db.users.find(u => u.id === Number(driverMatch[1]) && u.role === 'driver');
    if (!driver) return fail(res, 404, 'Chaufføren findes ikke');
    if (req.method === 'PATCH') {
      const data = await body(req); const name = String(data.name || '').trim();
      if (!name) return fail(res, 400, 'Udfyld chaufførens navn');
      if((data.email&&String(data.email).trim().toLowerCase()!==driver.email)||data.password)return fail(res,403,'Chaufføren skal selv ændre e-mail og adgangskode under Min konto');
      driver.name = name;
      if(data.portraitData){const image=await storeImage({data:data.portraitData,type:data.portraitType,name:data.portraitName},{prefix:'driver'}),oldFile=driver.portraitFile;driver.portraitFile=image.file;driver.portraitType=image.type;driver.portraitName=image.name;if(oldFile!==image.file)await removeStoredFile(oldFile)}
      await saveDb(); return json(res, 200, cleanUser(driver));
    }
    if (req.method === 'DELETE') {
      const assigned = db.trips.some(t => t.primaryDriverId === driver.id || t.secondaryDriverId === driver.id);
      if (assigned) return fail(res, 409, 'Chaufføren er tildelt en tur og kan derfor ikke slettes');
      if(userHasOperationalHistory(driver.id))return fail(res,409,'Chaufføren har registreret historik, betalinger eller udgifter og kan derfor ikke slettes');
      await removeStoredFile(driver.portraitFile);db.users = db.users.filter(u => u.id !== driver.id); await saveDb(); return json(res, 200, { ok: true });
    }
    return fail(res, 405, 'Handlingen er ikke tilladt');
  }
  const stopMatch = pathname.match(/^\/api\/stops\/(\d+)$/);
  if (stopMatch) {
    if (user.role !== 'admin') return fail(res, 403, 'Kun administratoren kan ændre opsamlingssteder');
    const stop = db.stops.find(s => s.id === Number(stopMatch[1]));
    if (!stop) return fail(res, 404, 'Opsamlingsstedet findes ikke');
    if (req.method === 'PATCH') {
      const data = await body(req); if (!data.name?.trim()) return fail(res, 400, 'Navn mangler');
      stop.name = data.name.trim(); stop.address = String(data.address || '').trim(); await saveDb(); return json(res, 200, stop);
    }
    if (req.method === 'DELETE') {
      const inUse = db.trips.some(t => t.originId === stop.id || t.destinationId === stop.id || (t.timetable||[]).some(row=>row.stopId===stop.id)) || db.passengers.some(p => p.pickupStopId === stop.id || p.destinationStopId === stop.id) || db.baggage.some(b => b.pickupStopId === stop.id || b.destinationStopId === stop.id);
      if (inUse) return fail(res, 409, 'Stedet bruges allerede og kan derfor ikke slettes');
      db.stops = db.stops.filter(s => s.id !== stop.id); await saveDb(); return json(res, 200, { ok: true });
    }
    return fail(res, 405, 'Handlingen er ikke tilladt');
  }
  if (pathname === '/api/trips' && req.method === 'POST') {
    if (!['admin','sales_manager'].includes(user.role)) return fail(res, 403, 'Kun administratorer og salgschefer kan oprette ture');
    const data = await body(req); if (!data.title || !data.departureAt || !data.destinationArrivalAt || !data.originId || !data.destinationId || !data.primaryDriverId || !data.busId) return fail(res, 400, 'Udfyld turens obligatoriske felter, inklusive forventet ankomst ved slutstedet');
    const origin = db.stops.find(stop => stop.id === Number(data.originId));
    if (!isFixedStartPoint(origin)) return fail(res, 400, 'Turens startpunkt skal være København eller Tetovo');
    if(!db.stops.some(stop=>stop.id===Number(data.destinationId)))return fail(res,400,'Vælg et gyldigt slutsted');
    if(Number(data.originId)===Number(data.destinationId))return fail(res,400,'Start- og slutsted skal være forskellige');
    if (Number(data.primaryDriverId) === Number(data.secondaryDriverId)) return fail(res, 400, 'De to chauffører skal være forskellige');
    const primaryDriver=db.users.find(candidate=>candidate.id===Number(data.primaryDriverId)&&candidate.role==='driver'),secondaryDriver=data.secondaryDriverId?db.users.find(candidate=>candidate.id===Number(data.secondaryDriverId)&&candidate.role==='driver'):null;
    if(!primaryDriver||(data.secondaryDriverId&&!secondaryDriver))return fail(res,400,'Vælg gyldige chauffører fra chaufførregisteret');
    const bus = db.buses.find(b => b.id === Number(data.busId)); if (!bus) return fail(res, 400, 'Vælg en gyldig bus');
    const salesManagerId=user.role==='admin'&&data.salesManagerId?Number(data.salesManagerId):null;if(salesManagerId&&!db.users.some(candidate=>candidate.id===salesManagerId&&candidate.role==='sales_manager'))return fail(res,400,'Vælg en gyldig salgschef på vagt');
    const departureAt = new Date(data.departureAt);if(Number.isNaN(departureAt.getTime()))return fail(res,400,'Vælg en gyldig afgangstid');
    const destinationAt = new Date(data.destinationArrivalAt);if(Number.isNaN(destinationAt.getTime()))return fail(res,400,'Vælg en gyldig forventet ankomsttid ved slutstedet');
    if(destinationAt<=departureAt)return fail(res,400,'Ankomsten ved slutstedet skal ligge efter afgangen fra startstedet');
    const durationMinutes=Math.round((destinationAt-departureAt)/60000);
    const timetable = [{ stopId: Number(data.originId), arrivalAt: departureAt.toISOString(), departureAt: departureAt.toISOString() }];
    if (Number(data.destinationId) !== Number(data.originId)) timetable.push({ stopId: Number(data.destinationId), arrivalAt: destinationAt.toISOString(), departureAt: destinationAt.toISOString() });
    const trip = { id: id(), title: data.title.trim(), departureAt: departureAt.toISOString(), destinationArrivalAt: destinationAt.toISOString(), durationMinutes, originId: Number(data.originId), destinationId: Number(data.destinationId), timetable, basePrice: Number(data.basePrice || 0), busId: bus.id, seatCount: bus.seatCount, primaryDriverId: Number(data.primaryDriverId), secondaryDriverId: data.secondaryDriverId ? Number(data.secondaryDriverId) : null, salesManagerId, status: 'planned', boardingStartedAt:null,boardingStartedBy:null,boardingSource:null,automaticBoardingRecordedAt:null,startedAt:null,startedBy:null,startSource:null,automaticStartRecordedAt:null,arrivedAt:null,arrivedBy:null,arrivalSource:null,automaticArrivalRecordedAt:null };
    db.trips.push(trip); audit(user,'trip.created','trip',trip.id,trip.id,{title:trip.title,salesManagerOnDutyId:salesManagerId}); await saveDb(); return json(res, 201, tripView(trip));
  }
  const expenseMatch = pathname.match(/^\/api\/expenses\/(\d+)$/);
  if (expenseMatch && req.method === 'PATCH') {
    const expense=db.expenses.find(e=>e.id===Number(expenseMatch[1]));if(!expense)return fail(res,404,'Udgiften findes ikke');
    const data=await body(req);
    const lockedExpenseTrip=db.trips.find(candidate=>candidate.id===expense.tripId);if(lockedExpenseTrip?.status==='completed'&&!data.forwardToSalesManagerId)return fail(res,409,'Turens økonomi er afsluttet. Genåbn turen før ændringer');
    if(data.forwardToSalesManagerId){
      if(user.role!=='driver'||!lockedExpenseTrip||!allowedTrip(user,lockedExpenseTrip)||![expense.createdBy,expense.paidByUserId].includes(user.id))return fail(res,403,'Kun chaufføren, som registrerede eller betalte udgiften, kan sende bilaget');
      if(!expense.receiptFile)return fail(res,409,'Tilføj en kvittering, før udgiften sendes til en salgschef');
      const salesManager=db.users.find(candidate=>candidate.id===Number(data.forwardToSalesManagerId)&&candidate.role==='sales_manager');if(!salesManager)return fail(res,400,'Vælg en gyldig salgschef');
      expense.forwardedToSalesManagerId=salesManager.id;expense.forwardedAt=new Date().toISOString();expense.forwardedBy=user.id;audit(user,'expense.forwarded_to_sales','expense',expense.id,expense.tripId,{salesManagerId:salesManager.id});await saveDb();return json(res,200,expenseRecordView(expense));
    }
    if (data.edit === true) {
      const expenseTrip=db.trips.find(candidate=>candidate.id===expense.tripId);
      if(!expenseTrip||!allowedTrip(user,expenseTrip)||(expense.expenseScope==='sales_preparation'&&user.role!=='admin'&&expense.createdBy!==user.id)||(user.role==='sales_manager'&&expense.createdBy!==user.id))return fail(res,403,'Du har ikke adgang til at rette udgiften');
      if(expense.reimbursementStatus==='paid')return fail(res,409,'En tilbagebetalt udgift kan ikke ændres');
      const reason=correctionReason(data);if(!reason)return fail(res,400,'Skriv kort, hvorfor udgiften rettes');
      const forcedSalesCash=expense.expenseScope==='sales_preparation'||user.role==='sales_manager',amount=Number(data.amount),currency=['DKK','EUR'].includes(data.currency)?data.currency:null,category=String(data.category||'').trim(),paymentMethod=forcedSalesCash?'cash':['company_card','cash','private'].includes(data.paymentMethod)?data.paymentMethod:null;
      if(!(amount>0)||!currency||!category||!paymentMethod)return fail(res,400,'Angiv kategori, beløb, valuta og betalingsmetode');
      const allowedPayers=[expenseTrip.primaryDriverId,expenseTrip.secondaryDriverId,expense.createdBy,user.id].filter(Boolean),paidByUserId=Number(data.paidByUserId||expense.paidByUserId);
      if(!allowedPayers.includes(paidByUserId)&&user.role!=='admin')return fail(res,400,'Vælg en medarbejder med ansvar på turen');
      const paidByUser=db.users.find(candidate=>candidate.id===paidByUserId);if(!paidByUser)return fail(res,400,'Vælg en gyldig betaler');
      const existingCashBoxUserId=expense.cashBoxUserId,locked=(expense.cashPaymentAllocations||[]).some(allocation=>{const item=cashRecordByReference(allocation.reference,expense.tripId);return !item||item.record.cashHolderUserId!==existingCashBoxUserId||item.record.cashHandedOverAt||hasPendingSettlementReference(allocation.reference)||hasPendingTransferReference(allocation.reference)});
      if(locked)return fail(res,409,'Udgiften er låst, fordi de tilknyttede kontanter er overført eller afstemt');
      const cashBoxUserId=paymentMethod==='cash'&&['driver','sales_manager'].includes(paidByUser.role)?paidByUserId:null,cashPaymentAllocations=cashBoxUserId?allocateCashExpense(expense.tripId,cashBoxUserId,currency,amount,expense.id):[];
      if(cashBoxUserId&&!cashPaymentAllocations)return fail(res,409,'Der er ikke nok disponible kontanter i medarbejderens kasse til det rettede beløb');
      const updates={category,description:String(data.description||'').trim(),amount,currency,paymentMethod,paidByUserId,cashBoxUserId,cashPaymentAllocations};
      if(expense.expenseScope==='sales_preparation')updates.expenseScope='sales_preparation';
      const changes=changedFields(expense,updates);if(!Object.keys(changes).length)return fail(res,400,'Der er ingen ændringer at gemme');
      if(expense.status==='approved')postExpenseReversal(expense,user,reason);Object.assign(expense,updates);expense.editHistory=expense.editHistory||[];expense.editHistory.push({editedAt:new Date().toISOString(),editedBy:user.id,reason,changes});
      if(expense.status!=='pending'){expense.status='pending';expense.reviewedAt=null;expense.reviewedBy=null;expense.reviewNote='Genåbnet efter rettelse';}
      expense.reimbursementStatus=paymentMethod==='private'?(expense.reimbursementStatus==='paid'?'paid':'pending'):'not_applicable';
      await saveDb();return json(res,200,expenseRecordView(expense));
    }
    if(data.receiptData){
      const expenseTrip=db.trips.find(trip=>trip.id===expense.tripId);if(!expenseTrip||!allowedTrip(user,expenseTrip)||(expense.expenseScope==='sales_preparation'&&user.role!=='admin'&&expense.createdBy!==user.id)||(user.role==='sales_manager'&&expense.createdBy!==user.id))return fail(res,403,'Du har ikke adgang til udgiften');
      const receiptType=String(data.receiptType||''),receiptName=path.basename(String(data.receiptName||'kvittering'));if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(receiptType))return fail(res,400,'Kvitteringen skal være PDF, JPG, PNG eller WebP');const encoded=String(data.receiptData).replace(/^data:[^;]+;base64,/,'');const fileData=Buffer.from(encoded,'base64');if(!fileData.length||fileData.length>5*1024*1024)return fail(res,400,'Kvitteringen skal være mellem 1 byte og 5 MB');const extensions={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','application/pdf':'.pdf'},receiptFile=`${crypto.randomBytes(18).toString('hex')}${extensions[receiptType]}`;await storeFile(receiptFile,fileData,receiptType);expense.receiptType=receiptType;expense.receiptName=receiptName;expense.receiptFile=receiptFile;expense.receiptOriginalBytes=Number(data.receiptOriginalBytes||fileData.length);expense.receiptStoredBytes=fileData.length;expense.receiptOptimized=data.receiptOptimized===true||data.receiptOptimized==='true';await saveDb();return json(res,200,{...expense,createdByName:userName(expense.createdBy),paidByName:userName(expense.paidByUserId||expense.createdBy),reviewedByName:userName(expense.reviewedBy)});
    }
    if (user.role !== 'admin') return fail(res,403,'Kun administratoren kan godkende udgifter');
    if(data.reimbursementStatus==='paid'){
      if((expense.paymentMethod||'cash')!=='private')return fail(res,409,'Kun private udlæg kan tilbagebetales');
      if(expense.status!=='approved')return fail(res,409,'Udlægget skal godkendes før tilbagebetaling');
      if(expense.reimbursementStatus==='paid')return fail(res,409,'Udlægget er allerede tilbagebetalt');
      expense.reimbursementStatus='paid';expense.reimbursedAt=new Date().toISOString();expense.reimbursedBy=user.id;await saveDb();return json(res,200,{...expense,createdByName:userName(expense.createdBy),paidByName:userName(expense.paidByUserId||expense.createdBy),reviewedByName:userName(expense.reviewedBy),reimbursedByName:user.name});
    }
    if(!['approved','rejected'].includes(data.status))return fail(res,400,'Vælg godkendt eller afvist');
    if(expense.status!=='pending')return fail(res,409,'Udgiften er allerede behandlet');
    if(data.status==='approved'&&!expense.receiptFile)return fail(res,409,'Tilføj en kvittering før udgiften godkendes');
    expense.status=data.status;expense.reviewedAt=new Date().toISOString();expense.reviewedBy=user.id;expense.reviewNote=String(data.reviewNote||'').trim();if(data.status==='approved')postExpense(expense,user.id);audit(user,`expense.${data.status}`,'expense',expense.id,expense.tripId,{amount:expense.amount,currency:expense.currency});await saveDb();return json(res,200,{...expense,createdByName:userName(expense.createdBy),paidByName:userName(expense.paidByUserId||expense.createdBy),reviewedByName:user.name});
  }
  const receiptMatch = pathname.match(/^\/api\/expenses\/(\d+)\/receipt$/);
  if (receiptMatch && req.method === 'GET') {
    const expense = db.expenses.find(e => e.id === Number(receiptMatch[1])); if (!expense || !expense.receiptFile) return fail(res, 404, 'Kvitteringen findes ikke');
    const expenseTrip = db.trips.find(t => t.id === expense.tripId); if (!expenseTrip || (!allowedTrip(user,expenseTrip)&&expense.forwardedToSalesManagerId!==user.id)) return fail(res, 403, 'Du har ikke adgang til kvitteringen');
    if(expense.expenseScope==='sales_preparation'&&user.role!=='admin'&&expense.createdBy!==user.id)return fail(res,403,'Kun administratoren og salgschefen har adgang til dette forberedelsesbilag');
    if(user.role==='sales_manager'&&expense.createdBy!==user.id&&expense.forwardedToSalesManagerId!==user.id)return fail(res,403,'Du har kun adgang til dine egne eller videresendte udgiftsbilag');
    return serveStoredFile(res,expense.receiptFile,expense.receiptType,expense.receiptName);
  }
  const baggagePhotoMatch = pathname.match(/^\/api\/baggage\/(\d+)\/photo$/);
  if (baggagePhotoMatch && req.method === 'GET') {
    const item = db.baggage.find(candidate => candidate.id === Number(baggagePhotoMatch[1])); if (!item || !item.photoFile) return fail(res,404,'Bagagebilledet findes ikke');
    const photoTrip = db.trips.find(candidate => candidate.id === item.tripId); if (!photoTrip || !allowedTrip(user,photoTrip)) return fail(res,403,'Du har ikke adgang til bagagebilledet');
    if (user.role === 'sales_manager' && item.pickupStopId !== photoTrip.originId) return fail(res,403,'Salgschefen kan kun se bagage fra turens startsted');
    return serveStoredFile(res,item.photoFile,item.photoType,item.photoName);
  }
  const match = pathname.match(/^\/api\/trips\/(\d+)(?:\/(passengers|group-bookings|baggage|seats|expenses|settlements|transfers|notifications|ticket-scan))?$/);
  if (!match) return fail(res, 404, 'Ikke fundet');
  const trip = db.trips.find(t => t.id === Number(match[1])); if (!trip) return fail(res, 404, 'Turen findes ikke');
  if (!allowedTrip(user, trip)) return fail(res, 403, 'Du har ikke adgang til denne tur');
  const part = match[2];
  if (!part && req.method === 'DELETE') {
    if (user.role !== 'admin') return fail(res,403,'Kun administratoren kan slette en tur');
    const linked = {
      passengers: db.passengers.some(record => record.tripId === trip.id),
      baggage: db.baggage.some(record => record.tripId === trip.id),
      expenses: db.expenses.some(record => record.tripId === trip.id),
      settlements: db.cashSettlements.some(record => record.tripId === trip.id),
      transfers: db.cashTransfers.some(record => record.tripId === trip.id),
      budgetEntries: (db.cashBudgetEntries || []).some(record => record.tripId === trip.id)
    };
    const hasLinkedRecords=Object.values(linked).some(Boolean);
    if (hasLinkedRecords && trip.status !== 'cancelled') return fail(res,409,'Turen har registrerede data og skal annulleres, før den kan slettes');
    let deletionReason='Tom tur oprettet ved en fejl';
    if (hasLinkedRecords) {
      const data=await body(req),confirmation=String(data.confirmation||'').trim().toUpperCase();
      deletionReason=String(data.deletionReason||'').trim();
      if(confirmation!=='SLET')return fail(res,409,'Skriv SLET for at bekræfte permanent sletning');
      if(deletionReason.length<3)return fail(res,400,'Skriv kort, hvorfor den annullerede tur slettes');
    }
    const directPassengers=db.passengers.filter(record=>record.tripId===trip.id),directPassengerIds=new Set(directPassengers.map(record=>record.id)),removePassengerIds=new Set(directPassengerIds);
    for(const passenger of directPassengers){
      if(passenger.returnPassengerId){const linkedReturn=db.passengers.find(record=>record.id===passenger.returnPassengerId);if(linkedReturn)removePassengerIds.add(linkedReturn.id)}
      if(passenger.outboundPassengerId){const outbound=db.passengers.find(record=>record.id===passenger.outboundPassengerId&&!directPassengerIds.has(record.id));if(outbound){outbound.ticketType='return_open';outbound.returnStatus='open';outbound.returnTripId=null;outbound.returnPassengerId=null;outbound.openReturnValidUntil=outbound.openReturnValidUntil||new Date(new Date().setFullYear(new Date().getFullYear()+1)).toISOString()}}
    }
    for(const passenger of db.passengers)if(passenger.outboundPassengerId&&directPassengerIds.has(passenger.outboundPassengerId))removePassengerIds.add(passenger.id);
    const removedPassengers=db.passengers.filter(record=>removePassengerIds.has(record.id)),removedBaggage=db.baggage.filter(record=>record.tripId===trip.id),removedExpenses=db.expenses.filter(record=>record.tripId===trip.id),removedSettlements=db.cashSettlements.filter(record=>record.tripId===trip.id),removedTransfers=db.cashTransfers.filter(record=>record.tripId===trip.id),removedTransferIds=new Set(removedTransfers.map(record=>record.id)),removedBudgetEntries=(db.cashBudgetEntries||[]).filter(record=>record.tripId===trip.id||removedTransferIds.has(record.transferId)),removedNotifications=db.notificationDrafts.filter(record=>record.tripId===trip.id),filesToRemove=[...removedBaggage.map(record=>record.photoFile),...removedExpenses.map(record=>record.receiptFile)].filter(Boolean);
    const summary={title:trip.title,reason:deletionReason,status:trip.status,passengers:removedPassengers.length,baggage:removedBaggage.length,expenses:removedExpenses.length,settlements:removedSettlements.length,transfers:removedTransfers.length,budgetEntries:removedBudgetEntries.length,notifications:removedNotifications.length};
    audit(user,'trip.deleted','trip',trip.id,trip.id,summary);
    db.passengers=db.passengers.filter(record=>!removePassengerIds.has(record.id));db.baggage=db.baggage.filter(record=>record.tripId!==trip.id);db.expenses=db.expenses.filter(record=>record.tripId!==trip.id);db.cashSettlements=db.cashSettlements.filter(record=>record.tripId!==trip.id);db.cashTransfers=db.cashTransfers.filter(record=>record.tripId!==trip.id);db.cashBudgetEntries=(db.cashBudgetEntries||[]).filter(record=>record.tripId!==trip.id&&!removedTransferIds.has(record.transferId));db.notificationDrafts=db.notificationDrafts.filter(record=>record.tripId!==trip.id);db.trips=db.trips.filter(record=>record.id!==trip.id);
    await saveDb();await Promise.all(filesToRemove.map(removeStoredFile));return json(res,200,{ok:true,deleted:summary});
  }
  if (!part && req.method === 'PATCH') {
    const data = await body(req);
    if (data.operationalAction) {
      const action=String(data.operationalAction),at=new Date().toISOString(),note=String(data.note||'').trim();
      if(trip.status!=='planned')return fail(res,409,'Driftsstatus kan kun ændres på en aktiv tur');
      if(action==='start_boarding'){
        if(!canOperateTrip(user,trip))return fail(res,403,'Kun administratoren, en tildelt chauffør eller salgschefen på vagt kan åbne check-in');
        if(trip.boardingStartedAt)return json(res,200,tripView(trip));
        trip.boardingStartedAt=at;trip.boardingStartedBy=user.id;trip.boardingSource='manual';
      }else if(action==='start_trip'){
        if(!['admin','driver'].includes(user.role))return fail(res,403,'Kun en tildelt chauffør eller administrator kan starte turen');
        if(!trip.boardingStartedAt)return fail(res,409,'Åbn check-in, før turen startes');
        if(!departureChecklistComplete(trip))return failDetails(res,409,'Afgangskontrollen er ikke færdig',{blockers:{departureChecklist:Object.keys(DEPARTURE_CHECKLIST_ITEMS).filter(key=>!trip.departureChecklist?.[key]?.checked)}});
        if(trip.startedAt)return json(res,200,tripView(trip));
        trip.startedAt=at;trip.startedBy=user.id;trip.startSource='manual';trip.automaticStartRecordedAt=null;
      }else if(action==='mark_arrived'){
        if(!['admin','driver'].includes(user.role))return fail(res,403,'Kun en tildelt chauffør eller administrator kan registrere ankomst');
        if(!trip.startedAt)return fail(res,409,'Turen skal være startet, før den kan markeres som ankommet');
        if(trip.arrivedAt)return json(res,200,tripView(trip));
        trip.arrivedAt=at;trip.arrivedBy=user.id;trip.arrivalSource='manual';trip.automaticArrivalRecordedAt=null;
      }else return fail(res,400,'Vælg en gyldig driftshandling');
      trip.lifecycleHistory=trip.lifecycleHistory||[];trip.lifecycleHistory.push({action,at,userId:user.id,note});audit(user,`trip.${action}`,'trip',trip.id,trip.id,{note});await saveDb();return json(res,200,tripView(trip));
    }
    if (Object.prototype.hasOwnProperty.call(data,'passengerListClosed')) {
      if(user.role!=='driver')return fail(res,403,'Kun en tildelt chauffør kan afslutte passagerlisten');
      if(data.passengerListClosed!==true)return fail(res,400,'Passagerlisten kan kun afsluttes, når alle passagerer er behandlet');
      if(trip.status!=='planned')return fail(res,409,'Passagerlisten kan kun afsluttes på en aktiv tur');
      const pending=db.passengers.filter(item=>item.tripId===trip.id&&!item.checkedIn&&item.attendanceStatus!=='no_show').map(item=>({id:item.id,name:item.name,seatNumber:item.seatNumber,pickupStopId:item.pickupStopId}));
      if(pending.length)return failDetails(res,409,'Alle passagerer skal være checket ind eller markeret som udeblevet',{blockers:{passengers:pending}});
      if(!trip.startedAt)return fail(res,409,'Turen skal være startet, før passagerlisten kan afsluttes');
      const at=new Date().toISOString();trip.passengerListClosedAt=at;trip.passengerListClosedBy=user.id;trip.passengerListCloseNote=String(data.note||'').trim();
      audit(user,'trip.passenger_list_closed','trip',trip.id,trip.id,{passengers:db.passengers.filter(item=>item.tripId===trip.id).length,note:trip.passengerListCloseNote});await saveDb();return json(res,200,tripView(trip));
    }
    if (Object.prototype.hasOwnProperty.call(data,'status')) {
      if(data.status==='completed'){
        if(user.role!=='admin'&&!assignedDriver(user,trip))return fail(res,403,'Kun administratoren eller en tildelt chauffør kan afslutte turen');
        if(trip.status!=='planned')return fail(res,409,'Kun en aktiv tur kan afsluttes');
        const blockers=tripCloseBlockers(trip);if(hasCloseBlockers(blockers))return failDetails(res,409,'Turen kan ikke afsluttes endnu',{blockers});
        const note=String(data.closeNote||'').trim(),at=new Date().toISOString();trip.status='completed';trip.closedAt=at;trip.closedBy=user.id;trip.closeNote=note;trip.operationsLockedAt=at;trip.economyLockedAt=null;trip.lifecycleHistory=trip.lifecycleHistory||[];trip.lifecycleHistory.push({action:'closed',at,userId:user.id,note});const automaticZeroSettlements=createAutomaticZeroSettlements(trip,user,at);audit(user,'trip.closed','trip',trip.id,trip.id,{note,automaticZeroSettlements:automaticZeroSettlements.length,cashStillHeld:cashBoxes(trip.id).length});await saveDb();return json(res,200,tripView(trip));
      }
      if (user.role !== 'admin') return fail(res,403,'Kun administratoren kan ændre turens status');
      if(data.status==='planned'&&trip.status==='completed'){
        const reason=String(data.reopenReason||'').trim();if(reason.length<3)return fail(res,400,'Skriv en begrundelse for genåbningen');
        const at=new Date().toISOString();trip.status='planned';trip.reopenedAt=at;trip.reopenedBy=user.id;trip.reopenReason=reason;trip.operationsLockedAt=null;trip.economyLockedAt=null;trip.lifecycleHistory=trip.lifecycleHistory||[];trip.lifecycleHistory.push({action:'reopened',at,userId:user.id,reason});audit(user,'trip.reopened','trip',trip.id,trip.id,{reason});await saveDb();return json(res,200,tripView(trip));
      }
      if(data.status!=='cancelled')return fail(res,400,'Ugyldig turstatus');
      if(trip.status==='completed')return fail(res,409,'Genåbn turen før den annulleres');
      if (trip.status === 'cancelled') return fail(res,409,'Turen er allerede annulleret');
      const reason = String(data.cancellationReason || '').trim(); if (reason.length < 3) return fail(res,400,'Skriv en begrundelse for annulleringen');
      trip.status='cancelled';trip.cancellationReason=reason;trip.cancelledAt=new Date().toISOString();trip.cancelledBy=user.id;audit(user,'trip.cancelled','trip',trip.id,trip.id,{reason});cancellationNotificationDrafts(trip,user);await saveDb();return json(res,200,tripView(trip));
    }
    if (trip.status === 'completed') return fail(res,409,'Turen er afsluttet og låst. Genåbn turen før ændringer');
    if (trip.status === 'cancelled') return fail(res,409,'Turen er annulleret og kan ikke ændres');
    if (data.departureChecklistItem) {
      const key=String(data.departureChecklistItem),definition=DEPARTURE_CHECKLIST_ITEMS[key];
      if(!definition)return fail(res,400,'Vælg et gyldigt punkt i afgangskontrollen');
      if(user.role==='sales_manager'&&!salesManagerOnDuty(user,trip))return fail(res,403,'Kun salgschefen på vagt kan udføre afgangskontrol på turen');
      if(!definition.roles.includes(user.role))return fail(res,403,'Dette kontrolpunkt skal godkendes af en tildelt chauffør eller administrator');
      const checked=data.checked===true,at=new Date().toISOString();trip.departureChecklist=trip.departureChecklist||{};
      if(checked)trip.departureChecklist[key]={checked:true,checkedAt:at,checkedBy:user.id,note:String(data.note||'').trim()};
      else delete trip.departureChecklist[key];
      audit(user,checked?'trip.departure_check_completed':'trip.departure_check_reopened','trip',trip.id,trip.id,{key,note:String(data.note||'').trim()});
      await saveDb();return json(res,200,tripView(trip));
    }
    if (Object.prototype.hasOwnProperty.call(data,'timetable')) {
      if (user.role !== 'admin') return fail(res,403,'Kun administratoren kan ændre turens tidtabel');
      if (!Array.isArray(data.timetable) || data.timetable.length < 1) return fail(res,400,'Tidsplanen skal indeholde mindst ét stoppested');
      const timetable = [], stopIds = new Set();
      for (const row of data.timetable) {
        const stopId = Number(row.stopId), isOrigin=stopId===trip.originId, isDestination=stopId===trip.destinationId, arrival = new Date(isOrigin?row.departureAt:row.arrivalAt), departure = new Date(isDestination?row.arrivalAt:row.departureAt);
        if (!db.stops.some(stop => stop.id === stopId)) return fail(res,400,'Tidsplanen indeholder et ukendt opsamlingssted');
        if (stopIds.has(stopId)) return fail(res,400,'Et opsamlingssted må kun stå én gang i tidsplanen');
        if (Number.isNaN(arrival.getTime()) || Number.isNaN(departure.getTime())) return fail(res,400,isOrigin?'Angiv afgang ved startstedet':isDestination?'Angiv ankomst ved slutstedet':'Angiv både ankomst og afgang ved alle mellemstop');
        if (arrival > departure) return fail(res,400,'Afgang kan ikke ligge før ankomst');
        stopIds.add(stopId); timetable.push({ stopId, arrivalAt: arrival.toISOString(), departureAt: departure.toISOString() });
      }
      timetable.sort((left,right) => new Date(left.arrivalAt) - new Date(right.arrivalAt));
      if (!stopIds.has(trip.originId) || !stopIds.has(trip.destinationId)) return fail(res,400,'Start- og slutsted skal være med i tidsplanen');
      for (let index=1; index<timetable.length; index++) if (new Date(timetable[index].arrivalAt) < new Date(timetable[index-1].departureAt)) return fail(res,400,'Tiderne skal følge stoppestedernes rækkefølge');
      trip.timetable = timetable;
      trip.departureAt = timetable.find(row => row.stopId === trip.originId)?.departureAt || trip.departureAt;
      trip.destinationArrivalAt = timetable.find(row => row.stopId === trip.destinationId)?.arrivalAt || trip.destinationArrivalAt;
      trip.durationMinutes = Math.round((new Date(trip.destinationArrivalAt)-new Date(trip.departureAt))/60000);
      await saveDb(); return json(res,200,tripView(trip));
    }
    if (data.completedStopId) {
      const stopId = Number(data.completedStopId); if (!db.stops.some(s => s.id === stopId)) return fail(res,400,'Opsamlingsstedet findes ikke');
      if(!canOperateTrip(user,trip))return fail(res,403,'Kun administratoren, en tildelt chauffør eller salgschefen på vagt kan afslutte et stoppested');
      trip.completedStopIds = trip.completedStopIds || []; if (!trip.completedStopIds.includes(stopId)) trip.completedStopIds.push(stopId); await saveDb(); return json(res,200,tripView(trip));
    }
    if (Object.prototype.hasOwnProperty.call(data,'salesManagerId')) {
      if(user.role!=='admin')return fail(res,403,'Kun administratoren kan vælge salgschef på vagt');
      const checkInStarted=db.passengers.some(passenger=>passenger.tripId===trip.id&&(passenger.checkedIn||passenger.attendanceHistory?.some(event=>event.action==='checked_in')));if(checkInStarted)return fail(res,409,'Salgschefen på vagt er låst, fordi check-in er begyndt på turen');
      const salesManagerId=data.salesManagerId?Number(data.salesManagerId):null;if(salesManagerId&&!db.users.some(candidate=>candidate.id===salesManagerId&&candidate.role==='sales_manager'))return fail(res,400,'Vælg en gyldig salgschef på vagt');
      trip.salesManagerId=salesManagerId;audit(user,'trip.sales_manager_on_duty_changed','trip',trip.id,trip.id,{salesManagerOnDutyId:salesManagerId});await saveDb();return json(res,200,tripView(trip));
    }
    if (Object.prototype.hasOwnProperty.call(data,'primaryDriverId') || Object.prototype.hasOwnProperty.call(data,'secondaryDriverId')) {
      if (user.role !== 'admin') return fail(res,403,'Kun administratoren kan ændre chauffører på en tur');
      const checkInStarted = db.passengers.some(passenger => passenger.tripId === trip.id && (passenger.checkedIn || passenger.attendanceHistory?.some(event => event.action === 'checked_in')));
      if (checkInStarted) return fail(res,409,'Chaufførerne er låst, fordi check-in er begyndt på turen');
      const primaryDriverId = Number(data.primaryDriverId); const secondaryDriverId = data.secondaryDriverId ? Number(data.secondaryDriverId) : null;
      const primaryDriver = db.users.find(candidate => candidate.id === primaryDriverId && candidate.role === 'driver');
      const secondaryDriver = secondaryDriverId ? db.users.find(candidate => candidate.id === secondaryDriverId && candidate.role === 'driver') : null;
      if (!primaryDriver || (secondaryDriverId && !secondaryDriver)) return fail(res,400,'Vælg gyldige chauffører fra chaufførregisteret');
      if (primaryDriverId === secondaryDriverId) return fail(res,400,'Primær og sekundær chauffør skal være forskellige');
      trip.primaryDriverId = primaryDriverId; trip.secondaryDriverId = secondaryDriverId; await saveDb(); return json(res,200,tripView(trip));
    }
    if (data.busId) {
      if (user.role !== 'admin') return fail(res,403,'Kun administratoren kan skifte bus');
      const bus = db.buses.find(b=>b.id===Number(data.busId)); if(!bus)return fail(res,404,'Bussen findes ikke');
      const highestBookedSeat = Math.max(0,...db.passengers.filter(p=>p.tripId===trip.id).flatMap(p=>[p.seatNumber,p.extraSeatNumber||0])); if(bus.seatCount<highestBookedSeat)return fail(res,409,`Sæde ${highestBookedSeat} er allerede reserveret og findes ikke i den valgte bus`);
      trip.busId=bus.id;trip.seatCount=bus.seatCount;await saveDb();return json(res,200,tripView(trip));
    }
    if (user.role !== 'admin') return fail(res, 403, 'Kun administratoren kan ændre antal sæder');
    const seatCount = Number(data.seatCount);
    if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > 84) return fail(res, 400, 'Antal sæder skal være mellem 1 og 84');
    const highestBookedSeat = Math.max(0, ...db.passengers.filter(p => p.tripId === trip.id).flatMap(p => [p.seatNumber,p.extraSeatNumber||0]));
    if (seatCount < highestBookedSeat) return fail(res, 409, `Der er allerede booket sæde ${highestBookedSeat}. Kapaciteten kan ikke sættes lavere.`);
    trip.seatCount = seatCount; await saveDb(); return json(res, 200, tripView(trip));
  }
  if (!part && req.method === 'GET') {
    const settlements=db.cashSettlements.filter(settlement=>settlement.tripId===trip.id&&(user.role!=='sales_manager'||settlement.driverId===user.id)).map(settlement=>({...settlement,driverName:db.users.find(candidate=>candidate.id===settlement.driverId)?.name||'Ukendt',submittedByName:db.users.find(candidate=>candidate.id===settlement.submittedBy)?.name||'Ukendt',reviewedByName:settlement.reviewedBy?db.users.find(candidate=>candidate.id===settlement.reviewedBy)?.name||'Ukendt':null}));
    const expenses=db.expenses.filter(expense=>expense.tripId===trip.id&&(user.role!=='sales_manager'||expense.createdBy===user.id||expense.forwardedToSalesManagerId===user.id)&&(user.role!=='driver'||expense.expenseScope!=='sales_preparation')).map(expenseRecordView);
    const transfers=db.cashTransfers.filter(transfer=>transfer.tripId===trip.id&&(user.role==='admin'||[transfer.fromUserId||transfer.fromDriverId,transfer.toUserId||transfer.toDriverId].includes(user.id))).map(transfer=>cashTransferView(transfer,user));
    const notifications=['admin','sales_manager'].includes(user.role)?db.notificationDrafts.filter(item=>item.tripId===trip.id).map(item=>({...item,createdByName:userName(item.createdBy),archivedByName:userName(item.archivedBy)})):[];
    return json(res,200,{trip:tripView(trip),passengers:db.passengers.filter(passenger=>passenger.tripId===trip.id).map(passengerRecordView),baggage:db.baggage.filter(item=>item.tripId===trip.id).map(baggageRecordView),expenses,settlements,transfers,notifications,cashBoxes:cashBoxes(trip.id),seats:seatMap(trip.id)});
  }
  if(part==='notifications'&&req.method==='PATCH'){
    if(!['admin','sales_manager'].includes(user.role))return fail(res,403,'Kun administrator og salgschef kan behandle beskedkladder');
    const data=await body(req),draft=db.notificationDrafts.find(item=>item.id===Number(data.id)&&item.tripId===trip.id);if(!draft)return fail(res,404,'Beskedkladden findes ikke');
    if(data.status!=='archived')return fail(res,400,'Beskedkladden kan kun arkiveres, indtil en beskedtjeneste er tilkoblet');
    draft.status='archived';draft.archivedAt=new Date().toISOString();draft.archivedBy=user.id;audit(user,'notification.draft_archived','notification',draft.id,trip.id,{type:draft.type});await saveDb();return json(res,200,{...draft,createdByName:userName(draft.createdBy),archivedByName:userName(draft.archivedBy)});
  }
  const retrospectiveSale = user.role === 'sales_manager' && req.method === 'POST' && ['passengers','group-bookings','baggage'].includes(part);
  if (trip.status === 'completed' && req.method !== 'GET' && !['settlements','transfers'].includes(part) && !retrospectiveSale) return fail(res,409,'Turen er driftsmæssigt afsluttet og låst. Salgschefer kan efterregistrere passagerer og bagage. Pengeoverførsel og kontantafregning kan stadig behandles');
  if (part === 'seats' && req.method === 'GET') return json(res, 200, seatMap(trip.id));
  if (trip.status === 'cancelled' && ['passengers','group-bookings','baggage','ticket-scan'].includes(part)) return fail(res,409,'Turen er annulleret og kan ikke længere bruges til salg eller check-in');
  if (part === 'ticket-scan' && req.method === 'POST') {
    if(!['driver','sales_manager'].includes(user.role)||!canOperateTrip(user,trip))return fail(res,403,'Kun en tildelt chauffør eller salgschefen på vagt kan checke ind ved at scanne billetten');
    const data=await body(req),scanValue=String(data.token||'').trim();
    let token=scanValue;
    try{const scannedUrl=new URL(scanValue);token=decodeURIComponent(scannedUrl.pathname.match(/^\/ticket\/([^/]+)$/)?.[1]||'')}catch(_){}
    const bookingNumber=bookingFromTicketToken(token);
    if(!bookingNumber)return fail(res,400,'QR-koden er ugyldig eller beskadiget');
    const bookingPassengers=db.passengers.filter(passenger=>passenger.tripId===trip.id&&passenger.bookingNumber===bookingNumber);
    if(!bookingPassengers.length)return fail(res,404,'Billetten gælder ikke til denne tur');
    if(!data.passengerId)return json(res,200,{bookingNumber,passengers:bookingPassengers.map(passengerRecordView)});
    const passenger=bookingPassengers.find(item=>item.id===Number(data.passengerId));
    if(!passenger)return fail(res,404,'Passageren findes ikke på den scannede booking');
    if(passenger.checkedIn)return json(res,200,{bookingNumber,alreadyCheckedIn:true,passenger:passengerRecordView(passenger)});
    reopenPassengerListForChange(trip,user,'Passager checket ind med QR-kode');
    const at=new Date().toISOString();passenger.checkedIn=true;passenger.attendanceStatus='checked_in';passenger.checkedInAt=at;passenger.checkedInBy=user.id;
    if(passenger.paymentLocation==='bus')passenger.cashHolderUserId=user.id;
    passenger.attendanceHistory=passenger.attendanceHistory||[];passenger.attendanceHistory.push({action:'checked_in',source:'qr_scan',at,userId:user.id,stopId:passenger.pickupStopId,receivedAmount:passenger.paymentStatus==='cash'?Number(passenger.cashAmount||0):0,receivedCurrency:passenger.paymentCurrency||'DKK',receivedBy:passenger.paymentStatus==='cash'?(passenger.cashHolderUserId||passenger.paymentRecordedBy):null});
    audit(user,'passenger.qr_checked_in','passenger',passenger.id,trip.id,{bookingNumber});await saveDb();return json(res,200,{bookingNumber,alreadyCheckedIn:false,passenger:passengerRecordView(passenger)});
  }
  if (part === 'group-bookings' && req.method === 'POST') {
    if (!['admin','sales_manager','driver'].includes(user.role)) return fail(res,403,'Du har ikke adgang til at oprette gruppebookinger');
    const data=await body(req),replay=clientActionReplay(data,user,'group-booking.create');if(replay)return json(res,replay.status,replay.response);const participants=Array.isArray(data.passengers)?data.passengers:[];
    if(participants.length<2||participants.length>20)return fail(res,400,'En gruppebooking skal indeholde mellem 2 og 20 passagerer');
    const contactPhone=String(data.phone||'').trim(),pickupStopId=Number(data.pickupStopId),destinationStopId=Number(data.destinationStopId),paymentStatus=String(data.paymentStatus||'');
    if(!contactPhone||!db.stops.some(stop=>stop.id===pickupStopId)||!db.stops.some(stop=>stop.id===destinationStopId)||pickupStopId===destinationStopId)return fail(res,400,'Udfyld hovedpersonens telefon og en gyldig fælles rute');
    if(!['unpaid','cash','free','pay_dk','pay_mk'].includes(paymentStatus))return fail(res,400,'Ugyldig betalingsstatus');
    if(user.role==='driver'&&paymentStatus!=='cash')return fail(res,403,'Chaufføren kan kun oprette billetter, der betales i bussen');
    if(user.role==='sales_manager'&&paymentStatus==='free')return fail(res,403,'Kun administratoren kan udstede gratis billetter');
    if(paymentStatus==='cash'&&!(Number(data.cashAmount)>0))return fail(res,400,'Angiv det samlede modtagne kontantbeløb');
    if(!(data.confirmDuplicate===true||data.confirmDuplicate==='true')){const duplicates=participants.flatMap((item,index)=>possiblePassengerDuplicates(trip.id,{name:item?.name,phone:index===0?contactPhone:''}));const unique=[...new Map(duplicates.map(item=>[item.id,item])).values()];if(unique.length)return failDetails(res,409,'Mulig dobbeltbooking fundet. Kontrollér passagererne, før du fortsætter.',{duplicateWarning:true,duplicates:unique});}
    const paymentCurrency=['DKK','EUR'].includes(data.paymentCurrency)?data.paymentCurrency:'DKK',ticketType=['one_way','return_fixed','return_open'].includes(data.ticketType)?data.ticketType:'one_way';
    let openReturnValidUntil=null;
    if(ticketType==='return_open'){
      const validUntil=new Date(`${String(data.openReturnValidUntil||'')}T23:59:59`);
      if(Number.isNaN(validUntil.getTime())||validUntil<=new Date(trip.departureAt))return fail(res,400,'Vælg en gyldig udløbsdato for den åbne returbillet');
      openReturnValidUntil=validUntil.toISOString();
    }
    const outboundSeats=seatMap(trip.id),chosenSeats=new Set(),chosenReturnSeats=new Set(),ticketNumbers=new Set(),prepared=[];
    let returnTrip=null,totalExtraAmount=0;
    for(let index=0;index<participants.length;index++){
      const item=participants[index]||{},name=String(item.name||'').trim(),ticketNumber=String(item.ticketNumber||'').trim(),seatNumber=Number(item.seatNumber),seat=outboundSeats.find(candidate=>candidate.number===seatNumber);
      if(!name||!seat)return fail(res,400,`Udfyld navn og sæde for passager ${index+1}`);
      if(seat.passengerId||chosenSeats.has(seatNumber))return fail(res,409,`Sæde ${seatNumber} er allerede reserveret eller valgt i gruppen`);
      chosenSeats.add(seatNumber);
      const normalizedTicket=ticketNumber.toLocaleLowerCase('da-DK');
      if(ticketNumber&&(ticketNumbers.has(normalizedTicket)||db.passengers.some(passenger=>passenger.tripId===trip.id&&String(passenger.ticketNumber||'').toLocaleLowerCase('da-DK')===normalizedTicket)))return fail(res,409,`Billetnummeret for ${name} bruges allerede på turen`);
      if(ticketNumber)ticketNumbers.add(normalizedTicket);
      const extraSeatNumber=item.extraSeatNumber?Number(item.extraSeatNumber):null,extraSeatFree=item.extraSeatFree===true||item.extraSeatFree==='true',extraSeatAmount=extraSeatNumber&&!extraSeatFree?Number(item.extraSeatAmount||0):0,extraSeatCurrency=['DKK','EUR'].includes(item.extraSeatCurrency)?item.extraSeatCurrency:paymentCurrency;
      if(extraSeatNumber){
        const extraSeat=outboundSeats.find(candidate=>candidate.number===extraSeatNumber);
        if(!extraSeat||extraSeat.passengerId||chosenSeats.has(extraSeatNumber)||!isAdjacentSeat(trip.id,seatNumber,extraSeatNumber))return fail(res,409,`Ekstrasædet for ${name} er ikke et ledigt nabosæde`);
        if(!extraSeatFree&&!(extraSeatAmount>0))return fail(res,400,`Angiv ekstrasædets beløb for ${name}, eller markér det som gratis`);
        if(!extraSeatFree&&extraSeatCurrency!==paymentCurrency)return fail(res,400,'Alle betalte ekstrasæder skal bruge gruppebetalingens valuta');
        chosenSeats.add(extraSeatNumber);totalExtraAmount+=extraSeatAmount;
      }
      let returnReservation=null;
      if(ticketType==='return_fixed'){
        returnReservation=validateReturnReservation(user,trip,pickupStopId,destinationStopId,data.returnTripId,item.returnSeatNumber);
        if(returnReservation.error)return fail(res,400,`${name}: ${returnReservation.error}`);
        if(chosenReturnSeats.has(returnReservation.returnSeat.number))return fail(res,409,`Retursæde ${returnReservation.returnSeat.number} er valgt til flere passagerer`);
        chosenReturnSeats.add(returnReservation.returnSeat.number);returnTrip=returnReservation.returnTrip;
      }
      prepared.push({name,ticketNumber,seat,extraSeatNumber,extraSeatAmount,extraSeatCurrency,extraSeatFree:extraSeatNumber?extraSeatFree:false,extraSeatReason:extraSeatNumber?String(item.extraSeatReason||'').trim():'',returnReservation});
    }
    const partyBookingId=crypto.randomUUID(),bookingNumber=nextBookingNumber(db,trip.departureAt),outboundIds=prepared.map(()=>id()),partyPrimaryPassengerId=outboundIds[0],partySize=prepared.length,paymentLocation=paymentStatus==='cash'?cashSaleLocation(user,trip):null,cashHolderUserId=paymentStatus==='cash'&&['sales_manager','driver'].includes(user.role)?user.id:null,sharedTicketCashAmount=paymentStatus==='cash'?Number(data.cashAmount||0):0;
    reopenPassengerListForChange(trip,user,'Ny gruppebooking');
    const created=[];
    for(let index=0;index<prepared.length;index++){
      const item=prepared[index],isPrimary=index===0,bookingGroupId=ticketType==='one_way'?null:crypto.randomUUID();
      const passenger={id:outboundIds[index],tripId:trip.id,name:item.name,ticketNumber:item.ticketNumber,phone:isPrimary?contactPhone:'',pickupStopId,destinationStopId,paymentStatus:isPrimary?paymentStatus:'group_included',paymentCurrency,ticketCashAmount:isPrimary?sharedTicketCashAmount:0,cashAmount:isPrimary&&paymentStatus==='cash'?sharedTicketCashAmount+totalExtraAmount:0,paymentLocation:isPrimary?paymentLocation:null,paymentRecordedAt:isPrimary&&['cash','free'].includes(paymentStatus)?new Date().toISOString():null,paymentRecordedBy:isPrimary&&['cash','free'].includes(paymentStatus)?user.id:null,cashHolderUserId:isPrimary?cashHolderUserId:null,createdBy:user.id,...salesSnapshot(user),freeTicketReason:isPrimary&&paymentStatus==='free'?String(data.freeTicketReason||'').trim():'',seatNumber:item.seat.number,seatType:item.seat.type,seatSurcharge:item.seat.surcharge,extraSeatNumber:item.extraSeatNumber,extraSeatAmount:item.extraSeatAmount,extraSeatCurrency:item.extraSeatCurrency,extraSeatFree:item.extraSeatFree,extraSeatReason:item.extraSeatReason,totalPrice:paymentStatus==='free'?item.extraSeatAmount:trip.basePrice+item.seat.surcharge+item.extraSeatAmount,checkedIn:false,attendanceStatus:'pending',checkedInAt:null,checkedInBy:null,ticketType,journeyLeg:'outbound',bookingGroupId,returnStatus:ticketType==='return_open'?'open':ticketType==='return_fixed'?'booked':null,returnTripId:returnTrip?.id||null,returnPassengerId:null,outboundPassengerId:null,openReturnValidUntil,partyBookingId,partyPrimaryPassengerId,partyRole:isPrimary?'primary':'member',partySize};
      passenger.bookingNumber=bookingNumber;db.passengers.push(passenger);created.push(passenger);postRevenue(passenger,'passenger',`Billet · ${passenger.name}`,user.id);
      if(item.returnReservation){reopenPassengerListForChange(item.returnReservation.returnTrip,user,'Ny returpassager');const returnPassenger=createReturnPassenger({outbound:passenger,returnTrip:item.returnReservation.returnTrip,returnSeat:item.returnReservation.returnSeat,user,bookingGroupId});passenger.returnPassengerId=returnPassenger.id;db.passengers.push(returnPassenger);audit(user,'passenger.return_booked','passenger',passenger.id,trip.id,{returnTripId:returnPassenger.tripId,returnPassengerId:returnPassenger.id,returnSeatNumber:returnPassenger.seatNumber,partyBookingId});}
      audit(user,'passenger.created','passenger',passenger.id,trip.id,{name:passenger.name,seatNumber:passenger.seatNumber,paymentStatus:passenger.paymentStatus,ticketType,partyBookingId,partyRole:passenger.partyRole});
    }
    audit(user,'party_booking.created','party_booking',partyPrimaryPassengerId,trip.id,{partyBookingId,partySize,pickupStopId,destinationStopId,ticketType,returnTripId:returnTrip?.id||null});
    const groupDraft=bookingNotificationDraft(trip,created[0],user);if(groupDraft)groupDraft.body=groupDraft.body.replace(`Sæde ${created[0].seatNumber}.`,`Sæder ${created.map(item=>item.seatNumber).join(', ')} · ${partySize} passagerer.`);
    const response=rememberClientAction(data,user,'group-booking.create',201,{partyBookingId,partyPrimaryPassengerId,partySize,passengers:created.map(passengerRecordView)});await saveDb();return json(res,201,response);
  }
  if (part === 'passengers' && req.method === 'POST') {
    if (!['admin','sales_manager','driver'].includes(user.role)) return fail(res, 403, 'Du har ikke adgang til at oprette passagerer');
    const data = await body(req),replay=clientActionReplay(data,user,'passenger.create');if(replay)return json(res,replay.status,replay.response);const seat = seatMap(trip.id).find(s => s.number === Number(data.seatNumber));
    if (!data.name?.trim() || !data.phone?.trim() || !data.pickupStopId || !data.destinationStopId || !seat) return fail(res, 400, 'Udfyld passagerens obligatoriske felter');
    if(!db.stops.some(stop=>stop.id===Number(data.pickupStopId))||!db.stops.some(stop=>stop.id===Number(data.destinationStopId)))return fail(res,400,'Vælg gyldige opsamlings- og destinationssteder');
    if(Number(data.pickupStopId)===Number(data.destinationStopId))return fail(res,400,'Opsamlingssted og destination skal være forskellige');
    if(user.role==='driver'&&data.paymentStatus!=='cash')return fail(res,403,'Chaufføren kan kun oprette billetter, der betales i bussen');
    if (seat.passengerId) return fail(res, 409, 'Sædet er allerede reserveret');
    if (!['unpaid','cash','free','pay_dk','pay_mk'].includes(data.paymentStatus)) return fail(res, 400, 'Ugyldig betalingsstatus');
    if(data.paymentStatus==='cash'&&!(Number(data.cashAmount)>0))return fail(res,400,'Angiv det modtagne kontantbeløb');
    if(!(data.confirmDuplicate===true||data.confirmDuplicate==='true')){const duplicates=possiblePassengerDuplicates(trip.id,{name:data.name,phone:data.phone});if(duplicates.length)return failDetails(res,409,'Mulig dobbeltbooking fundet. Kontrollér passageren, før du fortsætter.',{duplicateWarning:true,duplicates});}
    const ticketNumber=String(data.ticketNumber||'').trim();
    if(ticketNumber&&db.passengers.some(passenger=>passenger.tripId===trip.id&&String(passenger.ticketNumber||'').toLocaleLowerCase('da-DK')===ticketNumber.toLocaleLowerCase('da-DK')))return fail(res,409,'Billetnummeret bruges allerede på denne tur');
    const ticketType=['one_way','return_fixed','return_open'].includes(data.ticketType)?data.ticketType:'one_way';
    let openReturnValidUntil=null,returnReservation=null;
    if(ticketType==='return_open'){
      const validUntil=new Date(`${String(data.openReturnValidUntil||'')}T23:59:59`);
      if(Number.isNaN(validUntil.getTime())||validUntil<=new Date(trip.departureAt))return fail(res,400,'Vælg en gyldig udløbsdato for den åbne returbillet');
      openReturnValidUntil=validUntil.toISOString();
    }
    if(ticketType==='return_fixed'){
      returnReservation=validateReturnReservation(user,trip,Number(data.pickupStopId),Number(data.destinationStopId),data.returnTripId,data.returnSeatNumber);
      if(returnReservation.error)return fail(res,400,returnReservation.error);
    }
    const paymentCurrency = ['DKK','EUR'].includes(data.paymentCurrency) ? data.paymentCurrency : 'DKK';
    if(user.role==='sales_manager'&&data.paymentStatus==='free')return fail(res,403,'Kun administratoren kan udstede gratis billetter');
    const extraSeatNumber=data.extraSeatNumber?Number(data.extraSeatNumber):null,extraSeatFree=data.extraSeatFree===true||data.extraSeatFree==='true',extraSeatAmount=extraSeatNumber&&!extraSeatFree?Number(data.extraSeatAmount||0):0,extraSeatCurrency=['DKK','EUR'].includes(data.extraSeatCurrency)?data.extraSeatCurrency:paymentCurrency;
    if(extraSeatNumber){
      if(!['admin','sales_manager','driver'].includes(user.role))return fail(res,403,'Kun administratoren, salgschefen eller en tildelt chauffør kan tilføje en ekstra siddeplads');
      const extraSeat=seatMap(trip.id).find(candidate=>candidate.number===extraSeatNumber);if(!extraSeat||extraSeat.passengerId||extraSeatNumber===seat.number)return fail(res,409,'Den valgte ekstra siddeplads er ikke ledig');
      if(!isAdjacentSeat(trip.id,seat.number,extraSeatNumber))return fail(res,400,'Ekstrasædet skal være det ledige sæde direkte ved siden af passagerens sæde');
      if(!extraSeatFree&&!(extraSeatAmount>0))return fail(res,400,'Angiv ekstra sædebeløb, eller markér sædet som gratis');
      if(!extraSeatFree&&extraSeatCurrency!==paymentCurrency)return fail(res,400,'Ekstrasædet skal registreres i samme valuta som billetten');
    }
    const ticketCashAmount=data.paymentStatus==='cash'?Number(data.cashAmount||0):0,totalCashAmount=ticketCashAmount+extraSeatAmount;
    const paymentLocation=data.paymentStatus==='cash'?cashSaleLocation(user,trip):null,cashHolderUserId=data.paymentStatus==='cash'&&['sales_manager','driver'].includes(user.role)?user.id:null;
    const bookingGroupId=ticketType==='one_way'?null:crypto.randomUUID(),bookingNumber=nextBookingNumber(db,trip.departureAt);
    reopenPassengerListForChange(trip,user,'Ny passager');
    const passenger = { id: id(), tripId: trip.id, name: data.name.trim(), ticketNumber, phone: data.phone.trim(), pickupStopId: Number(data.pickupStopId), destinationStopId: Number(data.destinationStopId), paymentStatus: data.paymentStatus, paymentCurrency, ticketCashAmount,cashAmount: data.paymentStatus === 'cash' ? totalCashAmount : 0, paymentLocation, paymentRecordedAt: ['cash','free'].includes(data.paymentStatus) ? new Date().toISOString() : null, paymentRecordedBy: ['cash','free'].includes(data.paymentStatus) ? user.id : null, cashHolderUserId, createdBy:user.id,...salesSnapshot(user), freeTicketReason: data.paymentStatus === 'free' ? String(data.freeTicketReason || '').trim() : '', seatNumber: seat.number, seatType: seat.type, seatSurcharge: seat.surcharge,extraSeatNumber,extraSeatAmount,extraSeatCurrency,extraSeatFree:extraSeatNumber?extraSeatFree:false,extraSeatReason:extraSeatNumber?String(data.extraSeatReason||'').trim():'', totalPrice: data.paymentStatus === 'free' ? extraSeatAmount : trip.basePrice + seat.surcharge+extraSeatAmount, checkedIn: false, attendanceStatus: 'pending', checkedInAt: null, checkedInBy: null,ticketType,journeyLeg:'outbound',bookingGroupId,returnStatus:ticketType==='return_open'?'open':ticketType==='return_fixed'?'booked':null,returnTripId:returnReservation?.returnTrip?.id||null,returnPassengerId:null,outboundPassengerId:null,openReturnValidUntil,partyBookingId:null,partyPrimaryPassengerId:null,partyRole:null,partySize:null };
    passenger.bookingNumber=bookingNumber;db.passengers.push(passenger);postRevenue(passenger,'passenger',`Billet · ${passenger.name}`,user.id);
    let returnPassenger=null;
    if(returnReservation){
      reopenPassengerListForChange(returnReservation.returnTrip,user,'Ny returpassager');returnPassenger=createReturnPassenger({outbound:passenger,returnTrip:returnReservation.returnTrip,returnSeat:returnReservation.returnSeat,user,bookingGroupId});
      passenger.returnPassengerId=returnPassenger.id;db.passengers.push(returnPassenger);
      audit(user,'passenger.return_booked','passenger',passenger.id,trip.id,{returnTripId:returnReservation.returnTrip.id,returnPassengerId:returnPassenger.id,returnSeatNumber:returnPassenger.seatNumber});
    }
    audit(user,'passenger.created','passenger',passenger.id,trip.id,{name:passenger.name,seatNumber:passenger.seatNumber,extraSeatNumber:passenger.extraSeatNumber,extraSeatAmount:passenger.extraSeatAmount,extraSeatFree:passenger.extraSeatFree,paymentStatus:passenger.paymentStatus,ticketType:passenger.ticketType,returnTripId:passenger.returnTripId});bookingNotificationDraft(trip,passenger,user);const response=rememberClientAction(data,user,'passenger.create',201,{...passengerRecordView(passenger),returnPassenger:returnPassenger?passengerRecordView(returnPassenger):null});await saveDb(); return json(res, 201,response);
  }
  if (part === 'passengers' && req.method === 'DELETE') {
    if (!['admin','sales_manager','driver'].includes(user.role)) return fail(res,403,'Du har ikke adgang til at slette passagerer');
    const data=await body(req),passenger=db.passengers.find(candidate=>candidate.id===Number(data.id)&&candidate.tripId===trip.id);if(!passenger)return fail(res,404,'Passageren findes ikke');
    const reason=String(data.deletionReason||'').trim();if(reason.length<3)return fail(res,400,'Skriv kort, hvorfor passageren slettes');
    const reference=`passenger:${passenger.id}`;if(passenger.cashHandedOverAt||hasCashAuditReference(reference))return fail(res,409,'Passagerens betaling indgår i en kontantoverførsel eller afstemning og kan derfor ikke slettes');
    const linkedReturn=passenger.returnPassengerId?db.passengers.find(candidate=>candidate.id===passenger.returnPassengerId):null;
    if(linkedReturn&&(linkedReturn.checkedIn||linkedReturn.cashHandedOverAt||hasCashAuditReference(`passenger:${linkedReturn.id}`)))return fail(res,409,'Returrejsen er allerede brugt eller indgår i økonomihistorikken og kan derfor ikke slettes');
    reopenPassengerListForChange(trip,user,'Passager slettet');recordDeletion(trip,'passenger',passenger,user,reason);postRevenueReversal(passenger,'passenger',`Billet · ${passenger.name}`,user,reason);audit(user,'passenger.deleted','passenger',passenger.id,trip.id,{name:passenger.name,reason});
    if(linkedReturn){const linkedTrip=db.trips.find(candidate=>candidate.id===linkedReturn.tripId);if(linkedTrip){reopenPassengerListForChange(linkedTrip,user,'Returpassager slettet');recordDeletion(linkedTrip,'passenger',linkedReturn,user,`Retur slettet sammen med udrejsen: ${reason}`)}audit(user,'passenger.return_deleted','passenger',linkedReturn.id,linkedReturn.tripId,{outboundPassengerId:passenger.id,reason});}
    if(passenger.outboundPassengerId){const outbound=db.passengers.find(candidate=>candidate.id===passenger.outboundPassengerId);if(outbound){outbound.ticketType='return_open';outbound.returnStatus='open';outbound.returnTripId=null;outbound.returnPassengerId=null;outbound.openReturnValidUntil=outbound.openReturnValidUntil||new Date(new Date().setFullYear(new Date().getFullYear()+1)).toISOString();}}
    const removeIds=new Set([passenger.id,linkedReturn?.id].filter(Boolean)),partyBookingId=passenger.partyBookingId;
    if(partyBookingId&&passenger.journeyLeg==='outbound'){
      const remainingOutbounds=db.passengers.filter(candidate=>candidate.partyBookingId===partyBookingId&&candidate.journeyLeg==='outbound'&&!removeIds.has(candidate.id));
      if(remainingOutbounds.length){
        let primary=remainingOutbounds.find(candidate=>candidate.partyRole==='primary');
        if(passenger.partyRole==='primary'||!primary){
          primary=remainingOutbounds[0];
          Object.assign(primary,{phone:primary.phone||passenger.phone,paymentStatus:passenger.paymentStatus,paymentCurrency:passenger.paymentCurrency,ticketCashAmount:Number(passenger.ticketCashAmount||0),cashAmount:Number(passenger.cashAmount||0),paymentLocation:passenger.paymentLocation,paymentRecordedAt:passenger.paymentRecordedAt,paymentRecordedBy:passenger.paymentRecordedBy,cashHolderUserId:passenger.cashHolderUserId,freeTicketReason:passenger.freeTicketReason||''});postRevenue(primary,'passenger',`Billet · ${primary.name}`,user.id);
          audit(user,'party_booking.primary_changed','party_booking',primary.id,trip.id,{partyBookingId,previousPrimaryPassengerId:passenger.id,newPrimaryPassengerId:primary.id});
        }
        for(const record of db.passengers.filter(candidate=>candidate.partyBookingId===partyBookingId&&!removeIds.has(candidate.id))){const outboundId=record.journeyLeg==='return'?record.outboundPassengerId:record.id;record.partyPrimaryPassengerId=primary.id;record.partyRole=outboundId===primary.id?'primary':'member';record.partySize=remainingOutbounds.length;}
      }
    }
    db.passengers=db.passengers.filter(candidate=>!removeIds.has(candidate.id));await saveDb();return json(res,200,{ok:true,freedSeatNumber:passenger.seatNumber,freedExtraSeatNumber:passenger.extraSeatNumber||null,freedReturnSeatNumber:linkedReturn?.seatNumber||null});
  }
  if (part === 'passengers' && req.method === 'PATCH') {
    const data = await body(req),replay=clientActionReplay(data,user,'passenger.update');if(replay)return json(res,replay.status,replay.response);const passenger = db.passengers.find(p => p.id === Number(data.id) && p.tripId === trip.id); if (!passenger) return fail(res, 404, 'Passageren findes ikke');
    if(data.bookOpenReturn===true){
      if(!['admin','sales_manager','driver'].includes(user.role))return fail(res,403,'Du har ikke adgang til at booke en åben retur');
      if(passenger.journeyLeg==='return'||passenger.ticketType!=='return_open'||passenger.returnStatus!=='open')return fail(res,409,'Passageren har ikke en åben returbillet');
      if(passenger.openReturnValidUntil&&new Date(passenger.openReturnValidUntil)<new Date())return fail(res,409,'Den åbne returbillet er udløbet');
      const reservation=validateReturnReservation(user,trip,passenger.pickupStopId,passenger.destinationStopId,data.returnTripId,data.returnSeatNumber);
      if(reservation.error)return fail(res,400,reservation.error);
      const bookingGroupId=passenger.bookingGroupId||crypto.randomUUID(),returnPassenger=createReturnPassenger({outbound:passenger,returnTrip:reservation.returnTrip,returnSeat:reservation.returnSeat,user,bookingGroupId});
      passenger.ticketType='return_fixed';passenger.bookingGroupId=bookingGroupId;passenger.returnStatus='booked';passenger.returnTripId=reservation.returnTrip.id;passenger.returnPassengerId=returnPassenger.id;passenger.returnBookedAt=new Date().toISOString();passenger.returnBookedBy=user.id;db.passengers.push(returnPassenger);
      audit(user,'passenger.open_return_booked','passenger',passenger.id,trip.id,{returnTripId:reservation.returnTrip.id,returnPassengerId:returnPassenger.id,returnSeatNumber:returnPassenger.seatNumber});await saveDb();return json(res,200,{...passengerRecordView(passenger),returnPassenger:passengerRecordView(returnPassenger)});
    }
    if(data.confirmExternalPayment===true){
      if(!['admin','sales_manager'].includes(user.role))return fail(res,403,'Kun administratoren eller en salgschef kan bekræfte betaling i DK/MK');
      if(!['pay_dk','pay_mk'].includes(passenger.paymentStatus))return fail(res,409,'Billetten er ikke markeret til betaling i DK eller MK');
      if(passenger.externalPaymentConfirmedAt)return fail(res,409,'Betalingen er allerede bekræftet');
      const amount=Number(data.amount),currency=['DKK','EUR'].includes(data.currency)?data.currency:null;
      if(!(amount>0)||!currency)return fail(res,400,'Angiv det bekræftede beløb og valuta');
      passenger.externalPaymentConfirmedAt=new Date().toISOString();passenger.externalPaymentConfirmedBy=user.id;passenger.externalPaymentAmount=amount;passenger.externalPaymentCurrency=currency;passenger.externalPaymentNote=String(data.note||'').trim();passenger.paymentRecordedAt=passenger.externalPaymentConfirmedAt;passenger.paymentRecordedBy=user.id;
      postRevenue(passenger,'passenger',`Billet · ${passenger.name}`,user.id);audit(user,'passenger.external_payment_confirmed','passenger',passenger.id,trip.id,{paymentStatus:passenger.paymentStatus,amount,currency,note:passenger.externalPaymentNote});await saveDb();return json(res,200,passengerRecordView(passenger));
    }
    if (data.edit === true) {
      const reason=correctionReason(data);if(!reason)return fail(res,400,'Skriv kort, hvorfor passageren rettes');
      const oldRecordedAmount=recordedRevenueAmount(passenger),oldRecordedCurrency=recordedRevenueCurrency(passenger);
      const isPartyMember=Boolean(passenger.partyBookingId&&passenger.partyRole==='member'),name=String(data.name||'').trim(),ticketNumber=String(data.ticketNumber||'').trim(),phone=isPartyMember?'':String(data.phone||'').trim(),pickupStopId=Number(data.pickupStopId),destinationStopId=Number(data.destinationStopId),seatNumber=Number(data.seatNumber);
      if(!name||(!isPartyMember&&!phone)||!db.stops.some(stop=>stop.id===pickupStopId)||!db.stops.some(stop=>stop.id===destinationStopId))return fail(res,400,'Udfyld navn, telefon og gyldig rute');
      if(passenger.partyBookingId&&(pickupStopId!==passenger.pickupStopId||destinationStopId!==passenger.destinationStopId))return fail(res,409,'Ruten er fælles for gruppebookingen og kan ikke ændres på en enkelt passager');
      const seat=seatMap(trip.id).find(candidate=>candidate.number===seatNumber);if(!seat)return fail(res,400,'Vælg et gyldigt sæde');if(seat.passengerId&&(seat.passengerId!==passenger.id||seat.reservationType==='extra'))return fail(res,409,'Sædet er allerede reserveret');
      if(ticketNumber&&db.passengers.some(candidate=>candidate.tripId===trip.id&&candidate.id!==passenger.id&&String(candidate.ticketNumber||'').toLocaleLowerCase('da-DK')===ticketNumber.toLocaleLowerCase('da-DK')))return fail(res,409,'Billetnummeret bruges allerede på denne tur');
      const updates={name,ticketNumber,phone,pickupStopId,destinationStopId,seatNumber,seatType:seat.type,seatSurcharge:seat.surcharge};
      if(['admin','sales_manager','driver'].includes(user.role)&&Object.prototype.hasOwnProperty.call(data,'extraSeatNumber')){
        if(!passenger.extraSeatNumber&&data.extraSeatNumber)return fail(res,409,'Et ekstrasæde kan kun bestilles sammen med den nye billet');
        const effectivePaymentCurrency=['DKK','EUR'].includes(data.paymentCurrency)?data.paymentCurrency:(passenger.paymentCurrency||'DKK'),extraSeatNumber=data.extraSeatNumber?Number(data.extraSeatNumber):null,extraSeatFree=Boolean(extraSeatNumber&&(data.extraSeatFree===true||data.extraSeatFree==='true')),extraSeatAmount=extraSeatNumber&&!extraSeatFree?Number(data.extraSeatAmount||0):0,extraSeatCurrency=['DKK','EUR'].includes(data.extraSeatCurrency)?data.extraSeatCurrency:effectivePaymentCurrency;
        if(extraSeatNumber){
          const extraSeat=seatMap(trip.id).find(candidate=>candidate.number===extraSeatNumber);
          if(!extraSeat||extraSeatNumber===seatNumber||(extraSeat.passengerId&&extraSeat.passengerId!==passenger.id))return fail(res,409,'Den valgte ekstra siddeplads er ikke ledig');
          if(!isAdjacentSeat(trip.id,seatNumber,extraSeatNumber))return fail(res,400,'Ekstrasædet skal være det ledige sæde direkte ved siden af passagerens sæde');
          if(!extraSeatFree&&!(extraSeatAmount>0))return fail(res,400,'Angiv ekstra sædebeløb, eller markér sædet som gratis');
          if(!extraSeatFree&&extraSeatCurrency!==effectivePaymentCurrency)return fail(res,400,'Ekstrasædet skal registreres i samme valuta som billetten');
        }
        Object.assign(updates,{extraSeatNumber,extraSeatAmount,extraSeatCurrency,extraSeatFree,extraSeatReason:extraSeatNumber?String(data.extraSeatReason||'').trim():''});
      }else if(Object.prototype.hasOwnProperty.call(data,'extraSeatNumber'))return fail(res,403,'Kun administratoren, salgschefen eller en tildelt chauffør kan ændre en ekstra siddeplads');
      if(passenger.extraSeatNumber&&!Object.prototype.hasOwnProperty.call(updates,'extraSeatNumber')&&!isAdjacentSeat(trip.id,seatNumber,passenger.extraSeatNumber))return fail(res,400,'Det nye hovedsæde skal fortsat ligge ved siden af det registrerede ekstrasæde');
      if(passenger.paymentStatus==='free')updates.freeTicketReason=String(data.freeTicketReason||'').trim();
      if(passenger.paymentStatus==='cash'&&(Object.prototype.hasOwnProperty.call(data,'cashAmount')||Object.prototype.hasOwnProperty.call(data,'paymentCurrency'))){
        if(passenger.cashHandedOverAt||hasPendingSettlementReference(`passenger:${passenger.id}`)||hasPendingTransferReference(`passenger:${passenger.id}`))return fail(res,409,'Betalingen er låst af en igangværende eller afsluttet kontantafstemning');
        const amount=Number(data.cashAmount),currency=['DKK','EUR'].includes(data.paymentCurrency)?data.paymentCurrency:null;if(!(amount>0)||!currency)return fail(res,400,'Angiv korrekt beløb og valuta');updates.ticketCashAmount=amount;updates.paymentCurrency=currency;
      }
      const extraAmount=Object.prototype.hasOwnProperty.call(updates,'extraSeatAmount')?updates.extraSeatAmount:Number(passenger.extraSeatAmount||0),ticketAmount=Object.prototype.hasOwnProperty.call(updates,'ticketCashAmount')?updates.ticketCashAmount:Number(passenger.ticketCashAmount??(Number(passenger.cashAmount||0)-Number(passenger.extraSeatAmount||0)));
      if(passenger.paymentStatus==='cash')updates.cashAmount=ticketAmount+extraAmount;
      updates.totalPrice=passenger.paymentStatus==='free'?extraAmount:trip.basePrice+seat.surcharge+extraAmount;
      const changes=changedFields(passenger,updates);if(!Object.keys(changes).length)return fail(res,400,'Der er ingen ændringer at gemme');
      Object.assign(passenger,updates);passenger.editHistory=passenger.editHistory||[];passenger.editHistory.push({editedAt:new Date().toISOString(),editedBy:user.id,reason,changes});postRevenueCorrection(passenger,'passenger',`Billet · ${passenger.name}`,user,oldRecordedAmount,oldRecordedCurrency,reason);
      audit(user,'passenger.corrected','passenger',passenger.id,trip.id,{reason,changes});await saveDb();return json(res,200,passengerRecordView(passenger));
    }
    if (data.paymentStatus === 'cash') {
      if (!isPendingPayment(passenger)) return fail(res, 409, 'Billetten er allerede afsluttet som betalt eller gratis');
      const amount = Number(data.cashAmount); const currency = ['DKK','EUR'].includes(data.paymentCurrency) ? data.paymentCurrency : null; const location = cashSaleLocation(user,trip,data.paymentLocation);
      if (!(amount > 0) || !currency || !location) return fail(res, 400, 'Angiv beløb, valuta og betalingssted');
      let cashHolderUserId = null;
      if (['departure','shop'].includes(location)&&user.role==='sales_manager') cashHolderUserId=user.id;
      if (location === 'bus') {
        const checkInDriver = [trip.primaryDriverId,trip.secondaryDriverId].includes(passenger.checkedInBy) ? passenger.checkedInBy : null;
        cashHolderUserId = checkInDriver || (user.role === 'driver' ? user.id : Number(data.cashHolderUserId));
        if (![trip.primaryDriverId,trip.secondaryDriverId].includes(cashHolderUserId)) return fail(res, 400, 'Vælg den chauffør, som har pengene');
      }
      passenger.paymentStatus = 'cash'; passenger.ticketCashAmount = amount; passenger.cashAmount = amount+Number(passenger.extraSeatAmount||0); passenger.paymentCurrency = currency; passenger.paymentLocation = location; passenger.paymentRecordedAt = new Date().toISOString(); passenger.paymentRecordedBy = user.id; passenger.cashHolderUserId = cashHolderUserId;postRevenue(passenger,'passenger',`Billet · ${passenger.name}`,user.id);
    }
    if(user.role==='sales_manager'&&!salesManagerOnDuty(user,trip)&&(typeof data.checkedIn==='boolean'||data.attendanceStatus==='no_show'))return fail(res,403,'Kun salgschefen på vagt kan udføre check-in eller markere udeblevet på denne tur');
    if (typeof data.checkedIn === 'boolean') {
      if (data.checkedIn === passenger.checkedIn) return json(res,200,passengerRecordView(passenger));
      reopenPassengerListForChange(trip,user,'Passagerstatus ændret');
      passenger.checkedIn = data.checkedIn; passenger.attendanceStatus = passenger.checkedIn ? 'checked_in' : 'pending'; passenger.checkedInAt = passenger.checkedIn ? new Date().toISOString() : null; passenger.checkedInBy = passenger.checkedIn ? user.id : null;
      if (passenger.checkedIn && passenger.paymentLocation === 'bus' && user.role === 'driver') passenger.cashHolderUserId = user.id;
      passenger.attendanceHistory = passenger.attendanceHistory || []; const attendanceEvent={ action:passenger.checkedIn?'checked_in':'check_in_undone',at:new Date().toISOString(),userId:user.id,stopId:passenger.pickupStopId }; if(passenger.checkedIn)Object.assign(attendanceEvent,{receivedAmount:passenger.paymentStatus==='cash'?Number(passenger.cashAmount||0):0,receivedCurrency:passenger.paymentCurrency||'DKK',receivedBy:passenger.paymentStatus==='cash'?(passenger.cashHolderUserId||passenger.paymentRecordedBy):null}); passenger.attendanceHistory.push(attendanceEvent);
    }
    if (data.attendanceStatus === 'no_show') { if(passenger.attendanceStatus==='no_show')return json(res,200,passengerRecordView(passenger));reopenPassengerListForChange(trip,user,'Passager markeret udeblevet');passenger.checkedIn = false; passenger.attendanceStatus = 'no_show'; passenger.checkedInAt = null; passenger.checkedInBy = null; passenger.attendanceHistory = passenger.attendanceHistory || []; passenger.attendanceHistory.push({action:'no_show',at:new Date().toISOString(),userId:user.id,stopId:passenger.pickupStopId}); }
    audit(user,data.paymentStatus==='cash'?'passenger.payment_recorded':typeof data.checkedIn==='boolean'?(data.checkedIn?'passenger.checked_in':'passenger.unchecked'):data.attendanceStatus==='no_show'?'passenger.no_show':'passenger.updated','passenger',passenger.id,trip.id);const response=rememberClientAction(data,user,'passenger.update',200,passengerRecordView(passenger));await saveDb(); return json(res, 200,response);
  }
  if (part === 'baggage' && req.method === 'POST') {
    if (!['admin','sales_manager','driver'].includes(user.role)) return fail(res, 403, 'Du har ikke adgang til at registrere bagage');
    const data = await body(req),replay=clientActionReplay(data,user,'baggage.create');if(replay)return json(res,replay.status,replay.response);const pieces=Number(data.pieces); if (!data.senderName?.trim() || !data.recipientName?.trim() || !data.phone?.trim() || !data.pickupStopId || !data.destinationStopId || !Number.isInteger(pieces)||pieces<1) return fail(res, 400, 'Udfyld afsender, modtager og bagagens øvrige obligatoriske felter');
    if(!db.stops.some(stop=>stop.id===Number(data.pickupStopId))||!db.stops.some(stop=>stop.id===Number(data.destinationStopId)))return fail(res,400,'Vælg gyldige opsamlings- og destinationssteder');
    if(user.role==='driver'&&data.paymentStatus!=='cash')return fail(res,403,'Chaufføren kan kun modtage bagage, der betales i bussen');
    if(!['unpaid','cash','pay_dk','pay_mk'].includes(data.paymentStatus))return fail(res,400,'Ugyldig betalingsstatus');
    if(data.paymentStatus==='cash'&&!(Number(data.cashAmount)>0))return fail(res,400,'Angiv det modtagne kontantbeløb');
    const photoType=String(data.photoType||''),photoName=path.basename(String(data.photoName||'bagagefoto'));if(!data.photoData)return fail(res,400,'Tag eller vælg et billede af bagagen');
    if(!['image/jpeg','image/png','image/webp'].includes(photoType))return fail(res,400,'Bagagebilledet skal være JPG, PNG eller WebP');
    const encodedPhoto=String(data.photoData).replace(/^data:[^;]+;base64,/,'');const photoData=Buffer.from(encodedPhoto,'base64');if(!photoData.length)return fail(res,400,'Bagagebilledet er tomt');
    const photoExtensions={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'},photoFile=`baggage-${crypto.randomBytes(18).toString('hex')}${photoExtensions[photoType]}`;await storeFile(photoFile,photoData,photoType);
    const paymentCurrency = ['DKK','EUR'].includes(data.paymentCurrency) ? data.paymentCurrency : 'DKK';
    const createdAt=new Date().toISOString();
    const item = { id: id(), tripId: trip.id, senderName: data.senderName.trim(), recipientName: data.recipientName.trim(), phone: data.phone.trim(), pickupStopId: Number(data.pickupStopId), destinationStopId: Number(data.destinationStopId), pieces, description: String(data.description || '').trim(), photoName, photoType, photoFile,photoOriginalBytes:Number(data.photoOriginalBytes||photoData.length),photoStoredBytes:photoData.length,photoOptimized:data.photoOptimized===true||data.photoOptimized==='true', paymentStatus: data.paymentStatus, paymentCurrency, cashAmount: data.paymentStatus === 'cash' ? Number(data.cashAmount || 0) : 0, paymentLocation: data.paymentStatus === 'cash' ? cashSaleLocation(user,trip) : null, paymentRecordedAt: data.paymentStatus === 'cash' ? createdAt : null, paymentRecordedBy: data.paymentStatus === 'cash' ? user.id : null, cashHolderUserId: data.paymentStatus === 'cash'&&['sales_manager','driver'].includes(user.role)?user.id:null, notes: String(data.notes || '').trim(), status: 'registered', createdAt, createdBy:user.id,...salesSnapshot(user), statusUpdatedAt:createdAt, statusUpdatedBy:user.id, baggageHistory:[{action:'registered',at:createdAt,userId:user.id}] };
    db.baggage.push(item);postRevenue(item,'baggage',`Bagage · ${item.senderName}`,user.id);audit(user,'baggage.created','baggage',item.id,trip.id,{senderName:item.senderName,recipientName:item.recipientName,paymentStatus:item.paymentStatus,photoOriginalBytes:item.photoOriginalBytes,photoStoredBytes:item.photoStoredBytes});const response=rememberClientAction(data,user,'baggage.create',201,baggageRecordView(item));await saveDb(); return json(res, 201,response);
  }
  if (part === 'baggage' && req.method === 'DELETE') {
    if (!['admin','sales_manager','driver'].includes(user.role)) return fail(res,403,'Du har ikke adgang til at slette bagage');
    const data=await body(req),item=db.baggage.find(candidate=>candidate.id===Number(data.id)&&candidate.tripId===trip.id);if(!item)return fail(res,404,'Bagagen findes ikke');
    const reason=String(data.deletionReason||'').trim();if(reason.length<3)return fail(res,400,'Skriv kort, hvorfor bagagen slettes');
    const reference=`baggage:${item.id}`;if(item.cashHandedOverAt||hasCashAuditReference(reference))return fail(res,409,'Bagagens betaling indgår i en kontantoverførsel eller afstemning og kan derfor ikke slettes');
    recordDeletion(trip,'baggage',item,user,reason);postRevenueReversal(item,'baggage',`Bagage · ${item.senderName}`,user,reason);audit(user,'baggage.deleted','baggage',item.id,trip.id,{senderName:item.senderName,reason});db.baggage=db.baggage.filter(candidate=>candidate.id!==item.id);await saveDb();
    if(item.photoFile)await removeStoredFile(item.photoFile);
    return json(res,200,{ok:true});
  }
  if (part === 'baggage' && req.method === 'PATCH') {
    const data = await body(req),replay=clientActionReplay(data,user,'baggage.update');if(replay)return json(res,replay.status,replay.response);const item = db.baggage.find(b => b.id === Number(data.id) && b.tripId === trip.id); if (!item) return fail(res, 404, 'Bagagen findes ikke');
    if(data.confirmExternalPayment===true){
      if(!['admin','sales_manager'].includes(user.role))return fail(res,403,'Kun administratoren eller en salgschef kan bekræfte betaling i DK/MK');
      if(!['pay_dk','pay_mk'].includes(item.paymentStatus))return fail(res,409,'Bagagen er ikke markeret til betaling i DK eller MK');
      if(item.externalPaymentConfirmedAt)return fail(res,409,'Betalingen er allerede bekræftet');
      const amount=Number(data.amount),currency=['DKK','EUR'].includes(data.currency)?data.currency:null;
      if(!(amount>0)||!currency)return fail(res,400,'Angiv det bekræftede beløb og valuta');
      item.externalPaymentConfirmedAt=new Date().toISOString();item.externalPaymentConfirmedBy=user.id;item.externalPaymentAmount=amount;item.externalPaymentCurrency=currency;item.externalPaymentNote=String(data.note||'').trim();item.paymentRecordedAt=item.externalPaymentConfirmedAt;item.paymentRecordedBy=user.id;
      postRevenue(item,'baggage',`Bagage · ${item.senderName}`,user.id);audit(user,'baggage.external_payment_confirmed','baggage',item.id,trip.id,{paymentStatus:item.paymentStatus,amount,currency,note:item.externalPaymentNote});await saveDb();return json(res,200,baggageRecordView(item));
    }
    if (data.edit === true) {
      const reason=correctionReason(data);if(!reason)return fail(res,400,'Skriv kort, hvorfor bagagen rettes');
      const oldRecordedAmount=recordedRevenueAmount(item),oldRecordedCurrency=recordedRevenueCurrency(item);
      const senderName=String(data.senderName||'').trim(),recipientName=String(data.recipientName||'').trim(),phone=String(data.phone||'').trim(),pickupStopId=Number(data.pickupStopId),destinationStopId=Number(data.destinationStopId),pieces=Number(data.pieces);
      if(!senderName||!recipientName||!phone||!Number.isInteger(pieces)||pieces<1||!db.stops.some(stop=>stop.id===pickupStopId)||!db.stops.some(stop=>stop.id===destinationStopId))return fail(res,400,'Udfyld afsender, modtager, telefon, rute og antal kolli');
      const updates={senderName,recipientName,phone,pickupStopId,destinationStopId,pieces,description:String(data.description||'').trim(),notes:String(data.notes||'').trim()};
      if(item.paymentStatus==='cash'&&(Object.prototype.hasOwnProperty.call(data,'cashAmount')||Object.prototype.hasOwnProperty.call(data,'paymentCurrency'))){
        if(item.cashHandedOverAt||hasPendingSettlementReference(`baggage:${item.id}`)||hasPendingTransferReference(`baggage:${item.id}`))return fail(res,409,'Betalingen er låst af en igangværende eller afsluttet kontantafstemning');
        const amount=Number(data.cashAmount),currency=['DKK','EUR'].includes(data.paymentCurrency)?data.paymentCurrency:null;if(!(amount>0)||!currency)return fail(res,400,'Angiv korrekt beløb og valuta');updates.cashAmount=amount;updates.paymentCurrency=currency;
      }
      const changes=changedFields(item,updates);if(!Object.keys(changes).length)return fail(res,400,'Der er ingen ændringer at gemme');
      Object.assign(item,updates);item.editHistory=item.editHistory||[];item.editHistory.push({editedAt:new Date().toISOString(),editedBy:user.id,reason,changes});postRevenueCorrection(item,'baggage',`Bagage · ${item.senderName}`,user,oldRecordedAmount,oldRecordedCurrency,reason);
      audit(user,'baggage.corrected','baggage',item.id,trip.id,{reason,changes});await saveDb();return json(res,200,baggageRecordView(item));
    }
    if (data.paymentStatus === 'cash') {
      if (!isPendingPayment(item)) return fail(res, 409, 'Bagagen er allerede registreret som betalt');
      const amount = Number(data.cashAmount); const currency = ['DKK','EUR'].includes(data.paymentCurrency) ? data.paymentCurrency : null; const location = cashSaleLocation(user,trip,data.paymentLocation);
      if (!(amount > 0) || !currency || !location) return fail(res, 400, 'Angiv beløb, valuta og betalingssted');
      let cashHolderUserId = null;
      if (['departure','shop'].includes(location)&&user.role==='sales_manager') cashHolderUserId=user.id;
      if (location === 'bus') {
        cashHolderUserId = user.role === 'driver' ? user.id : Number(data.cashHolderUserId);
        if (![trip.primaryDriverId,trip.secondaryDriverId].includes(cashHolderUserId)) return fail(res, 400, 'Vælg den chauffør, som har pengene');
      }
      item.paymentStatus = 'cash'; item.cashAmount = amount; item.paymentCurrency = currency; item.paymentLocation = location; item.paymentRecordedAt = new Date().toISOString(); item.paymentRecordedBy = user.id; item.cashHolderUserId = cashHolderUserId;postRevenue(item,'baggage',`Bagage · ${item.senderName}`,user.id);
    }
    if (data.status !== undefined) {
      if(user.role==='sales_manager'&&!salesManagerOnDuty(user,trip))return fail(res,403,'Kun salgschefen på vagt kan ændre bagagens driftsstatus på denne tur');
      if (!['registered','received','onboard','delivered','unclaimed'].includes(data.status)) return fail(res, 400, 'Ugyldig status');
      item.status = data.status; item.statusUpdatedAt=new Date().toISOString(); item.statusUpdatedBy=user.id; item.baggageHistory=item.baggageHistory||[]; item.baggageHistory.push({action:data.status,at:item.statusUpdatedAt,userId:user.id});
    }
    audit(user,data.paymentStatus==='cash'?'baggage.payment_recorded':data.status?`baggage.${data.status}`:'baggage.updated','baggage',item.id,trip.id);const response=rememberClientAction(data,user,'baggage.update',200,baggageRecordView(item));await saveDb(); return json(res, 200,response);
  }
  if (part === 'expenses' && req.method === 'POST') {
    const data = await body(req); const amount = Number(data.amount); const currency = ['DKK','EUR'].includes(data.currency) ? data.currency : null; const category = String(data.category || '').trim();
    if (!(amount > 0) || !currency || !category) return fail(res, 400, 'Angiv kategori, beløb og valuta');
    const paymentMethod=user.role==='sales_manager'?'cash':['company_card','cash','private'].includes(data.paymentMethod)?data.paymentMethod:'cash';
    const allowedPayers=[user.id,trip.primaryDriverId,trip.secondaryDriverId].filter(Boolean),paidByUserId=user.role==='admin'&&allowedPayers.includes(Number(data.paidByUserId))?Number(data.paidByUserId):user.id;
    const paidByUser=db.users.find(candidate=>candidate.id===paidByUserId),cashBoxUserId=paymentMethod==='cash'&&['driver','sales_manager'].includes(paidByUser?.role)?paidByUserId:null,cashPaymentAllocations=cashBoxUserId?allocateCashExpense(trip.id,cashBoxUserId,currency,amount):[];
    if(cashBoxUserId&&!cashPaymentAllocations)return fail(res,409,'Der er ikke nok disponible kontanter i medarbejderens kasse til denne udgift');
    let receiptType=null,receiptName=null,receiptFile=null,receiptOriginalBytes=0,receiptStoredBytes=0,receiptOptimized=false;
    if(data.receiptData){receiptType=String(data.receiptType||'');receiptName=path.basename(String(data.receiptName||'kvittering'));if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(receiptType))return fail(res,400,'Kvitteringen skal være PDF, JPG, PNG eller WebP');const encoded=String(data.receiptData).replace(/^data:[^;]+;base64,/,'');const fileData=Buffer.from(encoded,'base64');if(!fileData.length||fileData.length>5*1024*1024)return fail(res,400,'Kvitteringen skal være mellem 1 byte og 5 MB');const extensions={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','application/pdf':'.pdf'};receiptFile=`${crypto.randomBytes(18).toString('hex')}${extensions[receiptType]}`;await storeFile(receiptFile,fileData,receiptType);receiptOriginalBytes=Number(data.receiptOriginalBytes||fileData.length);receiptStoredBytes=fileData.length;receiptOptimized=data.receiptOptimized===true||data.receiptOptimized==='true';}
    const expense = { id:id(),tripId:trip.id,expenseDate:trip.departureAt,category,description:String(data.description||'').trim(),amount,currency,paymentMethod,paidByUserId,expenseScope:user.role==='sales_manager'?'sales_preparation':'trip_operation',cashBoxUserId,cashPaymentAllocations,receiptName,receiptType,receiptFile,receiptOriginalBytes,receiptStoredBytes,receiptOptimized,createdAt:new Date().toISOString(),createdBy:user.id,status:'pending',reviewedAt:null,reviewedBy:null,reviewNote:'',reimbursementStatus:paymentMethod==='private'?'pending':'not_applicable',reimbursedAt:null,reimbursedBy:null };
    db.expenses.push(expense);audit(user,'expense.created','expense',expense.id,trip.id,{amount,currency,category,paymentMethod}); await saveDb(); return json(res,201,{...expense,createdByName:user.name,paidByName:userName(paidByUserId)});
  }
  if (part === 'transfers' && req.method === 'POST') {
    if(!['driver','sales_manager','admin'].includes(user.role))return fail(res,403,'Du har ikke adgang til at overføre kontanter');
    const data=await body(req),assignedDriverIds=[trip.primaryDriverId,trip.secondaryDriverId].filter(Boolean),staffIds=[...new Set([...assignedDriverIds,trip.salesManagerId].filter(Boolean))];
    const fromUserId=user.role==='admin'?Number(data.fromUserId||data.fromDriverId):user.id,toUserId=Number(data.toUserId||data.toDriverId);
    if(!staffIds.includes(fromUserId)||!staffIds.includes(toUserId)||fromUserId===toUserId)return fail(res,400,'Vælg to forskellige medarbejdere med ansvar på turen');
    const fromUser=db.users.find(candidate=>candidate.id===fromUserId),toUser=db.users.find(candidate=>candidate.id===toUserId);
    if(!fromUser||!toUser)return fail(res,400,'Vælg en gyldig afsender og modtager');
    if(fromUser.role==='sales_manager'&&toUser.role!=='driver')return fail(res,400,'Salgschefens turbudget kan kun overføres til en tildelt chauffør');
    if(fromUser.role==='driver'&&!['driver','sales_manager'].includes(toUser.role))return fail(res,400,'Chaufføren kan kun overføre til en anden chauffør eller turens salgschef');
    const transferType=fromUser.role==='sales_manager'?'trip_budget':toUser.role==='sales_manager'?'sales_handover':'driver_transfer';
    const isBudgetTransfer=fromUser.role==='sales_manager';let items=[],totals,cashTransferAllocations=[];
    if(isBudgetTransfer){totals={DKK:Math.max(0,Number(data.amountDKK||0)),EUR:Math.max(0,Number(data.amountEUR||0))};if(!(totals.DKK>0||totals.EUR>0))return fail(res,400,'Indtast et budgetbeløb i DKK eller EUR');const candidates=allCashItems().filter(item=>item.record.paymentStatus==='cash'&&['bus','departure','shop','budget'].includes(item.record.paymentLocation)&&item.record.cashHolderUserId===fromUserId&&!item.record.cashHandedOverAt&&!hasPendingSettlementReference(cashReference(item))&&!hasPendingTransferReference(cashReference(item))&&!hasPendingCashExpenseReference(cashReference(item)));for(const currency of ['DKK','EUR'])if(totals[currency]>0){const allocations=allocateCashTransfer(candidates,currency,totals[currency]);if(!allocations)return fail(res,409,`Der er ikke nok disponibelt budget i ${currency}`);cashTransferAllocations.push(...allocations)}items=[...new Set(cashTransferAllocations.map(allocation=>allocation.reference))].map(cashRecordByReferenceAny)}else{const references=[...new Set((Array.isArray(data.paymentRefs)?data.paymentRefs:[]).map(String))];if(!references.length)return fail(res,400,'Vælg mindst én betaling');items=references.map(cashRecordByReferenceAny);if(items.some(item=>!item||item.record.tripId!==trip.id))return fail(res,400,'En valgt betaling findes ikke på turen');if(items.some(item=>item.record.paymentStatus!=='cash'||!['bus','departure','shop','budget'].includes(item.record.paymentLocation)||item.record.cashHolderUserId!==fromUserId||item.record.cashHandedOverAt))return fail(res,409,'En valgt betaling står ikke længere hos afsenderen');if(items.some(item=>hasPendingSettlementReference(item.reference)||hasPendingTransferReference(item.reference)||hasPendingCashExpenseReference(item.reference)))return fail(res,409,'En valgt betaling er allerede låst');totals=cashAvailableAmounts(items);if(!(totals.DKK>0||totals.EUR>0))return fail(res,409,'De valgte betalinger er allerede brugt')}
    const transfer={id:id(),tripId:trip.id,fromUserId,toUserId,fromDriverId:fromUserId,toDriverId:toUserId,transferType,paymentRefs:items.map(item=>item.reference),cashTransferAllocations,totals,note:String(data.note||'').trim(),status:'pending',initiatedAt:new Date().toISOString(),initiatedBy:user.id,respondedAt:null,respondedBy:null,responseNote:''};
    transfer.receiptNumber=`KT-${String(trip.id).padStart(4,'0')}-${String(transfer.id).padStart(6,'0')}`;db.cashTransfers.push(transfer);audit(user,'cash_transfer.initiated','cash_transfer',transfer.id,trip.id,{receiptNumber:transfer.receiptNumber,fromUserId,toUserId,transferType,totals});await saveDb();return json(res,201,cashTransferView(transfer,user));
  }
  if (part === 'transfers' && req.method === 'PATCH') {
    const data=await body(req),transfer=db.cashTransfers.find(candidate=>candidate.id===Number(data.id)&&candidate.tripId===trip.id);if(!transfer)return fail(res,404,'Kontantoverførslen findes ikke');
    if(transfer.status!=='pending')return fail(res,409,'Kontantoverførslen er allerede behandlet');
    if(!['accepted','rejected'].includes(data.status))return fail(res,400,'Vælg modtaget eller afvist');
    const fromUserId=transfer.fromUserId||transfer.fromDriverId,toUserId=transfer.toUserId||transfer.toDriverId;
    if(user.role!=='admin'&&user.id!==toUserId)return fail(res,403,'Kun den modtagende medarbejder kan bekræfte overførslen');
    if(data.status==='accepted'){
      const items=transfer.paymentRefs.map(cashRecordByReferenceAny);if(items.some(item=>!item||item.record.cashHolderUserId!==fromUserId||item.record.cashHandedOverAt||hasPendingSettlementReference(item.reference)))return fail(res,409,'En betaling har ændret status. Overførslen kan ikke gennemføres');
      const acceptedAt=new Date().toISOString(),isBudgetTransfer=transfer.transferType==='trip_budget'&&Array.isArray(transfer.cashTransferAllocations)&&transfer.cashTransferAllocations.length;if(isBudgetTransfer){for(const allocation of transfer.cashTransferAllocations){const item=cashRecordByReferenceAny(allocation.reference);if(!item||cashAvailableAmount(item,null,transfer.id)<Number(allocation.amount))return fail(res,409,'Budgetsaldoen har ændret sig. Overførslen kan ikke gennemføres')}for(const currency of ['DKK','EUR'])if(Number(transfer.totals?.[currency]||0)>0)db.cashBudgetEntries.push({id:id(),transferId:transfer.id,tripId:trip.id,name:'Turbudget fra salgschef',paymentStatus:'cash',paymentLocation:'budget',paymentCurrency:currency,cashAmount:Number(transfer.totals[currency]),cashHolderUserId:toUserId,cashHandedOverAt:null,createdAt:acceptedAt,createdBy:fromUserId,note:transfer.note||''})}else for(const item of items){item.record.cashHolderUserId=toUserId;item.record.cashTransferHistory=item.record.cashTransferHistory||[];item.record.cashTransferHistory.push({transferId:transfer.id,transferType:transfer.transferType||'driver_transfer',fromUserId,toUserId,fromDriverId:fromUserId,toDriverId:toUserId,at:acceptedAt,acceptedBy:user.id});}
    }
    transfer.status=data.status;transfer.respondedAt=new Date().toISOString();transfer.respondedBy=user.id;transfer.responseNote=String(data.responseNote||'').trim();if(data.status==='accepted')postCashTransfer(transfer,user.id);audit(user,`cash_transfer.${data.status}`,'cash_transfer',transfer.id,trip.id,{receiptNumber:transfer.receiptNumber,totals:transfer.totals});await saveDb();return json(res,200,cashTransferView(transfer,user));
  }
  if (part === 'settlements' && req.method === 'POST') {
    const data = await body(req); const driverId = ['driver','sales_manager'].includes(user.role) ? user.id : Number(data.driverId);
    const cashHolderIds=[...new Set(allCashItems().filter(item=>cashItemBelongsToTrip(item,trip.id)&&item.record.cashHolderUserId&&!item.record.cashHandedOverAt).map(item=>item.record.cashHolderUserId))];
    if (user.role!=='sales_manager'&&![trip.primaryDriverId,trip.secondaryDriverId,trip.salesManagerId,...cashHolderIds].includes(driverId)) return fail(res,400,'Vælg en medarbejder med ansvar på turen');
    if (db.cashSettlements.some(s=>s.tripId===trip.id&&s.driverId===driverId&&s.status==='pending')) return fail(res,409,'Medarbejderen har allerede en afstemning, der afventer godkendelse');
    const items = unsettledCashRecords(trip.id,driverId); if (!items.length) return fail(res,400,'Der er ingen uafstemte kontanter hos medarbejderen');
    if(items.some(item=>hasPendingTransferReference(`${item.kind}:${item.record.id}`)))return fail(res,409,'En eller flere betalinger afventer overførsel til en anden chauffør');
    if(items.some(item=>hasPendingCashExpenseReference(cashReference(item))))return fail(res,409,'En udgift fra kassen skal godkendes eller afvises før kontantafstemningen');
    const expected = cashAvailableAmounts(items); const delivered = { DKK:Number(data.deliveredDKK||0),EUR:Number(data.deliveredEUR||0) };
    if (delivered.DKK < 0 || delivered.EUR < 0) return fail(res,400,'Det afleverede beløb kan ikke være negativt');
    const settlement = { id:id(),tripId:trip.id,driverId,expected,delivered,difference:{DKK:delivered.DKK-expected.DKK,EUR:delivered.EUR-expected.EUR},note:String(data.note||'').trim(),paymentRefs:items.map(item=>`${item.kind}:${item.record.id}`),status:'pending',submittedAt:new Date().toISOString(),submittedBy:user.id,reviewedAt:null,reviewedBy:null,reviewNote:'' };
    db.cashSettlements.push(settlement);audit(user,'cash_settlement.submitted','cash_settlement',settlement.id,trip.id,{driverId,expected,delivered}); await saveDb(); return json(res,201,{...settlement,driverName:db.users.find(u=>u.id===driverId)?.name||'Ukendt',submittedByName:user.name});
  }
  if (part === 'settlements' && req.method === 'PATCH') {
    if (user.role !== 'admin') return fail(res,403,'Kun administratoren kan godkende kontantafstemninger');
    const data = await body(req); const settlement = db.cashSettlements.find(s=>s.id===Number(data.id)&&s.tripId===trip.id); if (!settlement) return fail(res,404,'Afstemningen findes ikke');
    if (settlement.status !== 'pending') return fail(res,409,'Afstemningen er allerede behandlet');
    if (!['approved','rejected'].includes(data.status)) return fail(res,400,'Vælg godkendt eller afvist');
    settlement.status=data.status;settlement.reviewedAt=new Date().toISOString();settlement.reviewedBy=user.id;settlement.reviewNote=String(data.reviewNote||'').trim();
    if (data.status === 'approved') { for (const ref of settlement.paymentRefs) { const item=cashRecordByReferenceAny(ref); if(item&&!item.record.cashHandedOverAt){item.record.cashHandedOverAt=settlement.reviewedAt;item.record.cashSettlementId=settlement.id;} } postSettlement(settlement,user.id); }
    audit(user,`cash_settlement.${data.status}`,'cash_settlement',settlement.id,trip.id,{driverId:settlement.driverId,difference:settlement.difference});await saveDb(); return json(res,200,{...settlement,driverName:db.users.find(u=>u.id===settlement.driverId)?.name||'Ukendt',submittedByName:db.users.find(u=>u.id===settlement.submittedBy)?.name||'Ukendt',reviewedByName:user.name});
  }
  return fail(res, 405, 'Handlingen er ikke tilladt');
}
function staticFile(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(requested).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.woff2':'font/woff2' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); fs.createReadStream(file).pipe(res); return true;
}
const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  try {
    await storageReady;
    await applyAutomaticTripLifecycle();
    const publicTicketMatch=pathname.match(/^\/ticket\/([^/]+)$/);
    if(publicTicketMatch&&req.method==='GET'){
      const page=publicTicketPage(req,decodeURIComponent(publicTicketMatch[1]));
      if(!page)return fail(res,404,'Billetten findes ikke eller QR-koden er ugyldig');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow'});return res.end(page);
    }
    if (pathname.startsWith('/api/') && !validRequestOrigin(req)) return fail(res, 403, 'Anmodningen kommer fra en ukendt adresse');
    if (pathname.startsWith('/api/')) await api(req, res, pathname);
    else if (!staticFile(res, pathname)) fail(res, 404, 'Ikke fundet');
  }
  catch (error) {
    if (!error.statusCode || error.statusCode >= 500) console.error(error);
    if (!res.headersSent) fail(res, error.statusCode|| (pathname === '/api/health' ? 503 : 500), pathname === '/api/health' ? 'Databasen er ikke klar' : error.statusCode?error.message:'Intern fejl');
    else res.destroy();
  }
});
async function shutdown(signal) {
  console.log(`${signal}: BusOps lukker sikkert ned`);
  await new Promise(resolve => server.listening ? server.close(resolve) : resolve());
  await storageWriteQueue.catch(() => {});
  if (pool) await pool.end();
}
function scheduleAutomaticBackups() {
  if(!(BACKUP_INTERVAL_HOURS>0)||!R2_CONFIGURED||!backupKey())return null;
  const interval=Math.max(60*60*1000,BACKUP_INTERVAL_HOURS*60*60*1000),run=async()=>{try{await createDatabaseBackup({reason:'scheduled'})}catch(error){systemEvent('critical','database_backup_failed','Automatisk databasebackup fejlede',{message:error.message});await saveDb().catch(()=>{});console.error('Automatisk databasebackup fejlede:',error.message)}};
  const timer=setInterval(run,interval);timer.unref();const first=setTimeout(run,Math.min(5*60*1000,interval));first.unref();return timer;
}
function scheduleAutomaticTripLifecycle() {
  const run=()=>storageReady.then(()=>applyAutomaticTripLifecycle()).catch(error=>console.error('Automatisk turstatus fejlede:',error.message));
  const timer=setInterval(run,30*1000);timer.unref();const first=setTimeout(run,1000);first.unref();return timer;
}
if (require.main === module) {
  server.listen(PORT, HOST, () => {console.log(`BusOps kører på http://${HOST}:${PORT} med ${DATABASE_URL ? 'PostgreSQL' : 'JSON-lagring'}`);scheduleAutomaticBackups();scheduleAutomaticTripLifecycle()});
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => shutdown(signal).finally(() => process.exit(0)));
}
module.exports = { server, seed, hashPassword, verifyPassword, seatMap, storageReady, fileStorage:{storeFile,removeStoredFile,r2Request,inspectStoredFiles,migrateStoredFilesToR2,backend:FILE_STORAGE_BACKEND,r2Configured:R2_CONFIGURED},maintenance:{createDatabaseBackup,restoreDatabaseBackupBytes,decryptDatabaseSnapshot,applyAutomaticBoardingOpenings,applyAutomaticTripStarts,applyAutomaticTripArrivals,applyAutomaticTripLifecycle,backupConfigured:Boolean(backupKey())} };
