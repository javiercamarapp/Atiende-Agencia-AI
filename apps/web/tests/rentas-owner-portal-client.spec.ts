// Tests del cliente web del portal de propietario (Fase 3 backend, UI de esta fase) —
// lib/owner-portal-client.ts. Cubre: validación/login/activación públicos (sin
// sesión), las 3 lecturas autenticadas (me/unidades/statements), y que el
// refresh-y-reintento use `/rentas/owner-portal/auth/refresh` (nunca el
// `/auth/refresh` genérico de staff) — mismo criterio que
// hoteles-admin-client-auth-refresh.spec.ts para el resto de verticales.
import { describe, expect, it } from "vitest";
import {
  fetchOwnerPortalJson,
  fetchOwnerPortalMe,
  fetchOwnerPortalStatementDetalle,
  fetchOwnerPortalStatements,
  fetchOwnerPortalUnidades,
  OwnerPortalError,
  ownerPortalActivar,
  ownerPortalLogin,
  SessionExpiredError,
  validateOwnerPortalActivarForm,
  validateOwnerPortalLoginForm,
} from "../src/verticals/rentas/lib/owner-portal-client.ts";
import type { OwnerPortalSession } from "../src/verticals/rentas/lib/owner-portal-client.ts";
import type { AuthedFetchContext } from "../src/lib/authed-fetch.ts";

function fakeCtx(initial: OwnerPortalSession | null) {
  let current = initial;
  const persisted: OwnerPortalSession[] = [];
  let cleared = 0;
  const ctx: AuthedFetchContext<OwnerPortalSession> = {
    vertical: "rentas-owner-portal",
    refreshPath: "/rentas/owner-portal/auth/refresh",
    store: {
      read: () => current,
      persist: (s) => {
        current = s;
        persisted.push(s);
      },
      clear: () => {
        current = null;
        cleared += 1;
      },
    },
  };
  return { ctx, persisted, clearedCount: () => cleared, currentSession: () => current };
}

describe("validateOwnerPortalLoginForm", () => {
  it("correo vacío -> mensaje real", () => {
    expect(validateOwnerPortalLoginForm("", "algo")).toMatch(/correo/);
  });
  it("correo mal formado -> mensaje real", () => {
    expect(validateOwnerPortalLoginForm("no-es-correo", "algo")).toMatch(/no parece válido/);
  });
  it("password vacío -> mensaje real", () => {
    expect(validateOwnerPortalLoginForm("a@b.com", "")).toMatch(/contraseña/);
  });
  it("correo y password válidos -> null", () => {
    expect(validateOwnerPortalLoginForm("a@b.com", "algo")).toBeNull();
  });
});

describe("ownerPortalLogin", () => {
  it("hace POST real a /rentas/owner-portal/auth/login y devuelve la sesión", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/owner-portal/auth/login");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ email: "propietario@ejemplo.mx", password: "clave-super-segura" });
      return new Response(JSON.stringify({ token: "tok", refreshToken: "r", ownerId: "owner-1", email: "propietario@ejemplo.mx" }), { status: 200 });
    }) as unknown as typeof fetch;

    const session = await ownerPortalLogin(fetchImpl, "http://api.local", "Propietario@Ejemplo.MX", "clave-super-segura");
    expect(session).toEqual({ token: "tok", refreshToken: "r", ownerId: "owner-1", email: "propietario@ejemplo.mx" });
  });

  it("contraseña incorrecta -> 401 real, mensaje claro", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "no" }), { status: 401 })) as unknown as typeof fetch;
    await expect(ownerPortalLogin(fetchImpl, "http://api.local", "a@b.com", "mala")).rejects.toThrow(/Correo o contraseña incorrectos/);
  });

  it("formulario inválido -> nunca llega a llamar a fetch", async () => {
    const fetchImpl = (async () => {
      throw new Error("no debería llamarse");
    }) as unknown as typeof fetch;
    await expect(ownerPortalLogin(fetchImpl, "http://api.local", "", "")).rejects.toThrow(OwnerPortalError);
  });
});

describe("validateOwnerPortalActivarForm / ownerPortalActivar", () => {
  it("token vacío -> mensaje real", () => {
    expect(validateOwnerPortalActivarForm("", "clave-larga-1", "clave-larga-1")).toMatch(/token de invitación/);
  });
  it("password corto -> mensaje real", () => {
    expect(validateOwnerPortalActivarForm("tok", "corta", "corta")).toMatch(/al menos 8 caracteres/);
  });
  it("passwords que no coinciden -> mensaje real", () => {
    expect(validateOwnerPortalActivarForm("tok", "clave-larga-1", "clave-larga-2")).toMatch(/no coinciden/);
  });

  it("hace POST real a /rentas/owner-portal/auth/set-password con el token y la contraseña nueva", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/owner-portal/auth/set-password");
      expect(JSON.parse(init!.body as string)).toEqual({ token: "token-de-invitacion", password: "clave-super-segura" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(ownerPortalActivar(fetchImpl, "http://api.local", "token-de-invitacion", "clave-super-segura", "clave-super-segura")).resolves.toBeUndefined();
  });

  it("token inválido/expirado -> error real del servidor", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "El token de invitación no es válido, ya se usó, o expiró." }), { status: 400 })) as unknown as typeof fetch;
    await expect(ownerPortalActivar(fetchImpl, "http://api.local", "token-viejo", "clave-super-segura", "clave-super-segura")).rejects.toThrow(/no es válido/);
  });
});

