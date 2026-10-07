// Autopiloto 2: casilla OPCIONAL y desmarcada de promociones por WhatsApp en el checkout web. Solo el booleano `true` registra el consentimiento
// de marketing (fuente `checkout_web`, version del aviso decidida por la base); sin la casilla NO se toca la tabla; el pedido nunca falla por esto,
// ni siquiera contra la base sin migrar (SAVEPOINT).
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const BASE = "/v1/restaurantes/los-taquitos-de-pm/storefront";
const ORIGIN = { origin: "http://localhost:5173" };
const SESSION = "sesion-web-promo-0001";

async function setup(modo: "ok" | "sin_migrar" = "ok") {
  const t = await buildTestDeps();
  const consentimientos: unknown[][] = [];
  const envolver = (session: TenantDbSession): TenantDbSession => ({
    exec: (sql) => session.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      if (/marketing_registrar_consentimiento/.test(sql)) {
        if (modo === "sin_migrar") throw Object.assign(new Error("function restaurantes.marketing_registrar_consentimiento(uuid) does not exist"), { code: "42883" });
        consentimientos.push(params ?? []);
        return { rows: [{ cambio: true }] as unknown as T[] };
      }
      return session.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = { withAppSession: (claims, fn) => t.deps.engine.withAppSession(claims, (s) => fn(envolver(s))) };
  const app = buildApp({ ...t.deps, engine });
  const post = (path: string, body: Record<string, unknown>) => app.request(`${BASE}${path}`, jsonRequestInit(body, ORIGIN));
  const pedir = async (extra: Record<string, unknown>) => {
    const body = { session_id: SESSION, items: [{ product_id: t.products.cocaCola, requested_quantity: 2 }], canal: "recoger", payment_method: "efectivo" };
    const quote = (await (await post("/fco-montejo/quote", body)).json()) as { quote_hash: string };
    await post("/fco-montejo/confirm", { session_id: SESSION, quote_hash: quote.quote_hash });
    return post("/fco-montejo/orders", { ...body, quote_hash: quote.quote_hash, acepta_aviso_privacidad: true, customer_name: "Ana Pérez", customer_phone: "999 123 4567", ...extra });
  };
  return { ...t, consentimientos, pedir };
}

describe("checkout web: casilla opcional de promociones por WhatsApp", () => {
  it("con acepta_promociones=true registra el consentimiento del cliente del pedido, fuente checkout_web, en la organizacion del slug", async () => {
    const s = await setup();
    const res = await s.pedir({ acepta_promociones: true });
    expect(res.status).toBe(200);
    expect(s.consentimientos).toHaveLength(1);
    const [organizationId, customerId, otorgar, fuente] = s.consentimientos[0]!;
    expect(organizationId).toBe(s.organizationId);
    expect(typeof customerId).toBe("string");
    expect(otorgar).toBe(true);
    expect(fuente).toBe("checkout_web");
  });

  it.each([[{}], [{ acepta_promociones: false }], [{ acepta_promociones: "true" }], [{ acepta_promociones: 1 }]])("sin la casilla (%j) NO se registra ningun consentimiento y el pedido se crea igual", async (extra) => {
    const s = await setup();
    const res = await s.pedir(extra);
    expect(res.status).toBe(200);
    expect(s.consentimientos).toEqual([]);
  });

  it("base sin la migracion 052: el pedido se crea igual (nunca un 500 ni un pedido perdido)", async () => {
    const s = await setup("sin_migrar");
    const res = await s.pedir({ acepta_promociones: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rastreo_token?: string }).rastreo_token).toBeTruthy();
  });
});
