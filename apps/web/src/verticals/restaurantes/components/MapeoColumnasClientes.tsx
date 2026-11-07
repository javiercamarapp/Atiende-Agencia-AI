// Paso «Mapea tus columnas» de la importacion de clientes (portado del repo suelto, ClientesSection.tsx): un selector por dato con
// ejemplos reales de cada columna, aviso si la columna del telefono no trae telefonos, columnas repetidas y la vista previa de los
// primeros renglones tal como se leerian. Solo presenta: la logica vive en lib/mapeo-columnas-clientes.ts y la autoridad es el servidor.
import { useMemo } from "react";
import { Callout, FormField, Selector, useT } from "@atiende/ui";
import { mapeoClientes } from "@atiende/ui/i18n/mapeoClientes";
import { CAMPOS_IMPORTACION } from "../lib/clientes-importacion.ts";
import type { CampoImportacion, MapeoColumnas } from "../lib/clientes-importacion.ts";
import { UMBRAL_TELEFONO, calidadTelefono, camposFaltantes, camposRepetidos, ejemplosDeColumna, vistaPreviaLocal } from "../lib/mapeo-columnas-clientes.ts";

export interface MapeoColumnasClientesProps {
  /** Encabezados de la primera fila, o [] si el archivo no los trae. */
  readonly encabezados: readonly string[];
  /** Renglones de datos (sin encabezado). */
  readonly filasDatos: readonly (readonly string[])[];
  readonly columnas: number;
  readonly mapeo: MapeoColumnas;
  readonly onCambiar: (campo: CampoImportacion, indice: number | null) => void;
}

const CLAVE_CAMPO = {
  telefono: "mapeoClientes.campo.telefono",
  nombre: "mapeoClientes.campo.nombre",
  direccion: "mapeoClientes.campo.direccion",
  colonia: "mapeoClientes.campo.colonia",
  notas: "mapeoClientes.campo.notas",
} as const satisfies Record<CampoImportacion, string>;

export function MapeoColumnasClientes({ encabezados, filasDatos, columnas, mapeo, onCambiar }: MapeoColumnasClientesProps) {
  const t = useT(mapeoClientes);
  const faltan = new Set(camposFaltantes(mapeo));
  const repetidos = new Set(camposRepetidos(mapeo));
  const opciones = useMemo(
    () =>
      Array.from({ length: columnas }, (_, i) => {
        const nombre = encabezados[i]?.trim();
        const base = nombre ? t("mapeoClientes.columnaConNombre", { numero: i + 1, nombre }) : t("mapeoClientes.columna", { numero: i + 1 });
        const ejemplos = ejemplosDeColumna(filasDatos, i);
        return ejemplos.length > 0 ? `${base} (${t("mapeoClientes.ejemplo", { valores: ejemplos.join(" · ") })})` : base;
      }),
    [columnas, encabezados, filasDatos, t],
  );
  const calidad = mapeo.telefono === null ? null : calidadTelefono(filasDatos, mapeo.telefono);
  const telefonoDudoso = calidad !== null && calidad.conValor > 0 && calidad.plausibles / calidad.conValor < UMBRAL_TELEFONO;
  const vista = vistaPreviaLocal(filasDatos, mapeo);
  const camposVista = CAMPOS_IMPORTACION.filter((c) => mapeo[c] !== null);

  return (
    <div className="flex flex-col gap-3" data-testid="mapeo-columnas-clientes">
      <div className="flex flex-col gap-0.5">
        <p className="m-0 text-sm font-semibold text-foreground">{t("mapeoClientes.titulo")}</p>
        <p className="m-0 text-xs text-muted-foreground">{t("mapeoClientes.ayuda")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {CAMPOS_IMPORTACION.map((campo) => {
          const requerido = campo === "telefono";
          const error = faltan.has(campo) ? t("mapeoClientes.error.falta") : repetidos.has(campo) ? t("mapeoClientes.error.repetida") : undefined;
          return (
            <FormField key={campo} label={t(CLAVE_CAMPO[campo])} required={requerido} {...(requerido ? { hint: t("mapeoClientes.telefono.pista") } : {})} {...(error ? { error } : {})}>
              <Selector id={`clientes-import-${campo}`} size="sm" value={mapeo[campo] === null ? "" : String(mapeo[campo])} onChange={(e) => onCambiar(campo, e.target.value === "" ? null : Number(e.target.value))}>
                <option value="">{requerido ? t("mapeoClientes.opcion.elegir") : t("mapeoClientes.opcion.noImportar")}</option>
                {opciones.map((etiqueta, i) => (
                  <option key={i} value={i}>
                    {etiqueta}
                  </option>
                ))}
              </Selector>
            </FormField>
          );
        })}
      </div>
      {telefonoDudoso && calidad && (
        <Callout tone="warning" data-testid="mapeo-telefono-dudoso">
          {t("mapeoClientes.aviso.telefono", { plausibles: calidad.plausibles, conValor: calidad.conValor })}
        </Callout>
      )}
      {camposVista.length > 0 && vista.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="mapeo-vista-local">
          <p className="m-0 text-xs font-medium text-muted-foreground">{t("mapeoClientes.vista.titulo")}</p>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  {camposVista.map((c) => (
                    <th key={c} scope="col" className="px-2.5 py-1.5 font-medium">
                      {t(CLAVE_CAMPO[c])}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vista.map((fila, i) => (
                  <tr key={i} className="border-t border-border">
                    {camposVista.map((c) => (
                      <td key={c} className="max-w-48 truncate px-2.5 py-1.5 text-foreground">
                        {fila[c] || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
