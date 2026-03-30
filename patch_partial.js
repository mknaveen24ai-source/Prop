const fs = require('fs');
let text = fs.readFileSync('frontend/src/components/TradingPanel.js', 'utf8');

const targetStr = '<button\n                                        className="btn btn-red"\n                                        onClick={() => onCloseTrade(trade.id)}\n                                        style={{ padding: \\'5px 10px\\', fontSize: \\'11px\\' }}>\n                                        Close\n                                      </button>';

const replacementStr = '<button\n                                        className="btn"\n                                        onClick={() => setPartialForm({ id: trade.id, lots: parseFloat(trade.lot_size).toFixed(2) })}\n                                        style={{ padding: \\'5px 10px\\', fontSize: \\'11px\\', background: \\'var(--navy-border)\\', color: \\'var(--text-muted)\\' }}>\n                                        Partial\n                                      </button>\n                                      <button\n                                        className="btn btn-red"\n                                        onClick={() => onCloseTrade(trade.id)}\n                                        style={{ padding: \\'5px 10px\\', fontSize: \\'11px\\' }}>\n                                        Close\n                                      </button>';

if (text.includes(targetStr)) {
  text = text.replace(targetStr, replacementStr);
  fs.writeFileSync('frontend/src/components/TradingPanel.js', text);
  console.log('Successfully applied Partial Close button patch.');
} else {
  console.log('Failed to find target string in TradingPanel.js');
}
