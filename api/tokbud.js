// /api/tokbud.js
// Router รวมไฟล์เดียว รับ ?action=xxx เหมือน handle() เดิมใน appscript.txt
// รอบนี้พอร์ตแค่ 3 action แรก (read-only ล้วน ไม่แก้ข้อมูลอะไรเลย) เพื่อทดสอบคู่ขนานกับของเดิมก่อน:
//   - getCategories
//   - getCardColors
//   - getCompanies (home feed: filter/sort/pagination + สรุปข้อมูลบริษัทแต่ละใบ)
//
// ตาม decision ที่ตกลงกันไว้: ยังไม่ใช้ cache เลยตอนนี้ (Vercel cold start เร็วพอ ข้อมูลยังน้อย)
// อ่าน Sheet สดใหม่ทุกครั้งที่มีคำขอเข้ามา — ถ้าข้อมูลโตจนรู้สึกช้าจริงค่อยกลับมาเพิ่ม cache ทีหลัง

const { google } = require('googleapis');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Readable } = require('stream');

const SHEETS = {
  USERS: 'users',
  COMPANIES: 'companies',
  VOTES: 'votes',
  CATEGORIES: 'categories',
  DELETEREQUESTS: 'deleterequests'
};

// หมายเหตุ: ลำดับคอลัมน์จริงของ tab users ไม่ได้ fix ไว้ในโค้ดแล้ว — ทุกจุดที่เขียน/หาตำแหน่งคอลัมน์
// จะอ่านชื่อ header จากแถวแรกของชีทสดๆ ทุกครั้ง (ดู parseRowsWithHeaders/colIndexByName ด้านล่าง)
// ตรงตามหลักการเดิมของ appscript.txt (getHeaders()+colIndex()) — สลับลำดับคอลัมน์ในชีทเองได้อิสระ
// ไม่ต้องมาคอยเช็ค/ล็อคลำดับให้ตรงกับโค้ดอีกต่อไป

// พอร์ตตรงจาก appscript.txt บรรทัด 146-159 เป๊ะๆ ห้ามเปลี่ยนลำดับ/ค่าสี เพราะ index ของสีผูกกับข้อมูลเดิมในชีท
const CARD_COLORS = [
  { name: 'แดง', hex: '#E06666' },
  { name: 'ส้ม', hex: '#F6B26B' },
  { name: 'เหลือง', hex: '#FFD966' },
  { name: 'เขียว', hex: '#93C47D' },
  { name: 'มิ้นท์', hex: '#76C7B7' },
  { name: 'ฟ้า', hex: '#76A5AF' },
  { name: 'น้ำเงินอ่อน', hex: '#6D9EEB' },
  { name: 'น้ำเงิน', hex: '#4A86E8' },
  { name: 'ม่วง', hex: '#8E7CC3' },
  { name: 'ชมพู', hex: '#C27BA0' },
  { name: 'น้ำตาล', hex: '#A67C52' },
  { name: 'เทา', hex: '#666666' }
];

// ===== Google auth + Sheets/Drive clients (share credential เดียวกัน) =====
let authClientSingleton = null;
function getAuthClient() {
  if (!authClientSingleton) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    authClientSingleton = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      // เพิ่ม scope drive.file เข้ามาด้วย (รอบนี้ต้องใช้ตอน uploadImage) — drive.file แคบกว่า drive เต็ม
      // (เข้าถึงได้แค่ไฟล์ที่ service account นี้เป็นคนสร้างเอง ไม่ใช่ทุกไฟล์ใน Drive) ปลอดภัยกว่าตาม least-privilege
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file'
      ]
    });
  }
  return authClientSingleton;
}

let sheetsClientPromise = null;
function getSheetsClient() {
  if (!sheetsClientPromise) sheetsClientPromise = google.sheets({ version: 'v4', auth: getAuthClient() });
  return sheetsClientPromise;
}

let driveClientPromise = null;
function getDriveClient() {
  if (!driveClientPromise) driveClientPromise = google.drive({ version: 'v3', auth: getAuthClient() });
  return driveClientPromise;
}

// เทียบเท่า rowsToObjects() เดิมใน appscript.txt (บรรทัด 200-210) — แปลง 2D array (แถวแรก=header)
// เป็น array of object โดยใช้ header เป็น key (คืน headers จริงที่อ่านเจอมาด้วย ไม่สมมติลำดับตายตัว —
// ตรงตามหลักการเดิมของ getHeaders()/colIndex() ใน appscript.txt ที่หาตำแหน่งคอลัมน์จากชื่อสดทุกครั้ง)
function rowsToObjects(rows) {
  const parsed = parseRowsWithHeaders(rows);
  return parsed.objects;
}
function parseRowsWithHeaders(rows) {
  if (!rows || rows.length < 1) return { headers: [], objects: [] };
  const headers = rows[0].map(h => String(h || '').trim());
  const objects = rows.slice(1).map((r, i) => {
    const obj = {};
    headers.forEach((h, ci) => { obj[h] = r[ci] !== undefined ? r[ci] : ''; });
    obj._row = i + 2;
    return obj;
  });
  return { headers, objects };
}

