// CFO-07 · pestaña Resumen: «Lo más importante» (hallazgos priorizados con cifra citada), resumen narrado con las cifras resaltadas y la fila
// de KPI con semáforo y variación. Vista «Por sucursal»: las mismas cifras en una tabla KPI × sucursal. Una cifra `null` es «—», nunca 0.
import { Fragment, useState } from "react";
import { Lightbulb } from "lucide-react";
import type { CriterioOrden, KpiTarjeta, ResumenVista } from "@atiende/domain-restaurantes/cfo";
import { Callout, Card, DataTable, EstadoVacio, PageContainer, RadioSegmentado, Semaforo, SectionLabel, cn } from "@atiende/ui";
import type { EstadoSemaforo } from "@atiende/ui";
import { fetchResumen } from "./cfo-client.ts";
import { enlaceDeAccion, type CfoPaginaProps } from "./contexto.ts";
import { HallazgoTarjeta } from "./HallazgoTarjeta.tsx";
import { SIN_DATO, pesos, textoCifra, textoValor, textoVariacion, tonoVariacion } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

const SEMAFORO_KPI: Readonly<Record<KpiTarjeta["semaforo"], EstadoSemaforo>> = { verde: "verde", ambar: "ambar", rojo: "rojo", sin_dato: "sin_dato" };
const CLASE_TONO = { bueno: "text-success", malo: "text-destructive", neutro: "text-muted-foreground" } as const;

/** Resalta (negritas) las cifras de una oración narrada: pesos, porcentajes, minutos y conteos con unidad. */
export function resaltarCifras(texto: string): Array<string | { readonly cifra: string }> {
  const partes: Array<string | { readonly cifra: string }> = [];
  const re = /-?[$]\s?[\d,]+(?:\.\d+)?|-?\d[\d,]*(?:\.\d+)?\s?(?:%|pp|min)/g;
  let ultimo = 0;
  for (const m of texto.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > ultimo) partes.push(texto.slice(ultimo, i));
    partes.push({ cifra: m[0] });
    ultimo = i + m[0].length;
  }
  if (ultimo < texto.length) partes.push(texto.slice(ultimo));
  return partes;
}

function KpiCard({ k }: { readonly k: KpiTarjeta }) {
  const tono = tonoVariacion(k.variacion, k.mejorSi);
  const sinDato = k.valor.valor === null;
  return (
    <Card data-testid="kpi-cfo" data-kpi={k.id} className="flex min-w-0 flex-col gap-1 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 min-w-0 text-xs text-muted-foreground">{k.etiqueta}</span>
        <Semaforo estado={SEMAFORO_KPI[k.semaforo]} />
      </div>
      <p className={cn("min-w-0 truncate font-display text-xl font-semibold tabular-nums", sinDato && "text-faint")} aria-label={sinDato ? `${k.etiqueta}: sin dato` : undefined} title={sinDato ? undefined : textoCifra(k.valor, k.tipo)}>
        {textoCifra(k.valor, k.tipo)}
      </p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={CLASE_TONO[tono]} data-testid="kpi-variacion">
          {textoVariacion(k.variacion)}
        </span>
        <ChipDeCifra cifra={k.valor} />
      </div>
    </Card>
  );
}

function KpiPorSucursal({ d }: { readonly d: ResumenVista }) {
  type Fila = { readonly id: string; readonly etiqueta: string };
  const filas: Fila[] = d.kpis.total.kpis.map((k) => ({ id: k.id, etiqueta: k.etiqueta }));
  const celda = (kpis: readonly KpiTarjeta[], id: string) => {
    const k = kpis.find((x) => x.id === id);
    return k ? textoCifra(k.valor, k.tipo) : SIN_DATO;
  };
  return (
    <DataTable<Fila>
      etiqueta="Indicadores por sucursal"
      filas={filas}
      obtenerId={(f) => f.id}
      paginacion={false}
      vista="tabla"
      atributosFila={(f) => ({ "data-kpi": f.id })}
      columnas={[
        { id: "kpi", encabezado: "Indicador", principal: true, celda: (f) => f.etiqueta },
        ...d.kpis.porSucursal.map((s) => ({ id: s.propertyId, encabezado: s.nombre, alinear: "right" as const, className: "tabular-nums", celda: (f: Fila) => celda(s.kpis, f.id) })),
        { id: "total", encabezado: "Total", alinear: "right" as const, className: "tabular-nums font-medium", celda: (f: Fila) => celda(d.kpis.total.kpis, f.id) },
      ]}
    />
  );
}

