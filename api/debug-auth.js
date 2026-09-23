// ไฟล์ debug ชั่วคราว — แยกเช็คทีละสเต็ปว่าพังตรงไหนกันแน่ ลบทิ้งได้หลังจบปัญหานี้
// เปิดที่: https://tokbud.vercel.app/api/debug-auth

const { google } = require('googleapis');

module.exports = async (req, res) => {
  const report = { steps: {} };

  // สเต็ป 1: เช็คว่า env var มาครบ + หน้าตาไฟล์ JSON ดูสมเหตุสมผลไหม (ไม่โชว์ key จริง แค่โครงสร้าง)
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetId = process.env.TOKBUD_SHEET_ID;
  report.steps.env_vars_present = { GOOGLE_SERVICE_ACCOUNT_JSON: !!rawJson, TOKBUD_SHEET_ID: !!sheetId };

  if (!rawJson || !sheetId) {
    return res.status(200).json(report);
  }

  let creds;
  try {
    creds = JSON.parse(rawJson);
    report.steps.json_parse = 'ok';
  } catch (e) {
    report.steps.json_parse = 'FAILED: ' + e.message;
    return res.status(200).json(report);
  }

  // สเต็ป 2: เช็ครูปร่างของ private_key แบบไม่โชว์ค่าจริง (กันหลุด)
  const pk = creds.private_key || '';
  report.steps.private_key_shape = {
    length: pk.length,
    starts_correctly: pk.startsWith('-----BEGIN PRIVATE KEY-----'),
    ends_correctly: pk.trim().endsWith('-----END PRIVATE KEY-----'),
    contains_real_newlines: pk.includes('\n'),
    contains_literal_backslash_n: pk.includes('\\n'),
    client_email: creds.client_email || '(ไม่มี)',
    project_id: creds.project_id || '(ไม่มี)'
  };

  // สเต็ป 3: ลองขอ access token จริงๆ (แยกจากการเรียก Sheets) — จุดนี้ถ้าพัง แปลว่าตัว key/credential เองมีปัญหา
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );

  try {
    const tokenResult = await auth.authorize();
    report.steps.get_access_token = {
      status: 'ok',
      has_token: !!tokenResult.access_token,
      token_type: tokenResult.token_type
    };
  } catch (e) {
    report.steps.get_access_token = {
      status: 'FAILED',
      error_message: e.message,
      error_code: e.code || null,
      error_response_data: (e.response && e.response.data) || null
    };
    return res.status(200).json(report);
  }

  // สเต็ป 4: ถ้าได้ token มาแล้ว ลองเรียก Sheets API จริง
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    report.steps.call_sheets_api = {
      status: 'ok',
      spreadsheet_title: meta.data.properties.title,
      tabs: meta.data.sheets.map(s => s.properties.title)
    };
  } catch (e) {
    report.steps.call_sheets_api = {
      status: 'FAILED',
      error_message: e.message,
      error_code: e.code || null,
      error_response_data: (e.response && e.response.data) || null
    };
  }

  return res.status(200).json(report);
};
