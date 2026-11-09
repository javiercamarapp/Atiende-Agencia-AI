// QA adversarial citas, ronda 1 (lente CAOS) -- token vencido con peticiones EN PARALELO.
// El servidor real rota el refresh token y lo revoca al primer uso (apps/api/src/routes/auth.ts, POST /auth/refresh; ver el control
// en apps/api/tests/qa-citas-r1-caos.spec.ts). La Agenda dispara 4 GET a la vez al montar (proveedores, servicios, lista de espera y
// citas): cuando el access token de 15 min vence, las 4 reciben 401 casi juntas. Este doble de servidor reproduce esa semantica.
// Convencion: `it.fails` = defecto vigente (afirma lo ESPERADO); `it` = control que hoy pasa. Id: QA-citas-R1-caos-05.
import { describe, expect, it } from "vitest";
import { fetchJson, SessionExpiredError } from "../src/verticals/citas/lib/admin-client.ts";
import type { AuthedFetchContext } from "../src/lib/authed-fetch.ts";
import type { LoginSession } from "../src/verticals/citas/lib/auth-client.ts";

const API = "https://api.ejemplo.test";

function sesion(n: number): LoginSession {
  return { token: `acc-${n}`, refreshToken: `ref-${n}`, email: "duena@clinica.test", organizations: [] } as unknown as LoginSession;
}

/** Servidor falso: access token vigente = el ultimo emitido; refresh token de UN solo uso (rotacion con revocacion). */
function servidorRotativo(latenciaMs = 5) {
  let vigente = 1;
  const revocados = new Set<string>();
  let refrescosOk = 0;
  let refrescosRechazados = 0;
  const dormir = () => new Promise((r) => setTimeout(r, latenciaMs));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    await dormir();
    if (url.endsWith("/auth/refresh")) {
      const { refreshToken } = JSON.parse(String(init?.body ?? "{}")) as { refreshToken: string };
      if (revocados.has(refreshToken) || refreshToken !== `ref-${vigente}`) {
        refrescosRechazados += 1;
        return new Response(JSON.stringify({ message: "Refresh token inválido o expirado." }), { status: 401 });
      }
      revocados.add(refreshToken);
      vigente += 1;
      refrescosOk += 1;
      return new Response(JSON.stringify(sesion(vigente)), { status: 200 });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer acc-${vigente}`) return new Response(JSON.stringify({ message: "Sesion vencida" }), { status: 401 });
    return new Response(JSON.stringify({ ok: true, url }), { status: 200 });
  };
  return { fetchImpl, stats: () => ({ refrescosOk, refrescosRechazados }) };
}

function ctxCon(inicial: LoginSession) {
  let actual: LoginSession | null = inicial;
  let limpiezas = 0;
  const ctx: AuthedFetchContext<LoginSession> = {
    vertical: "citas",
    store: {
      read: () => actual,
      persist: (s) => {
        actual = s;
      },
      clear: () => {
        actual = null;
        limpiezas += 1;
      },
    },
  };
  return { ctx, limpiezas: () => limpiezas, actual: () => actual };
}

describe("QA R1 caos citas -- token vencido con peticiones en paralelo", () => {
  it("control: UNA peticion con el access token vencido se recupera con un solo refresh", async () => {
    const srv = servidorRotativo();
    // El navegador tiene acc-0 (vencido) y ref-1 (vigente) -- como tras 15 min de inactividad.
    const { ctx, limpiezas } = ctxCon({ ...sesion(1), token: "acc-0" } as LoginSession);
    const r = await fetchJson<{ ok: boolean }>(srv.fetchImpl, `${API}/v1/citas/properties/p/providers`, "acc-0", ctx);
    expect(r.ok).toBe(true);
    expect(srv.stats()).toEqual({ refrescosOk: 1, refrescosRechazados: 0 });
    expect(limpiezas()).toBe(0);
  });

  it("QA-citas-R1-caos-05: 4 peticiones en paralelo con el token vencido (montaje de la Agenda) NO deben cerrar la sesion", async () => {
    const srv = servidorRotativo();
    const { ctx, limpiezas, actual } = ctxCon({ ...sesion(1), token: "acc-0" } as LoginSession);
    const rutas = ["providers", "services", "waitlist", "appointments?from=a&to=b"];
    const resultados = await Promise.allSettled(rutas.map((r) => fetchJson(srv.fetchImpl, `${API}/v1/citas/properties/p/${r}`, "acc-0", ctx)));
    const expulsada = resultados.some((r) => r.status === "rejected" && r.reason instanceof SessionExpiredError);
    // Esperado: un solo refresh compartido (single-flight) y las 4 respuestas OK.
    // Actual: cada peticion refresca por su cuenta con el MISMO ref-1; la primera gana, las otras 3 reciben 401 del refresh,
    // withAuthRefresh limpia la sesion persistida y dispara SESSION_EXPIRED_EVENT -> el panel manda al staff al login a media tarea.
    expect({ expulsada, limpiezas: limpiezas(), sesionViva: actual() !== null, refrescos: srv.stats().refrescosOk }).toEqual({ expulsada: false, limpiezas: 0, sesionViva: true, refrescos: 1 });
  });
});
