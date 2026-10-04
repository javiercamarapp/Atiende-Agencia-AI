// L-27 -- repositorio de la post-adjudicacion: en memoria (mismas reglas que la base: aislamiento por organizacion, maquina de
// estados, roles, bitacora) y Postgres contra la base SIN migrar con AbortAwareFakeSession (una sesion plana no reproduce 25P02).
import { describe, expect, it } from "vitest";
import { InMemoryPostAdjudicacionRepository, PostgresPostAdjudicacionRepository } from "../src/post-adjudicacion-repository.ts";
import type { GarantiaCreate } from "../src/post-adjudicacion-repository.ts";
import {
  PostAdjudicacionForbiddenError,
  PostAdjudicacionNotAvailableError,
  PostAdjudicacionNotFoundError,
  PostAdjudicacionStateError,
  PostAdjudicacionValidationError,
} from "../src/post-adjudicacion.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b1";
const CONTRATO_A = "00000000-0000-0000-0000-0000000000c1";
const CONTRATO_B = "00000000-0000-0000-0000-0000000000c2";
const USER_A = "00000000-0000-0000-0000-0000000000d1";
const USER_B = "00000000-0000-0000-0000-0000000000d2";
const DECIDE = { userId: USER_A, canDecide: true } as const;
const ESCRIBE = { userId: USER_A, canDecide: false } as const;

const garantia = (over: Partial<GarantiaCreate> = {}): GarantiaCreate => ({
  tipo: "cumplimiento",
  montoCents: 1_000_000n,
  porcentajeBp: 1000,
  afianzadora: "Afianzadora Demo",
  numeroPoliza: "POL-1",
  vigenciaDesde: "2026-10-01",
  vigenciaHasta: "2027-10-01",
  fechaLimiteEntrega: "2026-10-20",
  entregadaEn: null,
  notas: null,
  ...over,
});

function repo() {
  const r = new InMemoryPostAdjudicacionRepository({
    responsables: { [ORG_A]: [{ userId: USER_A, nombre: "Ana", rol: "owner" }], [ORG_B]: [{ userId: USER_B, nombre: "Beto", rol: "owner" }] },
    now: () => "2026-10-05T12:00:00.000Z",
  });
  return r;
}

