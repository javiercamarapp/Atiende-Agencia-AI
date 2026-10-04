// El popup de filtros y orden del Cerebro (el panel de filtros de cerebro.tsx de Likida, adaptado: giro -> vertical y subtipo, fuentes las
// que de verdad hay en la cartera, tamano por la taxonomia de cada vertical, "necesidad" -> "cierre", "vacante" -> "contactable").
// Un clic en un chip lo agrega; el numero de la derecha es cuantos prospectos de la cartera lo cumplen.
import { Download } from "lucide-react";
import { Button, Input, resolverFormato } from "@atiende/ui";
import { Chip } from "./Chip.tsx";
import type { OpcionFiltro } from "./cartera.ts";
import type { ProspectoMapa } from "./datos.ts";
import { ETAPAS_EMBUDO, NOMBRE_ETAPA } from "./embudo.ts";
import { SIN_FILTROS, alternarEnSet } from "./filtros.ts";
import type { Filtros, OrdenCerebro, Plaza } from "./filtros.ts";
import { CRITERIO_SCORES } from "./datos.ts";
import { NOMBRE_VERTICAL, VERTICALES_CEREBRO } from "./verticales.ts";

const ETIQUETA = "etiqueta-mono mb-1.5 text-2xs font-medium uppercase text-muted-foreground";

const ORDENES: ReadonlyArray<readonly [OrdenCerebro, string]> = [
  ["cierre", "% cierre"],
  ["urgencia", "% urgencia"],
  ["ajuste", "% ajuste ICP"],
  ["completos", "Datos"],
  ["recientes", "Recientes"],
];

function Minimos<T extends number>({ valores, actual, onElegir, etiquetaCero }: { readonly valores: readonly T[]; readonly actual: T; readonly onElegir: (v: T) => void; readonly etiquetaCero: string }) {
  return (
    <div className="flex gap-1.5">
      {valores.map((u) => (
        <Chip key={u} activo={u !== 0 && actual === u} onClick={() => onElegir(actual === u ? (0 as T) : u)}>
          {u === 0 ? etiquetaCero : `≥${u}%`}
        </Chip>
      ))}
    </div>
  );
}

