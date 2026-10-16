// H-26 -- housekeeping residual: integracion HTTP real (app.request) sobre los repositorios en memoria. RLS/GRANT/triggers los cubre
// scripts/verify-hoteles-hk-canal contra Postgres real; el SAVEPOINT contra base sin migrar, packages/domain-hoteles/tests/housekeeping-residual-savepoint.spec.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryHousekeepingRepository, InMemoryHousekeepingResidualRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

const FECHA = "2026-03-10";
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
const SVG_B64 = Buffer.from("<svg onload=alert(1)></svg>").toString("base64");

async function setup(opts?: { migrated?: boolean }) {
  const ctx = await buildHotelesTestContext(buildApp);
  const hk = new InMemoryHousekeepingRepository();
  const residual = new InMemoryHousekeepingResidualRepository(hk, opts);
  const roomA = randomUUID();
  const roomB = randomUUID();
  hk.seedRoom({ id: roomA, propertyId: ctx.propertyId, code: "101", status: "ocupada" });
  hk.seedRoom({ id: roomB, propertyId: ctx.propertyId, code: "102", status: "sucia" });
  for (const s of Object.values(ctx.staff)) hk.seedStaff(ctx.propertyId, s.id);
  const app = buildApp({ ...ctx.deps, hotelesHousekeepingRepo: () => hk, hotelesHousekeepingResidualRepo: () => residual });
  const base = `/hoteles/${ctx.propertyId}/housekeeping`;
  const call = (method: string, path: string, token: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let raw: string | undefined;
    if (body !== undefined) {
      raw = JSON.stringify(body);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(new TextEncoder().encode(raw).byteLength);
    }
    return app.request(`${base}${path}`, { method, headers, ...(raw !== undefined ? { body: raw } : {}) });
  };
  return { ctx, hk, residual, app, base, roomA, roomB, call };
}
type S = Awaited<ReturnType<typeof setup>>;

