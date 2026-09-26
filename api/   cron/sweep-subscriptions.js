// Vercel Cron เรียก path นี้วันละ 1 ครั้งตามที่ตั้งไว้ใน vercel.json (schedule "0 18 * * *" = ตี 1 เวลาไทย
// เพราะ Vercel รันเป็น UTC เท่านั้น 18:00 UTC = 01:00 Bangkok/+7 ของวันถัดไป) ยืนยันตัวตนด้วย CRON_SECRET
// header ที่ Vercel แปะมาให้อัตโนมัติ (ตาม Vercel เอกสารเรื่อง cron job security) ไม่ใช้ session_token ปกติ
// เพราะไม่มี user คนไหน login อยู่ตอน cron รัน — ต้องตั้ง env var ชื่อ CRON_SECRET เองใน Vercel Dashboard
// (สุ่มสตริงยาวๆ อะไรก็ได้) แล้ว Vercel จะส่งมาเป็น header "Authorization: Bearer <ค่านั้น>" ให้เองทุกครั้งที่ยิง
const { sweepSubscriptionsCore } = require('../tokbud.js');

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const summary = await sweepSubscriptionsCore();
    return res.status(200).json({ success: true, summary });
  } catch (err) {
    console.error('[sweep-subscriptions cron] failed:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
