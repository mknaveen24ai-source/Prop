import React from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { PageWrapper } from '../../App';
import useAdminDashboardData from '../../components/admin/dashboard/useAdminDashboardData';
import {
  AdminDashboardAttention,
  AdminDashboardCharts,
  AdminDashboardExposureTable,
  AdminDashboardStats,
} from '../../components/admin/dashboard/AdminDashboardSections';
import {
  ErrorBanner,
  StatsSkeleton,
} from '../../components/admin/dashboard/AdminDashboardFeedback';

export default function AdminDashboard() {
  const { adminAxios } = useOutletContext();
  const navigate = useNavigate();
  const {
    loading,
    trendsLoading,
    error,
    overview,
    signupTrend,
    accountStatusData,
    funnelData,
    quickCounts,
    retry,
  } = useAdminDashboardData(adminAxios);

  return (
    <PageWrapper>
      <div style={{ paddingBottom: '40px' }}>
        <h1 className="admin-h1">Dashboard Overview</h1>

      {error && <ErrorBanner message={error} onRetry={retry} />}

      {loading ? (
        <StatsSkeleton />
      ) : (
        <AdminDashboardStats
          loading={loading}
          error={error}
          overview={overview}
          navigate={navigate}
        />
      )}

      <AdminDashboardCharts
        loading={loading}
        trendsLoading={trendsLoading}
        error={error}
        overview={overview}
        signupTrend={signupTrend}
        accountStatusData={accountStatusData}
        funnelData={funnelData}
      />

      <AdminDashboardAttention
        loading={loading}
        error={error}
        overview={overview}
        quickCounts={quickCounts}
        navigate={navigate}
      />

        <AdminDashboardExposureTable
          loading={loading}
          error={error}
          exposure={overview?.exposure || []}
        />
      </div>
    </PageWrapper>
  );
}
