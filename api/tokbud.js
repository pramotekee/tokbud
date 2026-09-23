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

const SHEETS = {
  USERS: 'users',
  COMPANIES: 'companies',
  VOTES: 'votes',
  CATEGORIES: 'categories',
  DELETEREQUESTS: 'deleterequests'
};

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

// ===== Google Sheets client (JWT service account) =====
let sheetsClientPromise = null;
function getSheetsClient() {
  if (!sheetsClientPromise) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      // ใช้ scope เต็ม (ไม่ใช่ readonly) ไว้ตั้งแต่ตอนนี้เลย เผื่อ action เขียนข้อมูล (createCompany/vote ฯลฯ)
      // ที่จะพอร์ตต่อในรอบหน้า จะได้ไม่ต้องมาวน setup credential ใหม่อีกรอบ
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsClientPromise = google.sheets({ version: 'v4', auth });
  }
  return sheetsClientPromise;
}

// เทียบเท่า rowsToObjects() เดิมใน appscript.txt (บรรทัด 200-210) — แปลง 2D array (แถวแรก=header)
// เป็น array of object โดยใช้ header เป็น key
function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map(h => String(h || '').trim());
  return rows.slice(1).map((r, i) => {
    const obj = {};
    headers.forEach((h, ci) => { obj[h] = r[ci] !== undefined ? r[ci] : ''; });
    obj._row = i + 2; // เลขแถวจริงในชีท (เผื่อ action เขียนข้อมูลใช้ต่อในอนาคต)
    return obj;
  });
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
      default:
        result = fail('ไม่รู้จัก action นี้ / Unknown action: ' + action);
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
