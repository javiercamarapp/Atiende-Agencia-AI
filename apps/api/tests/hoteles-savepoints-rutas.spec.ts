// H-26/H-29 -- rutas que leen varias veces sobre la MISMA sesion transaccional del request, cada lectura bajo SAVEPOINT. Lanzadas en
// paralelo (Promise.all), el RELEASE del primer savepoint destruye el siguiente (3B001) y la ruta respondia 500 con o sin la migracion 039.
// Estas pruebas usan los repositorios Postgres REALES sobre una sesion que modela la pila de savepoints (NestedSavepointSession); los
// tests HTTP con repositorios en memoria no pueden detectar este fallo.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildHotelesTestContext } from "./hoteles-fixtures.ts";
import { NestedSavepointSession, type NestedSavepointHandler } from "./support/nested-savepoint-session.ts";

const TASK = randomUUID();
const ROOM = randomUUID();

const tareaFila = (propertyId: string) => ({
  id: TASK, property_id: propertyId, room_id: ROOM, room_code: "101", task_type: "salida", status: "pendiente", priority: "normal", work_date: "2026-03-10",
  assigned_to: null, notes: null, started_at: null, finished_at: null, inspection_result: null, inspected_by: null, inspected_at: null,
  inspection_note: null, rejections: 0, created_by: null, created_at: "2026-03-10T08:00:00Z", updated_at: "2026-03-10T08:00:00Z",
});
const configFila = (propertyId: string) => ({
  property_id: propertyId, auto_assign_enabled: true, max_tasks_per_camarista: 14, shift_minutes: 480, minutes_salida: 40, minutes_estancia: 20,
  minutes_profunda: 70, minutes_repaso: 10, photos_required_on_inspection: false, max_photos_per_task: 6, updated_at: "2026-03-10T08:00:00Z",
});
const falta = (code: string, msg: string): never => {
  throw Object.assign(new Error(msg), { code });
};

async function setup(handlersFor: (propertyId: string) => NestedSavepointHandler[]) {
  const ctx = await buildHotelesTestContext(buildApp);
  const membresia: NestedSavepointHandler = {
    match: /from core\.membership m/,
    rows: () => [{ organization_id: ctx.organizationId, platform_role: "owner", vertical_role: "owner", organization_status: "active" }],
  };
  const session = new NestedSavepointSession([membresia, ...handlersFor(ctx.propertyId)]);
  const deps: AppDeps = {
    ...ctx.deps,
    engine: { withAppSession: (_c, fn) => fn(session) },
    // La lista de camaristas se lee con SAVEPOINT sobre la sesion del request, como en produccion.
    coreStaffRepo: (db) => ({ listMembersByVerticalRole: async () => { await db.query("select 1 as camaristas"); return []; } }) as never,
  };
  // Sin hotelesMensajeriaConfigRepo / hotelesHousekeepingRepo / hotelesHousekeepingResidualRepo: se usan los repositorios Postgres reales.
  const app = buildApp(deps);
  const get = (path: string) => app.request(`/hoteles/${ctx.propertyId}${path}`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
  const post = (path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return app.request(`/hoteles/${ctx.propertyId}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) },
      body: raw,
    });
  };
  return { ctx, session, get, post };
}

function savepointsSecuenciales(session: NestedSavepointSession) {
  // Cada SAVEPOINT se libera (o se revierte) antes de abrir el siguiente: nunca entrelazados.
  let abiertos = 0;
  for (const c of session.calls) {
    if (c.startsWith("savepoint ")) abiertos += 1;
    else if (c.startsWith("release savepoint ") || c.startsWith("rollback to savepoint ")) abiertos -= c.startsWith("release") ? 1 : 0;
    expect(abiertos).toBeLessThanOrEqual(2); // un primario + a lo sumo su respaldo anidado; nunca dos lecturas hermanas abiertas
  }
}

describe("GET /hoteles/:propertyId/mensajeria", () => {
  it("base migrada: 200 y la transaccion queda sana", async () => {
    const s = await setup(() => [
      { match: /from hoteles\.whatsapp_channel_config/, rows: () => [{ phone_number_id: "109876543210", enabled: true, updated_at: "2026-03-10T08:00:00Z" }] },
      { match: /from hoteles\.voice_agent_config/, rows: () => [{ enabled: true, updated_at: "2026-03-10T08:00:00Z", tiene_secreto: true }] },
    ]);
    const res = await s.get("/mensajeria");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ whatsapp: { configurado: true, phoneNumberId: "109876543210" }, voz: { configurado: true, secretoConfigurado: true } });
    expect(s.session.abortada).toBe(false);
    savepointsSecuenciales(s.session);
  });

  it("base sin 039 (updated_at inexistente): 200 con respaldo y la transaccion queda sana", async () => {
    const s = await setup(() => [
      { match: /updated_at::text as updated_at from hoteles\.whatsapp_channel_config/, rows: () => falta("42703", 'column "updated_at" does not exist') },
      { match: /null::text as updated_at from hoteles\.whatsapp_channel_config/, rows: () => [{ phone_number_id: "109876543210", enabled: false, updated_at: null }] },
      { match: /from hoteles\.voice_agent_config/, rows: () => falta("42703", 'column "updated_at" does not exist') },
    ]);
    const res = await s.get("/mensajeria");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ whatsapp: { configurado: true }, voz: { configurado: false } });
    expect(s.session.abortada).toBe(false);
  });
});

describe("POST /hoteles/:propertyId/housekeeping/asignacion-automatica", () => {
  it("lee tareas y camaristas en secuencia: 200 y la transaccion queda sana", async () => {
    const s = await setup((p) => [
      { match: /from hoteles\.housekeeping_config/, rows: () => [configFila(p)] },
      { match: /from hoteles\.housekeeping_task t join/, rows: () => [tareaFila(p)] },
      { match: /select 1 as camaristas/, rows: () => [{ ok: 1 }] },
    ]);
    const res = await s.post("/housekeeping/asignacion-automatica", { fecha: "2026-03-10" });
    expect(res.status).toBe(200);
    expect(s.session.abortada).toBe(false);
    savepointsSecuenciales(s.session);
  });
});

describe("GET /hoteles/:propertyId/housekeeping/tareas/:taskId/fotos", () => {
  it("lee fotos y configuracion en secuencia: 200 y la transaccion queda sana", async () => {
    const s = await setup((p) => [
      { match: /from hoteles\.housekeeping_task t join/, rows: () => [tareaFila(p)] },
      { match: /from hoteles\.housekeeping_task_photo/, rows: () => [] },
      { match: /from hoteles\.housekeeping_config/, rows: () => [configFila(p)] },
    ]);
    const res = await s.get(`/housekeeping/tareas/${TASK}/fotos`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: true, fotos: [], maximo: 6 });
    expect(s.session.abortada).toBe(false);
    savepointsSecuenciales(s.session);
  });

  it("base sin 039 (tablas inexistentes): 200 con lista vacia honesta y la transaccion queda sana", async () => {
    const s = await setup((p) => [
      { match: /from hoteles\.housekeeping_task t join/, rows: () => [tareaFila(p)] },
      { match: /from hoteles\.housekeeping_task_photo/, rows: () => falta("42P01", 'relation "hoteles.housekeeping_task_photo" does not exist') },
      { match: /from hoteles\.housekeeping_config/, rows: () => falta("42P01", 'relation "hoteles.housekeeping_config" does not exist') },
    ]);
    const res = await s.get(`/housekeeping/tareas/${TASK}/fotos`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, fotos: [] });
    expect(s.session.abortada).toBe(false);
  });
});
