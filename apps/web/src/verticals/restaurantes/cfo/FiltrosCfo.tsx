// CFO-07 · barra de filtros fija del CFO: rango (atajos + personalizado, máx. 400 días), selector múltiple de sucursales con «Todas»
// (para el admin acotado dice «Tus N sucursales»), «Comparar contra», conmutador Total / Por sucursal y Exportar.
// Todo es un control real: el estado vive en la URL (la dueña de ese estado es `CfoLayout`), nada es maqueta.
import { useEffect, useState } from "react";
import { Download, FileSpreadsheet, FileText, Store } from "lucide-react";
import { COMPARAR_CFO } from "@atiende/domain-restaurantes/cfo";
import type { AlcanceVista, CompararCfo } from "@atiende/domain-restaurantes/cfo";
import { Button, Checkbox, Input, Selector, Popover, PopoverContent, PopoverTrigger, RadioSegmentado, traductorActivo, useT } from "@atiende/ui";
import { restaurantesCfo } from "@atiende/ui/i18n/restaurantes/cfo";
import { ATAJOS_RANGO, ETIQUETA_COMPARAR, atajoActivo, errorDeRango, etiquetaRango, type FiltrosCfo, type VistaCfo } from "./filtros-url.ts";
import type { FormatoExportacionCfo } from "./cfo-client.ts";

export interface ExportarProps {
  /** El rol puede exportar (`cfo.exportar`) y la ruta existe (si respondió 404 se oculta). */
  readonly visible: boolean;
  readonly exportando: FormatoExportacionCfo | null;
  readonly onExportar: (formato: FormatoExportacionCfo) => void;
}

export interface FiltrosCfoProps {
  readonly filtros: FiltrosCfo;
  readonly alcance: AlcanceVista;
  readonly hoy: string;
  readonly onCambiar: (cambios: Partial<FiltrosCfo>) => void;
  readonly exportar: ExportarProps;
}

const tr = traductorActivo(restaurantesCfo);

/** «Todas» o «Tus N sucursales» (admin acotado) o los nombres elegidos (en el idioma activo). */
export function etiquetaSucursales(alcance: AlcanceVista, elegidas: readonly string[] | null): string {
  const permitidas = alcance.sucursales;
  if (elegidas === null) return alcance.organizacionCompleta ? tr("restaurantes.cfo.filtros.todasSucursales") : tr("restaurantes.cfo.tusSucursales", { n: permitidas.length });
  if (elegidas.length === 1) return permitidas.find((s) => s.propertyId === elegidas[0])?.nombre ?? tr("restaurantes.cfo.filtros.unaSucursal");
  return tr("restaurantes.cfo.filtros.nSucursales", { n: elegidas.length });
}

