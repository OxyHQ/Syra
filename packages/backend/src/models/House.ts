import mongoose, { Document, Schema } from "mongoose";

// --- Enums ---

export enum HouseMemberRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  HOST = 'host',
  MEMBER = 'member'
}

/**
 * House visibility as three ORTHOGONAL axes, not a single ladder.
 *
 * A flat level (public / invite-only / private) can only express three points on
 * one line. Real houses vary along three independent questions, and the axes let
 * every combination be meaningful by construction — e.g. `{ discovery: listed,
 * rooms: members }` is "anyone can find the house, but only members see what's
 * happening in it", which no single level could express. Each axis is one small
 * enum; each read site is one field comparison.
 *
 * Capabilities, and the axis that governs each:
 *
 *   (a) see the house exists   → `discovery`
 *   (b) list its rooms/series  → `rooms`
 *   (c) enter one of its rooms  → `rooms`
 *   (d) become a member         → `join`
 *
 * ── `discovery` — can this user learn the house exists? ──
 *   listed    (a) anyone; the house appears in `GET /houses`.
 *   unlisted  (a) anyone holding its id; absent from listings. Link-sharing, not
 *             secrecy — the id is the capability.
 *   hidden    (a) members only. A non-member gets 404 on EVERY house-scoped
 *             route, so the house's existence is never confirmed. 404 rather
 *             than 403 is deliberate and load-bearing: a 403 would tell a
 *             stranger that the id they guessed is real.
 *
 * ── `rooms` — can this user see and enter what's happening inside? ──
 *   anyone    (b)+(c) any caller who has cleared `discovery` may list the rooms
 *             and series and enter the rooms.
 *   members   (b)+(c) members only; a non-member gets 403 — the house is known
 *             to exist, the caller simply is not in it. The member roster is
 *             also withheld from non-members of a `members` house.
 *
 * ── `join` — how does a non-member become a member? ──
 *   anyone    (d) self-service via `POST /houses/:id/join`.
 *   invite    (d) an admin or owner adds them via `POST /houses/:id/members`.
 *   (A request-to-join flow is intentionally NOT a value here. A `request` value
 *   would need pending-request storage and approve/deny endpoints that do not
 *   exist; shipping it as a setting that silently behaved like `invite` would be
 *   a control that lies. It is deferred to its own task.)
 *
 * ── Composition ── Effective access is the STRICTEST applicable axis, evaluated
 * `discovery` then `rooms`. A `hidden` house is invisible to non-members
 * regardless of `rooms`, so `{ hidden, anyone }` behaves as `{ hidden, members }`
 * — well-defined, not forbidden, and it fails closed.
 *
 * Role (`HouseMemberRole`) is orthogonal to all three: it governs what a
 * *member* may DO inside the house. It never widens visibility for a non-member.
 */
export enum HouseDiscovery {
  LISTED = 'listed',
  UNLISTED = 'unlisted',
  HIDDEN = 'hidden'
}

export enum HouseRooms {
  ANYONE = 'anyone',
  MEMBERS = 'members'
}

export enum HouseJoin {
  ANYONE = 'anyone',
  INVITE = 'invite'
}

/**
 * Defaults for a new house, and the effective value for any document whose
 * `visibility` (or an individual axis) is absent. Chosen to reproduce the old
 * `isPublic: true` behaviour exactly — `join: invite` is today's only membership
 * mechanism (admin-adds), so existing behaviour is preserved with no backfill.
 */
export const DEFAULT_HOUSE_VISIBILITY: IHouseVisibility = {
  discovery: HouseDiscovery.LISTED,
  rooms: HouseRooms.ANYONE,
  join: HouseJoin.INVITE
};

// --- Interfaces ---

export interface IHouseVisibility {
  discovery: HouseDiscovery;
  rooms: HouseRooms;
  join: HouseJoin;
}

export interface IHouseMember {
  userId: string;
  role: HouseMemberRole;
  joinedAt: Date;
}

export interface IHouse extends Document {
  name: string;
  description?: string;
  avatar?: string;
  coverImage?: string;

  // Members
  members: IHouseMember[];
  createdBy: string; // userId of the original creator

  // Settings
  visibility: IHouseVisibility;
  tags: string[];

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Methods
  hasRole(userId: string, minRole: HouseMemberRole): boolean;
  getMemberRole(userId: string): HouseMemberRole | null;
  isMember(userId: string): boolean;
  canCreateRoom(userId: string): boolean;
  canSeeHouse(userId: string | undefined): boolean;
  canAccessRooms(userId: string | undefined): boolean;
  isSelfJoinable(): boolean;
}

