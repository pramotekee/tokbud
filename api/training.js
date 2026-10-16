// api/training.js  (เปลี่ยนนามสกุลจาก .txt เป็น .js แล้ววางในโฟลเดอร์ api/)
// รับใบสมัครคอร์ส YOU TALK PEOPLE LIKE -> เขียนลง Tab "training" ใน Google Sheet เดียวกับ TOKBUD
//   GET  /api/training  -> อ่านสถานะ/ข้อมูลรอบเรียนจาก Tab "training_settings"
//   POST /api/training  -> บันทึกใบสมัคร 1 ใบสมัคร = 1 แถวใหม่เสมอ
// หลักการ: map คอลัมน์จาก "ชื่อหัวคอลัมน์" (แถว 1) ไม่ใช้ลำดับคอลัมน์
// (ผู้สมัครที่ผ่านขั้นตอน "popup survey" ใน landing page ส่ง surveyChoice = 1..4 มาด้วย -> เขียนลงคอลัมน์ SurveyAnswer)
// ใช้ env เดิม: GOOGLE_SERVICE_ACCOUNT_JSON, TOKBUD_SHEET_ID

const { google } = require('googleapis');

const TAB_APPLY = 'training';
const TAB_SETTINGS = 'training_settings';

// คอลัมน์ที่ต้องมีในแถว 1 ของ Tab training (TeamNote ไม่บังคับ)
const REQUIRED_COLS = [
  'Timestamp', 'ApplicationID', 'Round', 'FirstName', 'LastName', 'Gender', 'Age',
  'Email', 'Phone', 'Role', 'RoleOther', 'Interests', 'Package',
  'PartnerFirstName', 'PartnerLastName', 'PartnerGender', 'PartnerEmail',
  'CallbackDate', 'CallbackSlot', 'PDPAConsent', 'Status'
];

const GENDERS = ['ชาย', 'หญิง', 'ไม่ระบุ'];
const PACKAGES = ['SOLO', 'DUO'];
const SLOTS = ['09:00-12:00', '12:00-15:00', '15:00-18:00', 'หลัง 18:00'];
const DAYS = ['วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์', 'วันอาทิตย์'];
const ROLE_OTHER = 'อื่นๆ';

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

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const emailOk = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 120;
const phoneClean = (s) => String(s || '').replace(/[\s-]/g, '');
const phoneOk = (s) => /^(\+66|0)\d{8,9}$/.test(s);

// ---- Survey (popup 1 คำถามในหน้า landing) ----
// ลำดับ/ข้อความต้องตรงกับ OPTIONS ในหน้าเว็บ (หน้าเว็บส่งมาแค่เลข 1-4, ข้อความในชีทมาจากที่นี่เสมอ)
const SURVEY_OPTIONS = [
  '1. คุยกับคนอื่นแล้วอึดอัด เข้ากับคนยาก',
  '2. บางวันลื่น บางวันสะดุด เอาแน่เอานอนไม่ได้',
  '3. ไม่ได้มีปัญหา แต่รู้สึกว่าอยากทำได้ดีกว่านี้',
  '4. ค่อนข้างเก่งอยู่แล้ว และอยากเก่งขึ้นอีก'
];
function surveyLabel(v) {
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\d{1,2}$/.test(v.trim())) n = +v.trim();
  return Number.isInteger(n) && n >= 1 && n <= SURVEY_OPTIONS.length ? SURVEY_OPTIONS[n - 1] : '';
}

// แคชสั้นๆ ในหน่วยความจำของ instance: คนเข้าพร้อมกันหลายคนแชร์ผลการอ่าน header/settings ครั้งเดียว
// (กันชน quota ของ Google Sheets API ตอนมี traffic พุ่ง) — ใช้เฉพาะเส้นทาง survey; เส้นทางสมัครอ่านสดทุกครั้งเหมือนเดิม
const memo = {};
function cached(key, ttlMs, loader) {
  const e = memo[key];
  if (e && Date.now() - e.t < ttlMs) return e.p;
  const p = loader();
  memo[key] = { t: Date.now(), p };
  p.catch(() => { if (memo[key] && memo[key].p === p) delete memo[key]; });
  return p;
}
const SURVEY_CACHE_MS = 60 * 1000;

