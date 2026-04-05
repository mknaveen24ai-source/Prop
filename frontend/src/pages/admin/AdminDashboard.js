import React, { useState, useEffect } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { LineChart, Line, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import AdminStatCard from '../../components/admin/AdminStatCard';
import AdminChart, { chartThemeProps } from '../../components/admin/AdminChart';

// Mock data for initial graphs until hooked to backend routes completely
const signupData = Array.from({length: 30}).map((_, i) => ({
  date: `Day ${i+1}`, signups: Math.floor(Math.random()*20)+5, challenges: Math.floor(Math.random()*15)+2
}));
const statusData = [
  { name: 'Active', value: 400, color: 'var(--admin-info)' },
  { name: 'Passed', value: 85, color: 'var(--admin-success)' },
  { name: 'Failed', value: 210, color: 'var(--admin-danger)' },
  { name: 'Funded', value: 42, color: 'var(--admin-gold)' },
  { name: 'Expired', value: 60, color: 'var(--admin-text-faint)' }
];
const revenueData = [
  { month: 'Jan', rev: 12000 }, { month: 'Feb', rev: 19000 }, { month: 'Mar', rev: 15000 },
  { month: 'Apr', rev: 22000 }, { month: 'May', rev: 25000 }, { month: 'Jun', rev: 28000 }
];
const funnelData = [
  { phase: 'Phase 1', count: 1200 },
  { phase: 'Phase 2', count: 480 },
  { phase: 'Funded', count: 120 }
];

export default function AdminDashboard() {
  const { adminAxios } = useOutletContext();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    users: 0, active_challenges: 0, funded: 0,
    total_payouts: 0, pnl: 0, pending: 0
  });
  const [quickCounts, setQuickCounts] = useState({
    kyc: 0, payouts: 0, disputes: 0, chats: 0
  });

  const [feed, setFeed] = useState([
    { id: 1, type: 'signup', text: 'New user registered', trader: 'John Doe', time: 'Just now', color: 'var(--admin-accent)' },
    { id: 2, type: 'purchase', text: 'Purchased 100k Challenge', trader: 'Alex M', time: '5m ago', color: 'var(--admin-info)' },
    { id: 3, type: 'pass', text: 'Passed Phase 1', trader: 'Sarah J', time: '12m ago', color: 'var(--admin-success)' },
    { id: 4, type: 'fail', text: 'Violated Max Drawdown', trader: 'Mike T', time: '1h ago', color: 'var(--admin-danger)' },
    { id: 5, type: 'payout', text: 'Requested $4,200 payout', trader: 'Emma W', time: '2h ago', color: 'var(--admin-gold)' }
  ]);

  useEffect(() => {
    adminAxios.get('/api/admin/overview').then(res => {
      const d = res.data || {};
      setStats({
        users: d.total_users || 1284,
        active_challenges: d.active_challenges || 432,
        funded: d.funded_accounts || 112,
        total_payouts: d.total_payouts_sum || 425000,
        pnl: d.net_pnl || 1250000,
        pending: d.pending_kyc || 5
      });
      setQuickCounts({
        kyc: d.pending_kyc || 3,
        payouts: d.pending_payouts || 1,
        disputes: d.open_disputes || 2,
        chats: 0
      });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [adminAxios]);

  if (loading) return <div className="admin-skeleton" style={{ height: '400px' }}></div>;

  return (
    <div style={{ paddingBottom: '40px' }}>
      <h1 className="admin-h1">Dashboard Overview</h1>
      
      {/* Top KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '24px' }}>
        <AdminStatCard icon="👥" label="Total Users" value={stats.users.toLocaleString()} trend="+12%" trendDirection="up" onClick={() => navigate('/admin/users')} />
        <AdminStatCard icon="🏆" label="Active Challenges" value={stats.active_challenges.toLocaleString()} trend="+4%" trendDirection="up" onClick={() => navigate('/admin/challenges')} />
        <AdminStatCard icon="💎" label="Funded Traders" value={stats.funded.toLocaleString()} trend="+2%" trendDirection="up" onClick={() => navigate('/admin/funded')} />
        <AdminStatCard icon="💸" label="Total Payouts" value={`$${stats.total_payouts.toLocaleString()}`} trend="-2%" trendDirection="down" onClick={() => navigate('/admin/payouts')} />
        <AdminStatCard icon="📈" label="Platform P&L" value={`$${stats.pnl.toLocaleString()}`} trend="+24%" trendDirection="up" onClick={() => navigate('/admin/pnl')} />
        <AdminStatCard icon="⚡" label="Pending Actions" value={stats.pending} onClick={() => navigate('/admin/kyc')} />
      </div>

      {/* Charts Row 1 */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px', marginBottom: '24px' }}>
        <AdminChart title="New Signups + Challenge Purchases (30D)">
          <LineChart data={signupData}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="date" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
            <Line type="monotone" dataKey="signups" stroke="var(--admin-accent)" strokeWidth={3} dot={false} activeDot={{ r: 6 }} name="Signups" />
            <Line type="monotone" dataKey="challenges" stroke="var(--admin-info)" strokeWidth={3} dot={false} name="Challenges" />
          </LineChart>
        </AdminChart>
        
        <AdminChart title="Account Status">
          <PieChart>
            <Tooltip {...chartThemeProps.tooltip} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Pie data={statusData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={4} dataKey="value" stroke="var(--admin-surface)" strokeWidth={2}>
              {statusData.map((e, i) => <Cell key={`cell-${i}`} fill={e.color} />)}
            </Pie>
          </PieChart>
        </AdminChart>
      </div>

      {/* Charts Row 2 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '32px' }}>
        <AdminChart title="Revenue Over Time (12M)">
          <BarChart data={revenueData}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="month" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `$${v/1000}k`} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(v) => `$${v.toLocaleString()}`} />
            <Bar dataKey="rev" fill="var(--admin-accent)" radius={[4, 4, 0, 0]} name="Revenue" />
          </BarChart>
        </AdminChart>
        
        <AdminChart title="Pass Rate Funnel">
          <BarChart data={funnelData} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="rgba(255,255,255,0.06)" />
            <XAxis type="number" {...chartThemeProps.xAxis} />
            <YAxis dataKey="phase" type="category" {...chartThemeProps.yAxis} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Bar dataKey="count" fill="var(--admin-success)" radius={[0, 4, 4, 0]} barSize={30} />
          </BarChart>
        </AdminChart>
      </div>

      {/* Quick Action Cards */}
      <h2 className="admin-h2" style={{ marginBottom: '16px' }}>Requires Attention</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '32px' }}>
        <ActionCard title="Pending KYC" count={quickCounts.kyc} color="var(--admin-warning)" link="/admin/kyc" navigate={navigate} />
        <ActionCard title="Pending Payouts" count={quickCounts.payouts} color="var(--admin-gold)" link="/admin/payouts" navigate={navigate} />
        <ActionCard title="Open Disputes" count={quickCounts.disputes} color="var(--admin-danger)" link="/admin/disputes" navigate={navigate} />
        <ActionCard title="Unread Chats" count={quickCounts.chats} color="var(--admin-accent)" link="/admin/chat" navigate={navigate} />
      </div>

      {/* Activity Feed */}
      <div className="admin-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--admin-border)' }}>
          <h2 className="admin-h2" style={{ margin: 0 }}>Live Activity Feed</h2>
        </div>
        <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
          {feed.map((item) => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '16px', padding: '16px 24px', borderBottom: '1px solid var(--admin-border)' }} className="admin-feed-item">
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: item.color, marginTop: '5px', flexShrink: 0, boxShadow: `0 0 8px ${item.color}` }}></div>
              <div style={{ flex: 1 }}>
                <div style={{ color: 'var(--admin-text)', fontWeight: 500 }}>{item.text}</div>
                <div style={{ fontSize: '13px', color: 'var(--admin-text-faint)', marginTop: '4px' }}>
                  <span style={{ color: 'var(--admin-text-muted)', cursor: 'pointer' }}>{item.trader}</span> • {item.time}
                </div>
              </div>
            </div>
          ))}
          <button className="admin-btn-ghost" style={{ width: '100%', padding: '12px', borderRadius: 0, border: 'none', color: 'var(--admin-text-muted)' }}>Load more history</button>
        </div>
      </div>

    </div>
  );
}

function ActionCard({ title, count, color, link, navigate }) {
  const isAlert = count > 0;
  return (
    <div 
      className="admin-card" 
      onClick={() => navigate(link)}
      style={{ 
        padding: '16px', marginBottom: 0, cursor: 'pointer',
        border: isAlert ? `1px solid ${color}` : undefined,
        background: isAlert ? `rgba(255,255,255,0.02)` : undefined
      }}
    >
      <div style={{ fontSize: '13px', color: 'var(--admin-text-muted)', marginBottom: '8px' }}>{title}</div>
      <div style={{ fontSize: '24px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700, color: isAlert ? color : 'var(--admin-text)' }}>
        {count}
      </div>
    </div>
  );
}
