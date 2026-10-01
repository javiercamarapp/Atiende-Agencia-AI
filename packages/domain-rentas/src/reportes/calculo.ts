// Rn-03 -- cálculo puro del reporte de ocupación e ingresos por unidad, propietario,
// canal y mes. Sin IO, determinista.
//
// Anti doble conteo (las tres formas reales de contar dos veces lo mismo):
//  1. Reserva que cruza meses: cada noche pertenece a UN mes ('YYYY-MM' de la noche) y el
//     dinero de la reserva se reparte entre sus noches (reparto exacto por resto mayor,
//     la suma de las partes es SIEMPRE el total). Los totales por unidad/propietario/
//     canal no cuentan una reserva dos veces; las `llegadas` cuentan en el mes de check-in.
//  2. Misma noche por dos reservas (p. ej. el mismo huésped llegado por dos canales): la
//     base de datos lo impide con el EXCLUDE de rentas.ocupacion sobre reservas
//     confirmadas, y la consulta solo trae `confirmado`; aquí además, por defensa en
//     profundidad, una noche de una unidad se cuenta UNA sola vez (gana la reserva de
//     check-in más antiguo, desempate por creación e id) y se reporta en advertencias.
//  3. Filas repetidas del mismo `ocupacionId` (un JOIN mal hecho): solo la primera cuenta.
//
// Fechas: `FechaLocal` 'YYYY-MM-DD' de calendario puro (daterange de Postgres), sin zona
// horaria de por medio -- America/Merida o cualquier otra no cambia a qué mes pertenece
// una noche. La zona solo se usa para decidir "hoy" al elegir un periodo por defecto
// (ver ./periodo.ts).
import { calcularNoches, esRangoValido, nochesDelRango, sumarDias } from "../fechas.ts";
import type { FechaLocal } from "../tipos.ts";
import {
  MAX_NOCHES_REPORTE,
  type AdvertenciasReporte,
  type EntradaReporte,
  type FilaDetalleReporte,
  type GrupoReporte,
  type MetricasReporte,
  type ReservaParaReporte,
  type ResultadoReporte,
  type UnidadParaReporte,
} from "./tipos.ts";

export const CANAL_SIN_CODIGO = "manual";
export const PROPIETARIO_SIN_ASIGNAR = "sin_propietario";

/** Reparte `total` centavos (puede ser negativo) en `partes` enteros cuya suma es
 * exactamente `total`: base + 1 centavo a las primeras `resto` partes. */
export function repartirCentavos(total: number, partes: number): number[] {
  if (!Number.isInteger(total)) throw new Error(`repartirCentavos: total no entero (${total}).`);
  if (!Number.isInteger(partes) || partes < 1) throw new Error(`repartirCentavos: partes inválidas (${partes}).`);
  const signo = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / partes);
  const resto = abs % partes;
  return Array.from({ length: partes }, (_, i) => signo * (base + (i < resto ? 1 : 0)));
}

interface Acumulador {
  llegadas: number;
  nochesOcupadas: number;
  nochesDisponibles: number | null;
  bruto: number;
  comisionCanal: number;
  comisionGestor: number;
  gastos: number;
  impuestos: number;
  neto: number;
}

const nuevoAcumulador = (conDisponibles: boolean): Acumulador => ({
  llegadas: 0,
  nochesOcupadas: 0,
  nochesDisponibles: conDisponibles ? 0 : null,
  bruto: 0,
  comisionCanal: 0,
  comisionGestor: 0,
  gastos: 0,
  impuestos: 0,
  neto: 0,
});

function aMetricas(a: Acumulador): MetricasReporte {
  const ocupacionBasisPoints =
    a.nochesDisponibles === null ? null : a.nochesDisponibles === 0 ? 0 : Math.round((a.nochesOcupadas * 10000) / a.nochesDisponibles);
  // half-up en centavos enteros (bruto >= 0 en la práctica; para negativos redondea hacia cero).
  const adrCentavos = a.nochesOcupadas === 0 ? 0 : Math.floor((a.bruto * 2 + a.nochesOcupadas) / (a.nochesOcupadas * 2));
  return {
    llegadas: a.llegadas,
    nochesOcupadas: a.nochesOcupadas,
    nochesDisponibles: a.nochesDisponibles,
    ocupacionBasisPoints,
    ingresoBrutoCentavos: a.bruto,
    comisionCanalCentavos: a.comisionCanal,
    comisionGestorCentavos: a.comisionGestor,
    gastosCentavos: a.gastos,
    impuestosCentavos: a.impuestos,
    netoCentavos: a.neto,
    adrCentavos,
  };
}

/** Meses ('YYYY-MM') del periodo con sus noches disponibles dentro del periodo. */
function nochesPorMesDelPeriodo(desde: FechaLocal, hasta: FechaLocal): Map<string, number> {
  const porMes = new Map<string, number>();
  for (const noche of nochesDelRango({ inicio: desde, fin: hasta })) {
    const mes = noche.slice(0, 7);
    porMes.set(mes, (porMes.get(mes) ?? 0) + 1);
  }
  return porMes;
}