// อ่าน tab ที่ต้องใช้ทั้งหมดในคำขอเดียว (batchGet) แทนที่จะยิงแยกทีละ tab เหมือน Apps Script เดิม
// (Apps Script เปิด spreadsheet ใหม่ทุกครั้งที่อ่านคนละ tab ซึ่งเป็นส่วนหนึ่งของปัญหาช้าเดิม —
// Sheets API รองรับขอหลาย range ในคำขอ HTTP เดียวได้เลย ไม่มีเหตุผลต้องแยกยิง)
async function loadAllSheetsData() {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.TOKBUD_SHEET_ID;
  const tabOrder = [SHEETS.COMPANIES, SHEETS.VOTES, SHEETS.USERS, SHEETS.CATEGORIES, SHEETS.DELETEREQUESTS];

  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: tabOrder
  });

  const [companiesRows, votesRows, usersRows, categoriesRows, deleteReqRows] =
    res.data.valueRanges.map(v => v.values || []);

  return {
    companies: rowsToObjects(companiesRows),
    votes: rowsToObjects(votesRows),
    users: rowsToObjects(usersRows),
    categories: (categoriesRows.slice(1) || []).map(r => r[0]).filter(Boolean),
    deleteRequests: rowsToObjects(deleteReqRows)
  };
}

function buildUserMap(users) {
  const map = {};
  users.forEach(u => { map[u.user_id] = u; });
  return map;
}

function buildVotesByCompany(votes) {
  const map = {};
  votes.forEach(v => {
    if (!map[v.company_id]) map[v.company_id] = [];
    map[v.company_id].push(v);
  });
  return map;
}

// พอร์ตตรงจาก summarizeCompany() เดิม (appscript.txt บรรทัด 1010-1031)
function summarizeCompany(t, votes, userMap) {
  const companyVotes = votes.filter(v => v.company_id === t.company_id);
  const joinVotes = companyVotes.filter(v => v.side === 'A');
  const leaveVotes = companyVotes.filter(v => v.side === 'B');
  const creator = userMap ? userMap[t.user_id] : null;

  return {
    company_id: t.company_id,
    company_name: t.company_name,
    description: t.description,
    image_url: t.image_url_display,
    card_color: t.card_color,
    category: t.category,
    tags: [t.tag_1, t.tag_2, t.tag_3, t.tag_4, t.tag_5].filter(Boolean),
    total_votes: companyVotes.length,
    join_count: joinVotes.length,
    leave_count: leaveVotes.length,
    start_date: t.start_date,
    creator_username: creator ? creator.username : '',
    creator_profile_image: creator ? creator.profile_image_url : ''
  };
}

// พอร์ตตรงจาก _seededHash() เดิม (บรรทัด 1135-1142) — ใช้ทำโหมด shuffle แบบสุ่มคงที่ตาม seed
function seededHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// พอร์ตตรงจาก _companyNameSortKey() + _compareNameKeys() เดิม (บรรทัด 1148-1174)
function companyNameSortKey(name) {
  const s = String(name == null ? '' : name).trim().toLowerCase();
  const ch = s.charAt(0);
  let group = 3;
  if (!ch) group = 0;
  else if (ch >= '0' && ch <= '9') group = 1;
  else if (ch >= 'a' && ch <= 'z') group = 2;
  else if (/[\x00-\x7F]/.test(ch)) group = 0;
  return { group, tokens: s.match(/\d+|\D+/g) || [] };
}

function compareNameKeys(a, b) {
  if (a.group !== b.group) return a.group - b.group;
  const n = Math.min(a.tokens.length, b.tokens.length);
  for (let i = 0; i < n; i++) {
    const x = a.tokens[i], y = b.tokens[i];
    const xNum = /^\d/.test(x), yNum = /^\d/.test(y);
    if (xNum && yNum) {
      const dx = parseInt(x, 10), dy = parseInt(y, 10);
      if (dx !== dy) return dx < dy ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.tokens.length - b.tokens.length;
}

// พอร์ตตรงจาก _paginate() เดิม (บรรทัด 1120-1131)
function paginate(list, p) {
  const total = list.length;
  const ALLOWED_PAGE_SIZES = [20, 50, 100];
  let pageSize = parseInt(p.page_size, 10);
  if (ALLOWED_PAGE_SIZES.indexOf(pageSize) === -1) pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  let page = parseInt(p.page, 10);
  if (!page || page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  const pageSlice = list.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  return { pageSlice, total, page, pageSize, totalPages };
}

function ok(data) { return Object.assign({ success: true }, data); }
function fail(message) { return { success: false, message }; }

// อ่าน tab เดียวแบบเบาที่สุด (ไม่พ่วง tab อื่นเหมือน loadAllSheetsData) — ใช้กับ action ที่ต้องการแค่ users
// เท่านั้น (signup/login) จะได้ไม่ต้องแบกภาระอ่าน companies/votes/categories ที่ไม่เกี่ยวข้องไปด้วยทุกครั้ง
async function getSheetRows(tabName) {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.TOKBUD_SHEET_ID;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: tabName });
  return res.data.values || [];
}

// แปลงเลขคอลัมน์ (1-based) เป็นตัวอักษรคอลัมน์สเปรดชีต เช่น 1 -> A, 13 -> M, 27 -> AA
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// เทียบเท่า colIndex() เดิม (บรรทัด 194-198) — หาตำแหน่งคอลัมน์จากชื่อ header จริง ไม่สมมติลำดับ
// throw ถ้าหาไม่เจอ (เช่น พิมพ์ชื่อคอลัมน์ผิด หรือ Pop ลบคอลัมน์นั้นออกจากชีทไปแล้วจริงๆ) เหมือนต้นฉบับ
function colIndexByName(headers, name) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error('ไม่พบคอลัมน์ "' + name + '" ในชีท (header row)');
  return idx + 1; // คืนเป็น 1-based
}
function normalizePhone(phone) {
  let p = String(phone).trim().replace(/[^0-9]/g, '');
  if (p.length === 9 && p.charAt(0) !== '0') p = '0' + p;
  return p;
}

