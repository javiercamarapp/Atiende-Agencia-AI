// D-35 + D-02 -- conciliación bancaria persistida y nivel 4 (LLM) por HTTP, end-to-end sobre los dobles en memoria con auth/RLS/roles reales
// (mismo patrón que despachos-conciliacion-importar-estado.spec.ts). Cubre: persistencia entre "recargas", el servidor recalcula el motor y nunca
// confía en nivel/confianza/origen del cliente, roles (readonly/auditor no escriben), cross-tenant, periodo cerrado, deshacer idempotente con
// bitácora, sugerencias del LLM que jamás aplican solas, 503 sin gateway, fallo del proveedor, notificación con dedupe y base sin migrar.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { LlmGateway } from "@atiende/agent-core";
import { hashPassword } from "@atiende/db";
import type { InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { getTemplate, PostgresConciliacionPersistidaRepository } from "@atiende/domain-despachos";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
let ctx: Mutable<DespachosTestContext>;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const FOLIO_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const FOLIO_B = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";

async function cfdi(total: number, fecha: string, folio: string, emisor = "CLIENTE ACME SA DE CV") {
  return ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    folioFiscal: folio,
    tipo: "I",
    rfcEmisor: "AAA010101AAA",
    rfcReceptor: "CLI010101CL1",
    emisorNombre: emisor,
    subtotal: total / 1.16,
    total,
    iva: total - total / 1.16,
    descuento: 0,
    categoria: "gasto_operativo",
    valido: true,
    issues: [],
    warnings: [],
    requiresHumanReview: false,
    diot: { reportable: false, proveedoresReportables: [] },
    fecha,
  });
}

let renglon = 0;
async function movimiento(fecha: string, abono: number, descripcion: string, cuenta = "012180001234567897") {
  renglon += 1;
  await ctx.despachosRepo.insertEstadoCuentaMovimientos({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    loteId: randomUUID(),
    movimientos: [{ hash: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), cuenta, banco: "bbva", formato: "csv", fecha, descripcion, referencia: null, cargo: null, abono, monto: abono, saldo: null, renglon }],
  });
}

const app = () => buildApp(ctx.deps);
const post = (token: string, path: string, body: unknown = {}) => app().request(`/despachos/${ctx.propertyId}/conciliacion/${path}`, authedJson(token, body));
const get = (token: string, path: string) => app().request(`/despachos/${ctx.propertyId}/conciliacion/${path}`, authedJson(token));
const admin = () => ctx.staff.admin.token;

interface Detalle {
  sesion: { id: string; estado: string };
  movimientos: { id: string; estado: string; matchId: string | null }[];
  cfdis: { id: string; conciliado: boolean }[];
  propuestas: { movimientoId: string; invoiceId: string; nivel: number; confianza: number }[];
  matches: { id: string; movimientoId: string; invoiceId: string; nivel: number | null; confianza: number | null; origen: string; deshechoEn: string | null; motivoDeshacer: string | null }[];
  sugerencias: { id: string; movimientoId: string; invoiceId: string; estado: string; confianza: number; razon: string }[];
}
async function detalle(id: string, token = admin()): Promise<Detalle> {
  const r = await get(token, `sesiones/${id}`);
  expect(r.status).toBe(200);
  return (await r.json()) as Detalle;
}
async function crearSesion(periodo = "2026-01", cuenta?: string): Promise<string> {
  const r = await post(admin(), "sesiones", { periodo, ...(cuenta ? { cuenta } : {}) });
  expect(r.status).toBe(201);
  return ((await r.json()) as { sesion: { id: string } }).sesion.id;
}

/** Un CFDI + un movimiento que el motor concilia exacto (mismo monto y fecha). */
async function escenarioExacto() {
  const factura = await cfdi(1160, "2026-01-05", FOLIO_A);
  await movimiento("2026-01-05", 1160, "SPEI RECIBIDO CLIENTE ACME SA DE CV");
  const sesionId = await crearSesion();
  const d = await detalle(sesionId);
  return { factura, sesionId, movimientoId: d.movimientos[0]!.id };
}

