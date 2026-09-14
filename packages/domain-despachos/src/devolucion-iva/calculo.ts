// Motor de cálculo del papel de trabajo de devolución de IVA — puerto de
// `b2b_ai/features/devolucion_iva/service.py` (4081 líneas totales del
// módulo, contando modelos/validadores/rutas/tests). Puro, sin I/O.
//
// Redondeo: el Python original usa `round(x, 2)` en TODOS estos cálculos —
// banker's rounding (round-half-to-even) sobre el float binario más cercano
// al literal decimal, NO "half away from zero". Se reutiliza el `r2()` ya
// verificado byte-exacto contra el intérprete real (`nomina/redondeo.ts`,
// Fase 3 — reconstruye el double exacto vía IEEE-754 con BigInt) en vez de
// reimplementar un tercer redondeo aproximado para este módulo (evita
// duplicar la lógica, mismo criterio que pide la tarea de esta fase).
import { r2 } from "../nomina/redondeo.ts";
import { fechaADate } from "../conciliacion/fechas.ts";
import type {
  ClasificacionIva,
  CongruenciaDiotCfdiDeclaracion,
  ConciliacionDeclaracionSaldo,
  ConciliacionDiotDeclaracion,
  ConciliacionFacturaDiot,
  DeclaracionMensualIva,
  DiotEntryIva,
  DiotFacturaDetalleIva,
  EstadoEnvioSolicitud,
  FacturaCfdiIva,
  MontoDevolucion,
  SolicitudDevolucion,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Paso 1: recopilar / clasificar
// ---------------------------------------------------------------------------

/** `recopilar_facturas` — filtra por periodo ("YYYY-MM") comparando contra
 * los primeros 7 caracteres de `fecha`, igual que el origen (`f.fecha[:7]`). */
export function recopilarFacturas(facturas: readonly FacturaCfdiIva[], periodo?: string | null): readonly FacturaCfdiIva[] {
  if (facturas.length === 0) return [];
  if (!periodo) return facturas;
  return facturas.filter((f) => f.fecha && f.fecha.slice(0, 7) === periodo);
}

export interface ClasificacionIvaResultado {
  readonly acreditable_100: readonly FacturaCfdiIva[];
  readonly acreditable_proporcional: readonly FacturaCfdiIva[];
  readonly no_acreditable: readonly FacturaCfdiIva[];
}

/** `clasificar_iva` — cualquier `categoria` no reconocida cae en
 * `no_acreditable` (mismo `else` final del origen; en TS `categoria` está
 * tipado a las 3 variantes válidas, pero se preserva el fallback por si el
 * cliente HTTP manda un valor inesperado antes de que el tipo lo atrape). */
export function clasificarIva(facturas: readonly FacturaCfdiIva[]): ClasificacionIvaResultado {
  const out: { acreditable_100: FacturaCfdiIva[]; acreditable_proporcional: FacturaCfdiIva[]; no_acreditable: FacturaCfdiIva[] } = {
    acreditable_100: [],
    acreditable_proporcional: [],
    no_acreditable: [],
  };
  for (const f of facturas) {
    const cat: ClasificacionIva = f.categoria;
    if (cat === "acreditable_100") out.acreditable_100.push(f);
    else if (cat === "acreditable_proporcional") out.acreditable_proporcional.push(f);
    else out.no_acreditable.push(f);
  }
  return out;
}

/** `FacturaCFDI.iva_acreditable_efectivamente_pagado` — LIVA Art. 5 fracc.
 * III: el IVA solo es acreditable si está EFECTIVAMENTE PAGADO, lo que este
 * módulo exige acreditar con el UUID del REP (complemento de pago). Sin
 * `referenciaComplementoPago`, el IVA acreditable "efectivamente pagado" es
 * 0 sin importar `proporcionalidad` — regla fiscal deliberada, no un bug. */
export function ivaAcreditableEfectivamentePagado(f: FacturaCfdiIva): number {
  if (!f.referenciaComplementoPago || f.referenciaComplementoPago.trim() === "") return 0;
  return r2(f.iva * f.proporcionalidad);
}

// ---------------------------------------------------------------------------
// Paso 2: generar DIOT (agrupación específica de devolución de IVA — es la
// TERCERA implementación DIOT del repo de referencia, deliberadamente
// distinta de `declaraciones/diot-aggregate.ts` — ver comentario de cabecera
// de ese archivo sobre las "tres implementaciones DIOT" ya documentadas en
// Fase 2. Esta agrupa SOLO por `rfcEmisor` con un tipo de operación fijo
// ("03" = gastos en general, catálogo SAT DIOT), sin desglose por tasa.)
// ---------------------------------------------------------------------------

const TIPO_OPERACION_GASTOS_GENERAL = "03";

/** `generar_diot` — agrupa por `rfcEmisor` (tipo de operación fijo "03");
 * `ivaTrasladado` es la suma simple de `iva` (SIN prorratear);
 * `ivaAcreditable` SÍ aplica `proporcionalidad`. Orden de salida: `sorted
 * (groups.items())` sobre tuplas `(rfc, tipoOperacion)` — como el tipo de
 * operación es constante aquí, equivale a ordenar por `rfcEmisor` (string,
 * ascendente). */
export function generarDiotDevolucionIva(facturas: readonly FacturaCfdiIva[]): readonly DiotEntryIva[] {
  if (facturas.length === 0) return [];

  interface Grupo {
    nombre: string;
    montoNeto: number;
    ivaTrasladado: number;
    ivaAcreditable: number;
    folios: string[];
    detalle: DiotFacturaDetalleIva[];
  }
  const grupos = new Map<string, Grupo>();

  for (const f of facturas) {
    const key = f.rfcEmisor;
    let g = grupos.get(key);
    if (!g) {
      g = { nombre: "", montoNeto: 0, ivaTrasladado: 0, ivaAcreditable: 0, folios: [], detalle: [] };
      grupos.set(key, g);
    }
    const ivaAcreditable = f.iva * f.proporcionalidad;
    g.nombre = g.nombre || f.nombreEmisor;
    g.montoNeto += f.subtotal;
    g.ivaTrasladado += f.iva;
    g.ivaAcreditable += ivaAcreditable;
    g.folios.push(f.uuid);
    g.detalle.push({
      folioFiscal: f.uuid,
      folioFactura: f.folioFactura ?? null,
      concepto: f.concepto ?? null,
      fechaPago: f.fechaPago ?? null,
      bancoPago: f.bancoPago ?? null,
    });
  }

  return [...grupos.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([rfc, g]) => ({
      rfcTercero: rfc,
      nombre: g.nombre,
      tipoOperacion: TIPO_OPERACION_GASTOS_GENERAL,
      montoNeto: r2(g.montoNeto),
      ivaTrasladado: r2(g.ivaTrasladado),
      ivaAcreditable: r2(g.ivaAcreditable),
      foliosFiscales: g.folios,
      facturasDetalle: g.detalle,
    }));
}

const RFC_PERSONA_MORAL = /^[A-ZÑ&]{3}\d{6}[A-Z\d]{3}$/;
const RFC_PERSONA_FISICA = /^[A-ZÑ&]{4}\d{6}[A-Z\d]{3}$/;

/** `validate_rfc` — longitud 12-13, y matchea persona física (13) o moral
 * (12) según el patrón del origen. Devuelve `null` si es válido. */
export function validarRfc(rfc: string): string | null {
  if (!rfc || rfc.trim() === "") return "RFC no puede estar vacío.";
  const v = rfc.trim().toUpperCase();
  if (v.length < 12 || v.length > 13) return `RFC con longitud inválida (${v.length} chars). Se esperaba 12-13.`;
  const ok = v.length === 12 ? RFC_PERSONA_MORAL.test(v) : RFC_PERSONA_FISICA.test(v);
  if (!ok) return `RFC con formato inválido: '${v}'.`;
  return null;
}

const VALID_IVA_RATES = new Set([0, 0.08, 0.16]);

/** `validate_iva_rate` — igualdad exacta contra {0, 0.08, 0.16} (el origen
 * usa un `set` de floats con `in`, no una tolerancia). */
export function validarTasaIva(rate: number): { ok: boolean; msg: string } {
  if (!VALID_IVA_RATES.has(rate)) {
    return { ok: false, msg: `Tasa de IVA inválida: ${rate}. Tasas aceptadas: 0%, 8%, 16%.` };
  }
  return { ok: true, msg: "" };
}

/** `validar_diot` — RFC, montos no negativos, y tasa efectiva de IVA
 * (`round(ivaTrasladado/montoNeto, 4)`) dentro del catálogo válido. */
export function validarDiot(entries: readonly DiotEntryIva[]): readonly string[] {
  const errors: string[] = [];
  if (entries.length === 0) {
    errors.push("No hay entradas DIOT para validar.");
    return errors;
  }
  entries.forEach((entry, idx) => {
    const prefix = `DIOT #${idx + 1}`;
    const rfcErr = validarRfc(entry.rfcTercero);
    if (rfcErr) errors.push(`${prefix}: ${rfcErr}`);
    if (entry.montoNeto < 0) errors.push(`${prefix}: monto_neto no puede ser negativo.`);
    if (entry.ivaTrasladado < 0) errors.push(`${prefix}: iva_trasladado no puede ser negativo.`);
    if (entry.ivaAcreditable < 0) errors.push(`${prefix}: iva_acreditable no puede ser negativo.`);
    if (entry.montoNeto > 0 && entry.ivaTrasladado > 0) {
      const effectiveRate = Math.round((entry.ivaTrasladado / entry.montoNeto + Number.EPSILON) * 10000) / 10000;
      const { ok, msg } = validarTasaIva(effectiveRate);
      if (!ok) errors.push(`${prefix}: ${msg}`);
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Paso 3: conciliación
// ---------------------------------------------------------------------------

/** `conciliar_facturas_diot` — MATCH si la factura aparece en algún
 * `foliosFiscales` de una entrada DIOT y el IVA acreditable coincide dentro
 * de 0.01 MXN; MISMATCH si no aparece o si el monto difiere. */
export function conciliarFacturasDiot(facturas: readonly FacturaCfdiIva[], diotEntries: readonly DiotEntryIva[]): readonly ConciliacionFacturaDiot[] {
  const diotByUuid = new Map<string, DiotEntryIva>();
  for (const entry of diotEntries) {
    for (const uuid of entry.foliosFiscales) diotByUuid.set(uuid, entry);
  }

  return facturas.map((f) => {
    const entry = diotByUuid.get(f.uuid);
    if (entry) {
      const ivaAcreditable = f.iva * f.proporcionalidad;
      if (Math.abs(entry.ivaAcreditable - ivaAcreditable) > 0.01) {
        return {
          facturaUuid: f.uuid,
          diotMatch: true,
          status: "mismatch" as const,
          detalles: `IVA DIOT (${entry.ivaAcreditable.toFixed(2)}) ≠ IVA factura (${ivaAcreditable.toFixed(2)})`,
        };
      }
      return { facturaUuid: f.uuid, diotMatch: true, status: "match" as const, detalles: "Conciliación correcta" };
    }
    return { facturaUuid: f.uuid, diotMatch: false, status: "mismatch" as const, detalles: "Factura no encontrada en DIOT" };
  });
}

/** `conciliar_diot_declaracion` — MATCH si la declaración no tiene
 * `ivaPagado` (0) Y el total DIOT también es 0, o si la diferencia relativa
 * (`|total-ivaPagado| / ivaPagado`) es ≤ 5%. */
export function conciliarDiotDeclaracion(diotEntries: readonly DiotEntryIva[], declaraciones: readonly DeclaracionMensualIva[]): readonly ConciliacionDiotDeclaracion[] {
  const diotIvaTotal = diotEntries.reduce((acc, e) => acc + e.ivaAcreditable, 0);

  return declaraciones.map((decl) => {
    const diferencia = Math.abs(diotIvaTotal - decl.ivaPagado);
    let status: "match" | "mismatch";
    if (decl.ivaPagado > 0) {
      const pctDiff = diferencia / decl.ivaPagado;
      status = pctDiff <= 0.05 ? "match" : "mismatch";
    } else if (diotIvaTotal === 0) {
      status = "match";
    } else {
      status = "mismatch";
    }
    return {
      diotIvaTotal: r2(diotIvaTotal),
      declaracionIvaAcreditable: r2(decl.ivaPagado),
      diferencia: r2(diferencia),
      status,
    };
  });
}

/** `conciliar_declaracion_saldo` — consistente si `|saldoNeto -
 * saldoAFavorSolicitado| <= 0.01` (tolerancia absoluta, no relativa). */
export function conciliarDeclaracionSaldo(declaraciones: readonly DeclaracionMensualIva[], saldoAFavor: number): ConciliacionDeclaracionSaldo {
  const totalSaldoFavor = declaraciones.reduce((acc, d) => acc + d.saldoFavor, 0);
  const totalSaldoContra = declaraciones.reduce((acc, d) => acc + d.saldoContra, 0);
  const saldoNeto = totalSaldoFavor - totalSaldoContra;
  const diferencia = Math.abs(saldoNeto - saldoAFavor);
  return {
    totalSaldoFavorDeclared: r2(totalSaldoFavor),
    totalSaldoContraDeclared: r2(totalSaldoContra),
    saldoNetoDeclaraciones: r2(saldoNeto),
    saldoAFavorSolicitado: r2(saldoAFavor),
    diferencia: r2(diferencia),
    consistente: diferencia <= 0.01,
  };
}

// ---------------------------------------------------------------------------
// Paso 4: saldo a favor / monto de devolución
// ---------------------------------------------------------------------------

/** `calcular_saldo_favor` — suma simple de `saldoFavor` de todas las
 * declaraciones. NO se deriva de trasladado−acreditable dentro de este
 * módulo (ver hallazgo de auditoría): confía en que `saldoFavor` ya viene
 * calculado externamente (de la declaración real presentada al SAT). */
export function calcularSaldoFavor(declaraciones: readonly DeclaracionMensualIva[]): number {
  return r2(declaraciones.reduce((acc, d) => acc + d.saldoFavor, 0));
}

/** `calcular_monto_devolucion` — `factorActualizacion=1.0` es un PLACEHOLDER
 * en el origen (actualización INPC real no implementada) y
 * `prescripcionVerificada=true` es OTRO placeholder (no hay verificación
 * real del plazo de prescripción de 5 años) — replicados tal cual, NO
 * corregidos: son huecos documentados del Python original, no bugs a
 * arreglar en silencio (ver ADR de esta fase). */
export function calcularMontoDevolucion(saldoFavor: number, declaraciones: readonly DeclaracionMensualIva[]): MontoDevolucion {
  const totalSaldoFavor = calcularSaldoFavor(declaraciones);
  const montoDevolucion = totalSaldoFavor;
  const factorActualizacion = 1.0;
  const montoActualizado = r2(montoDevolucion * factorActualizacion);

  let periodoMasAntiguo: string | null = null;
  if (declaraciones.length > 0) {
    const minAnio = Math.min(...declaraciones.map((d) => d.año));
    const minMes = Math.min(...declaraciones.map((d) => d.mes));
    periodoMasAntiguo = `${minAnio}-${String(minMes).padStart(2, "0")}`;
  }

  return {
    saldoFavorOriginal: r2(saldoFavor),
    totalSaldoFavorDeclaraciones: r2(totalSaldoFavor),
    factorActualizacion,
    montoActualizado,
    montoDevolucionSugerido: montoActualizado,
    periodoMasAntiguo,
    prescripcionVerificada: true,
  };
}

// ---------------------------------------------------------------------------
// Paso 5: congruencia + solicitud
// ---------------------------------------------------------------------------

/** REQ-IVA-010: por encima de este monto, exigir congruencia DIOT↔CFDI↔
 * declaración mensual antes de dejar la solicitud lista para envío. */
export const UMBRAL_CONGRUENCIA_MONTO = 10001.0;

/** Tolerancia ABSOLUTA de redondeo (no porcentual, a diferencia de
 * `conciliarDiotDeclaracion`, que usa 5% relativo). */
export const TOLERANCIA_CONGRUENCIA_MXN = 1.0;

/** `validar_congruencia_diot_cfdi_declaracion`. */
export function validarCongruenciaDiotCfdiDeclaracion(
  periodo: string,
  facturas: readonly FacturaCfdiIva[] = [],
  diotEntries: readonly DiotEntryIva[] = [],
  declaraciones: readonly DeclaracionMensualIva[] = [],
  tolerancia: number = TOLERANCIA_CONGRUENCIA_MXN,
): CongruenciaDiotCfdiDeclaracion {
  const diotExiste = diotEntries.length > 0;

  const totalCfdi = r2(facturas.filter((f) => !periodo || (f.fecha && f.fecha.slice(0, 7) === periodo)).reduce((acc, f) => acc + f.iva * f.proporcionalidad, 0));
  const totalDiot = r2(diotEntries.reduce((acc, e) => acc + e.ivaAcreditable, 0));

  const declaracionesPeriodo = declaraciones.filter((d) => !periodo || `${String(d.año).padStart(4, "0")}-${String(d.mes).padStart(2, "0")}` === periodo);
  const declaracionExiste = declaracionesPeriodo.length > 0;
  const totalDeclaracion = r2(declaracionesPeriodo.reduce((acc, d) => acc + d.ivaPagado, 0));

  const diferenciaCfdiDiot = r2(Math.abs(totalCfdi - totalDiot));
  const diferenciaDiotDeclaracion = r2(Math.abs(totalDiot - totalDeclaracion));
  const diferenciaMaxima = r2(Math.max(diferenciaCfdiDiot, diferenciaDiotDeclaracion));

  const congruente = diotExiste && diferenciaMaxima <= tolerancia;

  return {
    periodo,
    diotExiste,
    declaracionExiste,
    totalCfdiIvaAcreditable: totalCfdi,
    totalDiotIvaAcreditable: totalDiot,
    totalDeclaracionIvaPagado: totalDeclaracion,
    diferenciaCfdiDiot,
    diferenciaDiotDeclaracion,
    diferenciaMaxima,
    tolerancia,
    congruente,
  };
}

/** Dígito verificador de CLABE — módulo 10 ponderado 3-7-1 (puerto de
 * `b2b_ai.api.validators.validate_clabe`, reutilizado en el origen por
 * `devolucion_iva/validators.py::validate_clabe` en vez de reimplementarse
 * — se sigue el mismo criterio aquí: una sola implementación). */
export function digitoVerificadorClabe(primeros17: string): number {
  const factors = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7];
  let total = 0;
  for (let i = 0; i < 17; i++) {
    total += (Number(primeros17[i]) * factors[i]!) % 10;
  }
  return (10 - (total % 10)) % 10;
}

/** `validate_clabe` — 18 dígitos exactos + dígito verificador correcto.
 * Devuelve `null` si es válida, mensaje de error si no. */
export function validarClabe(clabe: string): string | null {
  if (!clabe || clabe.trim() === "") return "CLABE no puede estar vacío.";
  const v = clabe.trim();
  if (v.length !== 18) return `CLABE debe tener 18 dígitos, tiene ${v.length}.`;
  if (!/^\d{18}$/.test(v)) return "CLABE solo debe contener dígitos.";
  const check = digitoVerificadorClabe(v.slice(0, 17));
  if (Number(v[17]) !== check) return `CLABE con dígito verificador inválido: Dígito verificador inválido. Esperado: ${check}`;
  return null;
}

export interface SaldoDevolucionInput {
  readonly montoDevolucionSugerido?: number;
  readonly saldoFavorOriginal?: number;
}

/** `preparar_solicitud`. Lanza `Error` si `monto <= 0` o si la CLABE (si se
 * provee) es inválida — mismo comportamiento del origen (`raise
 * ValueError`). `now` se inyecta (en vez de leer el reloj del sistema
 * dentro de la función) para mantener el motor puro/testeable, igual que el
 * resto de los motores de despachos (`vencimientos/engine.ts` recibe
 * `todayIso` explícito por el mismo motivo). */
export function prepararSolicitud(
  periodo: string,
  saldo: SaldoDevolucionInput,
  opts: {
    readonly cuentaBanco?: string | null;
    readonly clabe?: string | null;
    readonly documentos?: readonly string[];
    readonly tenantId?: string | null;
    readonly facturas?: readonly FacturaCfdiIva[];
    readonly diotEntries?: readonly DiotEntryIva[];
    readonly declaraciones?: readonly DeclaracionMensualIva[];
    readonly now: string;
    readonly solicitudId: string;
  },
): SolicitudDevolucion {
  const monto = saldo.montoDevolucionSugerido ?? saldo.saldoFavorOriginal ?? 0;
  if (monto <= 0) {
    throw new Error(`El monto de devolución (${monto}) debe ser mayor a cero. No hay saldo a favor suficiente.`);
  }

  if (opts.clabe) {
    const clabeErr = validarClabe(opts.clabe);
    if (clabeErr) throw new Error(clabeErr);
  }

  const montoRedondeado = r2(monto);

  let estado: EstadoEnvioSolicitud = "lista_para_envio";
  let motivoAclaracion: string | null = null;

  if (montoRedondeado > UMBRAL_CONGRUENCIA_MONTO) {
    const congruencia = validarCongruenciaDiotCfdiDeclaracion(periodo, opts.facturas ?? [], opts.diotEntries ?? [], opts.declaraciones ?? []);
    if (!congruencia.congruente) {
      estado = "requiere_aclaracion";
      motivoAclaracion = !congruencia.diotExiste
        ? `No existe DIOT registrada para el periodo ${periodo}; no se puede validar la congruencia requerida para montos superiores a $${UMBRAL_CONGRUENCIA_MONTO.toFixed(2)} MXN.`
        : `Diferencia de congruencia DIOT↔CFDI↔declaración de $${congruencia.diferenciaMaxima.toFixed(2)} MXN supera la tolerancia de $${congruencia.tolerancia.toFixed(2)} MXN (periodo ${periodo}).`;
    }
  }

  return {
    solicitudId: opts.solicitudId,
    periodo,
    montoSolicitado: montoRedondeado,
    tenantId: opts.tenantId ?? null,
    cuentaBanco: opts.cuentaBanco ?? null,
    clabe: opts.clabe ?? null,
    documentos: opts.documentos ?? [],
    status: "pendiente",
    estado,
    motivoAclaracion,
    createdAt: opts.now,
  };
}

// ---------------------------------------------------------------------------
// REQ-IVA-016 — Plazo de resolución (Art. 22 CFF): 40 días hábiles desde la
// presentación (20 si hay dictamen de contador público registrado o
// garantía del interés fiscal). Reutiliza `fechaADate` (conciliacion/
// fechas.ts) para el parseo de fecha en vez de reimplementarlo.
// ---------------------------------------------------------------------------

export const DIAS_HABILES_PLAZO_RESOLUCION = 40;
export const DIAS_HABILES_PLAZO_RESOLUCION_CON_DICTAMEN_O_GARANTIA = 20;

/** Días inhábiles federales de México observados en 2026 (mes, día) — puerto
 * de `MEXICO_HOLIDAYS_2026` (`b2b_ai/features/alertas/deadline_engine.py`),
 * el mismo calendario oficial que usa el resto de plazos fiscales del
 * sistema (reutilizado aquí explícitamente por el origen para no mantener
 * un segundo calendario paralelo). */
export const MEXICO_HOLIDAYS_2026: ReadonlySet<string> = new Set(["1-1", "2-2", "3-16", "5-1", "9-16", "11-16", "12-25"]);

function esDiaHabil(d: Date, holidays: ReadonlySet<string> = MEXICO_HOLIDAYS_2026): boolean {
  const dow = d.getUTCDay(); // 0=domingo, 6=sábado
  if (dow === 0 || dow === 6) return false;
  const key = `${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  return !holidays.has(key);
}

/** `sumar_dias_habiles` — la fecha de inicio se EXCLUYE del conteo (Art. 12
 * CFF: el plazo corre a partir del día siguiente). */
export function sumarDiasHabiles(fechaInicio: string, numDiasHabiles: number, holidays: ReadonlySet<string> = MEXICO_HOLIDAYS_2026): string {
  if (numDiasHabiles < 0) throw new Error("num_dias_habiles no puede ser negativo.");
  const inicio = fechaADate(fechaInicio);
  if (!inicio) throw new Error(`fecha_inicio inválida: '${fechaInicio}'.`);

  let dia = new Date(inicio.getTime());
  let contados = 0;
  while (contados < numDiasHabiles) {
    dia = new Date(dia.getTime() + 86_400_000);
    if (esDiaHabil(dia, holidays)) contados += 1;
  }
  const y = dia.getUTCFullYear();
  const m = String(dia.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dia.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** `calcular_fecha_limite_resolucion` — REQ-IVA-016. */
export function calcularFechaLimiteResolucion(fechaPresentacion: string, hayDictamenOGarantia = false, holidays: ReadonlySet<string> = MEXICO_HOLIDAYS_2026): string {
  const dias = hayDictamenOGarantia ? DIAS_HABILES_PLAZO_RESOLUCION_CON_DICTAMEN_O_GARANTIA : DIAS_HABILES_PLAZO_RESOLUCION;
  return sumarDiasHabiles(fechaPresentacion, dias, holidays);
}
