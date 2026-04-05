import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminStatCard from '../../components/admin/AdminStatCard';
import AdminBadge from '../../components/admin/AdminBadge';
import { useToast } from '../../components/admin/AdminToast';

export default function AdminLeaderboard() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [traders, setTraders] = useState([]);
  const [visibility, setVisibility] = useState({});
  const [saving, setSaving] = useState(null); // holds trader id being saved

  useEffect(() => {
    fetchLeaderboard();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchLeaderboard = async () => {
    setLoading(true);
    try {
      // Public leaderboard data
      const res = await adminAxios.get('/api/leaderboard').catch(() => ({ data: [] }));
      const data = res.data || [];
      setTraders(data);
      // Pre-populate visibility map
      const map = {};
      data.forEach(t => { map[t.user_id || t.id] = t.visible !== false; });
      setVisibility(map);
    } catch {
      toast.error('Failed to load leaderboard');
    }
    setLoading(false);
  };

  const toggleVisibility = async (traderId, currentVisible) => {
    setSaving(traderId);
    try {
      await adminAxios.post('/api/admin/leaderboard/visibility', {
        userId: traderId,
        visible: !currentVisible
      });
      setVisibility(v => ({ ...v, [traderId]: !currentVisible }));
      toast.success(`Trader ${!currentVisible ? 'shown on' : 'hidden from'} leaderboard`);
    } catch {
      toast.error('Failed to update visibility');
    }
    setSaving(null);
  };

  const columns = [
    {
      header: 'Rank', key: 'rank',
      render: (t, i) => {
        const rank = t.rank || (traders.indexOf(t) + 1);
        return (
          <span style={{
            fontFamily: 'var(--admin-font-mono)',
            fontWeight: 700,
            color: rank === 1 ? 'var(--admin-gold)' : rank === 2 ? '#c0c0c0' : rank === 3 ? '#cd7f32' : 'var(--admin-text)',
            fontSize: rank <= 3 ? '16px' : '14px'
          }}>
            {rank <= 3 ? ['🥇','🥈','🥉'][rank - 1] : `#${rank}`}
          </span>
        );
      }
    },
    {
      header: 'Trader', key: 'username',
      render: t => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div className="admin-avatar" style={{ width: '32px', height: '32px', fontSize: '12px' }}>
            {(t.username || t.email || 'T').charAt(0).toUpperCase()}
          </div>
          <div>
            <div style={{ color: 'var(--admin-text)', fontWeight: 500 }}>{t.username || t.display_name || 'Anonymous'}</div>
            {t.country && <div style={{ fontSize: '11px', color: 'var(--admin-text-faint)' }}>{t.country}</div>}
          </div>
        </div>
      )
    },
    {
      header: 'Profit %', key: 'profit_pct',
      render: t => (
        <span style={{ color: 'var(--admin-success)', fontFamily: 'var(--admin-font-mono)', fontWeight: 700 }}>
          +{parseFloat(t.profit_pct || t.gain || 0).toFixed(2)}%
        </span>
      )
    },
    {
      header: 'Win Rate', key: 'win_rate',
      render: t => `${parseFloat(t.win_rate || 0).toFixed(1)}%`
    },
    {
      header: 'Total Trades', key: 'total_trades',
      render: t => (t.total_trades || 0).toLocaleString()
    },
    {
      header: 'Visible', key: 'visible',
      render: t => {
        const id = t.user_id || t.id;
        const visible = visibility[id] !== false;
        return (
          <button
            className={`admin-btn ${visible ? 'admin-btn-success' : 'admin-btn-ghost'}`}
            style={{ padding: '4px 12px', fontSize: '12px' }}
            disabled={saving === id}
            onClick={() => toggleVisibility(id, visible)}
          >
            {saving === id ? '...' : visible ? '👁 Visible' : '🚫 Hidden'}
          </button>
        );
      }
    },
  ];

  const topTrader = traders[0];

  return (
    <>
      <div style={{ marginBottom: '24px' }}>
        <h1 className="admin-h1">Leaderboard Management</h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>Control which traders appear in the public trading leaderboard.</p>
      </div>

      {!loading && traders.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px', marginBottom: '32px' }}>
          <AdminStatCard icon="🥇" label="Top Performer" value={topTrader?.username || 'N/A'} trendDirection="up" />
          <AdminStatCard icon="📊" label="Leaderboard Entries" value={traders.length.toLocaleString()} />
          <AdminStatCard icon="👁" label="Visible Traders" value={Object.values(visibility).filter(Boolean).length.toLocaleString()} />
        </div>
      )}

      <div className="admin-card" style={{ padding: 0 }}>
        <AdminDataTable
          columns={columns}
          data={traders}
          loading={loading}
          emptyMessage="Leaderboard is empty or data unavailable"
          emptyIcon="🏅"
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
        />
      </div>
    </>
  );
}