// พอร์ตตรงจาก calculateAge() เดิม (บรรทัด 271-278) — คำนวณไว้เผื่อใช้ในอนาคต แต่ไม่ได้เซฟลงชีท
// (ชีทจริงไม่มีคอลัมน์ age ดูคอมเมนต์ที่ USERS_HEADERS ด้านบน — พฤติกรรมเดิมเป๊ะ ไม่ได้ตกหล่นใหม่)
function calculateAge(birthday) {
  const b = new Date(birthday);
  const today = new Date();
  let age = today.getFullYear() - b.getFullYear();
  const m = today.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < b.getDate())) age--;
  return age;
}

// พอร์ตตรงจาก validateCountryCityState() เดิม (บรรทัด 822-830)
function validateCountryCityState(country, rawCityState) {
  const cityState = String(rawCityState || '').trim().slice(0, 100);
  if (country !== 'Thailand' && !cityState) {
    return { ok: false, message: 'Please enter your city/state' };
  }
  return { ok: true, cityState };
}

// พอร์ตตรงจาก driveThumbUrl()/normalizeImageUrl() เดิม (บรรทัด 303-316)
function driveThumbUrl(fileId) {
  return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1600';
}
function normalizeImageUrl(url) {
  if (!url) return '';
  url = String(url).trim();
  let m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return driveThumbUrl(m[1]);
  m = url.match(/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return driveThumbUrl(m[1]);
  m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return driveThumbUrl(m[1]);
  return url;
}

// พอร์ตตรงจาก generateCode()/generateUniqueCode() เดิม (บรรทัด 251-267) — รหัส 8 หลัก ตัวพิมพ์ใหญ่
// ตัดตัวที่สับสน (0,O,1,I,L) เช็คไม่ให้ชนกับ user_id ที่มีอยู่แล้วในชีทจริง (ไม่ใช่แค่สุ่มมั่ว)
function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}
function generateUniqueCode(existingIds) {
  let code;
  do { code = generateCode(); } while (existingIds.indexOf(code) !== -1);
  return code;
}

// พอร์ตตรงจาก findUserByToken() เดิม (บรรทัด 914-920) — ไม่มี cache (ตกลงกันไว้แล้วว่ายังไม่ทำ cache รอบนี้)
// เลยอ่านชีท users สดทุกครั้งที่มี action ไหนต้องยืนยันตัวตนผ่าน session_token
async function findUserByToken(token) {
  if (!token) return null;
  const rows = await getSheetRows(SHEETS.USERS);
  const { objects: users } = parseRowsWithHeaders(rows);
  const user = users.find(u => u.session_token === token) || null;
  if (user && user.account_status === 'deleted') return null;
  return user;
}

// พอร์ตตรงจาก getAgeGroup() เดิม (บรรทัด 280-287)
function getAgeGroup(age) {
  if (age < 18) return 'ต่ำกว่า 18';
  if (age <= 24) return '18-24';
  if (age <= 34) return '25-34';
  if (age <= 44) return '35-44';
  if (age <= 54) return '45-54';
  return '55+';
}

function validYNU(v) {
  return v === 'yes' || v === 'no' || v === 'unsure';
}

