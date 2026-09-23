// ไฟล์ทดสอบเชื่อมต่อ Google Sheets ก่อนเริ่มเขียน backend จริง
// v3: FIX บั๊กจริง — เดิมสร้าง JWT client แบบเรียงตำแหน่ง (email, null, key, scopes) ซึ่งเป็นรูปแบบเก่า
// ที่ google-auth-library เวอร์ชันใหม่ (ที่มากับ googleapis ตัวล่าสุด) ไม่รับค่า key ที่ส่งแบบนี้แล้ว
// (เงียบๆ ไม่ error ตอนสร้าง แต่พอขอ token จริงจะฟ้อง "No key or keyFile set.") ยืนยันจากผล debug-auth.js
// จริงที่ private_key ถูกต้องสมบูรณ์ทุกอย่าง แต่ authorize() ยัง fail อยู่ดี — เปลี่ยนมาส่งเป็น object แทน
// ซึ่งเป็นรูปแบบที่ถูกต้องสำหรับเวอร์ชันปัจจุบัน ไม่มีปัญหาความเข้ากันได้แบบนี้อีก
// ทดสอบได้โดยเปิด URL: https://tokbud.vercel.app/api/test-sheets

const { google } = require('googleapis');

module.exports = async (req, res) => {
  try {
    const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const sheetId = process.env.TOKBUD_SHEET_ID;

    if (!rawJson || !sheetId) {
      return res.status(500).json({
        success: false,
        error: 'ไม่ครบ env vars',
        missing: {
          GOOGLE_SERVICE_ACCOUNT_JSON: !rawJson,
          TOKBUD_SHEET_ID: !sheetId
        }
      });
    }

    let creds;
    try {
      creds = JSON.parse(rawJson);
    } catch (e) {
      return res.status(500).json({
        success: false,
        error: 'GOOGLE_SERVICE_ACCOUNT_JSON ไม่ใช่ JSON ที่ถูกต้อง — เช็คว่าคัดลอกไฟล์ .json ทั้งไฟล์มาวางครบหรือเปล่า'
      });
    }

    // FIX: ส่งเป็น options object แทนการเรียงตำแหน่ง — แก้บั๊ก "No key or keyFile set."
    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });

    const tabNames = meta.data.sheets.map(s => s.properties.title);

    return res.status(200).json({
      success: true,
      message: 'เชื่อมต่อ Google Sheets สำเร็จ',
      spreadsheet_title: meta.data.properties.title,
      tabs: tabNames
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};
