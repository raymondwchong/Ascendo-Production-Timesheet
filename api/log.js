const { google } = require('googleapis');
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'TimeLog';

async function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return auth.getClient();
}

async function ensureHeaders(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1:A1` });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1`, valueInputOption: 'RAW',
      requestBody: { values: [['Employee','Date','Day','Clock In','Clock Out','Hours Worked','Total Break (min)','Break 1 Start','Break 1 End','Break 2 Start','Break 2 End','Break 3 Start','Break 3 End','Status','Last Updated']] }
    });
  }
}

function fmtTime(iso) { if (!iso) return ''; return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: true }); }
function fmtDate(iso) { return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function fmtDay(iso) { return new Date(iso).toLocaleDateString('en-AU', { weekday: 'long' }); }
function totalBreakMins(breaks) { return (breaks || []).reduce((acc, b) => { if (b.start && b.end) return acc + (new Date(b.end) - new Date(b.start)) / 60000; return acc; }, 0); }
function calcHours(clockIn, clockOut, breaks) { if (!clockIn || !clockOut) return ''; const total = (new Date(clockOut) - new Date(clockIn)) / 3600000; return Math.max(0, total - totalBreakMins(breaks) / 60).toFixed(2); }

async function findActiveRow(sheets, employee) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:O` });
  const rows = res.data.values || [];
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][0] === employee && rows[i][13] !== 'Completed') return { rowNumber: i + 1, rowData: rows[i] };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureHeaders(sheets);
    const { action, employee, clockIn, clockOut, breaks, breakStart, breakEnd, breakIndex } = req.body;
    const now = new Date().toISOString();

    if (action === 'clockIn') {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:O`, valueInputOption: 'RAW',
        requestBody: { values: [[employee, fmtDate(clockIn), fmtDay(clockIn), fmtTime(clockIn), '', '', '', '', '', '', '', '', '', 'Clocked In', now]] }
      });
    } else {
      const found = await findActiveRow(sheets, employee);
      if (!found) return res.status(404).json({ error: 'Active session not found' });
      const { rowNumber, rowData } = found;

      let b1s = rowData[7]||'', b1e = rowData[8]||'', b2s = rowData[9]||'', b2e = rowData[10]||'', b3s = rowData[11]||'', b3e = rowData[12]||'';

      if (action === 'breakStart') {
        const t = fmtTime(breakStart);
        if (breakIndex === 0) b1s = t; else if (breakIndex === 1) b2s = t; else if (breakIndex === 2) b3s = t;
      }
      if (action === 'breakEnd') {
        const t = fmtTime(breakEnd);
        if (breakIndex === 0) b1e = t; else if (breakIndex === 1) b2e = t; else if (breakIndex === 2) b3e = t;
      }

      let clockOutFmt = rowData[4]||'', hoursWorked = rowData[5]||'', totalBreak = rowData[6]||'';
      let status = action === 'clockOut' ? 'Completed' : action === 'breakStart' ? 'On Break' : 'Clocked In';

      if (action === 'clockOut') {
        clockOutFmt = fmtTime(clockOut);
        const bl = breaks || [];
        const mins = Math.round(totalBreakMins(bl));
        totalBreak = mins > 0 ? String(mins) : '';
        hoursWorked = calcHours(rowData[3], clockOut, bl);
        b1s = bl[0] ? fmtTime(bl[0].start) : b1s; b1e = bl[0]&&bl[0].end ? fmtTime(bl[0].end) : b1e;
        b2s = bl[1] ? fmtTime(bl[1].start) : b2s; b2e = bl[1]&&bl[1].end ? fmtTime(bl[1].end) : b2e;
        b3s = bl[2] ? fmtTime(bl[2].start) : b3s; b3e = bl[2]&&bl[2].end ? fmtTime(bl[2].end) : b3e;
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A${rowNumber}:O${rowNumber}`, valueInputOption: 'RAW',
        requestBody: { values: [[employee, rowData[1], rowData[2], rowData[3], clockOutFmt, hoursWorked, totalBreak, b1s, b1e, b2s, b2e, b3s, b3e, status, now]] }
      });
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Sheets API error:', err);
    res.status(500).json({ error: err.message });
  }
}
