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
  DELETEREQUESTS: 'deleterequests',
  TRANSFERS: 'transfers',
  MYTYPE: 'mytype'
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

// พอร์ตตรงจาก findUserInMap() เดิม (appscript.txt บรรทัด 943-948) — หา user จาก userMap ที่มีอยู่แล้วด้วย
// session_token แทนการอ่านชีท users ซ้ำ (ใช้ตอน actionGetTransfer ที่ต้องอ่าน companies/votes/users มาแล้ว)
function findUserInMap(userMap, token) {
  if (!token) return null;
  const user = Object.values(userMap).find(u => u.session_token === token) || null;
  if (user && user.account_status === 'deleted') return null;
  return user;
}

// เทียบเท่า _loadHiddenCompanyIdsCached() เดิม — company_id ที่ Pop อนุมัติลบแล้ว (status='delete' ใน
// deleterequests) ไม่ควรโผล่ที่ไหนอีกเลย รวมถึงในลิงก์ transfer ที่ยังไม่หมดอายุของบริษัทนั้น
function getHiddenCompanyIds(deleteRequests) {
  return deleteRequests.filter(r => r.status === 'delete').map(r => r.company_id);
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

// เดิม (Apps Script) เขียนวันที่ลงชีทด้วย new Date() ตรงๆ — Google Sheets รู้จักเป็น "ค่าวันที่จริง" แสดงผล
// ตามฟอร์แมตของสเปรดชีต (เช่น "9/22/2026 17:14") ฝั่ง Node เขียนผ่าน Sheets API ด้วย valueInputOption RAW
// (จำเป็นต้องใช้ RAW เพื่อกันเลข 0 นำหน้าเบอร์โทรหาย — ดูคอมเมนต์ที่ actionSignup) ซึ่ง RAW ไม่ auto-parse
// อะไรเลย ถ้าส่ง ISO string ตรงๆ ("2026-09-24T08:36:43.604Z") จะถูกเก็บเป็นข้อความดิบตามนั้น อ่านยากกว่าของเดิม
// เลยจัดรูปแบบให้เป็น M/D/YYYY H:mm:ss (โซนเวลาไทย +7 คงที่ ไม่มี DST) ให้หน้าตาใกล้เคียงแถวเก่าที่สุด
// ข้อแลก: ยังเป็น "ข้อความ" ในสายตา Sheets ไม่ใช่ "ค่าวันที่จริง" แบบแถวเก่า (เรียงลำดับ/กรองแบบ native
// ของ Sheets เองอาจไม่เหมือนแถวเก่าเป๊ะ) แต่โค้ดฝั่งเราเองที่ใช้เรียงลำดับ/คำนวณ (เช่น sort "latest" ใน
// getCompanies) แปลง string นี้กลับเป็น Date ใน JS ได้ปกติ ไม่กระทบการทำงานของแอป — ถ้าต้องการให้เป็นค่าวันที่
// จริงแบบเป๊ะๆ ด้วย ทำได้แต่ต้องเปลี่ยนวิธีเขียน (batchUpdate แบบระบุชนิดข้อมูลเป็นเซลล์ๆ ไป) แจ้งได้ถ้าต้องการ
function formatDateForSheet(date) {
  const bkk = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const M = bkk.getUTCMonth() + 1, D = bkk.getUTCDate(), Y = bkk.getUTCFullYear();
  const h = bkk.getUTCHours();
  const m = String(bkk.getUTCMinutes()).padStart(2, '0');
  const s = String(bkk.getUTCSeconds()).padStart(2, '0');
  return `${M}/${D}/${Y} ${h}:${m}:${s}`;
}

// พอร์ตตรงจาก normalizePhone() เดิม (บรรทัด 244-248)
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

// พอร์ตตรงจาก csvEscape() เดิม (appscript.txt บรรทัด 624-629) — กัน field ที่มี comma/quote/ขึ้นบรรทัดใหม่ ทำ
// CSV เพี้ยน (มาตรฐาน RFC 4180: ครอบด้วย "" แล้ว escape "" ที่ซ้อนอยู่)
function csvEscape(value) {
  const s = String(value === undefined || value === null ? '' : value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// พอร์ตตรงจาก genderToEn() เดิม (บรรทัด 619-622) — gender เก็บเป็นภาษาไทยในชีท แต่ไฟล์ export ใช้ EN เสมอ
function genderToEn(g) {
  const map = { 'ชาย': 'male', 'หญิง': 'female', 'อื่นๆ': 'other' };
  return map[g] || g || '';
}

// เทียบเท่า Utilities.formatDate(..., 'GMT+7', 'yyyy-MM-dd HH:mm') เดิม ใช้เฉพาะตอน export CSV — ตั้งใจแกะ
// ตัวเลขจาก string ตรงๆ แทนที่จะพึ่ง new Date()+timezone ของเครื่อง Vercel (ซึ่งไม่แน่นอน) เพื่อกันพลาด:
//   - แถวใหม่ (last_changed_at เป็น "M/D/YYYY H:mm:ss" ที่ formatDateForSheet เขียนไว้ = เวลาไทยอยู่แล้ว
//     ในตัว) แกะตัวเลขมาเรียงใหม่ตรงๆ ไม่ต้องบวกเวลาซ้ำ
//   - แถวเก่าก่อน migrate (ค่าจริงเป็น Date/ISO UTC จาก Apps Script เดิม) ตีความเป็น UTC แล้วค่อยบวก +7
function formatExportTimestamp(v) {
  if (!v) return '';
  const s = String(v).trim();
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m1) {
    const [, M, D, Y, h, mi] = m1;
    return `${Y}-${M.padStart(2, '0')}-${D.padStart(2, '0')} ${h.padStart(2, '0')}:${mi}`;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return `${bkk.getUTCFullYear()}-${String(bkk.getUTCMonth() + 1).padStart(2, '0')}-${String(bkk.getUTCDate()).padStart(2, '0')} ${String(bkk.getUTCHours()).padStart(2, '0')}:${String(bkk.getUTCMinutes()).padStart(2, '0')}`;
}

// พอร์ตตรงจาก hasProAccess() เดิม (บรรทัด 557-571) — แหล่งความจริงเดียวว่า user คนนี้มีสิทธิ์ PRO ไหม ใช้จุดเดียว
// กับทุกฟีเจอร์ที่ gate ด้วย PRO (ตอนนี้มีแค่ Export — Conversation Cards ยังไม่ได้พอร์ตมาที่นี่) ได้ PRO เมื่อ
// plan==='pro' และ (subscription_status==='active' หรือ (===canceled และ pro_until ยังไม่หมดอายุ))
// มอบ/ถอด PRO ด้วยมือได้โดยตรงในชีท users (คอลัมน์ plan/subscription_status/pro_until) เหมือนเดิมทุกประการ —
// ยังไม่มี Stripe billing เชื่อมจริงตอนนี้ (อยู่ท้ายลำดับ migration ตามที่ตกลงกัน)
function hasProAccess(user) {
  if (!user || user.plan !== 'pro') return false;
  if (user.subscription_status === 'active') return true;
  if (user.subscription_status === 'canceled' && user.pro_until) {
    const until = new Date(user.pro_until).getTime();
    return !isNaN(until) && until > Date.now();
  }
  return false;
}

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
  const nowIso = formatDateForSheet(new Date());
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
  const nowIso = formatDateForSheet(new Date());

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
  const nowIso = formatDateForSheet(new Date());
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

// เทียบเท่า updateObjectByRow() เดิม (บรรทัด 221-234) — อัปเดตเฉพาะคอลัมน์ที่ระบุใน fieldsObj (ไม่แตะคอลัมน์
// อื่นเลย) โดยหาตำแหน่งคอลัมน์จากชื่อ header จริงเหมือนเดิมทุกจุด ไม่ hardcode ตำแหน่ง
async function updateRowFields(tabName, headers, rowNum, fieldsObj) {
  const keys = Object.keys(fieldsObj);
  if (keys.length === 0) return;
  const data = keys.map(key => ({
    range: tabName + '!' + colLetter(colIndexByName(headers, key)) + rowNum,
    values: [[fieldsObj[key]]]
  }));
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data }
  });
}