// พอร์ตตรงจาก isEnglishOnlyName() เดิม (บรรทัด 964-970) — บังคับชื่อบริษัทเป็นภาษาอังกฤษเท่านั้น
function isEnglishOnlyName(str) {
  const s = String(str || '').trim();
  if (!s) return false;
  if (!/^[a-zA-Z0-9 &,.\-'()]+$/.test(s)) return false;
  if (!/[a-zA-Z0-9]/.test(s)) return false;
  return true;
}
const ENGLISH_ONLY_NAME_ERROR = 'กรุณาตั้งชื่อบริษัทเป็นภาษาอังกฤษเท่านั้น / Company name must be in English only';

// ===== Actions =====

async function actionGetCategories() {
  const data = await loadAllSheetsData();
  return ok({ categories: data.categories });
}

function actionGetCardColors() {
  return ok({ colors: CARD_COLORS });
}

// พอร์ตตรงจาก actionGetCompanies()/_getCompaniesPayload() เดิม (บรรทัด 1176-1231) — รวม logic
// การกรองสถานะ active + hidden (จาก deleterequests) ที่เดิมอยู่ใน loadActiveCompaniesRaw() เข้ามาด้วย
async function actionGetCompanies(p) {
  const data = await loadAllSheetsData();

  const hiddenIds = data.deleteRequests.filter(r => r.status === 'delete').map(r => r.company_id);
  let visible = data.companies.filter(t => t.status === 'active' && hiddenIds.indexOf(t.company_id) === -1);

  const votesByCompany = buildVotesByCompany(data.votes);
  const userMap = buildUserMap(data.users);

  if (p.category) {
    visible = visible.filter(t =>
      String(t.category || '').split(',').map(c => c.trim()).indexOf(p.category) !== -1
    );
  }
  if (p.tag) {
    visible = visible.filter(t => [t.tag_1, t.tag_2, t.tag_3, t.tag_4, t.tag_5].indexOf(p.tag) !== -1);
  }
  if (p.search) {
    const q = String(p.search).toLowerCase();
    visible = visible.filter(t =>
      String(t.company_name).toLowerCase().indexOf(q) !== -1 ||
      String(t.description).toLowerCase().indexOf(q) !== -1 ||
      [t.tag_1, t.tag_2, t.tag_3, t.tag_4, t.tag_5].some(tag => String(tag).toLowerCase().indexOf(q) !== -1)
    );
  } else {
    visible = visible.slice();
  }

  const sortMode = (p.sort === 'shuffle' || p.sort === 'popular' || p.sort === 'name_asc' || p.sort === 'name_desc')
    ? p.sort : 'latest';

  if (sortMode === 'name_asc' || sortMode === 'name_desc') {
    const dir = sortMode === 'name_desc' ? -1 : 1;
    visible = visible
      .map(t => ({ t, k: companyNameSortKey(t.company_name) }))
      .sort((x, y) => {
        const c = compareNameKeys(x.k, y.k);
        if (c !== 0) return c * dir;
        const d = new Date(x.t.created_at) - new Date(y.t.created_at);
        if (d !== 0) return d;
        return String(x.t.company_id) < String(y.t.company_id) ? -1 : 1;
      })
      .map(o => o.t);
  } else if (sortMode === 'shuffle') {
    const seed = String(p.shuffle_seed || '');
    visible.sort((a, b) => seededHash(a.company_id + seed) - seededHash(b.company_id + seed));
  } else if (sortMode === 'popular') {
    visible.sort((a, b) => {
      const diff = (votesByCompany[b.company_id] || []).length - (votesByCompany[a.company_id] || []).length;
      if (diff !== 0) return diff;
      return new Date(a.created_at) - new Date(b.created_at);
    });
  } else {
    visible.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  const { pageSlice, total, page, pageSize, totalPages } = paginate(visible, p);
  const result = pageSlice.map(t => summarizeCompany(t, votesByCompany[t.company_id] || [], userMap));

  return ok({ companies: result, count: total, page, page_size: pageSize, total_pages: totalPages });
}

// พอร์ตตรงจาก actionSignup() เดิม (บรรทัด 832-892) — ข้ามส่วน LockService (ตกลงกับ Pop แล้วว่าข้ามไปก่อน
// ตอนนี้ traffic ยังน้อยมาก) จุดที่ต่างจากต้นฉบับจริงๆ คือ passcode ตอนนี้ hash ด้วย bcrypt ก่อนเก็บ
// (ตัดสินใจร่วมกับ Pop — ยังไม่มี user จริงเลยตอนนี้ ทำตั้งแต่ต้นดีกว่ารอ migrate ทีหลัง)
async function actionSignup(p) {
  const required = ['username', 'email', 'phone', 'passcode', 'birthday', 'gender', 'country'];
  for (const f of required) {
    if (!p[f]) return fail('กรุณากรอก ' + f + ' ให้ครบ');
  }
  if (p.country === 'Thailand' && !p.province) {
    return fail('กรุณาเลือกจังหวัด / Please select a province');
  }
  const cityStateCheck = validateCountryCityState(p.country, p.city_state);
  if (!cityStateCheck.ok) return fail(cityStateCheck.message);

  if (String(p.email).indexOf('@') === -1) {
    return fail('อีเมลไม่ถูกต้อง กรุณาใส่ @ ด้วย / Invalid email, please include an @');
  }

  const rows = await getSheetRows(SHEETS.USERS);
  const { headers, objects: users } = parseRowsWithHeaders(rows);
  const phone = normalizePhone(p.phone);

  if (users.some(u => normalizePhone(u.phone) === phone)) {
    return fail('เบอร์นี้เคยสมัครแล้ว กรุณา login แทน / This phone number is already registered, please log in instead');
  }

  const existingIds = users.map(u => u.user_id);
  const userId = generateUniqueCode(existingIds);
  const sessionToken = crypto.randomUUID();
  const profileImageUrl = normalizeImageUrl(p.profile_image_url || '');
  const nowIso = new Date().toISOString();
  // bcrypt.hash ครั้งเดียว ได้ string ที่เก็บทั้ง algorithm/cost/salt/hash รวมกันในตัว (ขึ้นต้น $2a$หรือ $2b$)
  // ไม่ต้องเก็บ salt แยกคอลัมน์เอง bcrypt.compare() ตอน login จะแกะ salt จากในนี้ให้เองอัตโนมัติ
  const passcodeHash = await bcrypt.hash(String(p.passcode), 10);

  // ใช้ header จริงที่อ่านจากแถวแรกของชีท (headers) ไม่ใช่ลำดับตายตัวในโค้ด — สลับลำดับคอลัมน์ในชีท
  // เองได้อิสระ ไม่กระทบ คอลัมน์ไหนที่ไม่มีค่าที่ต้องเซฟ (เช่น plan/stripe ที่ยังไม่ใช้ตอนสมัคร) จะเว้นว่างไว้
  const rowMap = {
    user_id: userId,
    username: p.username,
    email: p.email,
    phone: phone,
    passcode: passcodeHash,
    birthday: p.birthday,
    gender: p.gender,
    province: p.country === 'Thailand' ? p.province : '',
    country: p.country,
    city_state: cityStateCheck.cityState,
    profile_image_url: profileImageUrl,
    created_at: nowIso,
    session_token: sessionToken,
    account_status: 'active'
  };
  const rowValues = headers.map(h => (rowMap[h] !== undefined ? rowMap[h] : ''));

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: SHEETS.USERS,
    valueInputOption: 'RAW', // RAW = เก็บ string ตามที่ส่งไปเป๊ะ ไม่ auto-parse เลขนำหน้า 0 ของเบอร์โทรทิ้ง
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowValues] }
  });

  return ok({ user_id: userId, session_token: sessionToken, username: p.username, profile_image_url: profileImageUrl });
}

