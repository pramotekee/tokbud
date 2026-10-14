{\rtf1\ansi\ansicpg1252\cocoartf2907
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx566\tx1133\tx1700\tx2267\tx2834\tx3401\tx3968\tx4535\tx5102\tx5669\tx6236\tx6803\pardirnatural\partightenfactor0

\f0\fs24 \cf0 // api/training.js  (\uc0\u3648 \u3611 \u3621 \u3637 \u3656 \u3618 \u3609 \u3609 \u3634 \u3617 \u3626 \u3585 \u3640 \u3621 \u3592 \u3634 \u3585  .txt \u3648 \u3611 \u3655 \u3609  .js \u3649 \u3621 \u3657 \u3623 \u3623 \u3634 \u3591 \u3651 \u3609 \u3650 \u3615 \u3621 \u3648 \u3604 \u3629 \u3619 \u3660  api/)\
// \uc0\u3619 \u3633 \u3610 \u3651 \u3610 \u3626 \u3617 \u3633 \u3588 \u3619 \u3588 \u3629 \u3619 \u3660 \u3626  YOU TALK PEOPLE LIKE -> \u3648 \u3586 \u3637 \u3618 \u3609 \u3621 \u3591  Tab "training" \u3651 \u3609  Google Sheet \u3648 \u3604 \u3637 \u3618 \u3623 \u3585 \u3633 \u3610  TOKBUD\
//   GET  /api/training  -> \uc0\u3629 \u3656 \u3634 \u3609 \u3626 \u3606 \u3634 \u3609 \u3632 /\u3586 \u3657 \u3629 \u3617 \u3641 \u3621 \u3619 \u3629 \u3610 \u3648 \u3619 \u3637 \u3618 \u3609 \u3592 \u3634 \u3585  Tab "training_settings"\
//   POST /api/training  -> \uc0\u3610 \u3633 \u3609 \u3607 \u3638 \u3585 \u3651 \u3610 \u3626 \u3617 \u3633 \u3588 \u3619  1 \u3651 \u3610 \u3626 \u3617 \u3633 \u3588 \u3619  = 1 \u3649 \u3606 \u3623 \u3651 \u3627 \u3617 \u3656 \u3648 \u3626 \u3617 \u3629 \
// \uc0\u3627 \u3621 \u3633 \u3585 \u3585 \u3634 \u3619 : map \u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660 \u3592 \u3634 \u3585  "\u3594 \u3639 \u3656 \u3629 \u3627 \u3633 \u3623 \u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660 " (\u3649 \u3606 \u3623  1) \u3652 \u3617 \u3656 \u3651 \u3594 \u3657 \u3621 \u3635 \u3604 \u3633 \u3610 \u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660 \
// \uc0\u3651 \u3594 \u3657  env \u3648 \u3604 \u3636 \u3617 : GOOGLE_SERVICE_ACCOUNT_JSON, TOKBUD_SHEET_ID\
\
const \{ google \} = require('googleapis');\
\
const TAB_APPLY = 'training';\
const TAB_SETTINGS = 'training_settings';\
\
// \uc0\u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660 \u3607 \u3637 \u3656 \u3605 \u3657 \u3629 \u3591 \u3617 \u3637 \u3651 \u3609 \u3649 \u3606 \u3623  1 \u3586 \u3629 \u3591  Tab training (TeamNote \u3652 \u3617 \u3656 \u3610 \u3633 \u3591 \u3588 \u3633 \u3610 )\
const REQUIRED_COLS = [\
  'Timestamp', 'ApplicationID', 'Round', 'FirstName', 'LastName', 'Gender', 'Age',\
  'Email', 'Phone', 'Role', 'RoleOther', 'Interests', 'Package',\
  'PartnerFirstName', 'PartnerLastName', 'PartnerGender', 'PartnerEmail',\
  'CallbackDate', 'CallbackSlot', 'PDPAConsent', 'Status'\
];\
\
const GENDERS = ['\uc0\u3594 \u3634 \u3618 ', '\u3627 \u3597 \u3636 \u3591 ', '\u3652 \u3617 \u3656 \u3619 \u3632 \u3610 \u3640 '];\
const PACKAGES = ['SOLO', 'DUO'];\
const SLOTS = ['09:00-12:00', '12:00-15:00', '15:00-18:00', '\uc0\u3627 \u3621 \u3633 \u3591  18:00'];\
const ROLE_OTHER = '\uc0\u3629 \u3639 \u3656 \u3609 \u3654 ';\
\
let authSingleton = null;\
function getSheets() \{\
  if (!authSingleton) \{\
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);\
    authSingleton = new google.auth.JWT(\{\
      email: creds.client_email,\
      key: creds.private_key,\
      scopes: ['https://www.googleapis.com/auth/spreadsheets']\
    \});\
  \}\
  return google.sheets(\{ version: 'v4', auth: authSingleton \});\
\}\
\
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();\
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);\
const emailOk = (s) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]\{2,\}$/.test(s) && s.length <= 120;\
const phoneClean = (s) => String(s || '').replace(/[\\s-]/g, '');\
const phoneOk = (s) => /^(\\+66|0)\\d\{8,9\}$/.test(s);\
\
function bangkokNow() \{\
  return new Date(Date.now() + 7 * 3600 * 1000);\
\}\
function bangkokTimestamp() \{\
  return bangkokNow().toISOString().replace('T', ' ').slice(0, 19);\
\}\
function bangkokDateStr(offsetDays) \{\
  return new Date(bangkokNow().getTime() + offsetDays * 86400000).toISOString().slice(0, 10);\
\}\
\
// \uc0\u3629 \u3656 \u3634 \u3609 \u3585 \u3634 \u3619 \u3605 \u3633 \u3657 \u3591 \u3588 \u3656 \u3634 \u3619 \u3629 \u3610 \u3648 \u3619 \u3637 \u3618 \u3609 \u3592 \u3634 \u3585  Tab training_settings (\u3629 \u3656 \u3634 \u3609 \u3605 \u3634 \u3617 \u3594 \u3639 \u3656 \u3629 \u3627 \u3633 \u3623 \u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660 )\
async function readSettings(sheets) \{\
  const res = await sheets.spreadsheets.values.get(\{\
    spreadsheetId: process.env.TOKBUD_SHEET_ID,\
    range: TAB_SETTINGS\
  \});\
  const rows = res.data.values || [];\
  const headers = (rows[0] || []).map(norm);\
  const col = (name) => headers.indexOf(norm(name));\
\
  // \uc0\u3626 \u3606 \u3634 \u3609 \u3632 : \u3627 \u3634 \u3649 \u3606 \u3623 \u3607 \u3637 \u3656  Key = RoundStatus \u3649 \u3621 \u3657 \u3623 \u3629 \u3656 \u3634 \u3609 \u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660  Value\
  let status = 'open';\
  const kI = col('Key'), vI = col('Value');\
  if (kI >= 0 && vI >= 0) \{\
    for (let i = 1; i < rows.length; i++) \{\
      if (norm(rows[i][kI]) === 'roundstatus') \{\
        status = norm(rows[i][vI]) === 'full' ? 'full' : 'open'; // \uc0\u3617 \u3637 \u3649 \u3588 \u3656  "full" \u3648 \u3607 \u3656 \u3634 \u3609 \u3633 \u3657 \u3609 \u3607 \u3637 \u3656 \u3611 \u3636 \u3604 \u3619 \u3633 \u3610 \
        break;\
      \}\
    \}\
  \}\
\
  // \uc0\u3586 \u3657 \u3629 \u3617 \u3641 \u3621 \u3619 \u3629 \u3610 : \u3629 \u3656 \u3634 \u3609 \u3592 \u3634 \u3585 \u3649 \u3606 \u3623 \u3607 \u3637 \u3656  2 (\u3649 \u3606 \u3623 \u3586 \u3657 \u3629 \u3617 \u3641 \u3621 \u3649 \u3606 \u3623 \u3649 \u3619 \u3585 ) \u3651 \u3605 \u3657 \u3627 \u3633 \u3623 \u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660  RoundLabel \u3631 \u3621 \u3631 \
  const first = rows[1] || [];\
  const pick = (name) => \{\
    const i = col(name);\
    return i >= 0 ? str(first[i], 200) : '';\
  \};\
  return \{\
    status,\
    round: \{\
      label: pick('RoundLabel'),\
      date: pick('RoundDate'),\
      time: pick('RoundTime'),\
      location: pick('RoundLocation')\
    \}\
  \};\
\}\
\
function parseBody(req) \{\
  let b = req.body;\
  if (typeof b === 'string') \{\
    try \{ b = JSON.parse(b); \} catch (e) \{ b = null; \}\
  \}\
  return b && typeof b === 'object' ? b : null;\
\}\
\
// \uc0\u3605 \u3619 \u3623 \u3592 \u3586 \u3657 \u3629 \u3617 \u3641 \u3621 \u3613 \u3633 \u3656 \u3591 \u3648 \u3595 \u3636 \u3619 \u3660 \u3615 \u3648 \u3623 \u3629 \u3619 \u3660  (\u3652 \u3617 \u3656 \u3648 \u3594 \u3639 \u3656 \u3629 \u3586 \u3657 \u3629 \u3617 \u3641 \u3621 \u3592 \u3634 \u3585 \u3627 \u3609 \u3657 \u3634 \u3648 \u3623 \u3655 \u3610 ) -> \u3588 \u3639 \u3609  \{ error \} \u3627 \u3619 \u3639 \u3629  \{ data \}\
function validate(b) \{\
  const d = \{\
    applicationId: str(b.applicationId, 64),\
    firstName: str(b.firstName, 60),\
    lastName: str(b.lastName, 60),\
    gender: str(b.gender, 20),\
    age: str(b.age, 3),\
    email: str(b.email, 120),\
    phone: phoneClean(str(b.phone, 20)),\
    role: str(b.role, 80),\
    roleOther: str(b.roleOther, 100),\
    interests: Array.isArray(b.interests)\
      ? b.interests.map((x) => str(x, 100)).filter(Boolean).slice(0, 12) : [],\
    pkg: str(b.package, 10),\
    pFirst: str(b.partnerFirstName, 60),\
    pLast: str(b.partnerLastName, 60),\
    pGender: str(b.partnerGender, 20),\
    pEmail: str(b.partnerEmail, 120),\
    cbDate: str(b.callbackDate, 10),\
    cbSlot: str(b.callbackSlot, 20)\
  \};\
\
  const bad = [];\
  if (!/^[A-Za-z0-9-]\{8,64\}$/.test(d.applicationId)) bad.push('applicationId');\
  if (!d.firstName) bad.push('firstName');\
  if (!d.lastName) bad.push('lastName');\
  if (GENDERS.indexOf(d.gender) < 0) bad.push('gender');\
  if (!/^\\d\{1,2\}$/.test(d.age) || +d.age < 10) bad.push('age');\
  if (!emailOk(d.email)) bad.push('email');\
  if (!phoneOk(d.phone)) bad.push('phone');\
  if (!d.role) bad.push('role');\
  if (d.role === ROLE_OTHER && !d.roleOther) bad.push('roleOther');\
  if (d.role !== ROLE_OTHER) d.roleOther = '';\
  if (!d.interests.length) bad.push('interests');\
  if (PACKAGES.indexOf(d.pkg) < 0) bad.push('package');\
  if (d.pkg === 'DUO') \{\
    if (!d.pFirst) bad.push('partnerFirstName');\
    if (!d.pLast) bad.push('partnerLastName');\
    if (GENDERS.indexOf(d.pGender) < 0) bad.push('partnerGender');\
    if (!emailOk(d.pEmail)) bad.push('partnerEmail');\
  \} else \{\
    d.pFirst = d.pLast = d.pGender = d.pEmail = '';\
  \}\
  if (!/^\\d\{4\}-\\d\{2\}-\\d\{2\}$/.test(d.cbDate) ||\
      d.cbDate < bangkokDateStr(0) || d.cbDate > bangkokDateStr(30)) bad.push('callbackDate');\
  if (SLOTS.indexOf(d.cbSlot) < 0) bad.push('callbackSlot');\
  if (b.consent !== true) bad.push('consent');\
\
  return bad.length ? \{ error: bad \} : \{ data: d \};\
\}\
\
module.exports = async function trainingHandler(req, res) \{\
  res.setHeader('Cache-Control', 'no-store');\
\
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.TOKBUD_SHEET_ID) \{\
    console.error('[training] env vars \uc0\u3652 \u3617 \u3656 \u3588 \u3619 \u3610 : GOOGLE_SERVICE_ACCOUNT_JSON / TOKBUD_SHEET_ID');\
    return res.status(500).json(\{ ok: false, error: 'server', message: '\uc0\u3619 \u3632 \u3610 \u3610 \u3586 \u3633 \u3604 \u3586 \u3657 \u3629 \u3591  \u3585 \u3619 \u3640 \u3603 \u3634 \u3621 \u3629 \u3591 \u3651 \u3627 \u3617 \u3656 \u3629 \u3637 \u3585 \u3588 \u3619 \u3633 \u3657 \u3591 ' \});\
  \}\
