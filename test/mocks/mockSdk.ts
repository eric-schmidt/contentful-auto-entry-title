import { vi } from 'vitest';

const mockSdk: any = {
  app: {
    onConfigure: vi.fn(),
    getParameters: vi.fn().mockReturnValueOnce({}),
    setReady: vi.fn(),
    getCurrentState: vi.fn(),
  },
  entry: {
    fields: {},
    // Taxonomy concepts live on metadata rather than fields, so a fragment
    // reading them subscribes through this pair instead of onValueChanged.
    getMetadata: vi.fn(() => undefined),
    onMetadataChanged: vi.fn(() => vi.fn()),
  },
  ids: {
    app: 'test-app',
    space: 'test-space',
    environment: 'master',
    // Taxonomy is org-scoped; the editor's concept reader needs this as a
    // plain-client default.
    organization: 'test-org',
  },
  locales: { default: 'en-US' },
  // Proxies CMA calls through the web app with the signed-in user's
  // authorization — how the editor reads concepts without shipping a key.
  cmaAdapter: { makeRequest: vi.fn() },
};

export { mockSdk };
