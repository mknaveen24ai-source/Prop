import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminEntityDrawer from '../../components/admin/AdminEntityDrawer';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminModal from '../../components/admin/AdminModal';
import AdminStatCard from '../../components/admin/AdminStatCard';
import AdminStatGrid from '../../components/admin/AdminStatGrid';
import { useToast } from '../../components/admin/AdminToast';
import Card from '../../components/ui/Card';
import { exportAdminResource } from '../../utils/adminList';

const TABS = [
  { key: 'accounts', label: 'Account Recovery Queue' },
  { key: 'users', label: 'Trader Control Queue' },
  { key: 'money', label: 'Money And Risk Queue' }
];

const DEFAULT_ACTION_FORM = {
  reason: '',
  days: '14',
  accountType: 'phase1',
  accountSize: '10000',
  transactionId: ''
};

const DEFAULT_QUEUE_FILTERS = {
  accounts: { status: 'All', accountType: 'All', reviewFlagged: 'All' },
  users: { isBanned: 'All', kycStatus: 'All', hasActiveAccounts: 'All' },
  money: { payoutStatus: 'All', isFlagged: 'All', openDisputes: 'All', criticalViolations: 'All' }
};

const BULK_ACTION_ORDER = {
  accounts: ['restore_active', 'restore_with_reset', 'replace_account', 'lock_account', 'clear_review_flag', 'extend_days', 'force_close_open_trades', 'revoke_funded'],
  users: ['ban', 'unban', 'revoke_sessions', 'approve_kyc', 'reject_kyc', 'manual_account'],
  money: ['flag_payout', 'unflag_payout', 'approve_payout', 'reject_payout', 'waive_violation']
};

const VIEW_RESOURCE_BY_TAB = {
  accounts: 'command-center-accounts',
  users: 'command-center-users',
  money: 'command-center-money'
};

const EXPORT_RESOURCE_BY_TAB = {
  accounts: 'accounts',
  users: 'traders',
  money: 'payouts'
};

const DEFAULT_VISIBLE_COLUMNS = {
  accounts: ['id', 'email', 'status', 'account_type', 'current_balance', 'review_flagged', 'created_at'],
  users: ['email', 'kyc_status', 'is_banned', 'account_count', 'created_at'],
  money: ['id', 'email', 'amount_requested', 'status', 'risk', 'requested_at']
};

function formatMoney(value) {
  return `$${(parseFloat(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatLabel(value) {
  return String(value || 'unknown')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function mapAccountActionLabel(action) {
  const labels = {
    restore_active: 'Restore Active',
    restore_with_reset: 'Restore + Reset',
    replace_account: 'Replace Account',
    lock_account: 'Lock Account',
    clear_review_flag: 'Clear Review Flag',
    extend_days: 'Extend Days',
    force_close_open_trades: 'Force Close Trades',
    open_account_detail: 'Open Account Detail',
    pass: 'Force Pass',
    fail: 'Breach Account',
    revoke_funded: 'Revoke Funded'
  };
  return labels[action] || formatLabel(action);
}

function mapUserActionLabel(action) {
  const labels = {
    ban: 'Ban Trader',
    unban: 'Unban Trader',
    revoke_sessions: 'Revoke Sessions',
    approve_kyc: 'Approve KYC',
    reject_kyc: 'Reject KYC',
    manual_account: 'Manual Account',
    open_user_detail: 'Open User Detail'
  };
  return labels[action] || formatLabel(action);
}

function mapMoneyActionLabel(action) {
  const labels = {
    flag_payout: 'Flag Payout',
    unflag_payout: 'Unflag Payout',
    approve_payout: 'Approve Payout',
    reject_payout: 'Reject Payout',
    waive_violation: 'Waive Violation',
    open_account_detail: 'Open Account',
    open_dispute: 'Open Dispute'
  };
  return labels[action] || formatLabel(action);
}

function mapActionLabel(tab, action) {
  if (tab === 'accounts') return mapAccountActionLabel(action);
  if (tab === 'users') return mapUserActionLabel(action);
  return mapMoneyActionLabel(action);
}

function needsDays(action) {
  return action === 'extend_days';
}

function needsManualAccount(action) {
  return action === 'manual_account';
}

function supportsTransactionId(tab, action) {
  return tab === 'money' && action === 'approve_payout';
}

function buildActionPlaceholder({ tab, action, rows }) {
  if (!rows || rows.length === 0) return `Why are you running ${mapActionLabel(tab, action)}?`;
  if (rows.length === 1) {
    const row = rows[0];
    if (tab === 'accounts') return `Explain why ${mapActionLabel(tab, action)} is needed for account #${row.id}.`;
    if (tab === 'users') return `Explain why ${mapActionLabel(tab, action)} is needed for ${row.email || `user #${row.id}`}.`;
    return `Explain why ${mapActionLabel(tab, action)} is needed for payout #${row.id}.`;
  }
  return `Explain why ${mapActionLabel(tab, action)} should be applied to these ${rows.length} records.`;
}

