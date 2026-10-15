// api/books.js  (อัปโหลดเข้า GitHub ที่โฟลเดอร์ api/ ได้เลย ไม่ต้องแปลงนามสกุล)
// ส่งข้อมูลหนังสือ (ปก + คำอธิบาย) จาก Tab "book" ใน Google Sheet เดียวกับ TOKBUD ให้หน้า landing YOU TALK PEOPLE LIKE
//   GET /api/books  ->  { ok:true, books:[ { name, cover, caption } ] }
//
// หัวคอลัมน์แถว 1 ของ Tab "book" (ชื่อ Tab ต้องเป็น book ตัวพิมพ์เล็ก):
//   book_name | book_cover | caption
//   - map จาก "ชื่อหัวคอลัมน์" ไม่ใช้ลำดับ / ไม่สนตัวพิมพ์เล็กใหญ่ / ช่องว่าง _ - ไม่นับ
//     (book name, Book_Name, bookname ใช้ได้หมด)
//   - book_cover วาง share link ของ Google Drive ได้เลย (แปลงเป็นลิงก์รูปให้เอง เหมือน herobanner)
// ไม่ cache: อ่านชีทสดทุกครั้ง เหมือน herobanner (ตกลงกับ Pop แล้ว)
// ใช้ env เดิม: GOOGLE_SERVICE_ACCOUNT_JSON, TOKBUD_SHEET_ID

const { google } = require('googleapis');

const TAB = 'book';

let authSingleton = null;
function getSheets() {
  if (!authSingleton) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    authSingleton = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
  }
  return google.sheets({ version: 'v4', auth: authSingleton });
}

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
// ชื่อหัวคอลัมน์: ตัวพิมพ์เล็ก + ตัดช่องว่าง/_/- ทิ้ง
const colKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s_-]+/g, '');

// เหมือน normalizeImageUrl() ใน tokbud.js (แปลง share link ของ Drive -> thumbnail) แต่ใช้ขนาดเล็กกว่า (ปกในการ์ด)
function driveThumbUrl(fileId) {
  return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w600';
}
function normalizeImageUrl(url) {
  url = str(url, 500);
  if (!url) return '';
  let m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return driveThumbUrl(m[1]);
  m = url.match(/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return driveThumbUrl(m[1]);
  m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return driveThumbUrl(m[1]);
  return /^https:\/\//i.test(url) ? url : ''; // ไม่ใช่ลิงก์ https = ไม่ใช้
}

module.exports = async function booksHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method', message: 'Method not allowed' });
  }
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.TOKBUD_SHEET_ID) {
    console.error('[books] env vars ไม่ครบ: GOOGLE_SERVICE_ACCOUNT_JSON / TOKBUD_SHEET_ID');
    return res.status(500).json({ ok: false, error: 'server', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
  }

  try {
    const sheets = getSheets();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.TOKBUD_SHEET_ID,
      range: TAB
    });
    const rows = r.data.values || [];
    const headers = (rows[0] || []).map(colKey);
    const iName = headers.indexOf('bookname');
    const iCover = headers.indexOf('bookcover');
    const iCap = headers.indexOf('caption');

    const missing = [];
    if (iName < 0) missing.push('book_name');
    if (iCover < 0) missing.push('book_cover');
    if (iCap < 0) missing.push('caption');
    if (missing.length) {
      console.error('[books] Tab "' + TAB + '" ขาดคอลัมน์:', missing.join(', '));
      return res.status(500).json({ ok: false, error: 'columns', missing: missing, message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
    }

    const books = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const name = str(row[iName], 200);
      if (!name) continue; // แถวว่าง / ไม่มีชื่อ ข้าม
      books.push({
        name: name,
        cover: normalizeImageUrl(row[iCover]),
        caption: str(row[iCap], 5000)
      });
    }
    return res.status(200).json({ ok: true, books: books });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('[books] error:', msg);
    // ไม่มี Tab ชื่อ book -> Google ตอบ "Unable to parse range: book"
    if (/unable to parse range/i.test(msg)) {
      return res.status(500).json({ ok: false, error: 'tab', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
    }
    return res.status(500).json({ ok: false, error: 'server', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
  }
};
