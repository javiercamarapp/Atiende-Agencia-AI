// Smoke test del handler REAL exportado para Vercel (apps/api/src/vercel.ts) —
// ejercita el adaptador `hono/vercel` de punta a punta: construye deps de producción
// (con un DATABASE_URL falso — `pg.Pool` nunca abre el socket hasta el primer
// `.connect()`/query real, así que esto no intenta una conexión de red) y llama al
// `default export` exactamente como Vercel lo invoca: `(req: Request) => Response`.
import { beforeAll, describe, expect, it } from "vitest";

const REQUIRED_ENV = {
  JWT_SECRET: "test-jwt-secret",
  VOICE_TOOL_SECRET: "test-voice-tool-secret",
  WHATSAPP_VERIFY_TOKEN: "test-verify-token",
  WHATSAPP_APP_SECRET: "test-whatsapp-app-secret",
  INTERNAL_SECRET: "test-internal-secret",
  // Fase 3 rentas — portal de propietario: secreto de firma independiente del de staff
  // (ver diseño Fase 3 §1.2/§3), también exigido por loadApiEnv().
  RENTAS_OWNER_JWT_SECRET: "test-rentas-owner-jwt-secret",
  // Cadena sintácticamente válida pero que nunca se disca de verdad en este test —
  // ver comentario de arriba.
  DATABASE_URL: "postgres://user:pass@localhost:5432/postgres",
} as const;

beforeAll(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
});

describe("apps/api/src/vercel.ts — handler exportado para Vercel", () => {
  it("responde /health con la firma Fetch estándar (Request -> Response) que hono/vercel produce", async () => {
    const { default: handler } = await import("../src/vercel.ts");
    const res = await handler(new Request("https://example.com/health"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("coreRepo/engine están conectados a un motor de Postgres real (ManagedPostgresEngine) — no en memoria", async () => {
    const { buildProductionDeps } = await import("../src/production/deps.ts");
    const deps = buildProductionDeps();
    expect(deps.coreRepo.constructor.name).toBe("ProductionCoreRepository");
    expect(typeof deps.engine.withAppSession).toBe("function");
  });

  // Rama feat/fusion-produccion-repos-por-request: restaurantesRepo/hotelesRepo/
  // citasRepo/licitacionesRepo/despachosRepo/rentasRepo/rentasOwnerPortalRepo dejaron
  // de ser `notProductionReady` (ver production/deps.ts) — ahora son fábricas reales
  // `(db) => new PostgresXRepository(db)`. Esta prueba confirma justo eso: la fábrica
  // construye un `PostgresRestaurantesRepository`/`PostgresHotelesRepository` real
  // (nunca el Proxy que lanza "sin adaptador de producción todavía"), aunque el
  // `TenantDbSession` que se le pase aquí sea uno de mentira (`{}` — no hace falta un
  // Postgres real para verificar QUÉ CLASE se construyó).
  it("restaurantesRepo/hotelesRepo son fábricas reales de Postgres*Repository -- ya NO son notProductionReady", async () => {
    const { buildProductionDeps } = await import("../src/production/deps.ts");
    const deps = buildProductionDeps();
    const fakeDb = {} as Parameters<typeof deps.restaurantesRepo>[0];
    expect(deps.restaurantesRepo(fakeDb).constructor.name).toBe("PostgresRestaurantesRepository");
    expect(deps.hotelesRepo(fakeDb).constructor.name).toBe("PostgresHotelesRepository");
  });

  // El gap de arquitectura de `production/not-ready.ts` sigue vivo para las
  // integraciones sin adaptador/credenciales (no relacionadas con sesión-por-request,
  // ver comentario de ese archivo) — `hotelesPaymentsPort` sigue fallando explícito.
  it("hotelesPaymentsPort SÍ sigue notProductionReady (gap distinto: sin credenciales de Stripe/Conekta, ver production/not-ready.ts)", async () => {
    const { buildProductionDeps } = await import("../src/production/deps.ts");
    const deps = buildProductionDeps();
    expect(() => deps.hotelesPaymentsPort.charge({ idempotencyKey: "test", amount: 100, currency: "MXN", paymentMethodToken: "tok_test" })).toThrow(/sin adaptador de producción todavía/);
  });

  // Rama feat/fusion-produccion-gateway-llm: turnHandler/hotelesTurnHandler/
  // citasTurnHandler dejan de ser SIEMPRE `notProductionReady` (ver
  // production/llm-gateway.ts + production/deps.ts) — pero en ESTE proceso de
  // prueba ninguna variable ANTHROPIC_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY
  // está configurada (ver REQUIRED_ENV de arriba), así que siguen siendo el
  // mismo placeholder explícito que `hotelesPaymentsPort` — fail-closed, nunca
  // un gateway que finge funcionar sin credenciales reales.
  it("turnHandler/hotelesTurnHandler/citasTurnHandler SIGUEN notProductionReady sin ninguna API key de proveedor LLM configurada", async () => {
    const { buildProductionDeps } = await import("../src/production/deps.ts");
    const deps = buildProductionDeps();
    expect(deps.llmGateway).toBeUndefined();
    expect(() => deps.turnHandler.handleInboundMessage({} as never)).toThrow(/sin adaptador de producción todavía/);
    expect(() => deps.hotelesTurnHandler.handleInboundMessage({} as never)).toThrow(/sin adaptador de producción todavía/);
    expect(() => deps.citasTurnHandler.handleInboundMessage({} as never)).toThrow(/sin adaptador de producción todavía/);
  });

  it("un request HTTP real que golpea restaurantesRepo con un DATABASE_URL de mentira falla 500 (intento real de conexión, ya no un error de 'no implementado')", async () => {
    const { default: handler } = await import("../src/vercel.ts");
    const body = JSON.stringify({ phone: "9991234567" });
    const res = await handler(
      new Request("https://example.com/v1/restaurantes/los-taquitos/customers/lookup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(body).byteLength),
          "x-atiende-tool-secret": REQUIRED_ENV.VOICE_TOOL_SECRET,
        },
        body,
      }),
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("internal_error");
  });
});
