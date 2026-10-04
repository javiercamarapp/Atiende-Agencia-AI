// L-27 -- post-adjudicacion estructurada, HTTP real (Hono + auth + roles) sobre el repositorio en memoria (mismas reglas
// que la base: aislamiento por organizacion, maquina de estados, bitacora). El aislamiento real por RLS/triggers se prueba
// contra Postgres real en scripts/verify-licitaciones-post-adjudicacion/. Cubre: plazos que saltan dias inhabiles,
// garantias (crear/editar/entregar/liberar con rol de decision), hitos con responsable, convenios con historial y step-up,
// idempotencia, cross-tenant, la degradacion a "no disponible aun" y las alertas del barrido (una sola vez por evento).
import { InMemoryPostAdjudicacionRepository, mexicoCityDateKey } from "@atiende/domain-licitaciones";
import { InMemoryStaffSecurityRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { computeTotp } from "@atiende/core-auth";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const OTRA_ORG = "00000000-0000-4000-8000-0000000000b1";
const OTRO_CONTRATO = "00000000-0000-4000-8000-0000000000b2";
const OTRA_PERSONA = "00000000-0000-4000-8000-0000000000b3";

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function setup(opts: { sinRepo?: boolean; noDisponible?: boolean; deps?: (d: AppDeps) => AppDeps } = {}) {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const repo = new InMemoryPostAdjudicacionRepository({
    responsables: {
      [ctx.organizationId]: [
        { userId: ctx.staff.analyst.id, nombre: "Ana Analista", rol: "analyst" },
        { userId: ctx.staff.writer.id, nombre: "Walter Writer", rol: "writer" },
      ],
    },
  });
  if (opts.noDisponible) repo.unavailable = true;
  let deps: AppDeps = { ...ctx.deps, ...(opts.sinRepo ? {} : { licitacionesPostAdjudicacionRepo: () => repo }) };
  if (opts.deps) deps = opts.deps(deps);
  const app = buildApp(deps);
  const tenderBase = `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`;
  const base = `${tenderBase}/post-award`;
  const created = await app.request(tenderBase, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
  expect(created.status).toBe(201);
  const contract = (await created.json()) as Json;
  repo.linkContract(contract.id, ctx.tenderId);

  let n = 0;
  async function call(method: string, path: string, who: keyof typeof ctx.staff, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
    const h = { ...headers };
    if (method === "POST" && !("idempotency-key" in h)) h["idempotency-key"] = `k-${(n += 1)}`;
    const init: RequestInit = body === undefined ? { method, headers: { authorization: `Bearer ${ctx.staff[who].token}`, ...h } } : { ...authedJson(ctx.staff[who].token, body, h), method };
    const res = await app.request(`${base}${path}`, init);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  return { ctx, repo, app, call, contract, tenderBase, base, deps };
}

const garantiaBody = { tipo: "cumplimiento", monto: "125000.50", porcentaje: 10, afianzadora: "Afianzadora Demo", numeroPoliza: "POL-1", vigenciaDesde: "2026-10-01", vigenciaHasta: "2027-10-01" };

describe("post-adjudicacion: acceso y vacio honesto", () => {
  it("GET sin contrato registrado -> 404; con contrato, cualquier miembro (viewer) lo lee vacio con sus permisos", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp({ ...ctx.deps, licitacionesPostAdjudicacionRepo: () => new InMemoryPostAdjudicacionRepository() });
    const sin = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/post-award`, authedJson(ctx.staff.viewer.token));
    expect(sin.status).toBe(404);

    const s = await setup();
    const r = await s.call("GET", "", "viewer");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ available: true, garantias: [], hitos: [], convenios: [], puedeEscribir: false, puedeDecidir: false });
    expect(r.json.plazosCalculados).toMatchObject({ fechaLimiteFirma: null, fechaLimiteEntregaGarantia: null });
    expect(r.json.plazosCalculados.nota).toMatch(/no verificado/i);
    expect((await s.call("GET", "", "analyst")).json).toMatchObject({ puedeEscribir: true, puedeDecidir: true });
    expect((await s.call("GET", "", "writer")).json).toMatchObject({ puedeEscribir: true, puedeDecidir: false });
  });

  it("sin autenticacion -> 401", async () => {
    const s = await setup();
    expect((await s.app.request(s.base)).status).toBe(401);
  });

  it("base SIN la migracion 035: lecturas -> available:false (200) y escrituras -> 503; nunca 500", async () => {
    const s = await setup({ noDisponible: true });
    expect((await s.call("GET", "", "viewer")).json).toMatchObject({ available: false });
    expect((await s.call("GET", "/bitacora", "viewer")).json).toEqual({ available: false, bitacora: [] });
    expect((await s.call("GET", "/responsables", "viewer")).json).toEqual({ available: false, responsables: [] });
    expect((await s.call("POST", "/garantias", "writer", garantiaBody)).status).toBe(503);
    expect((await s.call("PUT", "/plazos", "writer", { plazoFirmaDias: 10 })).status).toBe(503);
    expect((await s.call("POST", "/hitos", "writer", { titulo: "Etapa 1", responsableId: s.ctx.staff.writer.id, fechaCompromiso: "2026-12-01" })).status).toBe(503);
  });

  it("sin repositorio cableado (ambiente sin la pieza): lectura available:false y escritura 503", async () => {
    const s = await setup({ sinRepo: true });
    expect((await s.call("GET", "", "viewer")).json).toMatchObject({ available: false });
    expect((await s.call("POST", "/garantias", "writer", garantiaBody)).status).toBe(503);
  });
});

describe("post-adjudicacion: el GET base no concurre sobre la sesion transaccional", () => {
  it("las lecturas del resumen corren en SECUENCIA (SAVEPOINT concurrentes sobre una sesion destruyen la pila: 3B001/25P02)", async () => {
    const inner = new InMemoryPostAdjudicacionRepository();
    let enVuelo = 0;
    let maxEnVuelo = 0;
    const llamadas: string[] = [];
    // Proxy: cada metodo de lectura cede el turno (macrotarea) para que Promise.all, si volviera, se solape.
    const repo = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function" || !/^(get|list)/.test(String(prop))) return typeof v === "function" ? v.bind(target) : v;
        return async (...args: unknown[]) => {
          enVuelo += 1;
          maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
          llamadas.push(String(prop));
          try {
            await new Promise((r) => setTimeout(r, 5));
            return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          } finally {
            enVuelo -= 1;
          }
        };
      },
    });
    const s = await setup({ deps: (d) => ({ ...d, licitacionesPostAdjudicacionRepo: () => repo }) });
    inner.linkContract(s.contract.id, s.ctx.tenderId);
    llamadas.length = 0;
    const r = await s.call("GET", "", "viewer");
    expect(r.status).toBe(200);
    expect(llamadas).toEqual(expect.arrayContaining(["getPlazos", "listGarantias", "listHitos", "listConvenios"]));
    expect(maxEnVuelo).toBe(1);
  });
});

describe("post-adjudicacion: plazos en dias habiles", () => {
  it("el plazo de firma SALTA los dias inhabiles del calendario efectivo y la entrega de garantia cuenta desde la firma", async () => {
    const s = await setup();
    // Jueves 12-nov-2026 + 3 dias habiles: vie 13, (lun 16-nov inhabil oficial), mar 17, mie 18.
    const put = await s.call("PUT", "/plazos", "writer", { falloNotificadoEn: "2026-11-12", plazoFirmaDias: 3, firmadoEn: "2026-11-18", plazoGarantiaDias: 2 });
    expect(put.status).toBe(200);
    expect(put.json.plazosCalculados.fechaLimiteFirma).toBe("2026-11-18");
    expect(put.json.plazosCalculados.fechaLimiteEntregaGarantia).toBe("2026-11-20");
    expect(put.json.plazosCalculados.calendarioNota).toMatch(/inhábiles oficiales/);
    const overview = await s.call("GET", "", "viewer");
    expect(overview.json.plazos).toMatchObject({ falloNotificadoEn: "2026-11-12", plazoFirmaDias: 3 });
    expect(overview.json.plazosCalculados.fechaLimiteFirma).toBe("2026-11-18");
  });

  it("la garantia de cumplimiento nueva toma su fecha limite de entrega de los plazos; cambiar los plazos mueve las pendientes", async () => {
    const s = await setup();
    await s.call("PUT", "/plazos", "writer", { falloNotificadoEn: "2026-11-12", plazoFirmaDias: 3, firmadoEn: "2026-11-18", plazoGarantiaDias: 2 });
    const g = await s.call("POST", "/garantias", "writer", garantiaBody);
    expect(g.status).toBe(201);
    expect(g.json.fechaLimiteEntrega).toBe("2026-11-20");
    const otra = await s.call("PUT", "/plazos", "writer", { plazoGarantiaDias: 5 });
    expect(otra.json.garantiasActualizadas).toBe(1);
    expect((await s.call("GET", "", "viewer")).json.garantias[0].fechaLimiteEntrega).toBe("2026-11-25");
  });

  it("validacion: dias fuera de 1..90, fechas imposibles; viewer 403; cuerpo vacio 400", async () => {
    const s = await setup();
    expect((await s.call("PUT", "/plazos", "writer", { plazoFirmaDias: 0 })).status).toBe(400);
    expect((await s.call("PUT", "/plazos", "writer", { plazoFirmaDias: 91 })).status).toBe(400);
    expect((await s.call("PUT", "/plazos", "writer", { firmadoEn: "2026-02-30" })).status).toBe(400);
    expect((await s.call("PUT", "/plazos", "writer", {})).status).toBe(400);
    expect((await s.call("PUT", "/plazos", "viewer", { plazoFirmaDias: 10 })).status).toBe(403);
  });
});

describe("post-adjudicacion: garantias", () => {
  it("crear una garantia: monto exacto, vigencia visible, idempotente con Idempotency-Key", async () => {
    const s = await setup();
    const r = await s.call("POST", "/garantias", "writer", garantiaBody, { "idempotency-key": "clave-1" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ tipo: "cumplimiento", monto: "125000.50", porcentaje: 10, estado: "pendiente_entrega", vigencia: { estadoEfectivo: "pendiente_entrega" } });
    const repetida = await s.call("POST", "/garantias", "writer", garantiaBody, { "idempotency-key": "clave-1" });
    expect(repetida.status).toBe(201);
    expect(repetida.json.id).toBe(r.json.id);
    expect((await s.call("GET", "", "viewer")).json.garantias).toHaveLength(1);
    // misma clave con OTRO cuerpo -> 422; sin clave -> 400
    expect((await s.call("POST", "/garantias", "writer", { ...garantiaBody, monto: "1.00" }, { "idempotency-key": "clave-1" })).status).toBe(422);
    const sinClave = await s.app.request(`${s.base}/garantias`, authedJson(s.ctx.staff.writer.token, garantiaBody));
    expect(sinClave.status).toBe(400);
  });

  it("validacion: monto como numero, decimales de mas, cero, tipo desconocido, vigencia invertida -> 400; viewer -> 403", async () => {
    const s = await setup();
    for (const patch of [{ monto: 125000.5 }, { monto: "10.999" }, { monto: "0" }, { tipo: "otra" }, { vigenciaHasta: "2026-01-01" }, { porcentaje: 150 }]) {
      const r = await s.call("POST", "/garantias", "writer", { ...garantiaBody, ...patch });
      expect(r.status, JSON.stringify(patch)).toBe(400);
    }
    expect((await s.call("POST", "/garantias", "viewer", garantiaBody)).status).toBe(403);
  });

  it("entregar (writer) y liberar: solo un rol de decision; una garantia liberada ya no se edita (409)", async () => {
    const s = await setup();
    const g = (await s.call("POST", "/garantias", "writer", garantiaBody)).json;
    // liberar una garantia aun pendiente es una transicion invalida
    expect((await s.call("PATCH", `/garantias/${g.id}`, "analyst", { estado: "liberada" })).status).toBe(409);
    const entregada = await s.call("PATCH", `/garantias/${g.id}`, "writer", { estado: "entregada" });
    expect(entregada.status).toBe(200);
    expect(entregada.json.estado).toBe("entregada");
    expect(entregada.json.entregadaEn).toBe(mexicoCityDateKey(new Date())); // sin fecha explicita: hoy
    // el writer NO libera; el analista si
    expect((await s.call("PATCH", `/garantias/${g.id}`, "writer", { estado: "liberada" })).status).toBe(403);
    expect((await s.call("PATCH", `/garantias/${g.id}`, "viewer", { notas: "x" })).status).toBe(403);
    const liberada = await s.call("PATCH", `/garantias/${g.id}`, "analyst", { estado: "liberada" });
    expect(liberada.status).toBe(200);
    expect(liberada.json.estado).toBe("liberada");
    expect((await s.call("PATCH", `/garantias/${g.id}`, "analyst", { notas: "tarde" })).status).toBe(409);
  });

  it("editar poliza, monto y vigencia; una entregada con vigencia terminada se muestra vencida", async () => {
    const s = await setup();
    const hoy = mexicoCityDateKey(new Date());
    const g = (await s.call("POST", "/garantias", "writer", { ...garantiaBody, vigenciaDesde: addDays(hoy, -200), vigenciaHasta: addDays(hoy, 15), entregadaEn: addDays(hoy, -100) })).json;
    expect(g.estado).toBe("entregada");
    expect(g.vigencia).toMatchObject({ porVencer: true, vencidaPorFecha: false });
    const editada = await s.call("PATCH", `/garantias/${g.id}`, "writer", { numeroPoliza: "POL-2", monto: "130000.00", vigenciaHasta: addDays(hoy, -1) });
    expect(editada.status).toBe(200);
    expect(editada.json).toMatchObject({ numeroPoliza: "POL-2", monto: "130000.00", vigencia: { estadoEfectivo: "vencida", vencidaPorFecha: true } });
    expect((await s.call("GET", "", "viewer")).json.resumen).toMatchObject({ garantiasVencidas: 1 });
    expect((await s.call("PATCH", `/garantias/${g.id}`, "writer", {})).status).toBe(400);
    expect((await s.call("PATCH", `/garantias/no-es-uuid`, "writer", { notas: "x" })).status).toBe(400);
  });

  it("CROSS-TENANT: una garantia de otra organizacion u otro contrato responde 404, no 403 ni datos", async () => {
    const s = await setup();
    const ajena = await s.repo.createGarantia(OTRA_ORG, OTRO_CONTRATO, { tipo: "anticipo", montoCents: 100n, porcentajeBp: null, afianzadora: null, numeroPoliza: null, vigenciaDesde: "2026-10-01", vigenciaHasta: "2027-10-01", fechaLimiteEntrega: null, entregadaEn: null, notas: null }, OTRA_PERSONA);
    expect((await s.call("PATCH", `/garantias/${ajena.id}`, "owner", { notas: "intento" })).status).toBe(404);
    expect((await s.call("GET", "", "owner")).json.garantias).toEqual([]);
    expect((await s.call("GET", "/bitacora", "owner")).json.bitacora).toEqual([]);
  });
});

describe("post-adjudicacion: hitos con responsable", () => {
  const hito = (responsableId: string, extra: Record<string, unknown> = {}) => ({ titulo: "Entrega de la etapa 1", responsableId, fechaCompromiso: "2099-01-31", ...extra });

  it("crear con un miembro del equipo; el selector de responsables lista solo staff de la organizacion", async () => {
    const s = await setup();
    const r = await s.call("GET", "/responsables", "viewer");
    expect(r.json.responsables.map((x: Json) => x.userId).sort()).toEqual([s.ctx.staff.analyst.id, s.ctx.staff.writer.id].sort());
    const h = await s.call("POST", "/hitos", "writer", hito(s.ctx.staff.analyst.id, { descripcion: "Primera entrega" }));
    expect(h.status).toBe(201);
    expect(h.json).toMatchObject({ titulo: "Entrega de la etapa 1", responsableId: s.ctx.staff.analyst.id, estado: "pendiente", vigencia: { vencido: false } });
  });

  it("responsable que no es del equipo, titulo corto, fecha imposible -> 400; viewer -> 403", async () => {
    const s = await setup();
    expect((await s.call("POST", "/hitos", "writer", hito(OTRA_PERSONA))).status).toBe(400);
    expect((await s.call("POST", "/hitos", "writer", hito(s.ctx.staff.analyst.id, { titulo: "ab" }))).status).toBe(400);
    expect((await s.call("POST", "/hitos", "writer", hito(s.ctx.staff.analyst.id, { fechaCompromiso: "2026-13-40" }))).status).toBe(400);
    expect((await s.call("POST", "/hitos", "viewer", hito(s.ctx.staff.analyst.id))).status).toBe(403);
  });

  it("un hito vencido se marca vencido con sus dias de retraso; cumplirlo lo sella y lo congela (409)", async () => {
    const s = await setup();
    const hoy = mexicoCityDateKey(new Date());
    const h = (await s.call("POST", "/hitos", "writer", hito(s.ctx.staff.writer.id, { fechaCompromiso: addDays(hoy, -3) }))).json;
    expect(h.vigencia).toMatchObject({ vencido: true, diasDeRetraso: 3, estadoEfectivo: "vencido" });
    expect((await s.call("GET", "", "viewer")).json.resumen).toMatchObject({ hitosVencidos: 1, hitosPendientes: 1 });
    expect((await s.call("PATCH", `/hitos/${h.id}`, "writer", { responsableId: OTRA_PERSONA })).status).toBe(400);
    const cumplido = await s.call("PATCH", `/hitos/${h.id}`, "writer", { estado: "cumplido" });
    expect(cumplido.status).toBe(200);
    expect(cumplido.json).toMatchObject({ estado: "cumplido", cumplidoEn: hoy, vigencia: { vencido: false } });
    expect((await s.call("PATCH", `/hitos/${h.id}`, "writer", { titulo: "Cambio tardio" })).status).toBe(409);
    expect((await s.call("PATCH", `/hitos/${h.id}`, "viewer", { estado: "cancelado" })).status).toBe(403);
  });

  it("CROSS-TENANT: un hito de otra organizacion responde 404", async () => {
    const s = await setup();
    // Se siembra con un miembro propio de ESA organizacion (el repositorio en memoria exige responsable de su organizacion).
    const ajeno = new InMemoryPostAdjudicacionRepository({ responsables: { [OTRA_ORG]: [{ userId: OTRA_PERSONA, nombre: "Ajena", rol: "owner" }] } });
    const hajeno = await ajeno.createHito(OTRA_ORG, OTRO_CONTRATO, { titulo: "Hito ajeno", descripcion: null, responsableId: OTRA_PERSONA, fechaCompromiso: "2026-12-01" }, OTRA_PERSONA);
    // El mismo id en el repositorio de la organizacion A no existe: 404, sin distinguir "ajeno" de "inexistente".
    expect((await s.call("PATCH", `/hitos/${hajeno.id}`, "owner", { estado: "cancelado" })).status).toBe(404);
  });
});

describe("post-adjudicacion: convenios modificatorios", () => {
  it("solo un rol de decision; deja historial numerado y mueve la fecha de fin del contrato; sin Idempotency-Key 400", async () => {
    const s = await setup();
    await s.app.request(s.tenderBase, { method: "PATCH", body: JSON.stringify({ endDate: "2026-12-31" }), headers: { authorization: `Bearer ${s.ctx.staff.owner.token}`, "content-type": "application/json" } });
    const body = { tipo: "plazo", nuevaFechaFin: "2027-03-31", fechaFirma: "2026-10-01", motivo: "Ampliacion por causas de la convocante" };
    expect((await s.call("POST", "/convenios", "writer", body)).status).toBe(403);
    expect((await s.call("POST", "/convenios", "viewer", body)).status).toBe(403);
    const c1 = await s.call("POST", "/convenios", "analyst", body);
    expect(c1.status).toBe(201);
    expect(c1.json.convenio).toMatchObject({ numero: 1, tipo: "plazo", fechaFinAnterior: "2026-12-31", nuevaFechaFin: "2027-03-31", montoDelta: null });
    expect(c1.json.contratoFechaFin).toBe("2027-03-31");
    const c2 = await s.call("POST", "/convenios", "owner", { tipo: "monto_plazo", montoDelta: "-5000.00", nuevaFechaFin: "2027-06-30", fechaFirma: "2026-11-01", motivo: "Reduccion y ajuste de plazo" });
    expect(c2.json.convenio).toMatchObject({ numero: 2, fechaFinAnterior: "2027-03-31", montoDelta: "-5000.00" });
    const contrato = await s.app.request(s.tenderBase, authedJson(s.ctx.staff.viewer.token));
    expect(((await contrato.json()) as Json).endDate).toBe("2027-06-30");
    const overview = (await s.call("GET", "", "viewer")).json;
    expect(overview.convenios.map((c: Json) => c.numero)).toEqual([1, 2]);
    expect(overview.resumen.ajusteDeMontoAcumulado).toBe("-5000.00");
    const bitacora = (await s.call("GET", "/bitacora", "viewer")).json.bitacora;
    expect(bitacora.filter((e: Json) => e.entidad === "convenio")).toHaveLength(2);
    const sinClave = await s.app.request(`${s.base}/convenios`, authedJson(s.ctx.staff.analyst.token, body));
    expect(sinClave.status).toBe(400);
  });

  it("validacion por tipo: monto sin monto, plazo con monto, ajuste cero o numerico -> 400", async () => {
    const s = await setup();
    const base = { fechaFirma: "2026-10-01", motivo: "Motivo suficiente" };
    for (const body of [{ ...base, tipo: "monto" }, { ...base, tipo: "plazo" }, { ...base, tipo: "plazo", montoDelta: "5.00", nuevaFechaFin: "2027-01-01" }, { ...base, tipo: "monto", montoDelta: "0" }, { ...base, tipo: "monto", montoDelta: 5000 }, { ...base, tipo: "x" }]) {
      expect((await s.call("POST", "/convenios", "analyst", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("con 2FA activo, un convenio exige step-up: sin token 403 step_up_required y NO se registra nada", async () => {
    const s = await setup();
    const security = new InMemoryStaffSecurityRepository(s.ctx.deps.coreRepo as InMemoryCoreRepository);
    const app = buildApp({ ...s.deps, staffSecurityRepo: security });
    const token = s.ctx.staff.analyst.token;
    const setupRes = await app.request("/auth/2fa/setup", authedJson(token, {}));
    const { secret } = (await setupRes.json()) as { secret: string };
    expect((await app.request("/auth/2fa/confirm", authedJson(token, { code: computeTotp(secret, Date.now()) }))).status).toBe(200);
    const body = { tipo: "monto", montoDelta: "100.00", fechaFirma: "2026-10-01", motivo: "Incremento autorizado" };
    const headers = { "idempotency-key": "k-stepup" };
    const sin = await app.request(`${s.base}/convenios`, authedJson(token, body, headers));
    expect(sin.status).toBe(403);
    expect(((await sin.json()) as Json).code).toBe("step_up_required");
    const stepUp = await app.request("/auth/step-up", authedJson(token, { scope: "contract_sensitive", code: computeTotp(secret, Date.now() + 30_000) }));
    const { stepUpToken } = (await stepUp.json()) as { stepUpToken: string };
    expect((await s.call("GET", "", "viewer")).json.convenios).toEqual([]);
    const con = await app.request(`${s.base}/convenios`, authedJson(token, body, { ...headers, "x-step-up-token": stepUpToken }));
    expect(con.status).toBe(201);
  });
});

describe("post-adjudicacion: alertas del barrido existente (campana)", () => {
  async function conAlertas(opts: { noDisponible?: boolean } = {}) {
    const s = await setup({ noDisponible: opts.noDisponible });
    const { deps, emisiones } = conEmisiones(s.deps);
    const hoy = mexicoCityDateKey(new Date());
    if (!opts.noDisponible) {
      // por vencer (en 10 dias), sana (en 90), no entregada (limite ayer), hito vencido (hace 2 dias) y un hito al corriente.
      await s.call("POST", "/garantias", "writer", { ...garantiaBody, tipo: "anticipo", afianzadora: "Afianzadora Secreta SA", vigenciaDesde: addDays(hoy, -100), vigenciaHasta: addDays(hoy, 10), entregadaEn: addDays(hoy, -50) });
      await s.call("POST", "/garantias", "writer", { ...garantiaBody, tipo: "vicios_ocultos", vigenciaHasta: addDays(hoy, 90), entregadaEn: addDays(hoy, -5) });
      await s.call("POST", "/garantias", "writer", { ...garantiaBody, fechaLimiteEntrega: addDays(hoy, -1) });
      await s.call("POST", "/hitos", "writer", { titulo: "Hito atrasado", responsableId: s.ctx.staff.writer.id, fechaCompromiso: addDays(hoy, -2) });
      await s.call("POST", "/hitos", "writer", { titulo: "Hito al corriente", responsableId: s.ctx.staff.writer.id, fechaCompromiso: addDays(hoy, 30) });
    }
    const cron = () => buildApp(deps).request("/internal/licitaciones/alert-notifications", { method: "POST", headers: { "x-atiende-internal-secret": s.ctx.deps.env.internalSecret } });
    return { s, emisiones, cron, hoy };
  }

  it("emite UNA alerta por evento (garantia por vencer, garantia no entregada, hito vencido) con enlace a la convocatoria, sin PII; repetir usa las mismas claves", async () => {
    const { s, emisiones, cron, hoy } = await conAlertas();
    const res = await cron();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.avisos_post_adjudicacion).toEqual({ garantiasPorVencer: 1, garantiasNoEntregadas: 1, hitosVencidos: 1 });
    const mias = emisiones.filter((e) => e.evento.startsWith("licitaciones.contrato."));
    expect(mias.map((e) => e.evento).sort()).toEqual(["licitaciones.contrato.garantia_no_entregada", "licitaciones.contrato.garantia_por_vencer", "licitaciones.contrato.hito_vencido"]);
    for (const e of mias) {
      expect(e.organizationId).toBe(s.ctx.organizationId);
      expect(e.enlace).toBe(`/licitaciones/{orgSlug}/convocatorias/${s.ctx.tenderId}/post-adjudicacion`);
      expect(e.dedupeKey).toMatch(new RegExp(`^${e.evento.replaceAll(".", "\\.")}:[0-9a-f-]{36}:\\d{4}-\\d{2}-\\d{2}$`));
    }
    expect(mias.find((e) => e.evento === "licitaciones.contrato.garantia_no_entregada")).toMatchObject({ categoria: "operacion", severidad: "critica" });
    expect(JSON.stringify(mias)).not.toMatch(/Secreta|125000|Hito atrasado|POL-1/);
    // Segunda corrida: las mismas claves (la base deduplica); ninguna alerta nueva con clave distinta.
    const claves = new Set(mias.map((e) => e.dedupeKey));
    emisiones.length = 0;
    expect((await cron()).status).toBe(200);
    const otra = emisiones.filter((e) => e.evento.startsWith("licitaciones.contrato."));
    expect(otra).toHaveLength(3);
    expect(new Set(otra.map((e) => e.dedupeKey))).toEqual(claves);
    expect(hoy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("una garantia liberada o un hito cumplido ya no generan alerta", async () => {
    const { s, emisiones, cron } = await conAlertas();
    const overview = (await s.call("GET", "", "viewer")).json;
    const porVencer = overview.garantias.find((g: Json) => g.vigencia.porVencer);
    const hito = overview.hitos.find((h: Json) => h.vigencia.vencido);
    expect((await s.call("PATCH", `/garantias/${porVencer.id}`, "analyst", { estado: "liberada" })).status).toBe(200);
    expect((await s.call("PATCH", `/hitos/${hito.id}`, "writer", { estado: "cumplido" })).status).toBe(200);
    const body = (await (await cron()).json()) as Json;
    expect(body.avisos_post_adjudicacion).toEqual({ garantiasPorVencer: 0, garantiasNoEntregadas: 1, hitosVencidos: 0 });
    expect(emisiones.filter((e) => e.evento.startsWith("licitaciones.contrato.")).map((e) => e.evento)).toEqual(["licitaciones.contrato.garantia_no_entregada"]);
  });

  it("base sin la migracion 035: el barrido responde 200 y no emite nada", async () => {
    const { emisiones, cron } = await conAlertas({ noDisponible: true });
    const res = await cron();
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).avisos_post_adjudicacion).toEqual({ garantiasPorVencer: 0, garantiasNoEntregadas: 0, hitosVencidos: 0 });
    expect(emisiones.filter((e) => e.evento.startsWith("licitaciones.contrato."))).toHaveLength(0);
  });

  it("una emision que falla (base sin migrar de notificaciones) no cambia la respuesta del barrido", async () => {
    const s = await setup();
    const hoy = mexicoCityDateKey(new Date());
    await s.call("POST", "/hitos", "writer", { titulo: "Hito atrasado", responsableId: s.ctx.staff.writer.id, fechaCompromiso: addDays(hoy, -2) });
    const { deps } = conEmisiones(s.deps, {
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const res = await buildApp(deps).request("/internal/licitaciones/alert-notifications", { method: "POST", headers: { "x-atiende-internal-secret": s.ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).avisos_post_adjudicacion).toEqual({ garantiasPorVencer: 0, garantiasNoEntregadas: 0, hitosVencidos: 0 });
  });
});
