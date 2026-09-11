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

  it("restaurantesRepo/hotelesRepo fallan explícito en vez de fingir datos en memoria (gap de arquitectura documentado, ver production/not-ready.ts)", async () => {
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
