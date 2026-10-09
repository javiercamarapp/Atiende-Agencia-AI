// «Probar agente» contra Postgres REAL, con la sesion que usa `dbSession` en produccion (rol `authenticated` + `request.jwt.claim.sub`
// del staff). Los tests con repositorio en memoria NO ven las funciones SQL «solo sistema» (`consume_api_rate_limit` lanza 42501 si
// `auth.uid()` no es nulo): este archivo es la prueba que no las esconde.
//
// Se omite sin `VERIFY_PGURL`. Lo corre `scripts/verify-restaurantes-agente-preview-rate-limit/run.sh` (Postgres efimero de puerto alto con
// TODAS las migraciones reales); no hay nada que configurar en CI ordinario (`npm test` lo salta).
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, signAccessToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { openManagedPostgres } from "@atiende/db";
import type { ManagedPostgresEngine } from "@atiende/db";
import { PostgresRestaurantesRepository, PostgresVozRepository } from "@atiende/domain-restaurantes";
import { FakeVoiceProvider } from "@atiende/voice-core";
import type { AppDeps } from "../src/deps.ts";
import { restaurantesAgentePreviewRoutes, AGENTE_PREVIEW_LIMITES } from "../src/routes/verticals/restaurantes/agente-preview.ts";
import { restaurantesVozAdminRoutes } from "../src/routes/verticals/restaurantes/voz-admin.ts";

const PGURL = process.env.VERIFY_PGURL;
const JWT_SECRET = "pg-real-jwt-secret";

