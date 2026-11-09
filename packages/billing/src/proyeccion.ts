// ═══════════════════════════════════════════════════════════════════════════
// PROYECCIÓN DE CIERRE DE MES — a partir del ritmo diario del mes en curso.
//
// Central: lo usado al día de hoy / días transcurridos × días del mes (ritmo
// promedio). Rango: lo usado + días que faltan × ritmo diario bajo/alto, donde
// bajo y alto son los percentiles 25 y 75 de los días COMPLETOS ya cerrados
// (con menos de 3 días cerrados no hay rango confiable: bajo = alto = central).
// La factura proyectada se calcula con el MISMO motor que la factura real
// (`calcularFacturaPlanMedido`), así que proyección y cobro nunca divergen en
// reglas: solo en el uso que se les pasa.
// ═══════════════════════════════════════════════════════════════════════════

import { calcularFacturaPlanMedido, type FacturaPlanMedido, type TarifaPlanMedido } from './plan-medido.ts';

export interface DiaDeUso {
  /** `YYYY-MM-DD` en la zona del negocio. */
  dia: string;
  segundosVoz: number;
  conversacionesWa: number;
}

export interface RangoProyectado {
  bajo: number;
  central: number;
  alto: number;
}

export interface ProyeccionMes {
  diasDelMes: number;
  /** Días transcurridos con fracción del día en curso (p. ej. 6.5). */
  diasTranscurridos: number;
  diasCompletos: number;
  minutosVoz: RangoProyectado;
  conversacionesWa: RangoProyectado;
  /** Facturas con el uso bajo/central/alto. null si la tarifa no se puede facturar (p. ej. «a cotizar»). */
  factura: { bajo: FacturaPlanMedido; central: FacturaPlanMedido; alto: FacturaPlanMedido } | null;
  /** Hay menos de 3 días completos: el rango no es confiable y se muestra solo el central. */
  rangoConfiable: boolean;
}

function percentil(valores: readonly number[], p: number): number {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  const idx = (ordenados.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return ordenados[lo]! + (ordenados[hi]! - ordenados[lo]!) * (idx - lo);
}

function rango(usadoHoy: number, diasTranscurridos: number, diasDelMes: number, diarioCompleto: readonly number[], confiable: boolean): RangoProyectado {
  const restantes = Math.max(diasDelMes - diasTranscurridos, 0);
  const central = diasTranscurridos > 0 ? (usadoHoy / diasTranscurridos) * diasDelMes : usadoHoy;
  if (!confiable) return { bajo: Math.round(central), central: Math.round(central), alto: Math.round(central) };
  const bajo = usadoHoy + restantes * percentil(diarioCompleto, 0.25);
  const alto = usadoHoy + restantes * percentil(diarioCompleto, 0.75);
  return { bajo: Math.round(Math.min(bajo, central)), central: Math.round(central), alto: Math.round(Math.max(alto, central)) };
}

/**
 * @param dias serie del mes completo (un elemento por día del mes, en orden), con el uso de cada día.
 * @param hoy  día del mes en curso (`YYYY-MM-DD`, zona del negocio) y fracción transcurrida de ese día (0-1).
 */
export function proyectarMes(
  tarifa: TarifaPlanMedido | null,
  sucursalesActivas: number,
  dias: readonly DiaDeUso[],
  hoy: { dia: string; fraccion: number },
): ProyeccionMes {
  const diasDelMes = dias.length;
  const idxHoy = dias.findIndex((d) => d.dia === hoy.dia);
  // Mes ya cerrado (consulta histórica): todo transcurrido. Mes futuro: nada.
  const mesCerrado = idxHoy === -1 && dias.length > 0 && hoy.dia > dias[dias.length - 1]!.dia;
  const diasCompletos = mesCerrado ? diasDelMes : Math.max(idxHoy, 0);
  const fraccion = Math.min(Math.max(hoy.fraccion, 0), 1);
  const diasTranscurridos = mesCerrado ? diasDelMes : idxHoy === -1 ? 0 : idxHoy + fraccion;
  const hastaHoy = mesCerrado ? dias : idxHoy === -1 ? [] : dias.slice(0, idxHoy + 1);
  const completos = dias.slice(0, diasCompletos);

  const minutosHoy = hastaHoy.reduce((s, d) => s + d.segundosVoz, 0) / 60;
  const convHoy = hastaHoy.reduce((s, d) => s + d.conversacionesWa, 0);
  const confiable = mesCerrado || diasCompletos >= 3;

  const minutosVoz = mesCerrado
    ? { bajo: Math.ceil(minutosHoy), central: Math.ceil(minutosHoy), alto: Math.ceil(minutosHoy) }
    : rango(minutosHoy, diasTranscurridos, diasDelMes, completos.map((d) => d.segundosVoz / 60), confiable);
  const conversacionesWa = mesCerrado
    ? { bajo: convHoy, central: convHoy, alto: convHoy }
    : rango(convHoy, diasTranscurridos, diasDelMes, completos.map((d) => d.conversacionesWa), confiable);

  let factura: ProyeccionMes['factura'] = null;
  if (tarifa && tarifa.modeloCobro === 'medido') {
    try {
      const f = (k: keyof RangoProyectado) => calcularFacturaPlanMedido(tarifa, { sucursalesActivas, minutosVoz: minutosVoz[k], conversacionesWa: conversacionesWa[k] });
      factura = { bajo: f('bajo'), central: f('central'), alto: f('alto') };
    } catch {
      factura = null;
    }
  }
  return { diasDelMes, diasTranscurridos, diasCompletos, minutosVoz, conversacionesWa, factura, rangoConfiable: confiable };
}

/** Umbral de bolsa cruzado por el uso (80, 100 o el de uso justo), o null. El más alto que aplique. */
export function umbralBolsa(usado: number, incluido: number, usoJustoPct: number | null): 80 | 100 | 150 | null {
  if (incluido <= 0) return null;
  const pct = (usado / incluido) * 100;
  if (usoJustoPct !== null && pct > usoJustoPct) return 150;
  if (pct >= 100) return 100;
  if (pct >= 80) return 80;
  return null;
}