// --- Schema ---

const HouseVisibilitySchema = new Schema<IHouseVisibility>({
  discovery: {
    type: String,
    enum: Object.values(HouseDiscovery),
    default: HouseDiscovery.LISTED
  },
  rooms: {
    type: String,
    enum: Object.values(HouseRooms),
    default: HouseRooms.ANYONE
  },
  join: {
    type: String,
    enum: Object.values(HouseJoin),
    default: HouseJoin.INVITE
  }
}, { _id: false });

const HouseMemberSchema = new Schema({
  userId: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: Object.values(HouseMemberRole),
    required: true,
    default: HouseMemberRole.MEMBER
  },
  joinedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const HouseSchema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500
  },
  avatar: {
    type: String,
    default: null,
    trim: true
  },
  coverImage: {
    type: String,
    default: null,
    trim: true
  },

  // Members
  members: {
    type: [HouseMemberSchema],
    default: []
  },
  createdBy: {
    type: String,
    required: true,
    index: true
  },

  // Settings
  visibility: {
    type: HouseVisibilitySchema,
    // A function default instantiates the subdocument so its per-axis defaults
    // apply on any document created without an explicit `visibility`.
    default: () => ({})
  },
  tags: {
    type: [String],
    default: []
  },
}, {
  timestamps: true
});

// --- Indexes ---

// Find houses by member
HouseSchema.index({ 'members.userId': 1 });

// Discovery: the houses a non-member is allowed to find, newest first.
HouseSchema.index({ 'visibility.discovery': 1, createdAt: -1 });

// Text search on name and description
HouseSchema.index({ name: 'text', description: 'text' });

// --- Methods ---

/**
 * Check if a user has a specific role or higher in the house.
 * Role hierarchy: owner > admin > host > member
 */
HouseSchema.methods.hasRole = function(userId: string, minRole: HouseMemberRole): boolean {
  const hierarchy: Record<HouseMemberRole, number> = {
    [HouseMemberRole.MEMBER]: 0,
    [HouseMemberRole.HOST]: 1,
    [HouseMemberRole.ADMIN]: 2,
    [HouseMemberRole.OWNER]: 3,
  };

  const member = this.members.find((m: IHouseMember) => m.userId === userId);
  if (!member) return false;

  return hierarchy[member.role as HouseMemberRole] >= hierarchy[minRole];
};

/**
 * Get a member's role in the house.
 */
HouseSchema.methods.getMemberRole = function(userId: string): HouseMemberRole | null {
  const member = this.members.find((m: IHouseMember) => m.userId === userId);
  return member ? member.role : null;
};

/**
 * Check if a user is a member of the house (any role).
 */
HouseSchema.methods.isMember = function(userId: string): boolean {
  return this.members.some((m: IHouseMember) => m.userId === userId);
};

/**
 * Check if a user can create rooms in this house (host, admin, or owner).
 */
HouseSchema.methods.canCreateRoom = function(userId: string): boolean {
  return this.hasRole(userId, HouseMemberRole.HOST);
};

/**
 * Capability (a) — the `discovery` axis. May this user know the house exists?
 *
 * Only `hidden` withholds existence. A caller who fails this check must get 404,
 * never 403 — see {@link HouseDiscovery}.
 */
HouseSchema.methods.canSeeHouse = function(userId: string | undefined): boolean {
  if (this.visibility.discovery !== HouseDiscovery.HIDDEN) return true;
  return userId !== undefined && this.isMember(userId);
};

/**
 * Capabilities (b) and (c) — the `rooms` axis. May this user list the house's
 * rooms and series, and enter a room in it?
 *
 * Listing and entering share one rule per axis value, so they share one method.
 * The caller chooses the failure code: 404 when {@link canSeeHouse} also fails,
 * 403 when it does not.
 */
HouseSchema.methods.canAccessRooms = function(userId: string | undefined): boolean {
  if (this.visibility.rooms === HouseRooms.ANYONE) return true;
  return userId !== undefined && this.isMember(userId);
};

/**
 * Capability (d) — the `join` axis. Does this house allow self-service joining?
 *
 * A house-level policy, independent of who is asking. The endpoint still gates
 * `canSeeHouse` (404) and already-a-member (400) around this; a `hidden` house is
 * therefore never self-joinable by a stranger, because they 404 before reaching
 * the join policy.
 */
HouseSchema.methods.isSelfJoinable = function(): boolean {
  return this.visibility.join === HouseJoin.ANYONE;
};

export default mongoose.model<IHouse>("House", HouseSchema);