function bangkokNow() {
  return new Date(Date.now() + 7 * 3600 * 1000);
}
function bangkokTimestamp() {
  return bangkokNow().toISOString().replace('T', ' ').slice(0, 19);
}
function bangkokDateStr(offsetDays) {
  return new Date(bangkokNow().getTime() + offsetDays * 86400000).toISOString().slice(0, 10);
}

// อ่านการตั้งค่ารอบเรียนจาก Tab training_settings (อ่านตามชื่อหัวคอลัมน์)
async function readSettings(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: TAB_SETTINGS
  });
  const rows = res.data.values || [];
  const headers = (rows[0] || []).map(norm);
  const col = (name) => headers.indexOf(norm(name));

  // สถานะ: หาแถวที่ Key = RoundStatus แล้วอ่านคอลัมน์ Value
  let status = 'open';
  const kI = col('Key'), vI = col('Value');
  if (kI >= 0 && vI >= 0) {
    for (let i = 1; i < rows.length; i++) {
      if (norm(rows[i][kI]) === 'roundstatus') {
        status = norm(rows[i][vI]) === 'full' ? 'full' : 'open'; // มีแค่ "full" เท่านั้นที่ปิดรับ
        break;
      }
    }
  }

  // ข้อมูลรอบ: อ่านจากแถวที่ 2 (แถวข้อมูลแถวแรก) ใต้หัวคอลัมน์ RoundLabel ฯลฯ
  const first = rows[1] || [];
  const pick = (name) => {
    const i = col(name);
    return i >= 0 ? str(first[i], 200) : '';
  };
  return {
    status,
    round: {
      label: pick('RoundLabel'),
      date: pick('RoundDate'),
      time: pick('RoundTime'),
      location: pick('RoundLocation')
    }
  };
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { b = null; }
  }
  return b && typeof b === 'object' ? b : null;
}

// ตรวจข้อมูลฝั่งเซิร์ฟเวอร์ (ไม่เชื่อข้อมูลจากหน้าเว็บ) -> คืน { error } หรือ { data }
function validate(b) {
  const d = {
    applicationId: str(b.applicationId, 64),
    firstName: str(b.firstName, 60),
    lastName: str(b.lastName, 60),
    gender: str(b.gender, 20),
    age: str(b.age, 3),
    email: str(b.email, 120),
    phone: phoneClean(str(b.phone, 20)),
    role: str(b.role, 80),
    roleOther: str(b.roleOther, 100),
    interests: Array.isArray(b.interests)
      ? b.interests.map((x) => str(x, 100)).filter(Boolean).slice(0, 12) : [],
    pkg: str(b.package, 10),
    pFirst: str(b.partnerFirstName, 60),
    pLast: str(b.partnerLastName, 60),
    pGender: str(b.partnerGender, 20),
    pEmail: str(b.partnerEmail, 120),
    cbDate: str(b.callbackDate, 20),
    cbSlot: str(b.callbackSlot, 20),
    surveyAnswer: '' // filled below from surveyChoice if valid
  };

  const bad = [];
  if (!/^[A-Za-z0-9-]{8,64}$/.test(d.applicationId)) bad.push('applicationId');
  if (!d.firstName) bad.push('firstName');
  if (!d.lastName) bad.push('lastName');
  if (GENDERS.indexOf(d.gender) < 0) bad.push('gender');
  if (!/^\d{1,2}$/.test(d.age) || +d.age < 10) bad.push('age');
  if (!emailOk(d.email)) bad.push('email');
  if (!phoneOk(d.phone)) bad.push('phone');
  if (!d.role) bad.push('role');
  if (d.role === ROLE_OTHER && !d.roleOther) bad.push('roleOther');
  if (d.role !== ROLE_OTHER) d.roleOther = '';
  if (!d.interests.length) bad.push('interests');
  if (PACKAGES.indexOf(d.pkg) < 0) bad.push('package');
  if (d.pkg === 'DUO') {
    if (!d.pFirst) bad.push('partnerFirstName');
    if (!d.pLast) bad.push('partnerLastName');
    if (GENDERS.indexOf(d.pGender) < 0) bad.push('partnerGender');
    if (!emailOk(d.pEmail)) bad.push('partnerEmail');
  } else {
    d.pFirst = d.pLast = d.pGender = d.pEmail = '';
  }
  if (DAYS.indexOf(d.cbDate) < 0) bad.push('callbackDate');
  if (SLOTS.indexOf(d.cbSlot) < 0) bad.push('callbackSlot');
  if (b.consent !== true) bad.push('consent');
  d.surveyAnswer = surveyLabel(b.surveyChoice); // ไม่ถูกต้อง/ไม่มี = ปล่อยว่าง ไม่ทำให้ใบสมัครตก

  return bad.length ? { error: bad } : { data: d };
}