// พอร์ตตรงจาก actionEditCompany()/syncVoteCompanyNames() เดิม (บรรทัด 1336-1408) — ตัด guard "ไม่มีอะไรเปลี่ยน
// ก็ fail" ออกเหมือนต้นฉบับที่แก้ไปแล้ว (FIX ของ Pop ที่ทำไว้ก่อนหน้า) อัปเดต updated_at เสมอแม้ diff ว่างเปล่า
async function actionEditCompany(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail('กรุณา login ก่อน / Please log in first');
  if (!p.company_id) return fail('ต้องระบุ company_id');

  const rows = await getSheetRows(SHEETS.COMPANIES);
  const { headers, objects: companies } = parseRowsWithHeaders(rows);
  const company = companies.find(c => c.company_id === p.company_id);
  if (!company) return fail('ไม่พบบริษัทนี้ / Company not found');
  if (company.status === 'deleted') return fail('ไม่พบบริษัทนี้ / Company not found');
  if (company.user_id !== user.user_id) return fail('คุณไม่มีสิทธิ์แก้ไขบริษัทนี้ / You don\'t have permission to edit this company');

  if (!p.company_name) return fail('กรุณากรอกชื่อบริษัท / Please enter a company name');
  if (!isEnglishOnlyName(p.company_name)) return fail(ENGLISH_ONLY_NAME_ERROR);
  if (!p.category) return fail('กรุณาเลือกหมวดหมู่ / Please select a category');

  const tags = [p.tag_1, p.tag_2, p.tag_3, p.tag_4, p.tag_5].filter(t => t && String(t).trim());
  if (tags.length < 1) return fail('กรุณาใส่ tag อย่างน้อย 1 อัน / Please add at least 1 tag');

  const editable = {};
  let nameChanged = false;

  if (String(p.company_name).trim() !== String(company.company_name).trim()) {
    editable.company_name = p.company_name;
    nameChanged = true;
  }
  if (String(p.image_url_raw || '') !== String(company.image_url_raw || '')) {
    editable.image_url_raw = p.image_url_raw || '';
    editable.image_url_display = p.image_url_raw ? normalizeImageUrl(p.image_url_raw) : '';
  }
  if (String(p.description || '') !== String(company.description || '')) editable.description = p.description || '';
  if (String(p.category) !== String(company.category)) editable.category = p.category;
  ['tag_1', 'tag_2', 'tag_3', 'tag_4', 'tag_5'].forEach(k => {
    const v = p[k] || '';
    if (String(v) !== String(company[k] || '')) editable[k] = v;
  });
  if (p.card_color && String(p.card_color) !== String(company.card_color)) editable.card_color = p.card_color;

  editable.updated_at = formatDateForSheet(new Date());
  await updateRowFields(SHEETS.COMPANIES, headers, company._row, editable);

  if (nameChanged) {
    // เทียบเท่า syncVoteCompanyNames() เดิม — อัปเดต company_name ที่ snapshot ไว้ในทุกแถวโหวตของบริษัทนี้ด้วย
    const voteRows = await getSheetRows(SHEETS.VOTES);
    const { headers: voteHeaders, objects: votes } = parseRowsWithHeaders(voteRows);
    const nameCol = voteHeaders.indexOf('company_name');
    if (nameCol !== -1) {
      const touchedRows = votes.filter(v => v.company_id === p.company_id);
      if (touchedRows.length > 0) {
        const sheets = getSheetsClient();
        const data = touchedRows.map(v => ({
          range: SHEETS.VOTES + '!' + colLetter(nameCol + 1) + v._row,
          values: [[p.company_name]]
        }));
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: process.env.TOKBUD_SHEET_ID,
          requestBody: { valueInputOption: 'RAW', data }
        });
      }
    }
  }

  return ok({ message: 'บันทึกการแก้ไขเรียบร้อย / Changes saved successfully', status: company.status });
}

// พอร์ตตรงจาก actionRequestDeleteCompany() เดิม (บรรทัด 1432-1472)
// เช็ค hasActiveTransfer() ก่อนด้วยแล้ว (กันลบบริษัทที่มีลิงก์ส่งมอบค้างอยู่) — เพิ่มกลับมาตอนพอร์ต transfer feature
async function actionRequestDeleteCompany(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail('กรุณา login ก่อน / Please log in first');
  if (!p.company_id) return fail('ต้องระบุบริษัท / Missing company_id');
  if (!p.passcode) return fail('กรุณากรอก Passcode เพื่อยืนยันการขอลบ / Please enter your Passcode to confirm this request');

  const passcodeMatches = await bcrypt.compare(String(p.passcode), String(user.passcode || ''));
  if (!passcodeMatches) return fail('Passcode ไม่ถูกต้อง / Incorrect passcode');

  const validReasons = ['duplicate', 'no_longer_want_listed', 'testing_only', 'other'];
  if (!p.reason || validReasons.indexOf(p.reason) === -1) return fail('กรุณาเลือกเหตุผล / Please select a reason');

  let reasonText = '';
  if (p.reason === 'no_longer_want_listed' || p.reason === 'other') {
    reasonText = String(p.reason_text || '').trim().slice(0, 500);
    if (!reasonText) return fail('กรุณาระบุรายละเอียดเพิ่มเติม / Please provide more detail');
  }

  const companyRows = await getSheetRows(SHEETS.COMPANIES);
  const companies = rowsToObjects(companyRows);
  const company = companies.find(c => c.company_id === p.company_id);
  if (!company) return fail('ไม่พบบริษัทนี้ / Company not found');
  if (company.user_id !== user.user_id) return fail('คุณไม่มีสิทธิ์ขอลบบริษัทนี้ / You don\'t have permission to request deletion of this company');
  if (await hasActiveTransfer(p.company_id)) {
    return fail('กรุณายกเลิกลิงก์ส่งมอบก่อน จึงจะขอลบบริษัทได้ / Please cancel the pending transfer link before requesting deletion');
  }

  const reqRows = await getSheetRows(SHEETS.DELETEREQUESTS);
  const { headers: reqHeaders, objects: requests } = parseRowsWithHeaders(reqRows);
  const existing = requests.find(r => r.company_id === p.company_id && r.status === 'pending');
  if (existing) return ok({ message: 'ส่งคำขอลบไปแล้ว กำลังรอการตรวจสอบ / A delete request is already pending review' });

  const existingIds = requests.map(r => r.request_id);
  const requestId = generateUniqueCode(existingIds);
  const rowMap = {
    request_id: requestId, company_id: p.company_id, requested_by: user.user_id,
    reason: p.reason, reason_text: reasonText, requested_at: formatDateForSheet(new Date()), status: 'pending'
  };
  const rowValues = reqHeaders.map(h => (rowMap[h] !== undefined ? rowMap[h] : ''));

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: SHEETS.DELETEREQUESTS,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowValues] }
  });

  return ok({ message: 'ส่งคำขอลบสำเร็จ ทีมงานจะตรวจสอบและดำเนินการ / Delete request submitted, our team will review it. It\'ll be removed from the feed once approved.' });
}

