export function trackEvent(eventName, params = {}) {
  if (!eventName) return;

  const payload = {
    event: eventName,
    ts: Date.now(),
    ...params,
  };

  if (Array.isArray(window.dataLayer)) {
    window.dataLayer.push(payload);
  }

  if (typeof window.gtag === 'function') {
    window.gtag('event', eventName, params);
  }
}

