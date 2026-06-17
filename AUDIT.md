# Syra — Auditoría exhaustiva del monorepo

> Fecha: 2026-06-17 — Alcance: `packages/backend`, `packages/frontend`, `packages/shared-types`, raíz del repo, deploys, docs.
> Metodología: lectura archivo por archivo + grep dirigido. Severidades: **CRÍTICO** (seguridad / build roto / código muerto que confunde deploys), **ALTO** (deuda estructural que bloquea evolución), **MEDIO** (calidad / DX / performance), **BAJO** (ruido).
> Referencias usan `path:line`.

---

## 0. Resumen ejecutivo

El monorepo tiene una base sólida (workspaces bun, shared-types compartido, ECS para backend, Cloudflare Pages para frontend) pero arrastra tres clases de problemas que hay que cortar de raíz:

1. **Seguridad rota en sockets**: el handshake confía en un `userId` que el cliente declara, sin validar token contra `OxyServices` (`packages/backend/src/sockets/playerSocket.ts:22-33`, `playlistSocket.ts:18-29`). Cualquiera puede emitir eventos como otro usuario.
2. **Validación runtime ausente**: cero `zod` en backend, un único schema legacy en frontend (`packages/frontend/types/validation.ts`). Controllers, sockets, env, persistencia en storage y respuestas API confían en TypeScript en runtime, que es ficción.
3. **Configuración de deploy inconsistente**: el repo dice ECS (`AGENTS.md`) pero conserva `vercel.json` raíz apuntando a un script inexistente, `packages/backend/vercel.json` apuntando a un entry inexistente, y `.do/app.yaml` para DigitalOcean. Sumado a ~15 `.md` post-mortem y ramas muertas en `store/`, el repo no representa la realidad.

A continuación, el desglose por carpeta. Cada hallazgo tiene severidad, ubicación y la solución que se aplicará en el refactor.

### Matriz de prioridades

| Sev      | Categoría             | Items |
| -------- | --------------------- | ----- |
| CRÍTICO  | Seguridad sockets     | 2     |
| CRÍTICO  | Build / deploy        | 6     |
| CRÍTICO  | Duplicación de tipos  | 3     |
| CRÍTICO  | Logger / console.log  | 2     |
| CRÍTICO  | Tooling (TS, configs) | 3     |
| ALTO     | Validación zod        | 5     |
| ALTO     | Estado frontend       | 4     |
| ALTO     | Duplicación servicios | 3     |
| ALTO     | `any` masivos         | 5     |
| ALTO     | Modelos / DB          | 2     |
| MEDIO    | Performance metrics   | 1     |
| MEDIO    | Docs basura           | 12    |
| MEDIO    | Hidratación storage   | 2     |
| MEDIO    | `require()` runtime   | 1     |
| BAJO     | Ruido cosmético       | ~10   |

Total: ~64 items. El refactor los agrupa en 5 fases (ver §15).

---

## 1. Raíz del repositorio

### 1.1 Deploys obsoletos (CRÍTICO)

- `vercel.json` (raíz) — apunta a `scripts/build-for-vercel.js`, archivo **inexistente**. `AGENTS.md` documenta deploy real en **AWS ECS** + Cloudflare Pages. **Borrar**.
- `packages/backend/vercel.json` — apunta a `src/server.ts` (el entry real es `packages/backend/server.ts`). Si alguien lo importara desde Vercel, romperia. **Borrar**.
- `.do/app.yaml` — config DigitalOcean App Platform (referencia `OxyHQ/Syra`, Spaces en `ams`). Conflictúa con ECS us-west-2. **Borrar carpeta `.do/` entera**.
- `scripts/setup-do-app.sh` — bootstrap DO, sin uso. **Borrar**.
- `docs/VERCEL_DEPLOYMENT.md`, `docs/DIGITALOCEAN_DEPLOYMENT.md` — documentación de deploys que ya no existen. **Borrar**.

### 1.2 Archivos basura en raíz (CRÍTICO bajo "ruido que confunde")

- `CLAUDE.md` (11 bytes) — stub. **Borrar**.
- `GEMINI.md` (11 bytes) — stub. **Borrar**.
- `FIX_ENTRY_POINT.md`, `WEB_ENTRY_POINT_FIX.md` — post-mortems de un bug ya resuelto. **Borrar**.

### 1.3 Archivos mal ubicados (CRÍTICO)

- `google-services.json` (raíz) — debe vivir en `packages/frontend/` junto a `app.json`. Su presencia en raíz hace que cualquier herramienta de Android (EAS, expo) que escanea cwd lo descubra fuera de contexto y rompe el build determinista.  **Mover** a `packages/frontend/google-services.json` y referenciarlo desde `app.json` con path relativo a `packages/frontend`.
- `nativewind-env.d.ts` (raíz, 245 bytes) — autogenerado por NativeWind; pertenece a `packages/frontend` (donde ya existe otra copia tracked). **Borrar la copia raíz** y agregar `nativewind-env.d.ts` al `.gitignore` global porque NativeWind lo regenera.
- `tsconfig.tsbuildinfo` raíz (483 KB) — debería estar en `.gitignore` pero está siendo trackeado (no aparece en `git ls-files` realmente; ya está en `.gitignore`). **Verificar `git rm --cached`** si llegara a estar tracked.

### 1.4 `tsconfig.json` raíz incoherente (CRÍTICO tooling)

`tsconfig.json:1-30`:

```jsonc
{
  "extends": "expo/tsconfig.base",        // ← fuga de deps frontend al monorepo
  "compilerOptions": {
    "composite": true,                     // ← project references mode
    "declaration": true,                   // ← emite .d.ts
    "noEmit": true                         // ← contradice composite+declaration
  }
}
```

Tres problemas:

