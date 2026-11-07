// JWT "falso" (sin firma válida) con el claim de soporte, SOLO para pintar el banner en pruebas: el cliente nunca verifica la firma
// (lo hace la API en cada petición). Reloj fijo: `expMs` se pasa explícito.
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export function tokenSoporteFalso(opts: { sid?: string; orgId?: string; vertical?: string; expMs: number; ro?: boolean }): string {
  return `${b64url({ alg: "HS256" })}.${b64url({ sub: "u1", org_id: opts.orgId ?? "o1", vertical: opts.vertical ?? "restaurantes", soporte: { sid: opts.sid ?? "s1", ro: opts.ro ?? true }, exp: Math.floor(opts.expMs / 1000) })}.firma`;
}

export function tokenSinSoporte(): string {
  return `${b64url({ alg: "HS256" })}.${b64url({ sub: "u1", org_id: "o1", vertical: "restaurantes", exp: 4_000_000_000 })}.firma`;
}

/** Respuesta de POST /superadmin/soporte/entrar para una org de restaurantes con slug dado. */
export function respuestaEntrar(opts: { slug: string; nombre: string; expMs: number; vertical?: string }) {
  return {
    token: tokenSoporteFalso({ expMs: opts.expMs, vertical: opts.vertical ?? "restaurantes" }),
    refreshToken: "",
    session: { id: "s1", kind: "soporte", organizationId: "o1", organizationName: opts.nombre, organizationSlug: opts.slug, vertical: opts.vertical ?? "restaurantes", expiresAtMs: opts.expMs, soloLectura: true },
  };
}

/** localStorage en memoria para jsdom (este entorno no trae uno): llamar en `beforeEach`. */
export function instalarLocalStorageEnMemoria(): Storage {
  const m = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  return storage;
}
