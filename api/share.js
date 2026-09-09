// /api/share.js — Vercel Serverless Function สำหรับ TOKBUD

// FIX (รูปประกอบไม่ขึ้นตอนแชร์ผ่าน LINE — Pop เจอปัญหาจริง, เทียบกับ WEZIDE ที่เคยทำให้รูปขึ้นได้):
// เดิมไฟล์นี้เช็ค isBot(userAgent) ก่อน แล้วแยก 2 เส้นทาง: คนจริง -> 302 ตรงไปเว็บจริงทันที (ไม่มี og:tag เลย),
// บอทที่รู้จัก (facebookexternalhit, whatsapp, ...) -> ค่อยเสิร์ฟ HTML ที่มี og:tag ปัญหาคือ LINE ไม่มี
// user-agent แยกระหว่าง "บอทดึงพรีวิว" กับ "คนเปิดจริงในแอป" (ทั้งคู่มีคำว่า Line/ เหมือนกันหมด) เดิมเลย
// ตั้งใจไม่ใส่ 'line/' ไว้ในลิสต์บอทเพื่อกันคนจริงเจอหน้าขาว แต่ผลข้างเคียงคือตัว LINE เองตอนดึงพรีวิวก็ถูก
// จัดเป็น "คนจริง" ไปด้วย เลยโดน 302 ทันทีไม่มีโอกาสอ่าน og:image เลยสักครั้ง (รูปเลยไม่เคยขึ้นใน LINE)
//
// แก้โดยตัดการเช็ค user-agent ทิ้งทั้งหมด — เสิร์ฟหน้า HTML ที่มี og:tag ครบให้ "ทุกคนที่เข้ามาเหมือนกันหมด"
// ไม่ว่าจะเป็นบอทแพลตฟอร์มไหนหรือคนจริง แล้วใช้ JavaScript สั่ง redirect คนจริงออกไปหน้าเว็บจริงแทนการทำ
// 302 ฝั่ง server (บอทแทบทั้งหมดไม่รัน JavaScript อยู่แล้ว จึงหยุดอ่านแค่ og:tag พอ ไม่ไปต่อ ไม่ต้องเดางาน
// เดา user-agent เองเลยสักตัว) — เป็น pattern เดียวกับที่ renderCompanyShareOgPage ฝั่ง appscript.txt เคยใช้ตอน
// เสิร์ฟตรงจาก script.google.com (ซึ่งเป็นจุดที่ WEZIDE เคยทำให้รูปขึ้นใน LINE ได้จริงตามที่ Pop ยืนยัน) —
// ไม่ใช้ <meta http-equiv="refresh"> เด็ดขาด (บาง crawler ทำตาม meta refresh ทันทีก่อน parse og:image ทัน)
// เหลือแค่ <script> อย่างเดียว คนจริงโดนเด้งออกแทบจะทันที (ต่ำกว่า 1 วิ) ส่วนบอททุกแพลตฟอร์มเห็น og:tag ชัวร์
//
// เก็บของเดิมไว้ครบ: ไม่พึ่ง req.query, ห่อ try/catch ชั้นนอกกันหน้าขาว, ปิด cache/Range request กัน
// Facebook 206 bug, query param ที่ยิงไป Apps Script ใช้ company_id= (ตรงกับ actionGetShareMeta ฝั่ง backend)

const DEFAULT_APPSCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwH_KorLbUReFtJ0q3uxLBcc802Crm451rlc31PlOeBZCL2oL9bUu-Jlb3bJnMBQnlbgw/exec';
const FRONTEND_URL = 'https://tokbud.vercel.app';

