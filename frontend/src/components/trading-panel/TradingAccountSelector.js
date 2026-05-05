import React from 'react';

export default function TradingAccountSelector({ accounts, selectedAccount, setSelectedAccount, getStatusColor }) {
  if (accounts.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
      {accounts.map((account) => (
        <button
          key={account.id}
          className="btn"
          onClick={() => setSelectedAccount(account)}
          style={{
            background: selectedAccount?.id === account.id ? 'var(--accent)' : 'var(--navy-card)',
            color: selectedAccount?.id === account.id ? 'var(--navy)' : 'var(--text)',
            border: '1px solid var(--accent)',
            fontSize: '12px',
            padding: '8px 14px',
          }}
        >
          {account.account_type.toUpperCase()} ${parseFloat(account.account_size).toLocaleString()}
          <span
            style={{
              marginLeft: '6px',
              fontSize: '10px',
              color: selectedAccount?.id === account.id ? 'var(--navy)' : getStatusColor(account.status),
            }}
          >
            ● {account.status.toUpperCase()}
          </span>
        </button>
      ))}
    </div>
  );
}
