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
      requestBody: { values: [['Employee','Date','Day','Clock In','Clock Out','Hours Worked','Total Break (min)','Breaks Detail','Status','Last Updated','_clockInISO','_clockOutISO','_breaksJSON']] }
    });
  }
}

function totalBreakMins(breaks) {
  return (breaks || []).reduce((acc, b) => {
    if (b.start && b.end) return acc + (new Date(b.end) - new Date(b.start)) / 60000;
    return acc;
  }, 0);
}

function calcHours(clockInISO, clockOutISO, breaks) {
  if (!clockInISO || !clockOutISO) return '';
  const total = (new Date(clockOutISO) - new Date(clockInISO)) / 3600000;
  return Math.max(0, total - totalBreakMins(breaks) / 60).toFixed(2);
}

async function findActiveRow(sheets, employee) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:M` });
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

    const {
      action, employee,
      clockInFormatted, clockInDate, clockInDay, clockInISO,
      clockOutFormatted, clockOutISO,
      breaks, breaksDetail, totalBreakMins: totalBreakMinsVal
    } = req.body;

    const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });

    if (action === 'clockIn') {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:M`, valueInputOption: 'RAW',
        requestBody: { values: [[
          employee, clockInDate, clockInDay, clockInFormatted,
          '', '', '', '', 'Clocked In', now,
          clockInISO, '', ''  // hidden ISO columns
        ]]}
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
      let storedClockOutISO = rowData[11] || '';
      let storedBreaksJSON = rowData[12] || '';

      if (action === 'clockOut') {
        clockOutFmt = clockOutFormatted;
        storedClockOutISO = clockOutISO;
        storedBreaksJSON = JSON.stringify(breaks || []);
        hoursWorked = calcHours(rowData[10], clockOutISO, breaks);
        totalBreak = totalBreakMinsVal ? String(Math.round(totalBreakMinsVal)) : '';
        breaksDetailVal = breaksDetail || '';
      } else if (action === 'breakStart' || action === 'breakEnd') {
        storedBreaksJSON = JSON.stringify(breaks || []);
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A${rowNumber}:M${rowNumber}`, valueInputOption: 'RAW',
        requestBody: { values: [[
          employee, rowData[1], rowData[2], rowData[3],
          clockOutFmt, hoursWorked, totalBreak, breaksDetailVal,
          status, now,
          rowData[10] || '', storedClockOutISO, storedBreaksJSON
        ]]}
      });
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Sheets API error:', err);
    res.status(500).json({ error: err.message });
  }
}
