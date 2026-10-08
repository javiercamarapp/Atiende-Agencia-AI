// CFO-04 · resumen narrado determinista (diseño §4.4): 3 a 6 oraciones en español de México, de usted, SIN modelo de lenguaje.
//
// Garantías:
//  - Cada número que aparece en el texto viene de la entrada (`kpis`, `hallazgos`) y va seguido de su referencia, p. ej. «$128,400.00 [ventas_netas]».
//  - `numerosNoRespaldados` es el guard: una regex sobre la SALIDA que detecta cualquier número que no esté en la entrada. `narrarResumen` lo
//    ejecuta y, si algo se cuela, descarta esa oración (nunca publica una cifra sin respaldo).
//  - Con datos vacíos dice que no hay datos; no inventa cifras ni comparaciones.
//  - LÍMITES del guard: es una regex sobre dígitos. No detecta cifras escritas con palabras («dos mil»), ni valida el SIGNO ni la unidad
//    (un «18 %» presente en la entrada con otro significado pasaría), ni números dentro de nombres de sucursal. Protege contra números
//    inventados o mal formateados, no contra una redacción semánticamente incorrecta: por eso las plantillas son fijas y revisadas.
//  - Sin `toLocale*`, sin reloj.
import { textoMultiSucursal } from "./consolidar.ts";
import type { Hallazgo } from "./hallazgos.ts";
import type { AlcanceSucursales, Cifra } from "./tipos.ts";
import { formatoCentavos, formatoEntero, formatoPct } from "./util.ts";

export type TipoValor = "centavos" | "pct" | "entero";

export interface ValorKpi {
  readonly cifra: Cifra;
  readonly tipo: TipoValor;
}

export interface KpisResumen {
  /** «agente» = sin SoftRestaurant (titular «Ventas por el agente»); «negocio» = con SR. */
  readonly titularOrigen: "agente" | "negocio";
  /** Ya redactado: «los últimos 7 días». */
  readonly periodo: string;
  /** Ya redactado: «su promedio de las 4 semanas previas». */
  readonly comparadoContra: string;
  /** «todas sus sucursales» o el nombre de la sucursal. */
  readonly alcanceEtiqueta?: string;
  readonly ventasNetas: ValorKpi;
  readonly pedidos?: ValorKpi;
  readonly ticket?: ValorKpi;
  readonly variacionVentas?: ValorKpi;
  readonly descuentoPct?: ValorKpi;
  readonly cancelacionPct?: ValorKpi;
  readonly costoPorPedidoAgente?: ValorKpi;
  readonly margenContribucion?: ValorKpi;
  readonly margenParcial?: boolean;
  /** Clientes que compraron en más de una sucursal (no aditivo). */
  readonly multiSucursal?: number | null;
  /** Sucursal que más explica la variación y qué porcentaje de ella. */
  readonly mayorAporte?: { readonly sucursal: string; readonly aportePct: Cifra } | null;
}

export interface OracionNarrativa {
  readonly texto: string;
  /** Referencias citadas, p. ej. ["ventas_netas", "pedidos"]. */
  readonly refs: readonly string[];
}

export interface ResumenNarrado {
  readonly oraciones: readonly OracionNarrativa[];
  /** Oraciones unidas con un espacio. */
  readonly texto: string;
  /** referencia -> cómo se mostró la cifra (para tooltips de la UI). */
  readonly referencias: Readonly<Record<string, string>>;
  /** Siempre [] si el guard pasó. */
  readonly numerosNoRespaldados: readonly string[];
  readonly sinDatos: boolean;
}

function mostrar(v: ValorKpi, absoluto = false): string | null {
  if (v.cifra.valor == null) return null;
  const x = absoluto ? Math.abs(v.cifra.valor) : v.cifra.valor;
  switch (v.tipo) {
    case "centavos": return formatoCentavos(x);
    case "pct": return formatoPct(x);
    case "entero": return formatoEntero(x);
  }
}

// ---- Guard de números --------------------------------------------------------------------------------------------------------------------

const REF_RE = /\[[a-z0-9_]+\]/g;
const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;

function tokensNumericos(texto: string): string[] {
  return (texto.replace(REF_RE, " ").match(NUM_RE) ?? []).map((t) => t.replace(/,/g, "").replace(/\.0+$/, ""));
}