1. `extends: "expo/tsconfig.base"` ata el tsconfig raíz a una dep que solo necesita el frontend. Lo correcto es que **cada paquete extienda lo suyo** y el raíz sea minimalista (target ES2022, moduleResolution Bundler, strict, sin extends externo).
2. `composite + declaration + noEmit` es contradictorio. `composite` requiere `noEmit: false` para project references. **Decisión**: usar **solución compuesta**: raíz como "solution tsconfig" con `references` a cada paquete, sin emitir nada (`noEmit: true`, sin `composite`, sin `declaration`).
3. `tsconfig.tsbuildinfo` raíz (483 KB) tiene sentido sólo con `composite`. Con la nueva config desaparece.

### 1.5 `package.json` raíz (BAJO/MEDIO)

- Convive con `react-native`, `react-native-worklets`, `@expo/vector-icons` listados en raíz junto con `bun` workspaces — son deps del frontend filtradas a raíz porque algún tooling antiguo (Metro, EAS) las requería allí. Hoy con `bunfig.toml` (`linker = "hoisted"`) **deberían vivir solo en `packages/frontend/package.json`**. Mover y verificar que `bun install` sigue resolviendo.
- `"overrides"` son razonablemente amplios. Mantener pero auditar uno a uno tras refactor.

### 1.6 Scripts globales (ALTO)

`package.json` raíz expone scripts derivados (`build:shared-types`, `build:backend`, `build:frontend`, `dev:*`, `test`, `typecheck`, `lint`). Verificar tras refactor que:
- `bun run typecheck` falla con cualquier `any` introducido (subir strictness en cada paquete).
- `bun test` corre los tests de los 3 paquetes (`bun test --filter '*'`).


---

## 2. `packages/backend`

### 2.1 `server.ts` (entry point) — CRÍTICO

`packages/backend/server.ts` concentra varios problemas:

#### 2.1.1 CORS artesanal (CRÍTICO)
Líneas ~80-145: middleware CORS escrito a mano leyendo `req.headers.origin`, mantiene una lista de orígenes hardcoded, emite headers manualmente. El paquete `cors` ya está en `dependencies`. **Reemplazar todo el bloque por** `app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }))` con `ALLOWED_ORIGINS` viniendo de `env.ts` (zod).

#### 2.1.2 Rate limiter importado pero NO montado (CRÍTICO seguridad)
`server.ts:37` importa `rateLimiter, bruteForceProtection` desde `./src/middleware/security`. **Nunca se invoca `app.use(rateLimiter)`**. Resultado: rate limiting global está muerto en producción. **Montar** `app.use(rateLimiter)` antes de las rutas y `app.use('/auth', bruteForceProtection)` donde corresponda.

#### 2.1.3 `require()` runtime (MEDIO)
Líneas ~178-180, ~212, ~434-436: usa `require('./src/...')` para lazy-loading. Con env-zod cargado en bootstrap y orden de imports correcto, no hace falta. **Convertir a `import`** estáticos al tope del archivo.

#### 2.1.4 `dotenv` cargado in-place (MEDIO)
`server.ts:5`: `require('dotenv').config()`. Aceptable, pero **mejor**: crear `src/config/env.ts` que llame `dotenv.config()` y exporte un objeto validado con zod. Server.ts haría `import { env } from './src/config/env';` como **primera línea**.

#### 2.1.5 Build script silencia errores (CRÍTICO)
`packages/backend/package.json`:
```json
"build": "tsc -p tsconfig.build.json || true"
```
El `|| true` enmascara errores TS en CI. **Quitar `|| true`**. Si hay errores reales, corregirlos primero.

### 2.2 `src/middleware/` — CRÍTICO duplicación

#### 2.2.1 `AuthRequest` duplicado
- `src/middleware/auth.ts` exporta `AuthRequest` y `requireAuth`. Usado por **23 archivos** (controllers y routes).
- `src/types/auth.ts` exporta otro `AuthRequest` casi idéntico. Usado solo por `src/middleware/security.ts`.

**Decisión**: `src/middleware/auth.ts` es la fuente canónica. **Borrar `src/types/auth.ts`** y actualizar `security.ts` para importar de `middleware/auth.ts`.

#### 2.2.2 Rate limiter duplicado
- `src/middleware/security.ts` — rate limiter global + bruteForceProtection (con Redis store opcional). **Nunca montado en server.ts**.
- `src/middleware/rateLimiter.ts` — otro rate limiter "feed-specific" más simple. **Nunca importado en ninguna parte**.

`rateLimiter.ts` es código muerto puro. **Borrar `src/middleware/rateLimiter.ts`**, mantener solo `security.ts` y montarlo (ver 2.1.2).

#### 2.2.3 `rate-limit-redis` instalado pero `rateLimitStore.ts` es store custom (BAJO)
`packages/backend/package.json` lista `rate-limit-redis`. Pero `src/middleware/rateLimitStore.ts` implementa un store custom contra `redis` directo. **Decisión**: borrar la dependencia `rate-limit-redis` (no se usa) y mantener el store custom (que sí está integrado con `rateLimiter` de `security.ts`).

#### 2.2.4 `middleware/performance.ts` (MEDIO)
Mantiene métricas en memoria (`requestCounts`, latencias). Se pierden al reiniciar. Está bien para dev, pero en prod debería **publicarse a CloudWatch** (puttable, o vía OpenTelemetry). Marcar como fase 3.

### 2.3 `src/sockets/` — CRÍTICO seguridad

#### 2.3.1 `playerSocket.ts:22-33`
```ts
io.on('connection', (socket) => {
  const userId = socket.handshake.auth?.userId; // ← cliente declara su userId
  if (!userId) return socket.disconnect();
  socket.data.userId = userId;
  // ... join room, emit, etc.
});
```
**Vulnerabilidad**: cualquiera abre socket con `{ auth: { userId: 'victim_id' } }` y emite eventos como esa víctima.

**Fix**: el cliente debe enviar `{ auth: { token } }` con el bearer JWT. El handshake llama a `OxyServices.verifyToken(token)` (instancia única de `packages/backend/src/lib/oxyServices.ts`, a crear) y deriva `socket.data.user = { id, ... }` solo si verifica.

