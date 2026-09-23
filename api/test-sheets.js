// ไฟล์ทดสอบเชื่อมต่อ Google Sheets ก่อนเริ่มเขียน backend จริง
// v2: เปลี่ยนมาอ่านค่าจาก GOOGLE_SERVICE_ACCOUNT_JSON (ทั้งไฟล์ JSON วางเป็นค่าเดียว) แทนการแยก
// EMAIL/PRIVATE_KEY เป็น 2 ตัวแปร — เดิมเสี่ยง private_key เพี้ยนตอน copy-paste บางส่วน (\n หาย/เกิน)
// จนยืนยันตัวตนไม่ผ่านแบบเงียบๆ (error "unregistered callers") วิธีนี้ให้ JSON.parse() จัดการ escaping
// ให้ทั้งหมด ตราบใดที่ copy ทั้งไฟล์มาวางครบ ไม่มีจุดเสี่ยงคนตัดข้อความเองผิดอีก
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
        error: 'GOOGLE_SERVICE_ACCOUNT_JSON ไม่ใช่ JSON ที่ถูกต้อง — เช็คว่าคัดลอกไฟล์ .json ทั้งไฟล์มาวางครบหรือเปล่า (ต้องขึ้นต้นด้วย { และปิดท้ายด้วย })'
      });
    }

    const auth = new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key,
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );

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
