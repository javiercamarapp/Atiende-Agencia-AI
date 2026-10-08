// D-P3-10/11/12 -- conciliación por HTTP: propuestas guardadas (el GET no recalcula) y POST recalcular, ventana de facturas, ambiguo / sin conciliar, dirección y CFDI cancelado,
// tope por CFDI, revisión de direcciones indeterminadas y piloto automático al guardar un estado de cuenta (bandera apagada por omisión; nunca confirma nivel 2, grupos ni IA).
// Mismo patrón que despachos-conciliacion-persistida.spec.ts: dobles en memoria con auth/RLS/roles reales.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmGateway } from "@atiende/agent-core";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PLAZO_FASE_IA_PILOTO_MS } from "../src/routes/verticals/despachos/conciliacion-piloto.ts";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
let ctx: Mutable<DespachosTestContext>;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

let folio = 0;
type Direccion = "emitido" | "recibido" | "indeterminado" | null;
async function cfdi(total: number, fecha: string, opciones: { direccion?: Direccion; emisor?: string } = {}) {
  folio += 1;
  const centavos = Math.round(total * 100);
  return ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    folioFiscal: `${String(folio).padStart(8, "0")}-bbbb-cccc-dddd-eeeeeeeeeeee`,
    tipo: "I",
    rfcEmisor: "AAA010101AAA",
    rfcReceptor: "CLI010101CL1",
    emisorNombre: opciones.emisor ?? "CLIENTE ACME SA DE CV",
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
    direccion: opciones.direccion === undefined ? "emitido" : opciones.direccion,
    totalCentavos: centavos,
  });
}

let renglon = 0;
async function movimiento(fecha: string, monto: number, descripcion = "SPEI RECIBIDO CLIENTE ACME SA DE CV", cuenta = "012180001234567897") {
  renglon += 1;
  await ctx.despachosRepo.insertEstadoCuentaMovimientos({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    loteId: randomUUID(),
    movimientos: [{ hash: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), cuenta, banco: "bbva", formato: "csv", fecha, descripcion, referencia: null, cargo: monto < 0 ? -monto : null, abono: monto > 0 ? monto : null, monto, saldo: null, renglon }],
  });
}

const app = () => buildApp(ctx.deps);
const post = (token: string, path: string, body: unknown = {}) => app().request(`/despachos/${ctx.propertyId}/conciliacion/${path}`, authedJson(token, body));
const get = (token: string, path: string) => app().request(`/despachos/${ctx.propertyId}/conciliacion/${path}`, authedJson(token));
const put = (token: string, path: string, body: unknown) => app().request(`/despachos/${ctx.propertyId}/conciliacion/${path}`, { ...authedJson(token, body), method: "PUT" });
const admin = () => ctx.staff.admin.token;

interface Detalle {
  sesion: { id: string; estado: string };
  movimientos: { id: string; estado: string; monto: number }[];
  cfdis: { id: string; cancelado: boolean; direccion: string | null; fecha: string }[];
  ventana: { desde: string; hasta: string; dias: number };
  propuestas: { movimientoId: string; invoiceId: string; nivel: number; requiereRevision: boolean }[];
  ambiguas: { movimientoId: string; combinaciones: string[][]; exactas: boolean }[];
  multiLinea: { movimientoId: string; invoiceIds: string[] }[];
  sinConciliar: { movimientoId: string; motivo: string; cercanos: { invoiceId: string; diferenciaCentavos: number }[] }[];
  propuestasEn: string | null;
  propuestasFuente: "guardadas" | "calculadas" | "ninguna";
  matches: { id: string; movimientoId: string; invoiceId: string; origen: string; nivel: number | null; deshechoEn: string | null }[];
}
async function detalle(id: string, token = admin()): Promise<Detalle> {
  const r = await get(token, `sesiones/${id}`);
  expect(r.status).toBe(200);
  return (await r.json()) as Detalle;
}
async function crearSesion(periodo = "2026-01"): Promise<string> {
  const r = await post(admin(), "sesiones", { periodo });
  expect(r.status).toBe(201);
  return ((await r.json()) as { sesion: { id: string } }).sesion.id;
}
const par = (movimientoId: string, invoiceId: string, extra: Record<string, unknown> = {}) => ({ movimientoId, invoiceId, manual: false, ...extra });
const confirmar = (sesionId: string, pares: unknown[]) => post(admin(), `sesiones/${sesionId}/confirmar`, { pares });

