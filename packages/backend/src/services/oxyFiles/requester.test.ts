import { expect, test } from 'bun:test';
import { personalFilesRequester } from './requester';

test('uses verified effective account and session, ignoring an owner header', () => {
  const req = {
    user: { id: 'managed-org' },
    accessToken: 'verified-org-session',
    headers: { 'x-oxy-user-id': 'another-person' },
  };
  expect(personalFilesRequester(req)).toEqual({
    requesterToken: 'verified-org-session',
    accountId: 'managed-org',
  });
});
test('an account identifier or raw header cannot replace a verified session', () => {
  const req = {
    user: { id: 'person' },
    headers: { authorization: 'Bearer unverified' },
  };
  expect(() => personalFilesRequester(req)).toThrow('original signed-in requester');
});
