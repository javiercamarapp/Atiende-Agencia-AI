// KPI de voz, costo y alertas operativas del agente de voz de restaurantes (R-13, migracion 035).
// Capa PURA: ningun acceso a base ni a reloj. Las agregaciones por dia las hace SQL
// (`restaurantes.voz_kpis_diarios`, dia = dia local de la sucursal); aqui solo se suman dias, se sacan
// porcentajes y se decide si un umbral se cruzo (misma regla que `restaurantes.voz_evaluar_alertas`).
//
// Reglas de honestidad: sin denominador el porcentaje es null (nunca 0%); sin tipo de cambio el costo en
// centavos es null (nunca 0); el costo "completo" solo si todos los dias con gasto tuvieron tipo de cambio.
// Todo el dinero es entero: micro-USD (como core.llm_usage_daily) y centavos MXN.

export interface VozKpiDia {
  /** YYYY-MM-DD, dia calendario en la zona horaria de la sucursal. */
  readonly fecha: string;
  readonly zonaHoraria: string;
  readonly llamadas: number;
  readonly llamadasCerradas: number;
  readonly duracionTotalS: number;
  readonly pedidosVoz: number;
  readonly escaladas: number;
  readonly abandonadas: number;
  readonly erroresProveedor: number;
  readonly erroresTwilio: number;
  readonly erroresOtros: number;
  readonly toolCalls: number;
  /** null = sin llamadas a herramienta ese dia (no es 0 ms). */
  readonly toolP95Ms: number | null;
  readonly costoVozMicroUsd: number;
  readonly costoTelefoniaMicroUsd: number;
  /** voz + telefonia en centavos MXN; null si no hay tipo de cambio para ese dia. */
  readonly costoTotalCentavosMxn: number | null;
  /** LLM de la ORGANIZACION (todas las sucursales y canales): null si el staff no tiene alcance de toda la organizacion. */
  readonly costoLlmOrgMicroUsd: number | null;
  readonly costoLlmOrgCentavosMxn: number | null;
}

export interface VozKpiTotales {
  readonly dias: number;
  readonly llamadas: number;
  readonly llamadasCerradas: number;
  readonly duracionTotalS: number;
  /** Duracion promedio por llamada CERRADA; null sin llamadas cerradas. */
  readonly duracionPromedioS: number | null;
  readonly pedidosVoz: number;
  readonly escaladas: number;
  readonly abandonadas: number;
  /** Porcentajes enteros sobre llamadas cerradas; null sin llamadas cerradas. */
  readonly tasaResolucionPct: number | null;
  readonly tasaHandoffPct: number | null;
  readonly tasaAbandonoPct: number | null;
  readonly erroresProveedor: number;
  readonly erroresTwilio: number;
  readonly erroresOtros: number;
  /** Errores de proveedor / llamadas, tope 100; null sin llamadas. */
  readonly tasaErrorPct: number | null;
  readonly toolCalls: number;
  /** El PEOR p95 diario del periodo (un p95 global no se puede reconstruir desde p95 diarios). */
  readonly toolP95PeorDiaMs: number | null;
  readonly costoVozMicroUsd: number;
  readonly costoTelefoniaMicroUsd: number;
  /** null si hay gasto y ningun dia con tipo de cambio. */
  readonly costoCentavosMxn: number | null;
  /** false si algun dia con gasto no tuvo tipo de cambio: la cifra en centavos es entonces un piso, no el total. */
  readonly costoCompleto: boolean;
  readonly costoPorLlamadaCentavosMxn: number | null;
  readonly costoLlmOrgMicroUsd: number | null;
  readonly costoLlmOrgCentavosMxn: number | null;
}

export interface VozKpiResumen {
  readonly zonaHoraria: string;
  readonly hoy: string;
  readonly diaDeHoy: VozKpiTotales;
  readonly mes: VozKpiTotales;
  readonly dias: readonly VozKpiDia[];
}

function pct(numerador: number, denominador: number): number | null {
  return denominador > 0 ? Math.round((numerador * 100) / denominador) : null;
}

function sumaNullable(valores: readonly (number | null)[]): number | null {
  const presentes = valores.filter((v): v is number => v !== null);
  return presentes.length === 0 ? null : presentes.reduce((a, b) => a + b, 0);
}

