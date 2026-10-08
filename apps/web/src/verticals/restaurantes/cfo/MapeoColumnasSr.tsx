// CFO-08 · mapeo asistido de columnas del reporte de SoftRestaurant: cada dato que necesita el CFO se liga a una columna del archivo (sugerida con los alias
// inferidos del dominio). Las columnas de CLIENTE (nombre, teléfono, correo, dirección, RFC…) no se ofrecen: se excluyen y se avisa.
import { ShieldCheck } from "lucide-react";
import type { TipoLayoutSr } from "@atiende/domain-restaurantes/cfo";
import { Callout, FormField, NativeSelect } from "@atiende/ui";
import { camposDeTipo, camposFaltantes, camposRepetidos, type MapeoSr } from "./sr-importacion-navegador.ts";

export const AVISO_SIN_DATOS_CLIENTES = "No subimos datos de tus clientes";

export interface MapeoColumnasSrProps {
  readonly tipo: TipoLayoutSr;
  readonly encabezados: readonly string[];
  /** Índices de columnas personales: no se ofrecen en los selectores. */
  readonly personales: ReadonlySet<number>;
  readonly excluidas: readonly string[];
  readonly mapeo: MapeoSr;
  readonly onCambiar: (campo: string, indice: number | null) => void;
  readonly avisoAlias?: string;
}

export function MapeoColumnasSr({ tipo, encabezados, personales, excluidas, mapeo, onCambiar, avisoAlias }: MapeoColumnasSrProps) {
  const faltan = new Set(camposFaltantes(tipo, mapeo));
  const repetidos = new Set(camposRepetidos(mapeo));
  return (
    <div className="flex flex-col gap-3" data-testid="mapeo-sr">
      {excluidas.length > 0 && (
        <Callout tone="info" icon={<ShieldCheck className="size-4" aria-hidden="true" />} data-testid="sr-columnas-excluidas">
          <p className="m-0 font-medium">{AVISO_SIN_DATOS_CLIENTES}.</p>
          <p className="m-0">
            Estas columnas se excluyen y no salen de tu navegador: <strong>{excluidas.join(", ")}</strong>.
          </p>
        </Callout>
      )}
      {avisoAlias && <p className="m-0 text-xs text-muted-foreground">{avisoAlias}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {camposDeTipo(tipo).map(({ campo, etiqueta, requerido }) => {
          const error = faltan.has(campo) ? "Elige la columna de este dato." : repetidos.has(campo) ? "Esa columna ya se usa en otro dato." : undefined;
          return (
            <FormField key={campo} label={etiqueta} required={requerido} {...(error ? { error } : {})}>
              <NativeSelect
                id={`sr-mapeo-${campo}`}
                size="sm"
                value={mapeo[campo] === null || mapeo[campo] === undefined ? "" : String(mapeo[campo])}
                onChange={(e) => onCambiar(campo, e.target.value === "" ? null : Number(e.target.value))}
                data-testid={`sr-mapeo-${campo}`}
              >
                <option value="">{requerido ? "Elige la columna…" : "No importar"}</option>
                {encabezados.map((h, i) =>
                  personales.has(i) || h.trim() === "" ? null : (
                    <option key={i} value={i}>
                      {`Columna ${i + 1}: ${h.trim()}`}
                    </option>
                  ),
                )}
              </NativeSelect>
            </FormField>
          );
        })}
      </div>
    </div>
  );
}
