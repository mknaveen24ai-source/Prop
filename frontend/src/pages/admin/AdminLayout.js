import React, { useState, useEffect, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import axios from 'axios';
import './admin.css';
import { AdminToastProvider } from '../../components/admin/AdminToast';
import AdminSidebar from '../../components/admin/AdminSidebar';
import AdminTopBar from '../../components/admin/AdminTopBar';
// If your App.js exposes a global socket, you can pass it via context or import it.
// For now, we'll keep the socket prop placeholder to connect securely.

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';
const adminAxios = axios.create({ baseURL: API_URL, withCredentials: true });

function AdminLoginScreen({ onLoginSuccess }) {
  const [step, setStep] = useState('password'); // 'password' | 'totp'
  const [password, setPassword] = useState('');
  const [pre2faToken, setPre2faToken] = useState('');
  const [totpDigits, setTotpDigits] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Rules of Hooks: each ref must be declared at the top level, not in a loop/callback
  const tr0 = useRef(null);
  const tr1 = useRef(null);
  const tr2 = useRef(null);
  const tr3 = useRef(null);
  const tr4 = useRef(null);
  const tr5 = useRef(null);
  const totpRefs = [tr0, tr1, tr2, tr3, tr4, tr5];

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await adminAxios.post('/api/admin/login', { password });
      if (res.data.requires2FA) {
        setPre2faToken(res.data.pre2faToken);
        setStep('totp');
        setTimeout(() => totpRefs[0]?.current?.focus(), 50);
      } else {
        onLoginSuccess();
      }
    } catch (err) {
      setErrorMsg('Invalid admin password');
    }
    setLoading(false);
  };

  const handleTotpVerify = async (code) => {
    setLoading(true);
    setErrorMsg('');
    try {
      await adminAxios.post('/api/admin/2fa/validate', 
        { token: code },
        { headers: { Authorization: `Bearer ${pre2faToken}` } }
      );
      onLoginSuccess();
    } catch (err) {
      setErrorMsg(err?.response?.data?.error || 'Invalid code');
    }
    setLoading(false);
  };

  const handleTotpInput = (index, value) => {
    const d = value.replace(/\D/g, '').slice(0, 1);
    const next = [...totpDigits];
    next[index] = d;
    setTotpDigits(next);
    
    if (d && index < 5) totpRefs[index + 1].current?.focus();
    if (d && index === 5) {
      const code = [...next.slice(0, 5), d].join('');
      if (code.length === 6) handleTotpVerify(code);
    }
  };

  const handleTotpKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !totpDigits[index] && index > 0) {
      totpRefs[index - 1].current?.focus();
    }
    if (e.key === 'Enter') {
      const code = totpDigits.join('');
      if (code.length === 6) handleTotpVerify(code);
    }
  };

  return (
    <div className="admin-layout" style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div className="admin-card" style={{ width: '400px', padding: '40px', position: 'relative', zIndex: 10 }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'var(--admin-accent-bg)', color: 'var(--admin-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: '24px' }}>
            {step === 'totp' ? '🔐' : '⚡'}
          </div>
          <h1 className="admin-h1">Admin Portal</h1>
          <p style={{ color: 'var(--admin-text-muted)' }}>
            {step === 'totp' ? 'Enter your authenticator code' : 'Prop Firm Control Centre'}
          </p>
        </div>

        {errorMsg && (
          <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: 'var(--admin-danger)', padding: '10px', borderRadius: '6px', marginBottom: '16px', fontSize: '13px', textAlign: 'center' }}>
            {errorMsg}
          </div>
        )}

        {step === 'password' && (
          <form onSubmit={handlePasswordSubmit}>
            <div className="admin-form-group">
              <label className="admin-label">Admin Password</label>
              <input 
                type="password" 
                className="admin-input" 
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
            <button type="submit" className="admin-btn admin-btn-primary" style={{ width: '100%', marginTop: '8px' }} disabled={loading}>
              {loading ? 'Authenticating...' : 'Secure Login'}
            </button>
          </form>
        )}

        {step === 'totp' && (
          <div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', margin: '24px 0' }}
                 onPaste={e => {
                   const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
                   if (pasted.length === 6) { 
                     setTotpDigits(pasted.split('')); 
                     handleTotpVerify(pasted);
                   }
                 }}>
              {totpDigits.map((d, i) => (
                <input
                  key={i}
                  ref={totpRefs[i]}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={e => handleTotpInput(i, e.target.value)}
                  onKeyDown={e => handleTotpKeyDown(i, e)}
                  style={{
                    width: '44px', height: '52px', textAlign: 'center',
                    fontSize: '24px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700,
                    background: 'var(--admin-bg)',
                    border: `1px solid ${d ? 'var(--admin-accent)' : 'var(--admin-border)'}`,
                    borderRadius: '8px', color: 'var(--admin-text)', outline: 'none',
                  }}
                />
              ))}
            </div>
            <button 
              className="admin-btn admin-btn-primary" 
              onClick={() => handleTotpVerify(totpDigits.join(''))}
              disabled={loading || totpDigits.join('').length < 6}
              style={{ width: '100%' }}
            >
              {loading ? 'Verifying...' : 'Verify Code'}
            </button>
            <button 
              onClick={() => setStep('password')}
              className="admin-btn admin-btn-ghost" 
              style={{ width: '100%', marginTop: '12px' }}
            >
              ← Back to password
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


export default function AdminLayout() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [isSidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isMobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Setup interceptors to catch 401s within the admin panel and logout
  useEffect(() => {
    const interceptor = adminAxios.interceptors.response.use(
      res => res,
      err => {
        if (err.response?.status === 401 || err.response?.status === 403) {
          setIsAuthenticated(false);
        }
        return Promise.reject(err);
      }
    );
    return () => adminAxios.interceptors.response.eject(interceptor);
  }, []);

  useEffect(() => {
    const verifySession = async () => {
      try {
        await adminAxios.get('/api/admin/overview');
        setIsAuthenticated(true);
      } catch (err) {
        setIsAuthenticated(false);
      } finally {
        setChecking(false);
      }
    };
    verifySession();
  }, []);

  if (checking) {
    return <div className="admin-layout" style={{ justifyContent: 'center', alignItems: 'center' }}>Connecting secure tunnel...</div>;
  }

  if (!isAuthenticated) {
    return <AdminLoginScreen onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  return (
    <AdminToastProvider>
      <div className="admin-layout">
        <AdminSidebar 
          isCollapsed={isSidebarCollapsed} 
          onToggleCollapse={() => setSidebarCollapsed(!isSidebarCollapsed)}
          isMobileOpen={isMobileMenuOpen}
          onMobileClose={() => setMobileMenuOpen(false)}
        />
        
        <div className="admin-main-wrapper">
          <AdminTopBar onMobileMenuClick={() => setMobileMenuOpen(true)} />
          <main className="admin-content" id="admin-scroll-container">
            {/* The Outlet renders whatever child route is active */}
            <Outlet context={{ adminAxios }} />
          </main>
        </div>
      </div>
    </AdminToastProvider>
  );
}