// พอร์ตตรงจาก actionLogin() เดิม (บรรทัด 895-912) — เทียบ passcode ด้วย bcrypt.compare() แทนการเทียบ
// string ตรงๆ (ดูคอมเมนต์ที่ actionSignup ด้านบน)
async function actionLogin(p) {
  if (!p.phone || !p.passcode) {
    return fail('กรุณากรอกเบอร์โทรและ Passcode / Please enter your phone number and Passcode');
  }

  const rows = await getSheetRows(SHEETS.USERS);
  const { headers, objects: users } = parseRowsWithHeaders(rows);
  const phone = normalizePhone(p.phone);
  const user = users.find(u => normalizePhone(u.phone) === phone);

  // เช็คแยกจากการหา user ก่อน (ไม่รวมเงื่อนไขเดียวกับ .find) เพราะ bcrypt.compare() เป็น async รอผลได้
  // ต้องมี user ตัวจริงให้เทียบ hash ด้วยก่อน ถ้าไม่เจอเบอร์เลยให้ fail ทันทีไม่ต้องเรียก bcrypt เปล่าๆ
  if (!user) return fail('เบอร์โทรหรือ Passcode ไม่ถูกต้อง / Incorrect phone number or Passcode');

  const passcodeMatches = await bcrypt.compare(String(p.passcode), String(user.passcode || ''));
  if (!passcodeMatches) return fail('เบอร์โทรหรือ Passcode ไม่ถูกต้อง / Incorrect phone number or Passcode');
  if (user.account_status === 'deleted') return fail('บัญชีนี้ถูกปิดใช้งานไปแล้ว / This account has been closed');

  const newToken = crypto.randomUUID();
  const sessionTokenCol = colIndexByName(headers, 'session_token');
  const cellRange = SHEETS.USERS + '!' + colLetter(sessionTokenCol) + user._row;

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: cellRange,
    valueInputOption: 'RAW',
    requestBody: { values: [[newToken]] }
  });

  return ok({ user_id: user.user_id, session_token: newToken, username: user.username, profile_image_url: user.profile_image_url || '' });
}

