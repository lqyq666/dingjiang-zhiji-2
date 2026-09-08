const defaultLocalWebOrigins = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3010",
  "http://localhost:3010",
];

export const localWebOrigins = (configuredOrigin?: string): Set<string> => {
  const origins = new Set(defaultLocalWebOrigins);
  const normalized = configuredOrigin?.trim();
  if (normalized) origins.add(normalized);
  return origins;
};