async function newTask(s: S, roomId: string, tipo = "salida") {
  const res = await s.app.request(`${s.base}/tareas`, authedJson(s.ctx.staff.frontdesk.token, { roomId, tipo, fecha: FECHA }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("configuracion", () => {
  it("sin fila devuelve los valores por defecto y la vision declarada como NO disponible", async () => {
    const s = await setup();
    const res = await s.call("GET", "/configuracion", s.ctx.staff.housekeeping.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ disponible: true, personalizada: false, asignacionAutomatica: false, maxTareasPorCamarista: 14, fotosObligatoriasEnInspeccion: false, maxFotosPorTarea: 6 });
    expect(body.vision).toMatchObject({ disponible: false });
  });

  it("solo owner/gm editan (403 al resto) y el cuerpo se valida (400)", async () => {
    const s = await setup();
    for (const t of [s.ctx.staff.frontdesk.token, s.ctx.staff.housekeeping.token, s.ctx.staff.fnb.token]) {
      expect((await s.call("PUT", "/configuracion", t, { asignacionAutomatica: true })).status).toBe(403);
    }
    expect((await s.call("PUT", "/configuracion", s.ctx.staff.owner.token, { maxTareasPorCamarista: 0 })).status).toBe(400);
    expect((await s.call("PUT", "/configuracion", s.ctx.staff.owner.token, {})).status).toBe(400);
    const ok = await s.call("PUT", "/configuracion", s.ctx.staff.gm.token, { asignacionAutomatica: true, minutosPorTipo: { salida: 50 } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ personalizada: true, asignacionAutomatica: true, minutosPorTipo: { salida: 50, estancia: 20 } });
    expect(await (await s.call("GET", "/configuracion", s.ctx.staff.frontdesk.token)).json()).toMatchObject({ asignacionAutomatica: true });
  });

  it("hora de arranque del dia (H-P3-04): default 7, owner/gm la cambian (0..23), el resto 403 y fuera de rango 400", async () => {
    const s = await setup();
    expect(await (await s.call("GET", "/configuracion", s.ctx.staff.owner.token)).json()).toMatchObject({ horaArranque: 7, horaArranqueDisponible: true });
    for (const t of [s.ctx.staff.frontdesk.token, s.ctx.staff.housekeeping.token]) expect((await s.call("PUT", "/configuracion", t, { horaArranque: 6 })).status).toBe(403);
    for (const malo of [24, -1, 6.5, "6"]) expect((await s.call("PUT", "/configuracion", s.ctx.staff.owner.token, { horaArranque: malo })).status).toBe(400);
    const ok = await s.call("PUT", "/configuracion", s.ctx.staff.gm.token, { horaArranque: 6 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ horaArranque: 6, personalizada: true });
    expect(await (await s.call("GET", "/configuracion", s.ctx.staff.frontdesk.token)).json()).toMatchObject({ horaArranque: 6 });
  });

  it("base sin migrar: GET degrada (disponible:false) y PUT responde 503", async () => {
    const s = await setup({ migrated: false });
    expect(await (await s.call("GET", "/configuracion", s.ctx.staff.owner.token)).json()).toMatchObject({ disponible: false, personalizada: false });
    expect((await s.call("PUT", "/configuracion", s.ctx.staff.owner.token, { asignacionAutomatica: true })).status).toBe(503);
  });
});

describe("fotos de inspeccion", () => {
  it("sube, lista, descarga con cabeceras seguras y retira", async () => {
    const s = await setup();
    const taskId = await newTask(s, s.roomB);
    const up = await s.call("POST", `/tareas/${taskId}/fotos`, s.ctx.staff.housekeeping.token, { imagen: PNG_B64, descripcion: "Bano limpio" });
    expect(up.status).toBe(201);
    const photo = (await up.json()) as { id: string; tipo: string; bytes: number };
    expect(photo).toMatchObject({ tipo: "image/png", bytes: 12 });

    const list = (await (await s.call("GET", `/tareas/${taskId}/fotos`, s.ctx.staff.frontdesk.token)).json()) as { fotos: unknown[]; maximo: number; vision: { disponible: boolean } };
    expect(list.fotos).toHaveLength(1);
    expect(list.maximo).toBe(6);
    expect(list.vision.disponible).toBe(false);

    const img = await s.call("GET", `/tareas/${taskId}/fotos/${photo.id}`, s.ctx.staff.frontdesk.token);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.headers.get("cache-control")).toBe("private, no-store");
    expect(img.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(new Uint8Array(await img.arrayBuffer()).length).toBe(12);

    expect((await s.call("DELETE", `/tareas/${taskId}/fotos/${photo.id}`, s.ctx.staff.housekeeping.token)).status).toBe(200);
    expect((await s.call("GET", `/tareas/${taskId}/fotos/${photo.id}`, s.ctx.staff.frontdesk.token)).status).toBe(404);
  });

  it("rechaza SVG/HTML aunque venga como imagen (400), base64 invalido y roles sin acceso", async () => {
    const s = await setup();
    const taskId = await newTask(s, s.roomB);
    expect((await s.call("POST", `/tareas/${taskId}/fotos`, s.ctx.staff.housekeeping.token, { imagen: SVG_B64 })).status).toBe(400);
    expect((await s.call("POST", `/tareas/${taskId}/fotos`, s.ctx.staff.housekeeping.token, { imagen: "###" })).status).toBe(400);
    expect((await s.call("POST", `/tareas/${taskId}/fotos`, s.ctx.staff.fnb.token, { imagen: PNG_B64 })).status).toBe(403);
    for (const cuerpo of [null, [], "texto"]) {
      expect((await s.call("POST", `/tareas/${taskId}/fotos`, s.ctx.staff.housekeeping.token, cuerpo)).status).toBe(400);
    }
    expect((await s.call("POST", `/tareas/${randomUUID()}/fotos`, s.ctx.staff.housekeeping.token, { imagen: PNG_B64 })).status).toBe(404);
  });

  it("respeta maxFotosPorTarea (409) y una tarea cancelada no recibe fotos (409)", async () => {
    const s = await setup();
    const taskId = await newTask(s, s.roomB);
    await s.call("PUT", "/configuracion", s.ctx.staff.owner.token, { maxFotosPorTarea: 1 });
    expect((await s.call("POST", `/tareas/${taskId}/fotos`, s.ctx.staff.housekeeping.token, { imagen: PNG_B64 })).status).toBe(201);
    expect((await s.call("POST", `/tareas/${taskId}/fotos`, s.ctx.staff.housekeeping.token, { imagen: PNG_B64 })).status).toBe(409);
    const other = await newTask(s, s.roomA, "estancia");
    await s.app.request(`${s.base}/tareas/${other}/cancelar`, authedJson(s.ctx.staff.frontdesk.token, {}));
    expect((await s.call("POST", `/tareas/${other}/fotos`, s.ctx.staff.housekeeping.token, { imagen: PNG_B64 })).status).toBe(409);
  });

  it("una camarista no sube fotos de la tarea asignada a OTRA (403)", async () => {
    const s = await setup();
    const taskId = await newTask(s, s.roomB);
    await s.app.request(`${s.base}/tareas/${taskId}/asignar`, authedJson(s.ctx.staff.frontdesk.token, { asignadoA: s.ctx.staff.frontdesk.id }));
    expect((await s.call("POST", `/tareas/${taskId}/fotos`, s.ctx.staff.housekeeping.token, { imagen: PNG_B64 })).status).toBe(403);
  });

  it("fotos obligatorias: aprobar sin foto es 409, con foto pasa; rechazar nunca exige foto", async () => {
    const s = await setup();
    await s.call("PUT", "/configuracion", s.ctx.staff.owner.token, { fotosObligatoriasEnInspeccion: true });
    const taskId = await newTask(s, s.roomB);
    const hkToken = s.ctx.staff.housekeeping.token;
    await s.app.request(`${s.base}/tareas/${taskId}/iniciar`, authedJson(hkToken, {}));
    await s.app.request(`${s.base}/tareas/${taskId}/terminar`, authedJson(hkToken, {}));
    const inspect = (aprobada: boolean, nota?: string) => s.app.request(`${s.base}/tareas/${taskId}/inspeccionar`, authedJson(s.ctx.staff.frontdesk.token, { aprobada, ...(nota ? { nota } : {}) }));
    expect((await inspect(true)).status).toBe(409);
    await s.call("POST", `/tareas/${taskId}/fotos`, hkToken, { imagen: PNG_B64 });
    expect((await inspect(true)).status).toBe(200);
  });
});

describe("conteo de blancos", () => {
  it("registra, corrige el mismo dia y compara con el conteo anterior", async () => {
    const s = await setup();
    const put = (fecha: string, body: object) => s.call("PUT", "/blancos", s.ctx.staff.housekeeping.token, { articulo: "sabanas", fecha, ...body });
    expect((await put("2026-03-09", { limpias: 100, sucias: 10 })).status).toBe(200);
    expect((await put(FECHA, { limpias: 80, sucias: 10 })).status).toBe(200);
    expect((await put(FECHA, { limpias: 85, sucias: 10 })).status).toBe(200); // corrige
    const rep = (await (await s.call("GET", `/blancos?fecha=${FECHA}`, s.ctx.staff.frontdesk.token)).json()) as { articulos: { articulo: string; total: number | null; diferencia: number | null; conteoAnterior: { total: number } | null }[] };
    const sabanas = rep.articulos.find((a) => a.articulo === "sabanas")!;
    expect(sabanas).toMatchObject({ total: 95, diferencia: -15, conteoAnterior: { total: 110 } });
    expect(rep.articulos).toHaveLength(7);
  });
  it("valida el articulo (400) y fnb no registra (403)", async () => {
    const s = await setup();
    expect((await s.call("PUT", "/blancos", s.ctx.staff.housekeeping.token, { articulo: "mantel", fecha: FECHA })).status).toBe(400);
    expect((await s.call("PUT", "/blancos", s.ctx.staff.fnb.token, { articulo: "sabanas", fecha: FECHA })).status).toBe(403);
  });
});

describe("opt-out de limpieza", () => {
  it("un cuerpo JSON que no es objeto (null, arreglo, texto) responde 400, nunca 500", async () => {
    const s = await setup();
    for (const cuerpo of [null, [], "texto"]) {
      expect((await s.call("POST", "/opt-out", s.ctx.staff.frontdesk.token, cuerpo)).status).toBe(400);
    }
  });

  it("registra, cancela la estancia pendiente, impide crearla de nuevo, generar el dia la omite y se puede revertir", async () => {
    const s = await setup();
    const estancia = await newTask(s, s.roomA, "estancia");
    const res = await s.call("POST", "/opt-out", s.ctx.staff.frontdesk.token, { roomId: s.roomA, fecha: FECHA, origen: "huesped" });
    expect(res.status).toBe(201);
    const optOut = (await res.json()) as { id: string; tareasCanceladas: number; estado: string };
    expect(optOut).toMatchObject({ tareasCanceladas: 1, estado: "activo" });
    expect((await s.hk.findTask(s.ctx.propertyId, estancia))?.status).toBe("cancelada");

    expect((await s.app.request(`${s.base}/tareas`, authedJson(s.ctx.staff.frontdesk.token, { roomId: s.roomA, tipo: "estancia", fecha: FECHA }))).status).toBe(409);
    expect((await s.app.request(`${s.base}/tareas`, authedJson(s.ctx.staff.frontdesk.token, { roomId: s.roomA, tipo: "profunda", fecha: FECHA }))).status).toBe(201); // la profunda NO se omite
    const gen = await s.app.request(`${s.base}/tareas/generar`, authedJson(s.ctx.staff.frontdesk.token, { fecha: FECHA }));
    expect(((await gen.json()) as { creadas: number }).creadas).toBe(1); // solo la salida de la 102; la estancia de la 101 se omitio

    expect((await s.call("POST", "/opt-out", s.ctx.staff.frontdesk.token, { roomId: s.roomA, fecha: FECHA })).status).toBe(409); // duplicado activo
    expect((await s.call("POST", `/opt-out/${optOut.id}/revertir`, s.ctx.staff.frontdesk.token, {})).status).toBe(200);
    expect((await s.call("POST", `/opt-out/${optOut.id}/revertir`, s.ctx.staff.frontdesk.token, {})).status).toBe(404);
    expect((await s.app.request(`${s.base}/tareas`, authedJson(s.ctx.staff.frontdesk.token, { roomId: s.roomA, tipo: "repaso", fecha: FECHA }))).status).toBe(201);
  });
  it("valida origen (whatsapp reservado al canal), habitacion y roles", async () => {
    const s = await setup();
    expect((await s.call("POST", "/opt-out", s.ctx.staff.frontdesk.token, { roomId: s.roomA, origen: "whatsapp" })).status).toBe(400);
    expect((await s.call("POST", "/opt-out", s.ctx.staff.frontdesk.token, { roomId: "no-uuid" })).status).toBe(400);
    expect((await s.call("POST", "/opt-out", s.ctx.staff.frontdesk.token, { roomId: randomUUID(), fecha: FECHA })).status).toBe(404);
    expect((await s.call("POST", "/opt-out", s.ctx.staff.fnb.token, { roomId: s.roomA })).status).toBe(403);
  });
});

describe("asignacion automatica", () => {
  it("apagada: 409; encendida: reparte entre camaristas; la camarista no la dispara (403)", async () => {
    const s = await setup();
    await newTask(s, s.roomA, "estancia");
    await newTask(s, s.roomB, "salida");
    expect((await s.call("POST", "/asignacion-automatica", s.ctx.staff.frontdesk.token, { fecha: FECHA })).status).toBe(409);
    await s.call("PUT", "/configuracion", s.ctx.staff.owner.token, { asignacionAutomatica: true });
    expect((await s.call("POST", "/asignacion-automatica", s.ctx.staff.housekeeping.token, { fecha: FECHA })).status).toBe(403);
    const res = await s.call("POST", "/asignacion-automatica", s.ctx.staff.frontdesk.token, { fecha: FECHA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { asignadas: number; sinAsignar: number; sinCamaristas: boolean };
    expect(body).toMatchObject({ asignadas: 2, sinAsignar: 0, sinCamaristas: false });
    const tareas = ((await (await s.app.request(`${s.base}/tareas?fecha=${FECHA}`, authedJson(s.ctx.staff.frontdesk.token))).json()) as { tareas: { asignadoA: string | null }[] }).tareas;
    expect(tareas.every((t) => t.asignadoA === s.ctx.staff.housekeeping.id)).toBe(true);
    // idempotente: ya no quedan tareas sin responsable
    expect(await (await s.call("POST", "/asignacion-automatica", s.ctx.staff.frontdesk.token, { fecha: FECHA })).json()).toMatchObject({ asignadas: 0, sinAsignar: 0 });
  });
  it("tope de tareas por camarista: lo que no cabe se reporta como sinAsignar", async () => {
    const s = await setup();
    await newTask(s, s.roomA, "estancia");
    await newTask(s, s.roomB, "salida");
    await s.call("PUT", "/configuracion", s.ctx.staff.owner.token, { asignacionAutomatica: true, maxTareasPorCamarista: 1 });
    expect(await (await s.call("POST", "/asignacion-automatica", s.ctx.staff.frontdesk.token, { fecha: FECHA })).json()).toMatchObject({ asignadas: 1, sinAsignar: 1 });
  });
  it("base sin migrar: 503, no 500", async () => {
    const s = await setup({ migrated: false });
    expect((await s.call("POST", "/asignacion-automatica", s.ctx.staff.frontdesk.token, { fecha: FECHA })).status).toBe(503);
  });
});
