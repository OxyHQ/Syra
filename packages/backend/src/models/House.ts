import mongoose, { Document, Schema } from "mongoose";

// --- Enums ---

export enum HouseMemberRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  HOST = 'host',
  MEMBER = 'member'
}

/**
 * How much of a house is exposed to a user who is not a member of it.
 *
 * This is the authoritative access contract for every house-scoped read. The
 * levels form a ladder — each one removes exactly one capability from the one
 * above it — and membership (`members[].userId`) is the only thing that grants
 * access back. Role (`HouseMemberRole`) governs what a *member* may do; it
 * never widens visibility for a non-member.
 *
 * | capability                | public | invite_only | private        |
 * |---------------------------|--------|-------------|----------------|
 * | (a) see the house exists  | anyone | anyone      | members only   |
 * | (b) list its rooms/series | anyone | members     | members        |
 * | (c) join one of its rooms | anyone | members     | members        |
 * | (d) be invited            | n/a    | admin+ adds | admin+ adds    |
 *
 * Precise semantics:
 *
 * - `public` — fully open. The house appears in discovery (`GET /houses`), its
 *   detail, rooms and series are readable by any caller, and anyone may join a
 *   room in it. Membership only affects write permissions.
 *
 * - `invite_only` — discoverable but sealed. The house still appears in
 *   discovery and its detail is readable, so people can find it and request an
 *   invitation, but the member roster is withheld from non-members and rooms,
 *   series and room joins are members-only (403 — the house is known to exist,
 *   the caller simply is not in it).
 *
 * - `private` — undiscoverable. The house is absent from discovery and every
 *   house-scoped read answers 404 to a non-member, so its existence is never
 *   confirmed. Distinguishing 403 from 404 here is deliberate: a 403 on a
 *   private house would leak that the id is real.
 *
 * (d) is uniform across all three levels: joining is never self-service for a
 * non-public house — an admin or the owner adds members via
 * `POST /houses/:id/members`, which is role-gated independently of visibility.
 */
export enum HouseVisibility {
  PUBLIC = 'public',
  INVITE_ONLY = 'invite_only',
  PRIVATE = 'private'
}

// --- Interfaces ---

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
  visibility: HouseVisibility;
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
}

// --- Schema ---

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
    type: String,
    enum: Object.values(HouseVisibility),
    default: HouseVisibility.PUBLIC
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

// Discovery: the houses a non-member is allowed to see, newest first
HouseSchema.index({ visibility: 1, createdAt: -1 });

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
 * Capability (a): may this user know the house exists?
 *
 * Only `private` hides existence. A caller who fails this check must get 404,
 * never 403 — see {@link HouseVisibility}.
 */
HouseSchema.methods.canSeeHouse = function(userId: string | undefined): boolean {
  if (this.visibility !== HouseVisibility.PRIVATE) return true;
  return userId !== undefined && this.isMember(userId);
};

/**
 * Capabilities (b) and (c): may this user list the house's rooms and series,
 * and join a room in it?
 *
 * Listing and joining share one rule at every visibility level — anyone for a
 * `public` house, members only otherwise — so they share one method rather
 * than two identical ones. Callers still choose the failure code themselves:
 * 404 when {@link canSeeHouse} also fails, 403 when it does not.
 */
HouseSchema.methods.canAccessRooms = function(userId: string | undefined): boolean {
  if (this.visibility === HouseVisibility.PUBLIC) return true;
  return userId !== undefined && this.isMember(userId);
};

export default mongoose.model<IHouse>("House", HouseSchema);