// action ให้ user ตั้ง passcode ใหม่ได้เอง 100% ไม่ต้องผ่าน Pop/LINE/email service ใดๆ เลย — เช็คตัวตนด้วย
// "เบอร์โทร + อีเมล" ที่กรอกไว้ตอนสมัครต้องตรงกันทั้งคู่ (ข้อมูลที่มีอยู่แล้ว ไม่ต้องเพิ่มช่องใหม่ตอนสมัคร)
// หมายเหตุด้านความปลอดภัย (แจ้งไว้ตรงๆ ไม่ใช่ตัดสินใจเงียบๆ): นี่ไม่ใช่การยืนยันตัวตนแบบ verified
// จริงจัง (อีเมล/เบอร์ไม่เคยถูกยืนยันว่าเป็นของจริงตั้งแต่ตอนสมัครอยู่แล้ว) เป็นแค่ "รู้ข้อมูล 2 อย่างพร้อมกัน"
// ซึ่งยากกว่ารู้แค่เบอร์อย่างเดียว แต่ไม่ได้ปลอดภัยระดับธนาคาร เหมาะกับสเกลปัจจุบัน ถ้า TOKBUD โตขึ้นเยอะ
// ค่อยพิจารณากลับมาทำ email verification link จริงจังทีหลังได้
async function actionResetPasscode(p) {
  if (!p.phone || !p.email || !p.new_passcode) {
    return fail('กรุณากรอกเบอร์โทร อีเมล และ passcode ใหม่ให้ครบ / Please fill in phone, email, and new passcode');
  }

  const rows = await getSheetRows(SHEETS.USERS);
  const { headers, objects: users } = parseRowsWithHeaders(rows);
  const phone = normalizePhone(p.phone);
  const email = String(p.email).trim().toLowerCase();

  const user = users.find(u =>
    normalizePhone(u.phone) === phone && String(u.email || '').trim().toLowerCase() === email
  );

  if (!user) {
    return fail('เบอร์โทรหรืออีเมลไม่ตรงกับข้อมูลที่สมัครไว้ / Phone number or email doesn\'t match our records');
  }
  if (user.account_status === 'deleted') {
    return fail('บัญชีนี้ถูกปิดใช้งานไปแล้ว / This account has been closed');
  }

  const newHash = await bcrypt.hash(String(p.new_passcode), 10);
  const passcodeCol = colIndexByName(headers, 'passcode');
  const cellRange = SHEETS.USERS + '!' + colLetter(passcodeCol) + user._row;

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: cellRange,
    valueInputOption: 'RAW',
    requestBody: { values: [[newHash]] }
  });

  return ok({ message: 'ตั้ง passcode ใหม่สำเร็จ / Passcode reset successfully' });
}

// action สำหรับ Pop คนเดียวใช้ตั้ง passcode ใหม่ให้ user ที่ลืม (หลัง Pop ยืนยันตัวตนเขาผ่านช่องทางนอกเว็บ
// เช่น LINE เอง — ไม่มีระบบ verify อัตโนมัติใดๆ ในนี้เลย เพราะงั้น ADMIN_KEY ต้องเก็บเป็นความลับ ห้ามหลุด
// ไปให้ใครหรือ commit ขึ้น GitHub เด็ดขาด ใครก็ตามที่รู้ ADMIN_KEY จะรีเซ็ต passcode ของ user คนไหนก็ได้ทันที
// เก็บไว้เป็นทางสำรอง (เช่น user จำอีเมลที่สมัครไว้ไม่ได้ด้วย) ไม่ใช่ทางหลักแล้ว — ทางหลักคือ resetPasscode ด้านบน
async function actionAdminResetPasscode(p) {
  if (!process.env.ADMIN_KEY) return fail('เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า ADMIN_KEY');
  if (!p.admin_key || p.admin_key !== process.env.ADMIN_KEY) {
    return fail('admin_key ไม่ถูกต้อง / Invalid admin key');
  }
  if (!p.phone || !p.new_passcode) {
    return fail('กรุณาระบุ phone และ new_passcode');
  }

  const rows = await getSheetRows(SHEETS.USERS);
  const { headers, objects: users } = parseRowsWithHeaders(rows);
  const phone = normalizePhone(p.phone);
  const user = users.find(u => normalizePhone(u.phone) === phone);
  if (!user) return fail('ไม่พบ user เบอร์นี้ / User not found');

  const newHash = await bcrypt.hash(String(p.new_passcode), 10);
  const passcodeCol = colIndexByName(headers, 'passcode');
  const cellRange = SHEETS.USERS + '!' + colLetter(passcodeCol) + user._row;

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: cellRange,
    valueInputOption: 'RAW',
    requestBody: { values: [[newHash]] }
  });

  return ok({ message: 'ตั้ง passcode ใหม่สำเร็จ สำหรับ user_id: ' + user.user_id, username: user.username });
}

// พอร์ตตรงจาก actionUploadImage()/driveThumbUrl()/getOrCreateUploadFolder() เดิม (บรรทัด 303-359)
// ⚠️ ก่อนใช้งานจริง: Pop ต้องแชร์โฟลเดอร์ Drive "TOKBUD_upload" (ID: 1OjIDiojfe0J8aC0CkCSIxiPn-NJXokjv)
// ให้ service account email เดียวกับที่แชร์ Google Sheet ไว้ เป็นสิทธิ์ Editor ด้วย — คนละสิทธิ์กับที่แชร์ Sheet
// ไว้ก่อนหน้านี้ (แชร์คนละไฟล์คนละสิทธิ์กัน) ถ้าไม่แชร์เพิ่ม upload จะ error สิทธิ์ไม่พอ
// ตัดส่วน fallback หาโฟลเดอร์ด้วยชื่อ/สร้างใหม่ออก (DriveApp เฉพาะของ Apps Script ไม่มีใน Node) ถ้า folder ID
// นี้ใช้ไม่ได้จริงๆ (ถูกลบ/ย้ายเจ้าของ) จะ error ตรงๆ ให้ Pop รู้ทันที แทนที่จะสร้างโฟลเดอร์ใหม่แบบเงียบๆ
const FIXED_UPLOAD_FOLDER_ID = '1OjIDiojfe0J8aC0CkCSIxiPn-NJXokjv';

