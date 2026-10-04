const { google } = require('googleapis');
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'TimeLog';

// Columns: A=Employee, B=Date, C=Day, D=ClockIn, E=ClockOut,
//          F=HoursWorked, G=TotalBreak(min), H=B1Start, I=B1End,
//          J=B2Start, K=B2End, L=B3Start, M=B3End, N=Status, O=LastUpdated
//          P=_clockInISO, Q=_clockOutISO

const HEADERS = [
  'Employee','Date','Day','Clock In','Clock Out',
  'Hours Worked','Total Break (min)',
  'Break 1 Start','Break 1 End',
  'Break 2 Start','Break 2 End',
  'Break 3 Start','Break 3 End',
  'Status','Last Updated',
  '_clockInISO','_clockOutISO'
];

async function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

async function ensureHeaders(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:A1`,
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return h + ':' + m;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtDay(iso) {
  return new Date(iso).toLocaleDateString('en-AU', { weekday: 'long' });
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

// Find the active (no clock out) row for this employee
async function findActiveRow(sheets, employee) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:Q`,
  });
  const rows = res.data.values || [];
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][0] === employee && rows[i][13] !== 'Completed') {
      return { rowNumber: i + 1, rowData: rows[i] };
    }
  }
  return null;
}

function buildRow(fields) {
  // Always returns a full 17-column row
  return [
    fields.employee   || '',
    fields.date       || '',
    fields.day        || '',
    fields.clockIn    || '',
    fields.clockOut   || '',
    fields.hours      || '',
    fields.breakMins  || '',
    fields.b1s        || '',
    fields.b1e        || '',
    fields.b2s        || '',
    fields.b2e        || '',
    fields.b3s        || '',
    fields.b3e        || '',
    fields.status     || '',
    fields.updated    || '',
    fields.clockInISO || '',
    fields.clockOutISO|| '',
  ];
}

async function ensureProblemLogHeaders(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `ProblemLog!A1:A1`,
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `ProblemLog!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Reported At (AEST)', 'Employee', 'Current Status', 'Last Action', 'Description', 'Recent Errors', 'Active Sessions', 'Device']] },
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const { action } = req.body;
    const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });

    // Handle problem reports separately
    if (action === 'problemReport') {
      await ensureProblemLogHeaders(sheets);
      const { employee, description, currentStatus, lastAction, recentErrors, localSessions, reportedAt, userAgent } = req.body;
      const row = [
        now,
        employee || 'unknown',
        currentStatus || '',
        lastAction || '',
        description || '',
        JSON.stringify(recentErrors || []),
        JSON.stringify(localSessions || []),
        userAgent || ''
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `ProblemLog!A:H`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
      return res.status(200).json({ success: true });
    }

    await ensureHeaders(sheets);

    const {
      clockInFormatted, clockInDate, clockInDay, clockInISO,
      clockOutFormatted, clockOutISO,
      breaks,
      breakStartFormatted, breakEndFormatted, breakIndex,
    } = req.body;
    const employee = req.body.employee;

    if (action === 'clockIn') {
      const row = buildRow({
        employee,
        date: clockInDate,
        day: clockInDay,
        clockIn: clockInFormatted,
        status: 'Clocked In',
        updated: now,
        clockInISO,
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:Q`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });

    } else {
      const found = await findActiveRow(sheets, employee);
      if (!found) return res.status(404).json({ error: 'Active session not found' });
      const { rowNumber, rowData } = found;

      // Read existing break columns
      let b1s = rowData[7]  || '';
      let b1e = rowData[8]  || '';
      let b2s = rowData[9]  || '';
      let b2e = rowData[10] || '';
      let b3s = rowData[11] || '';
      let b3e = rowData[12] || '';
      let clockOutFmt  = rowData[4]  || '';
      let hours        = rowData[5]  || '';
      let breakMins    = rowData[6]  || '';
      let storedClockOutISO = rowData[16] || '';
      let status = rowData[13] || 'Clocked In';

      if (action === 'breakStart') {
        // Write start time to the correct break slot
        if (breakIndex === 0)      b1s = breakStartFormatted;
        else if (breakIndex === 1) b2s = breakStartFormatted;
        else if (breakIndex === 2) b3s = breakStartFormatted;
        status = 'On Break';

      } else if (action === 'breakEnd') {
        // Write end time to the correct break slot
        if (breakIndex === 0)      b1e = breakEndFormatted;
        else if (breakIndex === 1) b2e = breakEndFormatted;
        else if (breakIndex === 2) b3e = breakEndFormatted;
        status = 'Clocked In';

      } else if (action === 'clockOut') {
        clockOutFmt = clockOutFormatted;
        storedClockOutISO = clockOutISO;
        status = 'Completed';
        // Use breaks array from app for accurate calculation
        const mins = Math.round(totalBreakMins(breaks || []));
        breakMins = mins > 0 ? String(mins) : '';
        hours = calcHours(rowData[15], clockOutISO, breaks || []);
        // Overwrite break columns from final app state (most accurate)
        const bl = breaks || [];
        if (bl[0]) { b1s = fmtTime(bl[0].start); b1e = bl[0].end ? fmtTime(bl[0].end) : b1e; }
        if (bl[1]) { b2s = fmtTime(bl[1].start); b2e = bl[1].end ? fmtTime(bl[1].end) : b2e; }
        if (bl[2]) { b3s = fmtTime(bl[2].start); b3e = bl[2].end ? fmtTime(bl[2].end) : b3e; }
      }

      const updatedRow = buildRow({
        employee,
        date:        rowData[1],
        day:         rowData[2],
        clockIn:     rowData[3],
        clockOut:    clockOutFmt,
        hours,
        breakMins,
        b1s, b1e, b2s, b2e, b3s, b3e,
        status,
        updated:     now,
        clockInISO:  rowData[15] || '',
        clockOutISO: storedClockOutISO,
      });

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${rowNumber}:Q${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [updatedRow] },
      });
    }

    res.status(200).json({ success: true });

  } catch (err) {
    console.error('Sheets API error:', err);
    res.status(500).json({ error: err.message });
  }
}