// ---------- POST (survey): popup 1 คำถามหน้า landing -> 1 คำตอบ = 1 แถว ไม่มี ApplicationID ----------
// ต้องมีคอลัมน์ Timestamp + SurveyAnswer เท่านั้น (Round ถ้ามีจะเติมให้) ไม่บังคับคอลัมน์ของใบสมัคร
// อ่าน header/settings ผ่านแคชสั้นๆ -> ตอนมีคนเข้าพร้อมกันมากๆ ใช้ Sheets API แค่ครั้งเดียวต่อคำตอบ (append)
async function handleSurvey(sheets, body, res) {
  const label = surveyLabel(body.surveyChoice);
  if (!label) {
    return res.status(400).json({ ok: false, error: 'invalid', message: 'ข้อมูลไม่ถูกต้อง' });
  }

  const headers = await cached('headers', SURVEY_CACHE_MS, async () => {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.TOKBUD_SHEET_ID,
      range: TAB_APPLY + '!1:1'
    });
    return (r.data.values && r.data.values[0]) || [];
  });
  const idx = {};
  headers.forEach((h, i) => { const k = norm(h); if (k && !(k in idx)) idx[k] = i; });

  if (!('timestamp' in idx) || !('surveyanswer' in idx)) {
    console.error('[training] survey: Tab "' + TAB_APPLY + '" ขาดคอลัมน์ Timestamp หรือ SurveyAnswer');
    return res.status(500).json({ ok: false, error: 'server', message: 'ระบบขัดข้อง' });
  }

  // Round เป็นข้อมูลเสริม: อ่านไม่ได้ก็ยังบันทึกคำตอบต่อ
  let roundLabel = '';
  if ('round' in idx) {
    try {
      const st = await cached('settings', SURVEY_CACHE_MS, () => readSettings(sheets));
      roundLabel = (st && st.round && st.round.label) || '';
    } catch (e) {
      console.warn('[training] survey: อ่านข้อมูลรอบไม่ได้ จะบันทึกโดยไม่ใส่ Round:', e && e.message ? e.message : e);
    }
  }

  const row = new Array(headers.length).fill('');
  row[idx.timestamp] = bangkokTimestamp();
  row[idx.surveyanswer] = label;
  if ('round' in idx) row[idx.round] = roundLabel;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: TAB_APPLY + '!A1',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
  return res.status(200).json({ ok: true });
}

