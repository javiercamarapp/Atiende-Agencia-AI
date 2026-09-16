// Sesión del back office de plataforma — mismo mecanismo que cada vertical
// (`persistXSession`/`readPersistedXSession`, ver `verticals/hoteles/lib/
// auth-client.ts`), llave de localStorage propia para no chocar con la sesión
// de ninguna vertical abierta en el mismo navegador.
import type { LoginSession, SessionStorageLike } from "../../lib/auth-client.ts";

export type { LoginSession, SessionStorageLike };

const SESSION_KEY = "atiende.superadmin.session";

export function persistSuperadminSession(storage: SessionStorageLike, session: LoginSession): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readPersistedSuperadminSession(storage: SessionStorageLike): LoginSession | null {
  const raw = storage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LoginSession;
  } catch {
    storage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearSuperadminSession(storage: SessionStorageLike): void {
  storage.removeItem(SESSION_KEY);
}
