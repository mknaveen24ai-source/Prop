with open('backend/routes/trades.js', 'r', encoding='utf-8') as f:
    text = f.read()

target = """  try {
    const { trade_id, note } = req.body

    if (!trade_id) return res.status(400).json({ error: 'trade_id required' })
    if (typeof note !== 'string') return res.status(400).json({ error: 'note must be a string' })
    if (note.length > 1000) return res.status(400).json({ error: 'Note must be 1000 characters or less' })

    // Ensure notes column exists (safe — idempotent)
    try {
      await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS trader_note TEXT`)
    } catch (_) {}

    // Verify trade belongs to this user
    const tradeCheck = await pool.query(
      `SELECT t.id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND a.user_id = $2`,
      [trade_id, req.user.userId]
    )
    if (tradeCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found' })
    }

    await pool.query(
      `UPDATE trades SET trader_note = $1 WHERE id = $2`,
      [note, trade_id]
    )

    res.json({ message: 'Note saved successfully' })"""

replace = """  try {
    const { trade_id, note, tags } = req.body

    if (!trade_id) return res.status(400).json({ error: 'trade_id required' })
    if (typeof note !== 'string') return res.status(400).json({ error: 'note must be a string' })
    if (note.length > 1000) return res.status(400).json({ error: 'Note must be 1000 characters or less' })
    if (tags && typeof tags !== 'string') return res.status(400).json({ error: 'tags must be a comma separated string' })

    try {
      await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS trader_note TEXT`)
    } catch (_) {}

    const tradeCheck = await pool.query(
      `SELECT t.id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND a.user_id = $2`,
      [trade_id, req.user.userId]
    )
    if (tradeCheck.rows.length === 0) return res.status(404).json({ error: 'Trade not found' })

    const tagsJson = tags ? JSON.stringify(tags.split(',').map(t => t.trim()).filter(Boolean)) : null

    await pool.query(
      `UPDATE trades SET trader_note = $1, tags = $2 WHERE id = $3`,
      [note, tagsJson, trade_id]
    )

    res.json({ message: 'Note and tags saved successfully' })"""

norm_target = target.replace('\r\n', '\n')
norm_replace = replace.replace('\r\n', '\n')
norm_text = text.replace('\r\n', '\n')

if norm_target in norm_text:
    res = norm_text.replace(norm_target, norm_replace)
    with open('backend/routes/trades.js', 'w', encoding='utf-8') as f:
        f.write(res)
    print("Backend patched for tags!")
else:
    print("Target not found.")
