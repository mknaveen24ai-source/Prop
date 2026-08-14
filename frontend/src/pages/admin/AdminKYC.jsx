import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';
import { exportAdminResource, normalizeAdminListResponse } from '../../utils/adminList';
import Card from '../../components/ui/Card';
import { API_BASE_URL as API_URL } from '../../config/apiBase'


const DEFAULT_FILTERS = {
  status: 'pending'
};

const ALL_COLUMN_KEYS = [
  'trader',
  'country',
  'submitted',
  'kyc',
  'sla',
  'quality',
  'classification',
  'tags'
];

function buildViewConfig({ search, filters, sort, visibleColumnKeys, density }) {
  return {
    search,
    filters,
    sort,
    columns: visibleColumnKeys,
    density
  };
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function formatHours(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return '-';
  return `${parsed.toFixed(1)}h`;
}

function formatDocumentType(value) {
  const labels = {
    passport: 'Passport',
    national_id: 'National ID',
    aadhaar: 'Aadhaar',
    drivers_license: "Driver's License",
    residence_permit: 'Residence Permit'
  };
  return labels[value] || value || '-';
}

function getSlaBadgeStatus(value) {
  if (value === 'breach') return 'danger';
  if (value === 'overdue') return 'warning';
  if (value === 'warning') return 'info';
  return 'success';
}

function getQualityBadgeStatus(value) {
  if (value === 'high') return 'danger';
  if (value === 'medium') return 'warning';
  return 'success';
}

function KycDocViewer({ userId, zoom, adminAxios }) {
  const [activeDoc, setActiveDoc] = useState('front');
  const [docUrl, setDocUrl] = useState('');
  const [docType, setDocType] = useState('');
  const [docError, setDocError] = useState('');
  const [loadingDoc, setLoadingDoc] = useState(false);

  useEffect(() => {
    setActiveDoc('front');
  }, [userId]);

  useEffect(() => {
    if (!userId || !adminAxios) return undefined;
    let objectUrl = '';
    let cancelled = false;

    async function fetchDocument() {
      setLoadingDoc(true);
      setDocError('');
      setDocUrl('');
      setDocType('');
      try {
        const res = await adminAxios.get(`/api/admin/kyc/document/${userId}/${activeDoc}`, {
          responseType: 'blob'
        });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data);
        setDocUrl(objectUrl);
        setDocType(String(res.headers?.['content-type'] || res.data?.type || ''));
      } catch (err) {
        if (!cancelled) {
          setDocError(err?.response?.data?.error || 'Document is not available.');
        }
      } finally {
        if (!cancelled) setLoadingDoc(false);
      }
    }

    fetchDocument();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activeDoc, adminAxios, userId]);

  const isPdf = docType.includes('pdf');

  if (!userId) return null;

  return (
    <div className="admin-kyc-viewer-shell">
      <div className="admin-kyc-viewer-tabs">
        <button
          className={`admin-filter-chip ${activeDoc === 'front' ? 'active' : ''}`}
          onClick={() => setActiveDoc('front')}
        >
          ID Front
        </button>
        <button
          className={`admin-filter-chip ${activeDoc === 'back' ? 'active' : ''}`}
          onClick={() => setActiveDoc('back')}
        >
          ID Back
        </button>
        <button
          className={`admin-filter-chip ${activeDoc === 'selfie' ? 'active' : ''}`}
          onClick={() => setActiveDoc('selfie')}
        >
          Selfie With ID
        </button>
      </div>

      <div className="admin-kyc-viewer-stage">
        {loadingDoc ? (
          <div className="admin-kyc-viewer-empty" style={{ display: 'flex' }}>
            <div style={{ fontSize: '14px' }}>Loading document...</div>
          </div>
        ) : docError ? (
          <div className="admin-kyc-viewer-empty" style={{ display: 'flex' }}>
            <div style={{ fontSize: '14px' }}>{docError}</div>
          </div>
        ) : isPdf ? (
          <object
            key={docUrl}
            data={docUrl}
            type="application/pdf"
            style={{
              width: `${Math.min(100, 90 * zoom)}%`,
              height: `${Math.min(100, 90 * zoom)}%`,
              background: 'var(--paper)'
            }}
          >
            <div className="admin-kyc-viewer-empty" style={{ display: 'flex' }}>
              <a className="admin-btn admin-btn-ghost" href={docUrl} target="_blank" rel="noreferrer">Open PDF</a>
            </div>
          </object>
        ) : (
          <img
            key={docUrl}
            src={docUrl}
            alt={activeDoc === 'selfie' ? 'Live selfie' : activeDoc === 'back' ? 'ID back document' : 'ID front document'}
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'center center',
              transition: 'transform 0.2s ease',
              maxWidth: '90%',
              maxHeight: '90%',
              objectFit: 'contain'
            }}
            onError={(event) => {
              event.currentTarget.style.display = 'none';
              const fallback = event.currentTarget.nextElementSibling;
              if (fallback) fallback.style.display = 'flex';
            }}
          />
        )}
      </div>
    </div>
  );
}