Además, los payloads recibidos por socket events (`'queue:update'`, `'play'`, etc.) deben validarse con zod schemas (compartidos vía `shared-types`).

#### 2.3.2 `playlistSocket.ts:18-29`
Idéntico problema. Mismo fix.

#### 2.3.3 `postSocket.ts` (CRÍTICO código muerto)
**Nunca se importa en `server.ts`**. Es código de un feature "posts" que no existe en Syra (es legacy de Mention). **Borrar `src/sockets/postSocket.ts`**.

### 2.4 `src/controllers/` — ALTO patrón repetido

20 archivos de controllers. Cada función exportada repite literalmente:

```ts
if (!isDatabaseConnected()) return res.status(503).json({ error: 'Database unavailable' });
if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
const body = req.body; // ← cero validación
```

**Fix**:

1. Helper `withDb(handler)` en `src/utils/withDb.ts` que devuelva `(req, res, next) => isDatabaseConnected() ? handler(req,res,next) : res.status(503)...`.
2. `requireAuth` ya existe (`middleware/auth.ts`), montar a nivel route.
3. Middleware `validate({ params?, query?, body? }: { params?: ZodSchema, query?: ZodSchema, body?: ZodSchema })` en `src/middleware/validate.ts` que devuelve 400 con el `ZodError.format()` si falla.
4. Schemas en `packages/shared-types/` (e.g. `playlistCreateBodySchema`) + `z.infer` para el tipo TS.

Controllers más grandes (orden de impacto):
- `playlists.controller.ts` (642 líneas) — el más urgente.
- `tracks.controller.ts`
- `library.controller.ts`
- `queue.controller.ts`
- `stream.controller.ts`
- `albums.controller.ts`, `artists.controller.ts`, `browse.controller.ts`, `search.controller.ts`, `sources.controller.ts`, `lyrics.controller.ts`, `audio.controller.ts`, `copyright.controller.ts`, `images.controller.ts`, `musicPreferences.controller.ts`.

### 2.5 `src/models/` — ALTO

- **`Playlist.ts`** tiene `visibility: 'public'|'private'|'unlisted'` **y** `isPublic: boolean`. Redundante y propenso a desincronía. **Decisión**: mantener `visibility` (más expresivo), **borrar `isPublic`** y migrar el código que lo lea a `visibility === 'public'`. Migración de datos: backfill `isPublic = (visibility === 'public')` en una vez y luego `$unset` el campo.
- **`Track.ts`**: revisar indexes. Confirmados (`{ oxyArtistId: 1 }`, `{ slug: 1, artistSlug: 1 } unique`). Falta probablemente `{ createdAt: -1 }` para feeds "new releases".
- **`PlaylistTrack.ts`**: bien, tiene `{ playlistId, order } unique` y `{ playlistId, trackId }`. OK.
- **`RecentlyPlayed.ts`**: bien, `{ oxyUserId, playedAt: -1 }`. OK.
- **`UserLibrary.ts`** (Library.ts): `oxyUserId` único + arrays con `index: true` sobre los items. Para arrays grandes, ese `index: true` puede ser ruidoso. Aceptable a esta escala. Mantener.

### 2.6 `src/utils/`

#### 2.6.1 `logger.ts` (CRÍTICO)
27 líneas de `console.log` con tags `[INFO]`, `[ERROR]`. Sin niveles configurables, sin estructura JSON. **Migrar a `pino`**:

```ts
import pino from 'pino';
export const logger = pino({
  level: env.LOG_LEVEL,
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});
```

Y reemplazar todos los call sites (`rg "logger\." packages/backend` da el inventario exacto).

#### 2.6.2 `auth.ts` (`getAuthenticatedUserId`) (BAJO)
Helper correcto pero infrautilizado: muchos controllers hacen `req.user?.id` directo. Después del refactor de `withDb` + `requireAuth`, este helper debería ser **el único punto** de lectura del userId.

#### 2.6.3 `redis.ts` + `redisHelpers.ts` (OK)
Bien estructurado. Mantener.

#### 2.6.4 `database.ts` (OK)
Conexión Mongo con backoff exponencial. Mantener. Después de env-zod, leer `env.MONGODB_URI` en vez de `process.env.MONGODB_URI`.

#### 2.6.5 `metrics.ts`, `mongoose-gridfs.ts`, `imageUpload.ts`, `imageColors.ts`, etc. (OK)
Mantener.

### 2.7 `src/services/` (OK estructura, ALTO en algunas piezas)

Bien organizado en subcarpetas (`catalog`, `compliance`, `ingest`, `lyrics`, `playback`, `premium`, `sources`, `stream`). Sin hallazgos críticos. Refactor menor:

- `services/sources/AudiusConnector.ts` y `CcConnector.ts`: validar respuestas externas con zod (defensa en profundidad ante cambios de API upstream).

### 2.8 `src/config/` (CRÍTICO incompleto)

Solo contiene `s3.config.ts`. **Falta `env.ts`** (validación zod de todas las env vars). Crear:

```ts
// src/config/env.ts
import { z } from 'zod';
import 'dotenv/config';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  MONGODB_URI: z.string().url(),
  REDIS_URL: z.string().url().optional(),
  OXY_API_URL: z.string().url(),
  S3_BUCKET: z.string(),
  S3_REGION: z.string(),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  ALLOWED_ORIGINS: z.string().transform(s => s.split(',').map(x => x.trim())),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
  // ... resto
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
```

Y reemplazar **todos** los `process.env.X` con `env.X` (excepto el bootstrap del propio env.ts).

### 2.9 `src/test/` (OK)

30 tests. Cobertura razonable en services y controllers. Mantener; añadir tests para los nuevos middlewares (`validate`, `withDb`).


---

## 3. `packages/frontend`

### 3.1 `app/` (Expo Router) — OK estructura

12 entradas top-level (`index.tsx`, `library.tsx`, `search.tsx`, `settings.tsx`, `_layout.tsx`, `+not-found.tsx`, `create-playlist.tsx` y carpetas `album/`, `artist/`, `library/`, `copyright/`, `u/`, `playlist/`). Sin hallazgos estructurales. Hallazgos puntuales en `_layout.tsx` (3.7).