async function actionUploadImage(p) {
  if (!p.file_data || !p.mime_type) return fail('ไม่มีข้อมูลรูปภาพ');

  try {
    let base64 = String(p.file_data);
    if (base64.indexOf(',') !== -1) base64 = base64.split(',')[1]; // ตัด prefix "data:image/png;base64,"
    const buffer = Buffer.from(base64, 'base64');

    const fileName = (p.file_name ? String(p.file_name).replace(/[^a-zA-Z0-9._-]/g, '_') : 'upload')
      + '_' + generateCode();

    const drive = getDriveClient();
    const createRes = await drive.files.create({
      requestBody: { name: fileName, parents: [FIXED_UPLOAD_FOLDER_ID] },
      media: { mimeType: p.mime_type, body: Readable.from(buffer) },
      fields: 'id'
    });
    const fileId = createRes.data.id;

    // เทียบเท่า setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW) เดิม
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    return ok({ file_id: fileId, image_url: driveThumbUrl(fileId) });
  } catch (err) {
    return fail('อัพโหลดรูปไม่สำเร็จ: ' + err.message);
  }
}

// พอร์ตตรงจาก actionCreateCompany() เดิม (บรรทัด 973-1008)
async function actionCreateCompany(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail('กรุณา login ก่อนสร้างบริษัท / Please log in before creating a company');

  if (!p.company_name) return fail('กรุณากรอกชื่อบริษัท / Please enter a company name');
  if (!isEnglishOnlyName(p.company_name)) return fail(ENGLISH_ONLY_NAME_ERROR);
  if (!p.category) return fail('กรุณาเลือกหมวดหมู่ / Please select a category');

  const tags = [p.tag_1, p.tag_2, p.tag_3, p.tag_4, p.tag_5].filter(t => t && String(t).trim());
  if (tags.length < 1) return fail('กรุณาใส่ tag อย่างน้อย 1 อัน / Please add at least 1 tag');

  const rows = await getSheetRows(SHEETS.COMPANIES);
  const { headers, objects: companies } = parseRowsWithHeaders(rows);
  const existingIds = companies.map(c => c.company_id);
  const companyId = generateUniqueCode(existingIds);
  const nowIso = new Date().toISOString();

  const rowMap = {
    company_id: companyId,
    user_id: user.user_id,
    image_url_raw: p.image_url_raw || '',
    image_url_display: p.image_url_raw ? normalizeImageUrl(p.image_url_raw) : '',
    company_name: p.company_name,
    description: p.description || '',
    card_color: p.card_color || CARD_COLORS[8].hex,
    category: p.category,
    tag_1: p.tag_1 || '', tag_2: p.tag_2 || '', tag_3: p.tag_3 || '', tag_4: p.tag_4 || '', tag_5: p.tag_5 || '',
    status: 'active',
    start_date: nowIso,
    end_date: '',
    created_at: nowIso,
    updated_at: nowIso
  };
  const rowValues = headers.map(h => (rowMap[h] !== undefined ? rowMap[h] : ''));

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: SHEETS.COMPANIES,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowValues] }
  });

  return ok({
    company_id: companyId, status: 'active',
    message: 'สร้างบริษัทสำเร็จ เผยแพร่ขึ้นหน้าแรกแล้ว / Company created and published to the homepage'
  });
}