module.exports = async function trainingHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.TOKBUD_SHEET_ID) {
    console.error('[training] env vars ไม่ครบ: GOOGLE_SERVICE_ACCOUNT_JSON / TOKBUD_SHEET_ID');
    return res.status(500).json({ ok: false, error: 'server', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
  }

  try {
    const sheets = getSheets();

    // ---------- GET: สถานะ + ข้อมูลรอบ ----------
    if (req.method === 'GET') {
      const s = await readSettings(sheets);
      return res.status(200).json({ ok: true, status: s.status, round: s.round });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'method', message: 'Method not allowed' });
    }

    // ---------- POST: รับใบสมัคร ----------
    const body = parseBody(req);
    if (!body) {
      return res.status(400).json({ ok: false, error: 'invalid', message: 'ข้อมูลไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง' });
    }

    // honeypot: บอทกรอกช่องที่ซ่อนไว้ -> ตอบสำเร็จหลอกๆ โดยไม่บันทึก
    if (str(body.website, 200)) {
      return res.status(200).json({ ok: true });
    }

    // popup survey (1 คำถามบนหน้า landing): 1 คำตอบ = 1 แถว ไม่มี ApplicationID
    if (body.action === 'survey') {
      return await handleSurvey(sheets, body, res);
    }

    const v = validate(body);
    if (v.error) {
      console.warn('[training] validation failed:', v.error.join(','));
      return res.status(400).json({
        ok: false, error: 'invalid', fields: v.error,
        message: 'ข้อมูลบางส่วนไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่อีกครั้ง'
      });
    }
    const d = v.data;

    // ปฏิเสธจริงๆ ฝั่งเซิร์ฟเวอร์เมื่อรอบเต็ม (ไม่ใช่แค่ซ่อนฟอร์ม)
    const settings = await readSettings(sheets);
    if (settings.status === 'full') {
      return res.status(409).json({ ok: false, error: 'full', message: 'รอบนี้เต็มแล้ว' });
    }

    // อ่านหัวคอลัมน์ของ Tab training (แถว 1) เพื่อ map ตามชื่อ
    const headRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.TOKBUD_SHEET_ID,
      range: TAB_APPLY + '!1:1'
    });
    const headers = (headRes.data.values && headRes.data.values[0]) || [];
    const idx = {};
    headers.forEach((h, i) => { const k = norm(h); if (k && !(k in idx)) idx[k] = i; });

    const missing = REQUIRED_COLS.filter((c) => !(norm(c) in idx));
    if (missing.length) {
      console.error('[training] Tab "' + TAB_APPLY + '" ขาดคอลัมน์:', missing.join(', '));
      return res.status(500).json({ ok: false, error: 'server', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
    }

    // กันบันทึกซ้ำจากการกดรัว/ลองส่งใหม่: ApplicationID เดิม = ใบสมัครเดิม
    const idCol = idx[norm('ApplicationID')];
    const colLetter = (n) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    const idRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.TOKBUD_SHEET_ID,
      range: TAB_APPLY + '!' + colLetter(idCol) + ':' + colLetter(idCol)
    });
    const existing = (idRes.data.values || []).map((r) => String(r[0] || ''));
    if (existing.indexOf(d.applicationId) >= 0) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    // ประกอบแถวตามชื่อคอลัมน์ (คอลัมน์ที่ไม่รู้จักปล่อยว่าง)
    const values = {
      Timestamp: bangkokTimestamp(),
      ApplicationID: d.applicationId,
      Round: settings.round.label,
      FirstName: d.firstName,
      LastName: d.lastName,
      Gender: d.gender,
      Age: d.age,
      Email: d.email,
      Phone: d.phone,
      Role: d.role,
      RoleOther: d.roleOther,
      Interests: d.interests.join(' | '),
      Package: d.pkg,
      PartnerFirstName: d.pFirst,
      PartnerLastName: d.pLast,
      PartnerGender: d.pGender,
      PartnerEmail: d.pEmail,
      CallbackDate: d.cbDate,
      CallbackSlot: d.cbSlot,
      PDPAConsent: 'yes',
      Status: 'new'
    };
    const row = new Array(headers.length).fill('');
    Object.keys(values).forEach((k) => { row[idx[norm(k)]] = values[k]; });
    // คำตอบ survey (ถ้ามี): คอลัมน์ SurveyAnswer ไม่บังคับ — ถ้าชีทไม่มีคอลัมน์นี้ ใบสมัครก็ยังบันทึกตามปกติ
    const surveyCol = idx[norm('SurveyAnswer')];
    if (surveyCol !== undefined) row[surveyCol] = d.surveyAnswer;
    else if (d.surveyAnswer) console.warn('[training] ไม่มีคอลัมน์ SurveyAnswer ใน Tab "' + TAB_APPLY + '" -> ไม่ได้บันทึกคำตอบ survey ของใบสมัครนี้');

    // RAW = เก็บเป็นข้อความตามที่ส่ง (เบอร์โทรขึ้นต้น 0 ไม่หาย, ไม่ตีความเป็นสูตร)
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.TOKBUD_SHEET_ID,
      range: TAB_APPLY + '!A1',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[training] error:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'server', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
  }
};