function compararReservas(a: ReservaParaReporte, b: ReservaParaReporte): number {
  if (a.inicio !== b.inicio) return a.inicio < b.inicio ? -1 : 1;
  if (a.creadaEn !== b.creadaEn) return a.creadaEn < b.creadaEn ? -1 : 1;
  return a.ocupacionId < b.ocupacionId ? -1 : a.ocupacionId > b.ocupacionId ? 1 : 0;
}

export function generarReporteOcupacionIngresos(entrada: EntradaReporte): ResultadoReporte {
  const { periodo, moneda } = entrada;
  if (!esRangoValido(periodo)) throw new Error(`Periodo inválido: [${periodo.inicio}, ${periodo.fin}).`);
  if (calcularNoches(periodo) > MAX_NOCHES_REPORTE) {
    throw new Error(`El periodo excede ${MAX_NOCHES_REPORTE} noches.`);
  }

  const unidades = new Map<string, UnidadParaReporte>(entrada.unidades.map((u) => [u.id, u]));
  const nochesMes = nochesPorMesDelPeriodo(periodo.inicio, periodo.fin);
  const nochesPeriodo = calcularNoches(periodo);

  // Cubo mes x unidad x canal (solo celdas con actividad).
  const cubo = new Map<string, { mes: string; unidadId: string; canal: string; a: Acumulador }>();
  const celda = (mes: string, unidadId: string, canal: string) => {
    const k = `${mes}|${unidadId}|${canal}`;
    let c = cubo.get(k);
    if (!c) {
      c = { mes, unidadId, canal, a: nuevoAcumulador(false) };
      cubo.set(k, c);
    }
    return c.a;
  };

  const advertencias = { reservasSinMovimientoFinanciero: 0, reservasMonedaDistinta: 0, nochesSolapadasOmitidas: 0, reservasDuplicadasOmitidas: 0 };
  const vistas = new Set<string>();
  const nochesReclamadas = new Map<string, Set<string>>(); // unidadId -> noches ya contadas

  const reservas = [...entrada.reservas].sort(compararReservas);
  for (const r of reservas) {
    if (vistas.has(r.ocupacionId)) {
      advertencias.reservasDuplicadasOmitidas += 1;
      continue;
    }
    vistas.add(r.ocupacionId);
    if (!unidades.has(r.unidadId) || !esRangoValido({ inicio: r.inicio, fin: r.fin })) continue;

    const nochesEstancia = nochesDelRango({ inicio: r.inicio, fin: r.fin });
    const total = nochesEstancia.length;
    const fin = r.financiero;
    const monedaOk = fin !== null && fin.moneda === moneda;
    const reparto = monedaOk
      ? {
          bruto: repartirCentavos(fin.brutoCentavos, total),
          comisionCanal: repartirCentavos(fin.comisionCanalCentavos, total),
          comisionGestor: repartirCentavos(fin.comisionGestorCentavos, total),
          gastos: repartirCentavos(fin.gastosCentavos, total),
          impuestos: repartirCentavos(fin.impuestosCentavos, total),
          neto: repartirCentavos(fin.netoCentavos, total),
        }
      : null;

    let reclamadas = nochesReclamadas.get(r.unidadId);
    if (!reclamadas) {
      reclamadas = new Set();
      nochesReclamadas.set(r.unidadId, reclamadas);
    }

    let nochesContadas = 0;
    nochesEstancia.forEach((noche, i) => {
      if (noche < periodo.inicio || noche >= periodo.fin) return; // fuera del periodo: no es de este reporte
      if (reclamadas.has(noche)) {
        advertencias.nochesSolapadasOmitidas += 1;
        return;
      }
      reclamadas.add(noche);
      nochesContadas += 1;
      const a = celda(noche.slice(0, 7), r.unidadId, r.canal);
      a.nochesOcupadas += 1;
      if (reparto) {
        a.bruto += reparto.bruto[i]!;
        a.comisionCanal += reparto.comisionCanal[i]!;
        a.comisionGestor += reparto.comisionGestor[i]!;
        a.gastos += reparto.gastos[i]!;
        a.impuestos += reparto.impuestos[i]!;
        a.neto += reparto.neto[i]!;
      }
    });

    if (nochesContadas > 0) {
      if (fin === null) advertencias.reservasSinMovimientoFinanciero += 1;
      else if (!monedaOk) advertencias.reservasMonedaDistinta += 1;
    }
    // Llegada: una sola vez, en el mes del check-in, y solo si cae dentro del periodo y la
    // reserva contó al menos una noche (no una reserva totalmente solapada/omitida).
    if (nochesContadas > 0 && r.inicio >= periodo.inicio && r.inicio < periodo.fin) {
      celda(r.inicio.slice(0, 7), r.unidadId, r.canal).llegadas += 1;
    }
  }

  // ---- Detalle ordenado (mes, unidad nombre, canal) ----
  const detalle: FilaDetalleReporte[] = [...cubo.values()]
    .map((c) => {
      const u = unidades.get(c.unidadId)!;
      return { mes: c.mes, unidadId: u.id, unidadNombre: u.nombre, ownerId: u.ownerId, ownerNombre: u.ownerNombre, canal: c.canal, ...aMetricas(c.a) };
    })
    .sort((a, b) => a.mes.localeCompare(b.mes) || a.unidadNombre.localeCompare(b.unidadNombre) || a.unidadId.localeCompare(b.unidadId) || a.canal.localeCompare(b.canal));

  // ---- Agrupaciones ----
  const sumar = (a: Acumulador, f: FilaDetalleReporte) => {
    a.llegadas += f.llegadas;
    a.nochesOcupadas += f.nochesOcupadas;
    a.bruto += f.ingresoBrutoCentavos;
    a.comisionCanal += f.comisionCanalCentavos;
    a.comisionGestor += f.comisionGestorCentavos;
    a.gastos += f.gastosCentavos;
    a.impuestos += f.impuestosCentavos;
    a.neto += f.netoCentavos;
  };

  const agrupar = (clave: (f: FilaDetalleReporte) => { clave: string; etiqueta: string }, disponibles: ((clave: string) => number) | null, universo: { clave: string; etiqueta: string }[]): GrupoReporte[] => {
    const mapa = new Map<string, { etiqueta: string; a: Acumulador }>();
    for (const u of universo) mapa.set(u.clave, { etiqueta: u.etiqueta, a: nuevoAcumulador(disponibles !== null) });
    for (const f of detalle) {
      const k = clave(f);
      let g = mapa.get(k.clave);
      if (!g) {
        g = { etiqueta: k.etiqueta, a: nuevoAcumulador(disponibles !== null) };
        mapa.set(k.clave, g);
      }
      sumar(g.a, f);
    }
    return [...mapa.entries()]
      .map(([k, g]) => {
        if (disponibles) g.a.nochesDisponibles = disponibles(k);
        return { clave: k, etiqueta: g.etiqueta, ...aMetricas(g.a) };
      })
      .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta) || a.clave.localeCompare(b.clave));
  };

  const listaUnidades = [...unidades.values()];
  const unidadesPorOwner = new Map<string, number>();
  for (const u of listaUnidades) unidadesPorOwner.set(u.ownerId ?? PROPIETARIO_SIN_ASIGNAR, (unidadesPorOwner.get(u.ownerId ?? PROPIETARIO_SIN_ASIGNAR) ?? 0) + 1);

  const porUnidad = agrupar((f) => ({ clave: f.unidadId, etiqueta: f.unidadNombre }), () => nochesPeriodo, listaUnidades.map((u) => ({ clave: u.id, etiqueta: u.nombre })));
  const porPropietario = agrupar(
    (f) => ({ clave: f.ownerId ?? PROPIETARIO_SIN_ASIGNAR, etiqueta: f.ownerNombre ?? "Sin propietario" }),
    (k) => (unidadesPorOwner.get(k) ?? 0) * nochesPeriodo,
    [...new Map(listaUnidades.map((u) => [u.ownerId ?? PROPIETARIO_SIN_ASIGNAR, { clave: u.ownerId ?? PROPIETARIO_SIN_ASIGNAR, etiqueta: u.ownerNombre ?? "Sin propietario" }])).values()],
  );
  const porCanal = agrupar((f) => ({ clave: f.canal, etiqueta: f.canal }), null, []);
  const porMes = agrupar((f) => ({ clave: f.mes, etiqueta: f.mes }), (k) => listaUnidades.length * (nochesMes.get(k) ?? 0), [...nochesMes.keys()].map((m) => ({ clave: m, etiqueta: m })));

  const total = nuevoAcumulador(true);
  total.nochesDisponibles = listaUnidades.length * nochesPeriodo;
  for (const f of detalle) sumar(total, f);

  const advertenciasFinal: AdvertenciasReporte = advertencias;
  return {
    periodo,
    moneda,
    totales: aMetricas(total),
    porUnidad,
    porPropietario,
    porCanal,
    porMes,
    detalle,
    advertencias: advertenciasFinal,
  };
}

/** Periodo por defecto: el mes calendario que contiene `hoy` -> [primer día, primer día del mes siguiente). */
export function mesCalendarioDe(hoy: FechaLocal): { inicio: FechaLocal; fin: FechaLocal } {
  const inicio = `${hoy.slice(0, 7)}-01`;
  let fin = sumarDias(inicio, 31);
  fin = `${fin.slice(0, 7)}-01`;
  return { inicio, fin };
}
