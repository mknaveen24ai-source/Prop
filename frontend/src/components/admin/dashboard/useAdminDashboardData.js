import { useCallback, useEffect, useMemo, useState } from 'react';

const STATUS_COLORS = {
  'Phase 1': 'var(--admin-info)',
  'Phase 2': 'var(--admin-accent)',
  Funded: 'var(--admin-gold)',
  Failed: 'var(--admin-danger)',
  Passed: 'var(--admin-success)',
  Expired: 'var(--admin-text-faint)',
};

export default function useAdminDashboardData(adminAxios) {
  const [loading, setLoading] = useState(true);
  const [trendsLoading, setTrendsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [overview, setOverview] = useState(null);
  const [signupTrend, setSignupTrend] = useState([]);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminAxios.get('/api/admin/overview');
      setOverview(res.data);
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'Network error';
      setError(msg);
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [adminAxios]);

  const fetchSignupTrend = useCallback(async () => {
    setTrendsLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/signup-trends?days=30');
      setSignupTrend(res.data || []);
    } catch {
      setSignupTrend([]);
    } finally {
      setTrendsLoading(false);
    }
  }, [adminAxios]);

  useEffect(() => {
    fetchOverview();
    fetchSignupTrend();
  }, [fetchOverview, fetchSignupTrend]);

  const accountStatusData = useMemo(() => {
    if (!overview) return [];

    return [
      { name: 'Phase 1', value: overview.accounts?.phase1 || 0, color: STATUS_COLORS['Phase 1'] },
      { name: 'Phase 2', value: overview.accounts?.phase2 || 0, color: STATUS_COLORS['Phase 2'] },
      { name: 'Funded', value: overview.accounts?.funded || 0, color: STATUS_COLORS.Funded },
      { name: 'Failed', value: overview.accounts?.failed || 0, color: STATUS_COLORS.Failed },
      { name: 'Passed', value: overview.accounts?.passed || 0, color: STATUS_COLORS.Passed },
      { name: 'Expired', value: overview.accounts?.expired || 0, color: STATUS_COLORS.Expired },
    ].filter((item) => item.value > 0);
  }, [overview]);

  const funnelData = useMemo(() => {
    if (!overview) return [];

    return [
      { phase: 'Phase 1', count: overview.accounts?.phase1 || 0 },
      { phase: 'Phase 2', count: overview.accounts?.phase2 || 0 },
      { phase: 'Funded', count: overview.accounts?.funded || 0 },
    ];
  }, [overview]);

  const quickCounts = useMemo(() => ({
    kyc: overview?.users?.pending_kyc || 0,
    payouts: overview?.payouts?.pending || 0,
    flagged: overview?.payouts?.flagged_count || 0,
    banned: overview?.users?.banned || 0,
  }), [overview]);

  return {
    loading,
    trendsLoading,
    error,
    overview,
    signupTrend,
    accountStatusData,
    funnelData,
    quickCounts,
    retry: () => {
      fetchOverview();
      fetchSignupTrend();
    },
  };
}
