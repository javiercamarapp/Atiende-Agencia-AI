// Modelo de presentacion del tablero «Turno de hoy» (PLAN-PANEL-OPERADOR §2.5 y boceto D). Funcion pura: recibe lo que mando el servidor y devuelve
// las tarjetas con su valor o, si falta el dato, el MOTIVO por el que no se muestra. Regla de la casa: nunca un 0 inventado; un 0 solo sale cuando
// el servidor lo midio (p. ej. 0 cancelados). Lo que el contrato aun no trae (hora pico) queda en «—» con su motivo.
import { etiquetasTraducidas, formatMoney, traductorActivo } from "@atiende/ui";
import { restaurantesOperacion } from "@atiende/ui/i18n/restaurantes/operacion";
import { fechaHoraEsMx, horaEsMx } from "../../../lib/formato-fecha.ts";
import type { OperacionHoy } from "@atiende/domain-restaurantes/operacion";
import { SEMAFORO_EN_CAMINO_ROJO_MIN } from "@atiende/domain-restaurantes/operacion";

const tr = traductorActivo(restaurantesOperacion);

export type ClaveTarjeta = "pedidos" | "ventas" | "ticket" | "puntuales" | "entrega" | "cancelados" | "horaPico" | "choferTop";

export interface TarjetaTurno {
  readonly clave: ClaveTarjeta;
  readonly label: string;
  readonly value: string;
  readonly nota?: string;
  /** Motivo por el que no hay cifra; si existe, la tarjeta muestra «—» con esta explicacion. */
  readonly sinDato?: string;
}

/** Zona del negocio (Merida): el corte se muestra SIEMPRE en ella, nunca en la zona del navegador de quien mira. */
export const ZONA_NEGOCIO = "America/Merida";

/** «21 oct 2026, 6:00 p.m. – 2:00 a.m. (hora de Mérida)»: el corte que devolvio el servidor, sin reinterpretarlo en la zona local. */
export function etiquetaCorte(corte: OperacionHoy["corte"]): string {
  return tr("restaurantes.operacion.turno.corteZona", { desde: fechaHoraEsMx(corte.desde, ZONA_NEGOCIO), hasta: horaEsMx(corte.hasta, ZONA_NEGOCIO) });
}

/** Etiqueta del canal en el idioma activo (i18n): cada lectura traduce; un canal desconocido se muestra tal cual. */
export const ETIQUETA_CANAL: Readonly<Record<string, string>> = etiquetasTraducidas(
  ["whatsapp", "voz", "llamada", "mostrador", "web"] as const,
  (c) => `restaurantes.operacion.canal.${c}` as const,
  restaurantesOperacion,
);
export const etiquetaCanal = (c: string): string => ETIQUETA_CANAL[c] ?? c;

const dinero = (n: number) => `$${formatMoney(n)}`;
const min = (n: number) => tr("restaurantes.operacion.minutos", { min: Math.round(n) });