describe("D-P3-10: propuestas guardadas en la sesión (el GET no recorre el motor)", () => {
  it("crear guarda las propuestas; un CFDI que llega después NO aparece en el GET hasta POST recalcular", async () => {
    await cfdi(1160, "2026-01-05");
    await movimiento("2026-01-05", 1160);
    await movimiento("2026-01-09", 500, "SPEI RECIBIDO OTRO");
    const sesionId = await crearSesion();
    const antes = await detalle(sesionId);
    expect(antes.propuestasFuente).toBe("guardadas");
    expect(antes.propuestasEn).not.toBeNull();
    expect(antes.propuestas).toHaveLength(1);

    await cfdi(500, "2026-01-09", { emisor: "OTRO" }); // llega DESPUÉS de calcular
    const sinRecalcular = await detalle(sesionId);
    expect(sinRecalcular.propuestas).toHaveLength(1); // el GET lee lo guardado, no vuelve a correr el motor

    const r = await post(admin(), `sesiones/${sesionId}/recalcular`);
    expect(r.status).toBe(200);
    const recalculado = (await r.json()) as Detalle & { guardado: boolean };
    expect(recalculado.guardado).toBe(true);
    expect(recalculado.propuestas).toHaveLength(2);
    expect((await detalle(sesionId)).propuestas).toHaveLength(2);
  });

  it("lo guardado se descarta si dejó de estar libre (ya conciliado) sin volver a correr el motor", async () => {
    await cfdi(1160, "2026-01-05");
    await movimiento("2026-01-05", 1160);
    const sesionId = await crearSesion();
    const d = await detalle(sesionId);
    const p = d.propuestas[0]!;
    expect((await confirmar(sesionId, [par(p.movimientoId, p.invoiceId)])).status).toBe(201);
    const despues = await detalle(sesionId);
    expect(despues.propuestas).toHaveLength(0);
    expect(despues.movimientos[0]!.estado).toBe("conciliado");
  });

  it("recalcular: solo roles de escritura (403 readonly), sesión cerrada 409, inexistente 404", async () => {
    await movimiento("2026-01-05", 10, "x");
    const sesionId = await crearSesion();
    expect((await post(ctx.staff.readonly.token, `sesiones/${sesionId}/recalcular`)).status).toBe(403);
    expect((await post(admin(), `sesiones/${randomUUID()}/recalcular`)).status).toBe(404);
    await post(admin(), `sesiones/${sesionId}/cerrar`);
    expect((await post(admin(), `sesiones/${sesionId}/recalcular`)).status).toBe(409);
  });

  it("base sin la migración 025: la sesión se crea, el GET calcula al vuelo (como antes) y recalcular responde guardado:false; nunca 500", async () => {
    await cfdi(1160, "2026-01-05");
    await movimiento("2026-01-05", 1160);
    ctx.conciliacionRepo.sin025 = true;
    const r = await post(admin(), "sesiones", { periodo: "2026-01" });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { propuestasGuardadas: boolean }).propuestasGuardadas).toBe(false);
    const sesionId = ((await (await post(admin(), "sesiones", { periodo: "2026-01" })).json()) as { sesion: { id: string } }).sesion.id;
    const d = await detalle(sesionId);
    expect(d.propuestasFuente).toBe("calculadas");
    expect(d.propuestas).toHaveLength(1);
    const rec = await post(admin(), `sesiones/${sesionId}/recalcular`);
    expect(rec.status).toBe(200);
    expect(((await rec.json()) as { guardado: boolean }).guardado).toBe(false);
  });

  it("los CFDI se cargan por la ventana del periodo (+-35 días): uno de otro año no se carga", async () => {
    await cfdi(1160, "2026-01-05");
    await cfdi(1160, "2025-03-01"); // fuera de la ventana
    await cfdi(80, "2025-12-20"); // dentro (12 días antes del 1 de enero)
    await movimiento("2026-01-05", 1160);
    const d = await detalle(await crearSesion());
    expect(d.ventana).toEqual({ desde: "2025-11-27", hasta: "2026-03-07", dias: 35 });
    expect(d.cfdis.map((c) => c.fecha).sort()).toEqual(["2025-12-20", "2026-01-05"]);
  });
});

