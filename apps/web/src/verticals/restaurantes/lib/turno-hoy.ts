// Modelo de presentacion del tablero «Turno de hoy» (PLAN-PANEL-OPERADOR §2.5 y boceto D). Funcion pura: recibe lo que mando el servidor y devuelve
// las tarjetas con su valor o, si falta el dato, el MOTIVO por el que no se muestra. Regla de la casa: nunca un 0 inventado; un 0 solo sale cuando
// el servidor lo midio (p. ej. 0 cancelados). Lo que el contrato aun no trae (hora pico) queda en «—» con su motivo.
import { formatMoney } from "@atiende/ui";
import type { OperacionHoy } from "@atiende/domain-restaurantes/operacion";
import { SEMAFORO_EN_CAMINO_ROJO_MIN } from "@atiende/domain-restaurantes/operacion";

export type ClaveTarjeta = "pedidos" | "ventas" | "ticket" | "puntuales" | "entrega" | "cancelados" | "horaPico" | "choferTop";

export interface TarjetaTurno {
  readonly clave: ClaveTarjeta;
  readonly label: string;
  readonly value: string;
  readonly nota?: string;
  /** Motivo por el que no hay cifra; si existe, la tarjeta muestra «—» con esta explicacion. */
  readonly sinDato?: string;
}

export const ETIQUETA_CANAL: Readonly<Record<string, string>> = { whatsapp: "WhatsApp", voz: "Voz", llamada: "Llamada", mostrador: "Mostrador", web: "Web" };
export const etiquetaCanal = (c: string): string => ETIQUETA_CANAL[c] ?? c;

const dinero = (n: number) => `$${formatMoney(n)}`;
const min = (n: number) => `${Math.round(n)} min`;
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

export function tarjetasTurno(h: OperacionHoy): readonly TarjetaTurno[] {
  const sinPedidos = h.pedidos.total === 0;
  const enCurso = (h.pedidos.porEstado.pending ?? 0) + (h.pedidos.porEstado.preparando ?? 0) + (h.pedidos.porEstado.en_camino ?? 0);
  const { pct, evaluados, umbralMin } = h.puntuales;
  const choferes = h.efectivoPorChofer.choferes;
  const top = h.efectivoPorChofer.disponible ? [...choferes].sort((a, b) => b.entregas - a.entregas)[0] : undefined;
  const motivosCancel = Object.entries(h.cancelados.porMotivo).filter(([, n]) => n > 0).map(([m, n]) => `${m.replace(/_/g, " ")}: ${n}`);

  return [
    { clave: "pedidos", label: "Pedidos", value: String(h.pedidos.total), nota: sinPedidos ? "Aún no hay pedidos en este corte" : `${enCurso} en curso` },
    { clave: "ventas", label: "Ventas", value: dinero(h.ventas), nota: "Sin cancelados", ...(sinPedidos ? { sinDato: "Aún no hay pedidos en este corte." } : {}) },
    { clave: "ticket", label: "Ticket promedio", value: dinero(h.ticketPromedio), ...(sinPedidos ? { sinDato: "Aún no hay pedidos en este corte." } : {}) },
    {
      clave: "puntuales", label: "A tiempo", value: pct === null ? "—" : `${Math.round(pct)}%`,
      nota: `${plural(evaluados, "entrega evaluada", "entregas evaluadas")} · ${umbralMin.domicilio}/${umbralMin.recoger} min`,
      ...(pct === null || evaluados === 0 ? { sinDato: "Aún no hay entregas que evaluar." } : {}),
    },
    {
      clave: "entrega", label: "Entrega promedio", value: h.tiempos.entregaMinProm === null ? "—" : min(h.tiempos.entregaMinProm),
      ...(h.tiempos.entregaMinP90 !== null ? { nota: `9 de cada 10 llegan en ${min(h.tiempos.entregaMinP90)} o menos` } : {}),
      ...(h.tiempos.entregaMinProm === null ? { sinDato: "Disponible tras actualizar la base: falta registrar la hora de salida." } : {}),
    },
    { clave: "cancelados", label: "Cancelados", value: String(h.cancelados.total), nota: motivosCancel.length ? motivosCancel.join(" · ") : "Sin cancelaciones" },
    { clave: "horaPico", label: "Hora pico", value: "—", sinDato: "El servidor todavía no calcula la hora pico." },
    {
      clave: "choferTop", label: "Chofer con más entregas", value: top ? top.nombre : "—",
      ...(top ? { nota: plural(top.entregas, "entrega", "entregas") } : { sinDato: h.efectivoPorChofer.disponible ? "Aún no hay entregas de choferes." : "Disponible tras actualizar la base (registro de cobros por chofer)." }),
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
  const rojas = a.enCaminoMas90.filter((x) => x.minutos > SEMAFORO_EN_CAMINO_ROJO_MIN).map((x) => ({ pedidoId: x.pedidoId, texto: `#${x.numero} lleva ${Math.round(x.minutos)} min en camino`, critica: true }));
  const sin = a.sinAceptar.map((x) => ({ pedidoId: x.pedidoId, texto: `#${x.numero} sin aceptar hace ${Math.round(x.minutos)} min`, critica: false }));
  return [...rojas, ...sin];
}
