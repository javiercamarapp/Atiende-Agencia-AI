// Pestana Bitacora de cambios (solo owner/gm): quien cambio que, con el valor anterior y el nuevo. Solo lectura.
import { useCallback, useEffect, useState } from "react";
import { DataTable } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchBitacoraConfiguracion } from "../../lib/configuracion-client.ts";
import type { EntradaBitacora } from "../../lib/configuracion-client.ts";
import { fechaHoraEsMx } from "../../../../lib/formato-fecha.ts";
import { mensajeDe } from "./comun.ts";
import type { PestanaProps } from "./comun.ts";

const AREA_LABEL: Record<EntradaBitacora["area"], string> = {
  impuestos: "Impuestos",
  politica_cancelacion: "Política de cancelación",
  sobreventa: "Sobreventa",
  tarifa: "Tarifa",
  onboarding_omitido: "Primeros pasos omitidos",
};

function resumen(v: Record<string, unknown> | null): string {
  if (!v) return "—";
  return Object.entries(v)
    .map(([k, val]) => `${k}: ${val === null ? "—" : String(val)}`)
    .join(" · ");
}

export function BitacoraTab({ apiBaseUrl, token, propertyId }: PestanaProps) {
  const [entradas, setEntradas] = useState<readonly EntradaBitacora[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      setEntradas(await fetchBitacoraConfiguracion(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(mensajeDe(err, "No se pudo cargar la bitácora."));
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const columnas: DataTableColumna<EntradaBitacora>[] = [
    { id: "fecha", encabezado: "Fecha", celda: (e) => fechaHoraEsMx(e.createdAt), valorOrden: (e) => e.createdAt, principal: true },
    { id: "area", encabezado: "Área", celda: (e) => AREA_LABEL[e.area] ?? e.area },
    { id: "antes", encabezado: "Antes", celda: (e) => resumen(e.valorAnterior), className: "break-words" },
    { id: "despues", encabezado: "Después", celda: (e) => resumen(e.valorNuevo), className: "break-words" },
  ];

  return (
    <DataTable
      etiqueta="Bitácora de cambios de configuración"
      columnas={columnas}
      filas={entradas ?? []}
      obtenerId={(e) => e.id}
      estado={error ? "error" : entradas === null ? "loading" : undefined}
      error={{ mensaje: error ?? undefined, onReintentar: () => void cargar() }}
      vacio={{ mensaje: "Todavía no hay cambios de configuración registrados." }}
      paginacion={{ tamano: 15 }}
    />
  );
}