/** Suma un conjunto de dias (cada dia ya viene agregado por SQL). */
export function totalizarDias(dias: readonly VozKpiDia[]): VozKpiTotales {
  const sum = (f: (d: VozKpiDia) => number) => dias.reduce((a, d) => a + f(d), 0);
  const llamadas = sum((d) => d.llamadas);
  const cerradas = sum((d) => d.llamadasCerradas);
  const duracion = sum((d) => d.duracionTotalS);
  const errores = sum((d) => d.erroresProveedor);
  const costoVoz = sum((d) => d.costoVozMicroUsd);
  const costoTel = sum((d) => d.costoTelefoniaMicroUsd);
  const hayGasto = costoVoz + costoTel > 0;
  const centavos = sumaNullable(dias.map((d) => d.costoTotalCentavosMxn));
  const diaConGastoSinFx = dias.some((d) => d.costoVozMicroUsd + d.costoTelefoniaMicroUsd > 0 && d.costoTotalCentavosMxn === null);
  const costoCentavosMxn = hayGasto ? centavos : 0;
  const p95s = dias.map((d) => d.toolP95Ms).filter((v): v is number => v !== null);
  return {
    dias: dias.length,
    llamadas,
    llamadasCerradas: cerradas,
    duracionTotalS: duracion,
    duracionPromedioS: cerradas > 0 ? Math.round(duracion / cerradas) : null,
    pedidosVoz: sum((d) => d.pedidosVoz),
    escaladas: sum((d) => d.escaladas),
    abandonadas: sum((d) => d.abandonadas),
    tasaResolucionPct: pct(sum((d) => d.pedidosVoz), cerradas),
    tasaHandoffPct: pct(sum((d) => d.escaladas), cerradas),
    tasaAbandonoPct: pct(sum((d) => d.abandonadas), cerradas),
    erroresProveedor: errores,
    erroresTwilio: sum((d) => d.erroresTwilio),
    erroresOtros: sum((d) => d.erroresOtros),
    tasaErrorPct: llamadas > 0 ? Math.min(100, Math.round((errores * 100) / llamadas)) : null,
    toolCalls: sum((d) => d.toolCalls),
    toolP95PeorDiaMs: p95s.length === 0 ? null : Math.max(...p95s),
    costoVozMicroUsd: costoVoz,
    costoTelefoniaMicroUsd: costoTel,
    costoCentavosMxn,
    costoCompleto: !diaConGastoSinFx,
    costoPorLlamadaCentavosMxn: costoCentavosMxn !== null && llamadas > 0 ? Math.round(costoCentavosMxn / llamadas) : null,
    costoLlmOrgMicroUsd: sumaNullable(dias.map((d) => d.costoLlmOrgMicroUsd)),
    costoLlmOrgCentavosMxn: sumaNullable(dias.map((d) => d.costoLlmOrgCentavosMxn)),
  };
}

/** `dias` debe incluir `hoy` (el rango de la consulta termina hoy); el mes es todo el rango. */
export function resumirKpis(dias: readonly VozKpiDia[], hoy: string, zonaHoraria: string): VozKpiResumen {
  return {
    zonaHoraria,
    hoy,
    diaDeHoy: totalizarDias(dias.filter((d) => d.fecha === hoy)),
    mes: totalizarDias(dias),
    dias,
  };
}

export const ZONA_HORARIA_POR_DEFECTO = "America/Mexico_City";

/** Fecha YYYY-MM-DD de `ahora` en la zona; una zona vacia o invalida cae a America/Mexico_City (igual que la base). */
export function diaLocalSucursal(ahora: Date, zonaHoraria: string | null): { fecha: string; zonaHoraria: string } {
  for (const zona of [zonaHoraria, ZONA_HORARIA_POR_DEFECTO]) {
    if (!zona) continue;
    try {
      const partes = new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
      if (/^\d{4}-\d{2}-\d{2}$/.test(partes)) return { fecha: partes, zonaHoraria: zona };
    } catch {
      // zona invalida: se prueba la siguiente
    }
  }
  return { fecha: ahora.toISOString().slice(0, 10), zonaHoraria: "UTC" };
}

/** Del dia 1 del mes de `hoy` hasta `hoy` (maximo 31 dias: dentro del tope de 63 de la base). */
export function rangoDelMes(hoy: string): { desde: string; hasta: string } {
  return { desde: `${hoy.slice(0, 8)}01`, hasta: hoy };
}

// ---------------------------------------------------------------------------------------------------
// Umbrales y alertas
// ---------------------------------------------------------------------------------------------------

export type VozAlertaTipo = "costo_dia" | "tasa_error";