export function CfoResumen(props: CfoPaginaProps) {
  const { api, filtros, base, pestanasDisponibles } = props;
  const [orden, setOrden] = useState<CriterioOrden>("impacto");
  const clave = `${filtros.desde}|${filtros.hasta}|${filtros.sucursales?.join(",") ?? ""}|${filtros.comparar}`;
  const { carga, recargando, recargar } = useCargaCfo(() => fetchResumen(api, filtros, orden), [clave, orden, api.propertyId, api.token]);

  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-resumen">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando el resumen del CFO…">
        {(d) => (
          <>
            <AvisosCfo vista={d} />

            <section aria-labelledby="cfo-lo-importante" className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <SectionLabel>Lo más importante</SectionLabel>
                  <h2 id="cfo-lo-importante" className="sr-only">
                    Lo más importante
                  </h2>
                </div>
                <RadioSegmentado<CriterioOrden>
                  name="cfo-orden-hallazgos"
                  label="Ordenar hallazgos"
                  opciones={[
                    { id: "impacto", rotulo: "Ordenar por impacto $" },
                    { id: "urgencia", rotulo: "Ordenar por urgencia" },
                  ]}
                  value={orden}
                  onChange={setOrden}
                  className="gap-1"
                />
              </div>
              {d.hallazgos.length === 0 ? (
                <EstadoVacio icon={Lightbulb} titulo="Nada urgente en este periodo" mensaje="No hay hallazgos que superen los umbrales configurados. Si faltan datos, los avisos de arriba lo dicen; un hallazgo solo aparece con cifras reales." />
              ) : (
                <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3" data-testid="hallazgos" data-orden={orden}>
                  {d.hallazgos.map((h, i) => (
                    <HallazgoTarjeta key={h.id} hallazgo={h} destacada={i === 0} enlace={enlaceDeAccion(h.accion.ruta, base, filtros, pestanasDisponibles)} />
                  ))}
                </div>
              )}
            </section>

            <section aria-labelledby="cfo-narrativa" className="space-y-2">
              <SectionLabel>Resumen narrado</SectionLabel>
              <h2 id="cfo-narrativa" className="sr-only">
                Resumen narrado
              </h2>
              <Card className="p-4" data-testid="cfo-narrativa">
                {d.narrativa.oraciones.length === 0 ? (
                  <p className="text-ui text-muted-foreground">{d.narrativa.texto || "Sin datos suficientes para redactar el resumen."}</p>
                ) : (
                  <p className="text-ui leading-relaxed">
                    {d.narrativa.oraciones.map((o, i) => (
                      <Fragment key={i}>
                        {resaltarCifras(o.texto).map((p, j) => (typeof p === "string" ? <Fragment key={j}>{p}</Fragment> : <strong key={j} className="font-semibold tabular-nums">{p.cifra}</strong>))}{" "}
                      </Fragment>
                    ))}
                  </p>
                )}
              </Card>
            </section>

            <section aria-labelledby="cfo-kpis" className="space-y-2.5">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <SectionLabel>Indicadores</SectionLabel>
                  <h2 id="cfo-kpis" className="sr-only">
                    Indicadores
                  </h2>
                </div>
                <Card className="flex items-center gap-3 px-3.5 py-2" data-testid="cfo-titular">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{d.titular.etiqueta}</p>
                    <p className="font-display text-xl font-semibold tabular-nums" aria-label={d.titular.cifra.valor === null ? `${d.titular.etiqueta}: sin dato` : undefined}>
                      {d.titular.cifra.valor === null ? SIN_DATO : pesos(d.titular.cifra.valor)}
                    </p>
                  </div>
                  <ChipDeCifra cifra={d.titular.cifra} mostrarMedido={d.titular.origen === "softrestaurant"} />
                </Card>
              </div>
              {props.filtros.vista === "sucursal" ? (
                <KpiPorSucursal d={d} />
              ) : (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="kpis">
                  {d.kpis.total.kpis.map((k) => (
                    <KpiCard key={k.id} k={k} />
                  ))}
                </div>
              )}
              {d.kpis.noAsignado && (
                <Callout tone="neutral" titulo="No asignado a una sucursal" data-testid="kpi-no-asignado">
                  Costo del agente de la organización (IA de texto, no atribuible a una sucursal): {textoValor("centavos", d.kpis.noAsignado.costoAgenteCentavos.valor)}
                  {d.kpis.noAsignado.llmTexto.valor === null ? " · IA de texto sin dato" : ""}.
                </Callout>
              )}
              {d.multiSucursal.texto && (
                <p className="text-xs text-muted-foreground" data-testid="multi-sucursal">
                  {d.multiSucursal.texto}
                </p>
              )}
            </section>
          </>
        )}
      </CargaCfoVista>
    </PageContainer>
  );
}