const ORG = "00000000-0000-0000-0000-0000000e0a01";
const PROP = "00000000-0000-0000-0000-0000000e0b01";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!PGURL)("POST .../admin/agente-whatsapp/preview/mensaje contra Postgres real (sesion de staff autenticado)", () => {
  let engine: ManagedPostgresEngine;
  let admin: pg.Client;
  let app: Hono<CoreAuthHonoEnv>;
  const staff: Record<string, { id: string; email: string; token: string }> = {};
  const turnos: string[] = [];

  async function crearStaff(clave: string, rol: "owner" | "admin"): Promise<void> {
    const id = randomUUID();
    const email = `${clave}-${id.slice(0, 8)}@example.com`;
    await admin.query("insert into core.staff_user (id, email, full_name, created_via) values ($1,$2,$3,'seed')", [id, email, clave]);
    await admin.query("insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values ($1,$2,null,$3,$4)", [id, ORG, rol === "owner" ? "owner" : "admin", rol]);
    const token = await signAccessToken({ sub: id, org_id: ORG, vertical: "restaurantes", property_ids: null, email }, JWT_SECRET, 900);
    staff[clave] = { id, email, token };
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PGURL });
    await admin.connect();
    await admin.query("insert into core.organization (id, vertical, name, slug) values ($1,'restaurantes','Preview PG','preview-pg') on conflict do nothing", [ORG]);
    await admin.query("insert into core.property (id, organization_id, name) values ($1,$2,'Sucursal PG') on conflict do nothing", [PROP, ORG]);
    await admin.query("insert into restaurantes.branch_detail (property_id, organization_id, slug) values ($1,$2,'sucursal-pg') on conflict do nothing", [PROP, ORG]);
    // Corridas repetidas sobre la misma base: el tope por organizacion es por dia, se parte de cero.
    await admin.query("delete from restaurantes.api_rate_limits where scope like 'agente-preview-%' or scope like 'voz-preview-%'");
    for (const k of ["dueno", "dueno2", "dueno3"]) await crearStaff(k, "owner");

    engine = openManagedPostgres({ connectionString: PGURL!, ssl: false, poolMax: 4 });
    const turnHandler = {
      async handleInboundMessage(entrada: { messages: readonly { content: string }[] }) {
        turnos.push(entrada.messages.at(-1)!.content);
        return { reply: "Hola, soy el asistente (prueba).", escalacion: undefined };
      },
    };
    const deps = {
      env: { jwtSecret: JWT_SECRET, voicePreviewTokenSecret: "pg-real-voice-preview-secret" },
      engine,
      restaurantesRepo: (db: ConstructorParameters<typeof PostgresRestaurantesRepository>[0]) => new PostgresRestaurantesRepository(db),
      coreRepo: { findMembershipsByUserId: async () => [] },
      llmGateway: {},
      turnHandler,
      vozRepo: (db: ConstructorParameters<typeof PostgresVozRepository>[0]) => new PostgresVozRepository(db),
      voiceProvider: new FakeVoiceProvider(),
    } as unknown as AppDeps;
    app = new Hono<CoreAuthHonoEnv>();
    // Mismo manejo de errores que apps/api/src/app.ts (+ `detail` para que el reporte muestre la causa real de un 500).
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json({ code: err.code, message: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503);
      return c.json({ code: "internal_error", message: "Error interno", detail: err instanceof Error ? err.message : String(err) }, 500);
    });
    app.route("/", restaurantesAgentePreviewRoutes(deps));
    app.route("/", restaurantesVozAdminRoutes(deps));
  });

  afterAll(async () => {
    await engine?.stop();
    await admin?.end();
  });

  const url = `/v1/restaurantes/${PROP}/admin/agente-whatsapp/preview/mensaje`;
  const enviar = (clave: string, sesionId: string) =>
    Promise.resolve(
      app.request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${staff[clave]!.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sesionId, mensajes: [{ rol: "usuario", texto: "Hola" }] }),
      }),
    );

  it("el PRIMER mensaje de un dueno autenticado responde 200 (no «Error interno») y llega al agente", async () => {
    const res = await enviar("dueno", randomUUID());
    const cuerpo = (await res.json()) as { respuesta?: string; detail?: string };
    expect(cuerpo.detail).toBeUndefined();
    expect(res.status).toBe(200);
    expect(cuerpo.respuesta).toContain("asistente");
    expect(turnos).toEqual(["Hola"]);
  });

  it("tope por staff: el mensaje 41 en la ventana de 10 min responde 429 y el agente NO se invoca; otro dueno de la misma organizacion no se ve afectado", async () => {
    const sesion = randomUUID();
    turnos.length = 0;
    // El primer mensaje del dueno ya conto (arriba): faltan 39 para llegar a 40.
    for (let i = 0; i < AGENTE_PREVIEW_LIMITES.porStaffPor10Min - 1; i++) expect((await enviar("dueno", sesion)).status).toBe(200);
    const mensaje41 = await enviar("dueno", sesion);
    expect(mensaje41.status).toBe(429);
    expect(turnos).toHaveLength(AGENTE_PREVIEW_LIMITES.porStaffPor10Min - 1);
    expect((await enviar("dueno2", sesion)).status).toBe(200);
  });

  it("tope por organizacion/dia: con 399 consumidos, el 400 pasa y el 401 responde 429 agente_preview_tope", async () => {
    await admin.query("delete from restaurantes.api_rate_limits where scope = 'agente-preview-org'");
    await admin.query("insert into restaurantes.api_rate_limits (scope, actor_hash, window_started_at, request_count) values ('agente-preview-org', $1, now(), $2)", [sha(ORG), AGENTE_PREVIEW_LIMITES.porOrganizacionPorDia - 1]);
    expect((await enviar("dueno3", randomUUID())).status).toBe(200);
    const tope = await enviar("dueno3", randomUUID());
    expect(tope.status).toBe(429);
    expect(((await tope.json()) as { code: string }).code).toBe("agente_preview_tope");
  });

  it("los contadores quedan atados al staff autenticado (hash de IP:staffId) y a la organizacion, no a un bucket global", async () => {
    const { rows } = await admin.query<{ scope: string; n: string }>("select scope, count(*)::text as n from restaurantes.api_rate_limits where scope in ('agente-preview-staff','agente-preview-org') group by scope order by scope");
    expect(rows).toEqual([
      { scope: "agente-preview-org", n: "1" },
      { scope: "agente-preview-staff", n: "3" },
    ]);
  });

  describe("preview de VOZ (mismo defecto de clase)", () => {
    const post = (path: string, clave: string, cuerpo: unknown) =>
      Promise.resolve(app.request(`/v1/restaurantes/${PROP}/admin/voz/${path}`, { method: "POST", headers: { authorization: `Bearer ${staff[clave]!.token}`, "content-type": "application/json" }, body: JSON.stringify(cuerpo) }));

    it("POST .../preview/sesion: la sesion de staff emite el token (201), no 500; tope de 20 sesiones/10 min => la 21 responde 429", async () => {
      const primera = await post("preview/sesion", "dueno", {});
      const cuerpo = (await primera.json()) as { sesionId?: string; tokenPreview?: string; detail?: string };
      expect(cuerpo.detail).toBeUndefined();
      expect(primera.status).toBe(201);
      for (let i = 1; i < 20; i++) expect((await post("preview/sesion", "dueno", {})).status).toBe(201);
      expect((await post("preview/sesion", "dueno", {})).status).toBe(429);
    });

    it("POST .../preview/:sesionId/herramienta: el limite (60/10 min por staff+sesion) no revienta con la sesion de staff", async () => {
      const sesion = (await (await post("preview/sesion", "dueno2", {})).json()) as { sesionId: string; tokenPreview: string };
      const res = await post(`preview/${sesion.sesionId}/herramienta`, "dueno2", { tokenPreview: sesion.tokenPreview, nombre: "consultar_sucursal", argumentos: {} });
      const cuerpo = (await res.json()) as { detail?: string };
      expect(cuerpo.detail).toBeUndefined();
      expect(res.status).toBe(200);
    });
  });
});