// พอร์ตตรงจาก actionCancelDeleteRequest() เดิม (บรรทัด 1478-1495)
async function actionCancelDeleteRequest(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail('กรุณา login ก่อน / Please log in first');
  if (!p.company_id) return fail('ต้องระบุบริษัท / Missing company_id');

  const companyRows = await getSheetRows(SHEETS.COMPANIES);
  const company = rowsToObjects(companyRows).find(c => c.company_id === p.company_id);
  if (!company) return fail('ไม่พบบริษัทนี้ / Company not found');
  if (company.user_id !== user.user_id) return fail('คุณไม่มีสิทธิ์ยกเลิกคำขอนี้ / You don\'t have permission to cancel this request');

  const reqRows = await getSheetRows(SHEETS.DELETEREQUESTS);
  const { headers: reqHeaders, objects: requests } = parseRowsWithHeaders(reqRows);
  const pending = requests.find(r => r.company_id === p.company_id && r.status === 'pending');
  if (!pending) return fail('ไม่พบคำขอลบที่รอดำเนินการอยู่ / No pending delete request found');

  await updateRowFields(SHEETS.DELETEREQUESTS, reqHeaders, pending._row, { status: 'cancelled' });
  return ok({ message: 'ยกเลิกคำขอลบเรียบร้อยแล้ว / Delete request cancelled' });
}

// พอร์ตตรงจาก actionGetMyCompanies() เดิม (บรรทัด 1593-1647) — ตอนนี้พอร์ต transfer feature มาครบแล้ว จึง
// ใส่ field `transfer` (ลิงก์ส่งมอบที่ยังรอผู้รับของบริษัทนั้น ถ้ามี) และ `transferred_out` (ประวัติบริษัทที่
// เคยเป็นของเรามาก่อนแต่โอนออกไปแล้ว) กลับเข้ามาเหมือนต้นฉบับ — fail-soft เหมือนเดิม: ถ้าอ่าน tab transfers
// พลาดด้วยเหตุผลใดก็ตาม (เช่น tab ถูกเปลี่ยนชื่อ) ต้องไม่ทำให้หน้า My Company พังทั้งหน้า
async function actionGetMyCompanies(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail('กรุณา login ก่อน / Please log in first');

  const companyRows = await getSheetRows(SHEETS.COMPANIES);
  const allCompanies = rowsToObjects(companyRows);
  const companies = allCompanies.filter(t => t.user_id === user.user_id && t.status !== 'deleted');

  const voteRows = await getSheetRows(SHEETS.VOTES);
  const votes = rowsToObjects(voteRows);
  const votesByCompany = buildVotesByCompany(votes);

  const usersRows = await getSheetRows(SHEETS.USERS);
  const userMap = buildUserMap(rowsToObjects(usersRows));

  const reqRows = await getSheetRows(SHEETS.DELETEREQUESTS);
  const pendingDeleteIds = {};
  rowsToObjects(reqRows).forEach(r => { if (r.status === 'pending') pendingDeleteIds[r.company_id] = true; });

  const pendingTransferByCompany = {};
  let transferredOut = [];
  try {
    const trRows = await getSheetRows(SHEETS.TRANSFERS);
    const transfers = rowsToObjects(trRows);
    const nowMs = Date.now();
    transfers.forEach(tr => {
      if (tr.from_user_id !== user.user_id) return;
      const eff = transferEffectiveStatus(tr, nowMs);
      if (eff === 'pending') {
        pendingTransferByCompany[tr.company_id] = {
          transfer_id: tr.transfer_id, created_at: toIso(tr.created_at), expires_at: toIso(tr.expires_at)
        };
      } else if (eff === 'accepted') {
        const toUser = userMap[tr.to_user_id];
        const c = allCompanies.find(x => x.company_id === tr.company_id);
        transferredOut.push({
          company_id: tr.company_id, company_name: c ? c.company_name : '',
          to_username: toUser ? toUser.username : '', completed_at: toIso(tr.completed_at)
        });
      }
    });
    transferredOut.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
    transferredOut = transferredOut.slice(0, 50);
  } catch (e) { console.error('[getMyCompanies] read transfers failed:', e); }

  return ok({
    companies: companies.map(t => Object.assign(
      summarizeCompany(t, votesByCompany[t.company_id] || [], userMap),
      {
        status: t.status,
        created_at: t.created_at,
        has_pending_delete_request: !!pendingDeleteIds[t.company_id],
        image_url_raw: t.image_url_raw || '',
        transfer: pendingTransferByCompany[t.company_id] || null
      }
    )),
    transferred_out: transferredOut
  });
}