describe("sesiones: crear, listar y detalle", () => {
  it("crea la sesión con los movimientos guardados del periodo, la lista y el detalle trae la propuesta del motor", async () => {
    await cfdi(1160, "2026-01-05", FOLIO_A);
    await movimiento("2026-01-05", 1160, "SPEI RECIBIDO CLIENTE ACME SA DE CV");
    await movimiento("2026-02-05", 50, "OTRO MES");
    const r = await post(admin(), "sesiones", { periodo: "2026-01" });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { sesion: { id: string; estado: string; periodo: string }; movimientos: number };
    expect(body.movimientos).toBe(1);
    expect(body.sesion).toMatchObject({ estado: "abierta", periodo: "2026-01" });

    const lista = (await (await get(admin(), "sesiones")).json()) as { disponible: boolean; sesiones: { id: string; totalMovimientos: number; matchesVigentes: number }[] };
    expect(lista.disponible).toBe(true);
    expect(lista.sesiones).toHaveLength(1);
    expect(lista.sesiones[0]).toMatchObject({ totalMovimientos: 1, matchesVigentes: 0 });

    const d = await detalle(body.sesion.id);
    expect(d.movimientos).toHaveLength(1);
    expect(d.movimientos[0]!.estado).toBe("sin_conciliar");
    expect(d.propuestas).toHaveLength(1);
    expect(d.propuestas[0]).toMatchObject({ nivel: 1, confianza: 100 });
  });

  it("rechaza periodo con formato inválido (400), periodo sin movimientos (404), cuenta inválida (400) y ids mal formados (400)", async () => {
    expect((await post(admin(), "sesiones", { periodo: "2026-1" })).status).toBe(400);
    expect((await post(admin(), "sesiones", { periodo: "2026-03" })).status).toBe(404);
    await movimiento("2026-01-05", 10, "x");
    expect((await post(admin(), "sesiones", { periodo: "2026-01", cuenta: "!!" })).status).toBe(400);
    expect((await get(admin(), "sesiones/no-es-uuid")).status).toBe(400);
    expect((await get(admin(), `sesiones/${randomUUID()}`)).status).toBe(404);
  });

  it("una sesión acotada a una cuenta solo ve los movimientos de esa cuenta", async () => {
    await movimiento("2026-01-05", 10, "cuenta uno", "CUENTA-UNO-1");
    await movimiento("2026-01-06", 20, "cuenta dos", "CUENTA-DOS-2");
    const id = await crearSesion("2026-01", "CUENTA-DOS-2");
    expect((await detalle(id)).movimientos).toHaveLength(1);
  });
});

