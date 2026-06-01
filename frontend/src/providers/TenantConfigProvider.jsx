import React from 'react'
import { BrandingProvider, useBranding } from '../BrandingContext'

export function TenantConfigProvider({ children }) {
  return <BrandingProvider>{children}</BrandingProvider>
}

export function useTenantConfig() {
  return useBranding()
}
