import { Badge } from '@oxyhq/bloom/badge';
import type { BadgeColor } from '@oxyhq/bloom/badge';
import type { EpisodeStatus, PodcastStatus } from '@syra/shared-types';

type AnyStatus = EpisodeStatus | PodcastStatus;

const STATUS_COLOR: Record<AnyStatus, BadgeColor> = {
  // Episode
  ready: 'success',
  processing: 'warning',
  failed: 'error',
  unavailable: 'default',
  // Podcast
  active: 'success',
  removed: 'error',
};

const STATUS_LABEL: Record<AnyStatus, string> = {
  ready: 'Ready',
  processing: 'Processing',
  failed: 'Failed',
  unavailable: 'Unavailable',
  active: 'Active',
  removed: 'Removed',
};

export function StatusBadge({ status }: { status: AnyStatus }) {
  return (
    <Badge variant="subtle" color={STATUS_COLOR[status]}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