// พอร์ตตรงจาก actionGetMyComments() เดิม (บรรทัด 1652-1687)
async function actionGetMyComments(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail('กรุณา login ก่อน / Please log in first');

  const companyRows = await getSheetRows(SHEETS.COMPANIES);
  const companies = rowsToObjects(companyRows);
  const companyMap = {};
  companies.forEach(c => { companyMap[c.company_id] = c; });

  const voteRows = await getSheetRows(SHEETS.VOTES);
  const votes = rowsToObjects(voteRows);
  const myVotes = votes.filter(v => v.user_id === user.user_id);
  myVotes.sort((a, b) => new Date(b.last_changed_at) - new Date(a.last_changed_at));

  return ok({
    comments: myVotes.map(v => ({
      vote_id: v.vote_id,
      company_id: v.company_id,
      company_name: companyMap[v.company_id] ? companyMap[v.company_id].company_name : v.company_name,
      card_color: companyMap[v.company_id] ? companyMap[v.company_id].card_color : '',
      side: v.side,
      main_reason: v.main_reason,
      voted_at: v.voted_at,
      last_changed_at: v.last_changed_at,
      join_salary_good: v.join_salary_good, join_benefits_good: v.join_benefits_good,
      join_brand_reputation: v.join_brand_reputation, join_growth_opportunity: v.join_growth_opportunity,
      join_challenging_work: v.join_challenging_work, join_culture_team: v.join_culture_team,
      join_location_flexibility: v.join_location_flexibility, join_confidence_score: v.join_confidence_score,
      leave_salary_benefits_mismatch: v.leave_salary_benefits_mismatch, leave_no_growth: v.leave_no_growth,
      leave_culture_mismatch: v.leave_culture_mismatch, leave_manager_mismatch: v.leave_manager_mismatch,
      leave_team_mismatch: v.leave_team_mismatch, leave_worklife_mismatch: v.leave_worklife_mismatch,
      leave_better_offer: v.leave_better_offer, leave_not_challenging: v.leave_not_challenging,
      leave_improvement_suggestion: v.leave_improvement_suggestion
    }))
  });
}

/* ================= COMPANY TRANSFER (ส่งมอบบริษัทให้คนอื่นดูแลต่อ) =================
 * พอร์ตตรงจาก appscript.txt บรรทัด 1911-2153 — logic เดียวกันเป๊ะ, ต่างจากต้นฉบับ 2 จุดเท่านั้น:
 *   (1) เทียบ passcode ด้วย bcrypt.compare() แทนเทียบ string ตรงๆ (ฝั่งนี้ hash passcode ไว้ ดู actionSignup)
 *   (2) ไม่มี LockService บน Vercel — ตามดีไซน์ที่ตกลงกับ Pop ไว้แล้วว่าข้ามการล็อคทั้งระบบไปก่อน (traffic ยัง
 *       น้อยมาก) จุดเดียวที่ยังพอมีความเสี่ยงจริงจากการไม่มีล็อคคือ acceptTransfer ถ้ามี 2 คนกด Accept พร้อมกัน
 *       เป๊ะๆ ในเสี้ยววินาทีเดียวกัน (โอกาสต่ำมากที่ traffic ปัจจุบัน) — ทุก action ยังอ่านชีทสดแล้วเช็คซ้ำก่อน
 *       เขียนเหมือนเดิม ลดความเสี่ยงลงได้มากแม้ไม่มีล็อคจริง ถ้าต้องการล็อคจริงทีหลังต้องใช้ external lock
 *       service (เช่น Upstash Redis) — ยังไม่ทำตอนนี้ตามดีไซน์เดิม
 */
const TRANSFER_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000; // 3 วัน

function toIso(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

// สถานะจริง: pending ที่เลยเวลาแล้ว (หรือ expires_at อ่านไม่ออก) ถือเป็น expired
function transferEffectiveStatus(t, nowMs) {
  const st = String(t.status || '').trim();
  if (st !== 'pending') return st;
  const exp = new Date(t.expires_at).getTime();
  return (isNaN(exp) || exp <= nowMs) ? 'expired' : 'pending';
}

async function markTransferExpired(headers, t) {
  try {
    if (String(t.status || '').trim() !== 'pending') return;
    await updateRowFields(SHEETS.TRANSFERS, headers, t._row, { status: 'expired', completed_at: t.expires_at || formatDateForSheet(new Date()) });
  } catch (e) { console.error('[transfer] mark expired failed:', e); } // แค่จัดระเบียบชีต ห้ามให้กระทบผู้ใช้
}

// เหตุผลที่บริษัทนี้ส่งมอบไม่ได้: 'not_found' | 'pending_delete' | '' (ส่งมอบได้)
async function transferBlockReason(company) {
  if (!company || company.status === 'deleted') return 'not_found';
  const reqRows = await getSheetRows(SHEETS.DELETEREQUESTS);
  const requests = rowsToObjects(reqRows);
  if (getHiddenCompanyIds(requests).indexOf(company.company_id) !== -1) return 'not_found';
  const hasPendingDelete = requests.some(r => r.company_id === company.company_id && r.status === 'pending');
  return hasPendingDelete ? 'pending_delete' : '';
}

// ใช้ใน actionRequestDeleteCompany — fail-soft: tab transfers หาย/ชื่อผิด ห้ามทำให้ฟีเจอร์ขอลบที่ใช้งานอยู่พัง
async function hasActiveTransfer(companyId) {
  try {
    const rows = await getSheetRows(SHEETS.TRANSFERS);
    const nowMs = Date.now();
    return rowsToObjects(rows).some(t => t.company_id === companyId && transferEffectiveStatus(t, nowMs) === 'pending');
  } catch (e) { return false; }
}

const TRANSFER_MSG = {
  login: 'กรุณา login ก่อน / Please log in first',
  invalid: 'ลิงก์นี้ไม่ถูกต้อง / This link is not valid',
  expired: 'ลิงก์นี้หมดอายุแล้ว / This link has expired',
  cancelled: 'ผู้ส่งยกเลิกลิงก์นี้แล้ว / The sender has cancelled this link',
  used: 'ลิงก์นี้ถูกใช้ไปแล้ว / This link has already been used',
  own: 'นี่คือลิงก์ที่คุณสร้างเอง กรุณาส่งต่อให้ผู้ที่จะรับช่วงดูแลแทน / This is your own transfer link. Please send it to the person who will take over',
  unavailable: 'บริษัทนี้ไม่พร้อมให้ส่งมอบแล้ว / This company is no longer available for transfer',
  notFound: 'ไม่พบบริษัทนี้ / Company not found',
  transferNotFound: 'ไม่พบรายการส่งมอบนี้ / Transfer not found'
};

// ผู้ส่ง: สร้างลิงก์ส่งมอบ (ต้องกรอก passcode) — ถ้ามีลิงก์ที่ยังใช้ได้อยู่แล้ว คืนลิงก์เดิม (กันกดซ้ำ/สองแท็บ)
async function actionCreateTransfer(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail(TRANSFER_MSG.login);
  if (!p.company_id) return fail('ข้อมูลไม่ครบ / Missing company_id');
  if (!p.passcode) return fail('กรุณากรอก Passcode เพื่อยืนยันการส่งมอบ / Please enter your Passcode to confirm this transfer');

  const passcodeMatches = await bcrypt.compare(String(p.passcode), String(user.passcode || ''));
  if (!passcodeMatches) return fail('Passcode ไม่ถูกต้อง / Incorrect passcode');

  const companyRows = await getSheetRows(SHEETS.COMPANIES);
  const company = rowsToObjects(companyRows).find(c => c.company_id === p.company_id);
  if (!company || company.status === 'deleted') return fail(TRANSFER_MSG.notFound);
  if (company.user_id !== user.user_id) return fail('คุณไม่มีสิทธิ์ส่งมอบบริษัทนี้ / You don\'t have permission to transfer this company');
  const block = await transferBlockReason(company);
  if (block === 'not_found') return fail(TRANSFER_MSG.notFound);
  if (block === 'pending_delete') return fail('ส่งมอบไม่ได้ขณะที่มีคำขอลบค้างอยู่ กรุณายกเลิกคำขอลบก่อน / You can\'t transfer a company while a delete request is pending. Please cancel the delete request first');

  const trRows = await getSheetRows(SHEETS.TRANSFERS);
  const { headers: trHeaders, objects: transfers } = parseRowsWithHeaders(trRows);
  const nowMs = Date.now();
  let active = null;
  for (const t of transfers) {
    if (t.company_id !== company.company_id) continue;
    const eff = transferEffectiveStatus(t, nowMs);
    if (eff === 'pending') active = t;
    else if (eff === 'expired') await markTransferExpired(trHeaders, t);
  }
  if (active) {
    return ok({ transfer_id: active.transfer_id, created_at: toIso(active.created_at), expires_at: toIso(active.expires_at), reused: true });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + TRANSFER_EXPIRY_MS);
  const transferId = crypto.randomUUID();
  const rowMap = {
    transfer_id: transferId, company_id: company.company_id, from_user_id: user.user_id, to_user_id: '',
    status: 'pending', created_at: formatDateForSheet(now), expires_at: formatDateForSheet(expiresAt), completed_at: ''
  };
  const rowValues = trHeaders.map(h => (rowMap[h] !== undefined ? rowMap[h] : ''));

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.TOKBUD_SHEET_ID,
    range: SHEETS.TRANSFERS,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowValues] }
  });
  return ok({ transfer_id: transferId, created_at: now.toISOString(), expires_at: expiresAt.toISOString() });
}

