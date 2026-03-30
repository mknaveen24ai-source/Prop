const fs = require('fs');
let txt = fs.readFileSync('backend/routes/admin.js', 'utf8');

// Find the exact segment to replace
const idx = txt.indexOf("AS total_pnl\n      FROM users u");
if (idx < 0) {
  console.log('Marker not found. Showing context around AS total_pnl:');
  const i2 = txt.indexOf('AS total_pnl');
  console.log(JSON.stringify(txt.substring(i2, i2 + 300)));
  process.exit(1);
}

const endMarker = "ORDER BY total_trades DESC\n      LIMIT 200\n    `);";
const endIdx = txt.indexOf(endMarker, idx);
if (endIdx < 0) {
  console.log('End marker not found');
  const subTxt = txt.substring(idx, idx + 400);
  console.log(JSON.stringify(subTxt));
  process.exit(1);
}

const oldBlock = txt.substring(idx, endIdx + endMarker.length);
console.log('Old block length:', oldBlock.length);

const newBlock = `AS total_pnl,
        -- Computed risk_score 0-100: higher score = more suspicious trader
        LEAST(100, (
          20
          + CASE
              WHEN COUNT(t.id) FILTER (WHERE t.status = 'closed') > 0
               AND ROUND(
                    COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::numeric
                    / COUNT(t.id) FILTER (WHERE t.status = 'closed') * 100, 1
                  ) > 70
              THEN 40 ELSE 0
            END
          + CASE
              WHEN COALESCE(ROUND(
                  AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)))
                  FILTER (WHERE t.status = 'closed' AND t.open_time IS NOT NULL AND t.close_time IS NOT NULL)
              , 0), 9999) < 300
               AND COUNT(t.id) FILTER (WHERE t.status = 'closed') > 0
              THEN 20 ELSE 0
            END
          + CASE WHEN COUNT(p.id) FILTER (WHERE p.is_flagged = true) > 0 THEN 20 ELSE 0 END
          + CASE WHEN a.review_flagged THEN 20 ELSE 0 END
        )) AS risk_score
      FROM users u
      JOIN accounts a ON a.user_id = u.id
      LEFT JOIN trades t ON t.account_id = a.id
      LEFT JOIN payouts p ON p.user_id = u.id
      WHERE a.status IN ('active', 'funded')
      GROUP BY u.id, u.full_name, u.email, a.id, a.account_type, a.status, a.review_flagged
      ORDER BY risk_score DESC, total_trades DESC
      LIMIT 200
    \`);`;

const updated = txt.substring(0, idx) + newBlock + txt.substring(endIdx + endMarker.length);
fs.writeFileSync('backend/routes/admin.js', updated, 'utf8');
console.log('PATCHED OK — risk_score computed field added');
