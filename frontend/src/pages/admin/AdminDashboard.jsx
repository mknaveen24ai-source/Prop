import React, { useRef, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { PageWrapper } from '../../App';
import useAdminDashboardData from '../../components/admin/dashboard/useAdminDashboardData';
import {
  AdminDashboardAlerts,
  AdminDashboardAttention,
  AdminDashboardCharts,
  AdminDashboardExposureTable,
  AdminDashboardStats,
} from '../../components/admin/dashboard/AdminDashboardSections';
import {
  ErrorBanner,
  StatsSkeleton,
} from '../../components/admin/dashboard/AdminDashboardFeedback';

// Draggable block order (Modern Gazette handoff spec, same native-HTML5-DnD
// pattern as the trader Dashboard's blockOrder — see DashboardHome.jsx):
// the 3 big sections below the fixed KPI strip are the draggable units.
const BLOCK_KEYS = ['revenue', 'pipeline', 'exposure'];

export default function AdminDashboard() {
  const { adminAxios } = useOutletContext();
  const navigate = useNavigate();
  const {
    loading,
    error,
    overview,
    accountStatusData,
    funnelData,
    revenueByMonth,
    kpiTrends,
    attentionQueue,
    attentionTotal,
    alerts,
    retry,
  } = useAdminDashboardData(adminAxios);

  const [blockOrder, setBlockOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('admin-dashboard-block-order'));
      if (saved && BLOCK_KEYS.every((k) => typeof saved[k] === 'number')) return saved;
    } catch { /* ignore malformed value */ }
    return { revenue: 1, pipeline: 2, exposure: 3 };
  });
  const dragBlockRef = useRef(null);
  const handleBlockDragStart = (key) => () => { dragBlockRef.current = key; };
  const handleBlockDrop = (key) => () => {
    const from = dragBlockRef.current;
    dragBlockRef.current = null;
    if (!from || from === key) return;
    setBlockOrder((prev) => {
      const next = { ...prev, [from]: prev[key], [key]: prev[from] };
      try { localStorage.setItem('admin-dashboard-block-order', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const totalActiveAccounts = (overview?.accounts?.phase1 || 0) + (overview?.accounts?.phase2 || 0) + (overview?.accounts?.funded || 0);

  return (
    <PageWrapper>
      <div style={{ paddingBottom: 'var(--space-8)', display: 'flex', flexDirection: 'column' }}>
        <h1 className="admin-h1">Command Center</h1>

        {error && <ErrorBanner message={error} onRetry={retry} />}

        <AdminDashboardAlerts loading={loading} error={error} alerts={alerts} navigate={navigate} />

        {loading ? (
          <StatsSkeleton />
        ) : (
          <AdminDashboardStats
            loading={loading}
            error={error}
            overview={overview}
            kpiTrends={kpiTrends}
            navigate={navigate}
          />
        )}

        <div
          draggable onDragStart={handleBlockDragStart('revenue')} onDragOver={(e) => e.preventDefault()} onDrop={handleBlockDrop('revenue')}
          style={{ order: blockOrder.revenue, cursor: 'grab' }}
        >
          <AdminDashboardCharts
            loading={loading}
            error={error}
            overview={overview}
            revenueByMonth={revenueByMonth}
            accountStatusData={accountStatusData}
          />
        </div>

        <div
          draggable onDragStart={handleBlockDragStart('pipeline')} onDragOver={(e) => e.preventDefault()} onDrop={handleBlockDrop('pipeline')}
          style={{ order: blockOrder.pipeline, cursor: 'grab' }}
        >
          <AdminDashboardAttention
            loading={loading}
            error={error}
            overview={overview}
            funnelData={funnelData}
            attentionQueue={attentionQueue}
            attentionTotal={attentionTotal}
            navigate={navigate}
          />
        </div>

        <div
          draggable onDragStart={handleBlockDragStart('exposure')} onDragOver={(e) => e.preventDefault()} onDrop={handleBlockDrop('exposure')}
          style={{ order: blockOrder.exposure, cursor: 'grab' }}
        >
          <AdminDashboardExposureTable
            loading={loading}
            error={error}
            exposure={overview?.exposure || []}
            totalActiveAccounts={totalActiveAccounts}
          />
        </div>
      </div>
    </PageWrapper>
  );
}
