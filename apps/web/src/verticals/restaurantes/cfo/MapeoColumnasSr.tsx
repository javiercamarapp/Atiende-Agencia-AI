// CFO-08 · mapeo asistido de columnas del reporte de SoftRestaurant: cada dato que necesita el CFO se liga a una columna del archivo (sugerida con los alias
// inferidos del dominio). Las columnas de CLIENTE (nombre, teléfono, correo, dirección, RFC…) no se ofrecen: se excluyen y se avisa.
import { ShieldCheck } from "lucide-react";
import type { TipoLayoutSr } from "@atiende/domain-restaurantes/cfo";
import { Callout, Checkbox, FormField, NativeSelect } from "@atiende/ui";
import { camposDeTipo, camposFaltantes, camposRepetidos, type MapeoSr } from "./sr-importacion-navegador.ts";

export const AVISO_SIN_DATOS_CLIENTES = "No subimos datos de tus clientes";

export interface MapeoColumnasSrProps {
  readonly tipo: TipoLayoutSr;
  readonly encabezados: readonly string[];
  /** Índices de columnas personales: no se ofrecen en los selectores. */
  readonly personales: ReadonlySet<number>;
  /** Columnas que la ayuda de UX excluyó (solo nombre o posición, nunca valores); la persona puede recuperarlas. */
  readonly excluidas: ReadonlyArray<{ readonly indice: number; readonly nombre: string; readonly incluida: boolean }>;
  readonly onIncluir: (indice: number, incluir: boolean) => void;
  readonly mapeo: MapeoSr;
  readonly onCambiar: (campo: string, indice: number | null) => void;
  readonly avisoAlias?: string;
}

export function MapeoColumnasSr({ tipo, encabezados, personales, excluidas, onIncluir, mapeo, onCambiar, avisoAlias }: MapeoColumnasSrProps) {
  const faltan = new Set(camposFaltantes(tipo, mapeo));
  const repetidos = new Set(camposRepetidos(mapeo));
  return (
    <div className="flex flex-col gap-3" data-testid="mapeo-sr">
      {excluidas.length > 0 && (
        <Callout tone="info" icon={<ShieldCheck className="size-4" aria-hidden="true" />} data-testid="sr-columnas-excluidas">
          <p className="m-0 font-medium">{AVISO_SIN_DATOS_CLIENTES}.</p>
          <p className="m-0">Parecen columnas de clientes y se excluyen: {excluidas.map((e) => `«${e.nombre}»`).join(", ")}. Nunca se muestra su contenido.</p>
          <p className="m-0 text-xs">Aunque la recuperes, cada valor se revisa contra el tipo de su campo y lo que no encaje no se envía.</p>
          <ul className="m-0 mt-1 list-none p-0">
            {excluidas.map((e) => (
              <li key={e.indice}>
                <Checkbox
                  checked={e.incluida}
                  onChange={(ev) => onIncluir(e.indice, ev.target.checked)}
                  label={`Esta columna NO es de clientes, incluirla: ${e.nombre} (columna ${e.indice + 1})`}
                  wrapperClassName="text-sm"
                  data-testid={`sr-incluir-${e.indice}`}
                />
              </li>
            ))}
          </ul>
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