export interface VozUmbrales {
  /** false = nunca se configuro (valores por defecto: todo apagado). */
  readonly configurado: boolean;
  /** Centavos MXN enteros; null = alerta de costo apagada. */
  readonly umbralCostoDiaCentavosMxn: number | null;
  /** Porcentaje entero 1-100; null = alerta de error apagada. */
  readonly umbralTasaErrorPct: number | null;
  readonly minLlamadasTasaError: number;
}

export type VozUmbralesEntrada = Omit<VozUmbrales, "configurado">;

export const VOZ_UMBRALES_POR_DEFECTO: VozUmbrales = {
  configurado: false,
  umbralCostoDiaCentavosMxn: null,
  umbralTasaErrorPct: null,
  minLlamadasTasaError: 5,
};

export interface VozAlerta {
  readonly fecha: string;
  readonly tipo: VozAlertaTipo;
  /** costo_dia: centavos MXN; tasa_error: porcentaje entero. */
  readonly valor: number;
  readonly umbral: number;
  /** true solo en la evaluacion que la dispara por primera vez ese dia. */
  readonly nueva: boolean;
}

/** Misma regla que `restaurantes.voz_evaluar_alertas`: costo >= umbral (solo con tipo de cambio) y
 * tasa >= umbral (solo con el volumen minimo de llamadas). */
export function evaluarAlertasDia(umbrales: VozUmbralesEntrada, dia: VozKpiDia): readonly Pick<VozAlerta, "fecha" | "tipo" | "valor" | "umbral">[] {
  const alertas: Pick<VozAlerta, "fecha" | "tipo" | "valor" | "umbral">[] = [];
  if (umbrales.umbralCostoDiaCentavosMxn !== null && dia.costoTotalCentavosMxn !== null && dia.costoTotalCentavosMxn >= umbrales.umbralCostoDiaCentavosMxn) {
    alertas.push({ fecha: dia.fecha, tipo: "costo_dia", valor: dia.costoTotalCentavosMxn, umbral: umbrales.umbralCostoDiaCentavosMxn });
  }
  if (umbrales.umbralTasaErrorPct !== null && dia.llamadas >= umbrales.minLlamadasTasaError && dia.llamadas > 0) {
    const tasa = Math.min(100, Math.round((dia.erroresProveedor * 100) / dia.llamadas));
    if (tasa >= umbrales.umbralTasaErrorPct) alertas.push({ fecha: dia.fecha, tipo: "tasa_error", valor: tasa, umbral: umbrales.umbralTasaErrorPct });
  }
  return alertas;
}

/** Valida la entrada del PUT de umbrales. Devuelve mensajes de error (vacio = valida). */
export function validarUmbrales(entrada: { umbralCostoDiaCentavosMxn: unknown; umbralTasaErrorPct: unknown; minLlamadasTasaError: unknown }): string[] {
  const errores: string[] = [];
  const c = entrada.umbralCostoDiaCentavosMxn;
  if (c !== null && (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > 100_000_000)) errores.push("umbralCostoDiaCentavosMxn: entero de 1 a 100000000 centavos, o null para apagar la alerta.");
  const t = entrada.umbralTasaErrorPct;
  if (t !== null && (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 100)) errores.push("umbralTasaErrorPct: entero de 1 a 100, o null para apagar la alerta.");
  const m = entrada.minLlamadasTasaError;
  if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 1000) errores.push("minLlamadasTasaError: entero de 1 a 1000.");
  return errores;
}

// ---------------------------------------------------------------------------------------------------
// Eventos que reporta el servicio de voz
// ---------------------------------------------------------------------------------------------------

export type VozEventoTipo = "tool_call" | "error_proveedor";
export const VOZ_EVENTO_TIPOS: readonly VozEventoTipo[] = ["tool_call", "error_proveedor"];
export type VozProveedorFallo = "twilio" | "gemini" | "otro";
export const VOZ_PROVEEDORES_FALLO: readonly VozProveedorFallo[] = ["twilio", "gemini", "otro"];

export interface VozEventoEntrada {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly conversationId: string | null;
  readonly tipo: VozEventoTipo;
  /** Obligatorio en `error_proveedor`. */
  readonly proveedor: VozProveedorFallo | null;
  /** Obligatorio en `tool_call`. */
  readonly herramienta: string | null;
  /** Obligatorio en `tool_call`. */
  readonly latenciaMs: number | null;
  /** Codigo corto del proveedor (HTTP, Twilio...), nunca el mensaje completo. */
  readonly codigo: string | null;
  readonly ocurridoAt: string | null;
}
