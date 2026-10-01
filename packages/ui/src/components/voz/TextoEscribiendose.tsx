import { useEffect, useState } from "react";

/**
 * Revela el texto letra por letra (18 ms por letra), para que la transcripción de
 * la vista previa se sienta "escribiéndose" en vivo en vez de aparecer de golpe.
 * El texto es el real recibido; esto solo cambia el ritmo en que se muestra.
 * Puerto del componente homónimo del panel original (UI pura); a diferencia del
 * original usa un temporizador por letra que se detiene al terminar, en vez de un
 * setInterval que sigue vivo mientras el componente esté montado.
 */
export function TextoEscribiendose({ texto, msPorLetra = 18 }: { texto: string; msPorLetra?: number }) {
  const [visibles, setVisibles] = useState(0);
  // Texto nuevo: vuelve a empezar desde la primera letra.
  useEffect(() => {
    setVisibles(0);
  }, [texto]);
  useEffect(() => {
    if (visibles >= texto.length) return undefined;
    const t = setTimeout(() => setVisibles((v) => v + 1), msPorLetra);
    return () => clearTimeout(t);
  }, [texto, visibles, msPorLetra]);
  return <>{texto.slice(0, visibles)}</>;
}
