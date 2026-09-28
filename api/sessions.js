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

// Columns: A=Employee, B=Date, C=Day, D=ClockIn, E=ClockOut,
//          F=HoursWorked, G=TotalBreak(min), H=B1Start, I=B1End,
//          J=B2Start, K=B2End, L=B3Start, M=B3End, N=Status, O=LastUpdated
//          P=_clockInISO, Q=_clockOutISO

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:Q`,
    });

    const rows = response.data.values || [];

    const sessions = rows
      .filter(r => r[0] && r[15]) // must have employee and _clockInISO
      .map(r => {
        // Rebuild breaks array from discrete columns using raw ISO times from app
        // Break times in cols H-M are formatted strings used for display in sheet
        // We reconstruct ISO times from _clockInISO date + formatted times
        const clockInISO = r[15] || null;
        const clockOutISO = r[16] || null;

        // Build breaks from formatted columns — parse back using date from clockInISO
        const dateStr = clockInISO ? clockInISO.slice(0, 10) : null;

        function parseBack(timeStr) {
          if (!timeStr || !dateStr) return null;
          try {
            // Parse "09:30 AM" style back to ISO using the shift date
            const dt = new Date(`${dateStr} ${timeStr}`);
            return isNaN(dt.getTime()) ? null : dt.toISOString();
          } catch { return null; }
        }

        const breaks = [];
        if (r[7]) breaks.push({ start: parseBack(r[7]), end: r[8] ? parseBack(r[8]) : null });
        if (r[9]) breaks.push({ start: parseBack(r[9]), end: r[10] ? parseBack(r[10]) : null });
        if (r[11]) breaks.push({ start: parseBack(r[11]), end: r[12] ? parseBack(r[12]) : null });

        return {
          employee: r[0],
          clockIn:  clockInISO,
          clockOut: clockOutISO || null,
          breaks:   breaks.filter(b => b.start),
        };
      })
      .filter(s => s.clockIn);

    res.status(200).json({ sessions });

  } catch (err) {
    console.error('Sheets read error:', err);
    res.status(500).json({ error: err.message });
  }
}