// ทุกคน (ไม่ต้อง login): ดูตัวอย่างจากลิงก์ — คืนรายละเอียดบริษัทเฉพาะตอนลิงก์ยังใช้ได้ (ลิงก์อื่นๆ คืนแค่สถานะ)
// ถ้าส่ง session_token มาด้วย จะบอกว่า login อยู่ไหม / เป็นลิงก์ของตัวเองไหม เพื่อให้หน้าเว็บเลือกปุ่มถูก
async function actionGetTransfer(p) {
  const id = String(p.transfer_id || '').trim();
  if (!id) return ok({ transfer_status: 'invalid' });

  const trRows = await getSheetRows(SHEETS.TRANSFERS);
  const { headers: trHeaders, objects: transfers } = parseRowsWithHeaders(trRows);
  const t = transfers.find(r => r.transfer_id === id);
  if (!t) return ok({ transfer_status: 'invalid' });

  const eff = transferEffectiveStatus(t, Date.now());
  if (eff === 'expired') await markTransferExpired(trHeaders, t);
  if (eff !== 'pending') return ok({ transfer_status: (eff === 'accepted' || eff === 'cancelled' || eff === 'expired') ? eff : 'invalid' });

  const data = await loadAllSheetsData();
  const company = data.companies.find(c => c.company_id === t.company_id);
  if (!company || company.status === 'deleted' || company.user_id !== t.from_user_id) {
    return ok({ transfer_status: 'unavailable' });
  }
  const votesByCompany = buildVotesByCompany(data.votes);
  const userMap = buildUserMap(data.users);
  const viewer = findUserInMap(userMap, p.session_token);
  const summary = summarizeCompany(company, votesByCompany[company.company_id] || [], userMap);
  const fromUser = userMap[t.from_user_id];
  return ok({
    transfer_status: 'pending',
    company: {
      company_id: summary.company_id, company_name: summary.company_name,
      image_url: summary.image_url, card_color: summary.card_color, comment_count: summary.total_votes
    },
    from_username: fromUser ? fromUser.username : '',
    expires_at: toIso(t.expires_at),
    logged_in: !!viewer,
    is_sender: !!viewer && viewer.user_id === t.from_user_id
  });
}

// ผู้รับ: กดรับ (ต้อง login, ไม่ต้องกรอก passcode) — เปลี่ยนเจ้าของบริษัท + จดประวัติ
async function actionAcceptTransfer(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail(TRANSFER_MSG.login);
  const id = String(p.transfer_id || '').trim();
  if (!id) return fail(TRANSFER_MSG.invalid);

  const trRows = await getSheetRows(SHEETS.TRANSFERS);
  const { headers: trHeaders, objects: transfers } = parseRowsWithHeaders(trRows);
  const t = transfers.find(r => r.transfer_id === id);
  if (!t) return fail(TRANSFER_MSG.invalid);

  const nowMs = Date.now();
  const eff = transferEffectiveStatus(t, nowMs);
  if (eff === 'expired') { await markTransferExpired(trHeaders, t); return fail(TRANSFER_MSG.expired); }
  if (eff === 'accepted') {
    // คนเดิมกดซ้ำ (เช่น เน็ตหลุดหลังรับสำเร็จ แล้ว frontend retry ให้อัตโนมัติ) = สำเร็จอยู่แล้ว ไม่ใช่ error
    if (t.to_user_id === user.user_id) {
      const companyRows = await getSheetRows(SHEETS.COMPANIES);
      const mine = rowsToObjects(companyRows).find(c => c.company_id === t.company_id);
      return ok({ company_id: t.company_id, company_name: mine ? mine.company_name : '', message: 'รับช่วงดูแลบริษัทเรียบร้อยแล้ว / You are now managing this company' });
    }
    return fail(TRANSFER_MSG.used);
  }
  if (eff === 'cancelled') return fail(TRANSFER_MSG.cancelled);
  if (eff !== 'pending') return fail(TRANSFER_MSG.invalid);
  if (t.from_user_id === user.user_id) return fail(TRANSFER_MSG.own);

  // ตรวจซ้ำจากชีตสดทุกครั้ง: ยังเป็นของผู้ส่งอยู่ไหม / บริษัทยังอยู่ไหม / ไม่มีคำขอลบค้าง
  const companyRows = await getSheetRows(SHEETS.COMPANIES);
  const { headers: companyHeaders, objects: companies } = parseRowsWithHeaders(companyRows);
  const company = companies.find(c => c.company_id === t.company_id);
  if (!company || company.status === 'deleted' || company.user_id !== t.from_user_id) {
    // เจ้าของเปลี่ยนไปแล้ว/บริษัทหาย: ลิงก์นี้ใช้ไม่ได้ตลอดไป ปิดรายการไม่ปล่อยค้าง pending
    await updateRowFields(SHEETS.TRANSFERS, trHeaders, t._row, { status: 'cancelled', completed_at: formatDateForSheet(new Date()) });
    return fail(TRANSFER_MSG.unavailable);
  }
  const block = await transferBlockReason(company);
  if (block !== '') return fail(TRANSFER_MSG.unavailable); // เช่น มีคำขอลบค้าง (อาจหายไปทีหลัง จึงไม่ปิดลิงก์)

  const now = new Date();
  const nowStr = formatDateForSheet(now);
  // ลำดับสำคัญ: เปลี่ยนเจ้าของก่อน แล้วค่อยจดประวัติ — ถ้าขั้นหลังพลาด ลิงก์เดิมจะถูกปฏิเสธเองเพราะเจ้าของไม่ใช่ผู้ส่งแล้ว (ไม่ค้างครึ่งๆ กลางๆ)
  await updateRowFields(SHEETS.COMPANIES, companyHeaders, company._row, { user_id: user.user_id, updated_at: nowStr });
  const acceptedPatch = { to_user_id: user.user_id, status: 'accepted', completed_at: nowStr };
  try {
    await updateRowFields(SHEETS.TRANSFERS, trHeaders, t._row, acceptedPatch);
  } catch (e) {
    await new Promise(r => setTimeout(r, 300));
    try { await updateRowFields(SHEETS.TRANSFERS, trHeaders, t._row, acceptedPatch); }
    catch (e2) { console.error('[transfer] company moved but history write failed:', t.transfer_id, e2); }
  }

  // เผื่อมีลิงก์ค้างซ้อนของบริษัทเดียวกัน (ปกติไม่มี เพราะสร้างซ้ำไม่ได้) -> ปิดให้หมด
  for (const o of transfers) {
    if (o._row === t._row || o.company_id !== t.company_id) continue;
    if (transferEffectiveStatus(o, nowMs) === 'pending') {
      try { await updateRowFields(SHEETS.TRANSFERS, trHeaders, o._row, { status: 'cancelled', completed_at: nowStr }); } catch (e) {}
    }
  }

  return ok({
    company_id: company.company_id, company_name: company.company_name,
    message: 'รับช่วงดูแลบริษัทเรียบร้อยแล้ว / You are now managing this company'
  });
}