function SelectorSucursales({ filtros, alcance, onCambiar }: Pick<FiltrosCfoProps, "filtros" | "alcance" | "onCambiar">) {
  const t = useT(restaurantesCfo);
  const permitidas = alcance.sucursales;
  const elegidas = filtros.sucursales;
  const etiquetaTodas = alcance.organizacionCompleta ? t("restaurantes.cfo.filtros.todas") : t("restaurantes.cfo.tusSucursales", { n: permitidas.length });
  function alternar(id: string) {
    if (elegidas === null) return onCambiar({ sucursales: [id] });
    const sigue = elegidas.includes(id) ? elegidas.filter((x) => x !== id) : [...elegidas, id];
    onCambiar({ sucursales: sigue.length === 0 ? null : sigue });
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-full justify-start gap-1.5 sm:w-auto" aria-label={t("restaurantes.cfo.filtros.sucursalesAria", { etiqueta: etiquetaSucursales(alcance, elegidas) })} data-testid="filtro-sucursales">
          <Store className="size-3.5" aria-hidden="true" />
          <span className="truncate">{etiquetaSucursales(alcance, elegidas)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72" aria-label={t("restaurantes.cfo.filtros.elegirSucursales")}>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">{t("restaurantes.cfo.filtros.sucursales")}</legend>
          <Checkbox label={etiquetaTodas} checked={elegidas === null} onChange={() => onCambiar({ sucursales: null })} data-testid="sucursal-todas" />
          <div className="max-h-56 space-y-2 overflow-y-auto border-t border-line2 pt-2">
            {permitidas.map((s) => (
              <Checkbox
                key={s.propertyId}
                label={s.activa === false ? t("restaurantes.cfo.filtros.inactiva", { nombre: s.nombre }) : s.nombre}
                checked={elegidas !== null && elegidas.includes(s.propertyId)}
                onChange={() => alternar(s.propertyId)}
                data-testid={`sucursal-${s.propertyId}`}
              />
            ))}
          </div>
          {alcance.organizacionCompleta && elegidas !== null && <p className="text-2xs text-muted-foreground">{t("restaurantes.cfo.filtros.parcial")}</p>}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}

function SelectorRango({ filtros, hoy, onCambiar }: Pick<FiltrosCfoProps, "filtros" | "hoy" | "onCambiar">) {
  const t = useT(restaurantesCfo);
  const activo = atajoActivo(filtros.desde, filtros.hasta, hoy);
  const [personalizado, setPersonalizado] = useState(activo === "personalizado");
  const [desde, setDesde] = useState(filtros.desde);
  const [hasta, setHasta] = useState(filtros.hasta);
  // Si la URL cambia desde fuera (enlace compartido, botón Atrás), los campos siguen al estado real.
  useEffect(() => {
    setDesde(filtros.desde);
    setHasta(filtros.hasta);
    if (atajoActivo(filtros.desde, filtros.hasta, hoy) === "personalizado") setPersonalizado(true);
  }, [filtros.desde, filtros.hasta, hoy]);

  const error = personalizado ? errorDeRango(desde, hasta) : null;
  function cambiarAtajo(id: string) {
    if (id === "personalizado") {
      setPersonalizado(true);
      return;
    }
    setPersonalizado(false);
    const a = ATAJOS_RANGO.find((x) => x.id === id);
    if (a) onCambiar(a.rango(hoy));
  }
  function editar(nuevoDesde: string, nuevoHasta: string) {
    setDesde(nuevoDesde);
    setHasta(nuevoHasta);
    if (errorDeRango(nuevoDesde, nuevoHasta) === null) onCambiar({ desde: nuevoDesde, hasta: nuevoHasta });
  }
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="cfo-rango" className="sr-only">
          {t("restaurantes.cfo.filtros.rango")}
        </label>
        <Selector id="cfo-rango" size="sm" value={personalizado ? "personalizado" : activo} onChange={(e) => cambiarAtajo(e.target.value)} wrapperClassName="w-full sm:w-52" data-testid="filtro-rango">
          {ATAJOS_RANGO.map((a) => (
            <option key={a.id} value={a.id}>
              {a.etiqueta}
            </option>
          ))}
          <option value="personalizado">{t("restaurantes.cfo.filtros.personalizado")}</option>
        </Selector>
        {personalizado && (
          <>
            <label htmlFor="cfo-desde" className="sr-only">
              {t("restaurantes.cfo.filtros.desde")}
            </label>
            <Input id="cfo-desde" type="date" value={desde} max={hoy} onChange={(e) => editar(e.target.value, hasta)} className="h-[var(--control-sm)] w-40" aria-invalid={error ? true : undefined} aria-describedby={error ? "cfo-rango-error" : undefined} />
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              {t("restaurantes.cfo.filtros.separador")}
            </span>
            <label htmlFor="cfo-hasta" className="sr-only">
              {t("restaurantes.cfo.filtros.hasta")}
            </label>
            <Input id="cfo-hasta" type="date" value={hasta} max={hoy} onChange={(e) => editar(desde, e.target.value)} className="h-[var(--control-sm)] w-40" aria-invalid={error ? true : undefined} aria-describedby={error ? "cfo-rango-error" : undefined} />
          </>
        )}
      </div>
      {error ? (
        <p id="cfo-rango-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-2xs text-muted-foreground" data-testid="rango-actual">
          {etiquetaRango(filtros.desde, filtros.hasta)}
        </p>
      )}
    </div>
  );
}

export function FiltrosCfoBarra({ filtros, alcance, hoy, onCambiar, exportar }: FiltrosCfoProps) {
  const t = useT(restaurantesCfo);
  return (
    <section aria-label={t("restaurantes.cfo.filtros.aria")} data-testid="cfo-filtros" className="rounded-xl border border-border bg-card p-3 md:sticky md:top-0 md:z-10">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <SelectorRango filtros={filtros} hoy={hoy} onCambiar={onCambiar} />
        <SelectorSucursales filtros={filtros} alcance={alcance} onCambiar={onCambiar} />
        <div className="flex items-center gap-1.5">
          <label htmlFor="cfo-comparar" className="text-xs text-muted-foreground">
            {t("restaurantes.cfo.filtros.comparar")}
          </label>
          <Selector id="cfo-comparar" size="sm" value={filtros.comparar} onChange={(e) => onCambiar({ comparar: e.target.value as CompararCfo })} wrapperClassName="w-56" data-testid="filtro-comparar">
            {COMPARAR_CFO.map((c) => (
              <option key={c} value={c}>
                {ETIQUETA_COMPARAR[c]}
              </option>
            ))}
          </Selector>
        </div>
        <RadioSegmentado<VistaCfo>
          name="cfo-vista"
          label={t("restaurantes.cfo.filtros.vista")}
          opciones={[
            { id: "total", rotulo: t("restaurantes.cfo.filtros.total") },
            { id: "sucursal", rotulo: t("restaurantes.cfo.filtros.porSucursal") },
          ]}
          value={filtros.vista}
          onChange={(v) => onCambiar({ vista: v })}
          className="gap-1"
        />
        {exportar.visible && (
          <div className="flex items-center gap-1.5 md:ml-auto" role="group" aria-label={t("restaurantes.cfo.filtros.exportar")}>
            <Download className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <Button type="button" variant="outline" size="sm" loading={exportar.exportando === "xlsx"} disabled={exportar.exportando !== null} onClick={() => exportar.onExportar("xlsx")} className="gap-1.5">
              <FileSpreadsheet className="size-3.5" aria-hidden="true" />
              {t("restaurantes.cfo.filtros.exportarExcel")}
            </Button>
            <Button type="button" variant="outline" size="sm" loading={exportar.exportando === "pdf"} disabled={exportar.exportando !== null} onClick={() => exportar.onExportar("pdf")} className="gap-1.5">
              <FileText className="size-3.5" aria-hidden="true" />
              {t("restaurantes.cfo.filtros.exportarPdf")}

            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
