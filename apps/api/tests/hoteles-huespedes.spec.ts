// H-27 -- ficha de huesped (CRM): integracion HTTP real (app.request) sobre los repositorios en memoria. RLS/GRANT/triggers
// de las notas y la bandera ARCO los cubre scripts/verify-hoteles-recepcion-ficha contra Postgres real; el SAVEPOINT contra
// base sin migrar lo cubre packages/domain-hoteles/tests/huespedes-savepoint.spec.ts.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryHuespedesRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

const NOW = new Date("2026-12-02T18:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

async function setup(opts: { migrated?: boolean; privacidadDisponible?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const ctx = await buildHotelesTestContext(buildApp);
  const crm = new InMemoryHuespedesRepository(ctx.hotelesRepo, opts);
  const app = buildApp({ ...ctx.deps, hotelesHuespedesRepo: (_db) => crm });
  const base = `/hoteles/${ctx.propertyId}/huespedes/${ctx.guestId}`;
  const reserva = (over: { status: "confirmada" | "en_estancia" | "check_out" | "cancelada"; in: string; out: string; total?: number }) => {
    const id = randomUUID();
    ctx.hotelesRepo.seedReservation({
      id,
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      roomTypeId: ctx.roomTypeId,
      guestId: ctx.guestId,
      checkInDate: over.in,
      checkOutDate: over.out,
      status: over.status,
      totalAmount: over.total ?? 3000,
      cancellationPenaltyAmount: null,
      canceledAt: null,
      createdAt: NOW.toISOString(),
    });
    return id;
  };
  return { ctx, crm, app, base, reserva };
}
type S = Awaited<ReturnType<typeof setup>>;

const post = (s: S, path: string, token: string, body: unknown) => s.app.request(`${s.base}${path}`, authedJson(token, body));
const get = (s: S, path: string, token: string) => s.app.request(`${s.base}${path}`, authedJson(token));
const json = async <T>(res: Response) => (await res.json()) as T;

interface Ficha {
  huesped: { id: string; nombreCompleto: string; email: string | null; telefono: string | null };
  resumen: { estancias: number; noches: number; ultimaEstancia: string | null; proximaLlegada: string | null };
  estancias: { reservaId: string; estado: string; montoNetoCentavos: number }[];
  notas: { disponible: boolean; items: { id: string; tipo: string; texto: string }[] };
  contactos: { motivo: string; canal: string; mensaje: string | null }[];
  consentimientos: { aviso: string; finalidadesOpcionales: string[]; revocado: boolean }[] | null;
  identidad: { registrada: boolean } | null;
  arco: { restriccion: boolean } | null;
}

describe("GET /huespedes/:guestId/ficha", () => {
  it("arma perfil, resumen, historial (montos en centavos), contactos enlazados por telefono, consentimiento e identidad", async () => {
    const s = await setup();
    s.reserva({ status: "check_out", in: "2026-10-01", out: "2026-10-04", total: 4500.5 });
    s.reserva({ status: "en_estancia", in: "2026-12-01", out: "2026-12-04" });
    s.reserva({ status: "confirmada", in: "2027-01-10", out: "2027-01-12" });
    s.reserva({ status: "cancelada", in: "2026-11-01", out: "2026-11-03" });
    s.crm.seedContacto(s.ctx.propertyId, "+52 1 55 1111 2222", { id: "c1", reason: "Pregunta por late check-out", source: "whatsapp", message: "x".repeat(300), createdAt: "2026-11-30T10:00:00Z" });
    s.crm.seedContacto(s.ctx.propertyId, "5599990000", { id: "c2", reason: "Otro huesped", source: "voice", message: null, createdAt: "2026-11-30T11:00:00Z" });
    s.crm.seedConsentimiento(s.ctx.guestId, { id: "k1", noticeVersion: "v2", optionalPurposes: ["marketing"], channel: "mostrador", consentedAt: "2026-10-01T10:00:00Z", revoked: false });
    s.crm.seedIdentidad(s.ctx.guestId);

    const res = await get(s, "/ficha", s.ctx.staff.frontdesk.token);
    expect(res.status).toBe(200);
    const f = await json<Ficha>(res);
    expect(f.huesped).toMatchObject({ id: s.ctx.guestId, nombreCompleto: "Ana Torres", telefono: "5511112222" });
    expect(f.resumen).toEqual({ estancias: 2, noches: 6, ultimaEstancia: "2026-12-01", proximaLlegada: "2027-01-10" });
    expect(f.estancias).toHaveLength(4);
    expect(f.estancias.find((e) => e.estado === "check_out")!.montoNetoCentavos).toBe(450050);
    expect(f.contactos).toHaveLength(1);
    expect(f.contactos[0]).toMatchObject({ motivo: "Pregunta por late check-out", canal: "whatsapp" });
    expect(f.contactos[0]!.mensaje).toHaveLength(200);
    expect(f.consentimientos).toEqual([{ id: "k1", aviso: "v2", finalidadesOpcionales: ["marketing"], canal: "mostrador", fecha: "2026-10-01T10:00:00Z", revocado: false }]);
    expect(f.identidad).toEqual({ registrada: true });
    expect(f.arco).toEqual({ restriccion: false });
    expect(f.notas).toEqual({ disponible: true, items: [] });
  });

  it("minimizacion: no filtra documento ni datos de otro huesped, solo la bandera de identidad", async () => {
    const s = await setup();
    s.crm.seedIdentidad(s.ctx.guestId);
    const texto = JSON.stringify(await json<Ficha>(await get(s, "/ficha", s.ctx.staff.owner.token)));
    expect(texto).not.toMatch(/payload|documento|passport|pasaporte|curp/i);
  });

  it("solo owner/gm/frontdesk/reservations; housekeeping, fnb y contabilidad reciben 403; sin token 401", async () => {
    const s = await setup();
    for (const rol of ["owner", "gm", "frontdesk", "reservations"] as const) expect((await get(s, "/ficha", s.ctx.staff[rol].token)).status).toBe(200);
    for (const rol of ["housekeeping", "fnb", "accountant"] as const) expect((await get(s, "/ficha", s.ctx.staff[rol].token)).status).toBe(403);
    expect((await s.app.request(`${s.base}/ficha`)).status).toBe(401);
  });

  it("huesped inexistente o con id mal formado", async () => {
    const s = await setup();
    const otro = await s.app.request(`/hoteles/${s.ctx.propertyId}/huespedes/${randomUUID()}/ficha`, authedJson(s.ctx.staff.owner.token));
    expect(otro.status).toBe(404);
    const malo = await s.app.request(`/hoteles/${s.ctx.propertyId}/huespedes/no-uuid/ficha`, authedJson(s.ctx.staff.owner.token));
    expect(malo.status).toBe(400);
  });

  it("base sin migraciones 031/032/038: perfil e historial siguen, y lo no disponible va como null o disponible:false (nunca 'sin datos')", async () => {
    const s = await setup({ migrated: false, privacidadDisponible: false });
    s.reserva({ status: "check_out", in: "2026-10-01", out: "2026-10-04" });
    const res = await get(s, "/ficha", s.ctx.staff.frontdesk.token);
    expect(res.status).toBe(200);
    const f = await json<Ficha>(res);
    expect(f.estancias).toHaveLength(1);
    expect(f.notas).toEqual({ disponible: false, items: [] });
    expect(f.consentimientos).toBeNull();
    expect(f.identidad).toBeNull();
    expect(f.arco).toBeNull();
  });
});

describe("notas y preferencias", () => {
  it("agrega una nota y una preferencia, aparecen en la ficha, y se archivan una sola vez", async () => {
    const s = await setup();
    const nota = await post(s, "/notas", s.ctx.staff.frontdesk.token, { tipo: "nota", texto: "  Llega tarde por vuelo  " });
    expect(nota.status).toBe(201);
    const creada = await json<{ id: string; tipo: string; texto: string }>(nota);
    expect(creada).toMatchObject({ tipo: "nota", texto: "Llega tarde por vuelo" });
    expect((await post(s, "/notas", s.ctx.staff.reservations.token, { tipo: "preferencia", texto: "Piso alto" })).status).toBe(201);
    const f = await json<Ficha>(await get(s, "/ficha", s.ctx.staff.owner.token));
    expect(f.notas.items.map((n) => n.tipo).sort()).toEqual(["nota", "preferencia"]);

    // la nota pertenece a OTRO huesped que el de la URL -> 404 y no se archiva
    const otroHuesped = await s.app.request(`/hoteles/${s.ctx.propertyId}/huespedes/${randomUUID()}/notas/${creada.id}/archivar`, authedJson(s.ctx.staff.frontdesk.token, {}));
    expect(otroHuesped.status).toBe(404);
    expect((await json<Ficha>(await get(s, "/ficha", s.ctx.staff.owner.token))).notas.items).toHaveLength(2);
    expect((await post(s, `/notas/${creada.id}/archivar`, s.ctx.staff.frontdesk.token, {})).status).toBe(200);
    expect((await post(s, `/notas/${creada.id}/archivar`, s.ctx.staff.frontdesk.token, {})).status).toBe(404);
    const despues = await json<Ficha>(await get(s, "/ficha", s.ctx.staff.owner.token));
    expect(despues.notas.items).toHaveLength(1);
  });

  it("valida el tipo, el texto (vacio, mas de 500) y rechaza numeros de tarjeta o documento (minimizacion)", async () => {
    const s = await setup();
    const t = s.ctx.staff.frontdesk.token;
    expect((await post(s, "/notas", t, { tipo: "secreto", texto: "x" })).status).toBe(400);
    expect((await post(s, "/notas", t, { tipo: "nota", texto: "   " })).status).toBe(400);
    expect((await post(s, "/notas", t, { tipo: "nota", texto: "a".repeat(501) })).status).toBe(400);
    const tarjeta = await post(s, "/notas", t, { tipo: "nota", texto: "Tarjeta 4111 1111 1111 1111" });
    expect(tarjeta.status).toBe(400);
    expect((await json<{ message: string }>(tarjeta)).message).toMatch(/tarjeta/);
    expect((await post(s, "/notas", t, { tipo: "nota", texto: "Habitacion 1203, ext 2200" })).status).toBe(201);
  });

  it("con ARCO de cancelacion/oposicion en curso responde 409 arco_en_curso y la ficha avisa la restriccion", async () => {
    const s = await setup();
    s.crm.seedRestriccionArco(s.ctx.guestId);
    const res = await post(s, "/notas", s.ctx.staff.frontdesk.token, { tipo: "nota", texto: "no deberia entrar" });
    expect(res.status).toBe(409);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: "arco_en_curso" });
    expect((await json<Ficha>(await get(s, "/ficha", s.ctx.staff.owner.token))).arco).toEqual({ restriccion: true });
  });

  it("solo roles de reservas escriben; housekeeping y contabilidad 403; huesped ajeno 404; base sin 038 -> 503 honesto", async () => {
    const s = await setup();
    for (const rol of ["housekeeping", "fnb", "accountant"] as const) expect((await post(s, "/notas", s.ctx.staff[rol].token, { tipo: "nota", texto: "x" })).status).toBe(403);
    const ajeno = await s.app.request(`/hoteles/${s.ctx.propertyId}/huespedes/${randomUUID()}/notas`, authedJson(s.ctx.staff.frontdesk.token, { tipo: "nota", texto: "x" }));
    expect(ajeno.status).toBe(404);

    const sinMigrar = await setup({ migrated: false });
    const res = await post(sinMigrar, "/notas", sinMigrar.ctx.staff.frontdesk.token, { tipo: "nota", texto: "x" });
    expect(res.status).toBe(503);
    expect((await json<{ message: string }>(res)).message).toMatch(/migracion 038/);
    expect((await post(sinMigrar, `/notas/${randomUUID()}/archivar`, sinMigrar.ctx.staff.frontdesk.token, {})).status).toBe(503);
  });
});