describe("fetchOwnerPortalMe / fetchOwnerPortalUnidades / fetchOwnerPortalStatements / fetchOwnerPortalStatementDetalle", () => {
  it("fetchOwnerPortalMe: GET real a /rentas/owner-portal/me", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe("http://api.local/rentas/owner-portal/me");
      return new Response(JSON.stringify({ id: "owner-1", name: "Propietario A", email: "a@b.com", organizaciones: [{ organizationId: "org-1", name: "Gestora", slug: "gestora" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const me = await fetchOwnerPortalMe(fetchImpl, "http://api.local", "tok");
    expect(me).toEqual({ id: "owner-1", name: "Propietario A", email: "a@b.com", organizaciones: [{ organizationId: "org-1", name: "Gestora", slug: "gestora" }] });
  });

  it("fetchOwnerPortalUnidades: desenvuelve { unidades }", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe("http://api.local/rentas/owner-portal/unidades");
      return new Response(JSON.stringify({ unidades: [{ id: "u-1", name: "Depa 301", propertyId: "prop-1", organizationId: "org-1", organizationName: "Gestora" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const unidades = await fetchOwnerPortalUnidades(fetchImpl, "http://api.local", "tok");
    expect(unidades).toHaveLength(1);
    expect(unidades[0]!.name).toBe("Depa 301");
  });

  it("fetchOwnerPortalStatements: arma el query string con propertyId/desde/hasta y desenvuelve { statements }", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe("http://api.local/rentas/owner-portal/statements?propertyId=prop-1&desde=2026-01-01&hasta=2026-02-01");
      return new Response(
        JSON.stringify({ statements: [{ id: "st-1", propertyId: "prop-1", organizationId: "org-1", organizationName: "Gestora", periodo: { inicio: "2026-01-01", fin: "2026-02-01" }, version: 1, moneda: "MXN", netoCentavos: 100, generadoEn: "2026-02-01T00:00:00.000Z" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await fetchOwnerPortalStatements(fetchImpl, "http://api.local", "tok", { propertyId: "prop-1", desde: "2026-01-01", hasta: "2026-02-01" });
    expect(result).toHaveLength(1);
  });

  it("fetchOwnerPortalStatements sin filtro: sin query string", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe("http://api.local/rentas/owner-portal/statements");
      return new Response(JSON.stringify({ statements: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchOwnerPortalStatements(fetchImpl, "http://api.local", "tok");
    expect(result).toEqual([]);
  });

  it("fetchOwnerPortalStatementDetalle: GET real por id", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe("http://api.local/rentas/owner-portal/statements/st-1");
      return new Response(
        JSON.stringify({
          id: "st-1",
          propertyId: "prop-1",
          organizationId: "org-1",
          organizationName: "Gestora",
          periodo: { inicio: "2026-01-01", fin: "2026-02-01" },
          version: 1,
          moneda: "MXN",
          netoCentavos: 100,
          generadoEn: "2026-02-01T00:00:00.000Z",
          totales: { ingresosBrutosCentavos: 100, comisionCanalCentavos: 0, comisionGestorCentavos: 0, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 100 },
          lineas: [],
          motivoVersion: null,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const detalle = await fetchOwnerPortalStatementDetalle(fetchImpl, "http://api.local", "tok", "st-1");
    expect(detalle.id).toBe("st-1");
  });

  it("statement de OTRO propietario -> 404 real (RLS/ownerId del JWT, nunca un parámetro manipulable)", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "Statement no encontrado." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchOwnerPortalStatementDetalle(fetchImpl, "http://api.local", "tok", "st-de-otro-owner")).rejects.toThrow(/Statement no encontrado/);
  });
});

describe("fetchOwnerPortalJson — refresh automático ante 401 usa /rentas/owner-portal/auth/refresh, nunca /auth/refresh", () => {
  it("un 401 dispara POST /rentas/owner-portal/auth/refresh con el refreshToken persistido y reintenta con el token nuevo", async () => {
    const refreshed: OwnerPortalSession = { token: "tok-nuevo", refreshToken: "refresh-nuevo", ownerId: "owner-1", email: "a@b.com" };
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === "http://api.local/rentas/owner-portal/auth/refresh") {
        expect(JSON.parse(init!.body as string)).toEqual({ refreshToken: "refresh-viejo" });
        return new Response(JSON.stringify(refreshed), { status: 200 });
      }
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer tok-viejo") return new Response(JSON.stringify({ message: "expirado" }), { status: 401 });
      expect(auth).toBe("Bearer tok-nuevo");
      return new Response(JSON.stringify({ unidades: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx, persisted } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", ownerId: "owner-1", email: "a@b.com" });

    const result = await fetchOwnerPortalJson<{ unidades: unknown[] }>(fetchImpl, "http://api.local/rentas/owner-portal/unidades", "tok-viejo", ctx);

    expect(result.unidades).toEqual([]);
    expect(calls).toEqual([
      "http://api.local/rentas/owner-portal/unidades",
      "http://api.local/rentas/owner-portal/auth/refresh",
      "http://api.local/rentas/owner-portal/unidades",
    ]);
    expect(persisted).toEqual([refreshed]);
  });

  it("refresh también responde 401 (refresh token revocado) -> limpia la sesión y lanza SessionExpiredError", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/rentas/owner-portal/auth/refresh") return new Response(JSON.stringify({ message: "Refresh token inválido o expirado." }), { status: 401 });
      return new Response(JSON.stringify({ message: "expirado" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, clearedCount, currentSession } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-revocado", ownerId: "owner-1", email: "a@b.com" });

    await expect(fetchOwnerPortalJson(fetchImpl, "http://api.local/rentas/owner-portal/me", "tok-viejo", ctx)).rejects.toThrow(SessionExpiredError);
    expect(clearedCount()).toBe(1);
    expect(currentSession()).toBeNull();
  });
});
