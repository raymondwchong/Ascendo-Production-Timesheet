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
      range: `${SHEET_NAME}!A2:M`,
    });

    const rows = response.data.values || [];

    // Columns:
    // A=Employee, B=Date, C=Day, D=ClockIn(formatted), E=ClockOut(formatted)
    // F=HoursWorked, G=TotalBreakMins, H=BreaksDetail, I=Status, J=LastUpdated
    // K=_clockInISO, L=_clockOutISO, M=_breaksJSON  (raw data for accurate sync)

    const sessions = rows
      .filter(r => r[0] && r[10]) // must have employee and clockInISO
      .map(r => {
        let breaks = [];
        try { if (r[12]) breaks = JSON.parse(r[12]); } catch(e) {}

        return {
          employee: r[0],
          clockIn: r[10] || null,       // use raw ISO — always accurate
          clockOut: r[11] || null,       // use raw ISO — always accurate
          breaks: breaks,
        };
      })
      .filter(s => s.clockIn);

    res.status(200).json({ sessions });
  } catch (err) {
    console.error('Sheets read error:', err);
    res.status(500).json({ error: err.message });
  }
}
