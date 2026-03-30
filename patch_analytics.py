with open('frontend/src/pages/Analytics.js', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace("const canvasRef = useRef(null)", "const canvasRef = useRef(null)\n  const [replayIndex, setReplayIndex] = useState(100)")

text = text.replace("const curve = data.analytics.drawdown_curve", "const fullCurve = data.analytics.drawdown_curve\n    const curve = fullCurve.slice(0, Math.max(1, Math.floor(fullCurve.length * (replayIndex / 100))))")

target3 = """<canvas
                ref={canvasRef}
                style={{ width: '100%', height: '220px', display: 'block' }}
              />"""
replace3 = """<canvas
                ref={canvasRef}
                style={{ width: '100%', height: '220px', display: 'block' }}
              />
              <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Equity Replay</span>
                <input type="range" min="1" max="100" value={replayIndex} onChange={e => { setReplayIndex(Number(e.target.value)); drawChart(); }} style={{ flex: 1, accentColor: 'var(--accent)' }} />
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{replayIndex}%</span>
              </div>"""

# Ensure exact spacing matches
norm_target3 = target3.replace('\r\n', '\n')
norm_text = text.replace('\r\n', '\n')
if norm_target3 in norm_text:
    text = norm_text.replace(norm_target3, replace3)
else:
    print("WARNING: target3 not found")

target4 = "{/* Drawdown Table */}"
replace4 = """{/* Profit Heatmap */}
          <div className="card" style={{ marginBottom: '20px' }}>
            <h3 style={{ color: 'var(--accent)', marginBottom: '16px', fontSize: '15px' }}>Profit Heatmap by Time of Day</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(60px, 1fr))', gap: '8px' }}>
              {analytics.heatmap && Object.entries(analytics.heatmap).map(([time, pnl]) => (
                <div key={time} style={{ background: pnl > 0 ? 'rgba(0, 200, 153, 0.15)' : pnl < 0 ? 'rgba(255, 71, 87, 0.15)' : 'var(--navy-card)', padding: '12px', borderRadius: '8px', border: `1px solid ${pnl > 0 ? 'rgba(0, 200, 153, 0.3)' : pnl < 0 ? 'rgba(255, 71, 87, 0.3)' : 'var(--navy-border)'}`, textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>{time}</div>
                  <div style={{ fontSize: '13px', fontWeight: 'bold', color: pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--text-dim)' }}>{pnl >= 0 ? '+' : ''}${pnl}</div>
                </div>
              ))}
            </div>
          </div>
          
          {/* Drawdown Table */}"""

text = text.replace(target4, replace4)

# add `drawChart` dependency in useEffect
text = text.replace("}, [data, drawChart])", "}, [data, drawChart, replayIndex])")
# Update use of drawChart to be aware of replayIndex
text = text.replace("}, [data])", "}, [data, replayIndex])")

with open('frontend/src/pages/Analytics.js', 'w', encoding='utf-8') as f:
    f.write(text)

print('Analytics UI overwritten safely via string replace.')