function textosDeEntrada(kpis: KpisResumen, hallazgos: readonly Hallazgo[]): string[] {
  const out: string[] = [kpis.periodo, kpis.comparadoContra, kpis.alcanceEtiqueta ?? ""];
  for (const v of [kpis.ventasNetas, kpis.pedidos, kpis.ticket, kpis.variacionVentas, kpis.descuentoPct, kpis.cancelacionPct, kpis.costoPorPedidoAgente, kpis.margenContribucion]) {
    if (!v) continue;
    out.push(mostrar(v) ?? "", mostrar(v, true) ?? "");
  }
  if (kpis.multiSucursal != null) out.push(textoMultiSucursal(kpis.multiSucursal) ?? "");
  if (kpis.mayorAporte) {
    out.push(kpis.mayorAporte.sucursal);
    if (kpis.mayorAporte.aportePct.valor != null) out.push(formatoPct(Math.abs(kpis.mayorAporte.aportePct.valor)));
  }
  for (const h of hallazgos) {
    out.push(h.titulo, h.cifraTexto, h.comparacion);
    if (h.impactoCentavos != null) out.push(formatoCentavos(h.impactoCentavos));
  }
  return out;
}

/** Números del texto que NO aparecen en la entrada. [] = todo respaldado. Se ignoran las referencias `[ventas_netas]`. */
export function numerosNoRespaldados(texto: string, kpis: KpisResumen, hallazgos: readonly Hallazgo[]): string[] {
  const permitidos = new Set(textosDeEntrada(kpis, hallazgos).flatMap(tokensNumericos));
  return tokensNumericos(texto).filter((t) => !permitidos.has(t));
}

// ---- Narrativa ---------------------------------------------------------------------------------------------------------------------------

