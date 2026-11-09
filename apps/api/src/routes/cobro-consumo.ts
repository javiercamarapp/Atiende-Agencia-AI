// Consumo, proyeccion, margen y cotizador del cobro medido (0104/0105 + restaurantes 204).
//
//   GET  /billing/consumo[?organizationId=&mes=YYYY-MM]          pantalla «Consumo y facturacion» (miembro o superadmin)
//   GET  /superadmin/cobro/organizaciones[?mes=]                  ingreso proyectado, costo y margen por organizacion
//   GET  /superadmin/cobro/costos-unitarios                      costos unitarios vigentes
//   PUT  /superadmin/cobro/costos-unitarios/:clave               (step-up) captura un costo unitario con su fuente
//   PUT  /superadmin/planes/:id/tabulador                        (step-up) tramos, bandas, margen minimo y alta por sucursal
//   POST /superadmin/cotizador/calcular                          costo, factura y margen de una propuesta (sin escribir)
//   POST /superadmin/cotizador/crear-plan                        (step-up) crea el plan a la medida + registra la cotizacion
//   GET  /superadmin/cotizaciones[?organizationId=]              cotizaciones registradas
//   GET  /superadmin/cotizaciones/:id/documento                  cotizacion imprimible (HTML; el navegador la guarda en PDF)
//
// Ningun precio ni costo vive aqui: tarifas y costos son datos de la base. El margen minimo sale del plan
// (`margen_minimo_pct`) y, si no lo trae, del piso de negociacion por omision de abajo (decision del dueño, 7-nov-2026).
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { calcularFacturaPlanMedido, cotizar, margenPeorPunto, proyectarMes, TarifaInvalida, type ComisionTarjeta, type CostosUnitarios, type TarifaPlanMedido } from "@atiende/billing";
import { CLAVES_COSTO_UNITARIO } from "@atiende/db";
import type { BandaUsoRow, ClaveCostoUnitario, CostoUnitarioRow, TramoSucursalRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import { mesActualEn, parsearTarifa, serializarFactura, serializarTarifa } from "./cobro-planes.ts";
import type { AppDeps } from "../deps.ts";

/** Piso de negociacion por omision cuando el plan no declara su propio margen minimo. */
export const MARGEN_MINIMO_POR_OMISION_PCT = 55;
const NO_DISPONIBLE = "El consumo y el cotizador todavía no están disponibles en este despliegue (faltan las migraciones 0104/0105 y restaurantes 204).";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/u;
const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const MUTACION = { max: 30, windowMs: 5 * 60_000 } as const;

/** Costos de la base -> forma del cotizador. Un costo sin capturar es null: el margen NO se inventa. */
export function costosDesdeFilas(filas: readonly CostoUnitarioRow[]): { costos: CostosUnitarios | null; comision: ComisionTarjeta | null; faltan: ClaveCostoUnitario[] } {
  const v = (k: ClaveCostoUnitario) => filas.find((f) => f.clave === k)?.costoMxn;
  const faltan = (["minuto_voz", "conversacion_wa", "fijo_mensual_sucursal"] as const).filter((k) => v(k) === undefined);
  const costos = faltan.length > 0 ? null : { minutoVozMxn: v("minuto_voz")!, conversacionWaMxn: v("conversacion_wa")!, fijoMensualSucursalMxn: v("fijo_mensual_sucursal")!, numeroVozMensualSucursalMxn: v("numero_voz_mensual_sucursal") ?? 0, fijoMensualOrganizacionMxn: v("fijo_mensual_organizacion") ?? 0 };
  const pct = v("comision_tarjeta_pct");
  const fijo = v("comision_tarjeta_fijo_mxn");
  const comision = pct === undefined || fijo === undefined ? null : { porcentaje: pct / 100, fijoMxn: fijo, ivaSobreComisionPct: 0.16 };
  return { costos, comision, faltan: [...faltan] };
}

/** Fecha y fraccion del dia en la zona del negocio. */
export function hoyEn(zonaHoraria: string, ahora = new Date()): { dia: string; fraccion: number } {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: zonaHoraria, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ahora);
  const g = (t: string) => partes.find((p) => p.type === t)?.value ?? "00";
  return { dia: `${g("year")}-${g("month")}-${g("day")}`, fraccion: (Number(g("hour")) * 60 + Number(g("minute"))) / 1440 };
}

function porcentaje(usado: number, incluido: number): number | null {
  return incluido > 0 ? Math.round((usado / incluido) * 1000) / 10 : null;
}

function parseEntero(v: unknown, campo: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw Errors.validation(`${campo} debe ser un entero entre ${min} y ${max}.`);
  return v;
}