function escapeHtml(str){
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// แกะ query param เองจาก req.url แบบตรงไปตรงมา ไม่พึ่ง req.query ของ framework ใดๆ
// req.url ของ Vercel Node function คือ path+query เสมอ (เช่น "/api/share?topic=ABC123")
function getQueryParam(req, key){
  try{
    const url = new URL(req.url, 'http://placeholder.local');
    return url.searchParams.get(key);
  }catch(e){
    return null;
  }
}

function redirect(res, location){
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store'); // กัน browser/CDN cache หน้า redirect นี้ค้างไว้ผิดๆ
  res.end();
}

// เสิร์ฟหน้า og:tag + JS redirect ให้ "ทุกคน" เหมือนกันหมด (ไม่แยกบอท/คนจริงอีกต่อไป — ดูคอมเมนต์บนสุดของไฟล์)
function renderOgPage(res, { title, desc, image, redirectUrl }){
  const html = `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(redirectUrl)}">
<meta name="twitter:card" content="summary_large_image">
<script>
try{ top.location.href = ${JSON.stringify(redirectUrl)}; }
catch(e){ location.href = ${JSON.stringify(redirectUrl)}; }
</script>
</head><body>กำลังพาไปยัง TOKBUD... ถ้าไม่ถูกพาไปอัตโนมัติ <a href="${escapeHtml(redirectUrl)}">กดที่นี่</a></body></html>`;

  // P0-fix (สืบทอดมาจาก WEZIDE — Facebook link preview ไม่ขึ้นรูป/title ผิด): ห้ามใส่ s-maxage เพราะ
  // เนื้อหาต้องเปลี่ยนตาม topic_id ทุกครั้งอยู่แล้ว การเปิด cache ระดับ edge ทำให้ Vercel เปิด Range-request
  // support อัตโนมัติ แล้ว Facebook crawler ส่ง Range header มาขอปกติ จะได้ 206 Partial Content ที่ตัด HTML
  // ไม่ครบ parse หา og:title/og:image ไม่เจอ แล้ว fallback ไปอ่าน og:url (หน้า index.html เปล่าๆ) แทน
  // -> ไม่ใช้ s-maxage/stale-while-revalidate เลย และปิด Range support ตรงๆ อีกชั้นกันเหตุการณ์นี้เกิดซ้ำ
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'none');
  return res.end(html);
}

module.exports = async (req, res) => {
  try{
    const appscriptUrl = process.env.APPSCRIPT_URL || DEFAULT_APPSCRIPT_URL;
    // ฝั่ง index.txt (buildShareUrl) ยิง /api/share?topic=<company_id> มา — พารามิเตอร์ในลิงก์ยังชื่อ "topic"
    // ตาม URL pattern เดิม ไม่ได้เปลี่ยน แค่ค่าที่ยิงต่อไปให้ Apps Script เท่านั้นที่ต้องเปลี่ยนชื่อเป็น company_id=
    const topicId = getQueryParam(req, 'topic');
    const userId = getQueryParam(req, 'mytype');

    if(!topicId && !userId){
      return redirect(res, FRONTEND_URL);
    }

    const redirectUrl = topicId
      ? `${FRONTEND_URL}/?topic=${encodeURIComponent(topicId)}`
      : `${FRONTEND_URL}/mytype.html?id=${encodeURIComponent(userId)}`;

    // ดึง title/desc/image จาก Apps Script มาใส่ og:tag เสมอ ไม่ว่าใครเข้ามาก็ตาม (ดูคอมเมนต์บนสุดของไฟล์)
    // สำคัญ: actionGetShareMeta ฝั่ง appscript.txt เช็คจาก p.company_id เท่านั้น (ไม่รู้จัก topic_id) ต้องส่งเป็น company_id=
    const qs = topicId
      ? `action=getShareMeta&company_id=${encodeURIComponent(topicId)}`
      : `action=getShareMeta&user_id=${encodeURIComponent(userId)}`;

    let data = null;
    try{
      const apiRes = await fetch(`${appscriptUrl}?${qs}`);
      data = await apiRes.json();
    }catch(fetchErr){
      data = null;
    }

    if(!data || !data.success){
      // Apps Script ตอบไม่สำเร็จ (เช่น cold start ช้าเกิน/ตอบ error) — ยังเสิร์ฟหน้า og:tag ได้เสมอด้วยค่า
      // default ของ TOKBUD แทนที่จะ 302 เฉยๆ ไปดื้อๆ (ซึ่งจะทำให้บอทไม่เห็น og:tag อะไรเลยรอบนั้น)
      return renderOgPage(res, {
        title: 'TOKBUD — Company Experience Check',
        desc: 'Real company experiences, shared by real employees.',
        image: '',
        redirectUrl
      });
    }

    return renderOgPage(res, {
      title: data.title || 'TOKBUD — Company Experience Check',
      desc: data.desc || 'Real company experiences, shared by real employees.',
      image: data.image || '',
      redirectUrl
    });

  }catch(err){
    // เหตุการณ์ไม่คาดคิดใดๆ ก็ตาม -> อย่างน้อยต้องพา user ไปหน้าแรกได้ ไม่ปล่อยให้เจอหน้าขาว/error ดิบ
    try{
      res.statusCode = 302;
      res.setHeader('Location', FRONTEND_URL);
      res.setHeader('Cache-Control', 'no-store');
      return res.end();
    }catch(e2){
      res.statusCode = 500;
      return res.end('error');
    }
  }
};
