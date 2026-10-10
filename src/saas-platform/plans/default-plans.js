// Seed data. Prices are minor units (cents, USD). Entitlements are enforced server-side.
// Limit value -1 means unlimited. overage rates are per call-minute, in cents.
export const DEFAULT_PLANS = [
  { code: 'trial', name: 'Free Trial', prices: [], entitlements: { callMinutes: 30, agents: 1, concurrentCalls: 1, phoneNumbers: 0, storageBytes: 50e6, apiRequestsPerMonth: 5000, hardCap: true, overageCentsPerMinute: 0 } },
  { code: 'starter', name: 'Starter', prices: [{ interval: 'MONTH', amountMinor: 4900 }, { interval: 'YEAR', amountMinor: 49000 }], entitlements: { callMinutes: 300, agents: 3, concurrentCalls: 3, phoneNumbers: 1, storageBytes: 500e6, apiRequestsPerMonth: 50000, hardCap: false, overageCentsPerMinute: 18 } },
  { code: 'growth', name: 'Growth', prices: [{ interval: 'MONTH', amountMinor: 19900 }, { interval: 'YEAR', amountMinor: 199000 }], entitlements: { callMinutes: 1500, agents: 15, concurrentCalls: 10, phoneNumbers: 5, storageBytes: 5e9, apiRequestsPerMonth: 250000, hardCap: false, overageCentsPerMinute: 14 } },
  { code: 'business', name: 'Business', prices: [{ interval: 'MONTH', amountMinor: 69900 }, { interval: 'YEAR', amountMinor: 699000 }], entitlements: { callMinutes: 6000, agents: 50, concurrentCalls: 30, phoneNumbers: 20, storageBytes: 25e9, apiRequestsPerMonth: 1000000, hardCap: false, overageCentsPerMinute: 11 } },
  { code: 'enterprise', name: 'Enterprise', prices: [], entitlements: { callMinutes: -1, agents: -1, concurrentCalls: 100, phoneNumbers: -1, storageBytes: -1, apiRequestsPerMonth: -1, hardCap: false, overageCentsPerMinute: 0 } },
];