describe("confirmar: el servidor recalcula el motor y nunca confía en el cliente", () => {
  it("confirma un par del motor con nivel y confianza del SERVIDOR (ignora lo que mande el cliente) y sobrevive a recargar", async () => {
    const { factura, sesionId, movimientoId } = await escenarioExacto();
    const r = await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id, nivel: 4, confianza: 12, origen: "llm_aprobado" }] });
    expect(r.status).toBe(201);
    const { matches } = (await r.json()) as { matches: { origen: string; nivel: number; confianza: number; confirmadoPor: string }[] };
    expect(matches[0]).toMatchObject({ origen: "motor", nivel: 1, confianza: 100, confirmadoPor: ctx.staff.admin.id });

    // "Recargar": otra petición, otra instancia de la app -> el match sigue ahí y el CFDI queda marcado como conciliado.
    const d = await detalle(sesionId);
    expect(d.movimientos[0]).toMatchObject({ estado: "conciliado" });
    expect(d.matches).toHaveLength(1);
    expect(d.cfdis.find((c) => c.id === factura.id)?.conciliado).toBe(true);
    expect(d.propuestas).toHaveLength(0);
    const lista = (await (await get(admin(), "sesiones")).json()) as { sesiones: { matchesVigentes: number }[] };
    expect(lista.sesiones[0]!.matchesVigentes).toBe(1);
  });

  it("un par que el motor NO propone se rechaza (422) y no guarda nada; como manual (rol de escritura) sí entra sin nivel ni confianza", async () => {
    const { sesionId, movimientoId } = await escenarioExacto();
    const otra = await cfdi(99999, "2026-01-20", FOLIO_B, "PROVEEDOR DISTINTO");
    const r = await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: otra.id }] });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error?: { code?: string } }).error?.code ?? "par_no_propuesto").toBe("par_no_propuesto");
    expect((await detalle(sesionId)).matches).toHaveLength(0);

    const m = await post(ctx.staff.contador.token, `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: otra.id, manual: true }] });
    expect(m.status).toBe(201);
    const { matches } = (await m.json()) as { matches: { origen: string; nivel: number | null; confianza: number | null }[] };
    expect(matches[0]).toMatchObject({ origen: "manual", nivel: null, confianza: null });
  });

  it("todo o nada: un lote con un par inválido no deja ningún match", async () => {
    const { factura, sesionId, movimientoId } = await escenarioExacto();
    const r = await post(admin(), `sesiones/${sesionId}/confirmar`, {
      pares: [
        { movimientoId, invoiceId: factura.id },
        { movimientoId: randomUUID(), invoiceId: factura.id, manual: true },
      ],
    });
    expect(r.status).toBe(400);
    expect((await detalle(sesionId)).matches).toHaveLength(0);
  });

  it("un movimiento ya conciliado no se concilia dos veces (409 o 422) y valida la forma del cuerpo (400)", async () => {
    const { factura, sesionId, movimientoId } = await escenarioExacto();
    expect((await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }] })).status).toBe(201);
    const otra = await cfdi(1160, "2026-01-05", FOLIO_B);
    const dup = await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: otra.id, manual: true }] });
    expect(dup.status).toBe(409);
    expect((await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [] })).status).toBe(400);
    expect((await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId: "x", invoiceId: "y" }] })).status).toBe(400);
    expect((await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: otra.id, manual: "si" }] })).status).toBe(400);
    expect((await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }, { movimientoId, invoiceId: otra.id }] })).status).toBe(400);
  });

  it("deja bitácora de la confirmación sin texto libre", async () => {
    const { factura, sesionId, movimientoId } = await escenarioExacto();
    await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }] });
    const ev = ctx.auditSink.entries.filter((e) => e.action === "despachos.conciliacion:confirmar");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.metadata).toMatchObject({ sesionId, pares: 1, motor: 1, manuales: 0 });
  });
});

describe("deshacer: motivo obligatorio, bitácora e idempotencia", () => {
  async function confirmado() {
    const e = await escenarioExacto();
    const r = await post(admin(), `sesiones/${e.sesionId}/confirmar`, { pares: [{ movimientoId: e.movimientoId, invoiceId: e.factura.id }] });
    const matchId = ((await r.json()) as { matches: { id: string }[] }).matches[0]!.id;
    return { ...e, matchId };
  }

  it("exige motivo (400), deshace con 200, deja el historial y libera al movimiento y al CFDI", async () => {
    const { sesionId, matchId, factura, movimientoId } = await confirmado();
    expect((await post(admin(), `matches/${matchId}/deshacer`, {})).status).toBe(400);
    expect((await post(admin(), `matches/${matchId}/deshacer`, { motivo: "ab" })).status).toBe(400);
    const r = await post(admin(), `matches/${matchId}/deshacer`, { motivo: "Se concilió contra la factura equivocada" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ yaDeshecho: false });

    const d = await detalle(sesionId);
    expect(d.matches[0]).toMatchObject({ id: matchId, motivoDeshacer: "Se concilió contra la factura equivocada" });
    expect(d.matches[0]!.deshechoEn).not.toBeNull();
    expect(d.movimientos[0]!.estado).toBe("sin_conciliar");
    expect(d.cfdis.find((c) => c.id === factura.id)?.conciliado).toBe(false);
    // Libre de nuevo: se puede confirmar otra vez.
    const otra = await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }] });
    expect(otra.status).toBe(201);
  });

  it("es idempotente: la segunda llamada responde 200 yaDeshecho, no pisa el motivo y no duplica la bitácora", async () => {
    const { sesionId, matchId } = await confirmado();
    await post(admin(), `matches/${matchId}/deshacer`, { motivo: "primer motivo valido" });
    const r = await post(admin(), `matches/${matchId}/deshacer`, { motivo: "segundo motivo valido" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ yaDeshecho: true });
    expect((await detalle(sesionId)).matches[0]!.motivoDeshacer).toBe("primer motivo valido");
    const ev = ctx.auditSink.entries.filter((e) => e.action === "despachos.conciliacion:deshacer");
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0]!.metadata)).not.toContain("primer motivo");
  });

  it("un match inexistente responde 404", async () => {
    expect((await post(admin(), `matches/${randomUUID()}/deshacer`, { motivo: "no existe esto" })).status).toBe(404);
  });
});

describe("periodo cerrado (cierre-mensual) bloquea confirmar y deshacer", () => {
  async function cerrarEnero() {
    const { periodo } = await ctx.despachosRepo.insertPeriodoCierre({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, anio: 2026, mes: 1, template: getTemplate(undefined) });
    await ctx.despachosRepo.updatePeriodoCierre({ ...periodo, status: "closed", closedAt: new Date().toISOString() });
  }

  it("confirmar con el periodo cerrado responde 409 periodo_cerrado y no guarda nada", async () => {
    const { factura, sesionId, movimientoId } = await escenarioExacto();
    await cerrarEnero();
    const r = await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }] });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("cerrado");
    expect((await detalle(sesionId)).matches).toHaveLength(0);
  });

  it("deshacer con el periodo cerrado responde 409; un match YA deshecho sigue siendo idempotente (200)", async () => {
    const { factura, sesionId, movimientoId } = await escenarioExacto();
    const c1 = await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }] });
    const matchId = ((await c1.json()) as { matches: { id: string }[] }).matches[0]!.id;
    await cerrarEnero();
    expect((await post(admin(), `matches/${matchId}/deshacer`, { motivo: "motivo valido" })).status).toBe(409);
    expect((await detalle(sesionId)).matches[0]!.deshechoEn).toBeNull();
  });

  it("un match deshecho ANTES del cierre sigue respondiendo 200 yaDeshecho después", async () => {
    const { factura, sesionId, movimientoId } = await escenarioExacto();
    const c1 = await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }] });
    const matchId = ((await c1.json()) as { matches: { id: string }[] }).matches[0]!.id;
    await post(admin(), `matches/${matchId}/deshacer`, { motivo: "motivo valido" });
    await cerrarEnero();
    const r = await post(admin(), `matches/${matchId}/deshacer`, { motivo: "otra vez" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ yaDeshecho: true });
  });

  it("sugerir con IA y aprobar también respetan el periodo cerrado", async () => {
    const e = await escenarioLlm();
    ctx.deps = conGateway(gatewayQueElige(0, 80));
    const s = await post(admin(), `sesiones/${e.sesionId}/sugerencias-llm`);
    expect(s.status).toBe(201);
    const sugId = ((await s.json()) as { sugerencias: { id: string }[] }).sugerencias[0]!.id;
    await cerrarEnero();
    expect((await post(admin(), `sugerencias/${sugId}/aprobar`)).status).toBe(409);
    expect((await post(admin(), `sesiones/${e.sesionId}/sugerencias-llm`)).status).toBe(409);
  });
});

describe("roles: readonly y auditor leen pero NO escriben", () => {
  it("GET lista y detalle: 200 para readonly y auditor; todas las escrituras: 403", async () => {
    const { factura, sesionId, movimientoId } = await escenarioExacto();
    const c1 = await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }] });
    const matchId = ((await c1.json()) as { matches: { id: string }[] }).matches[0]!.id;
    for (const rol of ["readonly", "auditor"] as const) {
      const t = ctx.staff[rol].token;
      expect((await get(t, "sesiones")).status).toBe(200);
      expect((await get(t, `sesiones/${sesionId}`)).status).toBe(200);
      expect((await post(t, "sesiones", { periodo: "2026-01" })).status).toBe(403);
      expect((await post(t, `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }] })).status).toBe(403);
      expect((await post(t, `matches/${matchId}/deshacer`, { motivo: "motivo valido" })).status).toBe(403);
      expect((await post(t, `sesiones/${sesionId}/cerrar`)).status).toBe(403);
      expect((await post(t, `sesiones/${sesionId}/sugerencias-llm`)).status).toBe(403);
      expect((await post(t, `sugerencias/${randomUUID()}/aprobar`)).status).toBe(403);
      expect((await post(t, `sugerencias/${randomUUID()}/rechazar`)).status).toBe(403);
    }
    expect((await detalle(sesionId)).matches[0]!.deshechoEn).toBeNull();
  });

  it("sin token: 401", async () => {
    const r = await app().request(`/despachos/${ctx.propertyId}/conciliacion/sesiones`);
    expect(r.status).toBe(401);
  });
});