function parseCentavos(v: unknown, campo: string): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000_000) throw Errors.validation(`${campo} debe ser un monto en MXN >= 0 o null.`);
  const c = Math.round(v * 100);
  if (Math.abs(v * 100 - c) > 1e-6) throw Errors.validation(`${campo} admite como máximo 2 decimales.`);
  return c;
}

export function parsearTramos(raw: unknown): TramoSucursalRow[] {
  if (!Array.isArray(raw) || raw.length > 20) throw Errors.validation("tramos debe ser un arreglo de máximo 20.");
  return raw.map((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>;
    return {
      desde: parseEntero(o.desde, `tramos[${i}].desde`, 1, 100_000),
      hasta: o.hasta === null || o.hasta === undefined ? null : parseEntero(o.hasta, `tramos[${i}].hasta`, 1, 100_000),
      precioCentavos: parseCentavos(o.precioMxn ?? null, `tramos[${i}].precioMxn`),
      minutosVozIncluidosPorSucursal: o.minutosVozIncluidosPorSucursal === null || o.minutosVozIncluidosPorSucursal === undefined ? null : parseEntero(o.minutosVozIncluidosPorSucursal, `tramos[${i}].minutosVozIncluidosPorSucursal`, 0, 1_000_000),
      conversacionesWaIncluidasPorSucursal: o.conversacionesWaIncluidasPorSucursal === null || o.conversacionesWaIncluidasPorSucursal === undefined ? null : parseEntero(o.conversacionesWaIncluidasPorSucursal, `tramos[${i}].conversacionesWaIncluidasPorSucursal`, 0, 1_000_000),
    };
  });
}

export function parsearBandas(raw: unknown): Omit<BandaUsoRow, "metrica">[] {
  if (!Array.isArray(raw) || raw.length > 20) throw Errors.validation("bandas debe ser un arreglo de máximo 20.");
  return raw.map((b, i) => {
    const o = (b ?? {}) as Record<string, unknown>;
    if (typeof o.costoUnitarioMxn !== "number" || !Number.isFinite(o.costoUnitarioMxn) || o.costoUnitarioMxn < 0) throw Errors.validation(`bandas[${i}].costoUnitarioMxn debe ser >= 0.`);
    return {
      desde: parseEntero(o.desde, `bandas[${i}].desde`, 0, 100_000_000),
      hasta: o.hasta === null || o.hasta === undefined ? null : parseEntero(o.hasta, `bandas[${i}].hasta`, 1, 100_000_000),
      precioCentavos: parseCentavos(o.precioMxn ?? null, `bandas[${i}].precioMxn`),
      costoUnitarioMxn: o.costoUnitarioMxn,
    };
  });
}

/** Supuestos de uso de la cotizacion: llamadas x minutos por llamada, conversaciones y sucursales. */
export function parsearSupuestos(raw: unknown): { sucursales: number; llamadasMes: number; minutosPorLlamada: number; conversacionesWa: number } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mpl = o.minutosPorLlamada;
  if (typeof mpl !== "number" || !Number.isFinite(mpl) || mpl < 0 || mpl > 60) throw Errors.validation("supuestos.minutosPorLlamada debe estar entre 0 y 60.");
  return {
    sucursales: parseEntero(o.sucursales, "supuestos.sucursales", 1, 10_000),
    llamadasMes: parseEntero(o.llamadasMes, "supuestos.llamadasMes", 0, 10_000_000),
    minutosPorLlamada: mpl,
    conversacionesWa: parseEntero(o.conversacionesWa, "supuestos.conversacionesWa", 0, 10_000_000),
  };
}