// ผู้ส่ง: ยกเลิกลิงก์ที่ยังไม่มีคนรับ
async function actionCancelTransfer(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail(TRANSFER_MSG.login);
  const id = String(p.transfer_id || '').trim();
  if (!id) return fail(TRANSFER_MSG.invalid);

  const trRows = await getSheetRows(SHEETS.TRANSFERS);
  const { headers: trHeaders, objects: transfers } = parseRowsWithHeaders(trRows);
  const t = transfers.find(r => r.transfer_id === id);
  if (!t || t.from_user_id !== user.user_id) return fail(TRANSFER_MSG.transferNotFound);

  const eff = transferEffectiveStatus(t, Date.now());
  if (eff === 'accepted') return fail('ลิงก์นี้ถูกรับไปแล้ว ยกเลิกไม่ได้ / This transfer was already accepted and can\'t be cancelled');
  if (eff === 'pending') await updateRowFields(SHEETS.TRANSFERS, trHeaders, t._row, { status: 'cancelled', completed_at: formatDateForSheet(new Date()) });
  else if (eff === 'expired') await markTransferExpired(trHeaders, t);
  // cancelled อยู่แล้ว = สำเร็จแบบ idempotent (กดซ้ำไม่ error)
  return ok({ message: 'ยกเลิกลิงก์ส่งมอบเรียบร้อยแล้ว / Transfer link cancelled' });
}

// พอร์ตตรงจาก actionExportCompanyVotes() เดิม (appscript.txt บรรทัด 2635-2674) — export CSV คำตอบทั้งหมดของ
// 1 บริษัท (ทุกโหวต ไม่ใช่แค่แถวที่มี comment) gate ชั้นเดียว: ต้อง login + ต้องเป็น PRO เท่านั้น (ไม่ต้องเป็น
// เจ้าของบริษัทนั้นด้วย — ตาม FIX ที่ตกลงกับ Pop ไว้แล้วในต้นฉบับ ให้ใครก็ได้ที่จ่าย PRO export ได้เอง)
// ไม่มีคอลัมน์ email/phone ใน export เลยตามที่ตกลงกัน (กันตามตัวคนคอมเมนต์กลับไปได้) คืน CSV เป็น string ผ่าน
// JSON (นำหน้าด้วย BOM \uFEFF กัน Excel เปิดภาษาไทยเพี้ยน) ให้ frontend สร้าง Blob ดาวน์โหลดเอง ไม่ใช่ไฟล์จริง
async function actionExportCompanyVotes(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail('กรุณา login ก่อน / Please log in first');
  if (!hasProAccess(user)) return fail('ฟีเจอร์ Export data นี้ สำหรับผู้ใช้งานแบบ PRO plan / This export feature is for PRO plan users only');
  if (!p.company_id) return fail('ไม่พบบริษัทที่ต้องการ export / Missing company_id');

  const companyRows = await getSheetRows(SHEETS.COMPANIES);
  const company = rowsToObjects(companyRows).find(c => c.company_id === p.company_id);
  if (!company) return fail('ไม่พบบริษัทนี้ / Company not found');

  const voteRows = await getSheetRows(SHEETS.VOTES);
  const votes = rowsToObjects(voteRows).filter(v => v.company_id === p.company_id);

  const header = ['no', 'timestamp', 'side', 'main_reason',
    'join_salary_good', 'join_benefits_good', 'join_brand_reputation', 'join_growth_opportunity', 'join_challenging_work', 'join_culture_team', 'join_location_flexibility', 'join_confidence_score',
    'leave_salary_benefits_mismatch', 'leave_no_growth', 'leave_culture_mismatch', 'leave_manager_mismatch', 'leave_team_mismatch', 'leave_worklife_mismatch', 'leave_better_offer', 'leave_not_challenging', 'leave_improvement_suggestion',
    'gender', 'age_group'];
  const lines = [header.map(csvEscape).join(',')];

  votes.forEach((v, idx) => {
    const timestampStr = formatExportTimestamp(v.last_changed_at);
    const sideLabel = v.side === 'A' ? 'Work' : (v.side === 'B' ? 'Left' : (v.side || ''));
    lines.push([
      idx + 1, timestampStr, sideLabel, v.main_reason || '',
      v.join_salary_good || '', v.join_benefits_good || '', v.join_brand_reputation || '', v.join_growth_opportunity || '', v.join_challenging_work || '', v.join_culture_team || '', v.join_location_flexibility || '', v.join_confidence_score || '',
      v.leave_salary_benefits_mismatch || '', v.leave_no_growth || '', v.leave_culture_mismatch || '', v.leave_manager_mismatch || '', v.leave_team_mismatch || '', v.leave_worklife_mismatch || '', v.leave_better_offer || '', v.leave_not_challenging || '', v.leave_improvement_suggestion || '',
      genderToEn(v.gender_snapshot), v.age_group_snapshot || ''
    ].map(csvEscape).join(','));
  });

  const safeTitle = String(company.company_name || 'company').replace(/[^a-zA-Z0-9ก-๙_-]+/g, '_').slice(0, 40);
  const bkkNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const exportStamp = `${bkkNow.getUTCFullYear()}${String(bkkNow.getUTCMonth() + 1).padStart(2, '0')}${String(bkkNow.getUTCDate()).padStart(2, '0')}_${String(bkkNow.getUTCHours()).padStart(2, '0')}${String(bkkNow.getUTCMinutes()).padStart(2, '0')}`;
  return ok({
    csv: '\uFEFF' + lines.join('\r\n'),
    filename: `TOKBUD_${safeTitle}_${exportStamp}.csv`,
    row_count: votes.length
  });
}

