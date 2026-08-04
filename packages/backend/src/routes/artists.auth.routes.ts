import { Router } from 'express';
import {
  registerAsArtist,
  getMyArtistProfile,
  updateMyArtistProfile,
  getArtistDashboard,
  getArtistInsights,
  createArtistClaim,
  getMyContributions,
  resolveMyContribution,
  updateMyContributionSettings,
  getMyImageSuggestions,
  acceptMyImageSuggestion,
  discardMyImageSuggestion,
} from '../controllers/artists.controller';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import { singleImageUpload } from '../utils/imageUpload';

const router = Router();

// Artist management routes (authenticated) - Must be before /:id routes!
// Accept optional image file upload via multer
router.post('/register', requireAuth, singleImageUpload, registerAsArtist);
router.get('/me', requireAuth, getMyArtistProfile);
router.patch('/me', requireAuth, updateMyArtistProfile);
router.get('/me/dashboard', requireAuth, getArtistDashboard);
router.get('/me/insights', requireAuth, getArtistInsights);

// What other people published onto my profile, and whether they may at all.
// `/me/contribution-settings` is a SIBLING of `/me/contributions/:trackId` rather
// than a child, so the toggle can never be parsed as a track id.
router.get('/me/contributions', requireAuth, getMyContributions);
router.patch('/me/contributions/:trackId', requireAuth, resolveMyContribution);
router.patch('/me/contribution-settings', requireAuth, updateMyContributionSettings);

// Suggested profile photos. Resolved by `ownerOxyUserId` and reachable ONLY
// under `/me`, so a suggestion — a guess about what somebody looks like — can
// never be addressed on another artist's id, let alone rendered publicly.
router.get('/me/image-suggestions', requireAuth, getMyImageSuggestions);
router.post('/me/image-suggestions/accept', requireAuth, acceptMyImageSuggestion);
router.post('/me/image-suggestions/discard', requireAuth, discardMyImageSuggestion);

// Claiming a contributed artist profile. Opens a PENDING claim and NEVER grants —
// resolution lives on /api/artist-claims and is reviewer-only.
router.post('/:id/claim', requireAuth, createArtistClaim);

export default router;