/** Tarifa propuesta (cuerpo del cotizador) sobre una base vacia; reutiliza las validaciones de PUT /tarifa. */
export function tarifaPropuesta(raw: Record<string, unknown>, planId: string, nombre: string): TarifaPlanMedido {
  const { cuotaFijaMxn, tramos, bandasMinutos, bandasConversaciones, margenMinimoPct, cuotaAltaPorSucursalMxn, ...resto } = raw;
  const t = parsearTarifa({ modeloCobro: "medido", ...resto });
  const tr = tramos === undefined ? [] : parsearTramos(tramos);
  const bm = bandasMinutos === undefined ? [] : parsearBandas(bandasMinutos).map((b) => ({ ...b, metrica: "minuto_voz" as const }));
  const bc = bandasConversaciones === undefined ? [] : parsearBandas(bandasConversaciones).map((b) => ({ ...b, metrica: "conversacion_wa" as const }));
  if (margenMinimoPct !== undefined && margenMinimoPct !== null && (typeof margenMinimoPct !== "number" || margenMinimoPct < 0 || margenMinimoPct > 100)) throw Errors.validation("margenMinimoPct debe estar entre 0 y 100.");
  return {
    planId,
    nombre,
    modeloCobro: "medido",
    cuotaFijaCentavos: parseCentavos(cuotaFijaMxn ?? null, "cuotaFijaMxn"),
    precioSucursalCentavos: t.precioSucursalCentavos ?? null,
    sucursalesIncluidas: t.sucursalesIncluidas ?? 0,
    minutosVozIncluidos: t.minutosVozIncluidos ?? 0,
    minutosVozIncluidosPorSucursal: t.minutosVozIncluidosPorSucursal ?? 0,
    precioMinutoVozExcedenteCentavos: t.precioMinutoVozExcedenteCentavos ?? null,
    conversacionesWaIncluidas: t.conversacionesWaIncluidas ?? 0,
    conversacionesWaIncluidasPorSucursal: t.conversacionesWaIncluidasPorSucursal ?? 0,
    precioConversacionWaExcedenteCentavos: t.precioConversacionWaExcedenteCentavos ?? null,
    usoJustoPct: t.usoJustoPct === undefined ? 150 : t.usoJustoPct,
    cuotaAltaCentavos: t.cuotaAltaCentavos ?? null,
    cuotaAltaPorSucursalCentavos: parseCentavos(cuotaAltaPorSucursalMxn ?? null, "cuotaAltaPorSucursalMxn"),
    tasaIvaBp: t.tasaIvaBp ?? 1600,
    organizacionExclusivaId: null,
    tramosSucursal: tr,
    bandasUso: [...bm, ...bc],
    margenMinimoPct: (margenMinimoPct as number | null | undefined) ?? null,
  };
}

/** Evalua una propuesta: margen al uso esperado y en el PEOR punto (bolsa llena), contra el minimo. */
export function evaluarPropuesta(tarifa: TarifaPlanMedido, supuestos: ReturnType<typeof parsearSupuestos>, costos: CostosUnitarios, comision: ComisionTarjeta | null) {
  const uso = { sucursales: supuestos.sucursales, minutosVoz: Math.ceil(supuestos.llamadasMes * supuestos.minutosPorLlamada), conversacionesWa: supuestos.conversacionesWa };
  const esperado = cotizar(tarifa, uso, costos, comision ?? undefined);
  const peor = margenPeorPunto(tarifa, supuestos.sucursales, costos, comision ?? undefined);
  const minimo = tarifa.margenMinimoPct ?? MARGEN_MINIMO_POR_OMISION_PCT;
  const margenes = [esperado.margenPct, peor.margenPct].filter((m): m is number => m !== null);
  const margenControl = margenes.length > 0 ? Math.min(...margenes) : null;
  return {
    usoEsperado: uso,
    esperado: { factura: serializarFactura(esperado.factura), costoMxn: esperado.costoMxn, utilidadMxn: esperado.utilidadMxn, margenPct: esperado.margenPct, margenConTarjetaPct: esperado.margenConTarjetaPct },
    peorPunto: { factura: serializarFactura(peor.factura), costoMxn: peor.costoMxn, margenPct: peor.margenPct, margenConTarjetaPct: peor.margenConTarjetaPct },
    margenMinimoPct: minimo,
    margenControlPct: margenControl,
    bajoMinimo: margenControl === null || margenControl < minimo,
  };
}