### 3.2 `stores/` vs `store/` — ALTO

Existen **dos** carpetas:

- `packages/frontend/stores/` — **canónica**, 12 archivos Zustand modernos: `playerStore.ts` (703 líneas), `queueStore.ts`, `usersStore.ts`, `linksStore.ts`, `musicPreferencesStore.ts`, `privacyStore.ts`, `uiStore.ts`, `videoMuteStore.ts`, subcarpeta `playback/`, helpers + tests.
- `packages/frontend/store/` — **legacy**, 4 archivos:
  - `appearanceStore.ts` — VIVO (4 referencias: `_layout.tsx`, `appInitializer.ts`, settings screen, `useServerAppearanceSync.ts`).
  - `profileStore.ts` — MUERTO (solo se referencia a sí mismo).
  - `trendsStore.ts` — MUERTO (solo se referencia a sí mismo, además es legacy de Mention).
  - `analyticsStore.ts` — MUERTO (solo se referencia a sí mismo).

**Decisión**:
1. **Borrar** `profileStore.ts`, `trendsStore.ts`, `analyticsStore.ts`.
2. **Migrar** `appearanceStore.ts` a **React Query** con persister (la preferencia del usuario son `colorScheme`, `accentColor`, etc., perfectamente cacheable como query con backend authoritative y override local). Hook `useAppearanceSettings()` que use `useQuery` + `useMutation`, con persister `@tanstack/query-async-storage-persister`.
3. **Borrar la carpeta `store/`** entera tras la migración.

### 3.3 `usersStore.ts` — ALTO

`packages/frontend/stores/usersStore.ts` tiene **21 `any`** y mantiene cache de usuarios manualmente. Es exactamente el use-case de React Query (recursos remotos con cache, invalidación, deduplicación). **Migrar a hooks**:

- `useUser(userId)` → `useQuery({ queryKey: ['user', userId], queryFn: ... })`
- `useUsers(userIds)` → `useQueries` o `useQuery` por lote.
- `useUpdateUserProfile()` → `useMutation` con invalidación.

Y **borrar `usersStore.ts`**. Esto elimina los 21 `any` automáticamente porque las respuestas vendrán tipadas desde `shared-types`.

### 3.4 `playerStore.ts` y `stores/playback/` — MEDIO

703 líneas. Es el corazón del playback. Hallazgos:

- Anti-pattern de uso: 4 componentes hacen `const { ... } = usePlayerStore()` desestructurando todo (`PlayerBar.tsx`, `MobilePlayerBar.tsx`, `NowPlaying.tsx`, `app/_layout.tsx`). Esto causa re-renders del componente entero cuando cambia **cualquier** campo del store. **Fix**: usar selectores explícitos: `const isPlaying = usePlayerStore(s => s.isPlaying);`.
- Estado y motor están bien separados (`stores/playback/`). Aceptable.
- Tras la separación de selectores, considerar dividir el store en slices (zustand v4 ya lo permite con `combine`) para `playback` / `queue` / `device` / `volume`.

### 3.5 Servicios duplicados — ALTO

#### 3.5.1 `OxyServices` instanciado 3 veces
- `packages/frontend/lib/oxyServices.ts:8` — instancia canónica (debería ser la única).
- `packages/frontend/utils/api.ts:12` — segunda instancia con `baseURL` distinta.
- `packages/frontend/hooks/useImagePicker.ts:124` — tercera instancia inline en un hook.

**Fix**: dejar **solo** `lib/oxyServices.ts`. `utils/api.ts` y `useImagePicker.ts` la importan. Eliminar las otras dos instancias.

#### 3.5.2 `QueryClient` duplicado
- `packages/frontend/lib/reactQuery.ts` — `QueryClient` con `staleTime: 10min`. **Nunca importado**. Muerto.
- `packages/frontend/components/providers/constants.ts` — `QueryClient` con `staleTime: 5min`. En uso vía `AppProviders.tsx`.

**Fix**: borrar `lib/reactQuery.ts`. La única config queda en `components/providers/constants.ts`. Añadir el persister allí.

### 3.6 `utils/api.ts` y `utils/logger.ts` — ALTO `any`

- `utils/api.ts` — 10 `any`. Wraps Oxy + axios. Tras consolidar OxyServices y tipar respuestas con zod schemas de `shared-types`, los `any` desaparecen.
- `utils/logger.ts` — 9 `any` (acepta `unknown[]` extra args como `any[]`). Refactor: `(...args: unknown[]) => void` con narrowing interno.

### 3.7 `app/_layout.tsx` — MEDIO

Hallazgos:
- 4 `useEffect` que orquestan init (`appInitializer`, push token registration, theme sync, deep link). Algunos son inevitables (side-effects de mount), pero **2 de los 4** son derivables a `useLayoutEffect` (theme apply) o a un init handler ejecutado **fuera** del componente (`appInitializer` ya se ejecuta en bootstrap, no necesita `useEffect`).
- Desestructura `usePlayerStore()` completo — ver 3.4.

### 3.8 `components/`

#### 3.8.1 `ui/LazyImage/` — CRÍTICO (reinventar la rueda)
298 líneas implementando lazy-loading, blur placeholder, progressive load. **`expo-image` ya está en `dependencies`** y lo hace nativo, con caché disk + memoria, blurhash, transitions, etc. **Borrar `LazyImage/` completo** y reemplazar usos por `<Image>` de `expo-image` (la API es casi idéntica al RN `<Image>`).

#### 3.8.2 `LegendList.tsx` — ALTO
11 `any`. Wrapper de virtualización. Tipar correctamente con generics: `function LegendList<T>(props: LegendListProps<T>)`.

#### 3.8.3 Zustand sin selectores
Ver 3.4. Componentes a corregir: `PlayerBar.tsx`, `MobilePlayerBar.tsx`, `NowPlaying.tsx`, `LyricsView.tsx`, `MobileBottomNav.tsx`.

