import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'

const ApiStateContext = createContext({
  isOnline: true
})

export function ApiStateProvider({ children }) {
  const [isOnline, setIsOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine
  )

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  const value = useMemo(() => ({ isOnline }), [isOnline])

  return (
    <ApiStateContext.Provider value={value}>
      {children}
    </ApiStateContext.Provider>
  )
}

export function useApiState() {
  return useContext(ApiStateContext)
}
