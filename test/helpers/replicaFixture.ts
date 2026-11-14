// Explicit synthetic replica fixture, not an Unotes Sync validator.
export const canonicalSerialize = (value: unknown): string => JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
export const withExtraFields = <T extends object>(value: T) => ({ ...value, extraFields: {} });