function escapar(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const mxn = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

/** Documento imprimible de la cotizacion para el cliente (sin costos ni margenes: esos son internos). */
export function documentoCotizacion(c: { folio: number; creadoEn: string; detalle: Record<string, unknown> }, organizacion: string): string {
  const d = c.detalle as { tarifa?: ReturnType<typeof serializarTarifa>; evaluacion?: { usoEsperado?: { sucursales: number; minutosVoz: number; conversacionesWa: number }; esperado?: { factura?: ReturnType<typeof serializarFactura> } }; vigenciaDias?: number };
  const f = d.evaluacion?.esperado?.factura;
  const t = d.tarifa;
  const filas = (f?.renglones ?? []).map((r) => `<tr><td>${escapar(r.descripcion)}</td><td class="n">${r.cantidad.toLocaleString("es-MX")}</td><td class="n">${mxn(r.precioUnitarioMxn)}</td><td class="n">${mxn(r.importeMxn)}</td></tr>`).join("");
  const incluye = t
    ? [
        t.cuotaFijaMxn !== null ? `Cuota mensual: ${mxn(t.cuotaFijaMxn)}` : null,
        t.minutosVozIncluidos > 0 ? `${t.minutosVozIncluidos.toLocaleString("es-MX")} minutos de voz al mes` : null,
        t.minutosVozIncluidosPorSucursal > 0 ? `${t.minutosVozIncluidosPorSucursal.toLocaleString("es-MX")} minutos de voz por sucursal al mes (bolsa compartida)` : null,
        t.conversacionesWaIncluidas > 0 ? `${t.conversacionesWaIncluidas.toLocaleString("es-MX")} conversaciones de WhatsApp al mes` : null,
        t.conversacionesWaIncluidasPorSucursal > 0 ? `${t.conversacionesWaIncluidasPorSucursal.toLocaleString("es-MX")} conversaciones de WhatsApp por sucursal al mes` : null,
        t.precioMinutoVozExcedenteMxn !== null ? `Minuto adicional: ${mxn(t.precioMinutoVozExcedenteMxn)}` : null,
        t.precioConversacionWaExcedenteMxn !== null ? `Conversación adicional: ${mxn(t.precioConversacionWaExcedenteMxn)}` : null,
        t.usoJustoPct !== null ? `Uso justo: hasta ${t.usoJustoPct} % de lo incluido; arriba de eso se revisa el plan juntos (nunca se corta una llamada)` : null,
      ].filter((x): x is string => x !== null)
    : [];
  return `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><title>Cotización ${c.folio}</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:32px auto;color:#111;padding:0 16px}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin-top:12px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;font-size:14px}.n{text-align:right}.t{font-weight:600}small{color:#555}</style></head>
<body><h1>Cotización ${c.folio}: ${escapar(organizacion)}</h1><small>Fecha: ${escapar(c.creadoEn.slice(0, 10))}. Precios en pesos mexicanos; el IVA (16 %) se desglosa aparte.${d.vigenciaDias ? ` Vigencia: ${d.vigenciaDias} días.` : ""}</small>
<h2>Qué incluye</h2><ul>${incluye.map((x) => `<li>${escapar(x)}</li>`).join("")}</ul>
<h2>Factura mensual estimada con el uso acordado</h2>
<p><small>Uso supuesto: ${d.evaluacion?.usoEsperado ? `${d.evaluacion.usoEsperado.sucursales} sucursales, ${d.evaluacion.usoEsperado.minutosVoz.toLocaleString("es-MX")} minutos de voz y ${d.evaluacion.usoEsperado.conversacionesWa.toLocaleString("es-MX")} conversaciones de WhatsApp al mes` : "no indicado"}.</small></p>
<table><thead><tr><th>Concepto</th><th class="n">Cantidad</th><th class="n">Precio</th><th class="n">Importe</th></tr></thead><tbody>${filas}
<tr><td class="t" colspan="3">Subtotal</td><td class="n t">${f ? mxn(f.subtotalMxn) : "-"}</td></tr>
<tr><td colspan="3">IVA ${f ? f.tasaIvaPct : 16} %</td><td class="n">${f ? mxn(f.ivaMxn) : "-"}</td></tr>
<tr><td class="t" colspan="3">Total</td><td class="n t">${f ? mxn(f.totalMxn) : "-"}</td></tr></tbody></table>
<p><small>El consumo real se mide cada mes; los excedentes se cobran con los precios de arriba. Para guardar en PDF: Imprimir → Guardar como PDF.</small></p></body></html>`;
}

export function cobroConsumoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  async function limitar(c: { req: { raw: Request } }, callerId: string, nombre: string) {
    if (!(await rateLimit(`admin:${nombre}:${requestActor(c.req.raw, callerId)}`, MUTACION.max, MUTACION.windowMs, { category: "admin" }))) throw Errors.tooManyRequests("Demasiadas solicitudes en poco tiempo.");
  }

  app.use("/billing/consumo", authMiddleware(deps.env));
  app.get("/billing/consumo", async (c) => {
    const callerId = c.get("userId");
    const queryOrg = c.req.query("organizationId");
    if (queryOrg !== undefined && !UUID_RE.test(queryOrg)) throw Errors.validation("organizationId: se esperaba un UUID.");
    const organizationId = queryOrg ?? c.get("organizationId");
    if (!organizationId || !UUID_RE.test(organizationId)) throw Errors.validation("organizationId: indica la organización (query) o inicia sesión dentro de una.");
    const queryMes = c.req.query("mes");
    if (queryMes !== undefined && !MES_RE.test(queryMes)) throw Errors.validation("mes: se esperaba YYYY-MM.");
    if (!deps.cobroPlanesRepo) return c.json({ disponible: false, motivo: NO_DISPONIBLE });
    const repo = deps.cobroPlanesRepo;

    const r = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const rp = repo(db);
      const t = await rp.tarifaDeOrganizacion(callerId, organizationId);
      if (t.availability === "not_migrated" || !t.tarifa) return { t, d: null, mes: null };
      if (t.tarifa.vertical !== "restaurantes") return { t, d: null, mes: null };
      const mes = queryMes ? `${queryMes}-01` : mesActualEn(t.tarifa.zonaHoraria);
      const d = await rp.consumoDetalleRestaurantes(callerId, organizationId, mes, 6);
      return { t, d, mes };
    });
    if (r.t.availability === "not_migrated") return c.json({ disponible: false, motivo: NO_DISPONIBLE });
    if (!r.t.tarifa) throw Errors.forbidden("No perteneces a esta organización.");
    const tarifa = r.t.tarifa;
    if (tarifa.vertical !== "restaurantes") return c.json({ disponible: false, motivo: "El consumo detallado todavía solo existe para restaurantes." });
    if (!r.d || r.d.availability === "not_migrated" || !r.d.detalle) return c.json({ disponible: false, motivo: NO_DISPONIBLE });
    const det = r.d.detalle;
    const plan = tarifa.plan && tarifa.plan.modeloCobro === "medido" ? tarifa.plan : null;

    let bolsa = null;
    let facturaAlCorte = null;
    let avisoTarifa: string | null = null;
    try {
      if (plan) {
        const f = calcularFacturaPlanMedido(plan, { sucursalesActivas: tarifa.sucursalesActivas, minutosVoz: det.totales.minutosVoz, conversacionesWa: det.totales.conversacionesWa });
        facturaAlCorte = serializarFactura(f);
        bolsa = {
          voz: { incluido: f.voz.incluido, usado: f.voz.usado, porcentaje: porcentaje(f.voz.usado, f.voz.incluido), topeUsoJusto: f.voz.topeUsoJusto },
          whatsapp: { incluido: f.whatsapp.incluido, usado: f.whatsapp.usado, porcentaje: porcentaje(f.whatsapp.usado, f.whatsapp.incluido), topeUsoJusto: f.whatsapp.topeUsoJusto },
        };
      }
    } catch (err) {
      if (!(err instanceof TarifaInvalida)) throw err;
      avisoTarifa = err.message;
    }
    const proy = proyectarMes(plan, tarifa.sucursalesActivas, det.dias, hoyEn(det.zonaHoraria));
    return c.json({
      disponible: true,
      organizationId,
      mes: det.mes,
      zonaHoraria: det.zonaHoraria,
      plan: tarifa.plan ? serializarTarifa(tarifa.plan) : null,
      sucursalesActivas: tarifa.sucursalesActivas,
      totales: det.totales,
      bolsa,
      facturaAlCorte,
      proyeccion: {
        diasDelMes: proy.diasDelMes,
        diasTranscurridos: Math.round(proy.diasTranscurridos * 10) / 10,
        rangoConfiable: proy.rangoConfiable,
        minutosVoz: proy.minutosVoz,
        conversacionesWa: proy.conversacionesWa,
        factura: proy.factura ? { bajo: serializarFactura(proy.factura.bajo), central: serializarFactura(proy.factura.central), alto: serializarFactura(proy.factura.alto) } : null,
      },
      sucursales: det.sucursales,
      historial: det.historial,
      avisoTarifa,
    });
  });

  app.get("/superadmin/cobro/costos-unitarios", async (c) => {
    if (!deps.cobroPlanesRepo) return c.json({ disponible: false, costos: [] });
    const repo = deps.cobroPlanesRepo;
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).costosUnitarios(callerId));
    return c.json({ disponible: r.availability === "available", claves: CLAVES_COSTO_UNITARIO, costos: r.costos });
  });

  app.put("/superadmin/cobro/costos-unitarios/:clave", async (c) => {
    if (!deps.cobroPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.cobroPlanesRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "cobro-costos");
    const clave = c.req.param("clave") as ClaveCostoUnitario;
    if (!CLAVES_COSTO_UNITARIO.includes(clave)) throw Errors.validation(`clave debe ser una de: ${CLAVES_COSTO_UNITARIO.join(", ")}.`);
    const raw = await readJsonCapped<{ costoMxn?: unknown; fuente?: unknown }>(c.req.raw, 2048);
    if (typeof raw.costoMxn !== "number" || !Number.isFinite(raw.costoMxn) || raw.costoMxn < 0) throw Errors.validation("costoMxn debe ser un número >= 0.");
    if (typeof raw.fuente !== "string" || raw.fuente.trim().length < 3 || raw.fuente.length > 200) throw Errors.validation("fuente: indica de dónde sale el costo (3 a 200 caracteres).");
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setCostoUnitario(callerId, clave, raw.costoMxn as number, (raw.fuente as string).trim()));
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  app.put("/superadmin/planes/:id/tabulador", async (c) => {
    if (!deps.cobroPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.cobroPlanesRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "planes-tabulador");
    const planId = c.req.param("id");
    if (!PLAN_ID_RE.test(planId)) throw Errors.validation("id de plan inválido.");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 16 * 1024);
    const tramos = raw.tramos === undefined ? undefined : parsearTramos(raw.tramos);
    const bandasMinutos = raw.bandasMinutos === undefined ? undefined : parsearBandas(raw.bandasMinutos);
    const bandasConversaciones = raw.bandasConversaciones === undefined ? undefined : parsearBandas(raw.bandasConversaciones);
    const margen = raw.margenMinimoPct;
    if (margen !== undefined && margen !== null && (typeof margen !== "number" || margen < 0 || margen > 100)) throw Errors.validation("margenMinimoPct debe estar entre 0 y 100 o null.");
    const alta = raw.cuotaAltaPorSucursalMxn === undefined ? undefined : parseCentavos(raw.cuotaAltaPorSucursalMxn, "cuotaAltaPorSucursalMxn");
    if (tramos === undefined && bandasMinutos === undefined && bandasConversaciones === undefined && margen === undefined && alta === undefined) throw Errors.validation("No hay nada que cambiar.");
    try {
      const ok = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
        const rp = repo(db);
        const pasos = [
          tramos === undefined ? null : rp.setTramos(callerId, planId, tramos),
          bandasMinutos === undefined ? null : rp.setBandas(callerId, planId, "minuto_voz", bandasMinutos),
          bandasConversaciones === undefined ? null : rp.setBandas(callerId, planId, "conversacion_wa", bandasConversaciones),
          margen === undefined ? null : rp.setMargenMinimo(callerId, planId, margen as number | null),
          alta === undefined ? null : rp.setCuotaAltaPorSucursal(callerId, planId, alta),
        ];
        // En serie: una sola transaccion; el primer error revierte todo.
        for (const p of pasos) if (p && (await p).availability === "not_migrated") return false;
        return true;
      });
      if (!ok) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  async function costosVigentes(callerId: string) {
    const repo = deps.cobroPlanesRepo!;
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).costosUnitarios(callerId));
    if (r.availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const { costos, comision, faltan } = costosDesdeFilas(r.costos);
    if (!costos) throw Errors.conflict(`Faltan costos unitarios para calcular el margen: ${faltan.join(", ")}. Captúralos en Costos unitarios.`);
    return { costos, comision };
  }

  app.post("/superadmin/cotizador/calcular", async (c) => {
    if (!deps.cobroPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const callerId = c.get("userId");
    const raw = await readJsonCapped<{ tarifa?: Record<string, unknown>; supuestos?: unknown }>(c.req.raw, 16 * 1024);
    if (!raw.tarifa || typeof raw.tarifa !== "object") throw Errors.validation("tarifa: se esperaba un objeto.");
    const tarifa = tarifaPropuesta(raw.tarifa, "propuesta", "Propuesta");
    const supuestos = parsearSupuestos(raw.supuestos);
    const { costos, comision } = await costosVigentes(callerId);
    try {
      return c.json({ ok: true, evaluacion: evaluarPropuesta(tarifa, supuestos, costos, comision) });
    } catch (err) {
      if (err instanceof TarifaInvalida) throw Errors.validation(err.message);
      throw err;
    }
  });

  app.post("/superadmin/cotizador/crear-plan", async (c) => {
    if (!deps.cobroPlanesRepo || !deps.costosPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.cobroPlanesRepo;
    const planes = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "cotizador-crear");
    const raw = await readJsonCapped<{ organizationId?: unknown; planId?: unknown; nombre?: unknown; tarifa?: Record<string, unknown>; supuestos?: unknown; motivoExcepcion?: unknown; vigenciaDias?: unknown }>(c.req.raw, 16 * 1024);
    const organizationId = typeof raw.organizationId === "string" ? raw.organizationId : "";
    if (!UUID_RE.test(organizationId)) throw Errors.validation("organizationId debe ser un UUID.");
    const planId = typeof raw.planId === "string" ? raw.planId : "";
    if (!PLAN_ID_RE.test(planId)) throw Errors.validation("planId inválido (minúsculas, dígitos y guiones, 3 a 60).");
    const nombre = typeof raw.nombre === "string" ? raw.nombre.trim() : "";
    if (nombre.length < 2 || nombre.length > 80) throw Errors.validation("nombre debe tener entre 2 y 80 caracteres.");
    if (!raw.tarifa || typeof raw.tarifa !== "object") throw Errors.validation("tarifa: se esperaba un objeto.");
    const tarifa = tarifaPropuesta(raw.tarifa, planId, nombre);
    const supuestos = parsearSupuestos(raw.supuestos);
    const motivo = typeof raw.motivoExcepcion === "string" && raw.motivoExcepcion.trim().length > 0 ? raw.motivoExcepcion.trim() : null;
    const vigenciaDias = raw.vigenciaDias === undefined ? 15 : parseEntero(raw.vigenciaDias, "vigenciaDias", 1, 90);
    const { costos, comision } = await costosVigentes(callerId);
    let evaluacion: ReturnType<typeof evaluarPropuesta>;
    try {
      evaluacion = evaluarPropuesta(tarifa, supuestos, costos, comision);
    } catch (err) {
      if (err instanceof TarifaInvalida) throw Errors.validation(err.message);
      throw err;
    }
    if (evaluacion.bajoMinimo && (motivo === null || motivo.length < 20)) {
      throw Errors.validation(`El margen (${evaluacion.margenControlPct ?? "sin dato"} %) queda debajo del mínimo de ${evaluacion.margenMinimoPct} %. Para crear el plan de todos modos indica el motivo (mínimo 20 caracteres): queda auditado.`);
    }
    try {
      const resultado = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
        const base = await planes(db).upsertPlan(callerId, { id: planId, nombre, vertical: "restaurantes", precioBaseCentavos: tarifa.cuotaFijaCentavos, precioAsientoCentavos: null, asientosIncluidos: 0, activo: true });
        if (base.availability === "not_migrated") return null;
        const rp = repo(db);
        const t = await rp.setTarifa(callerId, planId, {
          modeloCobro: "medido",
          precioSucursalCentavos: tarifa.precioSucursalCentavos,
          sucursalesIncluidas: tarifa.sucursalesIncluidas,
          minutosVozIncluidos: tarifa.minutosVozIncluidos,
          minutosVozIncluidosPorSucursal: tarifa.minutosVozIncluidosPorSucursal,
          precioMinutoVozExcedenteCentavos: tarifa.precioMinutoVozExcedenteCentavos,
          conversacionesWaIncluidas: tarifa.conversacionesWaIncluidas,
          conversacionesWaIncluidasPorSucursal: tarifa.conversacionesWaIncluidasPorSucursal,
          precioConversacionWaExcedenteCentavos: tarifa.precioConversacionWaExcedenteCentavos,
          usoJustoPct: tarifa.usoJustoPct,
          cuotaAltaCentavos: tarifa.cuotaAltaCentavos,
          tasaIvaBp: tarifa.tasaIvaBp,
          organizacionExclusivaId: organizationId,
        });
        if (t.availability === "not_migrated") return null;
        if ((tarifa.tramosSucursal ?? []).length > 0) await rp.setTramos(callerId, planId, (tarifa.tramosSucursal ?? []).map((x) => ({ desde: x.desde, hasta: x.hasta, precioCentavos: x.precioCentavos, minutosVozIncluidosPorSucursal: x.minutosVozIncluidosPorSucursal ?? null, conversacionesWaIncluidasPorSucursal: x.conversacionesWaIncluidasPorSucursal ?? null })));
        for (const metrica of ["minuto_voz", "conversacion_wa"] as const) {
          const bandas = (tarifa.bandasUso ?? []).filter((b) => b.metrica === metrica);
          if (bandas.length > 0) await rp.setBandas(callerId, planId, metrica, bandas.map(({ metrica: _m, ...b }) => b));
        }
        if (tarifa.cuotaAltaPorSucursalCentavos !== null && tarifa.cuotaAltaPorSucursalCentavos !== undefined) await rp.setCuotaAltaPorSucursal(callerId, planId, tarifa.cuotaAltaPorSucursalCentavos);
        await rp.setMargenMinimo(callerId, planId, evaluacion.margenMinimoPct);
        const final = await rp.tarifaDeOrganizacion(callerId, organizationId);
        const tarifaFinal = (await rp.listTarifas(callerId)).tarifas.find((x) => x.planId === planId) ?? null;
        const cot = await rp.registrarCotizacion(callerId, {
          organizationId,
          planId,
          detalle: { supuestos, evaluacion, tarifa: tarifaFinal ? serializarTarifa(tarifaFinal) : null, vigenciaDias, sucursalesActivas: final.tarifa?.sucursalesActivas ?? null },
          margenPct: evaluacion.margenControlPct ?? -1000,
          margenMinimoPct: evaluacion.margenMinimoPct,
          motivoExcepcion: evaluacion.bajoMinimo ? motivo : null,
        });
        return cot.cotizacion;
      });
      if (!resultado) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ ok: true, planId, cotizacion: resultado, evaluacion, siguientePaso: "Asigna el plan a la organización con el flujo de dos pasos de Planes (solicitar y confirmar)." }, 201);
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  app.get("/superadmin/cotizaciones", async (c) => {
    if (!deps.cobroPlanesRepo) return c.json({ disponible: false, cotizaciones: [] });
    const repo = deps.cobroPlanesRepo;
    const callerId = c.get("userId");
    const org = c.req.query("organizationId") ?? null;
    if (org !== null && !UUID_RE.test(org)) throw Errors.validation("organizationId: se esperaba un UUID.");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listarCotizaciones(callerId, org, 100));
    return c.json({ disponible: r.availability === "available", cotizaciones: r.cotizaciones });
  });

  app.get("/superadmin/cotizaciones/:id/documento", async (c) => {
    if (!deps.cobroPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.cobroPlanesRepo;
    const callerId = c.get("userId");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw Errors.validation("id de cotización inválido.");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listarCotizaciones(callerId, null, 200));
    const cot = r.cotizaciones.find((x) => x.id === id);
    if (!cot) throw Errors.notFound("No existe esa cotización.");
    const orgs = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).organizacionesMedidas(callerId));
    const nombre = orgs.organizaciones.find((o) => o.organizationId === cot.organizationId)?.nombre ?? "Cliente";
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    return c.body(documentoCotizacion(cot, nombre));
  });

  app.get("/superadmin/cobro/organizaciones", async (c) => {
    if (!deps.cobroPlanesRepo) return c.json({ disponible: false, organizaciones: [] });
    const repo = deps.cobroPlanesRepo;
    const callerId = c.get("userId");
    const queryMes = c.req.query("mes");
    if (queryMes !== undefined && !MES_RE.test(queryMes)) throw Errors.validation("mes: se esperaba YYYY-MM.");
    const lectura = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const rp = repo(db);
      const orgs = await rp.organizacionesMedidas(callerId);
      const costos = await rp.costosUnitarios(callerId);
      if (orgs.availability === "not_migrated") return null;
      const detalles = [];
      for (const o of orgs.organizaciones) {
        if (o.vertical !== "restaurantes") {
          detalles.push({ o, d: null });
          continue;
        }
        const mes = queryMes ? `${queryMes}-01` : mesActualEn(o.zonaHoraria);
        detalles.push({ o, d: (await rp.consumoDetalleRestaurantes(callerId, o.organizationId, mes, 0)).detalle });
      }
      return { detalles, costos: costos.costos };
    });
    if (!lectura) return c.json({ disponible: false, organizaciones: [] });
    const { costos, comision, faltan } = costosDesdeFilas(lectura.costos);
    const filas = lectura.detalles.map(({ o, d }) => {
      if (!d) return { organizationId: o.organizationId, nombre: o.nombre, slug: o.slug, plan: o.tarifa.nombre, disponible: false };
      const proy = proyectarMes(o.tarifa, o.sucursalesActivas, d.dias, hoyEn(d.zonaHoraria));
      const usoCentral = { sucursales: o.sucursalesActivas, minutosVoz: proy.minutosVoz.central, conversacionesWa: proy.conversacionesWa.central };
      let margen: { costoMxn: number; margenPct: number | null; margenConTarjetaPct: number | null } | null = null;
      let ingresoMxn: number | null = proy.factura ? proy.factura.central.subtotalCentavos / 100 : null;
      if (costos && proy.factura) {
        try {
          const r = cotizar(o.tarifa, usoCentral, costos, comision ?? undefined);
          margen = { costoMxn: r.costoMxn, margenPct: r.margenPct, margenConTarjetaPct: r.margenConTarjetaPct };
          ingresoMxn = r.factura.subtotalCentavos / 100;
        } catch {
          margen = null;
        }
      }
      const minimo = o.tarifa.margenMinimoPct ?? MARGEN_MINIMO_POR_OMISION_PCT;
      return {
        organizationId: o.organizationId,
        nombre: o.nombre,
        slug: o.slug,
        plan: o.tarifa.nombre,
        disponible: true,
        sucursalesActivas: o.sucursalesActivas,
        alCorte: d.totales,
        proyeccion: { minutosVoz: proy.minutosVoz, conversacionesWa: proy.conversacionesWa },
        ingresoProyectadoMxn: ingresoMxn,
        costoProyectadoMxn: margen?.costoMxn ?? null,
        margenPct: margen?.margenPct ?? null,
        margenConTarjetaPct: margen?.margenConTarjetaPct ?? null,
        margenMinimoPct: minimo,
        bajoMinimo: margen?.margenPct !== null && margen?.margenPct !== undefined && margen.margenPct < minimo,
      };
    });
    return c.json({ disponible: true, costosFaltantes: faltan, organizaciones: filas });
  });

  return app;
}