#### 3.8.4 Resto (`skeletons/`, `common/`, `playlists/`, `providers/`, `settings/`, `LibrarySidebar/`, `ui/Button`, `ui/Fab`, `ui/Loading`) — OK
Sin hallazgos críticos.

#### 3.8.5 `RegisterPushToken.tsx`, `NotificationPermissionSheet.tsx` — OK
Mantener. Pero asegurar que dependen del backend ECS, no de URLs hardcoded.

### 3.9 `hooks/`

- `useProfileData.md` — archivo `.md` dentro de `hooks/`. **Borrar** (no es código).
- `useImagePicker.ts:124` — ver 3.5.1 (instancia OxyServices propia).
- `useRealtimeNotifications.ts` — usa `types/validation.ts` (único zod actual, legacy de Mention). Tras eliminar Mention legacy, revisar si este hook sigue siendo necesario. Si lo es, mover el schema a `shared-types`.
- Resto OK.

### 3.10 `services/` — OK

13 archivos, bien estructurados (artistService, browseService, libraryService, musicService, playerSocketService, playlistSocketService, queueService, searchService, streamService, etc.). Sin hallazgos. Tests presentes (`searchService.test.ts`, `streamService.test.ts`).

Refactor menor: tras consolidar OxyServices, todos los services importan **una sola** instancia.

### 3.11 `lib/`

- `appInitializer.ts` — usa `useAppearanceStore` legacy. Tras migrar a React Query (3.2), reescribir para hidratar el query cache desde AsyncStorage.
- `constants.ts`, `i18n.ts`, `interests.ts`, `performance.ts`, `performanceConfig.ts`, `sonner.ts`, `sonner.web.ts`, `utils.ts` — OK.
- `oxyServices.ts` — quedará como única instancia (3.5.1).
- `reactQuery.ts` — borrar (3.5.2).

### 3.12 `context/`

- `LayoutScrollContext.tsx` — 7 `any`. Tipar el value del context con un type explícito.
- `BottomSheetContext.tsx`, `HomeRefreshContext.tsx` — OK.

### 3.13 `types/` e `interfaces/`

- `types/validation.ts` — único zod en frontend, legacy Mention notifications. Migrar a `shared-types/src/notification.ts` si el feature sigue vivo (lo usa `useRealtimeNotifications.ts`); si no, borrar.
- `types/css.d.ts` — OK.
- `interfaces/User.ts` — mover a `shared-types` como zod schema.
- `interfaces/Trend.ts` — MUERTO (legacy Mention). Borrar.

**Objetivo final**: la carpeta `interfaces/` desaparece. La carpeta `types/` queda solo con declaraciones ambient (`.d.ts`).

### 3.14 `utils/`

- `api.ts`, `logger.ts` — ver 3.6.
- `notifications.ts` — revisar que apunte a backend ECS (`api.syra.fm`).
- `device.ts`, `dateUtils.ts`, `formatNumber.ts`, `lyrics.ts`, `musicUtils.ts`, `pickImage.ts`, `searchUtils.ts`, `storage.ts`, `webStyles.ts`, `imageUrlCache.ts`, `blob.ts`, `composeUtils.ts`, `alerts.ts`, `deviceId.ts` — OK.

### 3.15 `package.json` (frontend) — CRÍTICO TS

- `typescript: "~6.0.3"` **no existe** como versión publicada. El runtime debe estar resolviéndose por el override de raíz (`~5.9.2`) o fallando silentemente. **Fijar `~5.9.2`** consistente con backend + raíz.

### 3.16 `config.ts` (frontend) — OK

URLs apuntan a `https://api.syra.fm` / `wss://api.syra.fm`. Coherente con `AGENTS.md`.

### 3.17 Docs basura en frontend (MEDIO)

- `packages/frontend/OPTIMIZATION_SUMMARY.md`
- `packages/frontend/MIGRATION_COMPLETE.md`
- `packages/frontend/NOTIFICATION_SYSTEM_README.md`
- `packages/frontend/README-subscriptions.md`

Todas son post-mortems / "complete" notes. **Borrar**.

### 3.18 `nativewind-env.d.ts` (frontend)

Tracked. Como es autogenerado por NativeWind en cada `bun install`, **debería estar en `.gitignore`**, no tracked. **Agregar a `.gitignore`** (`packages/frontend/.gitignore`) y `git rm --cached`.


---

## 4. `packages/shared-types`

### 4.1 Estructura — OK

10 dominios: `album`, `artist`, `common`, `connect`, `integrations`, `library`, `lyrics`, `media`, `player`, `playlist`, `profile`, `search`, `track`. Barrel en `index.ts` con `export *`. Buen punto de partida.

### 4.2 Falta zod (CRÍTICO/ALTO)

Hoy son `interface` puras TypeScript. **Decisión**: convertir cada dominio a **zod schemas** y derivar el tipo TS con `z.infer`. Patrón:

```ts
// shared-types/src/playlist.ts
import { z } from 'zod';

export const playlistVisibilitySchema = z.enum(['public', 'private', 'unlisted']);
export type PlaylistVisibility = z.infer<typeof playlistVisibilitySchema>;

export const playlistSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  ownerId: z.string(),
  visibility: playlistVisibilitySchema,
  coverArt: z.string().url().optional(),
  trackCount: z.number().int().nonneg(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Playlist = z.infer<typeof playlistSchema>;

export const playlistCreateBodySchema = playlistSchema.pick({
  title: true,
  description: true,
  visibility: true,
});
export type PlaylistCreateBody = z.infer<typeof playlistCreateBodySchema>;
```

Esto da, gratis:
- Validación en backend (middleware `validate(playlistCreateBodySchema)`).
- Validación en frontend (parsear respuestas API).
- Tipos TS sincronizados sin duplicación.

### 4.3 Artefactos `.js`/`.d.ts` en `src/` — BAJO

