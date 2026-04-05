import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useToast } from '../../components/admin/AdminToast';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';

export default function AdminKYC() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();
  
  const [loading, setLoading] = useState(true);
  const [queue, setQueue] = useState([]);
  const [selectedKyc, setSelectedKyc] = useState(null);
  
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('Document unclear');
  const [rejectCustom, setRejectCustom] = useState('');
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    fetchKycQueue();
  }, []);

  const fetchKycQueue = async () => {
    setLoading(true);
    try {
      // In the old Admin.js, KYC users were pulled by fetching all traders and filtering for pending.
      // We do this to ensure compatibility without backend edits.
      const res = await adminAxios.get('/api/admin/traders');
      const allTraders = res.data || [];
      const pendingAndRecent = allTraders.filter(u => u.kyc_status === 'pending' || u.kyc_status === 'approved' || u.kyc_status === 'rejected');
      // Sort pending first, then by date
      pendingAndRecent.sort((a, b) => {
        if (a.kyc_status === 'pending' && b.kyc_status !== 'pending') return -1;
        if (a.kyc_status !== 'pending' && b.kyc_status === 'pending') return 1;
        return new Date(b.created_at) - new Date(a.created_at);
      });
      setQueue(pendingAndRecent);
      
      // Auto-select first pending item
      const firstPending = pendingAndRecent.find(u => u.kyc_status === 'pending');
      if (firstPending && !selectedKyc) setSelectedKyc(firstPending);
    } catch {
      toast.error('Failed to load KYC queue');
    }
    setLoading(false);
  };

  const handleDecision = async (status) => {
    if (!selectedKyc) return;
    
    // Construct reason if rejected
    let reason = '';
    if (status === 'rejected') {
      reason = rejectReason === 'Other' ? rejectCustom : rejectReason;
      if (!reason.trim()) {
        toast.warning('Please provide a rejection reason');
        return;
      }
    }

    try {
      await adminAxios.post('/api/admin/kyc', {
        userId: selectedKyc.id,
        status: status,
        reason: reason
      });
      
      toast.success(`KYC ${status === 'approved' ? 'Approved' : 'Rejected'} for ${selectedKyc.email}`);
      setRejecting(false);
      setRejectReason('Document unclear');
      setRejectCustom('');
      setZoom(1);
      
      // Auto advance
      const nextPendingIndex = queue.findIndex(u => u.kyc_status === 'pending' && u.id !== selectedKyc.id);
      if (nextPendingIndex !== -1) {
        setSelectedKyc(queue[nextPendingIndex]);
      } else {
        setSelectedKyc(null);
      }
      
      fetchKycQueue(); // Refresh queue state
    } catch (err) {
      toast.error(`Failed to update KYC status`);
    }
  };

  const pendingCount = queue.filter(u => u.kyc_status === 'pending').length;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - var(--admin-topbar-h) - 48px)', gap: '24px' }}>
      
      {/* LEFT PANEL: Queue (40%) */}
      <div className="admin-card" style={{ flex: '0 0 40%', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--admin-border)' }}>
          <h2 className="admin-h2" style={{ margin: 0 }}>KYC Queue</h2>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '13px' }}>{pendingCount} Pending Reviews</div>
        </div>
        
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--admin-text-faint)' }}>Loading queue...</div>
          ) : queue.length === 0 ? (
            <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--admin-text-muted)' }}>No KYC documents in queue.</div>
          ) : (
            queue.map(u => (
              <div 
                key={u.id}
                onClick={() => { setSelectedKyc(u); setRejecting(false); setZoom(1); }}
                style={{
                  padding: '16px 24px',
                  borderBottom: '1px solid var(--admin-border)',
                  borderLeft: `4px solid ${u.kyc_status === 'pending' ? 'var(--admin-warning)' : u.kyc_status === 'approved' ? 'var(--admin-success)' : 'var(--admin-danger)'}`,
                  background: selectedKyc?.id === u.id ? 'var(--admin-elevated)' : 'transparent',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '16px'
                }}
              >
                <div className="admin-avatar" style={{ width: '40px', height: '40px', fontSize: '16px' }}>
                  {(u.name || u.email || 'A').charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>{u.name || 'Unnamed'}</div>
                  <div style={{ color: 'var(--admin-text-muted)', fontSize: '12px' }}>{u.email}</div>
                  <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px', marginTop: '4px' }}>
                    Submitted: {new Date(u.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ textTransform: 'uppercase', fontSize: '11px', fontWeight: 600, color: u.kyc_status === 'pending' ? 'var(--admin-warning)' : u.kyc_status === 'approved' ? 'var(--admin-success)' : 'var(--admin-danger)' }}>
                  {u.kyc_status}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* RIGHT PANEL: Details (60%) */}
      <div className="admin-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        {selectedKyc ? (
          <>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 className="admin-h2" style={{ margin: 0 }}>{selectedKyc.name || 'Unnamed Trader'}</h2>
                <div style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>{selectedKyc.email} • {selectedKyc.country || 'Unknown Country'}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="admin-btn admin-btn-ghost" onClick={() => setZoom(z => Math.max(0.5, z - 0.2))}>-</button>
                <div style={{ border: '1px solid var(--admin-border)', padding: '0 12px', display: 'flex', alignItems: 'center', borderRadius: '4px', fontSize: '12px' }}>{Math.round(zoom * 100)}%</div>
                <button className="admin-btn admin-btn-ghost" onClick={() => setZoom(z => Math.min(3, z + 0.2))}>+</button>
              </div>
            </div>

            <div style={{ flex: 1, overflow: 'auto', background: 'var(--admin-elevated)', display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative' }}>
              {/* Fallback to endpoint path since we have to maintain Node API unchanged. 
                  In standard flow, we hit /api/admin/kyc/document/:userId */}
              {selectedKyc.kyc_status === 'pending' || selectedKyc.kyc_status === 'approved' ? (
                 <img 
                 src={`${API_URL}/api/admin/kyc/document/${selectedKyc.id}`} 
                 alt="KYC Document"
                 style={{ 
                   transform: `scale(${zoom})`, 
                   transformOrigin: 'center center',
                   transition: 'transform 0.2s',
                   maxWidth: '90%', 
                   maxHeight: '90%',
                   objectFit: 'contain',
                   boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
                 }}
                 onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }}
               />
              ) : null}
              <div style={{ display: 'none', color: 'var(--admin-text-faint)' }}>Document unavailable or empty.</div>
            </div>

            {selectedKyc.kyc_status === 'pending' && (
              <div style={{ padding: '24px', borderTop: '1px solid var(--admin-border)', background: 'var(--admin-surface)' }}>
                {!rejecting ? (
                  <div style={{ display: 'flex', gap: '16px' }}>
                    <button className="admin-btn admin-btn-success" style={{ flex: 1, padding: '16px', fontSize: '16px' }} onClick={() => handleDecision('approved')}>
                      ✅ Approve Document
                    </button>
                    <button className="admin-btn admin-btn-danger" style={{ flex: 1, padding: '16px', fontSize: '16px' }} onClick={() => setRejecting(true)}>
                      ❌ Reject KYC
                    </button>
                  </div>
                ) : (
                  <div style={{ animation: 'adminFadeIn 0.2s ease' }}>
                    <div className="admin-form-group">
                      <label className="admin-label">Rejection Reason</label>
                      <select className="admin-select" value={rejectReason} onChange={e => setRejectReason(e.target.value)}>
                        <option>Document unclear</option>
                        <option>Wrong document type</option>
                        <option>Expired document</option>
                        <option>Information mismatch</option>
                        <option>Other</option>
                      </select>
                    </div>
                    {rejectReason === 'Other' && (
                      <div className="admin-form-group">
                        <textarea className="admin-textarea" placeholder="Type custom rejection reason..." value={rejectCustom} onChange={e => setRejectCustom(e.target.value)}></textarea>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
                      <button className="admin-btn admin-btn-ghost" style={{ flex: 1 }} onClick={() => setRejecting(false)}>Cancel</button>
                      <button className="admin-btn admin-btn-danger" style={{ flex: 2 }} onClick={() => handleDecision('rejected')}>Confirm Rejection</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-faint)' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>🔍</div>
            <div style={{ fontSize: '16px' }}>Select a user from the queue to review documents.</div>
          </div>
        )}
      </div>

    </div>
  );
}
