// api/referral.js  (วางในโฟลเดอร์ api/ ข้าง training.js)
// หน้า admin ตรวจ/ใช้ referral code ของศิษย์เก่า
//   POST /api/referral {action:'login',  adminKey}
//   POST /api/referral {action:'check',  adminKey, code}                    -> เจ้าของโค้ดคือใคร เรียนรอบไหน
//   POST /api/referral {action:'redeem', adminKey, code, studentName}       -> +1 (เพิ่ม 1 แถวใน Tab "referral_log")
// ข้อมูลโค้ดอ่านจาก Tab "training" (คอลัมน์ RefCode / FirstName / LastName / Round — map ตามชื่อหัวคอลัมน์)
// ไม่ดูคอลัมน์ Status: โค้ดมีในชีท = ใช้ได้ (โค้ดแจกให้เฉพาะคนที่เรียนจบอยู่แล้ว)
// Tab "referral_log" หัวคอลัมน์แถว 1: Timestamp | RefCode | ReferrerName | NewStudentName  (1 กด Redeem = 1 แถว)
// env: GOOGLE_SERVICE_ACCOUNT_JSON, TOKBUD_SHEET_ID (เดิม) + REFERRAL_ADMIN_KEY (ใหม่ = รหัสผ่าน admin)

const { google } = require('googleapis');
const crypto = require('crypto');

const TAB_TRAINING = 'training';
const TAB_LOG = 'referral_log';
const LOG_COLS = ['Timestamp', 'RefCode', 'ReferrerName', 'NewStudentName'];
const TRAINING_COLS = ['RefCode', 'FirstName', 'LastName', 'Round'];
const NOT_FOUND_MSG = 'ไม่พบ referral code นี้ในระบบ โปรดลองใหม่';
const SHEETS_TIMEOUT_MS = 20000;

let authSingleton = null;
function getSheets() {
  if (!authSingleton) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    authSingleton = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }
  return google.sheets({ version: 'v4', auth: authSingleton });
}

// กัน Google Sheets ค้าง: ถ้าเกินเวลา -> error (ผู้ใช้เห็นข้อความให้ลองใหม่) ไม่ปล่อยให้หน้าเว็บหมุนค้าง
function withTimeout(p, ms) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('sheets timeout')), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const nameKey = (s) => norm(s).replace(/\s+/g, ''); // เทียบชื่อ: ไม่สนช่องว่าง/ตัวพิมพ์
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bangkokTimestamp() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { b = null; }
  }
  return b && typeof b === 'object' ? b : null;
}

// เทียบรหัสผ่านแบบ constant-time (hash ก่อนเพื่อให้ความยาวเท่ากัน)
function keyOk(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(process.env.REFERRAL_ADMIN_KEY)).digest();
  return crypto.timingSafeEqual(a, b);
}

// code ที่ admin พิมพ์: ตัดช่องว่าง/ขีด ตัวพิมพ์ใหญ่ ; รูปแบบไม่ตรง = ถือว่าไม่พบ (ข้อความเดียวกัน)
function cleanCode(v) {
  const c = String(v == null ? '' : v).toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{4,12}$/.test(c) ? c : '';
}

function headerIndex(headers) {
  const idx = {};
  headers.forEach((h, i) => { const k = norm(h); if (k && !(k in idx)) idx[k] = i; });
  return idx;
}

// หาเจ้าของโค้ดใน Tab training -> { name, round } | null ; throw ถ้าชีทขาดคอลัมน์
async function findOwner(sheets, code) {
  const res = await withTimeout(sheets.spreadsheets.values.get({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: TAB_TRAINING
  }), SHEETS_TIMEOUT_MS);
  const rows = res.data.values || [];
  const idx = headerIndex(rows[0] || []);
  const missing = TRAINING_COLS.filter((c) => !(norm(c) in idx));
  if (missing.length) throw new Error('Tab "' + TAB_TRAINING + '" ขาดคอลัมน์: ' + missing.join(', '));
  const cRef = idx[norm('RefCode')], cF = idx[norm('FirstName')], cL = idx[norm('LastName')], cR = idx[norm('Round')];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (String(r[cRef] || '').trim().toUpperCase() === code) {
      const name = (String(r[cF] || '').trim() + ' ' + String(r[cL] || '').trim()).trim();
      return { name, round: String(r[cR] || '').trim() };
    }
  }
  return null;
}

// อ่าน referral_log ทั้งหมด -> { headers, idx, rows }
async function readLog(sheets) {
  const res = await withTimeout(sheets.spreadsheets.values.get({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: TAB_LOG
  }), SHEETS_TIMEOUT_MS);
  const rows = res.data.values || [];
  const headers = rows[0] || [];
  const idx = headerIndex(headers);
  const missing = LOG_COLS.filter((c) => !(norm(c) in idx));
  if (missing.length) throw new Error('Tab "' + TAB_LOG + '" ขาดคอลัมน์: ' + missing.join(', '));
  return { headers, idx, rows };
}

