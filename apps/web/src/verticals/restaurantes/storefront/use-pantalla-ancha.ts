// true en >= lg (1024 px): ahi el carrito es una columna fija. En pantallas angostas el carrito vive en una hoja
// inferior abierta desde una barra fija. Sin matchMedia (jsdom, SSR) se asume escritorio.
import { useEffect, useState } from "react";

const CONSULTA_ANCHA = "(min-width: 1024px)";

function leer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(CONSULTA_ANCHA).matches : true;
}

export function usePantallaAncha(): boolean {
  const [ancha, setAncha] = useState<boolean>(leer);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(CONSULTA_ANCHA);
    const alCambiar = () => setAncha(mq.matches);
    alCambiar();
    mq.addEventListener("change", alCambiar);
    return () => mq.removeEventListener("change", alCambiar);
  }, []);
  return ancha;
}