\
  try \{\
    const sheets = getSheets();\
\
    // ---------- GET: \uc0\u3626 \u3606 \u3634 \u3609 \u3632  + \u3586 \u3657 \u3629 \u3617 \u3641 \u3621 \u3619 \u3629 \u3610  ----------\
    if (req.method === 'GET') \{\
      const s = await readSettings(sheets);\
      return res.status(200).json(\{ ok: true, status: s.status, round: s.round \});\
    \}\
\
    if (req.method !== 'POST') \{\
      return res.status(405).json(\{ ok: false, error: 'method', message: 'Method not allowed' \});\
    \}\
\
    // ---------- POST: \uc0\u3619 \u3633 \u3610 \u3651 \u3610 \u3626 \u3617 \u3633 \u3588 \u3619  ----------\
    const body = parseBody(req);\
    if (!body) \{\
      return res.status(400).json(\{ ok: false, error: 'invalid', message: '\uc0\u3586 \u3657 \u3629 \u3617 \u3641 \u3621 \u3652 \u3617 \u3656 \u3606 \u3641 \u3585 \u3605 \u3657 \u3629 \u3591  \u3585 \u3619 \u3640 \u3603 \u3634 \u3621 \u3629 \u3591 \u3651 \u3627 \u3617 \u3656 \u3629 \u3637 \u3585 \u3588 \u3619 \u3633 \u3657 \u3591 ' \});\
    \}\
\
    // honeypot: \uc0\u3610 \u3629 \u3607 \u3585 \u3619 \u3629 \u3585 \u3594 \u3656 \u3629 \u3591 \u3607 \u3637 \u3656 \u3595 \u3656 \u3629 \u3609 \u3652 \u3623 \u3657  -> \u3605 \u3629 \u3610 \u3626 \u3635 \u3648 \u3619 \u3655 \u3592 \u3627 \u3621 \u3629 \u3585 \u3654  \u3650 \u3604 \u3618 \u3652 \u3617 \u3656 \u3610 \u3633 \u3609 \u3607 \u3638 \u3585 \
    if (str(body.website, 200)) \{\
      return res.status(200).json(\{ ok: true \});\
    \}\
\
    const v = validate(body);\
    if (v.error) \{\
      console.warn('[training] validation failed:', v.error.join(','));\
      return res.status(400).json(\{\
        ok: false, error: 'invalid', fields: v.error,\
        message: '\uc0\u3586 \u3657 \u3629 \u3617 \u3641 \u3621 \u3610 \u3634 \u3591 \u3626 \u3656 \u3623 \u3609 \u3652 \u3617 \u3656 \u3606 \u3641 \u3585 \u3605 \u3657 \u3629 \u3591  \u3585 \u3619 \u3640 \u3603 \u3634 \u3605 \u3619 \u3623 \u3592 \u3626 \u3629 \u3610 \u3649 \u3621 \u3657 \u3623 \u3621 \u3629 \u3591 \u3651 \u3627 \u3617 \u3656 \u3629 \u3637 \u3585 \u3588 \u3619 \u3633 \u3657 \u3591 '\
      \});\
    \}\
    const d = v.data;\
\
    // \uc0\u3611 \u3599 \u3636 \u3648 \u3626 \u3608 \u3592 \u3619 \u3636 \u3591 \u3654  \u3613 \u3633 \u3656 \u3591 \u3648 \u3595 \u3636 \u3619 \u3660 \u3615 \u3648 \u3623 \u3629 \u3619 \u3660 \u3648 \u3617 \u3639 \u3656 \u3629 \u3619 \u3629 \u3610 \u3648 \u3605 \u3655 \u3617  (\u3652 \u3617 \u3656 \u3651 \u3594 \u3656 \u3649 \u3588 \u3656 \u3595 \u3656 \u3629 \u3609 \u3615 \u3629 \u3619 \u3660 \u3617 )\
    const settings = await readSettings(sheets);\
    if (settings.status === 'full') \{\
      return res.status(409).json(\{ ok: false, error: 'full', message: '\uc0\u3619 \u3629 \u3610 \u3609 \u3637 \u3657 \u3648 \u3605 \u3655 \u3617 \u3649 \u3621 \u3657 \u3623 ' \});\
    \}\
\
    // \uc0\u3629 \u3656 \u3634 \u3609 \u3627 \u3633 \u3623 \u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660 \u3586 \u3629 \u3591  Tab training (\u3649 \u3606 \u3623  1) \u3648 \u3614 \u3639 \u3656 \u3629  map \u3605 \u3634 \u3617 \u3594 \u3639 \u3656 \u3629 \
    const headRes = await sheets.spreadsheets.values.get(\{\
      spreadsheetId: process.env.TOKBUD_SHEET_ID,\
      range: TAB_APPLY + '!1:1'\
    \});\
    const headers = (headRes.data.values && headRes.data.values[0]) || [];\
    const idx = \{\};\
    headers.forEach((h, i) => \{ const k = norm(h); if (k && !(k in idx)) idx[k] = i; \});\
\
    const missing = REQUIRED_COLS.filter((c) => !(norm(c) in idx));\
    if (missing.length) \{\
      console.error('[training] Tab "' + TAB_APPLY + '" \uc0\u3586 \u3634 \u3604 \u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660 :', missing.join(', '));\
      return res.status(500).json(\{ ok: false, error: 'server', message: '\uc0\u3619 \u3632 \u3610 \u3610 \u3586 \u3633 \u3604 \u3586 \u3657 \u3629 \u3591  \u3585 \u3619 \u3640 \u3603 \u3634 \u3621 \u3629 \u3591 \u3651 \u3627 \u3617 \u3656 \u3629 \u3637 \u3585 \u3588 \u3619 \u3633 \u3657 \u3591 ' \});\
    \}\
\
    // \uc0\u3585 \u3633 \u3609 \u3610 \u3633 \u3609 \u3607 \u3638 \u3585 \u3595 \u3657 \u3635 \u3592 \u3634 \u3585 \u3585 \u3634 \u3619 \u3585 \u3604 \u3619 \u3633 \u3623 /\u3621 \u3629 \u3591 \u3626 \u3656 \u3591 \u3651 \u3627 \u3617 \u3656 : ApplicationID \u3648 \u3604 \u3636 \u3617  = \u3651 \u3610 \u3626 \u3617 \u3633 \u3588 \u3619 \u3648 \u3604 \u3636 \u3617 \
    const idCol = idx[norm('ApplicationID')];\
    const colLetter = (n) => \{ let s = ''; n++; while (n > 0) \{ const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); \} return s; \};\
    const idRes = await sheets.spreadsheets.values.get(\{\
      spreadsheetId: process.env.TOKBUD_SHEET_ID,\
      range: TAB_APPLY + '!' + colLetter(idCol) + ':' + colLetter(idCol)\
    \});\
    const existing = (idRes.data.values || []).map((r) => String(r[0] || ''));\
    if (existing.indexOf(d.applicationId) >= 0) \{\
      return res.status(200).json(\{ ok: true, duplicate: true \});\
    \}\