/* ================= MY TYPE (About Me / self-expression + match feature) =================
 * พอร์ตตรงจาก appscript.txt บรรทัด 2155-2426 (ต้นฉบับเองก็บอกไว้ว่าพอร์ตมาจาก appscript_wezide.txt แบบตรงตัว
 * ไม่ปรับ logic ใดๆ — สคีมาชีท mytype คอลัมน์ A-BH ตรงกับของเดิมทุกตัว) ต่างจากต้นฉบับจุดเดียว: ไม่มี
 * CacheService บน Vercel เลยอ่านชีทสดทุกครั้งแทนการ cache ผลไว้ 1 นาทีแบบเดิม (ตามดีไซน์ "ไม่มี caching
 * ที่ไหนเลยตอนนี้" ที่ตกลงกับ Pop ไว้ตั้งแต่ต้นโปรเจกต์อยู่แล้ว ไม่ใช่จุดใหม่ที่ตัดสินใจเอง)
 * ⚠️ ยังไม่พอร์ต `translateCardQuestion` (แปลข้อความการ์ดคำถาม) เพราะต้นฉบับใช้ LanguageApp.translate() ของ
 * Apps Script ล้วนๆ ซึ่งไม่มีบน Vercel เลย ต้องต่อ Google Cloud Translation API แยกต่างหาก (ต้องสร้าง credential/
 * เปิด billing เพิ่ม) — เป็นการตัดสินใจโครงสร้างใหม่ที่ต้องถาม Pop ก่อน ไม่ใช่แค่พอร์ตโค้ดตรงๆ เหมือนที่ผ่านมา
 */
const MYTYPE_QUESTION_COUNT = 50;
function mytypeQuestionKeys() {
  const keys = [];
  for (let i = 1; i <= MYTYPE_QUESTION_COUNT; i++) keys.push('q' + String(i).padStart(2, '0'));
  return keys;
}
const MYTYPE_CONTACT_FIELDS = ['fb', 'yt', 'ig', 'tt', 'x', 'website'];
const MYTYPE_MATCH_THRESHOLDS = {
  very_me: { field: 'match_pct', min: 70 },
  kinda_me: { field: 'match_pct', min: 40 },
  not_me: { field: 'diff_pct', min: 40 },
  so_different: { field: 'diff_pct', min: 70 }
};
const MYTYPE_MIN_COMMON_ANSWERS = 5;
const MYTYPE_MATCH_RESULT_CAP = 60;

function extractAnsweredQuestions(row) {
  const out = {};
  if (!row) return out;
  mytypeQuestionKeys().forEach(k => {
    const v = row[k];
    if (v !== '' && v !== null && v !== undefined) out[k] = Number(v);
  });
  return out;
}

function computeMyTypeDiff(answersA, answersB) {
  let sum = 0, commonCount = 0;
  Object.keys(answersA).forEach(k => {
    if (answersB[k] !== undefined) { sum += Math.abs(answersA[k] - answersB[k]); commonCount++; }
  });
  return { commonCount, avgDiff: commonCount ? (sum / commonCount) : null };
}

function buildContactPayload(row, includeLinks) {
  const channels = [];
  const links = {};
  MYTYPE_CONTACT_FIELDS.forEach(f => {
    const v = row ? String(row[f] || '').trim() : '';
    if (v) { channels.push(f); if (includeLinks) links[f] = v; }
  });
  return { channels, links };
}

function normalizeContactUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
}

// public: ใครมีลิงก์ (?id=user_id) ก็เปิดดูได้ — session_token ใส่มาด้วยก็ได้ (ไม่ login ก็ดูได้ปกติ แค่ไม่เห็น
// ลิงก์ contact จริง) ใช้ userMap ตัวเต็ม (ไม่ filter) เพราะต้องหา target_user ที่อาจไม่ใช่ตัว viewer เอง
async function actionGetMyType(p) {
  if (!p.id) return fail('ต้องระบุ id ของผู้ใช้ / Must specify a user id');

  const usersRows = await getSheetRows(SHEETS.USERS);
  const userMap = buildUserMap(rowsToObjects(usersRows));
  const targetUser = userMap[p.id];
  if (!targetUser || targetUser.account_status === 'deleted') return fail('ไม่พบผู้ใช้นี้ / User not found');

  const viewer = findUserInMap(userMap, p.session_token);
  const isOwner = !!(viewer && viewer.user_id === targetUser.user_id);
  const isLoggedIn = !!viewer;

  const myTypeRows = await getSheetRows(SHEETS.MYTYPE);
  const row = rowsToObjects(myTypeRows).find(r => r.user_id === targetUser.user_id) || null;
  const baseUser = { user_id: targetUser.user_id, username: targetUser.username, profile_image_url: targetUser.profile_image_url || '' };

  if (!row) {
    return ok({ exists: false, user: baseUser, is_owner: isOwner, is_logged_in: isLoggedIn, card_is_pro: isOwner ? hasProAccess(viewer) : undefined });
  }

  const contact = buildContactPayload(row, isLoggedIn);
  return ok({
    exists: true, user: baseUser, aboutme: row.aboutme || '',
    contact_channels: contact.channels, contact_links: contact.links,
    answers: extractAnsweredQuestions(row), is_owner: isOwner, is_logged_in: isLoggedIn,
    card_is_pro: isOwner ? hasProAccess(viewer) : undefined,
    updated_at: row.updated_at
  });
}

