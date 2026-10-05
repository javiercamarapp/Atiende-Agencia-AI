// `prefers-reduced-motion` como valor reactivo (portado de admin/ui/prefers-reduced-motion.ts de Likida). Toda animacion del Cerebro
// (entrada de estados, pulso de luces, vuelo de camara, conteo de KPIs, llenado de barras) lo consulta: con "reducir movimiento" se
// salta el movimiento y se muestra el estado final de una vez.
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}
function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