describe("D-P3-10: CFDI fuera de la ventana", () => {
  it("el botón de IA (nivel 4) ve crédito a 60 días y el detalle etiqueta el CFDI que una sugerencia referencia aunque caiga fuera de la ventana del motor", async () => {
    const fuera = await cfdi(1160, "2025-11-01", { emisor: "CLIENTE ACME SA DE CV" }); // 65 días antes del periodo: fuera de +-35
    await movimiento("2026-01-05", 1000, "PAGO FACTURA CLIENTE ACME");
    ctx.deps = conEmisiones([], gatewayQueElige(0, 80));
    const sesionId = await crearSesion();
    const antes = await detalle(sesionId);
    expect(antes.cfdis.map((c) => c.id)).not.toContain(fuera.id); // sin referencias, el detalle sigue acotado a la ventana
    const r = await post(admin(), `sesiones/${sesionId}/sugerencias-llm`);
    expect(r.status).toBe(201);
    const d = (await detalle(sesionId)) as Detalle & { sugerencias: { estado: string; invoiceId: string }[] };
    expect(d.sugerencias).toHaveLength(1);
    expect(d.sugerencias[0]).toMatchObject({ estado: "pendiente", invoiceId: fuera.id });
    expect(d.cfdis.map((c) => c.id)).toContain(fuera.id);
  });
});

describe("D-P3-10: ambiguo y sin conciliar", () => {
  it("2 combinaciones exactas -> el movimiento queda 'ambiguo' con sus combinaciones y NO se propone ninguna", async () => {
    const [a, b, c, d] = [await cfdi(100, "2026-01-05"), await cfdi(200, "2026-01-05"), await cfdi(150, "2026-01-05"), await cfdi(150, "2026-01-05")];
    await movimiento("2026-01-05", 300, "DEPOSITO VARIOS");
    const det = await detalle(await crearSesion());
    expect(det.propuestas).toHaveLength(0);
    expect(det.movimientos[0]!.estado).toBe("ambiguo");
    expect(det.ambiguas).toHaveLength(1);
    expect(det.ambiguas[0]!.exactas).toBe(true);
    expect(det.ambiguas[0]!.combinaciones.map((x) => [...x].sort())).toEqual(expect.arrayContaining([[a.id, b.id].sort(), [c.id, d.id].sort()]));
    expect(det.sinConciliar[0]).toMatchObject({ motivo: "ambiguo" });
  });

  it("un ambiguo al que solo le queda UNA combinación vigente no desaparece: el GET recalcula al vuelo y lo muestra como multi-línea (no como 'sin conciliar' sin motivo)", async () => {
    const [a, b, c] = [await cfdi(100, "2026-01-05"), await cfdi(200, "2026-01-05"), await cfdi(150, "2026-01-05")];
    await cfdi(150, "2026-01-05");
    await movimiento("2026-01-05", 300, "DEPOSITO VARIOS");
    await movimiento("2026-01-06", 150, "PAGO CLIENTE UNO");
    const sesionId = await crearSesion();
    const antes = await detalle(sesionId);
    const mov300 = antes.movimientos.find((m) => m.monto === 300)!;
    const mov150 = antes.movimientos.find((m) => m.monto === 150)!;
    expect(antes.ambiguas.map((x) => x.movimientoId)).toContain(mov300.id);
    expect((await confirmar(sesionId, [par(mov150.id, c.id, { manual: true })])).status).toBe(201); // c queda conciliado: al ambiguo le queda [a, b]
    const despues = await detalle(sesionId);
    expect(despues.ambiguas.map((x) => x.movimientoId)).not.toContain(mov300.id);
    expect(despues.propuestasFuente).toBe("calculadas");
    const m = despues.multiLinea.find((x) => x.movimientoId === mov300.id);
    expect(m && [...m.invoiceIds].sort()).toEqual([a.id, b.id].sort());
  });

  it("sin combinación -> sin_conciliar con el motivo y los CFDI individuales más cercanos", async () => {
    for (const t of [150, 160, 170]) await cfdi(t, "2026-01-05");
    await movimiento("2026-01-05", 4000, "DEPOSITO RARO");
    const det = await detalle(await crearSesion());
    expect(det.movimientos[0]!.estado).toBe("sin_conciliar");
    expect(det.sinConciliar[0]).toMatchObject({ motivo: "sin_combinacion" });
    expect(det.sinConciliar[0]!.cercanos).toHaveLength(3);
    expect(det.sinConciliar[0]!.cercanos[0]!.diferenciaCentavos).toBeLessThanOrEqual(det.sinConciliar[0]!.cercanos[2]!.diferenciaCentavos);
  });
});

