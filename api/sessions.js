const { google } = require('googleapis');
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'TimeLog';

async function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  return auth.getClient();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:J`,
    });

    const rows = response.data.values || [];

    // Columns: A=Employee, B=Date, C=Day, D=ClockIn, E=ClockOut,
    //          F=HoursWorked, G=TotalBreakMins, H=BreaksDetail, I=Status, J=LastUpdated
    const sessions = rows
      .filter(r => r[0] && r[1] && r[3])
      .map(r => ({
        employee: r[0] || '',
        clockIn: r[3] ? parseDateTime(r[1], r[3]) : null,
        clockOut: r[4] ? parseDateTime(r[1], r[4]) : null,
        breaks: parseBreaksDetail(r[7], r[1]),
        hoursWorked: r[5] || null,
      }))
      .filter(s => s.clockIn);

    res.status(200).json({ sessions });
  } catch (err) {
    console.error('Sheets read error:', err);
    res.status(500).json({ error: err.message });
  }
}

function parseDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr || timeStr === '—' || timeStr === '') return null;
  try {
    const [day, month, year] = dateStr.split('/');
    const dt = new Date(`${year}-${month}-${day} ${timeStr}`);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  } catch { return null; }
}

// Parse the summary string "B1: 10:00 AM–10:15 AM (15m), B2: 12:30 PM–01:00 PM (30m)"
// back into a breaks array for the app to display
function parseBreaksDetail(detail, dateStr) {
  if (!detail || !dateStr) return [];
  try {
    return detail.split(', ').map(part => {
      const match = part.match(/B\d+:\s*(.+?)–(.+?)(?:\s*\(\d+m\))?$/);
      if (!match) return null;
      const start = parseDateTime(dateStr, match[1].trim());
      const end = match[2].trim() === 'ongoing' ? null : parseDateTime(dateStr, match[2].trim());
      return { start, end };
    }).filter(Boolean);
  } catch { return []; }
}