describe("cross-tenant: otra organización no ve ni toca la sesión", () => {
  async function otraOrganizacion() {
    const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
    const engine = ctx.deps.engine as InMemoryTenancyEngine;
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    coreRepo.addOrganization({ id: organizationId, slug: "otro-despacho", name: "Otro Despacho", vertical: "despachos" });
    engine.seedProperty({ id: propertyId, organizationId });
    ctx.despachosRepo.seedOrganization({ id: organizationId, slug: "otro-despacho", name: "Otro Despacho" });
    ctx.despachosRepo.seedDespachosProperty({ id: propertyId, organizationId, name: "Cliente ajeno" });
    const id = randomUUID();
    const password = "correcto-caballo-batería";
    coreRepo.addStaff({ id, email: "admin@otro-despacho.mx", fullName: "Admin B", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addMembership({ userId: id, organizationId, platformRole: "owner", verticalRole: "admin", propertyIds: null });
    engine.seedMembership({ userId: id, organizationId, platformRole: "owner", verticalRole: "admin", propertyIds: null });
    const login = await app().request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@otro-despacho.mx", password }) });
    return { propertyId, token: ((await login.json()) as { token: string }).token };
  }

  it("no accede a la property de A (403/404) ni a la sesión/match de A usando su propia property (404)", async () => {
    const { factura, sesionId, movimientoId } = await escenarioExacto();
    const c1 = await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }] });
    const matchId = ((await c1.json()) as { matches: { id: string }[] }).matches[0]!.id;
    const b = await otraOrganizacion();

    const aProp = (path: string, body?: unknown) => app().request(`/despachos/${ctx.propertyId}/conciliacion/${path}`, authedJson(b.token, body));
    expect([403, 404]).toContain((await aProp(`sesiones/${sesionId}`)).status);
    expect([403, 404]).toContain((await aProp("sesiones")).status);
    expect([403, 404]).toContain((await aProp(`matches/${matchId}/deshacer`, { motivo: "motivo valido" })).status);

    const suya = (path: string, body?: unknown) => app().request(`/despachos/${b.propertyId}/conciliacion/${path}`, authedJson(b.token, body));
    expect((await suya(`sesiones/${sesionId}`)).status).toBe(404);
    expect((await suya(`sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id, manual: true }] })).status).toBe(404);
    expect((await suya(`matches/${matchId}/deshacer`, { motivo: "motivo valido" })).status).toBe(404);
    expect((await suya(`sesiones/${sesionId}/cerrar`, {})).status).toBe(404);
    const lista = (await (await suya("sesiones")).json()) as { sesiones: unknown[] };
    expect(lista.sesiones).toHaveLength(0);
    expect((await detalle(sesionId)).matches[0]!.deshechoEn).toBeNull();
  });
});

describe("cerrar sesión", () => {
  it("cierra (idempotente) y una sesión cerrada ya no admite confirmar (409)", async () => {
    const { factura, sesionId, movimientoId } = await escenarioExacto();
    const r1 = await post(admin(), `sesiones/${sesionId}/cerrar`);
    expect(await r1.json()).toEqual({ yaCerrada: false });
    expect(await (await post(admin(), `sesiones/${sesionId}/cerrar`)).json()).toEqual({ yaCerrada: true });
    expect((await detalle(sesionId)).sesion.estado).toBe("cerrada");
    expect((await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id }] })).status).toBe(409);
    expect(ctx.auditSink.entries.filter((e) => e.action === "despachos.conciliacion:sesion-cerrar")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Nivel 4 (LLM)
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** Un movimiento que el motor NO concilia (monto muy distinto) pero con texto parecido al CFDI: candidato para el LLM. */
async function escenarioLlm() {
  const factura = await cfdi(1160, "2026-01-05", FOLIO_A);
  await movimiento("2026-01-20", 1000, "PAGO FACTURA CLIENTE ACME");
  const sesionId = await crearSesion();
  const d = await detalle(sesionId);
  return { factura, sesionId, movimientoId: d.movimientos[0]!.id };
}

interface LlamadaGateway {
  readonly tenantId: string;
  readonly role: string;
}
function gatewayQueElige(candidato: number | null, confianza: number, razonamiento = "Mismo cliente, importe cercano"): LlmGateway & { llamadas: LlamadaGateway[] } {
  const llamadas: LlamadaGateway[] = [];
  const complete = async (opts: LlamadaGateway) => {
    llamadas.push({ tenantId: opts.tenantId, role: opts.role });
    return {
      text: "",
      toolCalls: [{ id: "t1", name: "proponer_match_conciliacion", argumentsJson: JSON.stringify({ candidato_elegido: candidato, confianza, razonamiento }) }],
      model: "modelo-de-prueba",
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0,
      providerId: "fake",
      fallbackUsed: false,
      attempts: [],
    };
  };
  return { complete, llamadas } as unknown as LlmGateway & { llamadas: LlamadaGateway[] };
}

/** Envuelve el engine para capturar las llamadas a `core.emit_notification` (la sesión en memoria no la implementa). */
function conGateway(gateway: LlmGateway | undefined, emisiones: unknown[][] = []): AppDeps {
  const base = ctx.deps.engine;
  const engine = Object.create(base) as typeof base;
  engine.withAppSession = ((claims: unknown, fn: (s: TenantDbSession) => Promise<unknown>) =>
    (base.withAppSession as (c: unknown, f: (s: TenantDbSession) => Promise<unknown>) => Promise<unknown>).call(base, claims, (s) =>
      fn({
        exec: (sql: string) => s.exec(sql),
        query: async <T,>(sql: string, params?: unknown[]) => {
          if (/core\.emit_notification/.test(sql)) {
            emisiones.push(params ?? []);
            return { rows: [{ emit_notification: 1 }] as unknown as T[] };
          }
          return s.query<T>(sql, params);
        },
      }),
    )) as typeof base.withAppSession;
  return { ...ctx.deps, engine, llmGateway: gateway };
}

describe("D-02 nivel 4 (LLM) por HTTP", () => {
  it("sin gateway responde 503 honesto 'IA no configurada' y no guarda nada", async () => {
    const { sesionId } = await escenarioLlm();
    const r = await post(admin(), `sesiones/${sesionId}/sugerencias-llm`);
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("IA no configurada");
    expect((await detalle(sesionId)).sugerencias).toHaveLength(0);
  });

  it("guarda la sugerencia PENDIENTE con confianza y razón, NO cambia el estado de la conciliación y sobrevive a recargar", async () => {
    const { sesionId, factura, movimientoId } = await escenarioLlm();
    const gw = gatewayQueElige(0, 82, "Mismo cliente y fecha cercana");
    ctx.deps = conGateway(gw);
    const r = await post(admin(), `sesiones/${sesionId}/sugerencias-llm`);
    expect(r.status).toBe(201);
    const body = (await r.json()) as { sugerencias: { estado: string; movimientoId: string; invoiceId: string; confianza: number }[] };
    expect(body.sugerencias).toHaveLength(1);
    expect(body.sugerencias[0]).toMatchObject({ estado: "pendiente", movimientoId, invoiceId: factura.id, confianza: 82 });
    expect(gw.llamadas[0]).toMatchObject({ tenantId: ctx.organizationId, role: "despachos:conciliacion_llm_agent" });

    const d = await detalle(sesionId);
    expect(d.matches).toHaveLength(0);
    expect(d.movimientos[0]!.estado).toBe("sugerido");
    expect(d.cfdis.find((c) => c.id === factura.id)?.conciliado).toBe(false);
    expect(d.sugerencias[0]).toMatchObject({ estado: "pendiente", razon: "Mismo cliente y fecha cercana", confianza: 82 });
    // No se aplica sola ni con confianza 100: sigue pendiente aunque pase el tiempo / se vuelva a pedir.
    const otra = await post(admin(), `sesiones/${sesionId}/sugerencias-llm`);
    expect(((await otra.json()) as { sugerencias: unknown[] }).sugerencias).toHaveLength(0);
    expect((await detalle(sesionId)).sugerencias).toHaveLength(1);
  });

  it("emite UNA notificación con dedupe por sesión, sin PII (solo la cantidad) y solo cuando hay sugerencias nuevas", async () => {
    const { sesionId } = await escenarioLlm();
    const emisiones: unknown[][] = [];
    ctx.deps = conGateway(gatewayQueElige(0, 70), emisiones);
    const r = await post(admin(), `sesiones/${sesionId}/sugerencias-llm`);
    expect(((await r.json()) as { notificacion: string }).notificacion).toBe("emitida");
    expect(emisiones).toHaveLength(1);
    const textoEmitido = JSON.stringify(emisiones[0]);
    expect(textoEmitido).toContain("despachos.conciliacion.sugerencias_pendientes");
    expect(textoEmitido).toContain(`despachos.conciliacion.sugerencias_pendientes:${sesionId}`);
    expect(textoEmitido).toContain("/despachos/{orgSlug}/conciliacion");
    expect(textoEmitido).toContain("Sugerencias pendientes de aprobar o rechazar: 1.");
    expect(textoEmitido).not.toContain("ACME");
    // Segunda corrida sin sugerencias nuevas: no emite otra vez.
    await post(admin(), `sesiones/${sesionId}/sugerencias-llm`);
    expect(emisiones).toHaveLength(1);
  });

  it("aprobar crea el match llm_aprobado nivel 4 con la confianza guardada y deja bitácora; rechazar no crea match", async () => {
    const { sesionId, factura, movimientoId } = await escenarioLlm();
    ctx.deps = conGateway(gatewayQueElige(0, 77));
    const sug = ((await (await post(admin(), `sesiones/${sesionId}/sugerencias-llm`)).json()) as { sugerencias: { id: string }[] }).sugerencias[0]!;
    const r = await post(ctx.staff.contador.token, `sugerencias/${sug.id}/aprobar`);
    expect(r.status).toBe(200);
    const { estado, matchId } = (await r.json()) as { estado: string; matchId: string };
    expect(estado).toBe("aprobada");
    const d = await detalle(sesionId);
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]).toMatchObject({ id: matchId, origen: "llm_aprobado", nivel: 4, confianza: 77, movimientoId, invoiceId: factura.id });
    expect(d.sugerencias[0]!.estado).toBe("aprobada");
    expect(d.cfdis.find((c) => c.id === factura.id)?.conciliado).toBe(true);
    expect(ctx.auditSink.entries.some((e) => e.action === "despachos.conciliacion:sugerencia-aprobar")).toBe(true);
    // Ya resuelta: no se vuelve a aprobar ni a rechazar.
    expect((await post(admin(), `sugerencias/${sug.id}/aprobar`)).status).toBe(400);
    expect((await post(admin(), `sugerencias/${sug.id}/rechazar`)).status).toBe(400);
  });

  it("rechazar deja la sugerencia rechazada, sin match, y el movimiento vuelve a sin_conciliar", async () => {
    const { sesionId } = await escenarioLlm();
    ctx.deps = conGateway(gatewayQueElige(0, 77));
    const sug = ((await (await post(admin(), `sesiones/${sesionId}/sugerencias-llm`)).json()) as { sugerencias: { id: string }[] }).sugerencias[0]!;
    const r = await post(admin(), `sugerencias/${sug.id}/rechazar`);
    expect(await r.json()).toEqual({ estado: "rechazada", matchId: null });
    const d = await detalle(sesionId);
    expect(d.matches).toHaveLength(0);
    expect(d.movimientos[0]!.estado).toBe("sin_conciliar");
    expect(d.sugerencias[0]!.estado).toBe("rechazada");
  });

  it("aprobar falla (409) si el movimiento ya se concilió por otra vía mientras tanto", async () => {
    const { sesionId, factura, movimientoId } = await escenarioLlm();
    ctx.deps = conGateway(gatewayQueElige(0, 77));
    const sug = ((await (await post(admin(), `sesiones/${sesionId}/sugerencias-llm`)).json()) as { sugerencias: { id: string }[] }).sugerencias[0]!;
    const man = await post(admin(), `sesiones/${sesionId}/confirmar`, { pares: [{ movimientoId, invoiceId: factura.id, manual: true }] });
    expect(man.status).toBe(201);
    expect((await post(admin(), `sugerencias/${sug.id}/aprobar`)).status).toBe(409);
  });

  it("el modelo que responde 'ninguno' o un índice inventado NO genera sugerencia; el que falla da 502 y no guarda nada", async () => {
    const { sesionId } = await escenarioLlm();
    ctx.deps = conGateway(gatewayQueElige(null, 0, "no hay match"));
    const r = await post(admin(), `sesiones/${sesionId}/sugerencias-llm`);
    const b = (await r.json()) as { sugerencias: unknown[]; sinSugerencia: { razon: string }[] };
    expect(b.sugerencias).toHaveLength(0);
    expect(b.sinSugerencia).toHaveLength(1);
    ctx.deps = conGateway(gatewayQueElige(99, 90));
    expect(((await (await post(admin(), `sesiones/${sesionId}/sugerencias-llm`)).json()) as { sugerencias: unknown[] }).sugerencias).toHaveLength(0);
    const roto = { complete: async () => { throw new Error("proveedor caído"); } } as unknown as LlmGateway;
    ctx.deps = conGateway(roto);
    const f = await post(admin(), `sesiones/${sesionId}/sugerencias-llm`);
    expect(f.status).toBe(502);
    expect(await f.text()).not.toContain("proveedor caído");
    expect((await detalle(sesionId)).sugerencias).toHaveLength(0);
  });

  it("el LLM solo ve lo que el motor determinístico NO concilió (no gasta tokens en lo ya propuesto)", async () => {
    await cfdi(1160, "2026-01-05", FOLIO_A);
    await movimiento("2026-01-05", 1160, "SPEI RECIBIDO CLIENTE ACME SA DE CV");
    const sesionId = await crearSesion();
    const gw = gatewayQueElige(0, 90);
    ctx.deps = conGateway(gw);
    const r = await post(admin(), `sesiones/${sesionId}/sugerencias-llm`);
    expect(r.status).toBe(201);
    expect(gw.llamadas).toHaveLength(0);
  });

  it("sesión inexistente 404, cerrada 409 y readonly 403 incluso sin gateway", async () => {
    ctx.deps = conGateway(gatewayQueElige(0, 80));
    expect((await post(admin(), `sesiones/${randomUUID()}/sugerencias-llm`)).status).toBe(404);
    const { sesionId } = await escenarioLlm();
    await post(admin(), `sesiones/${sesionId}/cerrar`);
    expect((await post(admin(), `sesiones/${sesionId}/sugerencias-llm`)).status).toBe(409);
    ctx.deps = { ...ctx.deps, llmGateway: undefined };
    expect((await post(ctx.staff.readonly.token, `sesiones/${sesionId}/sugerencias-llm`)).status).toBe(403);
  });

  it("aprobar/rechazar una sugerencia inexistente: 404; con id mal formado: 400", async () => {
    expect((await post(admin(), `sugerencias/${randomUUID()}/aprobar`)).status).toBe(404);
    expect((await post(admin(), `sugerencias/no-uuid/rechazar`)).status).toBe(400);
  });
});

describe("base sin migrar (migración 021 pendiente): vacío honesto y 503, nunca 500", () => {
  it("lista -> disponible:false con vacío; detalle y escrituras -> 503", async () => {
    await movimiento("2026-01-05", 10, "x");
    ctx.conciliacionRepo.disponible = false;
    const lista = await get(admin(), "sesiones");
    expect(lista.status).toBe(200);
    expect(await lista.json()).toEqual({ disponible: false, sesiones: [] });
    expect((await post(admin(), "sesiones", { periodo: "2026-01" })).status).toBe(503);
    expect((await get(admin(), `sesiones/${randomUUID()}`)).status).toBe(503);
    expect((await post(admin(), `matches/${randomUUID()}/deshacer`, { motivo: "motivo valido" })).status).toBe(503);
    expect((await post(admin(), `sugerencias/${randomUUID()}/aprobar`)).status).toBe(503);
  });
});

/** Sesión falsa que modela la semántica REAL de SAVEPOINT en UN solo cliente pg (cola FIFO): RELEASE destruye también los savepoints creados después,
 *  y RELEASE / ROLLBACK TO de uno inexistente lanza 3B001 y deja la transacción abortada (25P02 hasta un ROLLBACK TO válido). */
class SavepointModelSession implements TenantDbSession {
  readonly stack: string[] = [];
  aborted = false;
  readonly errores: string[] = [];
  constructor(private readonly respuestas: readonly { match: RegExp; rows: unknown[] }[]) {}
  private fallar(code: string, msg: string): never {
    this.aborted = true;
    this.errores.push(code);
    throw Object.assign(new Error(msg), { code });
  }
  async exec(sql: string): Promise<void> {
    await Promise.resolve();
    const s = sql.trim().toLowerCase();
    const sp = /^(?:savepoint|release savepoint|rollback to savepoint) (\S+)$/.exec(s);
    if (!sp) return;
    const nombre = sp[1]!;
    if (s.startsWith("savepoint")) {
      if (this.aborted) this.fallar("25P02", "current transaction is aborted");
      this.stack.push(nombre);
      return;
    }
    const i = this.stack.lastIndexOf(nombre);
    if (i < 0) this.fallar("3B001", `savepoint "${nombre}" does not exist`);
    if (s.startsWith("release")) {
      if (this.aborted) this.fallar("25P02", "current transaction is aborted");
      this.stack.length = i;
    } else {
      this.stack.length = i + 1;
      this.aborted = false;
    }
  }
  async query<T>(sql: string): Promise<{ rows: T[] }> {
    await Promise.resolve();
    if (this.aborted) this.fallar("25P02", "current transaction is aborted");
    const r = this.respuestas.find((x) => x.match.test(sql));
    if (!r) this.fallar("XX000", `sin respuesta para: ${sql.slice(0, 60)}`);
    return { rows: r.rows as T[] };
  }
}

describe("adaptador Postgres sobre UNA transaccion compartida (SAVEPOINT/RELEASE reales)", () => {
  it("el detalle de la sesion lee en secuencia: sin 3B001, sin transaccion abortada y con la base ya migrada", async () => {
    const sesionId = randomUUID();
    const session = new SavepointModelSession([
      { match: /from despachos\.conciliacion_sesion where property_id/i, rows: [{ id: sesionId, property_id: ctx.propertyId, periodo: "2026-01", cuenta: null, estado: "abierta", creada_por: null, creada_en: new Date().toISOString(), cerrada_en: null }] },
      { match: /select propuestas from despachos\.conciliacion_sesion/i, rows: [] },
      { match: /from despachos\.invoice where/i, rows: [] },
      { match: /from despachos\.estado_cuenta_movimiento/i, rows: [] },
      { match: /from despachos\.conciliacion_match/i, rows: [] },
      { match: /from despachos\.conciliacion_sugerencia/i, rows: [] },
      { match: /from despachos\.invoice_conciliacion/i, rows: [] },
    ]);
    const a = buildApp({ ...ctx.deps, conciliacionRepo: () => new PostgresConciliacionPersistidaRepository(session) });
    const r = await a.request(`/despachos/${ctx.propertyId}/conciliacion/sesiones/${sesionId}`, authedJson(admin()));
    expect(session.errores).toEqual([]);
    expect(r.status).toBe(200);
    expect(session.stack).toEqual([]);
  });
});
