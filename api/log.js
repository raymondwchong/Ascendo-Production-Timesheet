// api/log.js
// Vercel serverless function — receives clock events and writes to Google Sheets

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'TimeLog';

async function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

async function ensureHeaders(sheets) {
  const headers = [
    'Row ID', 'Employee', 'Date', 'Day',
    'Clock In', 'Lunch Out', 'Lunch In', 'Clock Out',
    'Hours Worked', 'Lunch Duration (h)', 'Status', 'Last Updated'
  ];

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:L1`,
  });

  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtDay(iso) {
  return new Date(iso).toLocaleDateString('en-AU', { weekday: 'long' });
}

function calcHours(clockIn, clockOut, lunchStart, lunchEnd) {
  if (!clockIn || !clockOut) return '';
  let total = (new Date(clockOut) - new Date(clockIn)) / 3600000;
  if (lunchStart && lunchEnd) total -= (new Date(lunchEnd) - new Date(lunchStart)) / 3600000;
  return Math.max(0, total).toFixed(2);
}

function getStatus(clockOut, lunchStart, lunchEnd) {
  if (clockOut) return 'Completed';
  if (lunchStart && !lunchEnd) return 'On Lunch';
  if (lunchStart && lunchEnd) return 'Clocked In';
  return 'Clocked In';
}

// Find existing row for this session (employee + clockIn date)
async function findExistingRow(sheets, employee, clockInISO) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:E`,
  });

  const rows = res.data.values || [];
  const dateStr = fmtDate(clockInISO);

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][1] === employee && rows[i][2] === dateStr) {
      return i + 1; // 1-indexed sheet row number
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureHeaders(sheets);

    const { action, employee, clockIn, lunchStart, lunchEnd, clockOut } = req.body;
    const now = new Date().toISOString();

    if (action === 'clockIn') {
      // Insert a new row
      const row = [
        `${employee}_${clockIn}`, // row ID
        employee,
        fmtDate(clockIn),
        fmtDay(clockIn),
        fmtTime(clockIn),
        '', '', '',             // lunch out, lunch in, clock out (empty)
        '',                    // hours
        '',                    // lunch duration
        'Clocked In',
        now
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:L`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });

    } else {
      // Find the existing row and update it
      // We need to get the clock in time — stored in body for lunch/clockout actions
      // Fetch all rows to find matching employee row without clockOut
      const allRows = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:L`,
      });

      const rows = allRows.data.values || [];
      let targetRowIndex = null;
      let existingData = null;

      for (let i = rows.length - 1; i >= 1; i--) {
        if (rows[i][1] === employee && rows[i][10] !== 'Completed') {
          targetRowIndex = i + 1;
          existingData = rows[i];
          break;
        }
      }

      if (!targetRowIndex) {
        return res.status(404).json({ error: 'Active session not found' });
      }

      // Parse existing data
      const existing = {
        clockIn: existingData[4],
        lunchOut: existingData[5],
        lunchIn: existingData[6],
        clockOut: existingData[7],
      };

      if (action === 'lunchStart') existing.lunchOut = fmtTime(lunchStart);
      if (action === 'lunchEnd') existing.lunchIn = fmtTime(lunchEnd);
      if (action === 'clockOut') {
        if (lunchEnd && !existing.lunchIn) existing.lunchIn = fmtTime(lunchEnd);
        existing.clockOut = fmtTime(clockOut);
      }

      // Recalculate hours if we have all data
      let hoursWorked = '';
      let lunchDuration = '';

      // Re-derive ISO times for calculation from original clockIn
      const clockInISO = req.body.clockIn || null;

      if (action === 'clockOut' && clockInISO && clockOut) {
        hoursWorked = calcHours(clockInISO, clockOut, lunchStart, lunchEnd);
        if (lunchStart && lunchEnd) {
          lunchDuration = ((new Date(lunchEnd) - new Date(lunchStart)) / 3600000).toFixed(2);
        }
      }

      const newStatus = action === 'clockOut' ? 'Completed' :
                        action === 'lunchStart' ? 'On Lunch' : 'Clocked In';

      const updatedRow = [
        existingData[0],
        employee,
        existingData[2],
        existingData[3],
        existing.clockIn,
        existing.lunchOut,
        existing.lunchIn,
        existing.clockOut || '',
        hoursWorked || existingData[8] || '',
        lunchDuration || existingData[9] || '',
        newStatus,
        now
      ];

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${targetRowIndex}:L${targetRowIndex}`,
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

