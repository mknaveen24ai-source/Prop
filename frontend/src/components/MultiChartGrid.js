import React, { useState, useEffect, useRef } from 'react'
import { createChart, CandlestickSeries } from 'lightweight-charts'
import axios from 'axios'

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

// Single Pane Component
function ChartPane({ instrument, symbolColor }) {
  const chartContainerRef = useRef()
  const chartRef = useRef(null)
  const seriesRef = useRef(null)

  useEffect(() => {
    if (!chartContainerRef.current) return

    chartRef.current = createChart(chartContainerRef.current, {
      layout: { background: { type: 'solid', color: '#090B0E' }, textColor: '#A3A3A3' },
      grid: { vertLines: { color: 'rgba(255, 255, 255, 0.05)' }, horzLines: { color: 'rgba(255, 255, 255, 0.05)' } },
      crosshair: { mode: 1, vertLine: { width: 1, color: '#A3A3A3', style: 0 }, horzLine: { width: 1, color: '#A3A3A3', style: 0 } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.1)' }
    })

    seriesRef.current = chartRef.current.addSeries(CandlestickSeries, {
      upColor: '#00C899', downColor: '#FF4757', borderVisible: false, wickUpColor: '#00C899', wickDownColor: '#FF4757'
    })

    // Fetch real historical OHLC data from MT5 price feed database
    axios.get(`${API_URL}/api/prices/chart/${instrument}?tf=1`)
      .then(res => {
        if (res.data && res.data.length > 0) {
          seriesRef.current.setData(res.data)
        }
      })
      .catch(err => {
        console.error(`Error fetching chart history for ${instrument}:`, err)
      })

    const handleResize = () => { if (chartRef.current && chartContainerRef.current) chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth, height: chartContainerRef.current.clientHeight }) }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      if (chartRef.current) chartRef.current.remove()
    }
  }, [instrument])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 5, color: symbolColor, display: 'flex', gap: '8px', alignItems: 'center', background: 'rgba(9, 11, 14, 0.8)', padding: '4px 8px', borderRadius: '4px' }}>
        <span style={{ fontWeight: 'bold' }}>{instrument}</span>
        <span style={{ fontSize: '11px', color: '#A3A3A3' }}>1M</span>
      </div>
      <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}

export default function MultiChartGrid({ selectedInstrument }) {
  const [layoutSpec, setLayoutSpec] = useState(1) // 1, 2, or 4
  const [symbols, setSymbols] = useState([selectedInstrument, 'XAUUSD', 'GBPUSD', 'US30'])

  useEffect(() => {
    setSymbols(prev => {
      const nw = [...prev]
      nw[0] = selectedInstrument
      return nw
    })
  }, [selectedInstrument])

  const gridStyle = {
    display: 'grid',
    gap: '4px',
    width: '100%',
    height: '100%',
    gridTemplateColumns: layoutSpec === 1 ? '1fr' : layoutSpec === 2 ? '1fr 1fr' : '1fr 1fr',
    gridTemplateRows: layoutSpec === 4 ? '1fr 1fr' : '1fr',
  }

  const colors = ['#00E5FF', '#FF00E5', '#00FF00', '#FFEA00']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#090B0E', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--navy-border)' }}>
      <div style={{ display: 'flex', background: 'rgba(255,255,255,0.02)', padding: '6px 12px', gap: '8px', alignItems: 'center' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Layouts:</div>
        <button onClick={() => setLayoutSpec(1)} style={{ background: layoutSpec===1?'var(--accent)':'transparent', border: '1px solid var(--navy-border)', borderRadius: '4px', padding: '2px 8px', color: layoutSpec===1?'#000':'var(--text)' }}>1</button>
        <button onClick={() => setLayoutSpec(2)} style={{ background: layoutSpec===2?'var(--accent)':'transparent', border: '1px solid var(--navy-border)', borderRadius: '4px', padding: '2px 8px', color: layoutSpec===2?'#000':'var(--text)' }}>2</button>
        <button onClick={() => setLayoutSpec(4)} style={{ background: layoutSpec===4?'var(--accent)':'transparent', border: '1px solid var(--navy-border)', borderRadius: '4px', padding: '2px 8px', color: layoutSpec===4?'#000':'var(--text)' }}>4</button>
      </div>
      <div style={{ flex: 1, padding: '4px' }}>
        <div style={gridStyle}>
          {Array.from({ length: layoutSpec }).map((_, i) => (
            <div key={i} style={{ border: '1px solid rgba(255,255,255,0.05)', position: 'relative' }}>
              <ChartPane instrument={symbols[i]} symbolColor={colors[i]} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
