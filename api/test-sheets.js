// ไฟล์ทดสอบเชื่อมต่อ Google Sheets ก่อนเริ่มเขียน backend จริง
// ไม่ได้แก้ข้อมูลอะไรในชีทเลย แค่อ่านชื่อไฟล์ + รายชื่อ tab กลับมา
// เพื่อยืนยันว่า: env vars ถูกต้อง, service account มีสิทธิ์เข้าถึงชีทจริง, ต่อ Google Sheets API ผ่าน
// ทดสอบได้โดยเปิด URL: https://tokbud.vercel.app/api/test-sheets

const { google } = require('googleapis');

module.exports = async (req, res) => {
  try {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const rawKey = process.env.GOOGLE_PRIVATE_KEY;
    const sheetId = process.env.TOKBUD_SHEET_ID;

    if (!email || !rawKey || !sheetId) {
      return res.status(500).json({
        success: false,
        error: 'ไม่ครบ env vars',
        missing: {
          GOOGLE_SERVICE_ACCOUNT_EMAIL: !email,
          GOOGLE_PRIVATE_KEY: !rawKey,
          TOKBUD_SHEET_ID: !sheetId
        }
      });
    }

    // ค่า private key ที่วางใน Vercel เป็น string บรรทัดเดียว มี \n เป็นตัวหนังสือ (backslash-n)
    // ต้องแปลงกลับเป็นการขึ้นบรรทัดใหม่จริงก่อน ไม่งั้น Google จะปฏิเสธ key ว่ารูปแบบผิด
    const privateKey = rawKey.replace(/\\n/g, '\n');

    const auth = new google.auth.JWT(
      email,
      null,
      privateKey,
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
