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
    html:    `<p>Hallo <strong>${escHtml(user.username)}</strong>,</p>
              <p><strong>${escHtml(byUsername || 'Jemand')}</strong> hat dich der Karte <strong>${escHtml(card.text)}</strong> zugewiesen.</p>`,
  });
}

// ---------------------------------------------------------------------------
// notifyCommentAdded
//   Called when a comment is added to a card.
//   card          – { id, text }
//   comment       – { text, author }
//   notifyUserIds – array of user IDs to notify (assignees + watchers)
// ---------------------------------------------------------------------------
async function notifyCommentAdded({ card, comment, notifyUserIds }) {
  // Fetch full card context once (board, column, priority, due date)
  const cardCtx = db.getCardEmailContext(card.id);
  // Fetch last comments (newest last, excluding the just-added one)
  const allComments = db.getRecentComments(card.id, 6);
  // The newest comment is the one just added; previous ones are the rest
  const prevComments = allComments.slice(0, -1);

  for (const userId of notifyUserIds) {
    if (!isEnabled(userId, 'comment_added')) continue;
    const user = db.getUserById(userId);
    if (!user || !user.email) continue;
    // Don't notify the author of their own comment
    if (user.username === comment.author) continue;

    const html = buildCommentEmail({
      toUsername: user.username,
      comment,
      cardCtx: cardCtx || card,
      prevComments,
    });

    const text = buildCommentEmailText({
      toUsername: user.username,
      comment,
      cardCtx: cardCtx || card,
      prevComments,
    });

    await sendEmail({
      to:      user.email,
      subject: `Neuer Kommentar auf "${(cardCtx || card).text}"`,
      html,
      text,
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
// buildCommentEmail – builds rich HTML email for comment notification
// ---------------------------------------------------------------------------
function buildCommentEmail({ toUsername, comment, cardCtx, prevComments }) {
  const priorityLabel = { high: '🔴 Hoch', medium: '🟡 Mittel', low: '🟢 Niedrig' };
  const priority = cardCtx.priority ? (priorityLabel[cardCtx.priority] || cardCtx.priority) : null;

  const metaRows = [];
  if (cardCtx.board_title) metaRows.push(`<tr><td style="color:#64748b;padding:3px 12px 3px 0;white-space:nowrap;">Board</td><td><strong>${escHtml(cardCtx.board_title)}</strong></td></tr>`);
  if (cardCtx.column_title) metaRows.push(`<tr><td style="color:#64748b;padding:3px 12px 3px 0;white-space:nowrap;">Spalte</td><td><strong>${escHtml(cardCtx.column_title)}</strong></td></tr>`);
  if (priority) metaRows.push(`<tr><td style="color:#64748b;padding:3px 12px 3px 0;white-space:nowrap;">Priorität</td><td>${escHtml(priority)}</td></tr>`);
  if (cardCtx.due_date) metaRows.push(`<tr><td style="color:#64748b;padding:3px 12px 3px 0;white-space:nowrap;">Fällig am</td><td>${escHtml(cardCtx.due_date)}</td></tr>`);

  const metaTable = metaRows.length
    ? `<table style="border-collapse:collapse;margin-bottom:16px;font-size:13px;">${metaRows.join('')}</table>`
    : '';

  const descriptionBlock = (cardCtx.description && cardCtx.description.trim())
    ? `<div style="background:#f8fafc;border-left:3px solid #cbd5e1;padding:8px 12px;margin-bottom:16px;font-size:13px;color:#475569;">${escHtml(cardCtx.description).replace(/\n/g, '<br>')}</div>`
    : '';

  let prevBlock = '';
  if (prevComments && prevComments.length > 0) {
    const items = prevComments.map(c =>
      `<div style="padding:8px 0;border-bottom:1px solid #f1f5f9;">
        <span style="font-weight:600;font-size:12px;color:#475569;">${escHtml(c.author || 'Unbekannt')}</span>
        <span style="font-size:11px;color:#94a3b8;margin-left:8px;">${escHtml(c.created_at || '')}</span>
        <div style="margin-top:4px;font-size:13px;color:#374151;">${escHtml(c.text).replace(/\n/g, '<br>')}</div>
      </div>`
    ).join('');
    prevBlock = `
      <div style="margin-top:24px;">
        <h3 style="font-size:13px;color:#64748b;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:.05em;">Vorherige Kommentare</h3>
        <div style="font-size:13px;">${items}</div>
      </div>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;margin:0;padding:24px;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1);">

    <!-- Header -->
    <div style="background:#2563eb;padding:20px 24px;">
      <span style="color:#fff;font-size:18px;font-weight:700;">📋 Kanban</span>
    </div>

    <div style="padding:24px;">
      <p style="margin:0 0 4px 0;color:#64748b;font-size:13px;">Hallo <strong>${escHtml(toUsername)}</strong>,</p>
      <p style="margin:0 0 20px 0;font-size:14px;color:#374151;">
        <strong>${escHtml(comment.author || 'Jemand')}</strong> hat einen neuen Kommentar auf der Karte hinterlassen:
      </p>

      <!-- Card title -->
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px 16px;margin-bottom:16px;">
        <span style="font-size:15px;font-weight:600;color:#1e40af;">${escHtml(cardCtx.text)}</span>
      </div>

      ${metaTable}
      ${descriptionBlock}

      <!-- New comment -->
      <div style="margin-bottom:8px;">
        <h3 style="font-size:13px;color:#64748b;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:.05em;">Neuer Kommentar</h3>
        <div style="background:#f0fdf4;border-left:3px solid #22c55e;border-radius:0 4px 4px 0;padding:12px 16px;font-size:14px;color:#15803d;">
          <strong>${escHtml(comment.author || 'Jemand')}</strong>
          <div style="margin-top:6px;color:#374151;">${escHtml(comment.text).replace(/\n/g, '<br>')}</div>
        </div>
      </div>

      ${prevBlock}
    </div>

    <div style="background:#f8fafc;padding:12px 24px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">
      Diese Nachricht wurde automatisch von Ihrem Kanban-System versandt.
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// buildCommentEmailText – plain-text fallback
// ---------------------------------------------------------------------------
function buildCommentEmailText({ toUsername, comment, cardCtx, prevComments }) {
  const lines = [
    `Hallo ${toUsername},`,
    '',
    `${comment.author || 'Jemand'} hat einen neuen Kommentar auf der Karte hinterlassen:`,
    '',
    `Karte:   ${cardCtx.text}`,
  ];
  if (cardCtx.board_title) lines.push(`Board:   ${cardCtx.board_title}`);
  if (cardCtx.column_title) lines.push(`Spalte:  ${cardCtx.column_title}`);
  if (cardCtx.priority) lines.push(`Priorität: ${cardCtx.priority}`);
  if (cardCtx.due_date) lines.push(`Fällig:  ${cardCtx.due_date}`);
  if (cardCtx.description && cardCtx.description.trim()) {
    lines.push('', 'Beschreibung:', cardCtx.description.trim());
  }
  lines.push('', '--- Neuer Kommentar ---', `${comment.author || 'Jemand'}:`, comment.text);

  if (prevComments && prevComments.length > 0) {
    lines.push('', '--- Vorherige Kommentare ---');
    for (const c of prevComments) {
      lines.push(`${c.author || 'Unbekannt'} (${c.created_at || ''}):`);
      lines.push(c.text);
      lines.push('');
    }
  }

  return lines.join('\n');
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
