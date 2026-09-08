// /api/share.js — Vercel Serverless Function สำหรับ TOKBUD (ดัดแปลงจาก share.js เดิมของ WEZIDE ที่ Pop ส่งมาให้ดู)
//
// เก็บ pattern การป้องกันบั๊กทั้งหมดจากเวอร์ชัน WEZIDE ไว้ครบ (ไม่พึ่ง req.query, ห่อ try/catch ชั้นนอกกัน
// หน้าขาว, ไม่ตรวจจับ 'line/' เป็นบอทกันคนจริงเจอหน้าว่าง, ปิด cache/Range request กัน Facebook 206 bug)
// สิ่งที่เปลี่ยนจากของเดิมมี 3 จุด:
//   1. FRONTEND_URL / DEFAULT_APPSCRIPT_URL ชี้มาที่โปรเจค TOKBUD แทน WEZIDE
//   2. query param ที่ยิงไป Apps Script เปลี่ยนจาก topic_id= เป็น company_id= — เจอบั๊กจริงตอนตรวจโค้ด:
//      appscript.txt ฝั่ง actionGetShareMeta(p) เช็คแค่ p.company_id เท่านั้น ถ้ายังส่ง topic_id= แบบเดิม
//      (ตามไฟล์ WEZIDE ที่ส่งมา) จะโดน fail('ต้องระบุ company_id') ทุกครั้ง ต่อให้แก้ domain/ทุกอย่างอื่นถูกหมด
//      แล้วก็ยังจะไม่มีรูป/title ขึ้นอยู่ดี
//   3. title/desc default (กรณี Apps Script ตอบไม่สำเร็จ) เปลี่ยนเป็นข้อความของ TOKBUD

const DEFAULT_APPSCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwH_KorLbUReFtJ0q3uxLBcc802Crm451rlc31PlOeBZCL2oL9bUu-Jlb3bJnMBQnlbgw/exec';
const FRONTEND_URL = 'https://tokbud.vercel.app';

const BOT_UA_PATTERNS = [
  // หมายเหตุสำคัญ (สืบทอดมาจาก WEZIDE): ไม่ใส่ 'line/' ในลิสต์นี้โดยตั้งใจ — LINE ไม่มี user-agent แยกระหว่าง
  // "บอทดึงพรีวิว" กับ "in-app browser ที่คนจริงใช้เปิดลิงก์" ทั้งคู่มีคำว่า "Line/" ติดมาเหมือนกันหมด ถ้าใส่ไว้
  // จะทำให้คนจริงที่กดลิงก์ในแอป LINE โดนเข้าใจผิดว่าเป็นบอท แล้วได้หน้า og:tag เปล่า (body ว่าง) แทนที่จะถูก
  // redirect ไปหน้าเว็บจริง — เป็นสาเหตุของบั๊ก "กดลิงก์แล้วเจอหน้าขาว" ที่เจอในโปรเจคเดิมมาก่อน
  // (แลกกับ trade-off: รูปพรีวิวใน LINE อาจไม่การันตีว่าจะขึ้นเสมอ เพราะตรวจจับบอทของ LINE ไม่ได้แม่นยำ
  // — แต่การกดลิงก์แล้วไปหน้าเว็บถูกต้องสำคัญกว่า)
  'facebookexternalhit', 'facebot', 'twitterbot', 'slackbot',
  'discordbot', 'whatsapp', 'telegrambot', 'linkedinbot', 'pinterest', 'googlebot',
  'bingbot', 'embedly', 'quora link preview', 'showyoubot', 'outbrain', 'redditbot',
  'applebot', 'skypeuripreview', 'vkshare', 'w3c_validator', 'iframely', 'tumblr'
];

function isBot(userAgent){
  const ua = String(userAgent || '').toLowerCase();
  return BOT_UA_PATTERNS.some(p => ua.indexOf(p) !== -1);
}

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

module.exports = async (req, res) => {
  try{
    const appscriptUrl = process.env.APPSCRIPT_URL || DEFAULT_APPSCRIPT_URL;
    // ฝั่ง index.txt (buildShareUrl) ยิง /api/share?topic=<company_id> มา — พารามิเตอร์ในลิงก์ยังชื่อ "topic"
    // ตาม URL pattern เดิม ไม่ได้เปลี่ยน แค่ค่าที่ยิงต่อไปให้ Apps Script (ข้อ 2 ด้านบน) เท่านั้นที่ต้องเปลี่ยนชื่อ
    const topicId = getQueryParam(req, 'topic');
    const userId = getQueryParam(req, 'mytype');

    if(!topicId && !userId){
      return redirect(res, FRONTEND_URL);
    }

    const redirectUrl = topicId
      ? `${FRONTEND_URL}/?topic=${encodeURIComponent(topicId)}`
      : `${FRONTEND_URL}/mytype.html?id=${encodeURIComponent(userId)}`;

    const ua = req.headers && req.headers['user-agent'];

    // คนจริง -> 302 ตรงไปหน้าเว็บจริงทันที ไม่ต้องรอดึง meta
    if(!isBot(ua)){
      return redirect(res, redirectUrl);
    }

    // bot -> ดึง title/desc/image จาก Apps Script มาใส่ og:tag
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
      return redirect(res, redirectUrl);
    }

    const title = data.title || 'TOKBUD — Company Experience Check';
    const desc = data.desc || 'Real company experiences, shared by real employees.';
    const image = data.image || '';

    const html = `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(redirectUrl)}">
</head><body></body></html>`;

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
