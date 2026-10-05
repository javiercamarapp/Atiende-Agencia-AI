// Sesion unificada de un panel de vertical (PR-4 del plan de diseno-ux, 4.5).
//
// Antes cada *Shell.tsx repetia el mismo bloque: leer la sesion persistida,
// escuchar SESSION_EXPIRED_EVENT, cargar las sucursales, resolver la sucursal
// activa (persistida por organizacion), derivar organizacion y rol, y hacer
// logout. Aqui vive UNA vez; cada vertical solo aporta un `adaptador` con sus
// funciones propias (llave de sesion, endpoint de sucursales, persistencia de la
// sucursal elegida).
//
// El rol que devuelve es COSMETICO (ocultar controles): la autorizacion real es
// siempre del servidor.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SESSION_EXPIRED_EVENT, SESSION_REFRESHED_EVENT } from "./authed-fetch.ts";
import type { SessionExpiredEventDetail, SessionRefreshedEventDetail } from "./authed-fetch.ts";
import type { LoginSession, SessionStorageLike } from "./auth-client.ts";

export interface VerticalBranch {
  readonly propertyId: string;
  readonly name: string;
}

export interface VerticalSessionAdapter<B extends VerticalBranch = VerticalBranch> {
  /** Identificador de la vertical: filtra SESSION_EXPIRED_EVENT de otras verticales abiertas. */
  readonly vertical: string;
  readonly readSession: (storage: SessionStorageLike) => LoginSession | null;
  readonly clearSession: (storage: SessionStorageLike) => void;
  readonly logout: (fetchImpl: typeof fetch, apiBaseUrl: string, refreshToken: string) => Promise<void>;
  readonly fetchBranches: (fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly B[]>;
  readonly readPropertyId: (storage: SessionStorageLike, orgSlug: string) => string | null;
  readonly persistPropertyId: (storage: SessionStorageLike, orgSlug: string, propertyId: string) => void;
  readonly resolveActivePropertyId: (branches: readonly B[], selected: string | null) => string | null;
}

export interface UseVerticalSessionOptions<B extends VerticalBranch> {
  readonly adapter: VerticalSessionAdapter<B>;
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  /** Rol cuando la organizacion no aparece en la sesion. @default "staff" */
  readonly defaultRole?: string;
}

/** `resolviendo`: leyendo la sesion persistida · `sin-sesion`: no hay sesion (ya se disparo onRequireLogin) · `cargando`: cargando sucursales. */
export type VerticalSessionFase = "resolviendo" | "sin-sesion" | "cargando" | "error" | "vacio" | "listo";

export interface VerticalSessionBase {
  readonly fase: VerticalSessionFase;
  /** Mensaje del fallo de carga de sucursales (solo con fase "error"). */
  readonly error: string | null;
  /** Vuelve a intentar la carga de sucursales tras un error. */
  readonly reintentar: () => void;
  readonly logout: () => Promise<void>;
  readonly loggingOut: boolean;
}

export interface VerticalSessionListo<B extends VerticalBranch> extends VerticalSessionBase {
  readonly fase: "listo";
  readonly session: LoginSession;
  readonly branches: readonly B[];
  readonly activeBranch: B;
  readonly propertyId: string;
  readonly selectBranch: (propertyId: string) => void;
  readonly orgId: string;
  readonly role: string;
  /** True si el rol de la sesion esta entre los permitidos (solo cosmetico; el servidor es la autoridad). */
  readonly hasRole: (allowed: Iterable<string>) => boolean;
}

type FasePendiente = Exclude<VerticalSessionFase, "listo">;

/** Una variante por fase (union discriminada real): al descartar cada `fase`, TypeScript estrecha hasta `VerticalSessionListo`. */
export type VerticalSessionPendiente = {
  [F in FasePendiente]: VerticalSessionBase & { readonly fase: F; readonly session: LoginSession | null };
}[FasePendiente];

export type VerticalSession<B extends VerticalBranch = VerticalBranch> = VerticalSessionListo<B> | VerticalSessionPendiente;

export function useVerticalSession<B extends VerticalBranch>({ adapter, apiBaseUrl, orgSlug, onRequireLogin, defaultRole = "staff" }: UseVerticalSessionOptions<B>): VerticalSession<B> {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [branches, setBranches] = useState<readonly B[] | null>(null);
  // `null` hasta que el staff elige: se inicializa con la sucursal persistida de ESTA organizacion para que
  // sobreviva a que App.tsx monte una instancia nueva del shell al navegar a otra ruta del panel.
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(() => adapter.readPropertyId(window.localStorage, orgSlug));
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [intento, setIntento] = useState(0);
  // Guarda sincrona: dos llamadas en el mismo tick (doble clic) verian ambas `loggingOut === false` en el closure.
  const cerrandoSesion = useRef(false);

  useEffect(() => {
    const s = adapter.readSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [adapter, onRequireLogin]);

  // fetchJson/sendJson de cada admin-client intentan un refresh ante un 401; si tambien falla disparan
  // SESSION_EXPIRED_EVENT en `window` (no son componentes React). Se filtra por vertical para no reaccionar
  // a la expiracion de otra vertical abierta en otra pestana.
  useEffect(() => {
    function handleSessionExpired(event: Event) {
      const detail = (event as CustomEvent<SessionExpiredEventDetail>).detail;
      if (detail?.vertical !== adapter.vertical) return;
      adapter.clearSession(window.localStorage);
      setSession(null);
      onRequireLogin();
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [adapter, onRequireLogin]);

  // Tras un refresh exitoso (withAuthRefresh persiste la sesion nueva) el estado de aqui seguia con el access token y el refresh token VIEJOS: cada
  // pantalla mandaba el token vencido (401 + otro refresh en cada peticion) y "Cerrar sesion" revocaba el refresh token ya rotado, dejando vigente el
  // verdadero. Se relee la sesion persistida; solo cambia el estado si el token realmente cambio.
  useEffect(() => {
    function handleSessionRefreshed(event: Event) {
      const detail = (event as CustomEvent<SessionRefreshedEventDetail>).detail;
      if (detail?.vertical !== adapter.vertical) return;
      const fresca = adapter.readSession(window.localStorage);
      if (!fresca) return;
      setSession((actual) => (actual && actual.token === fresca.token && actual.refreshToken === fresca.refreshToken ? actual : fresca));
    }
    window.addEventListener(SESSION_REFRESHED_EVENT, handleSessionRefreshed);
    return () => window.removeEventListener(SESSION_REFRESHED_EVENT, handleSessionRefreshed);
  }, [adapter]);

  useEffect(() => {
    if (!session) return;
    let cancelado = false;
    setError(null);
    (async () => {
      try {
        const list = await adapter.fetchBranches(fetch, apiBaseUrl, session.token, orgSlug);
        if (!cancelado) setBranches(list);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las sucursales.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [adapter, session, apiBaseUrl, orgSlug, intento]);

  const logout = useCallback(async () => {
    if (!session || cerrandoSesion.current) return;
    cerrandoSesion.current = true;
    setLoggingOut(true);
    // Logout limpio: la llamada real a /auth/logout es best-effort (red caida, token ya vencido): si falla, la
    // sesion local se limpia igual y se redirige al login; el error no se propaga (nadie lo atiende en un onClick).
    try {
      // El refresh token VIGENTE es el persistido (el del estado puede ser uno ya rotado por un refresh).
      const vigente = adapter.readSession(window.localStorage) ?? session;
      await adapter.logout(fetch, apiBaseUrl, vigente.refreshToken);
    } catch {
      // ignorado a proposito, ver arriba
    } finally {
      adapter.clearSession(window.localStorage);
      setSession(null);
      cerrandoSesion.current = false;
      setLoggingOut(false);
      onRequireLogin();
    }
  }, [adapter, apiBaseUrl, onRequireLogin, session]);

  const reintentar = useCallback(() => {
    setError(null);
    setBranches(null);
    setIntento((n) => n + 1);
  }, []);

  const selectBranch = useCallback(
    (propertyId: string) => {
      setSelectedPropertyId(propertyId);
      adapter.persistPropertyId(window.localStorage, orgSlug, propertyId);
    },
    [adapter, orgSlug],
  );

  const org = useMemo(() => session?.organizations.find((o) => o.slug === orgSlug), [session, orgSlug]);
  const base = { error, reintentar, logout, loggingOut };

  if (session === undefined) return { ...base, fase: "resolviendo", session: null };
  if (!session) return { ...base, fase: "sin-sesion", session: null };
  if (error) return { ...base, fase: "error", session };
  if (!branches) return { ...base, fase: "cargando", session };
  if (branches.length === 0) return { ...base, fase: "vacio", session };

  const propertyId = adapter.resolveActivePropertyId(branches, selectedPropertyId)!;
  const activeBranch = branches.find((b) => b.propertyId === propertyId)!;
  const role = org?.rol ?? defaultRole;
  return {
    ...base,
    fase: "listo",
    session,
    branches,
    activeBranch,
    propertyId,
    selectBranch,
    orgId: org?.id ?? "",
    role,
    hasRole: (allowed) => new Set(allowed).has(role),
  };
}