function getBulkEligibleActions(tab, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const orderedActions = BULK_ACTION_ORDER[tab] || [];
  const allowedSets = rows.map((row) => new Set(
    (Array.isArray(row.allowed_actions) ? row.allowed_actions : [])
      .filter((action) => orderedActions.includes(action))
  ));
  return orderedActions.filter((action) => allowedSets.every((set) => set.has(action)));
}

function buildViewConfig({ activeTab, search, filters, density, visibleColumnKeys }) {
  return {
    activeTab,
    search,
    filters,
    density,
    columns: visibleColumnKeys
  };
}

export default function AdminCommandCenter() {
  const { adminAxios, session, socket } = useOutletContext();
  const navigate = useNavigate();
  const toast = useToast();

  const [activeTab, setActiveTab] = useState('accounts');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [summary, setSummary] = useState({});
  const [rows, setRows] = useState([]);
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [actionContext, setActionContext] = useState(null);
  const [actionForm, setActionForm] = useState(DEFAULT_ACTION_FORM);
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(DEFAULT_VISIBLE_COLUMNS.accounts);
  const [drawerRow, setDrawerRow] = useState(null);
  const [filters, setFilters] = useState(DEFAULT_QUEUE_FILTERS);

  const isSuperAdmin = session?.role === 'super_admin';

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.includes(String(row.id))),
    [rows, selectedIds]
  );

  const availableBulkActions = useMemo(
    () => getBulkEligibleActions(activeTab, selectedRows),
    [activeTab, selectedRows]
  );

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', {
        params: { resource: VIEW_RESOURCE_BY_TAB[activeTab] }
      });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  const loadQueue = async ({ silent = false } = {}) => {
    if (!isSuperAdmin) return;
    if (!silent) setLoading(true);

    try {
      const params = { limit: 200 };
      if (search.trim()) params.search = search.trim();

      if (activeTab === 'accounts') {
        const current = filters.accounts;
        if (current.status !== 'All') params.status = current.status;
        if (current.accountType !== 'All') params.account_type = current.accountType;
        if (current.reviewFlagged !== 'All') params.review_flagged = current.reviewFlagged === 'Flagged';
      } else if (activeTab === 'users') {
        const current = filters.users;
        if (current.isBanned !== 'All') params.is_banned = current.isBanned === 'Banned';
        if (current.kycStatus !== 'All') params.kyc_status = current.kycStatus.toLowerCase();
        if (current.hasActiveAccounts !== 'All') params.has_active_accounts = current.hasActiveAccounts === 'Has Active';
      } else {
        const current = filters.money;
        if (current.payoutStatus !== 'All') params.payout_status = current.payoutStatus.toLowerCase();
        if (current.isFlagged !== 'All') params.is_flagged = current.isFlagged === 'Flagged';
        if (current.openDisputes !== 'All') params.open_disputes = current.openDisputes === 'Open Disputes';
        if (current.criticalViolations !== 'All') params.critical_violations = current.criticalViolations === 'Critical Violations';
      }

      const endpoint = activeTab === 'accounts'
        ? '/api/admin/command-center/accounts'
        : activeTab === 'users'
          ? '/api/admin/command-center/users'
          : '/api/admin/command-center/money-risk';

      const res = await adminAxios.get(endpoint, { params });
      setSummary(res.data?.summary || {});
      setRows(Array.isArray(res.data?.rows) ? res.data.rows : []);
      setSelectedIds([]);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load command center');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    loadQueue();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    fetchViews();
    setActiveViewId('');
    setVisibleColumnKeys(DEFAULT_VISIBLE_COLUMNS[activeTab] || []);
    setDrawerRow(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    loadQueue({ silent: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters]);

  useEffect(() => {
    if (!socket || !isSuperAdmin) return undefined;
    const refresh = () => loadQueue({ silent: true });
    socket.on('admin_command_center_updated', refresh);
    socket.on('admin_enforcement_event', refresh);
    socket.on('admin_violation_updated', refresh);

    return () => {
      socket.off('admin_command_center_updated', refresh);
      socket.off('admin_enforcement_event', refresh);
      socket.off('admin_violation_updated', refresh);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, activeTab, isSuperAdmin, search, filters]);

  const toggleRowSelection = (rowId) => {
    setSelectedIds((current) => (
      current.includes(String(rowId))
        ? current.filter((id) => id !== String(rowId))
        : [...current, String(rowId)]
    ));
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === rows.length) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(rows.map((row) => String(row.id)));
  };

  const toggleColumn = (columnKey) => {
    setVisibleColumnKeys((current) => (
      current.includes(columnKey)
        ? current.filter((key) => key !== columnKey)
        : [...current, columnKey]
    ));
  };

  const saveView = async () => {
    const defaultName = activeTab === 'accounts'
      ? 'Account Recovery Queue'
      : activeTab === 'users'
        ? 'Trader Control Queue'
        : 'Money And Risk Queue';
    const name = window.prompt('Name this command center view', defaultName);
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: VIEW_RESOURCE_BY_TAB[activeTab],
        name,
        config: buildViewConfig({ activeTab, search, filters, density, visibleColumnKeys })
      });
      toast.success('Saved view created');
      fetchViews();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not save view');
    }
  };

  const updateView = async (view) => {
    try {
      await adminAxios.patch(`/api/admin/saved-views/${view.id}`, {
        config: buildViewConfig({ activeTab, search, filters, density, visibleColumnKeys })
      });
      toast.success('Saved view updated');
      fetchViews();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not update view');
    }
  };

  const deleteView = async (view) => {
    if (!window.confirm(`Delete saved view "${view.name}"?`)) return;
    try {
      await adminAxios.delete(`/api/admin/saved-views/${view.id}`);
      setActiveViewId('');
      toast.success('Saved view deleted');
      fetchViews();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not delete view');
    }
  };

  const selectView = (viewId) => {
    setActiveViewId(viewId);
    if (!viewId) {
      setSearch('');
      setDensity('comfortable');
      setVisibleColumnKeys(DEFAULT_VISIBLE_COLUMNS[activeTab] || []);
      setFilters(DEFAULT_QUEUE_FILTERS);
      return;
    }

    const view = views.find((candidate) => String(candidate.id) === String(viewId));
    const config = view?.config_json || {};
    setSearch(config.search || '');
    setDensity(config.density || 'comfortable');
    setVisibleColumnKeys(Array.isArray(config.columns) && config.columns.length > 0
      ? config.columns
      : (DEFAULT_VISIBLE_COLUMNS[activeTab] || []));
    setFilters({ ...DEFAULT_QUEUE_FILTERS, ...(config.filters || {}) });
  };

  const exportCurrentView = async () => {
    try {
      const params = { search };
      if (activeTab === 'accounts') {
        const current = filters.accounts;
        if (current.status !== 'All') params.status = current.status;
        if (current.accountType !== 'All') params.account_type = current.accountType;
        if (current.reviewFlagged !== 'All') params.review_flagged = current.reviewFlagged === 'Flagged';
      } else if (activeTab === 'users') {
        const current = filters.users;
        if (current.isBanned !== 'All') params.is_banned = current.isBanned === 'Banned';
        if (current.kycStatus !== 'All') params.kyc_status = current.kycStatus.toLowerCase();
        if (current.hasActiveAccounts !== 'All') params.has_active_accounts = current.hasActiveAccounts === 'Has Active';
      } else {
        const current = filters.money;
        if (current.payoutStatus !== 'All') params.status = current.payoutStatus.toLowerCase();
        if (current.isFlagged !== 'All') params.is_flagged = current.isFlagged === 'Flagged';
      }

      await exportAdminResource(adminAxios, EXPORT_RESOURCE_BY_TAB[activeTab], params);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not export current queue');
    }
  };

  const closeActionModal = () => {
    setActionContext(null);
    setActionForm(DEFAULT_ACTION_FORM);
  };

  const openActionFlow = ({ scope, action, row = null }) => {
    if (scope === 'row' && action === 'open_account_detail') {
      const targetAccountId = activeTab === 'money' ? row?.account_id : row?.id;
      if (!targetAccountId) {
        toast.error('This row does not have an account to open');
        return;
      }
      navigate(`/admin/accounts/${targetAccountId}`);
      return;
    }

    if (scope === 'row' && action === 'open_user_detail') {
      navigate(`/admin/users?q=${encodeURIComponent(row?.email || row?.id || '')}`);
      return;
    }

    if (scope === 'row' && action === 'open_dispute') {
      navigate('/admin/disputes');
      return;
    }

    const targetRows = scope === 'bulk' ? selectedRows : row ? [row] : [];
    if (targetRows.length === 0) {
      toast.error(scope === 'bulk' ? 'Select at least one row first' : 'No row available for this action');
      return;
    }

    if (scope === 'bulk' && targetRows.length > 100) {
      toast.error('Bulk actions are limited to 100 rows at a time');
      return;
    }

    if (scope === 'bulk' && !availableBulkActions.includes(action)) {
      toast.error('This bulk action is not available for the current selection');
      return;
    }

    if (action === 'waive_violation') {
      const eligibleRows = targetRows.filter((candidate) => candidate.latest_violation_id);
      if (eligibleRows.length === 0) {
        toast.error('None of the selected rows have an open violation to waive');
        return;
      }
    }

    setActionContext({
      scope,
      action,
      tab: activeTab,
      rows: targetRows
    });
    setActionForm({
      ...DEFAULT_ACTION_FORM,
      accountSize: String(targetRows[0]?.account_size || DEFAULT_ACTION_FORM.accountSize),
      transactionId: ''
    });
  };

  const submitRowAction = async (context, form) => {
    const row = context.rows[0];
    const { action, tab } = context;
    const reason = form.reason.trim();

    if (tab === 'accounts') {
      const payload = { action, reason };
      if (action === 'extend_days') payload.days = parseInt(form.days, 10);
      await adminAxios.post(`/api/admin/accounts/${row.id}/override`, payload);
      toast.success(mapAccountActionLabel(action));
      return;
    }

    if (tab === 'users') {
      if (action === 'ban') {
        await adminAxios.post('/api/admin/ban', { user_id: row.id, reason });
      } else if (action === 'unban') {
        await adminAxios.post('/api/admin/unban', { user_id: row.id, reason });
      } else if (action === 'revoke_sessions') {
        await adminAxios.post(`/api/admin/users/${row.id}/revoke-sessions`, { reason });
      } else if (action === 'approve_kyc') {
        await adminAxios.post('/api/admin/kyc/approve', { user_id: row.id, reason });
      } else if (action === 'reject_kyc') {
        await adminAxios.post('/api/admin/kyc/reject', { user_id: row.id, reason });
      } else if (action === 'manual_account') {
        await adminAxios.post(`/api/admin/users/${row.id}/manual-account`, {
          reason,
          account_type: form.accountType,
          account_size: parseInt(form.accountSize, 10)
        });
      }
      toast.success(mapUserActionLabel(action));
      return;
    }

    if (action === 'flag_payout') {
      await adminAxios.post(`/api/admin/payouts/${row.id}/flag`, { reason });
    } else if (action === 'unflag_payout') {
      await adminAxios.post(`/api/admin/payouts/${row.id}/unflag`, { reason });
    } else if (action === 'approve_payout') {
      await adminAxios.post('/api/admin/payouts/approve', {
        payout_id: row.id,
        transaction_id: form.transactionId.trim() || null,
        reason
      });
    } else if (action === 'reject_payout') {
      await adminAxios.post('/api/admin/payouts/reject', { payout_id: row.id, reason });
    } else if (action === 'waive_violation' && row.latest_violation_id) {
      await adminAxios.post(`/api/admin/violations/${row.latest_violation_id}/resolve`, {
        note: reason,
        resolution_type: 'waived'
      });
    }

    toast.success(mapMoneyActionLabel(action));
  };

  const submitBulkAction = async (context, form) => {
    const payload = {
      reason: form.reason.trim(),
      action: context.action
    };

    if (context.tab === 'accounts') {
      payload.entity = 'account';
      payload.ids = context.rows.map((row) => String(row.id));
      if (context.action === 'extend_days') payload.options = { days: parseInt(form.days, 10) };
    } else if (context.tab === 'users') {
      payload.entity = 'user';
      payload.ids = context.rows.map((row) => String(row.id));
      if (context.action === 'manual_account') {
        payload.options = {
          account_type: form.accountType,
          account_size: parseInt(form.accountSize, 10)
        };
      }
    } else if (context.action === 'waive_violation') {
      payload.entity = 'violation';
      payload.ids = context.rows.filter((row) => row.latest_violation_id).map((row) => String(row.latest_violation_id));
      payload.action = 'waive_violation';
    } else {
      payload.entity = 'payout';
      payload.ids = context.rows.map((row) => String(row.id));
      if (context.action === 'approve_payout' && form.transactionId.trim()) {
        payload.options = { transaction_id: form.transactionId.trim() };
      }
    }

    const res = await adminAxios.post('/api/admin/command-center/bulk-action', payload);
    const failures = Array.isArray(res.data?.results) ? res.data.results.filter((result) => !result.success) : [];

    if (failures.length > 0) {
      toast.error(`${failures.length} item(s) failed in the bulk action`);
    } else {
      toast.success(`Bulk action completed for ${payload.ids.length} item(s)`);
    }
  };

  const submitAction = async () => {
    if (!actionContext || submitting) return;

    const reason = actionForm.reason.trim();
    if (reason.length < 5) {
      toast.error('Please enter a clear admin reason');
      return;
    }

    if (needsDays(actionContext.action)) {
      const days = parseInt(actionForm.days, 10);
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        toast.error('Please enter a valid day count between 1 and 365');
        return;
      }
    }

    if (needsManualAccount(actionContext.action)) {
      const size = parseInt(actionForm.accountSize, 10);
      if (!['phase1', 'phase2', 'funded'].includes(actionForm.accountType)) {
        toast.error('Please choose a valid account type');
        return;
      }
      if (!Number.isFinite(size) || size <= 0) {
        toast.error('Please enter a valid account size');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (actionContext.scope === 'bulk') {
        await submitBulkAction(actionContext, actionForm);
      } else {
        await submitRowAction(actionContext, actionForm);
      }
      closeActionModal();
      await loadQueue({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Action failed');
    } finally {
      setSubmitting(false);
    }
  };

  const runRowAction = async (row, action) => {
    if (submitting) return;
    if (action === 'open_account_detail') {
      const accountId = activeTab === 'money' ? row.account_id : row.id;
      if (accountId) navigate(`/admin/accounts/${accountId}`);
      return;
    }
    if (action === 'open_user_detail') {
      navigate(`/admin/users?q=${encodeURIComponent(row.email || row.id)}`);
      return;
    }
    if (action === 'open_dispute') {
      navigate('/admin/disputes');
      return;
    }
    openActionFlow({ scope: 'row', action, row });
  };

  const runBulkAction = (action) => {
    openActionFlow({ scope: 'bulk', action });
  };

  const accountColumns = [
    {
      header: (
        <input
          type="checkbox"
          checked={rows.length > 0 && selectedIds.length === rows.length}
          onChange={toggleSelectAll}
        />
      ),
      key: 'select',
      render: (row) => (
        <input
          type="checkbox"
          checked={selectedIds.includes(String(row.id))}
          onChange={() => toggleRowSelection(row.id)}
        />
      )
    },
    {
      header: 'Account',
      key: 'id',
      render: (row) => (
        <div className="admin-td-mono" style={{ color: 'var(--admin-text)', fontWeight: 700 }}>{row.account_uid || `#${row.id}`}</div>
      )
    },
    {
      header: 'Trader',
      key: 'email',
      render: (row) => (
        <div>
          <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>{row.full_name || 'Unnamed Trader'}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{row.email}</div>
        </div>
      )
    },
    {
      header: 'Status',
      key: 'status',
      render: (row) => <AdminBadge status={row.status} label={formatLabel(row.status)} />
    },
    {
      header: 'Type',
      key: 'account_type',
      render: (row) => <AdminBadge status={row.account_type === 'funded' ? 'success' : 'info'} label={formatLabel(row.account_type)} />
    },
    {
      header: 'Balance',
      key: 'current_balance',
      render: (row) => formatMoney(row.current_balance)
    },
    {
      header: 'Review',
      key: 'review_flagged',
      render: (row) => row.review_flagged
        ? <AdminBadge status="warning" label="Flagged" />
        : <AdminBadge status="success" label="Clear" />
    },
    {
      header: 'Created',
      key: 'created_at',
      render: (row) => formatTimestamp(row.created_at)
    }
  ];

  const userColumns = [
    {
      header: (
        <input
          type="checkbox"
          checked={rows.length > 0 && selectedIds.length === rows.length}
          onChange={toggleSelectAll}
        />
      ),
      key: 'select',
      render: (row) => (
        <input
          type="checkbox"
          checked={selectedIds.includes(String(row.id))}
          onChange={() => toggleRowSelection(row.id)}
        />
      )
    },
    {
      header: 'Trader',
      key: 'email',
      render: (row) => (
        <div>
          <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>{row.full_name || 'Unnamed Trader'}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{row.email}</div>
        </div>
      )
    },
    {
      header: 'KYC',
      key: 'kyc_status',
      render: (row) => <AdminBadge status={row.kyc_status || 'pending'} label={formatLabel(row.kyc_status || 'pending')} />
    },
    {
      header: 'Status',
      key: 'is_banned',
      render: (row) => row.is_banned ? <AdminBadge status="danger" label="Banned" /> : <AdminBadge status="success" label="Active" />
    },
    {
      header: 'Accounts',
      key: 'account_count',
      render: (row) => (
        <div>
          <div style={{ color: 'var(--admin-text)' }}>{row.account_count || 0} total</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{row.active_account_count || 0} active</div>
        </div>
      )
    },
    {
      header: 'Joined',
      key: 'created_at',
      render: (row) => formatTimestamp(row.created_at)
    }
  ];

  const moneyColumns = [
    {
      header: (
        <input
          type="checkbox"
          checked={rows.length > 0 && selectedIds.length === rows.length}
          onChange={toggleSelectAll}
        />
      ),
      key: 'select',
      render: (row) => (
        <input
          type="checkbox"
          checked={selectedIds.includes(String(row.id))}
          onChange={() => toggleRowSelection(row.id)}
        />
      )
    },
    {
      header: 'Payout',
      key: 'id',
      render: (row) => (
        <div>
          <div className="admin-td-mono" style={{ color: 'var(--admin-text)', fontWeight: 700 }}>PAY-{String(row.id).padStart(5, '0')}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>Account {row.account_uid || `#${row.account_id}`}</div>
        </div>
      )
    },
    {
      header: 'Trader',
      key: 'email',
      render: (row) => (
        <div>
          <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>{row.full_name || 'Unknown Trader'}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{row.email}</div>
        </div>
      )
    },
    {
      header: 'Amount',
      key: 'amount_requested',
      render: (row) => formatMoney(row.amount_requested)
    },
    {
      header: 'Status',
      key: 'status',
      render: (row) => <AdminBadge status={row.status} label={formatLabel(row.status)} />
    },
    {
      header: 'Risk',
      key: 'risk',
      render: (row) => (
        <div>
          {row.is_flagged ? <AdminBadge status="warning" label="Flagged" /> : <AdminBadge status="success" label="Clean" />}
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px', marginTop: '6px' }}>
            {row.open_disputes_count || 0} disputes, {row.critical_violations_count || 0} critical
          </div>
        </div>
      )
    },
    {
      header: 'Requested',
      key: 'requested_at',
      render: (row) => formatTimestamp(row.requested_at)
    }
  ];

  const currentColumns = activeTab === 'accounts'
    ? accountColumns
    : activeTab === 'users'
      ? userColumns
      : moneyColumns;

  const currentColumnOptions = currentColumns
    .filter((column) => column.key && column.key !== 'select')
    .map((column) => ({ key: column.key, header: typeof column.header === 'string' ? column.header : column.key }));

  const visibleColumns = currentColumns.filter((column) => column.key === 'select' || visibleColumnKeys.includes(column.key));

  const rowActions = (row) => {
    const allowed = Array.isArray(row.allowed_actions) ? row.allowed_actions : [];
    return [
      { label: 'Preview', icon: 'info', onClick: () => setDrawerRow(row) },
      ...allowed.map((action) => ({
        label: mapActionLabel(activeTab, action),
        icon: action.startsWith('open_') ? 'info' : action.includes('lock') || action.includes('ban') ? 'warning' : 'activity',
        danger: ['fail', 'lock_account', 'ban', 'reject_payout'].includes(action),
        onClick: () => runRowAction(row, action)
      }))
    ];
  };

  const summaryCards = useMemo(() => {
    if (activeTab === 'accounts') {
      return [
        { label: 'Rows', value: summary.total || 0, icon: 'file' },
        { label: 'Failed', value: summary.failed || 0, icon: 'warning' },
        { label: 'Locked', value: summary.locked || 0, icon: 'lock' },
        { label: 'Flagged', value: summary.review_flagged || 0, icon: 'flag' }
      ];
    }
    if (activeTab === 'users') {
      return [
        { label: 'Rows', value: summary.total || 0, icon: 'users' },
        { label: 'Banned', value: summary.banned || 0, icon: 'warning' },
        { label: 'Pending KYC', value: summary.pending_kyc || 0, icon: 'kyc' },
        { label: 'With Active', value: summary.with_active_accounts || 0, icon: 'activity' }
      ];
    }
    return [
      { label: 'Rows', value: summary.total || 0, icon: 'wallet' },
      { label: 'Pending', value: summary.pending || 0, icon: 'history' },
      { label: 'Flagged', value: summary.flagged || 0, icon: 'flag' },
      { label: 'Critical', value: summary.with_critical_violations || 0, icon: 'warning' }
    ];
  }, [activeTab, summary]);

  const currentView = views.find((view) => String(view.id) === String(activeViewId));
  const drawerEntityType = activeTab === 'accounts' ? 'account' : activeTab === 'users' ? 'user' : 'payout';
  const drawerTitle = drawerRow
    ? activeTab === 'accounts'
      ? `Account ${drawerRow.account_uid || `#${drawerRow.id}`}`
      : activeTab === 'users'
        ? drawerRow.email || `User #${drawerRow.id}`
        : `Payout #${drawerRow.id}`
    : '';

  if (!isSuperAdmin) {
    return (
      <Card>
        <h1 className="admin-h1">Command Center</h1>
        <p style={{ color: 'var(--admin-text-muted)' }}>This workspace is available to super-admins only.</p>
      </Card>
    );
  }

  const selectedActionRows = actionContext?.rows || [];
  const modalActionLabel = actionContext ? mapActionLabel(actionContext.tab, actionContext.action) : '';
  const modalPlaceholder = actionContext ? buildActionPlaceholder(actionContext) : 'Explain why this admin action is needed.';

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <div>
          <h1 className="admin-h1">Command Center</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
            Super-admin recovery, trader control, and money-risk queues in one workspace.
          </p>
        </div>
        <button className="admin-btn admin-btn-ghost" onClick={() => loadQueue()} disabled={loading || submitting}>
          Refresh
        </button>
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '20px' }}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`admin-filter-chip ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <AdminStatGrid>
        {summaryCards.map((card) => (
          <AdminStatCard key={card.label} icon={card.icon} label={card.label} value={card.value} />
        ))}
      </AdminStatGrid>

      <AdminFilterBar
        searchPlaceholder="Search by trader, email, ID, or queue-specific field..."
        searchValue={search}
        onSearchChange={setSearch}
      >
        {activeTab === 'accounts' && (
          <>
            {['All', 'failed', 'locked', 'expired', 'active'].map((value) => (
              <button
                key={value}
                className={`admin-filter-chip ${filters.accounts.status === value ? 'active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, accounts: { ...current.accounts, status: value } }))}
              >
                {value === 'All' ? 'All Statuses' : formatLabel(value)}
              </button>
            ))}
            {['All', 'phase1', 'phase2', 'funded'].map((value) => (
              <button
                key={value}
                className={`admin-filter-chip ${filters.accounts.accountType === value ? 'active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, accounts: { ...current.accounts, accountType: value } }))}
              >
                {value === 'All' ? 'All Types' : formatLabel(value)}
              </button>
            ))}
            {['All', 'Flagged', 'Clear'].map((value) => (
              <button
                key={value}
                className={`admin-filter-chip ${filters.accounts.reviewFlagged === value ? 'active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, accounts: { ...current.accounts, reviewFlagged: value } }))}
              >
                {value === 'All' ? 'All Review States' : value}
              </button>
            ))}
          </>
        )}

        {activeTab === 'users' && (
          <>
            {['All', 'Banned', 'Active'].map((value) => (
              <button
                key={value}
                className={`admin-filter-chip ${filters.users.isBanned === value ? 'active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, users: { ...current.users, isBanned: value } }))}
              >
                {value === 'All' ? 'All Statuses' : value}
              </button>
            ))}
            {['All', 'Pending', 'Approved', 'Rejected'].map((value) => (
              <button
                key={value}
                className={`admin-filter-chip ${filters.users.kycStatus === value ? 'active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, users: { ...current.users, kycStatus: value } }))}
              >
                {value === 'All' ? 'All KYC' : value}
              </button>
            ))}
            {['All', 'Has Active', 'No Active'].map((value) => (
              <button
                key={value}
                className={`admin-filter-chip ${filters.users.hasActiveAccounts === value ? 'active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, users: { ...current.users, hasActiveAccounts: value } }))}
              >
                {value}
              </button>
            ))}
          </>
        )}

        {activeTab === 'money' && (
          <>
            {['All', 'Pending', 'Paid', 'Rejected'].map((value) => (
              <button
                key={value}
                className={`admin-filter-chip ${filters.money.payoutStatus === value ? 'active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, money: { ...current.money, payoutStatus: value } }))}
              >
                {value === 'All' ? 'All Payouts' : value}
              </button>
            ))}
            {['All', 'Flagged', 'Clean'].map((value) => (
              <button
                key={value}
                className={`admin-filter-chip ${filters.money.isFlagged === value ? 'active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, money: { ...current.money, isFlagged: value } }))}
              >
                {value === 'All' ? 'All Flag States' : value}
              </button>
            ))}
            {['All', 'Open Disputes', 'No Disputes'].map((value) => (
              <button
                key={value}
                className={`admin-filter-chip ${filters.money.openDisputes === value ? 'active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, money: { ...current.money, openDisputes: value } }))}
              >
                {value}
              </button>
            ))}
            {['All', 'Critical Violations', 'No Critical Violations'].map((value) => (
              <button
                key={value}
                className={`admin-filter-chip ${filters.money.criticalViolations === value ? 'active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, money: { ...current.money, criticalViolations: value } }))}
              >
                {value}
              </button>
            ))}
          </>
        )}
      </AdminFilterBar>

      <AdminListToolbar
        resourceLabel={activeTab === 'accounts' ? 'accounts' : activeTab === 'users' ? 'traders' : 'payouts'}
        views={views}
        activeViewId={activeViewId}
        onSelectView={selectView}
        onSaveView={saveView}
        onUpdateView={currentView ? () => updateView(currentView) : null}
        onDeleteView={currentView ? () => deleteView(currentView) : null}
        density={density}
        onDensityChange={setDensity}
        columns={currentColumnOptions}
        visibleColumnKeys={visibleColumnKeys}
        onToggleColumn={toggleColumn}
        onExport={exportCurrentView}
        selectionLabel={selectedIds.length > 0 ? `${selectedIds.length} selected` : ''}
        extraActions={selectedIds.length > 0 ? (
          <>
            {availableBulkActions.map((action) => (
              <button key={action} className="admin-btn admin-btn-ghost" onClick={() => runBulkAction(action)} disabled={submitting}>
                {mapActionLabel(activeTab, action)}
              </button>
            ))}
          </>
        ) : null}
      />

      <Card flush>
        <AdminDataTable
          columns={visibleColumns}
          data={rows}
          loading={loading}
          rowActions={rowActions}
          emptyMessage="No records match the current command center filters"
          emptyIcon="command"
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
          density={density}
          onRowClick={(row) => setDrawerRow(row)}
        />
      </Card>

      <AdminEntityDrawer
        open={!!drawerRow}
        entityType={drawerEntityType}
        row={drawerRow}
        title={drawerTitle}
        adminAxios={adminAxios}
        quickActions={drawerRow ? rowActions(drawerRow).filter((action) => action.label !== 'Preview').map((action) => ({
          label: action.label,
          onClick: action.onClick
        })) : []}
        onClose={() => setDrawerRow(null)}
        onRefresh={() => loadQueue({ silent: true })}
      />

      <AdminModal
        isOpen={!!actionContext}
        onClose={submitting ? undefined : closeActionModal}
        title={actionContext ? `${modalActionLabel} ${actionContext.scope === 'bulk' ? `(${selectedActionRows.length})` : ''}` : 'Admin Action'}
        size="md"
        footer={(
          <>
            <button className="admin-btn admin-btn-ghost" onClick={closeActionModal} disabled={submitting}>Cancel</button>
            <button className="admin-btn admin-btn-primary" onClick={submitAction} disabled={submitting}>
              {submitting ? 'Applying...' : actionContext?.scope === 'bulk' ? 'Run Bulk Action' : 'Apply Action'}
            </button>
          </>
        )}
      >
        {actionContext && (
          <div style={{ display: 'grid', gap: '16px' }}>
            <div style={{ background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', padding: '14px' }}>
              <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>Target Summary</div>
              <div style={{ color: 'var(--admin-text)' }}>
                {actionContext.scope === 'bulk' ? `${selectedActionRows.length} selected row(s)` : '1 selected row'}
              </div>
              <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px', marginTop: '8px', display: 'grid', gap: '4px' }}>
                {selectedActionRows.slice(0, 4).map((row) => (
                  <div key={`${actionContext.action}-${row.id}`}>
                    {actionContext.tab === 'accounts'
                      ? `Account ${row.account_uid || `#${row.id}`} - ${row.full_name || row.email || 'Unknown trader'}`
                      : actionContext.tab === 'users'
                        ? `${row.email || `User #${row.id}`} - ${row.full_name || 'Unnamed trader'}`
                        : `Payout #${row.id} - ${row.email || 'Unknown trader'} - ${formatMoney(row.amount_requested)}`}
                  </div>
                ))}
                {selectedActionRows.length > 4 && (
                  <div>+ {selectedActionRows.length - 4} more</div>
                )}
              </div>
            </div>

            <div className="admin-form-group" style={{ margin: 0 }}>
              <label className="admin-label">Reason</label>
              <textarea
                className="admin-textarea"
                rows={4}
                value={actionForm.reason}
                onChange={(event) => setActionForm((current) => ({ ...current, reason: event.target.value }))}
                placeholder={modalPlaceholder}
              />
            </div>

            {needsDays(actionContext.action) && (
              <div className="admin-form-group" style={{ margin: 0 }}>
                <label className="admin-label">Extension Days</label>
                <input
                  className="admin-input admin-font-mono"
                  type="number"
                  min="1"
                  max="365"
                  value={actionForm.days}
                  onChange={(event) => setActionForm((current) => ({ ...current, days: event.target.value }))}
                />
              </div>
            )}

            {needsManualAccount(actionContext.action) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
                <div className="admin-form-group" style={{ margin: 0 }}>
                  <label className="admin-label">Account Type</label>
                  <select
                    className="admin-input"
                    value={actionForm.accountType}
                    onChange={(event) => setActionForm((current) => ({ ...current, accountType: event.target.value }))}
                  >
                    <option value="phase1">Phase 1</option>
                    <option value="phase2">Phase 2</option>
                    <option value="funded">Funded</option>
                  </select>
                </div>
                <div className="admin-form-group" style={{ margin: 0 }}>
                  <label className="admin-label">Account Size</label>
                  <input
                    className="admin-input admin-font-mono"
                    type="number"
                    min="1000"
                    step="1"
                    value={actionForm.accountSize}
                    onChange={(event) => setActionForm((current) => ({ ...current, accountSize: event.target.value }))}
                  />
                </div>
              </div>
            )}

            {supportsTransactionId(actionContext.tab, actionContext.action) && (
              <div className="admin-form-group" style={{ margin: 0 }}>
                <label className="admin-label">Transaction ID</label>
                <input
                  className="admin-input admin-font-mono"
                  type="text"
                  value={actionForm.transactionId}
                  onChange={(event) => setActionForm((current) => ({ ...current, transactionId: event.target.value }))}
                  placeholder="Optional payment / settlement reference"
                />
              </div>
            )}
          </div>
        )}
      </AdminModal>
    </>
  );
}
