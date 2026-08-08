/**
 * `user_behavior` — declared, and still never written.
 *
 * `schema/user.ts` records that the model was built because the brief's
 * `Produces` list named it, while `docs/db/RELATIONS.md` recommends dropping it
 * outright. This port does not settle that: it moves the ONE statement that
 * touches the table and changes nothing else.
 *
 * The claim was re-checked against the tree at port time rather than inherited:
 * `grep -rn "userBehavior\|UserBehavior" src/` outside the schema, this module
 * and the model itself returns exactly one call site — the
 * `DELETE /api/profile/settings/behavior` cleanup below. No route, service,
 * script, job or test creates or updates a row, so the delete has never had
 * anything to delete.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import { userBehavior } from '../schema/user';

/**
 * Delete an account's behavior row, answering whether one existed.
 *
 * The route distinguishes the two outcomes in its message ("reset successfully"
 * vs "no personalization data to reset"), which `findOneAndDelete` answered by
 * returning the document or `null`. `returning()` answers it here without the
 * round trip a read-then-delete would need.
 */
export async function deleteUserBehavior(oxyUserId: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(userBehavior)
    .where(eq(userBehavior.oxyUserId, oxyUserId))
    .returning({ id: userBehavior.id });

  return deleted.length > 0;
}
