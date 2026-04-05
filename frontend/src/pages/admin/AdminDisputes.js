import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminModal from '../../components/admin/AdminModal';
import { useToast } from '../../components/admin/AdminToast';

const STATUS_OPTIONS = ['open', 'under_review', 'resolved'];

export default function AdminDisputes() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [disputes, setDisputes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [resolution, setResolution] = useState('');
  const [saving, setSaving] = useState(false);
  const [filterStatus, setFilterStatus] = useState('open');

  useEffect(() => {
    fetchDisputes();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchDisputes = async () => {
    setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/disputes');
      setDisputes(res.data || []);
    } catch {
      toast.error('Failed to load disputes');
    }
    setLoading(false);
  };

  const resolveDispute = async (status) => {
    if (!selected) return;
    setSaving(true);
    try {
      await adminAxios.post('/api/admin/disputes/resolve', {
        disputeId: selected.id,
        status,
        resolution
      });
      toast.success(`Dispute #${selected.id} marked as ${status}`);
      setShowModal(false);
      setResolution('');
      fetchDisputes();
    } catch {
      toast.error('Failed to update dispute');
    }
    setSaving(false);
  };

  const columns = [
    {
      header: 'Dispute ID', key: 'id', isMono: true,
      render: d => `#${String(d.id).padStart(5, '0')}`
    },
    {
      header: 'Trader', key: 'user_email',
      render: d => (
        <div>
          <div style={{ color: 'var(--admin-text)' }}>{d.user_email || `User #${d.user_id}`}</div>
          {d.account_id && <div style={{ fontSize: '11px', color: 'var(--admin-text-faint)' }}>Acc #{d.account_id}</div>}
        </div>
      )
    },
    {
      header: 'Type', key: 'type',
      render: d => <span style={{ fontWeight: 500 }}>{d.type || 'General'}</span>
    },
    { header: 'Subject', key: 'subject', render: d => d.subject || d.title || '—' },
    {
      header: 'Status', key: 'status',
      render: d => <AdminBadge status={d.status === 'open' ? 'danger' : d.status === 'under_review' ? 'warning' : 'success'} label={d.status} />
    },
    {
      header: 'Opened', key: 'created_at',
      render: d => new Date(d.created_at).toLocaleDateString()
    },
  ];

  const getRowActions = (d) => [
    { label: 'Review Dispute', icon: '⚖️', onClick: () => { setSelected(d); setResolution(d.resolution || ''); setShowModal(true); } },
    { label: 'Mark Under Review', icon: '🔍', onClick: async () => {
      try {
        await adminAxios.post('/api/admin/disputes/resolve', { disputeId: d.id, status: 'under_review' });
        toast.success('Dispute marked under review');
        fetchDisputes();
      } catch { toast.error('Failed'); }
    }},
  ];

  const filtered = filterStatus === 'All'
    ? disputes
    : disputes.filter(d => d.status === filterStatus);

  return (
    <>
      <div style={{ marginBottom: '24px' }}>
        <h1 className="admin-h1">Dispute Management</h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>Handle trader complaints, rule violation contests, and trade reviews.</p>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap' }}>
        {['All', ...STATUS_OPTIONS].map(s => (
          <button
            key={s}
            className={`admin-filter-chip ${filterStatus === s ? 'active' : ''}`}
            onClick={() => setFilterStatus(s)}
          >
            {s.replace('_', ' ')}
            {s !== 'All' ? ` (${disputes.filter(d => d.status === s).length})` : ''}
          </button>
        ))}
      </div>

      <div className="admin-card" style={{ padding: 0 }}>
        <AdminDataTable
          columns={columns}
          data={filtered}
          loading={loading}
          rowActions={getRowActions}
          emptyMessage="No disputes found"
          emptyIcon="⚖️"
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
        />
      </div>

      <AdminModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={`Dispute #${String(selected?.id || '').padStart(5, '0')}`}
        size="lg"
        footer={<>
          <button className="admin-btn admin-btn-ghost" onClick={() => setShowModal(false)}>Close</button>
          <button className="admin-btn admin-btn-warning" disabled={saving} onClick={() => resolveDispute('under_review')}>Mark Under Review</button>
          <button className="admin-btn admin-btn-success" disabled={saving || !resolution.trim()} onClick={() => resolveDispute('resolved')}>Mark Resolved</button>
        </>}
      >
        {selected && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Trader</div>
                <div style={{ color: 'var(--admin-text)', fontWeight: 500, marginTop: '4px' }}>{selected.user_email}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Account</div>
                <div className="admin-td-mono" style={{ marginTop: '4px' }}>#{selected.account_id || 'N/A'}</div>
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Subject</div>
                <div style={{ color: 'var(--admin-text)', fontWeight: 600, fontSize: '16px', marginTop: '4px' }}>
                  {selected.subject || selected.title || '—'}
                </div>
              </div>
            </div>

            {(selected.description || selected.message) && (
              <div className="admin-form-group">
                <label className="admin-label">Trader's Statement</label>
                <div style={{
                  background: 'var(--admin-bg)', border: '1px solid var(--admin-border)',
                  borderRadius: '8px', padding: '16px', color: 'var(--admin-text)',
                  fontSize: '13px', lineHeight: '1.6', whiteSpace: 'pre-wrap'
                }}>
                  {selected.description || selected.message}
                </div>
              </div>
            )}

            <div className="admin-form-group">
              <label className="admin-label">Admin Resolution Notes</label>
              <textarea
                className="admin-textarea"
                placeholder="Enter your resolution decision, reason, and any actions taken..."
                value={resolution}
                onChange={e => setResolution(e.target.value)}
                rows={4}
              />
            </div>
          </div>
        )}
      </AdminModal>
    </>
  );
}