export function narrarResumen(kpis: KpisResumen, hallazgos: readonly Hallazgo[], alcance: AlcanceSucursales): ResumenNarrado {
  const referencias: Record<string, string> = {};
  const registrar = (ref: string, v: ValorKpi, absoluto = false): string => {
    const m = mostrar(v, absoluto) as string;
    referencias[ref] = m;
    return `${m} [${ref}]`;
  };
  const candidatas: Array<OracionNarrativa & { prio: number }> = [];
  const add = (o: OracionNarrativa, prio: number): void => { candidatas.push({ ...o, prio }); };

  // Sin datos de ventas: una sola oración honesta.
  const ventas = mostrar(kpis.ventasNetas);
  if (ventas == null || (kpis.pedidos?.cifra.valor ?? 1) === 0) {
    const o = { texto: "No hay datos de ventas en el periodo seleccionado, así que no se puede resumir ni comparar.", refs: [] as string[] };
    return { oraciones: [o], texto: o.texto, referencias, numerosNoRespaldados: [], sinDatos: true };
  }

  const alc = kpis.alcanceEtiqueta ? ` (${kpis.alcanceEtiqueta})` : "";
  const quien = kpis.titularOrigen === "agente" ? "el agente vendió" : "el negocio vendió";
  const refs1 = ["ventas_netas"];
  let s1 = `En ${kpis.periodo}${alc}, ${quien} ${registrar("ventas_netas", kpis.ventasNetas)}`;
  if (kpis.pedidos && mostrar(kpis.pedidos) != null) { s1 += ` en ${registrar("pedidos", kpis.pedidos)} pedidos`; refs1.push("pedidos"); }
  if (kpis.ticket && mostrar(kpis.ticket) != null) { s1 += `, con un ticket promedio de ${registrar("ticket", kpis.ticket)}`; refs1.push("ticket"); }
  add({ texto: `${s1}.`, refs: refs1 }, 0);

  // Comparación
  const variacion = kpis.variacionVentas?.cifra.valor;
  if (kpis.variacionVentas && variacion != null) {
    if (variacion === 0) add({ texto: `Eso es igual que ${kpis.comparadoContra} [variacion_ventas].`, refs: ["variacion_ventas"] }, 0);
    else {
      referencias["variacion_ventas"] = mostrar(kpis.variacionVentas, true) as string;
      add({ texto: `Eso es ${mostrar(kpis.variacionVentas, true)} [variacion_ventas] ${variacion > 0 ? "más" : "menos"} que ${kpis.comparadoContra}.`, refs: ["variacion_ventas"] }, 0);
    }
  } else {
    add({ texto: "No hay un periodo de comparación con datos, así que no se calcula la variación.", refs: [] }, 0);
  }

  // Quién explica la variación
  const ap = kpis.mayorAporte;
  // Solo si la sucursal fue en el MISMO sentido que el total (aporte > 0); si no, «explica X % de la caída» sería falso.
  if (ap && ap.aportePct.valor != null && ap.aportePct.valor > 0 && variacion != null && variacion !== 0 && alcance.propertyIds.length > 1) {
    referencias["mayor_aporte"] = formatoPct(Math.abs(ap.aportePct.valor));
    add({ texto: `${ap.sucursal} explica ${formatoPct(Math.abs(ap.aportePct.valor))} [mayor_aporte] de ${variacion < 0 ? "la caída" : "el aumento"}.`, refs: ["mayor_aporte"] }, 2);
  }

  // Lo más importante
  const top = hallazgos.slice(0, 2);
  if (top.length === 0) {
    add({ texto: "No se detectaron hallazgos que requieran su atención en este periodo.", refs: [] }, 1);
  } else {
    top.forEach((h, i) => {
      const refs = [`hallazgo_${i + 1}`];
      let t = `${i === 0 ? "Lo más importante: " : "También: "}${h.titulo} [hallazgo_${i + 1}]`;
      referencias[`hallazgo_${i + 1}`] = h.cifraTexto;
      if (h.impactoCentavos != null) {
        t += `, con ${formatoCentavos(h.impactoCentavos)} [impacto_${i + 1}] en juego`;
        referencias[`impacto_${i + 1}`] = formatoCentavos(h.impactoCentavos);
        refs.push(`impacto_${i + 1}`);
      }
      add({ texto: `${t}.`, refs }, i === 0 ? 1 : 3);
    });
  }

  // Descuentos y cancelaciones
  const d = kpis.descuentoPct && mostrar(kpis.descuentoPct) != null ? kpis.descuentoPct : null;
  const c = kpis.cancelacionPct && mostrar(kpis.cancelacionPct) != null ? kpis.cancelacionPct : null;
  if (d && c) add({ texto: `Los descuentos fueron ${registrar("descuento_pct", d)} de la venta bruta y las cancelaciones ${registrar("cancelacion_pct", c)} de los pedidos.`, refs: ["descuento_pct", "cancelacion_pct"] }, 5);
  else if (d) add({ texto: `Los descuentos fueron ${registrar("descuento_pct", d)} de la venta bruta.`, refs: ["descuento_pct"] }, 5);
  else if (c) add({ texto: `Las cancelaciones fueron ${registrar("cancelacion_pct", c)} de los pedidos.`, refs: ["cancelacion_pct"] }, 5);

  // Clientes en más de una sucursal (no aditivo)
  if (kpis.multiSucursal != null && kpis.multiSucursal > 0 && alcance.propertyIds.length > 1) {
    referencias["multi_sucursal"] = formatoEntero(kpis.multiSucursal);
    add({ texto: `${textoMultiSucursal(kpis.multiSucursal)} [multi_sucursal].`, refs: ["multi_sucursal"] }, 3);
  }

  // Margen de contribución
  if (kpis.margenContribucion && mostrar(kpis.margenContribucion) != null) {
    add({
      texto: `El margen de contribución es ${registrar("margen_contribucion", kpis.margenContribucion)}${kpis.margenParcial ? ", parcial porque faltan costos por capturar" : ""}.`,
      refs: ["margen_contribucion"],
    }, 4);
  }

  if (!alcance.organizacionCompleta) add({ texto: "Las cifras corresponden solo a las sucursales que usted administra.", refs: [] }, 1);

  // 3 a 6 oraciones: se conservan las de mayor prioridad (menor número) en su orden natural; cada una pasa el guard de números.
  const validas = candidatas.filter((o) => numerosNoRespaldados(o.texto, kpis, hallazgos).length === 0);
  const elegidas = new Set([...validas].map((o, idx) => ({ o, idx })).sort((a, b) => a.o.prio - b.o.prio || a.idx - b.idx).slice(0, 6).map((x) => x.o));
  const aprobadas: OracionNarrativa[] = validas.filter((o) => elegidas.has(o)).map(({ texto, refs }) => ({ texto, refs }));
  const texto = aprobadas.map((o) => o.texto).join(" ");
  return { oraciones: aprobadas, texto, referencias, numerosNoRespaldados: numerosNoRespaldados(texto, kpis, hallazgos), sinDatos: false };
}
