'use strict';

const db = require('./db');

// ---------------------------------------------------------------------------
// sendEmail – sends a transactional email via the Resend API.
// If RESEND_API_KEY is absent (or not configured in app_settings), the mail is
// only logged to the console so the app stays usable without email configured.
// ---------------------------------------------------------------------------
async function sendEmail({ to, subject, html, text }) {
  const apiKey = db.getSetting('resend_api_key') || process.env.RESEND_API_KEY || '';
  const from   = db.getSetting('email_from')     || process.env.EMAIL_FROM    || 'Kanban <noreply@yourdomain.com>';

  if (!apiKey) {
    console.log('[EMAIL] (no API key – mail not sent)');
    console.log(`[EMAIL] To: ${to} | Subject: ${subject}`);
    if (text) console.log(`[EMAIL] Body: ${text}`);
    return { ok: false, reason: 'no_api_key' };
  }

  const payload = JSON.stringify({ from, to, subject, html: html || text, text: text || '' });

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: payload,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[EMAIL] Resend API error', res.status, body);
      return { ok: false, status: res.status, body };
    }
    console.log('[EMAIL] Sent to', to, '| subject:', subject, '| id:', body.id);
    return { ok: true, id: body.id };
  } catch (err) {
    console.error('[EMAIL] Failed to call Resend API:', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Helper: check if a user has a notification pref enabled
// ---------------------------------------------------------------------------
function isEnabled(userId, eventType) {
  const prefs = db.getNotificationPrefs(userId);
  return !!(prefs[eventType] && prefs[eventType].email_enabled);
}

// ---------------------------------------------------------------------------
// notifyCardAssigned
//   Called when a user is assigned to a card.
//   assignedUserId  – the user being assigned
//   card            – { id, text }
//   byUsername      – who performed the assignment
// ---------------------------------------------------------------------------
async function notifyCardAssigned({ assignedUserId, card, byUsername }) {
  if (!isEnabled(assignedUserId, 'card_assigned')) return;
  const user = db.getUserById(assignedUserId);
  if (!user || !user.email) return;

  await sendEmail({
    to:      user.email,
    subject: `Du wurdest einer Karte zugewiesen: "${card.text}"`,
    text:    `Hallo ${user.username},\n\n${byUsername || 'Jemand'} hat dich der Karte "${card.text}" zugewiesen.\n`,
    html:    `<p>Hallo <strong>${user.username}</strong>,</p>
              <p><strong>${escHtml(byUsername || 'Jemand')}</strong> hat dich der Karte <strong>${escHtml(card.text)}</strong> zugewiesen.</p>`,
  });
}

// ---------------------------------------------------------------------------
// notifyCommentAdded
//   Called when a comment is added to a card.
//   card        – { id, text }
//   comment     – { text, author }
//   assigneeIds – array of user IDs assigned to the card
// ---------------------------------------------------------------------------
async function notifyCommentAdded({ card, comment, assigneeIds }) {
  for (const userId of assigneeIds) {
    if (!isEnabled(userId, 'comment_added')) continue;
    const user = db.getUserById(userId);
    if (!user || !user.email) continue;
    // Don't notify the author of their own comment
    if (user.username === comment.author) continue;

    await sendEmail({
      to:      user.email,
      subject: `Neuer Kommentar auf "${card.text}"`,
      text:    `Hallo ${user.username},\n\n${comment.author || 'Jemand'} hat einen Kommentar hinterlassen:\n\n"${comment.text}"\n`,
      html:    `<p>Hallo <strong>${escHtml(user.username)}</strong>,</p>
                <p><strong>${escHtml(comment.author || 'Jemand')}</strong> hat einen Kommentar hinterlassen:</p>
                <blockquote>${escHtml(comment.text)}</blockquote>`,
    });
  }
}

// ---------------------------------------------------------------------------
// notifyCardMoved
//   Called when a card is moved to a different column.
//   card        – { id, text }
//   fromColumn  – column title before move (optional)
//   toColumn    – column title after move
//   byUsername  – who moved it
//   assigneeIds – array of user IDs assigned to the card
// ---------------------------------------------------------------------------
async function notifyCardMoved({ card, fromColumn, toColumn, byUsername, assigneeIds }) {
  for (const userId of assigneeIds) {
    if (!isEnabled(userId, 'card_moved')) continue;
    const user = db.getUserById(userId);
    if (!user || !user.email) continue;

    const from = fromColumn ? `von "${fromColumn}" ` : '';
    await sendEmail({
      to:      user.email,
      subject: `Karte verschoben: "${card.text}"`,
      text:    `Hallo ${user.username},\n\n${byUsername || 'Jemand'} hat die Karte "${card.text}" ${from}nach "${toColumn}" verschoben.\n`,
      html:    `<p>Hallo <strong>${escHtml(user.username)}</strong>,</p>
                <p><strong>${escHtml(byUsername || 'Jemand')}</strong> hat die Karte <strong>${escHtml(card.text)}</strong> ${escHtml(from)}nach <strong>${escHtml(toColumn)}</strong> verschoben.</p>`,
    });
  }
}

// ---------------------------------------------------------------------------
// notifyDueSoon
//   Called by the periodic reminder job.
//   rows – array of { id, text, due_date, board_id, user_id, username, email }
// ---------------------------------------------------------------------------
async function notifyDueSoon(rows) {
  for (const row of rows) {
    if (!row.email) continue;
    if (!isEnabled(row.user_id, 'card_due_soon')) continue;

    await sendEmail({
      to:      row.email,
      subject: `Erinnerung: Karte "${row.text}" ist bald fällig`,
      text:    `Hallo ${row.username},\n\nDie Karte "${row.text}" ist am ${row.due_date} fällig.\n`,
      html:    `<p>Hallo <strong>${escHtml(row.username)}</strong>,</p>
                <p>Die Karte <strong>${escHtml(row.text)}</strong> ist am <strong>${escHtml(row.due_date)}</strong> fällig.</p>`,
    });
  }
}

// ---------------------------------------------------------------------------
// HTML escaping helper
// ---------------------------------------------------------------------------
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  sendEmail,
  notifyCardAssigned,
  notifyCommentAdded,
  notifyCardMoved,
  notifyDueSoon,
};
