/**
 * Coordinador de carga (ds3 / lote 2.1). Garantiza que SOLO UN dibujo de `CargandoLogo` sea visible a la vez
 * (E23) y concentra los tiempos de R15:
 *
 *  - Retardo: un logo no se muestra hasta pasados 120 ms desde que se monta; si la carga termina antes, nunca se ve.
 *  - Prioridad: pantalla > panel > linea (a igual prioridad gana el primero que se registro). Los demas siguen
 *    montados (con su role=status y su texto sr-only) pero con el dibujo oculto.
 *  - Permanencia minima: `useCargaRetenida` mantiene el logo en pantalla 600 ms (pantalla) o 400 ms (panel/linea)
 *    contados desde que aparecio, para que no parpadee.
 *  - Fase global: `faseCarga()` deriva la fase de la animacion del reloj global, de modo que un logo remontado
 *    continua la respiracion donde iba en vez de reiniciarla.
 *
 * Usa `setTimeout` y `Date.now`/`performance.now` globales: con timers falsos las pruebas son deterministas.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export type CargaTamano = "pantalla" | "panel" | "linea";

export const CARGA_RETARDO_MS = 120;
export const CARGA_PERMANENCIA_MS: Readonly<Record<CargaTamano, number>> = { pantalla: 600, panel: 400, linea: 400 };
/** Tope de una carga antes de pasar a `EstadoError` (lo aplica el consumidor; aqui solo se declara). */
export const CARGA_TOPE_MS = 20_000;
/** Duracion de un ciclo de respiracion; debe coincidir con `.carga-logo` en index.css. */
export const CARGA_CICLO_MS = 1600;

const PRIORIDAD: Readonly<Record<CargaTamano, number>> = { pantalla: 3, panel: 2, linea: 1 };

type Entrada = { id: number; tamano: CargaTamano; lista: boolean; temporizador: ReturnType<typeof setTimeout> };

const entradas = new Map<number, Entrada>();
const oyentes = new Set<() => void>();
let siguienteId = 1;
let visibleId: number | null = null;

function recalcular(): void {
  let ganador: Entrada | null = null;
  for (const e of entradas.values()) {
    if (!e.lista) continue;
    if (ganador === null || PRIORIDAD[e.tamano] > PRIORIDAD[ganador.tamano]) ganador = e;
  }
  const nuevo = ganador ? ganador.id : null;
  if (nuevo === visibleId) return;
  visibleId = nuevo;
  oyentes.forEach((o) => o());
}

/** Registra una carga en curso; devuelve `{ id, soltar }`. `soltar` es idempotente. */
export function registrarCarga(tamano: CargaTamano): { id: number; soltar: () => void } {
  const id = siguienteId++;
  const entrada: Entrada = {
    id,
    tamano,
    lista: false,
    temporizador: setTimeout(() => {
      entrada.lista = true;
      recalcular();
    }, CARGA_RETARDO_MS),
  };
  entradas.set(id, entrada);
  return {
    id,
    soltar: () => {
      const e = entradas.get(id);
      if (!e) return;
      clearTimeout(e.temporizador);
      entradas.delete(id);
      recalcular();
    },
  };
}

export function suscribirCarga(oyente: () => void): () => void {
  oyentes.add(oyente);
  return () => {
    oyentes.delete(oyente);
  };
}

/** Id del logo que debe dibujarse ahora (o null). Primitivo: estable para `useSyncExternalStore`. */
export function obtenerCargaVisible(): number | null {
  return visibleId;
}

/** Solo para pruebas: vacia el coordinador y cancela sus timers. */
export function reiniciarCoordinadorCarga(): void {
  entradas.forEach((e) => clearTimeout(e.temporizador));
  entradas.clear();
  oyentes.clear();
  visibleId = null;
  siguienteId = 1;
}

/** `animation-delay` negativo que sincroniza la respiracion con el reloj global. */
export function faseCarga(ahoraMs: number = typeof performance === "undefined" ? Date.now() : performance.now()): string {
  return `-${Math.floor(ahoraMs % CARGA_CICLO_MS)}ms`;
}

/**
 * Registra el logo de la instancia mientras esta montada. `visible` es true solo si esta instancia es la ganadora
 * y ya pasaron los 120 ms. Antes de montar (y en SSR) es false.
 */
export function useCargaCoordinada(tamano: CargaTamano): { visible: boolean } {
  const [id, setId] = useState<number | null>(null);
  const activo = useSyncExternalStore(suscribirCarga, obtenerCargaVisible, () => null);
  useEffect(() => {
    const registro = registrarCarga(tamano);
    setId(registro.id);
    return () => {
      registro.soltar();
      setId(null);
    };
  }, [tamano]);
  return { visible: id !== null && activo === id };
}

/**
 * Para quien decide si pintar el logo: `true` mientras `cargando`, y tras terminar mantiene `true` hasta cumplir la
 * permanencia minima (contada desde que el logo aparecio, es decir, 120 ms despues de empezar). Si la carga acaba
 * antes de los 120 ms devuelve `false` al instante (el logo nunca se mostro).
 */
export function useCargaRetenida(cargando: boolean, tamano: CargaTamano): boolean {
  const [retenida, setRetenida] = useState(false);
  const inicio = useRef<number | null>(null);
  useEffect(() => {
    if (cargando) {
      if (inicio.current === null) inicio.current = Date.now();
      return;
    }
    const empezo = inicio.current;
    inicio.current = null;
    if (empezo === null) return;
    const aparecio = empezo + CARGA_RETARDO_MS;
    const restante = aparecio + CARGA_PERMANENCIA_MS[tamano] - Date.now();
    if (Date.now() < aparecio || restante <= 0) return;
    setRetenida(true);
    const t = setTimeout(() => setRetenida(false), restante);
    return () => clearTimeout(t);
  }, [cargando, tamano]);
  return cargando || retenida;
}
