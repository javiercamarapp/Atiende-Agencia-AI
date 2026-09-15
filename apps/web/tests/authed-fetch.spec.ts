// Tests del mecanismo COMPARTIDO de refresh-y-reintento (Hallazgo de auditoría,
// severidad ALTA, "duplicado en TODAS las verticales": "Expiración del JWT (15
// min) no se maneja: el panel queda muerto sin refresh ni redirección"). Prueba
// `withAuthRefresh` en aislamiento, con un `AuthedSessionStore` falso inyectado
// (mismo criterio que el resto de este repo: nunca `globalThis.fetch`/`window`
// reales en un test, ver comentario de cabecera de cada admin-client.ts) — las
// pruebas de integración por vertical (hoteles-admin-client-auth-refresh.spec.ts,
// etc.) cubren que cada `fetchJson`/`sendJson` real efectivamente lo use.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiBaseUrlFromRequestUrl,
  defaultBrowserStorage,
  SESSION_EXPIRED_EVENT,
  SessionExpiredError,
  withAuthRefresh,
} from "../src/lib/authed-fetch.ts";
import type { AuthedFetchContext, AuthedSession, AuthedSessionStore } from "../src/lib/authed-fetch.ts";

interface FakeSession extends AuthedSession {
  readonly email: string;
}

function fakeStore(initial: FakeSession | null): AuthedSessionStore<FakeSession> & { readonly calls: { persisted: FakeSession[]; cleared: number } } {
  let current = initial;
  const calls = { persisted: [] as FakeSession[], cleared: 0 };
  return {
    read: () => current,
    persist: (session) => {
      current = session;
      calls.persisted.push(session);
    },
    clear: () => {
      current = null;
      calls.cleared += 1;
    },
    calls,
  };
}

function fakeCtx(vertical: string, initial: FakeSession | null) {
  const store = fakeStore(initial);
  const ctx: AuthedFetchContext<FakeSession> = { vertical, store };
  return { ctx, store };
}