describe("InMemoryPostAdjudicacionRepository -- garantias", () => {
  it("crear, listar y leer: el monto vuelve como cadena decimal y el porcentaje en puntos porcentuales", async () => {
    const r = repo();
    const g = await r.createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A);
    expect(g).toMatchObject({ tipo: "cumplimiento", monto: "10000.00", porcentaje: 10, estado: "pendiente_entrega", entregadaEn: null });
    expect(await r.listGarantias(ORG_A, CONTRATO_A)).toHaveLength(1);
    expect((await r.getGarantia(ORG_A, g.id))?.id).toBe(g.id);
  });

  it("CROSS-TENANT: otra organizacion no la ve, no la lista ni la edita (404, nunca 403)", async () => {
    const r = repo();
    const g = await r.createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A);
    expect(await r.getGarantia(ORG_B, g.id)).toBeNull();
    expect(await r.listGarantias(ORG_B, CONTRATO_A)).toEqual([]);
    await expect(r.updateGarantia(ORG_B, g.id, { notas: "x" }, DECIDE)).rejects.toBeInstanceOf(PostAdjudicacionNotFoundError);
    expect(await r.listBitacora(ORG_B, CONTRATO_A)).toEqual([]);
  });

  it("flujo completo: entregar -> liberar (solo con rol de decision) y una garantia final ya no se edita", async () => {
    const r = repo();
    const g = await r.createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A);
    await expect(r.updateGarantia(ORG_A, g.id, { estado: "liberada" }, DECIDE)).rejects.toBeInstanceOf(PostAdjudicacionStateError); // pendiente -> liberada invalida
    const entregada = await r.updateGarantia(ORG_A, g.id, { estado: "entregada", entregadaEn: "2026-10-06" }, ESCRIBE);
    expect(entregada).toMatchObject({ estado: "entregada", entregadaEn: "2026-10-06" });
    await expect(r.updateGarantia(ORG_A, g.id, { estado: "liberada" }, ESCRIBE)).rejects.toBeInstanceOf(PostAdjudicacionForbiddenError);
    const liberada = await r.updateGarantia(ORG_A, g.id, { estado: "liberada" }, DECIDE);
    expect(liberada.estado).toBe("liberada");
    await expect(r.updateGarantia(ORG_A, g.id, { notas: "tarde" }, DECIDE)).rejects.toThrow(/ya está liberada/);
  });

  it("una garantia entregada exige fecha de entrega y una pendiente no puede tenerla", async () => {
    const r = repo();
    const g = await r.createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A);
    await expect(r.updateGarantia(ORG_A, g.id, { estado: "entregada" }, ESCRIBE)).rejects.toBeInstanceOf(PostAdjudicacionValidationError);
    await expect(r.updateGarantia(ORG_A, g.id, { entregadaEn: "2026-10-06" }, ESCRIBE)).rejects.toBeInstanceOf(PostAdjudicacionValidationError);
    await expect(r.updateGarantia(ORG_A, g.id, { vigenciaHasta: "2026-09-01" }, ESCRIBE)).rejects.toThrow(/anterior/);
  });

  it("la bitacora registra crear y cambio de estado con el actor, sin montos ni nombres", async () => {
    const r = repo();
    const g = await r.createGarantia(ORG_A, CONTRATO_A, garantia({ afianzadora: "Afianzadora Secreta SA" }), USER_A);
    await r.updateGarantia(ORG_A, g.id, { estado: "entregada", entregadaEn: "2026-10-06" }, { userId: USER_B, canDecide: false });
    const b = await r.listBitacora(ORG_A, CONTRATO_A);
    expect(b.map((e) => [e.accion, e.actorId])).toEqual([
      ["cambio_estado", USER_B],
      ["crear", USER_A],
    ]);
    expect(JSON.stringify(b)).not.toMatch(/Secreta|10000/);
  });

  it("setLimiteEntregaPendientes solo mueve las de cumplimiento aun pendientes del contrato indicado", async () => {
    const r = repo();
    const a = await r.createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A);
    const anticipo = await r.createGarantia(ORG_A, CONTRATO_A, garantia({ tipo: "anticipo" }), USER_A);
    const entregada = await r.createGarantia(ORG_A, CONTRATO_A, garantia({ entregadaEn: "2026-10-02", fechaLimiteEntrega: "2026-10-03" }), USER_A);
    const otraOrg = await r.createGarantia(ORG_B, CONTRATO_B, garantia(), USER_B);
    expect(await r.setLimiteEntregaPendientes(ORG_A, CONTRATO_A, "2026-11-11")).toBe(1);
    expect((await r.getGarantia(ORG_A, a.id))?.fechaLimiteEntrega).toBe("2026-11-11");
    expect((await r.getGarantia(ORG_A, anticipo.id))?.fechaLimiteEntrega).toBe("2026-10-20");
    expect((await r.getGarantia(ORG_A, entregada.id))?.fechaLimiteEntrega).toBe("2026-10-03");
    expect((await r.getGarantia(ORG_B, otraOrg.id))?.fechaLimiteEntrega).toBe("2026-10-20");
  });
});