`packages/shared-types/src/*.js` y `*.d.ts` no aparecen en `.gitignore` global pero **tampoco están tracked** (verificado: `.gitignore` excluye `dist/`, `*.tsbuildinfo`; los `.js/.d.ts` están sueltos como artefactos locales). Confirmar con `git ls-files packages/shared-types/src | grep -E '\.(js|d\.ts)$'`. Si aparecen, `git rm --cached`. La build emite a `dist/`.

### 4.4 `index.ts` barrel — OK

`export *` desde cada dominio. Aceptable porque es la **fuente** del shared-types, no un re-export de un paquete externo (los re-exports prohibidos en AGENTS.md aplican a wrappers de libs externas).

---

## 5. Deploys y CI

### 5.1 `.github/workflows/deploy-aws.yml` (backend) — OK

Build `linux/arm64` -> ECR -> ECS `update-service --force-new-deployment`. OIDC con role `oxy-github-deploy`. Sincroniza secrets de GitHub a SSM. Mantener.

### 5.2 `.github/workflows/deploy-frontends.yml` (frontend) — OK

Cloudflare Pages, project `syra`, branch `main`. Mantener.

### 5.3 Configs muertas de deploy — CRÍTICO

Ya cubierto en §1.1. Borrar `vercel.json` (raíz), `packages/backend/vercel.json`, `.do/`, `scripts/setup-do-app.sh`, `docs/VERCEL_DEPLOYMENT.md`, `docs/DIGITALOCEAN_DEPLOYMENT.md`.

### 5.4 `Dockerfile` backend — OK

Arm64. Mantener. Revisar tras refactor que `bun install --production` y `bun run build` (sin `|| true`) pasen limpios.

---

## 6. `docs/` — MEDIO ruido

Inventario y veredicto:

| Archivo                                       | Acción   | Motivo                                      |
| --------------------------------------------- | -------- | ------------------------------------------- |
| `docs/README.md`                              | Mantener | Índice                                      |
| `docs/CODE_CLEANUP_SUMMARY.md`                | Borrar   | Post-mortem                                 |
| `docs/COMPOSE_ARCHITECTURE_DIAGRAM.md`        | Borrar   | Legacy Mention                              |
| `docs/COMPOSE_COMPONENTS_GUIDE.md`            | Borrar   | Legacy Mention                              |
| `docs/COMPOSE_INTEGRATION_CHECKLIST.md`       | Borrar   | Legacy Mention                              |
| `docs/COMPOSE_OPTIMIZATION_COMPLETE.md`       | Borrar   | Post-mortem                                 |
| `docs/COMPOSE_OPTIMIZATION_SUMMARY.md`        | Borrar   | Post-mortem                                 |
| `docs/COMPOSE_REFACTORING.md`                 | Borrar   | Legacy Mention                              |
| `docs/DIGITALOCEAN_DEPLOYMENT.md`             | Borrar   | Deploy retirado                             |
| `docs/MENTION_FORMAT_FINAL.md`                | Borrar   | Legacy Mention                              |
| `docs/MENTION_FORMAT_UPDATE.md`               | Borrar   | Legacy Mention                              |
| `docs/MENTION_IMPLEMENTATION_COMPLETE.md`     | Borrar   | Legacy Mention                              |
| `docs/MENTION_IMPLEMENTATION_FINAL.md`        | Borrar   | Legacy Mention                              |
| `docs/MENTION_NOTIFICATIONS.md`               | Borrar   | Legacy Mention                              |
| `docs/MENTION_SYSTEM_README.md`               | Borrar   | Legacy Mention                              |
| `docs/MENTION_VISUAL_GUIDE.md`                | Borrar   | Legacy Mention                              |
| `docs/PERFORMANCE_GUIDE.md`                   | Revisar  | Si vigente, mantener                        |
| `docs/PERFORMANCE_OPTIMIZATIONS.md`           | Borrar   | Post-mortem                                 |
| `docs/THEME_QUICK_REFERENCE.md`               | Revisar  | Si vigente con NativeWind, mantener         |
| `docs/THEMING_PROGRESS.md`                    | Borrar   | Progress note                               |
| `docs/THEMING_REFACTOR_SUMMARY.md`            | Borrar   | Post-mortem                                 |
| `docs/THEMING_TROUBLESHOOTING.md`             | Revisar  | Si vigente, mantener                        |
| `docs/VERCEL_DEPLOYMENT.md`                   | Borrar   | Deploy retirado                             |
| `docs/compliance/` (dir)                      | Revisar  | Si vigente, mantener                        |
| `docs/superpowers/` (dir)                     | Revisar  | Si vigente, mantener                        |
| `packages/backend/IMAGE_CACHE_SETUP.md`       | Borrar   | Mover info útil a `packages/backend/README.md` si aplica |

**Verificar previo a borrado**: `rg "MENTION_|COMPOSE_|DIGITALOCEAN|VERCEL_" --type md` para asegurar que ningún `.md` vivo enlaza a estos.

---

## 7. `.gitignore`

Estado actual: cubre `dist/`, `*.tsbuildinfo`, `.expo`, `node_modules`, `.env*`. **Falta**: `nativewind-env.d.ts` (autogenerado).

---

## 8. Inventario de hallazgos por severidad

### 8.1 CRÍTICO (bloqueante para producción / seguridad)

1. **Socket auth roto** — `packages/backend/src/sockets/playerSocket.ts:22-33`, `playlistSocket.ts:18-29`. Validar token contra OxyServices.
2. **Rate limiter no montado** — `packages/backend/server.ts:37` importa, nunca invoca.
3. **Build silencia errores** — `packages/backend/package.json` `"build": "tsc ... || true"`.
4. **`AuthRequest` duplicado** — borrar `packages/backend/src/types/auth.ts`.
5. **Rate limiter duplicado** — borrar `packages/backend/src/middleware/rateLimiter.ts`.
6. **`postSocket.ts` muerto** — borrar.
7. **CORS artesanal** — usar paquete `cors` (`packages/backend/server.ts`).
8. **`require()` runtime** en server.ts — convertir a `import`.
9. **Env sin validación** — crear `packages/backend/src/config/env.ts` con zod.
10. **Vercel/DO config muerta** — borrar `vercel.json` x2, `.do/`, `scripts/setup-do-app.sh`, dos `.md` de deploys.
11. **TS incoherente** — frontend `~6.0.3` no existe, unificar `~5.9.x`.
12. **`tsconfig.json` raíz incoherente** — quitar `extends: "expo/tsconfig.base"`, resolver `composite/declaration/noEmit`.
13. **`google-services.json` raíz** — mover a `packages/frontend/`.
14. **Logger con `console.log`** — migrar backend a pino; frontend, depurar console.log persistentes.
15. **`LazyImage` reinventa `expo-image`** — borrar.

