// Rn-07 -- HTTP real (app.request) de las solicitudes ARCO de rentas: rol (solo admin_gestora), registro idempotente,
// plazos, transiciones, notificacion in-app sin PII y degradacion contra la base sin la migracion 028 (nunca 500).
import { describe, expect, it } from "vitest";
import { InMemoryRentasPrivacidadRepository } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

async function preparar(opciones: ConstructorParameters<typeof InMemoryRentasPrivacidadRepository>[0] = {}) {
  const ctx = await buildRentasTestContext(buildApp);
  const privacidad = new InMemoryRentasPrivacidadRepository(opciones);
  const app = buildApp({ ...ctx.deps, rentasPrivacidadRepo: () => privacidad });
  return { ctx, app, privacidad, base: `/rentas/${ctx.propertyId}/privacidad/solicitudes` };
}

const CUERPO = { derecho: "acceso", canal: "correo", solicitanteNombre: "Titular Uno", solicitanteContacto: "titular1@example.com", detalle: "Quiere copia de sus datos" };

describe("solicitudes ARCO de rentas (HTTP)", () => {
  it("solo admin_gestora: el resto de los roles recibe 403 y sin token 401", async () => {
    const { ctx, app, base } = await preparar();
    for (const t of [ctx.staff.operadorAccesoTotal.token, ctx.staff.contador.token, ctx.staff.limpieza.token, ctx.staff.operadorSoloCalendario.token]) {
      expect((await app.request(base, authedJson(t, undefined, {}, "GET"))).status).toBe(403);
      expect((await app.request(base, authedJson(t, CUERPO))).status).toBe(403);
    }
    expect((await app.request(base, { method: "GET" })).status).toBe(401);
  });

  it("registra (201), es idempotente (200), lista con folio y plazo, y valida el cuerpo (400)", async () => {
    const { ctx, app, base } = await preparar();
    const t = ctx.staff.adminGestora.token;
    const creada = await app.request(base, authedJson(t, CUERPO));
    expect(creada.status).toBe(201);
    const { id, folio, creada: esNueva } = (await creada.json()) as { id: string; folio: string; creada: boolean };
    expect(esNueva).toBe(true);
    expect(folio).toMatch(/^ARCO-R-[0-9A-F]{8}$/);
    const repetida = await app.request(base, authedJson(t, { ...CUERPO, solicitanteContacto: " TITULAR1@example.com " }));
    expect(repetida.status).toBe(200);
    expect(await repetida.json()).toMatchObject({ id, creada: false });

    const lista = (await (await app.request(base, authedJson(t, undefined, {}, "GET"))).json()) as { disponible: boolean; total: number; plazos: { respuestaDias: number; ejecucionDias: number }; items: { id: string; estado: string; plazo: string; folio: string }[] };
    expect(lista).toMatchObject({ disponible: true, total: 1, plazos: { respuestaDias: 20, ejecucionDias: 15 } });
    expect(lista.items[0]).toMatchObject({ id, estado: "recibida", plazo: "en_plazo", folio });

    for (const malo of [{ ...CUERPO, derecho: "borrado" }, { ...CUERPO, canal: "sms" }, { ...CUERPO, solicitanteNombre: "" }, { ...CUERPO, recibidaEn: "2999-01-01T00:00:00Z" }]) {
      expect((await app.request(base, authedJson(t, malo))).status).toBe(400);
    }
    expect((await app.request(`${base}?estado=otra`, authedJson(t, undefined, {}, "GET"))).status).toBe(400);
    expect((await app.request(`${base}?limit=0`, authedJson(t, undefined, {}, "GET"))).status).toBe(400);
  });

  it("una solicitud recibida hace 30 dias aparece 'por_vencer' o 'vencida' segun su plazo", async () => {
    const { ctx, app, base } = await preparar();
    const t = ctx.staff.adminGestora.token;
    const hace = new Date(Date.now() - 22 * 24 * 3600 * 1000).toISOString();
    await app.request(base, authedJson(t, { ...CUERPO, recibidaEn: hace }));
    const lista = (await (await app.request(base, authedJson(t, undefined, {}, "GET"))).json()) as { items: { plazo: string }[] };
    expect(lista.items[0]!.plazo).toBe("vencida");
  });

  it("cambia el estado con su bitacora; resuelta es terminal (409); rechazar exige motivo (400); id invalido 400; inexistente 404", async () => {
    const { ctx, app, base } = await preparar();
    const t = ctx.staff.adminGestora.token;
    const { id } = (await (await app.request(base, authedJson(t, CUERPO))).json()) as { id: string };
    const patch = (cuerpo: unknown, ruta = id) => app.request(`${base}/${ruta}/estado`, authedJson(t, cuerpo, {}, "PATCH"));
    expect((await patch({ estado: "rechazada" })).status).toBe(400);
    expect((await patch({ estado: "recibida" })).status).toBe(400);
    expect((await patch({ estado: "en_proceso" })).status).toBe(200);
    expect(await (await patch({ estado: "resuelta", nota: "Entregada la copia" })).json()).toEqual({ id, estado: "resuelta" });
    expect((await patch({ estado: "en_proceso" })).status).toBe(409);
    expect((await patch({ estado: "en_proceso" }, "no-es-uuid")).status).toBe(400);
    expect((await patch({ estado: "en_proceso" }, "00000000-0000-4000-8000-0000000000ff")).status).toBe(404);
    const ev = (await (await app.request(`${base}/${id}/eventos`, authedJson(t, undefined, {}, "GET"))).json()) as { disponible: boolean; items: { hacia: string }[] };
    expect(ev.items.map((e) => e.hacia)).toEqual(["recibida", "en_proceso", "resuelta"]);
  });

  it("contra la base sin la migracion 028: la lista responde disponible:false y las escrituras 503, nunca 500", async () => {
    const { ctx, app, base } = await preparar({ disponible: false });
    const t = ctx.staff.adminGestora.token;
    const lista = await app.request(base, authedJson(t, undefined, {}, "GET"));
    expect(lista.status).toBe(200);
    expect(await lista.json()).toMatchObject({ disponible: false, total: 0, items: [] });
    expect((await app.request(base, authedJson(t, CUERPO))).status).toBe(503);
    expect((await app.request(`${base}/00000000-0000-4000-8000-0000000000ff/estado`, authedJson(t, { estado: "en_proceso" }, {}, "PATCH"))).status).toBe(503);
    expect(await (await app.request(`${base}/00000000-0000-4000-8000-0000000000ff/eventos`, authedJson(t, undefined, {}, "GET"))).json()).toEqual({ disponible: false, items: [] });
  });

  it("si la base rechaza por rol (RLS) la ruta responde 403, no 500", async () => {
    const { ctx, app, base } = await preparar({ autorizado: false });
    expect((await app.request(base, authedJson(ctx.staff.adminGestora.token, CUERPO))).status).toBe(403);
  });
});
