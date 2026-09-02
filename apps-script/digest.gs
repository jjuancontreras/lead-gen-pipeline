/**
 * Apps Script runs plain JavaScript, NOT TypeScript. A type annotation
 * here is a fatal SyntaxError at paste time, not a lint warning - the whole
 * file fails to parse and the trigger silently never runs.
 *
 * SETUP INSTRUCTIONS
 *
 * 1. Open the bound Apps Script editor:
 *    - In the Google Sheet, click Extensions > Apps Script
 *    - The editor opens to this file (digest.gs)
 *
 * 2. Add the daily 08:00 time-driven trigger:
 *    - In the editor, click the clock icon (Triggers) in the left sidebar
 *    - Click "+ Create new trigger"
 *    - Choose:
 *      * Function: digestLeads
 *      * Deployment: Head
 *      * Event source: Time-driven
 *      * Type of time-based trigger: Day timer
 *      * Time of day: 8:00 AM – 9:00 AM
 *    - Click Save
 *
 * 3. Required OAuth scopes (automatically requested on first run):
 *    - https://www.googleapis.com/auth/spreadsheets (read-only for this script)
 *    - https://www.googleapis.com/auth/gmail.send
 *
 * The script reads the Leads sheet, finds all leads with next_action_date <= today
 * and do_not_contact empty, and sends one batched email to the user listing them
 * (most-overdue first).
 */

function digestLeads() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Leads');

  // Handle missing sheet.
  if (!sheet) {
    Logger.log('Leads tab not found - nothing to do');
    return;
  }

  // Get all data.
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    // Only header row or empty.
    Logger.log('Leads sheet is empty - nothing to do');
    return;
  }

  // Map headers by name.
  const headers = data[0];
  const headerMap = {};
  for (let i = 0; i < headers.length; i++) {
    headerMap[headers[i]] = i;
  }

  // Helper to safely get cell value by column name.
  function getCell(row, columnName) {
    const idx = headerMap[columnName];
    return (idx !== undefined ? (row[idx] ?? '').toString().trim() : '').trim();
  }

  // Helper to parse date strings (e.g., "2025-09-03" or "9/3/2025").
  function parseDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }

  // Validate required columns exist.
  const requiredCols = [
    'name', 'tier', 'status', 'channel_used',
    'email', 'phone', 'instagram', 'facebook', 'tiktok',
    'next_action_date', 'last_contacted_at', 'do_not_contact',
  ];
  for (const col of requiredCols) {
    if (!(col in headerMap)) {
      Logger.log(`Column "${col}" not found in Leads sheet - nothing to do`);
      return;
    }
  }

  // Today at 00:00 UTC.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Collect leads due for action.
  const due = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    const nextActionDateStr = getCell(row, 'next_action_date');
    const doNotContactStr = getCell(row, 'do_not_contact');

    // Skip if do_not_contact is set.
    if (doNotContactStr) {
      continue;
    }

    // Parse next_action_date.
    const nextActionDate = parseDate(nextActionDateStr);
    if (!nextActionDate) {
      // Invalid or missing date - skip.
      continue;
    }

    // Include if next_action_date <= today.
    if (nextActionDate <= today) {
      const lastContactedStr = getCell(row, 'last_contacted_at');
      const lastContactedDate = parseDate(lastContactedStr);

      // Calculate days since last contact.
      let daysSinceContacted = '';
      if (lastContactedDate) {
        const diff = Math.floor((today.getTime() - lastContactedDate.getTime()) / (1000 * 60 * 60 * 24));
        daysSinceContacted = diff.toString();
      }

      due.push({
        name: getCell(row, 'name'),
        tier: getCell(row, 'tier'),
        status: getCell(row, 'status'),
        channelUsed: getCell(row, 'channel_used'),
        email: getCell(row, 'email'),
        phone: getCell(row, 'phone'),
        instagram: getCell(row, 'instagram'),
        facebook: getCell(row, 'facebook'),
        tiktok: getCell(row, 'tiktok'),
        nextActionDate: nextActionDateStr,
        daysSinceContacted: daysSinceContacted,
      });
    }
  }

  // If nothing is due, log and exit.
  if (due.length === 0) {
    Logger.log('No leads due for action');
    return;
  }

  // Sort by next_action_date (most overdue first).
  due.sort((a, b) => {
    const dateA = parseDate(a.nextActionDate) || new Date(9999, 0, 1);
    const dateB = parseDate(b.nextActionDate) || new Date(9999, 0, 1);
    return dateA.getTime() - dateB.getTime();
  });

  // Build email body.
  let body = `You have ${due.length} lead${due.length === 1 ? '' : 's'} due for action:\n\n`;

  for (const lead of due) {
    body += `${lead.name}\n`;
    body += `  Tier: ${lead.tier}\n`;
    body += `  Status: ${lead.status}\n`;
    body += `  Channel: ${lead.channelUsed}\n`;

    // Best contact: email → phone → instagram → facebook → tiktok.
    let contact = '(no contact available)';
    if (lead.email) {
      contact = lead.email;
    } else if (lead.phone) {
      contact = lead.phone;
    } else if (lead.instagram) {
      contact = lead.instagram;
    } else if (lead.facebook) {
      contact = lead.facebook;
    } else if (lead.tiktok) {
      contact = lead.tiktok;
    }
    body += `  Contact: ${contact}\n`;

    body += `  Next Action: ${lead.nextActionDate}\n`;
    if (lead.daysSinceContacted) {
      body += `  Days Since Contacted: ${lead.daysSinceContacted}\n`;
    }
    body += '\n';
  }

  // Send email to user.
  const userEmail = Session.getActiveUser().getEmail();
  GmailApp.sendEmail(userEmail, 'Leads Digest', body);
  Logger.log(`Sent digest to ${userEmail} with ${due.length} lead${due.length === 1 ? '' : 's'}`);
}