describe("D-P3-11: dirección, CFDI cancelado y tope por CFDI", () => {
  it("un abono NO se propone contra un CFDI recibido, y confirmarlo como manual responde 409 (signo)", async () => {
    const recibido = await cfdi(1000, "2026-01-05", { direccion: "recibido" });
    await movimiento("2026-01-05", 1000);
    const sesionId = await crearSesion();
    const det = await detalle(sesionId);
    expect(det.propuestas).toHaveLength(0);
    const r = await confirmar(sesionId, [par(det.movimientos[0]!.id, recibido.id, { manual: true })]);
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("signo");
  });

  it("un cargo se propone contra un CFDI recibido (cobro/pago correcto)", async () => {
    await cfdi(1000, "2026-01-05", { direccion: "recibido" });
    await movimiento("2026-01-05", -1000, "PAGO PROVEEDOR CLIENTE ACME SA DE CV");
    expect((await detalle(await crearSesion())).propuestas).toHaveLength(1);
  });

  it("un CFDI cancelado no se propone ni se confirma (409)", async () => {
    const c = await cfdi(1000, "2026-01-05");
    await ctx.despachosRepo.registrarEstadoSatInvoice(ctx.propertyId, c.id, "cancelado");
    await movimiento("2026-01-05", 1000);
    const sesionId = await crearSesion();
    const det = await detalle(sesionId);
    expect(det.propuestas).toHaveLength(0);
    expect(det.cfdis.find((x) => x.id === c.id)?.cancelado).toBe(true);
    const r = await confirmar(sesionId, [par(det.movimientos[0]!.id, c.id, { manual: true })]);
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("cancelado");
  });

  it("un mismo CFDI no se concilia dos veces por el total (409); deshacer libera el cupo", async () => {
    const c = await cfdi(1000, "2026-01-05");
    await movimiento("2026-01-05", 1000);
    await movimiento("2026-01-06", 1000, "SPEI RECIBIDO OTRO DEPOSITO");
    const sesionId = await crearSesion();
    const det = await detalle(sesionId);
    const [m1, m2] = det.movimientos;
    const primera = await confirmar(sesionId, [par(m1!.id, c.id, { manual: true })]);
    expect(primera.status).toBe(201);
    const segunda = await confirmar(sesionId, [par(m2!.id, c.id, { manual: true })]);
    expect(segunda.status).toBe(409);
    expect(await segunda.text()).toContain("superaría");
    const matchId = ((await primera.json()) as { matches: { id: string }[] }).matches[0]!.id;
    expect((await post(admin(), `matches/${matchId}/deshacer`, { motivo: "motivo valido" })).status).toBe(200);
    expect((await confirmar(sesionId, [par(m2!.id, c.id, { manual: true })])).status).toBe(201);
  });

  it("pagos parciales que suman el total sí se permiten", async () => {
    const c = await cfdi(1000, "2026-01-05");
    await movimiento("2026-01-05", 400, "ABONO PARCIAL 1");
    await movimiento("2026-01-06", 600, "ABONO PARCIAL 2");
    const sesionId = await crearSesion();
    const [m1, m2] = (await detalle(sesionId)).movimientos;
    expect((await confirmar(sesionId, [par(m1!.id, c.id, { manual: true }), par(m2!.id, c.id, { manual: true })])).status).toBe(201);
  });

  it("dirección indeterminada: se propone con requiereRevision y solo se confirma con `revisado: true`", async () => {
    const c = await cfdi(1000, "2026-01-05", { direccion: "indeterminado" });
    await movimiento("2026-01-05", 1000);
    const sesionId = await crearSesion();
    const det = await detalle(sesionId);
    expect(det.propuestas[0]).toMatchObject({ invoiceId: c.id, requiereRevision: true });
    const sin = await confirmar(sesionId, [par(det.movimientos[0]!.id, c.id)]);
    expect(sin.status).toBe(409);
    expect(await sin.text()).toContain("revis");
    expect((await confirmar(sesionId, [par(det.movimientos[0]!.id, c.id, { revisado: true })])).status).toBe(201);
    expect((await confirmar(sesionId, [par(det.movimientos[0]!.id, c.id, { revisado: "si" })])).status).toBe(400);
  });
});

