declare const __LBA_BUILD_SHA256__: string | undefined;

/** Stamped by the production compiler from its complete pinned source set. No env override. */
export const BUILD_SOURCE_SHA256 = typeof __LBA_BUILD_SHA256__ === 'string' && /^[a-f0-9]{64}$/.test(__LBA_BUILD_SHA256__)
  ? __LBA_BUILD_SHA256__ : null;