### 8.2 ALTO (deuda estructural)

1. **Cero zod en controllers** — middleware `validate(schema)` + schemas en shared-types.
2. **shared-types sin zod** — convertir a `z.object` + `z.infer`.
3. **3 instancias OxyServices** — consolidar en `lib/oxyServices.ts`.
4. **2 QueryClient** — borrar `lib/reactQuery.ts`, dejar `components/providers/constants.ts`.
5. **`store/` legacy** — borrar 3 archivos muertos + migrar `appearanceStore` a React Query.
6. **`usersStore.ts`** — migrar a hooks RQ, eliminar 21 `any`.
7. **Zustand sin selectores** — refactor consumidores grandes.
8. **`any` masivos** — `usersStore` 21, `LegendList` 11, `utils/api` 10, `utils/logger` 9, `LayoutScrollContext` 7.
9. **Patrón repetido controllers** — helper `withDb(handler)`.
10. **Modelo Playlist `isPublic` redundante** — eliminar campo.
11. **Indexes Mongo** — añadir `{ createdAt: -1 }` en Track.
12. **`interfaces/` y `types/` frontend** — mover a shared-types o borrar.
13. **Validación respuestas API en frontend** — parsear con schemas zod.

### 8.3 MEDIO (calidad / DX / performance)

1. **`performance.ts` métricas in-memory** — exportar a CloudWatch.
2. **Docs basura** — 12+ `.md` legacy.
3. **Hidratación storage sin validar** — usar zod `safeParse` antes de aplicar.
4. **TanStack Query Persister** — configurar para offline-first.
5. **`useEffect` en `_layout.tsx`** — derivar lo derivable.
6. **`appInitializer` reescrito** post-migración appearance.

### 8.4 BAJO

1. `nativewind-env.d.ts` raíz duplicado.
2. Deps RN en `package.json` raíz.
3. `package.json` raíz `overrides` amplios.
4. `useProfileData.md` mal ubicado.
5. `rate-limit-redis` dep instalada sin uso.

---

## 9. Plan de ejecución (fases)

### Fase 0 — Entregable
- [x] Auditoría exploratoria.
- [x] `AUDIT.md` (este archivo).

### Fase 1 — CRÍTICOS (commit/PR `fase-1-critical`)
1. Crear `packages/backend/src/config/env.ts` con zod, reemplazar `process.env.X`.
2. Migrar logger backend a pino.
3. Reemplazar CORS artesanal por paquete `cors`.
4. Montar rate limiter en `server.ts`.
5. Convertir `require()` a `import` en `server.ts`.
6. Quitar `|| true` del build script backend.
7. Refactor socket auth (`playerSocket.ts`, `playlistSocket.ts`) contra OxyServices.
8. Borrar `postSocket.ts`, `middleware/rateLimiter.ts`, `types/auth.ts`.
9. Borrar `vercel.json` (raíz), `packages/backend/vercel.json`, `.do/`, `scripts/setup-do-app.sh`, `docs/VERCEL_DEPLOYMENT.md`, `docs/DIGITALOCEAN_DEPLOYMENT.md`.
10. Borrar `CLAUDE.md`, `GEMINI.md`, `FIX_ENTRY_POINT.md`, `WEB_ENTRY_POINT_FIX.md`.
11. Mover `google-services.json` a `packages/frontend/`.
12. Borrar `nativewind-env.d.ts` raíz y añadir a `.gitignore`.
13. Unificar TS a `~5.9.x` en los 4 `package.json`.
14. Reescribir `tsconfig.json` raíz (sin `extends` expo, sin `composite+declaration+noEmit` simultáneos).
15. Borrar `LazyImage/` y migrar usos a `expo-image`.

**Verificación fase 1**: `bun install && bun run build:shared-types && bun run build:backend && bun run build:frontend && bun run typecheck && bun test --filter '*'` debe pasar en limpio.

### Fase 2 — ALTOS (commit/PR `fase-2-high`)
1. Convertir `packages/shared-types/src/*.ts` a `z.object` + `z.infer`.
2. Crear `packages/backend/src/middleware/validate.ts`.
3. Crear `packages/backend/src/utils/withDb.ts`.
4. Aplicar validate + withDb en los 16 controllers.
5. Refactor sockets para parsear payloads con zod.
6. Consolidar OxyServices en `lib/oxyServices.ts` (frontend).
7. Borrar `lib/reactQuery.ts`, mover su config útil a `components/providers/constants.ts`.
8. Borrar `store/profileStore.ts`, `store/trendsStore.ts`, `store/analyticsStore.ts`.
9. Migrar `store/appearanceStore.ts` a React Query (`useAppearanceSettings`).
10. Borrar carpeta `store/`.
11. Migrar `stores/usersStore.ts` a hooks RQ. Borrar.
12. Mover `interfaces/User.ts` a `shared-types`. Borrar `interfaces/`.
13. Eliminar `any` en `LegendList`, `utils/api`, `utils/logger`, `LayoutScrollContext`.
14. Selectores Zustand en `PlayerBar`, `MobilePlayerBar`, `NowPlaying`, `LyricsView`, `MobileBottomNav`, `app/_layout.tsx`.
15. Eliminar `Playlist.isPublic` (migración + código).
16. Añadir indexes faltantes (Track).

**Verificación fase 2**: igual que fase 1.

