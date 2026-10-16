// «Probar agente» contra Postgres REAL, con la sesion que usa `dbSession` en produccion (rol `authenticated` + `request.jwt.claim.sub`
// del staff). Los tests con repositorio en memoria NO ven las funciones SQL «solo sistema» (`consume_api_rate_limit` lanza 42501 si
// `auth.uid()` no es nulo): este archivo es la prueba que no las esconde.
//
// Se omite sin `VERIFY_PGURL`. Lo corre `scripts/verify-restaurantes-agente-preview-rate-limit/run.sh` (Postgres efimero de puerto alto con
// TODAS las migraciones reales); `npm test` lo salta, y en CI lo corre el job `restaurantes-agente-preview-pg-real-gate` de `postgres-real-gate.yml`.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, signAccessToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { openManagedPostgres } from "@atiende/db";
import type { ManagedPostgresEngine } from "@atiende/db";
import { PostgresRestaurantesRepository, PostgresVozRepository, telefonoFicticioPreview } from "@atiende/domain-restaurantes";
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

    const herramienta = async (clave: string, sesion: { sesionId: string; tokenPreview: string }, nombre: string, argumentos: unknown = {}, extra: Record<string, unknown> = {}) => {
      const res = await post(`preview/${sesion.sesionId}/herramienta`, clave, { tokenPreview: sesion.tokenPreview, nombre, argumentos, ...extra });
      const cuerpo = (await res.json()) as { resultado?: Record<string, unknown>; simulado?: boolean; detail?: string };
      return { status: res.status, cuerpo, resultado: cuerpo.resultado ?? {} };
    };
    const nuevaSesion = async (clave: string) => (await (await post("preview/sesion", clave, {})).json()) as { sesionId: string; tokenPreview: string };

    // Fotografia de TODAS las tablas de dominio: el preview de voz corre ahora en sesion de sistema (con permiso para escribir), y la unica
    // prueba de que NO escribe nada real es contar filas antes y despues.
    async function fotoTablas(): Promise<Record<string, number>> {
      const { rows } = await admin.query<{ t: string }>(
        "select format('%I.%I', n.nspname, c.relname) as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname in ('restaurantes','core') order by 1",
      );
      const foto: Record<string, number> = {};
      for (const { t } of rows) foto[t] = Number((await admin.query<{ n: string }>(`select count(*)::text as n from ${t}`)).rows[0]!.n);
      return foto;
    }
    const difiere = (antes: Record<string, number>, despues: Record<string, number>) =>
      Object.keys(despues)
        .filter((t) => antes[t] !== despues[t])
        .sort();
    // Estado interno del flujo (maquina de cotizar/confirmar/crear de la llamada) y contadores de uso: son lo UNICO que el preview puede tocar.
    const PERMITIDAS = ["restaurantes.api_rate_limits", "restaurantes.order_flow_state"];

    const PRODUCTO = randomUUID();
    const ORG_AJENA = "00000000-0000-0000-0000-0000000e0a02";
    const PROP_AJENA = "00000000-0000-0000-0000-0000000e0b02";
    const ITEMS = [{ product_id: PRODUCTO, product_name: "Agua de prueba", requested_quantity: 2 }];
    const CREAR = { branch_slug: "sucursal-pg", customer_name: "Prueba", items: ITEMS, payment_method: "efectivo", canal: "recoger" };

    describe("ejecucion de herramientas del preview de voz (la sesion de staff NO puede con las funciones de solo sistema)", () => {
      beforeAll(async () => {
        await admin.query("insert into restaurantes.products (id, organization_id, name, price) values ($1,$2,'Agua de prueba',45) on conflict do nothing", [PRODUCTO, ORG]);
        await admin.query("insert into restaurantes.branch_products (property_id, product_id, price) values ($1,$2,45) on conflict do nothing", [PROP, PRODUCTO]);
        // Otra organizacion con su sucursal: nada de lo que mande el cuerpo debe poder alcanzarla.
        await admin.query("insert into core.organization (id, vertical, name, slug) values ($1,'restaurantes','Ajena PG','ajena-pg') on conflict do nothing", [ORG_AJENA]);
        await admin.query("insert into core.property (id, organization_id, name) values ($1,$2,'Sucursal ajena') on conflict do nothing", [PROP_AJENA, ORG_AJENA]);
        await admin.query("insert into restaurantes.branch_detail (property_id, organization_id, slug) values ($1,$2,'sucursal-ajena') on conflict do nothing", [PROP_AJENA, ORG_AJENA]);
      });

      /** Siembra un pedido ANTERIOR del telefono ficticio de la sesion, para que historial_pedidos y repetir_pedido tengan algo que leer. */
      async function sembrarHistorial(sesionId: string): Promise<void> {
        const tel = telefonoFicticioPreview(sesionId);
        const { rows } = await admin.query<{ id: string }>("insert into restaurantes.customers (organization_id, phone, name, order_count) values ($1,$2,'Cliente previo',1) on conflict (organization_id, phone) do update set name = excluded.name returning id", [ORG, tel]);
        await admin.query(
          "insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, branch, total, status, items, source, canal, payment_method) values ($1,$2,$3,'Cliente previo',$4,'Sucursal PG',90,'entregado',$5::jsonb,'voice','recoger','efectivo')",
          [ORG, PROP, rows[0]!.id, tel, JSON.stringify([{ id: PRODUCTO, name: "Agua de prueba", quantity: 2, price: 45 }])],
        );
      }

      it("historial_pedidos y repetir_pedido: sin error (antes: 42501 cliente_memoria es solo para la sesion de sistema) y repetir entra al flujo de cotizacion", async () => {
        const sesion = await nuevaSesion("dueno2");
        await sembrarHistorial(sesion.sesionId);
        const historial = await herramienta("dueno2", sesion, "historial_pedidos");
        expect(historial.status).toBe(200);
        expect(historial.cuerpo.detail).toBeUndefined();
        expect(historial.resultado.error).toBeUndefined();
        expect(historial.resultado.total_pedidos_anteriores).toBe(1);
        const repetir = await herramienta("dueno2", sesion, "repetir_pedido", { branch_slug: "sucursal-pg", canal: "recoger" });
        expect(repetir.resultado.error).toBeUndefined();
        expect(repetir.resultado.quote_hash).toMatch(/^[0-9a-f]{32}$/);
      });

      it("cotizar -> confirmar_resumen -> crear_pedido: devuelve el pedido SIMULADO (PRUEBA-xxxx) y NO escribe pedido, cliente, comanda, aviso ni correo", async () => {
        const sesion = await nuevaSesion("dueno2");
        const antes = await fotoTablas();
        const cotizacion = await herramienta("dueno2", sesion, "cotizar_pedido", { branch_slug: "sucursal-pg", items: ITEMS, canal: "recoger" });
        expect(cotizacion.resultado.error).toBeUndefined();
        const hash = cotizacion.resultado.quote_hash as string;
        expect(hash).toMatch(/^[0-9a-f]{32}$/);
        const confirmacion = await herramienta("dueno2", sesion, "confirmar_resumen", { quote_hash: hash });
        expect(confirmacion.resultado.error).toBeUndefined();
        expect(confirmacion.resultado.confirmado).toBe(true);
        const creacion = await herramienta("dueno2", sesion, "crear_pedido", CREAR);
        expect(creacion.status).toBe(200);
        // Primero lo que importa: ninguna tabla de dominio cambio (si el modo fuera `real` aqui aparecerian orders, customers, comandas, avisos...).
        expect(difiere(antes, await fotoTablas()).filter((t) => !PERMITIDAS.includes(t))).toEqual([]);
        expect(creacion.resultado.error).toBeUndefined();
        expect(creacion.cuerpo.simulado).toBe(true);
        const orden = creacion.resultado.order as { id: string; status: string; total: number; simulado: boolean };
        expect(orden.id).toMatch(/^PRUEBA-[0-9A-F]{4}$/);
        expect(orden).toMatchObject({ status: "simulado", total: 90, simulado: true });
        const { rows } = await admin.query<{ n: string }>("select count(*)::text as n from restaurantes.orders where organization_id = $1 and customer_phone = $2", [ORG, telefonoFicticioPreview(sesion.sesionId)]);
        expect(rows[0]!.n).toBe("0");
      });

      it("el modo y la organizacion los fija el SERVIDOR: `modo: real`, `organizationId`, `phone` en el cuerpo o en los argumentos no cambian nada (sigue simulado y sin escrituras)", async () => {
        const sesion = await nuevaSesion("dueno2");
        const antes = await fotoTablas();
        const ataque = { modo: "real", organizationId: ORG_AJENA, organization_id: ORG_AJENA, propertyId: PROP_AJENA, phone: "9991112233", lockedPropertyId: PROP_AJENA };
        const cot = await herramienta("dueno2", sesion, "cotizar_pedido", { branch_slug: "sucursal-pg", items: ITEMS, canal: "recoger", ...ataque }, ataque);
        expect(cot.resultado.error).toBeUndefined();
        expect((await herramienta("dueno2", sesion, "confirmar_resumen", { quote_hash: cot.resultado.quote_hash, ...ataque }, ataque)).resultado.error).toBeUndefined();
        const creacion = await herramienta("dueno2", sesion, "crear_pedido", { ...CREAR, ...ataque }, ataque);
        expect(difiere(antes, await fotoTablas()).filter((t) => !PERMITIDAS.includes(t))).toEqual([]);
        expect(creacion.resultado.error).toBeUndefined();
        expect(creacion.cuerpo.simulado).toBe(true);
        expect((creacion.resultado.order as { id: string }).id).toMatch(/^PRUEBA-/);
        const { rows } = await admin.query<{ n: string }>("select count(*)::text as n from restaurantes.orders where customer_phone = '9991112233' or organization_id = $1", [ORG_AJENA]);
        expect(rows[0]!.n).toBe("0");
      });

      it("registrar_contacto y escalar_a_humano: exito simulado y NINGUN aviso (callback) ni notificacion al equipo", async () => {
        const sesion = await nuevaSesion("dueno2");
        const antes = await fotoTablas();
        const contacto = await herramienta("dueno2", sesion, "registrar_contacto", { reason: "pidio_llamada", customer_name: "Prueba", message: "hola" });
        expect(contacto.resultado).toMatchObject({ ok: true, simulado: true });
        const escalada = await herramienta("dueno2", sesion, "escalar_a_humano", { motivo: "queja", resumen: "prueba" });
        expect(escalada.resultado).toMatchObject({ ok: true, simulado: true });
        expect(difiere(antes, await fotoTablas()).filter((t) => !PERMITIDAS.includes(t))).toEqual([]);
      });

      it("aislamiento: una sucursal de OTRA organizacion en los argumentos no devuelve datos ajenos ni escribe", async () => {
        const sesion = await nuevaSesion("dueno2");
        const antes = await fotoTablas();
        const ajena = await herramienta("dueno2", sesion, "cotizar_pedido", { branch_slug: "sucursal-ajena", items: ITEMS, canal: "recoger" });
        expect(ajena.status).toBe(200);
        expect(typeof ajena.resultado.error).toBe("string");
        expect(ajena.resultado.quote).toBeUndefined();
        expect(difiere(antes, await fotoTablas()).filter((t) => !PERMITIDAS.includes(t))).toEqual([]);
      });

      it("la autorizacion ocurre ANTES de abrir la sesion de sistema: sin token / token de otra sesion / otro dueno de otra organizacion no ejecutan nada", async () => {
        const sesion = await nuevaSesion("dueno2");
        const otra = await nuevaSesion("dueno2");
        const antes = await fotoTablas();
        const sinToken = await post(`preview/${sesion.sesionId}/herramienta`, "dueno2", { nombre: "consultar_sucursal", argumentos: {} });
        expect(sinToken.status).toBe(401);
        const tokenAjeno = await post(`preview/${sesion.sesionId}/herramienta`, "dueno2", { tokenPreview: otra.tokenPreview, nombre: "consultar_sucursal", argumentos: {} });
        expect([401, 403]).toContain(tokenAjeno.status);
        const desconocida = await post(`preview/${sesion.sesionId}/herramienta`, "dueno2", { tokenPreview: sesion.tokenPreview, nombre: "borrar_todo", argumentos: {} });
        expect(desconocida.status).toBe(400);
        expect(difiere(antes, await fotoTablas()).filter((t) => t !== "restaurantes.api_rate_limits")).toEqual([]);
      });
    });
  });
});
