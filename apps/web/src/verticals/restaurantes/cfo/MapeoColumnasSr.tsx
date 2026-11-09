// CFO-08 · mapeo asistido de columnas del reporte de SoftRestaurant: cada dato que necesita el CFO se liga a una columna del archivo (sugerida con los alias
// inferidos del dominio). Las columnas de CLIENTE (nombre, teléfono, correo, dirección, RFC…) no se ofrecen: se excluyen y se avisa.
import { ShieldCheck } from "lucide-react";
import type { TipoLayoutSr } from "@atiende/domain-restaurantes/cfo";
import { Callout, Checkbox, FormField, Selector, useT } from "@atiende/ui";
import { restaurantesCfoSr } from "@atiende/ui/i18n/restaurantes/cfoSr";
import { camposDeTipo, camposFaltantes, camposRepetidos, type MapeoSr } from "./sr-importacion-navegador.ts";

export interface MapeoColumnasSrProps {
  readonly tipo: TipoLayoutSr;
  readonly encabezados: readonly string[];
  /** Índices de columnas personales: no se ofrecen en los selectores. */
  readonly personales: ReadonlySet<number>;
  /** Todas las columnas que el encabezado marcó como personales (incluso las recuperadas): ninguna puede ser el folio. */
  readonly personalesFolio?: ReadonlySet<number>;
  /** Columnas que la ayuda de UX excluyó (solo nombre o posición, nunca valores); la persona puede recuperarlas. */
  readonly excluidas: ReadonlyArray<{ readonly indice: number; readonly nombre: string; readonly incluida: boolean }>;
  readonly onIncluir: (indice: number, incluir: boolean) => void;
  readonly mapeo: MapeoSr;
  readonly onCambiar: (campo: string, indice: number | null) => void;
  readonly avisoAlias?: string;
}

export function MapeoColumnasSr({ tipo, encabezados, personales, personalesFolio, excluidas, onIncluir, mapeo, onCambiar, avisoAlias }: MapeoColumnasSrProps) {
  const t = useT(restaurantesCfoSr);
  const faltan = new Set(camposFaltantes(tipo, mapeo));
  const repetidos = new Set(camposRepetidos(mapeo));
  return (
    <div className="flex flex-col gap-3" data-testid="mapeo-sr">
      {excluidas.length > 0 && (
        <Callout tone="info" icon={<ShieldCheck className="size-4" aria-hidden="true" />} data-testid="sr-columnas-excluidas">
          <p className="m-0 font-medium">{t("restaurantes.cfoSr.sinDatosClientes")}.</p>
          <p className="m-0">{t("restaurantes.cfoSr.columnasExcluidas", { lista: excluidas.map((e) => `«${e.nombre}»`).join(", ") })}</p>
          <p className="m-0 text-xs">{t("restaurantes.cfoSr.recuperar")}</p>
          <ul className="m-0 mt-1 list-none p-0">
            {excluidas.map((e) => (
              <li key={e.indice}>
                <Checkbox
                  checked={e.incluida}
                  onChange={(ev) => onIncluir(e.indice, ev.target.checked)}
                  label={t("restaurantes.cfoSr.incluir", { nombre: e.nombre, n: String(e.indice + 1) })}
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
          const error = faltan.has(campo) ? t("restaurantes.cfoSr.eligeColumnaDato") : repetidos.has(campo) ? t("restaurantes.cfoSr.columnaUsada") : undefined;
          return (
            <FormField key={campo} label={etiqueta} required={requerido} {...(error ? { error } : {})}>
              <Selector
                id={`sr-mapeo-${campo}`}
                size="sm"
                value={mapeo[campo] === null || mapeo[campo] === undefined ? "" : String(mapeo[campo])}
                onChange={(e) => onCambiar(campo, e.target.value === "" ? null : Number(e.target.value))}
                data-testid={`sr-mapeo-${campo}`}
              >
                <option value="">{t(requerido ? "restaurantes.cfoSr.eligeColumna" : "restaurantes.cfoSr.noImportar")}</option>
                {encabezados.map((h, i) =>
                  personales.has(i) || (campo === "folio" && personalesFolio?.has(i)) || h.trim() === "" ? null : (
                    <option key={i} value={i}>
                      {t("restaurantes.cfoSr.opcionColumna", { n: String(i + 1), nombre: h.trim() })}
                    </option>
                  ),
                )}
              </Selector>
            </FormField>
          );
        })}
      </div>
    </div>
  );
}
