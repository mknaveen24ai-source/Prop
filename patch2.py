with open('frontend/src/components/TradingPanel.js', 'r', encoding='utf-8') as f:
    text = f.read()

target = """                                      <button
                                        className="btn btn-red"
                                        onClick={() => onCloseTrade(trade.id)}
                                        style={{ padding: '5px 10px', fontSize: '11px' }}>
                                        Close
                                      </button>"""

replace = """                                      <button
                                        className="btn"
                                        onClick={() => setPartialForm({ id: trade.id, lots: parseFloat(trade.lot_size).toFixed(2) })}
                                        style={{ padding: '5px 10px', fontSize: '11px', background: 'var(--navy-border)', color: 'var(--text-muted)' }}>
                                        Partial
                                      </button>
                                      <button
                                        className="btn btn-red"
                                        onClick={() => onCloseTrade(trade.id)}
                                        style={{ padding: '5px 10px', fontSize: '11px' }}>
                                        Close
                                      </button>"""

# Normalize just in case of CRLF
norm_text = text.replace('\r\n', '\n')
norm_target = target.replace('\r\n', '\n')
norm_replace = replace.replace('\r\n', '\n')

if norm_target in norm_text:
    res = norm_text.replace(norm_target, norm_replace)
    with open('frontend/src/components/TradingPanel.js', 'w', encoding='utf-8') as f:
        f.write(res)
    print("Patch applied to TradingPanel.js successfully!")
else:
    print("Target string not found.")
