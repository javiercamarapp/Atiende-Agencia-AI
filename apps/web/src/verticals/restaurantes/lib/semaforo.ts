// Semaforo de tiempo del panel movil del operador (PLAN-PANEL-OPERADOR §5.3). Funciones puras, sin DOM ni red.
//
// Regla oficial (decisión del dueño): el tiempo prometido es 65 min a domicilio y 35 al recoger; verde hasta el 70 % del
// prometido, amarillo hasta el 100 %, rojo despues. Un pedido sin aceptar pasa a amarillo a los 3 min y a rojo a los 5. «En camino»
// cuenta desde la salida y se pone rojo a los 90 min. Las constantes se redeclaran aqui (apps/web no importa codigo de los paquetes
// domain-*) y una prueba las compara con las del contrato `@atiende/domain-restaurantes/operacion` para que no se desfasen.
import type { CanalPedidoOperacion, EstadoPanel, Semaforo } from "@atiende/domain-restaurantes/operacion";

export const MINUTOS_PROMETIDOS: Readonly<Record<CanalPedidoOperacion, number>> = { domicilio: 65, recoger: 35 };
export const FRACCION_AMARILLO = 0.7;
export const EN_CAMINO_ROJO_MIN = 90;
export const SIN_ACEPTAR_AMARILLO_MIN = 3;
export const SIN_ACEPTAR_ROJO_MIN = 5;

const ORDEN: Readonly<Record<Semaforo, number>> = { verde: 0, amarillo: 1, rojo: 2 };

function peor(a: Semaforo, b: Semaforo): Semaforo {
  return ORDEN[a] >= ORDEN[b] ? a : b;
}

/** Minutos enteros transcurridos desde `iso` (0 si la fecha no es valida o esta en el futuro). */
export function minutosDesde(iso: string | null | undefined, ahoraMs: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((ahoraMs - t) / 60_000));
}

/** Color del semaforo para un pedido con `minutos` transcurridos (desde que se creo; desde que salio si esta en camino). */
export function semaforoPedido(estado: EstadoPanel, canal: CanalPedidoOperacion, minutos: number): Semaforo {
  const m = Math.max(0, minutos);
  if (estado === "en_camino") {
    if (m >= EN_CAMINO_ROJO_MIN) return "rojo";
    return m >= MINUTOS_PROMETIDOS.domicilio * FRACCION_AMARILLO ? "amarillo" : "verde";
  }
  const prometido = MINUTOS_PROMETIDOS[canal];
  let color: Semaforo = m > prometido ? "rojo" : m >= prometido * FRACCION_AMARILLO ? "amarillo" : "verde";
  if (estado === "pending") {
    const sinAceptar: Semaforo = m > SIN_ACEPTAR_ROJO_MIN ? "rojo" : m > SIN_ACEPTAR_AMARILLO_MIN ? "amarillo" : "verde";
    color = peor(color, sinAceptar);
  }
  return color;
}

export const ETIQUETA_SEMAFORO: Readonly<Record<Semaforo, string>> = { verde: "A tiempo", amarillo: "Por vencer", rojo: "Atrasado" };

/** «12 min» / «1 h 05 min» (el texto acompana siempre al color: el color nunca es la unica senal). */
export function textoMinutos(minutos: number): string {
  const m = Math.max(0, Math.floor(minutos));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h} h ${String(r).padStart(2, "0")} min`;
}
