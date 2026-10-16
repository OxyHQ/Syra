/**
 * Oxy's file events (OxyHQ/oxy ADR 0041 D9): Oxy tells Syra when a file Syra
 * owns or uses is deleted, trashed, restored, changes visibility, or is taken
 * down after a content claim — so Syra stops showing it at once instead of
 * serving a broken image until somebody notices.
 *
 * Received at `POST /webhooks/oxy/files` (`routes/oxyFilesWebhook.routes.ts`),
 * verified with `verifyFileEventSignature` against `OXY_FILES_WEBHOOK_SECRET`
 * (the secret Oxy shows once when the endpoint is registered), deduplicated on
 * the event id (delivery is at least once), then applied here.
 *
 * ## What each event does
 *
 * Every `image_assets` row stored as the file gets a serving status, and every
 * DTO and `/api/images/:id` treats anything but `active` as no image:
 *
 * | event | serving status |
 * |---|---|
 * | `file.blocked` | `blocked` — a takedown; nothing may serve it |
 * | `file.deleted`, `file.trashed` | `unavailable` |
 * | `file.restored`, `file.unblocked`, `file.visibility_changed` | `active` while the file is `active` and public or unlisted, `unavailable` otherwise |
 *
 * A house, room or series image is an Oxy file id with no row of its own. A
 * terminal event (`deleted`, `blocked`) clears the column — the trigger then
 * drops Syra's reference — and a reversible one leaves it: Oxy already refuses
 * to serve a trashed or private file, and keeping the id is what lets a restore
 * bring the image back.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FileEvent } from '@oxy.so/core/server';
import { getDb } from '../../db/postgres';
import { imageAssets, type ImageServingStatus } from '../../db/schema/catalog';
import { oxyFileEvents } from '../../db/schema/oxyFiles';
import { houses, rooms, series } from '../../db/schema/rooms';
import { logger } from '../../utils/logger';

/** The serving status an event leaves a file's rows in. */
export function servingStatusAfter(event: FileEvent): ImageServingStatus {
  switch (event.type) {
    case 'file.blocked':
      return 'blocked';
    case 'file.deleted':
    case 'file.trashed':
      return 'unavailable';
    case 'file.restored':
    case 'file.unblocked':
    case 'file.visibility_changed':
      return event.file.status === 'active' &&
        (event.file.visibility === 'public' || event.file.visibility === 'unlisted')
        ? 'active'
        : 'unavailable';
  }
}

/** Whether the event ends the file for good, so a direct file column lets go of it. */
function isTerminal(event: FileEvent): boolean {
  return event.type === 'file.deleted' || event.type === 'file.blocked';
}

export interface AppliedFileEvent {
  duplicate: boolean;
  imageRows: number;
  clearedColumns: number;
}

/**
 * Record and apply one verified event, in one transaction: an event is applied
 * exactly once even when Oxy delivers it twice, or two instances receive it.
 */
export async function applyFileEvent(event: FileEvent): Promise<AppliedFileEvent> {
  return getDb().transaction(async (tx) => {
    const inserted = await tx
      .insert(oxyFileEvents)
      .values({ eventId: event.id, type: event.type, fileId: event.file.id })
      .onConflictDoNothing()
      .returning({ eventId: oxyFileEvents.eventId });
    if (inserted.length === 0) return { duplicate: true, imageRows: 0, clearedColumns: 0 };

    const status = servingStatusAfter(event);
    const updated = await tx
      .update(imageAssets)
      .set({ servingStatus: status, updatedAt: sql`date_trunc('milliseconds', now())` })
      .where(
        and(
          eq(imageAssets.oxyFileId, event.file.id),
          // A legacy object found missing stays missing: no event can bring
          // back bytes that are not in Oxy.
          inArray(imageAssets.servingStatus, ['active', 'unavailable', 'blocked']),
        ),
      )
      .returning({ id: imageAssets.id });

    let clearedColumns = 0;
    if (isTerminal(event)) {
      const fileId = event.file.id;
      clearedColumns += (
        await tx
          .update(houses)
          .set({ avatarFileId: null })
          .where(eq(houses.avatarFileId, fileId))
          .returning({ id: houses.id })
      ).length;
      clearedColumns += (
        await tx
          .update(houses)
          .set({ coverImageFileId: null })
          .where(eq(houses.coverImageFileId, fileId))
          .returning({ id: houses.id })
      ).length;
      clearedColumns += (
        await tx
          .update(rooms)
          .set({ streamImageFileId: null })
          .where(eq(rooms.streamImageFileId, fileId))
          .returning({ id: rooms.id })
      ).length;
      clearedColumns += (
        await tx
          .update(series)
          .set({ coverImageFileId: null })
          .where(eq(series.coverImageFileId, fileId))
          .returning({ id: series.id })
      ).length;
    }

    logger.info('[OxyFiles] file event applied', {
      eventId: event.id,
      type: event.type,
      fileId: event.file.id,
      servingStatus: status,
      imageRows: updated.length,
      clearedColumns,
    });
    return { duplicate: false, imageRows: updated.length, clearedColumns };
  });
}
