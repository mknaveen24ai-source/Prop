import re

with open('frontend/src/components/TradingPanel.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Add noteSaved, setNoteSaved, noteTags, setNoteTags to state
target1 = r"const \[noteText, setNoteText\]           = useState\(''\)\n  const \[noteSaved, setNoteSaved\]         = useState\(false\)"
replace1 = """const [noteText, setNoteText]           = useState('')
  const [noteTags, setNoteTags]           = useState('')
  const [noteSaved, setNoteSaved]         = useState(false)"""

target2 = r"setNoteText\(trade.trader_note \|\| ''\)\n                                      setNoteSaved\(false\)"
replace2 = """setNoteText(trade.trader_note || '')
                                      setNoteTags(trade.tags ? (typeof trade.tags === 'string' ? trade.tags : JSON.stringify(trade.tags)) : '')
                                      setNoteSaved(false)"""

target3 = r"await axios.patch\(`\$\{API_URL\}/api/trades/note`, \{ trade_id: tradeId, note: noteText \}\)"
replace3 = """await axios.patch(`${API_URL}/api/trades/note`, { trade_id: tradeId, note: noteText, tags: noteTags })"""

target4 = r"<textarea\n                                      value=\{noteText\}"
replace4 = """<input type="text" placeholder="Tags (comma separated, e.g. A+ Setup, Revenge)" value={noteTags} onChange={e => { setNoteTags(e.target.value); setNoteSaved(false) }} style={{ width: '100%', fontSize: '13px', background: 'var(--navy)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 12px', color: 'var(--accent)', fontFamily: 'DM Sans, sans-serif', marginBottom: '8px' }} />
                                    <textarea
                                      value={noteText}"""

new_text = re.sub(target1, replace1, text)
new_text = re.sub(target2, replace2, new_text)
new_text = re.sub(target3, replace3, new_text)
new_text = re.sub(target4, replace4, new_text)

with open('frontend/src/components/TradingPanel.js', 'w', encoding='utf-8') as f:
    f.write(new_text)

print('Tags injected successfully.')
