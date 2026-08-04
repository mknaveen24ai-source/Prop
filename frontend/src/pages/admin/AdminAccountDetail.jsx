import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminDataTable from '../../components/admin/AdminDataTable';
import { useToast } from '../../components/admin/AdminToast';
import Card from '../../components/ui/Card';

function formatMoney(value) {
  return `$${parseFloat(value || 0).toFixed(2)}`;
}

function formatAccountType(accountType) {
  if (accountType === 'phase1') return 'Phase 1';
  if (accountType === 'phase2') return 'Phase 2';
  if (accountType === 'funded') return 'Funded';
  return accountType || 'Unknown';
}

function formatLabel(value) {
  return String(value || 'unknown')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function AdminAccountDetail() {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const { adminAxios, socket, session } = useOutletContext();
  const toast = useToast();
  const isSuperAdmin = session?.role === 'super_admin';

  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState(null);
  const [flagMeta, setFlagMeta] = useState(null);
  const [violations, setViolations] = useState([]);
  const [enforcementEvents, setEnforcementEvents] = useState([]);
  const [overrideReason, setOverrideReason] = useState('');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [extendDays, setExtendDays] = useState('14');
  const [submitting, setSubmitting] = useState(false);

  const loadPage = async () => {
    setLoading(true);
    try {
      const [accountsRes, suspiciousRes, violationsRes, eventsRes] = await Promise.all([
        adminAxios.get('/api/admin/accounts'),
        adminAxios.get('/api/admin/suspicious-accounts').catch(() => ({ data: { flagged: [] } })),
        adminAxios.get('/api/admin/violations', { params: { account_id: accountId, limit: 100 } }).catch(() => ({ data: [] })),
        adminAxios.get('/api/admin/enforcement/events').catch(() => ({ data: [] }))
      ]);

      const accounts = Array.isArray(accountsRes.data) ? accountsRes.data : [];
      const foundAccount = accounts.find((row) => String(row.id) === String(accountId));

      if (!foundAccount) {
        setAccount(null);
        toast.error('Account not found');
        return;
      }

      const flaggedRows = suspiciousRes.data?.flagged || [];
      const matchedFlag = flaggedRows.find((row) => String(row.id) === String(accountId)) || null;
      const eventRows = Array.isArray(eventsRes.data) ? eventsRes.data : [];

      setAccount(foundAccount);
      setFlagMeta(matchedFlag);
      setViolations(Array.isArray(violationsRes.data) ? violationsRes.data : []);
      setEnforcementEvents(eventRows.filter((row) => String(row.account_id) === String(accountId)));
    } catch (err) {
      toast.error('Failed to load account details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPage();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => {
    if (!socket) return;

    const handleRealtimeUpdate = (payload) => {
      if (payload?.account_id && String(payload.account_id) !== String(accountId)) return;
      loadPage();
    };

    socket.on('admin_violation_updated', handleRealtimeUpdate);
    socket.on('admin_enforcement_event', handleRealtimeUpdate);
    socket.on('admin_command_center_updated', handleRealtimeUpdate);

    return () => {
      socket.off('admin_violation_updated', handleRealtimeUpdate);
      socket.off('admin_enforcement_event', handleRealtimeUpdate);
      socket.off('admin_command_center_updated', handleRealtimeUpdate);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, accountId]);

  const openViolations = useMemo(() => violations.filter((row) => row.status !== 'resolved'), [violations]);
  const allowedActions = useMemo(
    () => (Array.isArray(account?.allowed_actions) ? account.allowed_actions : []),
    [account]
  );
  const canRunAction = (action) => allowedActions.includes(action);

  const violationColumns = [
    {
      header: 'Type',
      key: 'violation_type',
      render: (row) => (
        <div>
          <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>{formatLabel(row.violation_type)}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>#{row.id}</div>
        </div>
      )
    },
    {
      header: 'Severity',
      key: 'severity',
      render: (row) => (
        <AdminBadge
          status={row.severity === 'critical' ? 'danger' : row.severity === 'high' ? 'warning' : 'info'}
          label={formatLabel(row.severity)}
        />
      )
    },
    {
      header: 'Message',
      key: 'message',
      render: (row) => <div style={{ maxWidth: '420px', color: 'var(--admin-text-muted)' }}>{row.message || 'No detail recorded'}</div>
    },
    {
      header: 'Detected',
      key: 'last_detected_at',
      render: (row) => formatTimestamp(row.last_detected_at)
    },
    {
      header: 'Status',
      key: 'status',
      render: (row) => <AdminBadge status={row.status === 'resolved' ? 'success' : 'danger'} label={formatLabel(row.status)} />
    }
  ];

  const enforcementColumns = [
    {
      header: 'Action',
      key: 'action',
      render: (row) => (
        <div>
          <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>{formatLabel(row.action)}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>#{row.id}</div>
        </div>
      )
    },
    {
      header: 'Status',
      key: 'status',
      render: (row) => <AdminBadge status={row.status === 'applied' ? 'success' : 'danger'} label={formatLabel(row.status)} />
    },
    {
      header: 'Message',
      key: 'message',
      render: (row) => <div style={{ maxWidth: '420px', color: 'var(--admin-text-muted)' }}>{row.message || 'No message recorded'}</div>
    },
    {
      header: 'Created',
      key: 'created_at',
      render: (row) => formatTimestamp(row.created_at)
    }
  ];

  const executeOverride = async (action, extra = {}) => {
    if (!account || submitting) return;
    const reason = overrideReason.trim();
    if (reason.length < 5) {
      toast.error('Enter a clear admin reason before applying this action');
      return;
    }

    if (action === 'extend_days') {
      const days = parseInt(extra.days, 10);
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        toast.error('Enter a valid day count between 1 and 365');
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await adminAxios.post(`/api/admin/accounts/${account.id}/override`, {
        action,
        reason,
        ...extra
      });
      toast.success(res.data?.message || 'Admin action applied');
      setOverrideReason('');
      await loadPage();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to apply admin action');
    } finally {
      setSubmitting(false);
    }
  };

  const applyBalanceAdjustment = async () => {
    if (!account || submitting) return;
    setSubmitting(true);
    try {
      const res = await adminAxios.post(`/api/admin/accounts/${account.id}/adjust-balance`, {
        amount: parseFloat(adjustAmount),
        reason: adjustReason.trim()
      });
      toast.success(res.data?.message || 'Balance adjusted');
      setAdjustAmount('');
      setAdjustReason('');
      await loadPage();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to adjust balance');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'grid', gap: '16px' }}>
        <div className="admin-skeleton" style={{ height: '120px' }} />
        <div className="admin-skeleton" style={{ height: '320px' }} />
      </div>
    );
  }

  if (!account) {
    return (
      <Card>
        <h1 className="admin-h1">Account Detail</h1>
        <p style={{ color: 'var(--admin-text-muted)' }}>The requested account could not be found.</p>
        <button className="admin-btn admin-btn-ghost" onClick={() => navigate('/admin/violations')}>Back To Violations</button>
      </Card>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <div>
          <button className="admin-btn admin-btn-ghost" style={{ marginBottom: '12px' }} onClick={() => navigate('/admin/violations')}>
            ← Back To Violations
          </button>
          <h1 className="admin-h1">Account {account.account_uid || `#${String(account.id).padStart(5, '0')}`}</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
            {formatAccountType(account.account_type)} account for {account.full_name || account.user_email || account.email}
          </p>
        </div>
        <button className="admin-btn admin-btn-ghost" onClick={loadPage} disabled={submitting}>↺ Refresh</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        {[
          { label: 'Status', value: account.status?.toUpperCase() || 'UNKNOWN' },
          { label: 'Balance', value: formatMoney(account.current_balance) },
          { label: 'Peak', value: formatMoney(account.peak_balance) },
          { label: 'Open Violations', value: String(openViolations.length) },
          { label: 'Actions Logged', value: String(enforcementEvents.length) }
        ].map((card) => (
          <Card key={card.label} stat style={{ margin: 0 }}>
            <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>{card.label}</div>
            <div style={{ marginTop: '8px', fontSize: '24px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700 }}>{card.value}</div>
          </Card>
        ))}
      </div>

      <Card style={{ marginBottom: '24px' }}>
        <h2 className="admin-h2" style={{ marginBottom: '16px' }}>Account Snapshot</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Trader</div>
            <div style={{ marginTop: '4px', color: 'var(--admin-text)' }}>{account.full_name || 'Unnamed Trader'}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px' }}>{account.user_email || account.email}</div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>UID</div>
            <div className="admin-td-mono" style={{ marginTop: '4px' }}>{account.account_uid || account.id}</div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Starting Balance</div>
            <div style={{ marginTop: '4px', color: 'var(--admin-text)' }}>{formatMoney(account.starting_balance)}</div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Max Drawdown</div>
            <div style={{ marginTop: '4px', color: 'var(--admin-text)' }}>{parseFloat(account.max_drawdown_pct || 0).toFixed(2)}%</div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Profit Target</div>
            <div style={{ marginTop: '4px', color: 'var(--admin-text)' }}>{formatMoney(account.profit_target)}</div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Created</div>
            <div style={{ marginTop: '4px', color: 'var(--admin-text)' }}>{formatTimestamp(account.created_at)}</div>
          </div>
        </div>

        <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <AdminBadge status={account.status} label={formatLabel(account.status)} />
          <AdminBadge status={account.account_type === 'funded' ? 'gold' : 'info'} label={formatAccountType(account.account_type)} />
          {(flagMeta?.review_flagged || account.review_flagged) && <AdminBadge status="warning" label="Flagged For Review" />}
          {flagMeta?.is_banned && <AdminBadge status="danger" label="User Banned" />}
        </div>

        {(flagMeta?.review_flag_reason || account.review_flag_reason) && (
          <div style={{ marginTop: '16px', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', padding: '14px' }}>
            <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>Review Flag Reason</div>
            <div style={{ color: 'var(--admin-text)' }}>{flagMeta.review_flag_reason || account.review_flag_reason}</div>
          </div>
        )}

        <div style={{ marginTop: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <button
            className="admin-btn admin-btn-ghost"
            onClick={() => navigate(`/admin/trades?account=${account.id}`)}
          >
            View Account Trades
          </button>
          <button
            className="admin-btn admin-btn-ghost"
            onClick={() => navigate(`/admin/users?q=${encodeURIComponent(account.user_email || account.email || account.user_id || '')}`)}
          >
            View Trader
          </button>
          <button
            className="admin-btn admin-btn-ghost"
            onClick={() => navigate(`/admin/violations?account=${account.id}`)}
          >
            View Violations Feed
          </button>
        </div>
      </Card>

      <Card style={{ marginBottom: '24px' }}>
        <h2 className="admin-h2" style={{ marginBottom: '16px' }}>Admin Controls</h2>
        {!isSuperAdmin && (
          <div style={{ marginBottom: '16px', color: 'var(--admin-text-muted)', fontSize: '13px' }}>
            Recovery powers and balance overrides are limited to super-admin accounts.
          </div>
        )}
        {isSuperAdmin && (
          <div style={{ marginBottom: '16px', color: 'var(--admin-text-muted)', fontSize: '13px' }}>
            Every recovery or override action requires an explicit admin reason.
          </div>
        )}
        <div className="admin-form-group">
          <label className="admin-label">Action Reason</label>
          <textarea
            className="admin-textarea"
            rows={3}
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            placeholder="Why are you taking action on this account?"
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px', marginBottom: '20px' }}>
          {isSuperAdmin && canRunAction('force_close_open_trades') && (
            <button className="admin-btn admin-btn-primary" onClick={() => executeOverride('force_close_open_trades')} disabled={submitting}>
              Force Close Open Trades
            </button>
          )}
          {isSuperAdmin && canRunAction('pass') && (
            <>
              <button className="admin-btn admin-btn-success" onClick={() => executeOverride('pass')} disabled={submitting}>
                Force Pass & Promote
              </button>
              <button className="admin-btn admin-btn-danger" onClick={() => executeOverride('fail')} disabled={submitting}>
                Breach Account
              </button>
            </>
          )}
          {isSuperAdmin && canRunAction('revoke_funded') && (
            <button className="admin-btn admin-btn-danger" onClick={() => executeOverride('revoke_funded')} disabled={submitting}>
              Revoke & Lock Funded
            </button>
          )}
          {isSuperAdmin && canRunAction('restore_active') && (
            <button className="admin-btn admin-btn-success" onClick={() => executeOverride('restore_active')} disabled={submitting}>
              Restore Active
            </button>
          )}
          {isSuperAdmin && canRunAction('restore_with_reset') && (
            <button className="admin-btn admin-btn-warning" onClick={() => executeOverride('restore_with_reset')} disabled={submitting}>
              Restore + Reset
            </button>
          )}
          {isSuperAdmin && canRunAction('replace_account') && (
            <button className="admin-btn admin-btn-primary" onClick={() => executeOverride('replace_account')} disabled={submitting}>
              Replace Account
            </button>
          )}
          {isSuperAdmin && canRunAction('lock_account') && (
            <button className="admin-btn admin-btn-danger" onClick={() => executeOverride('lock_account')} disabled={submitting}>
              Lock Account
            </button>
          )}
          {isSuperAdmin && canRunAction('clear_review_flag') && (
            <button className="admin-btn admin-btn-ghost" onClick={() => executeOverride('clear_review_flag')} disabled={submitting}>
              Clear Review Flag
            </button>
          )}
        </div>

        {isSuperAdmin && canRunAction('extend_days') && (
          <div className="admin-form-group" style={{ marginBottom: '20px' }}>
            <label className="admin-label">Extend Challenge Time</label>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <input
                className="admin-input admin-font-mono"
                type="number"
                min="1"
                max="365"
                value={extendDays}
                onChange={(e) => setExtendDays(e.target.value)}
                style={{ maxWidth: '160px' }}
              />
              <button
                className="admin-btn admin-btn-ghost"
                onClick={() => executeOverride('extend_days', { days: parseInt(extendDays, 10) })}
                disabled={submitting || !extendDays}
              >
                Extend Days
              </button>
            </div>
          </div>
        )}

        {isSuperAdmin && (
          <div className="admin-form-group">
            <label className="admin-label">Balance Adjustment</label>
            <div style={{ display: 'grid', gap: '12px' }}>
              <input
                className="admin-input admin-font-mono"
                type="number"
                step="0.01"
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(e.target.value)}
                placeholder="e.g. 250.00 or -100.00"
              />
              <textarea
                className="admin-textarea"
                rows={3}
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="Reason for this balance adjustment"
              />
              <button
                className="admin-btn admin-btn-warning"
                onClick={applyBalanceAdjustment}
                disabled={submitting || !adjustAmount || !adjustReason.trim()}
              >
                Apply Balance Adjustment
              </button>
            </div>
          </div>
        )}
      </Card>

      <Card flush>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--admin-border)' }}>
          <h2 className="admin-h2" style={{ margin: 0 }}>Violations For This Account</h2>
        </div>
        <AdminDataTable
          columns={violationColumns}
          data={violations}
          loading={false}
          emptyMessage="No violations recorded for this account"
          emptyIcon="🧠"
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
        />
      </Card>

      <Card flush style={{ marginTop: '24px' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--admin-border)' }}>
          <h2 className="admin-h2" style={{ margin: 0 }}>Automation Action History</h2>
        </div>
        <AdminDataTable
          columns={enforcementColumns}
          data={enforcementEvents}
          loading={false}
          emptyMessage="No enforcement actions recorded for this account"
          emptyIcon="🧾"
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
        />
      </Card>
    </>
  );
}
