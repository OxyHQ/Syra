import { Router } from 'express';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import {
  listArtistClaims,
  listMyArtistClaims,
  resolveArtistClaim,
} from '../controllers/artists.controller';
import { requireComplianceReviewer } from '../middleware/complianceReviewer';

const router = Router();

/**
 * Claim REVIEW, on its own path rather than under `/artists`.
 *
 * Not a preference: the public artists router answers `GET /api/artists/:id` and
 * rejects anything that is not an ObjectId with a 404, and it is mounted before
 * the authenticated router. A review queue at `/api/artists/claims` would be
 * swallowed there and could never reach a handler. Submission stays on the artist
 * itself (`POST /api/artists/:id/claim`), which is a POST and so passes through.
 */

// The claimant's own view.
router.get('/mine', requireAuth, listMyArtistClaims);

// The queue and the decision. Reviewer-gated: approval is what hands somebody an
// artist page, and a contributed page carries other people's recordings.
router.get('/', requireAuth, requireComplianceReviewer, listArtistClaims);
router.post('/:id/resolve', requireAuth, requireComplianceReviewer, resolveArtistClaim);

export default router;