export default function AdminKYC() {
  const { adminAxios, socket } = useOutletContext();
  const navigate = useNavigate();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [listData, setListData] = useState({
    summary: {},
    rows: [],
    pagination: { current: 1, total: 1, total_items: 0, page_size: 25 }
  });
  const [slaData, setSlaData] = useState({ summary: {}, queue: [] });
  const [qualityData, setQualityData] = useState({ summary: {}, rows: [] });
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'created_at', direction: 'desc' });
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [zoom, setZoom] = useState(1);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('Document unclear');
  const [rejectCustom, setRejectCustom] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [historyNotes, setHistoryNotes] = useState([]);
  const [requestingInfo, setRequestingInfo] = useState(false);

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'kyc' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  const fetchAuxiliary = async () => {
    try {
      const [slaRes, qualityRes] = await Promise.all([
        adminAxios.get('/api/admin/kyc-sla'),
        adminAxios.get('/api/admin/kyc-quality-flags')
      ]);
      setAccessDenied(false);
      setSlaData({
        summary: slaRes.data?.summary || {},
        queue: Array.isArray(slaRes.data?.queue) ? slaRes.data.queue : []
      });
      setQualityData({
        summary: qualityRes.data?.summary || {},
        rows: Array.isArray(qualityRes.data?.rows) ? qualityRes.data.rows : []
      });
    } catch (err) {
      if (err?.response?.status === 403) {
        setAccessDenied(true);
      }
      setSlaData({ summary: {}, queue: [] });
      setQualityData({ summary: {}, rows: [] });
    }
  };

  // FIX (AUDIT): stale-closure race — see AdminUsers.jsx for full explanation.
  const fetchKycQueue = async ({ silent = false, pageOverride } = {}) => {
    const effectivePage = pageOverride ?? page;
    if (!silent) setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/traders', {
        params: {
          format: 'list',
          page: effectivePage,
          page_size: 25,
          search,
          sort: sort.key,
          order: sort.direction,
          kyc_status: filters.status !== 'all' ? filters.status : undefined
        }
      });
      const next = normalizeAdminListResponse(res.data);
      const filteredRows = (next.rows || []).filter((row) => {
        const status = String(row.kyc_status || '').toLowerCase();
        if (!['pending', 'approved', 'rejected'].includes(status)) return false;
        return status !== 'pending' || Boolean(row.kyc_submitted_at);
      });
      next.rows = filteredRows;
      setAccessDenied(false);
      setListData(next);
      setSelectedIds((current) => current.filter((id) => filteredRows.some((row) => String(row.id) === id)));
    } catch (err) {
      if (err?.response?.status === 403) {
        setAccessDenied(true);
      } else {
        toast.error(err?.response?.data?.error || 'Failed to load KYC queue');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchViews();
    fetchAuxiliary();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchKycQueue();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setPage(1);
      fetchKycQueue({ silent: true, pageOverride: 1 });
    }, 150);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters]);

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => {
      fetchKycQueue({ silent: true });
      fetchAuxiliary();
    };
    socket.on('admin_command_center_updated', refresh);
    socket.on('admin_enforcement_event', refresh);
    return () => {
      socket.off('admin_command_center_updated', refresh);
      socket.off('admin_enforcement_event', refresh);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, page, sort, search, filters]);

  const slaMap = useMemo(
    () => new Map((slaData.queue || []).map((row) => [String(row.user_id), row])),
    [slaData.queue]
  );
  const qualityMap = useMemo(
    () => new Map((qualityData.rows || []).map((row) => [String(row.user_id), row])),
    [qualityData.rows]
  );

  const rows = useMemo(() => (
    (listData.rows || []).map((row) => {
      const sla = slaMap.get(String(row.id));
      const quality = qualityMap.get(String(row.id));
      return {
        ...row,
        kyc_wait_hours: sla?.wait_hours ?? null,
        kyc_sla_status: sla?.sla_status || null,
        funded_accounts: sla?.funded_accounts ?? 0,
        quality_score: quality?.quality_score ?? 0,
        quality_risk: quality?.risk_level || 'low',
        quality_flags: Array.isArray(quality?.flags) ? quality.flags : [],
        id_file_exists: quality?.id_file_exists ?? null,
        back_file_exists: quality?.back_file_exists ?? null,
        selfie_file_exists: quality?.selfie_file_exists ?? null,
        missing_files: Boolean(quality && (!quality.id_file_exists || !quality.back_file_exists || !quality.selfie_file_exists))
      };
    })
  ), [listData.rows, qualityMap, slaMap]);

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedUserId('');
      return;
    }
    if (!selectedUserId || !rows.some((row) => String(row.id) === String(selectedUserId))) {
      const firstPending = rows.find((row) => String(row.kyc_status || '').toLowerCase() === 'pending');
      setSelectedUserId(String((firstPending || rows[0]).id));
      setZoom(1);
      setRejecting(false);
    }
  }, [rows, selectedUserId]);

  const selectedUser = useMemo(
    () => rows.find((row) => String(row.id) === String(selectedUserId)) || null,
    [rows, selectedUserId]
  );

  useEffect(() => {
    if (!selectedUserId) { setHistoryNotes([]); return undefined; }
    let cancelled = false;
    adminAxios.get('/api/admin/notes', { params: { entity_type: 'user', entity_id: selectedUserId } })
      .then((res) => { if (!cancelled) setHistoryNotes(Array.isArray(res.data) ? res.data : []); })
      .catch(() => { if (!cancelled) setHistoryNotes([]); });
    return () => { cancelled = true; };
  }, [adminAxios, selectedUserId]);

  const requestMoreInfo = async () => {
    if (!selectedUser || requestingInfo) return;
    const message = window.prompt(`What does ${selectedUser.full_name || selectedUser.email} need to provide?`, 'Please re-upload a clearer photo of your ID.');
    if (!message) return;
    setRequestingInfo(true);
    try {
      await adminAxios.post('/api/admin/kyc/request-info', { user_id: selectedUser.id, message: message.trim() });
      toast.success('Request sent to trader');
      const res = await adminAxios.get('/api/admin/notes', { params: { entity_type: 'user', entity_id: selectedUserId } });
      setHistoryNotes(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not send request');
    } finally {
      setRequestingInfo(false);
    }
  };

  const pagination = listData.pagination || { current: 1, total: 1, total_items: 0, page_size: 25 };

  const handleSortChange = (sortKey) => {
    setSort((current) => ({
      key: sortKey,
      direction: current.key === sortKey && current.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  const toggleColumn = (columnKey) => {
    setVisibleColumnKeys((current) => (
      current.includes(columnKey)
        ? current.filter((key) => key !== columnKey)
        : [...current, columnKey]
    ));
  };

  const saveView = async () => {
    const name = window.prompt('Name this KYC view', 'Pending KYC Review');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'kyc',
        name,
        config: buildViewConfig({ search, filters, sort, visibleColumnKeys, density })
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
        config: buildViewConfig({ search, filters, sort, visibleColumnKeys, density })
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
      setFilters(DEFAULT_FILTERS);
      setSort({ key: 'created_at', direction: 'desc' });
      setVisibleColumnKeys(ALL_COLUMN_KEYS);
      setDensity('comfortable');
      setPage(1);
      return;
    }

    const selectedView = views.find((view) => String(view.id) === String(viewId));
    const config = selectedView?.config_json || {};
    setSearch(config.search || '');
    setFilters({ ...DEFAULT_FILTERS, ...(config.filters || {}) });
    setSort(config.sort || { key: 'created_at', direction: 'desc' });
    setVisibleColumnKeys(Array.isArray(config.columns) && config.columns.length > 0 ? config.columns : ALL_COLUMN_KEYS);
    setDensity(config.density || 'comfortable');
    setPage(1);
  };

  const toggleSelection = (row) => {
    setSelectedIds((current) => (
      current.includes(String(row.id))
        ? current.filter((id) => id !== String(row.id))
        : [...current, String(row.id)]
    ));
  };

  const toggleAll = () => {
    if (selectedIds.length === rows.length) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(rows.map((row) => String(row.id)));
  };

  const availableBulkActions = useMemo(() => {
    if (selectedIds.length === 0) return [];
    const selectedRows = rows.filter((row) => selectedIds.includes(String(row.id)));
    const actionOrder = ['approve_kyc', 'reject_kyc'];
    return actionOrder.filter((action) => selectedRows.every((row) => (row.allowed_actions || []).includes(action)));
  }, [rows, selectedIds]);

  const applyTagToSelection = async () => {
    if (selectedIds.length === 0) return;
    const tag = window.prompt(`Tag ${selectedIds.length} selected KYC profiles`, 'manual-review');
    if (!tag) return;
    try {
      await adminAxios.post('/api/admin/tags/assign', {
        entity_type: 'user',
        ids: selectedIds,
        tags: [tag],
        mode: 'add'
      });
      toast.success('Tags updated');
      fetchKycQueue({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to tag profiles');
    }
  };

  const runBulkKycAction = async (action) => {
    if (selectedIds.length === 0) return;
    const defaultReason = action === 'approve_kyc' ? 'KYC approved from review queue' : 'KYC rejected from review queue';
    const reason = window.prompt(
      action === 'approve_kyc'
        ? `Why are you approving ${selectedIds.length} KYC submission(s)?`
        : `Why are you rejecting ${selectedIds.length} KYC submission(s)?`,
      defaultReason
    );
    if (!reason) return;
    try {
      await adminAxios.post('/api/admin/command-center/bulk-action', {
        entity: 'user',
        ids: selectedIds,
        action,
        reason
      });
      toast.success(action === 'approve_kyc' ? 'Bulk KYC approval submitted' : 'Bulk KYC rejection submitted');
      fetchKycQueue({ silent: true });
      fetchAuxiliary();
      setSelectedIds([]);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Bulk KYC action failed');
    }
  };

  const exportCurrentView = async () => {
    try {
      await exportAdminResource(adminAxios, 'traders', {
        search,
        sort: sort.key,
        order: sort.direction,
        kyc_status: filters.status !== 'all' ? filters.status : undefined
      });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not export KYC view');
    }
  };

  const handleDecision = async (status) => {
    if (!selectedUser || submitting) return;

    let reason = '';
    if (status === 'rejected') {
      reason = rejectReason === 'Other' ? rejectCustom.trim() : rejectReason;
      if (!reason) {
        toast.warning('Please provide a rejection reason');
        return;
      }
    }

    setSubmitting(true);
    try {
      const endpoint = status === 'approved' ? '/api/admin/kyc/approve' : '/api/admin/kyc/reject';
      const payload = status === 'approved'
        ? { user_id: selectedUser.id, reason: 'Approved from KYC queue' }
        : { user_id: selectedUser.id, reason };

      await adminAxios.post(endpoint, payload);
      toast.success(`KYC ${status === 'approved' ? 'approved' : 'rejected'} for ${selectedUser.email}`);
      setRejecting(false);
      setRejectReason('Document unclear');
      setRejectCustom('');
      await fetchKycQueue({ silent: true });
      await fetchAuxiliary();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to update KYC status');
    } finally {
      setSubmitting(false);
    }
  };

  const reviewActions = (row) => {
    const actions = [
      {
        label: 'Review',
        icon: 'info',
        onClick: () => {
          setSelectedUserId(String(row.id));
          setZoom(1);
          setRejecting(false);
        }
      }
    ];

    if ((row.allowed_actions || []).includes('approve_kyc')) {
      actions.push({
        label: 'Approve',
        icon: 'approve',
        onClick: async () => {
          setSelectedUserId(String(row.id));
          setRejecting(false);
          await adminAxios.post('/api/admin/kyc/approve', {
            user_id: row.id,
            reason: 'Approved from KYC queue list'
          });
          toast.success('KYC approved');
          fetchKycQueue({ silent: true });
          fetchAuxiliary();
        }
      });
    }

    if ((row.allowed_actions || []).includes('reject_kyc')) {
      actions.push({
        label: 'Reject',
        icon: 'reject',
        danger: true,
        onClick: () => {
          setSelectedUserId(String(row.id));
          setRejecting(true);
        }
      });
    }

    return actions;
  };

  const columns = useMemo(() => {
    const allColumns = [
      {
        key: 'trader',
        header: 'Trader',
        sortKey: 'created_at',
        render: (row) => (
          <div>
            <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>{row.full_name || 'Unnamed Trader'}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{row.email}</div>
          </div>
        )
      },
      {
        key: 'country',
        header: 'Country',
        sortKey: 'country',
        render: (row) => row.kyc_document_country || row.country || '-'
      },
      {
        key: 'submitted',
        header: 'Submitted',
        sortKey: 'created_at',
        render: (row) => formatDate(row.kyc_submitted_at || row.created_at)
      },
      {
        key: 'kyc',
        header: 'KYC Status',
        sortKey: 'kyc_status',
        render: (row) => <AdminBadge status={row.kyc_status || 'pending'} label={String(row.kyc_status || 'pending').toUpperCase()} />
      },
      {
        key: 'sla',
        header: 'SLA',
        render: (row) => (
          <div>
            <AdminBadge
              status={getSlaBadgeStatus(row.kyc_sla_status)}
              label={row.kyc_sla_status ? row.kyc_sla_status.replace(/_/g, ' ') : 'No timer'}
            />
            <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px', marginTop: '6px' }}>
              {row.kyc_wait_hours ? formatHours(row.kyc_wait_hours) : 'No wait data'}
            </div>
          </div>
        )
      },
      {
        key: 'quality',
        header: 'Quality',
        render: (row) => (
          <div>
            <AdminBadge status={getQualityBadgeStatus(row.quality_risk)} label={row.quality_risk || 'low'} />
            <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px', marginTop: '6px' }}>
              Score {row.quality_score || 0}{row.missing_files ? ' - missing file' : ''}
            </div>
          </div>
        )
      },
      {
        key: 'classification',
        header: 'Classification',
        render: (row) => (
          <div>
            <div style={{ color: 'var(--admin-text)' }}>{row.classification || row.support_tier || '-'}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{row.risk_tier || 'normal risk'}</div>
          </div>
        )
      },
      {
        key: 'tags',
        header: 'Tags',
        render: (row) => (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {(row.tags || []).slice(0, 3).map((tag) => (
              <span key={tag} className="admin-tag-pill">{tag}</span>
            ))}
            {(!row.tags || row.tags.length === 0) && <span style={{ color: 'var(--admin-text-faint)' }}>-</span>}
          </div>
        )
      }
    ];

    return allColumns.filter((column) => visibleColumnKeys.includes(column.key));
  }, [visibleColumnKeys]);

  const currentView = views.find((view) => String(view.id) === String(activeViewId));
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const someSelected = selectedIds.length > 0 && selectedIds.length < rows.length;

  if (accessDenied) {
    return (
      <Card>
        <h1 className="admin-h1">KYC Queue</h1>
        <p style={{ color: 'var(--admin-text-muted)', marginBottom: '16px' }}>
          This admin session does not currently have access to the KYC queue or its supporting review endpoints.
        </p>
        <button className="admin-btn admin-btn-ghost" onClick={() => { fetchKycQueue(); fetchAuxiliary(); }}>
          Retry Access Check
        </button>
      </Card>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <div>
          <h1 className="admin-h1">KYC Queue</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
            Review pending documents, SLA drift, and quality-risk signals from one operator queue.
          </p>
        </div>
        <button className="admin-btn admin-btn-ghost" onClick={() => { fetchKycQueue(); fetchAuxiliary(); }} disabled={loading || submitting}>
          Refresh Queue
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <AdminStatCard icon="kyc" label="Pending Queue" value={slaData.summary?.pending_total || 0} />
        <AdminStatCard icon="timer" label="Over SLA" value={slaData.summary?.overdue_total || 0} />
        <AdminStatCard icon="warning" label="Quality Risk High" value={qualityData.summary?.high_risk_count || 0} />
        <AdminStatCard icon="file" label="Missing Files" value={qualityData.summary?.missing_file_count || 0} />
      </div>

      <AdminFilterBar
        searchPlaceholder="Search by trader name, email, or country..."
        searchValue={search}
        onSearchChange={setSearch}
      >
        {['pending', 'approved', 'rejected', 'all'].map((value) => (
          <button
            key={value}
            className={`admin-filter-chip ${filters.status === value ? 'active' : ''}`}
            onClick={() => setFilters((current) => ({ ...current, status: value }))}
          >
            {value === 'all' ? 'All KYC States' : value.charAt(0).toUpperCase() + value.slice(1)}
          </button>
        ))}
      </AdminFilterBar>

      <AdminListToolbar
        views={views}
        activeViewId={activeViewId}
        onSelectView={selectView}
        onSaveView={saveView}
        onUpdateView={currentView ? () => updateView(currentView) : null}
        onDeleteView={currentView ? () => deleteView(currentView) : null}
        columns={ALL_COLUMN_KEYS.map((key) => ({ key, label: key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) }))}
        visibleColumnKeys={visibleColumnKeys}
        onToggleColumn={toggleColumn}
        density={density}
        onDensityChange={setDensity}
        onExport={exportCurrentView}
        selectionLabel={selectedIds.length > 0 ? `${selectedIds.length} selected` : ''}
        extraActions={selectedIds.length > 0 ? (
          <>
            <button className="admin-btn admin-btn-ghost" onClick={applyTagToSelection}>
              Tag Selection
            </button>
            {availableBulkActions.includes('approve_kyc') && (
              <button className="admin-btn admin-btn-primary" onClick={() => runBulkKycAction('approve_kyc')}>
                Approve Selected
              </button>
            )}
            {availableBulkActions.includes('reject_kyc') && (
              <button className="admin-btn admin-btn-ghost" onClick={() => runBulkKycAction('reject_kyc')}>
                Reject Selected
              </button>
            )}
          </>
        ) : null}
      />

      <div className="admin-kyc-layout">
        <Card flush>
          <AdminDataTable
            columns={columns}
            data={rows}
            loading={loading}
            emptyMessage="No KYC submissions match the current filters"
            emptyIcon="kyc"
            pagination={pagination}
            onPageChange={setPage}
            rowActions={reviewActions}
            sort={sort}
            onSortChange={handleSortChange}
            density={density}
            onRowClick={(row) => {
              setSelectedUserId(String(row.id));
              setRejecting(false);
              setZoom(1);
            }}
            selection={{
              selectedIds,
              allSelected,
              someSelected,
              onToggleAll: toggleAll,
              onToggleRow: toggleSelection
            }}
          />
        </Card>

        <Card className="admin-kyc-review-panel">
          {selectedUser ? (
            <>
              <div className="admin-kyc-review-header">
                <div>
                  <h2 className="admin-h2" style={{ margin: 0 }}>{selectedUser.full_name || 'Unnamed Trader'}</h2>
                  <div style={{ color: 'var(--admin-text-muted)', fontSize: '13px', marginTop: '4px' }}>
                    {selectedUser.email} - {selectedUser.kyc_document_country || selectedUser.country || 'Unknown Country'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button className="admin-btn admin-btn-ghost" onClick={() => navigate(`/admin/users?q=${encodeURIComponent(selectedUser.email || selectedUser.id)}`)}>
                    Open Profile
                  </button>
                  <button className="admin-btn admin-btn-ghost" onClick={() => setZoom((value) => Math.max(0.5, value - 0.2))}>-</button>
                  <div className="admin-selection-pill">{Math.round(zoom * 100)}%</div>
                  <button className="admin-btn admin-btn-ghost" onClick={() => setZoom((value) => Math.min(3, value + 0.2))}>+</button>
                </div>
              </div>

              <div className="admin-entity-badge-row" style={{ marginBottom: '16px' }}>
                <AdminBadge status={selectedUser.kyc_status || 'pending'} label={`KYC ${selectedUser.kyc_status || 'pending'}`} />
                {selectedUser.kyc_sla_status && (
                  <AdminBadge status={getSlaBadgeStatus(selectedUser.kyc_sla_status)} label={`SLA ${selectedUser.kyc_sla_status}`} />
                )}
                <AdminBadge status={getQualityBadgeStatus(selectedUser.quality_risk)} label={`Quality ${selectedUser.quality_risk}`} />
              </div>

              <div className="admin-entity-info-grid" style={{ marginBottom: '16px' }}>
                <div><span>Submitted</span><strong>{formatDate(selectedUser.kyc_submitted_at || selectedUser.created_at)}</strong></div>
                <div><span>Wait Time</span><strong>{selectedUser.kyc_wait_hours ? formatHours(selectedUser.kyc_wait_hours) : '-'}</strong></div>
                <div><span>Quality Score</span><strong>{selectedUser.quality_score || 0}</strong></div>
                <div><span>Funded Accounts</span><strong>{selectedUser.funded_accounts || 0}</strong></div>
              </div>

              <Card style={{ margin: '0 0 16px 0' }}>
                <h3 className="admin-h3">Submitted Identity Details</h3>
                <div className="admin-entity-info-grid">
                  <div><span>Country</span><strong>{selectedUser.kyc_document_country || selectedUser.country || '-'}</strong></div>
                  <div><span>Document Type</span><strong>{formatDocumentType(selectedUser.kyc_document_type)}</strong></div>
                  <div><span>Document Number</span><strong style={{ fontFamily: 'var(--font-mono)' }}>{selectedUser.kyc_document_number || '-'}</strong></div>
                  <div><span>Documents</span><strong>{selectedUser.missing_files ? 'Check missing files' : 'Front, back, live photo'}</strong></div>
                </div>
              </Card>

              <Card style={{ margin: 0 }}>
                {String(selectedUser.kyc_status || '').toLowerCase() === 'rejected' ? (
                  <div style={{ color: 'var(--admin-text-muted)' }}>
                    This submission has been rejected. Use the trader profile if you need to review historical notes or resubmissions.
                  </div>
                ) : (
                  <KycDocViewer userId={selectedUser.id} zoom={zoom} adminAxios={adminAxios} />
                )}
              </Card>

              <Card style={{ margin: 0 }}>
                <h3 className="admin-h3">Quality Flags</h3>
                {(selectedUser.quality_flags || []).length > 0 ? (
                  <ul className="admin-kyc-flag-list">
                    {selectedUser.quality_flags.map((flag) => (
                      <li key={flag}>{flag}</li>
                    ))}
                  </ul>
                ) : (
                  <div style={{ color: 'var(--admin-text-muted)' }}>No quality issues detected for the current submission.</div>
                )}
              </Card>

              {String(selectedUser.kyc_status || '').toLowerCase() === 'pending' && (
                <Card style={{ margin: 0 }}>
                  {!rejecting ? (
                    <div style={{ display: 'flex', gap: '12px' }}>
                      <button className="admin-btn admin-btn-danger" style={{ flex: 1 }} disabled={submitting} onClick={() => setRejecting(true)}>
                        Reject
                      </button>
                      <button className="admin-btn admin-btn-ghost" style={{ flex: 1 }} disabled={requestingInfo} onClick={requestMoreInfo}>
                        {requestingInfo ? 'Sending…' : 'Request more'}
                      </button>
                      <button className="admin-btn admin-btn-success" style={{ flex: 1 }} disabled={submitting} onClick={() => handleDecision('approved')}>
                        Approve
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gap: '12px' }}>
                      <div className="admin-form-group" style={{ margin: 0 }}>
                        <label className="admin-label">Rejection Reason</label>
                        <select className="admin-select" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)}>
                          <option value="Document unclear">Document unclear</option>
                          <option value="Wrong document type">Wrong document type</option>
                          <option value="Expired document">Expired document</option>
                          <option value="Information mismatch">Information mismatch</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      {rejectReason === 'Other' && (
                        <textarea
                          className="admin-input"
                          rows={3}
                          value={rejectCustom}
                          onChange={(event) => setRejectCustom(event.target.value)}
                          placeholder="Add a custom rejection reason"
                          style={{ resize: 'vertical', minHeight: '88px' }}
                        />
                      )}
                      <div style={{ display: 'flex', gap: '12px' }}>
                        <button className="admin-btn admin-btn-ghost" style={{ flex: 1 }} disabled={submitting} onClick={() => setRejecting(false)}>
                          Cancel
                        </button>
                        <button className="admin-btn admin-btn-danger" style={{ flex: 2 }} disabled={submitting} onClick={() => handleDecision('rejected')}>
                          Confirm Rejection
                        </button>
                      </div>
                    </div>
                  )}
                </Card>
              )}
            </>
          ) : (
            <div style={{ color: 'var(--admin-text-muted)' }}>
              Select a trader from the queue to start reviewing documents.
            </div>
          )}
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Card style={{ margin: 0 }}>
            <h3 className="admin-h3">Automated Checks</h3>
            {selectedUser ? (
              [
                { label: 'ID document front uploaded', pass: selectedUser.id_file_exists },
                { label: 'ID document back uploaded', pass: selectedUser.back_file_exists },
                { label: 'Live selfie uploaded', pass: selectedUser.selfie_file_exists },
                { label: 'No quality flags raised', pass: (selectedUser.quality_flags || []).length === 0 },
                { label: 'Within SLA window', pass: selectedUser.kyc_sla_status !== 'breach' },
              ].map((check) => (
                <div key={check.label} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 0', borderBottom: '1px solid var(--rule-soft)' }}>
                  <span style={{ color: check.pass == null ? 'var(--admin-text-faint)' : check.pass ? 'var(--gain)' : 'var(--loss)' }}>
                    {check.pass == null ? '—' : check.pass ? '✓' : '✕'}
                  </span>
                  <span style={{ flex: 1, fontSize: '12.5px' }}>{check.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '.1em', textTransform: 'uppercase', color: check.pass == null ? 'var(--admin-text-faint)' : check.pass ? 'var(--gain)' : 'var(--loss)' }}>
                    {check.pass == null ? 'Unknown' : check.pass ? 'Pass' : 'Fail'}
                  </span>
                </div>
              ))
            ) : (
              <div style={{ color: 'var(--admin-text-muted)' }}>Select a trader to see checks.</div>
            )}
          </Card>

          <Card style={{ margin: 0 }}>
            <h3 className="admin-h3">Submission History</h3>
            {historyNotes.length === 0 ? (
              <div style={{ color: 'var(--admin-text-muted)' }}>No reviewer notes yet for this trader.</div>
            ) : (
              historyNotes.map((note) => (
                <div key={note.id} style={{ padding: '9px 0', borderBottom: '1px solid var(--rule-soft)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '12.5px' }}>
                    <span>{note.created_by}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--admin-text-faint)' }}>{formatDate(note.created_at)}</span>
                  </div>
                  <div style={{ fontSize: '11.5px', color: 'var(--admin-text-muted)', marginTop: '3px' }}>{note.note_text}</div>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
