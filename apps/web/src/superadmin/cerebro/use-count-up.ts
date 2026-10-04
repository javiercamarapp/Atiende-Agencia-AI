// Conteo animado de los KPIs del Cerebro (portado de admin/ui/use-count-up.ts de Likida). El estado arranca en el valor REAL, nunca en 0: la
// animacion solo corre cuando `valorFinal` CAMBIA despues de montado (un filtro nuevo, un latido con altas). `animar=false`
// (prefers-reduced-motion) muestra el valor final de una vez.
import { useEffect, useRef, useState } from "react";

export function useCountUp(valorFinal: number, animar: boolean, duracionMs = 600): number {
  const [valorMostrado, setValorMostrado] = useState(valorFinal);
  const previoRef = useRef(valorFinal);
  const montadoRef = useRef(false);

  useEffect(() => {
    if (!montadoRef.current) {
      montadoRef.current = true;
      previoRef.current = valorFinal;
      return;
    }
    if (!animar || valorFinal === previoRef.current) {
      previoRef.current = valorFinal;
      setValorMostrado(valorFinal);
      return;
    }
    const desde = previoRef.current;
    const delta = valorFinal - desde;
    let inicio: number | null = null;
    let raf = 0;
    function tick(t: number) {
      if (inicio === null) inicio = t;
      const p = Math.min(1, (t - inicio) / duracionMs);
      const suavizado = 1 - (1 - p) ** 3; // ease-out cubico
      setValorMostrado(desde + delta * suavizado);
      if (p < 1) raf = requestAnimationFrame(tick);
      else previoRef.current = valorFinal;
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [valorFinal, animar, duracionMs]);

  return valorMostrado;
}
