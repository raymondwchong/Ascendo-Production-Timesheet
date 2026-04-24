// api/sessions.js
// Returns all sessions from Google Sheets so the app can sync on load

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'TimeLog';

async function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return auth.getClient();
}

function parseTime(dateStr, timeStr) {
  // Converts "12/04/2025" + "09:30 AM" back to ISO string (approximate — good enough for display)
  if (!dateStr || !timeStr || timeStr === '—' || timeStr === '') return null;
  try {
    const [day, month, year] = dateStr.split('/');
    const dt = new Date(`${year}-${month}-${day} ${timeStr}`);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:L`, // skip header row
    });

    const rows = response.data.values || [];

    const sessions = rows
      .filter(r => r[1] && r[2] && r[4]) // must have employee, date, clock in
      .map(r => ({
        employee: r[1] || '',
        clockIn: parseTime(r[2], r[4]),
        lunchStart: parseTime(r[2], r[5]),
        lunchEnd: parseTime(r[2], r[6]),
        clockOut: parseTime(r[2], r[7]),
      }))
      .filter(s => s.clockIn);

    res.status(200).json({ sessions });

  } catch (err) {
    console.error('Sheets read error:', err);
    res.status(500).json({ error: err.message });
  }
}

