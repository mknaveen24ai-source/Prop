import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __testing, initDeviceSignature, getDeviceSignatureAsync } from './deviceSignature';

// The collector runs on every page load for every user, so the properties that
// matter are: it is stable (an unstable fingerprint silently stops matching and
// reads as "no link found"), and it never throws (it rides on the axios request
// interceptor, so a throw here would break every API call in the app).

function decode(encoded) {
  return JSON.parse(decodeURIComponent(escape(atob(encoded))));
}

describe('fastHash', () => {
  it('is deterministic', () => {
    expect(__testing.fastHash('device-signature')).toBe(__testing.fastHash('device-signature'));
  });

  it('separates similar inputs', () => {
    expect(__testing.fastHash('abc')).not.toBe(__testing.fastHash('abd'));
    expect(__testing.fastHash('')).not.toBe(__testing.fastHash('a'));
  });
});

describe('encode', () => {
  it('round-trips through base64 including unicode component values', () => {
    const payload = { v: 1, components: { webgl: 'NVIDIA — RTX™ 3060', platform: 'Win32' } };
    expect(decode(__testing.encode(payload))).toEqual(payload);
  });
});

describe('collectComponents', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('returns a component vector without throwing under jsdom', async () => {
    // jsdom has no real canvas/WebGL/audio backend, so this exercises exactly
    // the degraded path a privacy-hardened browser produces.
    const components = await __testing.collectComponents();

    expect(components).toBeTypeOf('object');
    expect(components).toHaveProperty('platform');
    expect(components).toHaveProperty('timezone');
    expect(components).toHaveProperty('screen');
  });

  it('degrades to null for a blocked probe rather than throwing', async () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => { throw new Error('canvas blocked'); };

    try {
      const components = await __testing.collectComponents();
      expect(components.canvas).toBeNull();
      expect(components.webgl).toBeNull();
      // Non-canvas probes must still be collected.
      expect(components.timezone).toBeTruthy();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  it('is stable across repeated collection', async () => {
    const first = await __testing.collectComponents();
    const second = await __testing.collectComponents();
    expect(second).toEqual(first);
  });

  it('reports the physical screen, not the window, so a resize is not a new device', async () => {
    const before = await __testing.collectComponents();
    window.innerWidth = 400;
    window.innerHeight = 800;
    const after = await __testing.collectComponents();
    expect(after.screen).toBe(before.screen);
  });
});

describe('initDeviceSignature', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('produces a decodable payload and caches it in sessionStorage', async () => {
    const encoded = await initDeviceSignature();

    // jsdom may not yield the 4 stable components the collector requires; if it
    // does produce a signature, it must be well-formed and cached.
    if (encoded) {
      const payload = decode(encoded);
      expect(payload.v).toBe(1);
      expect(payload.components).toBeTypeOf('object');
      expect(payload.components.hash).toBeUndefined();
      expect(sessionStorage.getItem('device_signature_v1')).toBe(encoded);
    } else {
      expect(encoded).toBeNull();
    }
  });

  it('memoizes — repeated calls resolve to the same value', async () => {
    const [a, b] = await Promise.all([initDeviceSignature(), initDeviceSignature()]);
    expect(a).toBe(b);
  });

  it('survives sessionStorage being unavailable', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    try {
      await expect(getDeviceSignatureAsync()).resolves.not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
