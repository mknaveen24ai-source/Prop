import React from 'react'
import Login from './Login'

export default function ResetPasswordPage({ onLogin }) {
  return <Login onLogin={onLogin} initialMode="reset" />
}