export function tarjetasTurno(h: OperacionHoy): readonly TarjetaTurno[] {
  const sinPedidos = h.pedidos.total === 0;
  const entregados = h.pedidos.porEstado.entregado ?? 0;
  const enCurso = (h.pedidos.porEstado.pending ?? 0) + (h.pedidos.porEstado.preparando ?? 0) + (h.pedidos.porEstado.en_camino ?? 0);
  const { pct, evaluados, umbralMin } = h.puntuales;
  const choferes = h.efectivoPorChofer.choferes;
  const top = h.efectivoPorChofer.disponible ? [...choferes].sort((a, b) => b.entregas - a.entregas)[0] : undefined;
  const motivosCancel = Object.entries(h.cancelados.porMotivo).filter(([, n]) => n > 0).map(([m, n]) => `${m.replace(/_/g, " ")}: ${n}`);

  return [
    { clave: "pedidos", label: tr("restaurantes.operacion.turno.pedidos"), value: String(h.pedidos.total), nota: sinPedidos ? tr("restaurantes.operacion.turno.sinPedidos") : tr("restaurantes.operacion.turno.enCurso", { n: enCurso }) },
    { clave: "ventas", label: tr("restaurantes.operacion.turno.ventas"), value: dinero(h.ventas), nota: tr("restaurantes.operacion.turno.sinCancelados"), ...(sinPedidos ? { sinDato: tr("restaurantes.operacion.turno.sinPedidosPunto") } : {}) },
    { clave: "ticket", label: tr("restaurantes.operacion.turno.ticket"), value: dinero(h.ticketPromedio), ...(sinPedidos ? { sinDato: tr("restaurantes.operacion.turno.sinPedidosPunto") } : {}) },
    {
      clave: "puntuales", label: tr("restaurantes.operacion.turno.aTiempo"), value: pct === null ? "—" : `${Math.round(pct)}%`,
      nota: `${tr("restaurantes.operacion.turno.entregasEvaluadas", { count: evaluados })} · ${umbralMin.domicilio}/${umbralMin.recoger} min`,
      ...(pct === null || evaluados === 0 ? { sinDato: tr("restaurantes.operacion.turno.sinEntregasEvaluar") } : {}),
    },
    {
      clave: "entrega", label: tr("restaurantes.operacion.turno.entregaPromedio"), value: h.tiempos.entregaMinProm === null ? "—" : min(h.tiempos.entregaMinProm),
      ...(h.tiempos.entregaMinP90 !== null ? { nota: tr("restaurantes.operacion.turno.p90", { min: min(h.tiempos.entregaMinP90) }) } : {}),
      ...(h.tiempos.entregaMinProm === null
        ? { sinDato: tr(entregados === 0 ? "restaurantes.operacion.turno.sinEntregas" : "restaurantes.operacion.turno.faltaSalida") }
        : {}),
    },
    { clave: "cancelados", label: tr("restaurantes.operacion.turno.cancelados"), value: String(h.cancelados.total), nota: motivosCancel.length ? motivosCancel.join(" · ") : tr("restaurantes.operacion.turno.sinCancelaciones") },
    { clave: "horaPico", label: tr("restaurantes.operacion.turno.horaPico"), value: "—", sinDato: tr("restaurantes.operacion.turno.horaPicoSinDato") },
    {
      clave: "choferTop", label: tr("restaurantes.operacion.turno.choferTop"), value: top ? top.nombre : "—",
      ...(top ? { nota: tr("restaurantes.operacion.turno.entregas", { count: top.entregas }) } : { sinDato: tr(h.efectivoPorChofer.disponible ? "restaurantes.operacion.turno.sinEntregasChoferes" : "restaurantes.operacion.turno.choferNoDisponible") }),
    },
  ];
}

export interface CanalTurno {
  readonly canal: string;
  readonly etiqueta: string;
  readonly total: number;
  readonly porcentaje: number;
}

/** Canales con al menos un pedido, de mayor a menor, con su parte del total (para la barra apilada). */
export function canalesTurno(porCanal: Readonly<Record<string, number>>): readonly CanalTurno[] {
  const entradas = Object.entries(porCanal).filter(([, n]) => n > 0);
  const suma = entradas.reduce((s, [, n]) => s + n, 0);
  return entradas.sort((a, b) => b[1] - a[1]).map(([canal, total]) => ({ canal, etiqueta: etiquetaCanal(canal), total, porcentaje: suma > 0 ? Math.round((total / suma) * 100) : 0 }));
}

export interface AlertaTurno {
  readonly pedidoId: string;
  readonly texto: string;
  readonly critica: boolean;
}

/** «En camino» de mas de 90 min (rojo, critica) y pedidos sin aceptar. Las criticas van primero. */
export function alertasTurno(a: OperacionHoy["alertas"]): readonly AlertaTurno[] {
  const rojas = a.enCaminoMas90.filter((x) => x.minutos > SEMAFORO_EN_CAMINO_ROJO_MIN).map((x) => ({ pedidoId: x.pedidoId, texto: tr("restaurantes.operacion.turno.alertaEnCamino", { numero: String(x.numero), min: Math.round(x.minutos) }), critica: true }));
  const sin = a.sinAceptar.map((x) => ({ pedidoId: x.pedidoId, texto: tr("restaurantes.operacion.turno.alertaSinAceptar", { numero: String(x.numero), min: Math.round(x.minutos) }), critica: false }));

  return [...rojas, ...sin];
}