describe("InMemoryPostAdjudicacionRepository -- hitos, convenios y plazos", () => {
  it("hito: el responsable debe ser staff de la MISMA organizacion; cumplir lo sella y lo congela", async () => {
    const r = repo();
    const input = { titulo: "Entrega de la etapa 1", descripcion: null, responsableId: USER_A, fechaCompromiso: "2026-10-01" };
    await expect(r.createHito(ORG_A, CONTRATO_A, { ...input, responsableId: USER_B }, USER_A)).rejects.toBeInstanceOf(PostAdjudicacionForbiddenError);
    const h = await r.createHito(ORG_A, CONTRATO_A, input, USER_A);
    expect(await r.getHito(ORG_B, h.id)).toBeNull();
    await expect(r.updateHito(ORG_B, h.id, { titulo: "Ajeno" }, ESCRIBE)).rejects.toBeInstanceOf(PostAdjudicacionNotFoundError);
    await expect(r.updateHito(ORG_A, h.id, { responsableId: USER_B }, ESCRIBE)).rejects.toBeInstanceOf(PostAdjudicacionForbiddenError);
    const cumplido = await r.updateHito(ORG_A, h.id, { estado: "cumplido", cumplidoEn: "2026-10-04" }, ESCRIBE);
    expect(cumplido).toMatchObject({ estado: "cumplido", cumplidoEn: "2026-10-04" });
    await expect(r.updateHito(ORG_A, h.id, { titulo: "Tarde" }, ESCRIBE)).rejects.toBeInstanceOf(PostAdjudicacionStateError);
  });

  it("convenios: consecutivo por contrato, historial conservado y fecha de fin anterior", async () => {
    const r = repo();
    const c1 = await r.createConvenio(ORG_A, CONTRATO_A, { tipo: "plazo", montoDeltaCents: null, nuevaFechaFin: "2027-03-31", fechaFirma: "2026-10-01", motivo: "Ampliacion" }, USER_A, "2026-12-31");
    const c2 = await r.createConvenio(ORG_A, CONTRATO_A, { tipo: "monto_plazo", montoDeltaCents: -250_000n, nuevaFechaFin: "2027-06-30", fechaFirma: "2026-11-01", motivo: "Reduccion" }, USER_A, "2027-03-31");
    const otro = await r.createConvenio(ORG_B, CONTRATO_B, { tipo: "monto", montoDeltaCents: 100n, nuevaFechaFin: null, fechaFirma: "2026-11-01", motivo: "Otra org" }, USER_B, null);
    expect([c1.numero, c2.numero, otro.numero]).toEqual([1, 2, 1]);
    expect(c2).toMatchObject({ montoDelta: "-2500.00", fechaFinAnterior: "2027-03-31" });
    expect((await r.listConvenios(ORG_A, CONTRATO_A)).map((c) => c.numero)).toEqual([1, 2]);
    expect(await r.listConvenios(ORG_B, CONTRATO_A)).toEqual([]);
  });

  it("plazos: upsert parcial conserva lo no enviado y registra la bitacora", async () => {
    const r = repo();
    await r.upsertPlazos(ORG_A, CONTRATO_A, { falloNotificadoEn: "2026-10-01", plazoFirmaDias: 15 }, USER_A);
    const p = await r.upsertPlazos(ORG_A, CONTRATO_A, { firmadoEn: "2026-10-20", plazoGarantiaDias: 10 }, USER_A);
    expect(p).toMatchObject({ falloNotificadoEn: "2026-10-01", plazoFirmaDias: 15, firmadoEn: "2026-10-20", plazoGarantiaDias: 10 });
    expect(await r.getPlazos(ORG_B, CONTRATO_A)).toBeNull();
    expect((await r.listBitacora(ORG_A, CONTRATO_A)).map((e) => e.accion)).toEqual(["editar", "crear"]);
  });

  it("candidatos de alerta: por vencer, no entregada e hito vencido, solo de la organizacion pedida", async () => {
    const r = repo();
    r.linkContract(CONTRATO_A, "tender-a");
    r.linkContract(CONTRATO_B, "tender-b");
    const hoy = "2026-10-05";
    const porVencer = await r.createGarantia(ORG_A, CONTRATO_A, garantia({ entregadaEn: "2026-09-01", vigenciaHasta: "2026-10-15" }), USER_A);
    await r.createGarantia(ORG_A, CONTRATO_A, garantia({ entregadaEn: "2026-09-01", vigenciaHasta: "2027-06-15" }), USER_A); // sana
    const noEntregada = await r.createGarantia(ORG_A, CONTRATO_A, garantia({ fechaLimiteEntrega: "2026-10-01" }), USER_A);
    const hito = await r.createHito(ORG_A, CONTRATO_A, { titulo: "Etapa uno", descripcion: null, responsableId: USER_A, fechaCompromiso: "2026-10-03" }, USER_A);
    await r.createGarantia(ORG_B, CONTRATO_B, garantia({ entregadaEn: "2026-09-01", vigenciaHasta: "2026-10-10" }), USER_B);
    const c = await r.listAlertCandidates(ORG_A, hoy, 30);
    expect(c!.map((x) => [x.tipo, x.entidadId, x.tenderId, x.fecha])).toEqual([
      ["garantia_no_entregada", noEntregada.id, "tender-a", "2026-10-01"],
      ["hito_vencido", hito.id, "tender-a", "2026-10-03"],
      ["garantia_por_vencer", porVencer.id, "tender-a", "2026-10-15"],
    ]);
    expect((await r.listAlertCandidates(ORG_B, hoy, 30))!.map((x) => x.tipo)).toEqual(["garantia_por_vencer"]);
  });

  it("sin la migracion: todo lanza PostAdjudicacionNotAvailableError y los candidatos son null", async () => {
    const r = repo();
    r.unavailable = true;
    await expect(r.listGarantias(ORG_A, CONTRATO_A)).rejects.toBeInstanceOf(PostAdjudicacionNotAvailableError);
    await expect(r.createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A)).rejects.toBeInstanceOf(PostAdjudicacionNotAvailableError);
    expect(await r.listAlertCandidates(ORG_A, "2026-10-05", 30)).toBeNull();
  });
});

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("PostgresPostAdjudicacionRepository -- base SIN migrar (SAVEPOINT)", () => {
  it("lecturas: 42P01 (tabla inexistente) -> NotAvailable con la sesion RECUPERADA, no 25P02", async () => {
    const session = new AbortAwareFakeSession([
      { match: /contract_guarantee/, respond: () => pgError("42P01", 'relation "licitaciones.contract_guarantee" does not exist') },
      { match: /contract_milestone/, respond: () => pgError("42P01", 'relation "licitaciones.contract_milestone" does not exist') },
      { match: /contract_amendment/, respond: () => pgError("42P01", 'relation "licitaciones.contract_amendment" does not exist') },
      { match: /contract_plazos/, respond: () => pgError("42P01", 'relation "licitaciones.contract_plazos" does not exist') },
      { match: /contract_post_award_log/, respond: () => pgError("42P01", 'relation "licitaciones.contract_post_award_log" does not exist') },
      { match: /post_award_list_responsables/, respond: () => pgError("42883", "function licitaciones.post_award_list_responsables(uuid) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const r = new PostgresPostAdjudicacionRepository(session);
    await expect(r.listGarantias(ORG_A, CONTRATO_A)).rejects.toBeInstanceOf(PostAdjudicacionNotAvailableError);
    await expect(r.listHitos(ORG_A, CONTRATO_A)).rejects.toBeInstanceOf(PostAdjudicacionNotAvailableError);
    await expect(r.listConvenios(ORG_A, CONTRATO_A)).rejects.toBeInstanceOf(PostAdjudicacionNotAvailableError);
    await expect(r.getPlazos(ORG_A, CONTRATO_A)).rejects.toBeInstanceOf(PostAdjudicacionNotAvailableError);
    await expect(r.listBitacora(ORG_A, CONTRATO_A)).rejects.toBeInstanceOf(PostAdjudicacionNotAvailableError);
    await expect(r.listResponsables(ORG_A)).rejects.toBeInstanceOf(PostAdjudicacionNotAvailableError);
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBeGreaterThanOrEqual(6);
    // la transaccion compartida NO quedo abortada: la siguiente consulta del request funciona
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("escrituras: 42P01 -> NotAvailable (no 25P02) y la sesion sigue usable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into licitaciones\.contract_guarantee/, respond: () => pgError("42P01", 'relation "licitaciones.contract_guarantee" does not exist') },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresPostAdjudicacionRepository(session).createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A)).rejects.toBeInstanceOf(PostAdjudicacionNotAvailableError);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("alertas de sistema: 42883 de la funcion -> null (no hay candidatos) con la sesion recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_post_award_alert_candidates/, respond: () => pgError("42883", "function licitaciones.system_post_award_alert_candidates(uuid, date, integer) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await new PostgresPostAdjudicacionRepository(session).listAlertCandidates(ORG_A, "2026-10-05", 30)).toBeNull();
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("un error que NO es de migracion pendiente (operador inexistente) no se disfraza", async () => {
    const session = new AbortAwareFakeSession([{ match: /contract_guarantee/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresPostAdjudicacionRepository(session).listGarantias(ORG_A, CONTRATO_A)).rejects.toThrow(/operator does not exist/);
  });

  it("errores de negocio de la base se traducen: 22023 estado, 22023 validacion, 42501 decision, 54000 tope", async () => {
    const mk = (code: string, msg: string) => new PostgresPostAdjudicacionRepository(new AbortAwareFakeSession([{ match: /insert into licitaciones\.contract_guarantee/, respond: () => pgError(code, msg) }]));
    await expect(mk("22023", "una garantia nueva solo nace pendiente de entrega o entregada").createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A)).rejects.toBeInstanceOf(PostAdjudicacionValidationError);
    await expect(mk("22023", "transicion de garantia invalida: pendiente_entrega -> liberada").createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A)).rejects.toBeInstanceOf(PostAdjudicacionStateError);
    await expect(mk("42501", "liberar o ejecutar una garantia exige un rol de decision").createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A)).rejects.toThrow(/rol de decisión/);
    await expect(mk("54000", "maximo 30 garantias por contrato").createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A)).rejects.toBeInstanceOf(PostAdjudicacionValidationError);
    await expect(mk("23503", "violates foreign key").createGarantia(ORG_A, CONTRATO_A, garantia(), USER_A)).rejects.toBeInstanceOf(PostAdjudicacionNotFoundError);
  });
});