/** Envuelve el engine para capturar las llamadas a `core.emit_notification` (la sesión en memoria no la implementa) y opcionalmente fija el gateway de IA. */
function conEmisiones(emisiones: unknown[][], gateway?: LlmGateway): AppDeps {
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
  return { ...ctx.deps, engine, ...(gateway ? { llmGateway: gateway } : {}) };
}

function gatewayQueElige(candidato: number, confianza: number): LlmGateway {
  return {
    complete: async () => ({
      text: "",
      toolCalls: [{ id: "t1", name: "proponer_match_conciliacion", argumentsJson: JSON.stringify({ candidato_elegido: candidato, confianza, razonamiento: "Mismo cliente, importe cercano" }) }],
      model: "modelo-de-prueba",
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0,
      providerId: "fake",
      fallbackUsed: false,
      attempts: [],
    }),
  } as unknown as LlmGateway;
}

const CSV = (renglones: string[]) => ["BBVA México - Estado de cuenta (sintetico)", "Fecha Operación;Fecha Valor;Concepto;Cargo;Abono;Saldo", ...renglones].join("\n");
const guardar = (token: string, contenido: string) => app().request(`/despachos/${ctx.propertyId}/conciliacion/importar-estado-de-cuenta/guardar`, authedJson(token, { contenido, formato: "csv", banco: "bbva", cuenta: "012180001234567897" }));
interface RespuestaGuardar {
  insertados: number;
  conciliacion: { estado: string; autoconfirmarNivel1: boolean; sesiones: { sesionId: string; periodo: string; creada: boolean; propuestas: number; ambiguas: number; autoconfirmados: number; sugerenciasIA: number }[] } | null;
}