\
    // \uc0\u3611 \u3619 \u3632 \u3585 \u3629 \u3610 \u3649 \u3606 \u3623 \u3605 \u3634 \u3617 \u3594 \u3639 \u3656 \u3629 \u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660  (\u3588 \u3629 \u3621 \u3633 \u3617 \u3609 \u3660 \u3607 \u3637 \u3656 \u3652 \u3617 \u3656 \u3619 \u3641 \u3657 \u3592 \u3633 \u3585 \u3611 \u3621 \u3656 \u3629 \u3618 \u3623 \u3656 \u3634 \u3591 )\
    const values = \{\
      Timestamp: bangkokTimestamp(),\
      ApplicationID: d.applicationId,\
      Round: settings.round.label,\
      FirstName: d.firstName,\
      LastName: d.lastName,\
      Gender: d.gender,\
      Age: d.age,\
      Email: d.email,\
      Phone: d.phone,\
      Role: d.role,\
      RoleOther: d.roleOther,\
      Interests: d.interests.join(' | '),\
      Package: d.pkg,\
      PartnerFirstName: d.pFirst,\
      PartnerLastName: d.pLast,\
      PartnerGender: d.pGender,\
      PartnerEmail: d.pEmail,\
      CallbackDate: d.cbDate,\
      CallbackSlot: d.cbSlot,\
      PDPAConsent: 'yes',\
      Status: 'new'\
    \};\
    const row = new Array(headers.length).fill('');\
    Object.keys(values).forEach((k) => \{ row[idx[norm(k)]] = values[k]; \});\