// พอร์ตตรงจาก actionVote() เดิม (บรรทัด 2807-2868) — รองรับทั้งสร้างใหม่ (append) และแก้ไขของเดิม (update in place)
async function actionVote(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail('กรุณา login ก่อนส่งความคิดเห็น / Please log in before submitting');
  if (!p.company_id || !p.side) return fail('ข้อมูลไม่ครบ / Missing information');
  if (p.side !== 'A' && p.side !== 'B') return fail('side ต้องเป็น A หรือ B เท่านั้น / side must be A or B only');

  const companyRows = await getSheetRows(SHEETS.COMPANIES);
  const companies = rowsToObjects(companyRows);
  const company = companies.find(c => c.company_id === p.company_id);
  if (!company) return fail('ไม่พบบริษัทนี้ / Company not found');
  if (company.status === 'deleted') return fail('ไม่พบบริษัทนี้ / Company not found');

  const comment = String(p.main_reason || '').trim().slice(0, 5000);
  if (!comment) return fail('กรุณากรอกเหตุผลหลัก / Please enter your main reason');

  let sideFields;
  if (p.side === 'A') {
    const ynuKeys = ['join_salary_good', 'join_benefits_good', 'join_brand_reputation', 'join_growth_opportunity',
      'join_challenging_work', 'join_culture_team', 'join_location_flexibility'];
    for (const k of ynuKeys) { if (!validYNU(p[k] || '')) return fail('กรุณาตอบให้ครบทุกข้อ / Please answer all questions'); }
    const score = Number(p.join_confidence_score);
    if (!p.join_confidence_score || isNaN(score) || score < 1 || score > 5) {
      return fail('กรุณาเลือกคะแนน 1-5 / Please select a score from 1 to 5');
    }
    sideFields = {
      join_salary_good: p.join_salary_good || '', join_benefits_good: p.join_benefits_good || '',
      join_brand_reputation: p.join_brand_reputation || '', join_growth_opportunity: p.join_growth_opportunity || '',
      join_challenging_work: p.join_challenging_work || '', join_culture_team: p.join_culture_team || '',
      join_location_flexibility: p.join_location_flexibility || '', join_confidence_score: score
    };
  } else {
    const ynuKeys = ['leave_salary_benefits_mismatch', 'leave_no_growth', 'leave_culture_mismatch', 'leave_manager_mismatch',
      'leave_team_mismatch', 'leave_worklife_mismatch', 'leave_better_offer', 'leave_not_challenging'];
    for (const k of ynuKeys) { if (!validYNU(p[k] || '')) return fail('กรุณาตอบให้ครบทุกข้อ / Please answer all questions'); }
    sideFields = {
      leave_salary_benefits_mismatch: p.leave_salary_benefits_mismatch || '', leave_no_growth: p.leave_no_growth || '',
      leave_culture_mismatch: p.leave_culture_mismatch || '', leave_manager_mismatch: p.leave_manager_mismatch || '',
      leave_team_mismatch: p.leave_team_mismatch || '', leave_worklife_mismatch: p.leave_worklife_mismatch || '',
      leave_better_offer: p.leave_better_offer || '', leave_not_challenging: p.leave_not_challenging || '',
      leave_improvement_suggestion: String(p.leave_improvement_suggestion || '').trim().slice(0, 5000)
    };
  }

  const voteRows = await getSheetRows(SHEETS.VOTES);
  const { headers: voteHeaders, objects: votes } = parseRowsWithHeaders(voteRows);
  const existing = votes.find(v => v.company_id === p.company_id && v.user_id === user.user_id && v.side === p.side);
  const nowIso = new Date().toISOString();
  const sheets = getSheetsClient();

  if (!existing) {
    const existingVoteIds = votes.map(v => v.vote_id);
    const voteId = generateUniqueCode(existingVoteIds);
    const rowMap = Object.assign({
      vote_id: voteId, company_id: p.company_id, user_id: user.user_id, side: p.side,
      main_reason: comment, voted_at: nowIso, last_changed_at: nowIso,
      gender_snapshot: user.gender,
      age_group_snapshot: user.birthday ? getAgeGroup(calculateAge(user.birthday)) : '',
      province_snapshot: user.province, company_name: company.company_name
    }, sideFields);
    const rowValues = voteHeaders.map(h => (rowMap[h] !== undefined ? rowMap[h] : ''));

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.TOKBUD_SHEET_ID,
      range: SHEETS.VOTES,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowValues] }
    });
    return ok({ message: 'ส่งความคิดเห็นสำเร็จ / Submitted successfully', is_new: true });
  }

  // แก้ไขของเดิม: update ทีละเซลล์เฉพาะคอลัมน์ที่เปลี่ยน (main_reason, last_changed_at, + sideFields ทั้งหมด)
  // ไม่ใช่ overwrite ทั้งแถว กัน column อื่นที่ไม่เกี่ยว (เช่น voted_at, snapshot ตอนโหวตครั้งแรก) โดนทับหายไป
  const updateMap = Object.assign({ main_reason: comment, last_changed_at: nowIso }, sideFields);
  const data = Object.keys(updateMap).map(key => {
    const col = colIndexByName(voteHeaders, key);
    return {
      range: SHEETS.VOTES + '!' + colLetter(col) + existing._row,
      values: [[updateMap[key]]]
    };
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data }
  });
  return ok({ message: 'แก้ไขความคิดเห็นสำเร็จ / Updated successfully', is_new: false });
}

// ===== Router =====

module.exports = async (req, res) => {
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.TOKBUD_SHEET_ID) {
      return res.status(500).json(fail('เซิร์ฟเวอร์ตั้งค่าไม่ครบ (env vars) / Server misconfigured'));
    }

    const p = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const action = p.action;

    let result;
    switch (action) {
      case 'getCategories':
        result = await actionGetCategories();
        break;
      case 'getCardColors':
        result = actionGetCardColors();
        break;
      case 'getCompanies':
        result = await actionGetCompanies(p);
        break;
      case 'uploadImage':
        result = await actionUploadImage(p);
        break;
      case 'createCompany':
        result = await actionCreateCompany(p);
        break;
      case 'vote':
        result = await actionVote(p);
        break;
      case 'signup':
        result = await actionSignup(p);
        break;
      case 'login':
        result = await actionLogin(p);
        break;
      case 'adminResetPasscode':
        result = await actionAdminResetPasscode(p);
        break;
      case 'resetPasscode':
        result = await actionResetPasscode(p);
        break;
      default:
        result = fail('ไม่รู้จัก action นี้ / Unknown action: ' + action);
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
