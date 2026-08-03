import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAdminStatusColor } from '../adminStatusTone';

export default function useAdminDashboardData(adminAxios) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [overview, setOverview] = useState(null);

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

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  const accountStatusData = useMemo(() => {
    if (!overview) return [];

    return [
      { name: 'Phase 1', value: overview.accounts?.phase1 || 0, color: getAdminStatusColor('phase 1') },
      { name: 'Phase 2', value: overview.accounts?.phase2 || 0, color: getAdminStatusColor('phase 2') },
      { name: 'Funded', value: overview.accounts?.funded || 0, color: getAdminStatusColor('funded') },
      { name: 'Failed', value: overview.accounts?.failed || 0, color: getAdminStatusColor('failed') },
      { name: 'Passed', value: overview.accounts?.passed || 0, color: getAdminStatusColor('passed') },
      { name: 'Expired', value: overview.accounts?.expired || 0, color: getAdminStatusColor('expired') },
    ].filter((item) => item.value > 0);
  }, [overview]);

  const funnelData = useMemo(() => {
    if (!overview) return [];

    const stages = [
      { phase: 'Phase 1', count: overview.accounts?.phase1 || 0 },
      { phase: 'Phase 2', count: overview.accounts?.phase2 || 0 },
      { phase: 'Funded', count: overview.accounts?.funded || 0 },
    ];
    // Conversion % relative to the first stage (Modern Gazette handoff
    // spec: "horizontal bars sized relative to first stage, conversion %
    // printed per row").
    const firstCount = stages[0]?.count || 0;
    return stages.map((stage) => ({
      ...stage,
      pct: firstCount > 0 ? Math.round((stage.count / firstCount) * 100) : 0,
    }));
  }, [overview]);

  const revenueByMonth = useMemo(() => overview?.revenue_by_month || [], [overview]);
  const kpiTrends = useMemo(() => overview?.kpi_trends || {}, [overview]);
  const attentionQueue = useMemo(() => overview?.attention_queue || [], [overview]);
  const attentionTotal = overview?.attention_total || 0;
  const alerts = useMemo(() => overview?.alerts || [], [overview]);

  return {
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
    retry: fetchOverview,
  };
}
