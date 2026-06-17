import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export interface UserEntity {
  id: string;
  _id?: string;
  username?: string;
  name?: { full?: string; first?: string; last?: string } | string;
  handle?: string;
  avatar?: string;
  verified?: boolean;
  bio?: string;
  createdAt?: string;
  privacySettings?: Record<string, unknown>;
  links?: unknown[];
  linksMetadata?: unknown[];
}

type CachedUser = {
  data: UserEntity;
  fetchedAt: number;
  isFull: boolean;
};

interface PostWithUser {
  user?: UserEntity;
  original?: { user?: UserEntity };
  quoted?: { user?: UserEntity };
  repostedBy?: UserEntity;
}

interface UsersState {
  usersById: Record<string, CachedUser>;
  idByUsername: Record<string, string>;
  ttlMs: number;

  upsertUser: (user: Partial<UserEntity> & { id?: string; _id?: string }) => void;
  upsertMany: (users: (Partial<UserEntity> & { id?: string; _id?: string })[]) => void;
  primeFromPosts: (posts: PostWithUser[]) => void;
  getCachedById: (id: string) => UserEntity | undefined;
  getCachedByUsername: (username: string) => UserEntity | undefined;
  ensureById: (
    id: string,
    loader: (id: string) => Promise<UserEntity | null | undefined>,
    opts?: { force?: boolean }
  ) => Promise<UserEntity | undefined>;
  ensureByUsername: (
    username: string,
    loader: (username: string) => Promise<UserEntity | null | undefined>,
    opts?: { force?: boolean }
  ) => Promise<UserEntity | undefined>;
  invalidate: (idOrUsername: string) => void;
  clearAll: () => void;
}

const now = () => Date.now();

export const useUsersStore = create<UsersState>()(
  subscribeWithSelector((set, get) => ({
    usersById: {},
    idByUsername: {},
    ttlMs: 5 * 60 * 1000,

    upsertUser: (user) => {
      if (!user) return;
      const id = String(user.id ?? user._id ?? "");
      if (!id) return;
      const username = user.username ?? user.handle;
      set((state) => {
        const prev = state.usersById[id]?.data || {};
        const merged: UserEntity = { ...prev, ...user, id };
        const isFull = Boolean(user.bio || user.privacySettings || user.links || user.linksMetadata || user.createdAt);
        const next: UsersState["usersById"] = {
          ...state.usersById,
          [id]: { data: merged, fetchedAt: now(), isFull: isFull || state.usersById[id]?.isFull || false },
        };
        const nextMap = { ...state.idByUsername };
        if (username) nextMap[String(username).toLowerCase()] = id;
        return { usersById: next, idByUsername: nextMap };
      });
    },

    upsertMany: (users) => {
      if (!Array.isArray(users) || users.length === 0) return;
      set((state) => {
        const nextUsers: UsersState["usersById"] = { ...state.usersById };
        const nextMap = { ...state.idByUsername };
        const ts = now();
        for (const u of users) {
          if (!u) continue;
          const id = String(u.id ?? u._id ?? "");
          if (!id) continue;
          const username = u.username ?? u.handle;
          const prev = nextUsers[id]?.data || {};
          nextUsers[id] = { data: { ...prev, ...u, id }, fetchedAt: ts, isFull: nextUsers[id]?.isFull || false };
          if (username) nextMap[String(username).toLowerCase()] = id;
        }
        return { usersById: nextUsers, idByUsername: nextMap };
      });
    },

    primeFromPosts: (posts) => {
      if (!Array.isArray(posts) || posts.length === 0) return;
      const users: UserEntity[] = [];
      for (const p of posts) {
        if (p?.user && (p.user.id || p.user._id)) users.push(p.user);
        if (p?.original?.user) users.push(p.original.user);
        if (p?.quoted?.user) users.push(p.quoted.user);
        if (p?.repostedBy) users.push(p.repostedBy);
      }
      if (users.length) get().upsertMany(users);
    },

    getCachedById: (id) => get().usersById[id]?.data,
    getCachedByUsername: (username) => {
      const id = get().idByUsername[username?.toLowerCase?.() ?? username];
      return id ? get().usersById[id]?.data : undefined;
    },

    ensureById: async (id, loader, opts) => {
      const { ttlMs } = get();
      const cached = get().usersById[id];
      const fresh = cached && (!opts?.force) && now() - cached.fetchedAt < ttlMs;
      if (cached?.data && fresh && cached.isFull) return cached.data;
      const loaded = await loader(id).catch(() => undefined);
      if (loaded) {
        set((state) => {
          const username = loaded.username ?? loaded.handle;
          const nextUsers = {
            ...state.usersById,
            [id]: { data: { ...(state.usersById[id]?.data || {}), ...loaded, id }, fetchedAt: now(), isFull: true },
          };
          const nextMap = { ...state.idByUsername };
          if (username) nextMap[String(username).toLowerCase()] = id;
          return { usersById: nextUsers, idByUsername: nextMap };
        });
      }
      return loaded || cached?.data;
    },

    ensureByUsername: async (username, loader, opts) => {
      const key = username?.toLowerCase?.() ?? username;
      const id = get().idByUsername[key];
      if (id) return get().ensureById(id, async () => loader(username), opts);
      const loaded = await loader(username).catch(() => undefined);
      if (loaded) {
        const loadedId = String(loaded.id ?? loaded._id ?? "");
        if (loadedId) {
          set((state) => {
            const nextUsers = {
              ...state.usersById,
              [loadedId]: { data: { ...(state.usersById[loadedId]?.data || {}), ...loaded, id: loadedId }, fetchedAt: now(), isFull: true },
            };
            const nextMap = { ...state.idByUsername };
            const uname = loaded.username ?? loaded.handle;
            if (uname) nextMap[String(uname).toLowerCase()] = loadedId;
            return { usersById: nextUsers, idByUsername: nextMap };
          });
        } else {
          get().upsertUser(loaded);
        }
      }
      return loaded || undefined;
    },

    invalidate: (idOrUsername) => {
      set((state) => {
        const key = idOrUsername?.toLowerCase?.() ?? idOrUsername;
        const id = state.usersById[idOrUsername]?.data ? idOrUsername : state.idByUsername[key];
        if (!id) return state;
        const next = { ...state.usersById };
        delete next[id];
        const nextMap = { ...state.idByUsername };
        for (const uname in nextMap) {
          if (nextMap[uname] === id) delete nextMap[uname];
        }
        return { usersById: next, idByUsername: nextMap };
      });
    },

    clearAll: () => set({ usersById: {}, idByUsername: {} })
  }))
);

export const useUserById = (id?: string) =>
  useUsersStore((s) => (id ? s.usersById[id]?.data : undefined));

export const useUserByUsername = (username?: string) =>
  useUsersStore((s) => (username ? s.getCachedByUsername(username) : undefined));
