import type { FilterQuery } from 'mongoose';

const AUDIUS_ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isAudiusCatalogEnabled(): boolean {
  return AUDIUS_ENABLED_VALUES.has(String(process.env.AUDIUS_CATALOG_ENABLED ?? '').trim().toLowerCase());
}

export function visibleCatalogFilter<T>(filter: FilterQuery<T> = {}): FilterQuery<T> {
  if (isAudiusCatalogEnabled()) return filter;
  return { ...filter, source: { $ne: 'audius' } };
}

export function playableTrackFilter<T>(filter: FilterQuery<T> = {}): FilterQuery<T> {
  return visibleCatalogFilter<T>({ ...filter, isAvailable: true });
}
