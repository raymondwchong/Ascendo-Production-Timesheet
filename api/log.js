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

    // All times arrive pre-formatted from the browser in local timezone
    // clockInISO and clockOutISO are raw ISO strings used only for hour calculation
    const {
      action, employee,
      clockInFormatted, clockInDate, clockInDay, clockInISO,
      clockOutFormatted, clockOutISO,
      breaks, breaksDetail,
      totalBreakMins: totalBreakMinsVal
    } = req.body;

    const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });

    if (action === 'clockIn') {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:J`, valueInputOption: 'RAW',
        requestBody: { values: [[employee, clockInDate, clockInDay, clockInFormatted, '', '', '', '', 'Clocked In', now]] }
      });

    } else {
      const found = await findActiveRow(sheets, employee);
      if (!found) return res.status(404).json({ error: 'Active session not found' });
      const { rowNumber, rowData } = found;

      let clockOutFmt = rowData[4] || '';
      let hoursWorked = rowData[5] || '';
      let totalBreak = rowData[6] || '';
      let breaksDetailVal = rowData[7] || '';
      let status = action === 'clockOut' ? 'Completed' : action === 'breakStart' ? 'On Break' : 'Clocked In';

      if (action === 'clockOut') {
        clockOutFmt = clockOutFormatted;
        hoursWorked = calcHours(clockInISO, clockOutISO, breaks);
        totalBreak = totalBreakMinsVal ? String(Math.round(totalBreakMinsVal)) : '';
        breaksDetailVal = breaksDetail || '';
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A${rowNumber}:J${rowNumber}`, valueInputOption: 'RAW',
        requestBody: { values: [[employee, rowData[1], rowData[2], rowData[3], clockOutFmt, hoursWorked, totalBreak, breaksDetailVal, status, now]] }
      });
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Sheets API error:', err);
    res.status(500).json({ error: err.message });
  }
}