export function PanelFiltros({ filtros, setFiltros, prospectos, filtrados, fuentes, subtipos, tamanos, plazas, conteoVertical, exportando, onExportar, popupRef }: {
  readonly filtros: Filtros;
  readonly setFiltros: (f: (actual: Filtros) => Filtros) => void;
  readonly prospectos: readonly ProspectoMapa[];
  readonly filtrados: readonly ProspectoMapa[];
  readonly fuentes: readonly OpcionFiltro[];
  readonly subtipos: readonly OpcionFiltro[];
  readonly tamanos: readonly OpcionFiltro[];
  readonly plazas: readonly Plaza[];
  readonly conteoVertical: ReadonlyMap<string, number>;
  readonly exportando: boolean;
  readonly onExportar: () => void;
  readonly popupRef: React.RefObject<HTMLDivElement>;
}) {
  const n = resolverFormato("entero");
  return (
    <div
      ref={popupRef}
      role="dialog"
      aria-label="Filtros y orden"
      data-testid="cerebro-filtros"
      className="cerebro-panel absolute right-4 top-20 z-40 max-h-[calc(100%-6.5rem)] w-[min(94vw,560px)] space-y-3 overflow-y-auto rounded-2xl border border-border bg-card p-4 shadow-elevated"
    >
      <div>
        <p className={ETIQUETA}>Vertical</p>
        <div className="flex flex-wrap gap-1.5">
          {VERTICALES_CEREBRO.map((v) => (
            <Chip key={v} vertical={v} activo={filtros.verticales?.has(v) ?? false} onClick={() => setFiltros((f) => ({ ...f, verticales: alternarEnSet(f.verticales, v) }))}>
              {NOMBRE_VERTICAL[v]} · {conteoVertical.get(v) ?? 0}
            </Chip>
          ))}
        </div>
      </div>
      {subtipos.length > 0 && (
        <div>
          <p className={ETIQUETA}>Subtipo</p>
          <div className="flex flex-wrap gap-1.5">
            {subtipos.map((s) => (
              <Chip key={s.clave} activo={filtros.subtipos?.has(s.clave) ?? false} onClick={() => setFiltros((f) => ({ ...f, subtipos: alternarEnSet(f.subtipos, s.clave) }))}>
                {s.nombre} · {s.n}
              </Chip>
            ))}
          </div>
        </div>
      )}
      <div>
        <p className={ETIQUETA}>Etapa del embudo</p>
        <div className="flex flex-wrap gap-1.5">
          {ETAPAS_EMBUDO.map((e) => (
            <Chip key={e} activo={filtros.etapas?.has(e) ?? false} onClick={() => setFiltros((f) => ({ ...f, etapas: alternarEnSet(f.etapas, e) }))}>
              {NOMBRE_ETAPA[e]}
            </Chip>
          ))}
        </div>
      </div>
      {tamanos.length > 0 && (
        <div>
          <p className={ETIQUETA}>Tamaño (rangos de la taxonomía)</p>
          <div className="flex flex-wrap gap-1.5">
            {tamanos.map((t) => (
              <Chip key={t.clave} activo={filtros.tamanos?.has(t.clave) ?? false} onClick={() => setFiltros((f) => ({ ...f, tamanos: alternarEnSet(f.tamanos, t.clave) }))}>
                {t.nombre}
              </Chip>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-3">
        {fuentes.length > 0 && (
          <div>
            <p className={ETIQUETA}>Fuente</p>
            <div className="flex flex-wrap gap-1.5">
              {fuentes.map((f) => (
                <Chip key={f.clave} activo={filtros.fuentes?.has(f.clave) ?? false} onClick={() => setFiltros((v) => ({ ...v, fuentes: alternarEnSet(v.fuentes, f.clave) }))}>
                  {f.nombre} · {f.n}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <div>
          <p className={ETIQUETA}>Urgencia mínima</p>
          <Minimos valores={[0, 50, 70] as const} actual={filtros.minUrgencia} onElegir={(v) => setFiltros((f) => ({ ...f, minUrgencia: v }))} etiquetaCero="Todas" />
        </div>
        <div>
          <p className={ETIQUETA} title={CRITERIO_SCORES.ajuste}>Ajuste ICP mínimo</p>
          <Minimos valores={[0, 40, 65, 85] as const} actual={filtros.minAjuste} onElegir={(v) => setFiltros((f) => ({ ...f, minAjuste: v }))} etiquetaCero="Todas" />
        </div>
        <div>
          <p className={ETIQUETA} title={CRITERIO_SCORES.cierre}>Cierre mínimo</p>
          <Minimos valores={[0, 40, 65, 85] as const} actual={filtros.minCierre} onElegir={(v) => setFiltros((f) => ({ ...f, minCierre: v }))} etiquetaCero="Todas" />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <div>
          <p className={ETIQUETA}>Alcanzables</p>
          <div className="flex flex-wrap gap-1.5">
            <Chip activo={filtros.soloTel} onClick={() => setFiltros((f) => ({ ...f, soloTel: !f.soloTel }))}>Con teléfono</Chip>
            <Chip activo={filtros.soloDecisor} onClick={() => setFiltros((f) => ({ ...f, soloDecisor: !f.soloDecisor }))}>Con decisor</Chip>
            <Chip activo={filtros.soloContactable} title="Con base de licitud registrada y sin el destino en la lista de supresión" onClick={() => setFiltros((f) => ({ ...f, soloContactable: !f.soloContactable }))}>
              Contactable hoy
            </Chip>
          </div>
        </div>
        <div>
          <p className={ETIQUETA}>Datos completos</p>
          <Minimos valores={[0, 50, 75] as const} actual={filtros.minCompletitud} onElegir={(v) => setFiltros((f) => ({ ...f, minCompletitud: v }))} etiquetaCero="Todos" />
        </div>
        <div>
          <p className={ETIQUETA}>Sin toque en</p>
          <div className="flex gap-1.5">
            {([0, 7, 14, 30] as const).map((d) => (
              <Chip key={d} activo={d !== 0 && filtros.sinToqueDias === d} onClick={() => setFiltros((f) => ({ ...f, sinToqueDias: f.sinToqueDias === d ? 0 : d }))}>
                {d === 0 ? "Todos" : `≥${d} días`}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <p className={ETIQUETA}>Ordenar por</p>
          <div className="flex flex-wrap gap-1.5">
            {ORDENES.map(([k, nombre]) => (
              <Chip key={k} activo={filtros.orden === k} onClick={() => setFiltros((f) => ({ ...f, orden: k }))}>{nombre}</Chip>
            ))}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setFiltros(() => SIN_FILTROS)}>
          Limpiar todo
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <div className="min-w-[220px] flex-1">
          <p className={ETIQUETA}>Buscar</p>
          <Input type="search" aria-label="Buscar prospecto" placeholder="Empresa, ciudad, contacto…" value={filtros.busqueda} onChange={(e) => setFiltros((f) => ({ ...f, busqueda: e.target.value }))} />
        </div>
        <div className="min-w-[220px]">
          <p className={ETIQUETA}>Cerca de (plaza)</p>
          <Input
            list="cerebro-plazas"
            aria-label="Plaza"
            placeholder="Escribe una ciudad…"
            defaultValue={filtros.centro?.nombre ?? ""}
            onChange={(e) => {
              const plaza = plazas.find((x) => x.nombre === e.target.value);
              setFiltros((f) => ({ ...f, centro: plaza ? { lat: plaza.lat, lng: plaza.lng, nombre: plaza.nombre } : null, radioKm: plaza ? f.radioKm || 50 : 0 }));
            }}
          />
          <datalist id="cerebro-plazas">
            {plazas.map((x) => <option key={x.nombre} value={x.nombre} />)}
          </datalist>
        </div>
        <div>
          <p className={ETIQUETA}>Radio</p>
          <div className="flex gap-1.5">
            {[25, 50, 100, 200].map((km) => (
              <Chip key={km} activo={filtros.radioKm === km && filtros.centro !== null} onClick={() => setFiltros((f) => ({ ...f, radioKm: f.radioKm === km ? 0 : km }))}>
                {km} km
              </Chip>
            ))}
          </div>
        </div>
        <Button type="button" size="sm" className="ml-auto" loading={exportando} disabled={filtrados.length === 0} onClick={onExportar}>
          <Download className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          Exportar CSV ({n(filtrados.length)})
        </Button>
      </div>
      <p className="text-eyebrow text-muted-foreground">
        {n(filtrados.length)} de {n(prospectos.length)} prospectos pasan el filtro.
      </p>
    </div>
  );
}