// เจ้าของบัญชีเท่านั้นที่แก้ของตัวเองได้ — เฉพาะ field ที่ frontend ส่งมาจริงเท่านั้นที่ถูกเขียน/ทับ (undefined = ไม่แตะ)
async function actionSaveMyType(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return fail('กรุณา login ก่อน / Please log in first');
  if (p.aboutme !== undefined && String(p.aboutme).length > 500) {
    return fail('About Me ต้องไม่เกิน 500 ตัวอักษร / About Me must not exceed 500 characters');
  }

  const trRows = await getSheetRows(SHEETS.MYTYPE);
  const { headers, objects } = parseRowsWithHeaders(trRows);
  const existing = objects.find(r => r.user_id === user.user_id);

  const editable = {};
  if (p.aboutme !== undefined) editable.aboutme = String(p.aboutme).trim();
  MYTYPE_CONTACT_FIELDS.forEach(f => { if (p[f] !== undefined) editable[f] = normalizeContactUrl(p[f]); });

  let invalidQ = null, invalidReason = '';
  mytypeQuestionKeys().forEach(k => {
    if (p[k] === undefined) return;
    const v = Number(p[k]);
    if (isNaN(v) || v < 0 || v > 100) { invalidQ = k; invalidReason = 'range'; return; }
    const rounded = Math.max(1, Math.min(100, Math.round(v)));
    if (rounded === 50) { invalidQ = k; invalidReason = 'midpoint'; return; }
    editable[k] = rounded;
  });
  if (invalidQ) {
    return fail(invalidReason === 'midpoint'
      ? `คำถาม ${invalidQ} ต้องเอียงไปทางใดทางหนึ่ง ไม่ใช่ตรงกลางพอดี / Question ${invalidQ} must lean to one side, not exactly in the middle`
      : `ค่าคำถาม ${invalidQ} ไม่ถูกต้อง / Invalid value for question ${invalidQ}`);
  }
  if (Object.keys(editable).length === 0) return fail('ไม่มีข้อมูลที่จะบันทึก / No data to save');

  const nowStr = formatDateForSheet(new Date());
  editable.updated_at = nowStr;

  if (existing) {
    await updateRowFields(SHEETS.MYTYPE, headers, existing._row, editable);
  } else {
    editable.user_id = user.user_id;
    editable.created_at = nowStr;
    const rowValues = headers.map(h => (editable[h] !== undefined ? editable[h] : ''));
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.TOKBUD_SHEET_ID, range: SHEETS.MYTYPE, valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS', requestBody: { values: [rowValues] }
    });
  }
  return ok({ message: 'บันทึก My Type สำเร็จ / My Type saved successfully' });
}

// gate ด้วย session_token ฝั่ง backend เท่านั้น ไม่ login/token ผิด -> is_pro:false เฉยๆ ไม่ fail (frontend ตกไป
// โหมด demo แทน ไม่ใช่ error state)
async function actionGetCardAccess(p) {
  const user = await findUserByToken(p.session_token);
  if (!user) return ok({ is_pro: false });
  return ok({ is_pro: hasProAccess(user) });
}

async function actionGetMyTypeMatch(p) {
  const usersRows = await getSheetRows(SHEETS.USERS);
  const userMap = buildUserMap(rowsToObjects(usersRows));
  const user = findUserInMap(userMap, p.session_token);
  if (!user) return fail('กรุณา login ก่อน / Please log in first');

  const threshold = MYTYPE_MATCH_THRESHOLDS[p.mode];
  if (!threshold) return fail('mode ไม่ถูกต้อง / Invalid mode');

  const myTypeRows = await getSheetRows(SHEETS.MYTYPE);
  const allRows = rowsToObjects(myTypeRows);
  const myRow = allRows.find(r => r.user_id === user.user_id);
  if (!myRow) return fail('กรุณาตั้งค่า My Type ของตัวเองก่อน / Please set up your own My Type first');

  const myAnswers = extractAnsweredQuestions(myRow);
  const results = [];
  allRows.forEach(row => {
    if (row.user_id === user.user_id) return;
    const otherUser = userMap[row.user_id];
    if (!otherUser || otherUser.account_status === 'deleted') return;

    const { commonCount, avgDiff } = computeMyTypeDiff(myAnswers, extractAnsweredQuestions(row));
    if (commonCount < MYTYPE_MIN_COMMON_ANSWERS) return;

    const matchPct = Math.round(100 - avgDiff);
    const diffPct = Math.round(avgDiff);
    const value = threshold.field === 'match_pct' ? matchPct : diffPct;
    if (value < threshold.min) return;

    results.push({ user_id: row.user_id, username: otherUser.username, profile_image_url: otherUser.profile_image_url || '', match_pct: matchPct, diff_pct: diffPct });
  });

  results.sort((a, b) => b[threshold.field] - a[threshold.field]);
  return ok({ mode: p.mode, count: results.length, results: results.slice(0, MYTYPE_MATCH_RESULT_CAP) });
}

// เจ้าของโปรไฟล์เท่านั้นที่ใช้ได้ — endpoint เปิดใช้งานปกติแต่ frontend ยังไม่มีปุ่ม/UI เรียก (ตามคำสั่งเดิมของ Pop
// เผื่ออนาคตเปิดกลับมาใช้ ตรงกับต้นฉบับ)
async function actionSearchMyType(p) {
  const usersRows = await getSheetRows(SHEETS.USERS);
  const userMap = buildUserMap(rowsToObjects(usersRows));
  const user = findUserInMap(userMap, p.session_token);
  if (!user) return fail('กรุณา login ก่อน / Please log in first');

  const q = String(p.query || '').trim().toLowerCase();
  if (!q) return ok({ results: [] });

  const myTypeRows = await getSheetRows(SHEETS.MYTYPE);
  const allRows = rowsToObjects(myTypeRows);
  const results = [];
  for (const row of allRows) {
    if (row.user_id === user.user_id) continue;
    const otherUser = userMap[row.user_id];
    if (!otherUser || otherUser.account_status === 'deleted') continue;
    if (String(otherUser.username || '').toLowerCase().indexOf(q) === -1) continue;
    results.push({ user_id: otherUser.user_id, username: otherUser.username, profile_image_url: otherUser.profile_image_url || '' });
    if (results.length >= 20) break;
  }
  return ok({ results });
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
      case 'editCompany':
        result = await actionEditCompany(p);
        break;
      case 'requestDeleteCompany':
        result = await actionRequestDeleteCompany(p);
        break;
      case 'cancelDeleteRequest':
        result = await actionCancelDeleteRequest(p);
        break;
      case 'getMyCompanies':
        result = await actionGetMyCompanies(p);
        break;
      case 'getMyComments':
        result = await actionGetMyComments(p);
        break;
      case 'createTransfer':
        result = await actionCreateTransfer(p);
        break;
      case 'getTransfer':
        result = await actionGetTransfer(p);
        break;
      case 'acceptTransfer':
        result = await actionAcceptTransfer(p);
        break;
      case 'cancelTransfer':
        result = await actionCancelTransfer(p);
        break;
      case 'exportCompanyVotes':
        result = await actionExportCompanyVotes(p);
        break;
      case 'getMyType':
        result = await actionGetMyType(p);
        break;
      case 'saveMyType':
        result = await actionSaveMyType(p);
        break;
      case 'getMyTypeMatch':
        result = await actionGetMyTypeMatch(p);
        break;
      case 'searchMyType':
        result = await actionSearchMyType(p);
        break;
      case 'getCardAccess':
        result = await actionGetCardAccess(p);
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
