/**
 * WARNING: This is a one-time migration/debug script.
 * DO NOT run this in production unless explicitly instructed.
 * This script may modify database schema or data irreversibly.
 */

const fs = require('fs');

let code = fs.readFileSync('c:/propfirm/backend/server.js', 'utf8');

const NEW_ROUTES = `
// ── Support Chat Routes ───────────────────────────────────────────────────────────

app.get('/api/support/tickets', authenticateToken, async function(req, res) {
  try {
    const result = await pool.query('SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC', [req.user.userId]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Could not fetch tickets' }); }
});

app.get('/api/support/ticket/:id', authenticateToken, async function(req, res) {
  try {
    const ticketRes = await pool.query('SELECT * FROM support_tickets WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
    if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    const msgsRes = await pool.query('SELECT * FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC', [req.params.id]);
    res.json({ ticket: ticketRes.rows[0], messages: msgsRes.rows });
  } catch (error) { res.status(500).json({ error: 'Could not fetch ticket' }); }
});

app.post('/api/support/ticket/:id/reply', authenticateToken, async function(req, res) {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    
    await pool.query(\`CREATE TABLE IF NOT EXISTS support_ticket_messages (
      id BIGSERIAL PRIMARY KEY, ticket_id BIGINT REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL, sender_name TEXT, message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )\`);

    const ticketRes = await pool.query('SELECT * FROM support_tickets WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
    if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });

    await pool.query(
      'INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_name, message) VALUES ($1, $2, $3, $4)',
      [req.params.id, 'user', req.user.email, message]
    );
    await pool.query('UPDATE support_tickets SET status = $1 WHERE id = $2', ['open', req.params.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Could not reply' }); }
});

app.get('/api/admin/support-tickets/:id', authAdm, async function(req, res) {
  try {
    const msgsRes = await pool.query('SELECT * FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC', [req.params.id]);
    res.json(msgsRes.rows);
  } catch (error) { res.status(500).json({ error: 'Could not fetch messages' }); }
});

app.post('/api/admin/support-tickets/:id/reply', authAdm, async function(req, res) {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    
    await pool.query(\`CREATE TABLE IF NOT EXISTS support_ticket_messages (
      id BIGSERIAL PRIMARY KEY, ticket_id BIGINT REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL, sender_name TEXT, message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )\`);

    await pool.query(
      'INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_name, message) VALUES ($1, $2, $3, $4)',
      [req.params.id, 'admin', 'Support Team', message]
    );
    await pool.query('UPDATE support_tickets SET status = $1 WHERE id = $2', ['answered', req.params.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Could not reply' }); }
});
`;

if (!code.includes('/api/support/tickets')) {
  code = code.replace('app.listen(', NEW_ROUTES + '\napp.listen(');
  fs.writeFileSync('c:/propfirm/backend/server.js', code);
  console.log('Added Support Chat APIs to server.js');
} else {
  console.log('Routes already exist in server.js');
}
