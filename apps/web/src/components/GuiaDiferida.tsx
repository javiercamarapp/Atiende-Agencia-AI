// ds3 «Guía» diferida: el componente (`@atiende/ui/guia`) y el contenido de la vertical se descargan SOLO con la bandera ds3 encendida.
// Sin la bandera no se baja ni un byte de la guia (antes ~21 kB gzip por consola), no se pinta y no se llama a la API.
// La lectura de la bandera usa el helper de lib/diseno (`leerDisenoDs3`): es la unica rama de JS de la guia y se retira con la bandera.
import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { leerDisenoDs3 } from "@atiende/ui";
import type { ContenidoConsola, GuiaRecorridoProps } from "@atiende/ui";

export interface ContenidoGuiaCargado {
  readonly contenido?: ContenidoConsola;
  readonly esenciales?: readonly string[];
  readonly excluir?: readonly string[];
}
/** Carga diferida del contenido de la consola (`() => import("./guia-<vertical>.ts").then(...)`). */
export type CargarGuia = () => Promise<ContenidoGuiaCargado>;

export type GuiaDiferidaProps = Omit<GuiaRecorridoProps, "contenido" | "esenciales" | "excluir"> & { readonly cargar?: CargarGuia };

export function GuiaDiferida({ cargar, ...props }: GuiaDiferidaProps) {
  const [cargado, setCargado] = useState<{ Guia: ComponentType<GuiaRecorridoProps>; contenido: ContenidoGuiaCargado } | null>(null);
  const cargarRef = useRef(cargar);
  cargarRef.current = cargar;
  // Se vuelve a cargar solo si cambia la pista (otro rol u otra consola), no en cada render del shell.
  const pista = props.pista;
  useEffect(() => {
    if (!leerDisenoDs3()) return undefined;
    let vivo = true;
    Promise.all([import("@atiende/ui/guia"), cargarRef.current ? cargarRef.current() : Promise.resolve({})])
      .then(([m, contenido]) => {
        if (vivo) setCargado({ Guia: m.GuiaRecorrido, contenido });
      })
      .catch(() => undefined); // sin red para el chunk: no hay guia, el resto del panel sigue igual
    return () => {
      vivo = false;
    };
  }, [pista]);
  if (!cargado) return null;
  const { Guia, contenido } = cargado;
  return <Guia {...props} contenido={contenido.contenido} esenciales={contenido.esenciales} excluir={contenido.excluir} />;
}