describe("D-P3-12: piloto automático al guardar un estado de cuenta", () => {
  const unico = CSV(["05/01/2026;05/01/2026;SPEI RECIBIDO CLIENTE ACME SA DE CV;;1,160.00;51,160.00"]);

  it("la bandera nace APAGADA: crea la sesión y guarda propuestas pero NO confirma nada; avisa con la campana", async () => {
    await cfdi(1160, "2026-01-05");
    const emisiones: unknown[][] = [];
    ctx.deps = conEmisiones(emisiones);
    const cfg = (await (await get(admin(), "configuracion")).json()) as { autoconfirmarNivel1: boolean };
    expect(cfg.autoconfirmarNivel1).toBe(false);
    const r = await guardar(admin(), unico);
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as RespuestaGuardar;
    expect(cuerpo.conciliacion).toMatchObject({ estado: "ok", autoconfirmarNivel1: false });
    expect(cuerpo.conciliacion!.sesiones).toHaveLength(1);
    expect(cuerpo.conciliacion!.sesiones[0]).toMatchObject({ periodo: "2026-01", creada: true, propuestas: 1, autoconfirmados: 0 });
    const det = await detalle(cuerpo.conciliacion!.sesiones[0]!.sesionId);
    expect(det.matches).toHaveLength(0);
    expect(det.propuestas).toHaveLength(1);
    expect(det.propuestasFuente).toBe("guardadas");
    // campana in-app: tipo/clave de dedupe por sesión/enlace a la pantalla, solo la cantidad (sin PII)
    expect(emisiones).toHaveLength(1);
    const emitido = JSON.stringify(emisiones[0]);
    expect(emitido).toContain("despachos.conciliacion.propuestas_por_revisar");
    expect(emitido).toContain(`despachos.conciliacion.propuestas_por_revisar:${det.sesion.id}`);
    expect(emitido).toContain("/despachos/{orgSlug}/conciliacion");
    expect(emitido).toContain("Propuestas del motor por confirmar (o con varias combinaciones posibles): 1.");
    expect(emitido).not.toContain("ACME");
  });

  it("es idempotente: subir el mismo archivo otra vez no crea otra sesión ni repite nada", async () => {
    await cfdi(1160, "2026-01-05");
    await guardar(admin(), unico);
    const segunda = (await (await guardar(admin(), unico)).json()) as RespuestaGuardar;
    expect(segunda.insertados).toBe(0);
    expect(segunda.conciliacion).toBeNull();
    const lista = (await (await get(admin(), "sesiones")).json()) as { sesiones: unknown[] };
    expect(lista.sesiones).toHaveLength(1);
  });

  it("con la bandera encendida confirma el nivel 1 ÚNICO con origen autopiloto y deja bitácora con actor sistema; se puede deshacer con motivo", async () => {
    const c = await cfdi(1160, "2026-01-05");
    const sink = ctx.auditSink;
    expect((await put(admin(), "configuracion", { autoconfirmarNivel1: true })).status).toBe(200);
    const cuerpo = (await (await guardar(admin(), unico)).json()) as RespuestaGuardar;
    expect(cuerpo.conciliacion).toMatchObject({ estado: "ok", autoconfirmarNivel1: true });
    expect(cuerpo.conciliacion!.sesiones[0]).toMatchObject({ autoconfirmados: 1, propuestas: 0 });
    const det = await detalle(cuerpo.conciliacion!.sesiones[0]!.sesionId);
    expect(det.matches).toHaveLength(1);
    expect(det.matches[0]).toMatchObject({ invoiceId: c.id, origen: "autopiloto", nivel: 1, deshechoEn: null });
    const entrada = sink.entries.find((e) => e.action === "despachos.conciliacion:autopiloto-confirmar");
    expect(entrada).toMatchObject({ actorUserId: null, actorEmail: "sistema", metadata: expect.objectContaining({ actor: "sistema", pares: 1 }) });
    expect(JSON.stringify(entrada!.metadata)).not.toContain("ACME");
    const des = await post(admin(), `matches/${det.matches[0]!.id}/deshacer`, { motivo: "revision humana" });
    expect(des.status).toBe(200);
    expect((await detalle(det.sesion.id)).movimientos[0]!.estado).toBe("sin_conciliar");
  });

  it("NUNCA autoconfirma: nivel 2, ambiguos, dirección indeterminada ni grupos (con la bandera encendida)", async () => {
    await put(admin(), "configuracion", { autoconfirmarNivel1: true });
    await cfdi(1000, "2026-01-05", { direccion: "indeterminado" }); // indeterminado
    await cfdi(2000, "2026-01-06"); // dos CFDI iguales para un movimiento -> ambiguo
    await cfdi(2000, "2026-01-06");
    await cfdi(3010, "2026-01-07", { emisor: "CLIENTE ACME SA DE CV" }); // nivel 2 (monto cercano, no igual)
    for (const t of [100, 200, 300]) await cfdi(t, "2026-01-08"); // grupo (multi-línea): 600 = 100+200+300
    const cuerpo = (await (
      await guardar(
        admin(),
        CSV([
          "05/01/2026;05/01/2026;SPEI RECIBIDO CLIENTE ACME SA DE CV;;1,000.00;1.00",
          "06/01/2026;06/01/2026;SPEI RECIBIDO CLIENTE ACME SA DE CV;;2,000.00;1.00",
          "07/01/2026;07/01/2026;SPEI RECIBIDO CLIENTE ACME SA DE CV;;3,000.00;1.00",
          "08/01/2026;08/01/2026;DEPOSITO VARIOS;;600.00;1.00",
        ]),
      )
    ).json()) as RespuestaGuardar;
    expect(cuerpo.conciliacion!.sesiones[0]!.autoconfirmados).toBe(0);
    const det = await detalle(cuerpo.conciliacion!.sesiones[0]!.sesionId);
    expect(det.matches).toHaveLength(0);
  });

  it("no confirma si el CFDI tiene OTRO candidato para el mismo movimiento (único = sin alternativa)", async () => {
    await put(admin(), "configuracion", { autoconfirmarNivel1: true });
    await cfdi(1160, "2026-01-05");
    await cfdi(1160, "2026-01-05");
    const cuerpo = (await (await guardar(admin(), unico)).json()) as RespuestaGuardar;
    expect(cuerpo.conciliacion!.sesiones[0]!.autoconfirmados).toBe(0);
  });

  it("las sugerencias de IA nunca se autoconfirman: con gateway quedan PENDIENTES y se avisan; sin gateway no se hace nada y no falla", async () => {
    await put(admin(), "configuracion", { autoconfirmarNivel1: true });
    await cfdi(1160, "2026-01-05");
    const csv = CSV(["20/01/2026;20/01/2026;PAGO FACTURA CLIENTE ACME;;1,000.00;1.00"]); // monto distinto: el motor no lo concilia, el modelo lo sugiere
    const sin = (await (await guardar(admin(), csv)).json()) as RespuestaGuardar; // sin gateway
    expect(sin.conciliacion).toMatchObject({ estado: "ok" });
    expect(sin.conciliacion!.sesiones[0]).toMatchObject({ sugerenciasIA: 0, autoconfirmados: 0 });
  });

  it("con gateway: la sugerencia de IA queda PENDIENTE (nunca un match), emite el aviso de sugerencias y un fallo del proveedor no rompe el archivo", async () => {
    await put(admin(), "configuracion", { autoconfirmarNivel1: true });
    await cfdi(1160, "2026-01-05");
    const emisiones: unknown[][] = [];
    ctx.deps = conEmisiones(emisiones, gatewayQueElige(0, 82));
    const cuerpo = (await (await guardar(admin(), CSV(["20/01/2026;20/01/2026;PAGO FACTURA CLIENTE ACME;;1,000.00;1.00"]))).json()) as RespuestaGuardar;
    expect(cuerpo.conciliacion!.sesiones[0]).toMatchObject({ sugerenciasIA: 1, autoconfirmados: 0 });
    const det = (await (await get(admin(), `sesiones/${cuerpo.conciliacion!.sesiones[0]!.sesionId}`)).json()) as Detalle & { sugerencias: { estado: string; confianza: number }[] };
    expect(det.matches).toHaveLength(0);
    expect(det.sugerencias).toHaveLength(1);
    expect(det.sugerencias[0]).toMatchObject({ estado: "pendiente", confianza: 82 });
    expect(JSON.stringify(emisiones)).toContain("despachos.conciliacion.sugerencias_pendientes");

    const roto = { complete: async () => { throw new Error("proveedor caído"); } } as unknown as LlmGateway;
    ctx.deps = conEmisiones([], roto);
    const r = await guardar(admin(), CSV(["21/01/2026;21/01/2026;OTRO PAGO CLIENTE ACME;;1,001.00;1.00"]));
    expect(r.status).toBe(201);
    expect(((await r.json()) as RespuestaGuardar).insertados).toBe(1);
  });

  it("la fase de IA tiene UN plazo global y abortable: un proveedor colgado no retiene el guardado y solo se evalua la sesion mas reciente", async () => {
    await put(admin(), "configuracion", { autoconfirmarNivel1: true });
    await cfdi(1160, "2026-01-05");
    await cfdi(1160, "2026-02-05");
    let llamadas = 0;
    let senal: AbortSignal | undefined;
    const colgado = {
      complete: (peticion: { request: { signal?: AbortSignal } }) => {
        llamadas += 1;
        senal = peticion.request.signal;
        return new Promise(() => {}); // nunca responde
      },
    } as unknown as LlmGateway;
    ctx.deps = conEmisiones([], colgado);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pendiente = guardar(admin(), CSV(["20/01/2026;20/01/2026;PAGO ACME;;1,000.00;1.00", "20/02/2026;20/02/2026;PAGO ACME;;1,000.00;1.00"]));
      let terminado = false;
      void Promise.resolve(pendiente).finally(() => { terminado = true; });
      // El plazo se arma al llegar a la fase de IA (despues de las escrituras): se avanza el reloj falso por tramos hasta que responde.
      for (let i = 0; i < 200 && !terminado; i++) await vi.advanceTimersByTimeAsync(PLAZO_FASE_IA_PILOTO_MS / 4);
      const r = await pendiente;
      expect(r.status).toBe(201);
      const cuerpo = (await r.json()) as RespuestaGuardar;
      expect(cuerpo.insertados).toBe(2);
      expect(cuerpo.conciliacion!.sesiones.map((x) => x.sugerenciasIA)).toEqual([0, 0]);
    } finally {
      vi.useRealTimers();
    }
    expect(llamadas).toBe(1); // dos periodos, una sola llamada: solo la sesion mas reciente
    expect(senal?.aborted).toBe(true);
  });

  it("la bandera la cambia solo el admin (403 contador/readonly), la lee solo el admin (403 contador, auditor y solo lectura) y valida el cuerpo", async () => {
    expect((await put(ctx.staff.contador.token, "configuracion", { autoconfirmarNivel1: true })).status).toBe(403);
    expect((await put(ctx.staff.readonly.token, "configuracion", { autoconfirmarNivel1: true })).status).toBe(403);
    expect((await put(admin(), "configuracion", { autoconfirmarNivel1: "si" })).status).toBe(400);
    expect((await get(ctx.staff.readonly.token, "configuracion")).status).toBe(403);
    expect((await get(ctx.staff.auditor.token, "configuracion")).status).toBe(403);
    expect((await get(ctx.staff.contador.token, "configuracion")).status).toBe(403);
    expect((await put(admin(), "configuracion", { autoconfirmarNivel1: true })).status).toBe(200);
    expect(((await (await get(admin(), "configuracion")).json()) as { autoconfirmarNivel1: boolean }).autoconfirmarNivel1).toBe(true);
  });

  it("base sin la migración 025: el archivo se guarda igual (201) y la conciliación responde no_disponible; nunca 500", async () => {
    await cfdi(1160, "2026-01-05");
    ctx.conciliacionRepo.sin025 = true;
    const r = await guardar(admin(), unico);
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as RespuestaGuardar;
    expect(cuerpo.insertados).toBe(1);
    expect(cuerpo.conciliacion).toMatchObject({ estado: "no_disponible", sesiones: [] });
    expect((await get(admin(), "configuracion")).status).toBe(200);
    expect(((await (await get(admin(), "configuracion")).json()) as { autoconfirmarNivel1: boolean }).autoconfirmarNivel1).toBe(false);
    expect((await put(admin(), "configuracion", { autoconfirmarNivel1: true })).status).toBe(503);
  });

  it("base sin la migración 021: el archivo se guarda igual y la conciliación responde no_disponible", async () => {
    ctx.conciliacionRepo.disponible = false;
    const cuerpo = (await (await guardar(admin(), unico)).json()) as RespuestaGuardar;
    expect(cuerpo.insertados).toBe(1);
    expect(cuerpo.conciliacion?.estado).toBe("no_disponible");
  });
});