module.exports = async function referralHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method', message: 'Method not allowed' });
  }
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.TOKBUD_SHEET_ID || !process.env.REFERRAL_ADMIN_KEY) {
    console.error('[referral] env vars ไม่ครบ: GOOGLE_SERVICE_ACCOUNT_JSON / TOKBUD_SHEET_ID / REFERRAL_ADMIN_KEY');
    return res.status(500).json({ ok: false, error: 'server', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
  }

  const body = parseBody(req);
  if (!body) {
    return res.status(400).json({ ok: false, error: 'invalid', message: 'ข้อมูลไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง' });
  }

  // ทุก action ต้องผ่านรหัสผ่าน admin ; ผิด = หน่วง 1 วินาที (ชะลอการเดารหัส)
  if (!keyOk(body.adminKey)) {
    await sleep(1000);
    return res.status(401).json({ ok: false, error: 'auth', message: 'รหัสผ่านไม่ถูกต้อง' });
  }

  try {
    if (body.action === 'login') {
      return res.status(200).json({ ok: true });
    }

    const code = cleanCode(body.code);

    if (body.action === 'check') {
      if (!code) return res.status(200).json({ ok: true, found: false, message: NOT_FOUND_MSG });
      const owner = await findOwner(getSheets(), code);
      if (!owner) return res.status(200).json({ ok: true, found: false, message: NOT_FOUND_MSG });
      return res.status(200).json({ ok: true, found: true, owner });
    }

    if (body.action === 'redeem') {
      const studentName = str(body.studentName, 120);
      if (studentName.length < 2) {
        return res.status(400).json({ ok: false, error: 'invalid', message: 'กรุณากรอกชื่อผู้สมัครใหม่' });
      }
      if (!code) return res.status(200).json({ ok: true, found: false, message: NOT_FOUND_MSG });

      const sheets = getSheets();
      // ตรวจโค้ดซ้ำที่เซิร์ฟเวอร์ (ไม่เชื่อว่าหน้าเว็บ check มาแล้ว)
      const owner = await findOwner(sheets, code);
      if (!owner) return res.status(200).json({ ok: true, found: false, message: NOT_FOUND_MSG });

      // กันใช้โค้ดตัวเอง
      if (nameKey(studentName) === nameKey(owner.name)) {
        return res.status(200).json({ ok: false, error: 'self', message: 'ชื่อผู้สมัครใหม่เป็นชื่อเดียวกับเจ้าของโค้ด ใช้โค้ดของตัวเองไม่ได้' });
      }

      // กันนับซ้ำ: โค้ดเดียวกัน + ชื่อเดียวกัน ที่อยู่ใน log แล้ว
      const log = await readLog(sheets);
      const cCode = log.idx[norm('RefCode')], cStu = log.idx[norm('NewStudentName')];
      let countBefore = 0;
      for (let i = 1; i < log.rows.length; i++) {
        const r = log.rows[i] || [];
        if (String(r[cCode] || '').trim().toUpperCase() !== code) continue;
        countBefore++;
        if (nameKey(r[cStu]) === nameKey(studentName)) {
          return res.status(200).json({
            ok: false, error: 'duplicate',
            message: 'ชื่อนี้ใช้ referral code นี้ไปแล้ว ไม่นับซ้ำ',
            count: countBefore
          });
        }
      }

      const values = {
        Timestamp: bangkokTimestamp(),
        RefCode: code,
        ReferrerName: owner.name,
        NewStudentName: studentName
      };
      const row = new Array(log.headers.length).fill('');
      Object.keys(values).forEach((k) => { row[log.idx[norm(k)]] = values[k]; });

      // RAW = เก็บเป็นข้อความตามที่ส่ง (ชื่อที่ขึ้นต้นด้วย = ไม่ถูกตีเป็นสูตร) ; append แถวเดียว = ไม่มี read-modify-write ของตัวนับ
      await withTimeout(sheets.spreadsheets.values.append({
        spreadsheetId: process.env.TOKBUD_SHEET_ID,
        range: TAB_LOG + '!A1',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] }
      }), SHEETS_TIMEOUT_MS);

      return res.status(200).json({ ok: true, redeemed: true, owner, studentName, count: countBefore + 1 });
    }

    return res.status(400).json({ ok: false, error: 'invalid', message: 'ข้อมูลไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง' });
  } catch (err) {
    console.error('[referral] error:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'server', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
  }
};