\
    // RAW = \uc0\u3648 \u3585 \u3655 \u3610 \u3648 \u3611 \u3655 \u3609 \u3586 \u3657 \u3629 \u3588 \u3623 \u3634 \u3617 \u3605 \u3634 \u3617 \u3607 \u3637 \u3656 \u3626 \u3656 \u3591  (\u3648 \u3610 \u3629 \u3619 \u3660 \u3650 \u3607 \u3619 \u3586 \u3638 \u3657 \u3609 \u3605 \u3657 \u3609  0 \u3652 \u3617 \u3656 \u3627 \u3634 \u3618 , \u3652 \u3617 \u3656 \u3605 \u3637 \u3588 \u3623 \u3634 \u3617 \u3648 \u3611 \u3655 \u3609 \u3626 \u3641 \u3605 \u3619 )\
    await sheets.spreadsheets.values.append(\{\
      spreadsheetId: process.env.TOKBUD_SHEET_ID,\
      range: TAB_APPLY + '!A1',\
      valueInputOption: 'RAW',\
      insertDataOption: 'INSERT_ROWS',\
      requestBody: \{ values: [row] \}\
    \});\
\
    return res.status(200).json(\{ ok: true \});\
  \} catch (err) \{\
    console.error('[training] error:', err && err.message ? err.message : err);\
    return res.status(500).json(\{ ok: false, error: 'server', message: '\uc0\u3619 \u3632 \u3610 \u3610 \u3586 \u3633 \u3604 \u3586 \u3657 \u3629 \u3591  \u3585 \u3619 \u3640 \u3603 \u3634 \u3621 \u3629 \u3591 \u3651 \u3627 \u3617 \u3656 \u3629 \u3637 \u3585 \u3588 \u3619 \u3633 \u3657 \u3591 ' \});\
  \}\
\};}