### Fase 3 — MEDIOS (commit/PR `fase-3-medium`)
1. Configurar TanStack Query Persister con `@tanstack/query-async-storage-persister`.
2. Hidratación storage con `safeParse` zod.
3. Migrar `performance.ts` metrics a CloudWatch (via `@aws-sdk/client-cloudwatch`).
4. Limpiar docs (`docs/MENTION_*`, `COMPOSE_*`, `THEMING_PROGRESS.md`, `THEMING_REFACTOR_SUMMARY.md`, `CODE_CLEANUP_SUMMARY.md`, `PERFORMANCE_OPTIMIZATIONS.md`, `packages/frontend/OPTIMIZATION_SUMMARY.md`, `MIGRATION_COMPLETE.md`, `NOTIFICATION_SYSTEM_README.md`, `README-subscriptions.md`, `packages/backend/IMAGE_CACHE_SETUP.md`, `hooks/useProfileData.md`).
5. Eliminar `rate-limit-redis` de deps.
6. Mover deps RN del `package.json` raíz a `packages/frontend/package.json` y verificar `bun install`.
7. Reescribir `_layout.tsx` reduciendo `useEffect`.

**Verificación fase 3**: igual que antes.

### Fase 4 — Verificación final (commit `fase-4-verify`)
1. `bun install` limpio.
2. `bun run typecheck` sin errores.
3. `bun run lint` sin errores.
4. `bun test --filter '*'` verde en los 3 paquetes.
5. `bun run build:shared-types && bun run build:backend && bun run build:frontend` sin warnings críticos.
6. Smoke test manual: arrancar backend con `bun run dev:backend`, frontend con `bun run dev:frontend`, login, reproducir track, crear playlist, recibir push (si dev).
7. Push de las 4 ramas -> PR a `main` con review propio en cada una.

---

## 10. Convenciones del refactor

- **TypeScript**: cero `any`, cero `@ts-ignore`, cero `!`. Si una API externa devuelve `unknown`, parsear con zod.
- **Logger**: `pino` en backend; `utils/logger.ts` en frontend (sin `console.log` directos en código de prod).
- **Validación**: zod en cada frontera (env, HTTP body/query/params, socket payloads, respuestas API consumidas por frontend, hidratación de storage).
- **Estado frontend**: React Query para recursos remotos; Zustand para estado UI/local. `store/` desaparece. `stores/usersStore` desaparece.
- **Tipos compartidos**: `packages/shared-types/` es la fuente única, derivada de zod.
- **Tests**: cada nuevo middleware (`validate`, `withDb`) y cada hook nuevo (RQ) acompañado de test.
- **Commits**: por fase, mensajes en imperativo (`fase 1: socket auth + env zod + cleanup deploys`).
- **Sin re-exports**, sin barrel-files nuevos fuera de `shared-types/index.ts`.
- **Lockfile**: tras cada install, commitear `bun.lock`.

---

## 11. Riesgos y mitigaciones

| Riesgo | Mitigación |
| ------ | ---------- |
| Socket auth refactor rompe clientes mobile en vuelo | Mantener compatibilidad: aceptar `{ auth: { token } }` y, transitoriamente, registrar el caso `userId` con warning antes de cortarlo. Después de 1 deploy, eliminar el fallback. |
| Migración `Playlist.isPublic` rompe lecturas viejas | Backfill `isPublic = visibility === 'public'` en un script `scripts/migrations/2026-06-isPublic.ts`, luego deploy del código sin `isPublic`, luego `$unset` en script posterior. |
| `expo-image` no soporta alguna prop que LazyImage exponía | Auditar consumidores de LazyImage antes; reemplazar manualmente con props equivalentes (`placeholder`, `transition`, `cachePolicy`). |
| Persister Query Async Storage hidrata datos corruptos | `safeParse` con zod antes de aceptar; si falla, `queryClient.clear()` para esa key. |
| `cors` paquete cierra orígenes que el artesanal dejaba pasar | Auditar lista actual (`ALLOWED_ORIGINS`); test e2e contra `syra.fm` y `api.syra.fm` antes de deploy. |

---

## 12. Apéndice — Comandos de verificación previos al borrado

Antes de borrar cualquier archivo, ejecutar:

```bash
# Verificar referencias a archivos a borrar
rg "vercel\.json|\.do/|setup-do-app|VERCEL_DEPLOYMENT|DIGITALOCEAN_DEPLOYMENT"
rg "FIX_ENTRY_POINT|WEB_ENTRY_POINT_FIX|CLAUDE\.md|GEMINI\.md"
rg "MENTION_|COMPOSE_OPTIMIZATION|THEMING_PROGRESS|CODE_CLEANUP_SUMMARY"
rg "OPTIMIZATION_SUMMARY|MIGRATION_COMPLETE|NOTIFICATION_SYSTEM_README|README-subscriptions|IMAGE_CACHE_SETUP"
rg "postSocket|rateLimiter\.ts|types/auth" packages/backend
rg "lib/reactQuery|store/(profileStore|trendsStore|analyticsStore|appearanceStore)" packages/frontend
rg "LazyImage" packages/frontend
rg "rate-limit-redis"
```

Si una sentencia devuelve cero resultados (excepto el propio archivo a borrar), es seguro proceder.

---

## 13. Cierre

Este documento es el contrato del refactor. Cada item tiene severidad, ubicación y acción concreta. La ejecución se hace en 4 fases secuenciales (Fase 0 es este entregable). Al finalizar la Fase 4, el repo:

- Compila sin warnings, sin `|| true`, sin `any`, sin `@ts-ignore`.
- Tiene validación zod en cada frontera.
- Tiene una sola fuente para sockets auth (OxyServices), QueryClient, OxyServices client, tipos compartidos.
- No referencia Vercel ni DigitalOcean.
- Tiene `docs/` limpio y `README.md` actualizado (si procede en una fase posterior).
- Pasa `bun test --filter '*'` con cobertura >= la actual y nuevos tests para middlewares y hooks introducidos.
