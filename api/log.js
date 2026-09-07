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
      requestBody: { values: [['Employee','Date','Day','Clock In','Clock Out','Hours Worked','Total Break (min)','Breaks Detail','Status','Last Updated']] }
    });
  }
}

function fmtTime(iso) { if (!iso) return ''; return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: true }); }
function fmtDate(iso) { return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function fmtDay(iso) { return new Date(iso).toLocaleDateString('en-AU', { weekday: 'long' }); }

function totalBreakMins(breaks) {
  return (breaks || []).reduce((acc, b) => {
    if (b.start && b.end) return acc + (new Date(b.end) - new Date(b.start)) / 60000;
    return acc;
  }, 0);
}

function calcHours(clockIn, clockOut, breaks) {
  if (!clockIn || !clockOut) return '';
  const total = (new Date(clockOut) - new Date(clockIn)) / 3600000;
  return Math.max(0, total - totalBreakMins(breaks) / 60).toFixed(2);
}

function formatBreaksDetail(breaks) {
  if (!breaks || breaks.length === 0) return '';
  return breaks.map((b, i) => {
    const start = fmtTime(b.start);
    const end = b.end ? fmtTime(b.end) : 'ongoing';
    const mins = b.start && b.end ? ` (${Math.round((new Date(b.end) - new Date(b.start)) / 60000)}m)` : '';
    return `B${i + 1}: ${start}–${end}${mins}`;
  }).join(', ');
}

async function findActiveRow(sheets, employee) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:J` });
  const rows = res.data.values || [];
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][0] === employee && rows[i][8] !== 'Completed') return { rowNumber: i + 1, rowData: rows[i] };
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
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:J`, valueInputOption: 'RAW',
        requestBody: { values: [[employee, fmtDate(clockIn), fmtDay(clockIn), fmtTime(clockIn), '', '', '', '', 'Clocked In', now]] }
      });
    } else {
      const found = await findActiveRow(sheets, employee);
      if (!found) return res.status(404).json({ error: 'Active session not found' });
      const { rowNumber, rowData } = found;

      let clockOutFmt = rowData[4] || '';
      let hoursWorked = rowData[5] || '';
      let totalBreak = rowData[6] || '';
      let breaksDetail = rowData[7] || '';
      let status = action === 'clockOut' ? 'Completed' : action === 'breakStart' ? 'On Break' : 'Clocked In';

      if (action === 'clockOut') {
        const bl = breaks || [];
        clockOutFmt = fmtTime(clockOut);
        const mins = Math.round(totalBreakMins(bl));
        totalBreak = mins > 0 ? String(mins) : '';
        hoursWorked = calcHours(clockIn, clockOut, bl);
        breaksDetail = formatBreaksDetail(bl);
      } else if (action === 'breakStart' || action === 'breakEnd') {
        // Build a partial breaks array from what we know so far
        // We'll update breaksDetail progressively
        const partialBreaks = [];
        // Re-parse existing detail isn't reliable, so just update on clockOut
        // For now just update status
        breaksDetail = rowData[7] || '';
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A${rowNumber}:J${rowNumber}`, valueInputOption: 'RAW',
        requestBody: { values: [[employee, rowData[1], rowData[2], rowData[3], clockOutFmt, hoursWorked, totalBreak, breaksDetail, status, now]] }
      });
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Sheets API error:', err);
    res.status(500).json({ error: err.message });
  }
}
