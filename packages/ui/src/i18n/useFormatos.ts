import { useMemo } from "react";
import { crearFormatos, type Formatos } from "./formato.ts";
import { useI18n } from "./proveedor";

/** Formato de numeros, dinero, porcentajes y fechas en el idioma activo (es-MX / en-US). */
export function useFormatos(): Formatos {
  const { idioma } = useI18n();
  return useMemo(() => crearFormatos(idioma), [idioma]);
}