describe("withAuthRefresh", () => {
  it("respuesta que NO es 401 -> se devuelve tal cual, nunca toca /auth/refresh", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const { ctx } = fakeCtx("hoteles", { token: "tok", refreshToken: "r", email: "a@b.com" });

    const res = await withAuthRefresh(fetchImpl, "http://api.local", ctx, "tok", (t) => fetchImpl("http://api.local/algo", { headers: { authorization: `Bearer ${t}` } }));

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("401 + refresh exitoso -> UN POST a /auth/refresh con el refreshToken persistido, persiste la sesión nueva completa y reintenta UNA vez con el token nuevo", async () => {
    const refreshed = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "a@b.com" };
    let attempt = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://api.local/auth/refresh") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init!.body as string)).toEqual({ refreshToken: "refresh-viejo" });
        return new Response(JSON.stringify(refreshed), { status: 200 });
      }
      attempt += 1;
      const token = (init?.headers as Record<string, string>).authorization;
      if (attempt === 1) {
        expect(token).toBe("Bearer tok-viejo");
        return new Response(JSON.stringify({ message: "expirado" }), { status: 401 });
      }
      expect(token).toBe("Bearer tok-nuevo");
      return new Response(JSON.stringify({ resultado: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx, store } = fakeCtx("hoteles", { token: "tok-viejo", refreshToken: "refresh-viejo", email: "a@b.com" });

    const res = await withAuthRefresh(fetchImpl, "http://api.local", ctx, "tok-viejo", (t) => fetchImpl("http://api.local/protegido", { headers: { authorization: `Bearer ${t}` } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resultado: "ok" });
    // Nunca más de un intento a /auth/refresh ni más de dos a la ruta protegida.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(store.calls.persisted).toEqual([refreshed]);
    expect(store.read()).toEqual(refreshed);
  });

  it("401 + refresh también responde 401 -> limpia la sesión, dispara SESSION_EXPIRED_EVENT y lanza SessionExpiredError (nunca reintenta la protegida)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "Refresh token inválido o expirado." }), { status: 401 });
      return new Response(JSON.stringify({ message: "expirado" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, store } = fakeCtx("hoteles", { token: "tok-viejo", refreshToken: "refresh-revocado", email: "a@b.com" });

    await expect(withAuthRefresh(fetchImpl, "http://api.local", ctx, "tok-viejo", (t) => fetchImpl("http://api.local/protegido", { headers: { authorization: `Bearer ${t}` } }))).rejects.toThrow(
      SessionExpiredError,
    );

    expect(store.calls.cleared).toBe(1);
    expect(store.read()).toBeNull();
    // Solo 2 llamadas: la protegida original + el refresh fallido. NUNCA una tercera
    // (reintentar la protegida sin un token nuevo real no arreglaría nada).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("401 + POST /auth/refresh revienta de red -> tratado igual que un refresh no-ok (limpia sesión y lanza SessionExpiredError)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "http://api.local/auth/refresh") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ message: "expirado" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, store } = fakeCtx("hoteles", { token: "tok-viejo", refreshToken: "r", email: "a@b.com" });

    await expect(withAuthRefresh(fetchImpl, "http://api.local", ctx, "tok-viejo", (t) => fetchImpl("http://api.local/protegido", { headers: { authorization: `Bearer ${t}` } }))).rejects.toThrow(
      SessionExpiredError,
    );
    expect(store.calls.cleared).toBe(1);
  });

  it("401 + refresh responde 200 pero sin token/refreshToken válidos -> tratado como refresh fallido", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ message: "expirado" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, store } = fakeCtx("hoteles", { token: "tok-viejo", refreshToken: "r", email: "a@b.com" });

    await expect(withAuthRefresh(fetchImpl, "http://api.local", ctx, "tok-viejo", (t) => fetchImpl("http://api.local/protegido", { headers: { authorization: `Bearer ${t}` } }))).rejects.toThrow(
      SessionExpiredError,
    );
    expect(store.calls.cleared).toBe(1);
  });

  it("401 sin ninguna sesión persistida que refrescar -> limpia (no-op), dispara el evento y lanza SessionExpiredError sin llamar nunca a /auth/refresh", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "expirado" }), { status: 401 })) as unknown as typeof fetch;
    const { ctx, store } = fakeCtx("hoteles", null);

    await expect(withAuthRefresh(fetchImpl, "http://api.local", ctx, "tok-viejo", (t) => fetchImpl("http://api.local/protegido", { headers: { authorization: `Bearer ${t}` } }))).rejects.toThrow(
      SessionExpiredError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1); // solo la protegida original, nunca /auth/refresh
    expect(store.calls.cleared).toBe(1);
  });

  it("ctx.refreshPath -> el refresh se pide a ESE path en vez de /auth/refresh (identidad no-staff con su propio endpoint, ej. el portal de propietario de rentas)", async () => {
    const refreshed = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "a@b.com" };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "http://api.local/rentas/owner-portal/auth/refresh") return new Response(JSON.stringify(refreshed), { status: 200 });
      // Nunca debe pedirse el endpoint genérico de staff cuando ctx.refreshPath está fijado.
      if (url === "http://api.local/auth/refresh") throw new Error("no debería llamarse /auth/refresh cuando ctx.refreshPath está fijado");
      return new Response(JSON.stringify({ resultado: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    const store = fakeStore({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "a@b.com" });
    const ctx: AuthedFetchContext<FakeSession> = { vertical: "rentas-owner-portal", store, refreshPath: "/rentas/owner-portal/auth/refresh" };

    let attempt = 0;
    const res = await withAuthRefresh(fetchImpl, "http://api.local", ctx, "tok-viejo", (t) => {
      attempt += 1;
      if (attempt === 1) return Promise.resolve(new Response(JSON.stringify({ message: "expirado" }), { status: 401 }));
      return fetchImpl("http://api.local/protegido", { headers: { authorization: `Bearer ${t}` } });
    });

    expect(res.status).toBe(200);
    expect(store.calls.persisted).toEqual([refreshed]);
  });

  it("el segundo intento (con el token ya refrescado) también responde 401 -> se devuelve esa Response tal cual, sin un tercer intento ni bucle", async () => {
    const refreshed = { token: "tok-nuevo", refreshToken: "r-nuevo", email: "a@b.com" };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify(refreshed), { status: 200 });
      return new Response(JSON.stringify({ message: "sigue sin autorizar" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx } = fakeCtx("hoteles", { token: "tok-viejo", refreshToken: "r-viejo", email: "a@b.com" });

    const res = await withAuthRefresh(fetchImpl, "http://api.local", ctx, "tok-viejo", (t) => fetchImpl("http://api.local/protegido", { headers: { authorization: `Bearer ${t}` } }));
    expect(res.status).toBe(401);
    // protegida (1) + refresh (1) + protegida reintentada (1) = 3, nunca un 4º intento.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("notifySessionExpired (a través de withAuthRefresh)", () => {
  const originalDispatch = (globalThis as { dispatchEvent?: unknown }).dispatchEvent;

  afterEach(() => {
    if (originalDispatch === undefined) delete (globalThis as { dispatchEvent?: unknown }).dispatchEvent;
    else (globalThis as { dispatchEvent?: unknown }).dispatchEvent = originalDispatch;
  });

  it("cuando globalThis SÍ expone dispatchEvent (navegador real), dispara SESSION_EXPIRED_EVENT con la vertical en el detail", async () => {
    const dispatched: CustomEvent[] = [];
    (globalThis as { dispatchEvent?: (e: Event) => boolean }).dispatchEvent = (e: Event) => {
      dispatched.push(e as CustomEvent);
      return true;
    };

    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "no" }), { status: 401 });
      return new Response(JSON.stringify({}), { status: 401 });
    }) as unknown as typeof fetch;
    const { ctx } = fakeCtx("citas", { token: "t", refreshToken: "r", email: "a@b.com" });

    await expect(
      withAuthRefresh(fetchImpl, "http://api.local", ctx, "t", (tok) => fetchImpl("http://api.local/x", { headers: { authorization: `Bearer ${tok}` } })),
    ).rejects.toThrow(SessionExpiredError);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.type).toBe(SESSION_EXPIRED_EVENT);
    expect(dispatched[0]!.detail).toEqual({ vertical: "citas" });
  });

  it("cuando globalThis NO expone dispatchEvent (entorno \"node\" de vitest sin stub), no revienta", async () => {
    delete (globalThis as { dispatchEvent?: unknown }).dispatchEvent;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "no" }), { status: 401 });
      return new Response(JSON.stringify({}), { status: 401 });
    }) as unknown as typeof fetch;
    const { ctx } = fakeCtx("citas", { token: "t", refreshToken: "r", email: "a@b.com" });

    await expect(
      withAuthRefresh(fetchImpl, "http://api.local", ctx, "t", (tok) => fetchImpl("http://api.local/x", { headers: { authorization: `Bearer ${tok}` } })),
    ).rejects.toThrow(SessionExpiredError);
  });
});

describe("apiBaseUrlFromRequestUrl", () => {
  it("extrae el origin de una URL absoluta, igual al apiBaseUrl que la generó", () => {
    expect(apiBaseUrlFromRequestUrl("http://api.local/v1/hoteles/x/admin/propiedades")).toBe("http://api.local");
    expect(apiBaseUrlFromRequestUrl("https://api.atiende.mx/hoteles/prop-1/reservas")).toBe("https://api.atiende.mx");
  });
});

describe("defaultBrowserStorage", () => {
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

  afterEach(() => {
    if (originalLocalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  });

  it("null cuando globalThis no expone localStorage (entorno \"node\" de vitest)", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(defaultBrowserStorage()).toBeNull();
  });

  it("devuelve exactamente globalThis.localStorage cuando existe (navegador real)", () => {
    const fake = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
    (globalThis as { localStorage?: unknown }).localStorage = fake;
    expect(defaultBrowserStorage()).toBe(fake);
  });
});
