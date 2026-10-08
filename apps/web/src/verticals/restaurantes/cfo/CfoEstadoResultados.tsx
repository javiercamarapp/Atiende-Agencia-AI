// CFO-07 · pestaña Estado de resultados (P&L operativo): columnas por sucursal, «No asignado», Total y variación contra el comparativo.
// Cada línea lleva su chip de confianza (medido / estimado / capturado / SoftRestaurant). Una línea sin dato dice «Captura pendiente» y ofrece
// «Capturar costos» (solo owner/admin); el EBITDA solo aparece con TODAS las líneas con dato, si no dice «Incompleto: faltan …». Nunca 0 inventado.
import { useMemo, useState, type ReactNode } from "react";
import { Settings2, SquarePen } from "lucide-react";
import type { ColumnaPyl, ConceptoCosto, LineaId, LineaPyl, EstadoResultadosVista, Granularidad } from "@atiende/domain-restaurantes/cfo";
import { Button, Callout, ChartCard, DataTable, NativeSelect, PageContainer } from "@atiende/ui";
import { fetchEstadoResultados } from "./cfo-client.ts";
import { AjustesCfoDialogo } from "./AjustesCfoDialogo.tsx";
import { CapturaCostosDialogo, ORGANIZACION } from "./CapturaCostosDialogo.tsx";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, etiquetaMes, pesos, porcentaje, textoVariacion } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";
import { puedeEn } from "../lib/permisos.ts";

const NOMBRE_LINEA: Readonly<Record<LineaId, string>> = {
  ventas_brutas: "ventas brutas",
  descuentos_promocion: "descuentos",
  compensaciones: "compensaciones",
  ventas_netas: "ventas netas",
  iva_estimado: "IVA",
  ventas_netas_sin_iva: "ventas sin IVA",
  costo_ventas: "costo de ventas",
  utilidad_bruta: "utilidad bruta",
  costo_agente: "costo del agente",
  comision_terminal: "comisión de terminal",
  nomina: "nómina",
  renta: "renta",
  servicios: "servicios",
  otros: "otros",
  ebitda: "EBITDA",
};

/** Línea del P&L -> concepto que la alimenta (solo las capturables). */
const CONCEPTO_DE_LINEA: Readonly<Partial<Record<LineaId, ConceptoCosto>>> = {
  costo_ventas: "insumos",
  comision_terminal: "comision_terminal",
  nomina: "nomina",
  renta: "renta",
  servicios: "servicios",
  otros: "otros",
};
const DERIVADAS: ReadonlySet<LineaId> = new Set<LineaId>(["utilidad_bruta", "ebitda"]);
const SUBTOTALES: ReadonlySet<LineaId> = new Set<LineaId>(["ventas_netas", "ventas_netas_sin_iva", "utilidad_bruta", "ebitda"]);

const claveColumna = (c: ColumnaPyl): string => (c.clave === "sucursal" ? (c.propertyId ?? c.nombre) : c.clave);
const lista = (ids: readonly LineaId[]): string => ids.map((i) => NOMBRE_LINEA[i]).join(", ");

type TipoFila = "titular" | "linea" | "margen" | "memo" | "ratio";
interface FilaPyl {
  readonly id: string;
  readonly tipo: TipoFila;
  readonly etiqueta: string;
  readonly lineaId?: LineaId;
  readonly celda: (c: ColumnaPyl) => ReactNode;
  /** Variación del Total contra el comparativo (texto). */
  readonly variacion: string | null;
}

function celdaLinea(c: ColumnaPyl, l: LineaPyl | undefined): ReactNode {
  if (!l) return SIN_DATO;
  if (DERIVADAS.has(l.id)) {
    if (l.id === "ebitda" && c.incompleto.length > 0) return <span className="text-warning" data-testid="ebitda-incompleto">{`Incompleto: faltan ${lista(c.incompleto)}`}</span>;
    if (l.cifra.valor === null) return <span className="text-muted-foreground">{l.faltaCaptura ? "Incompleto: falta el costo de ventas" : SIN_DATO}</span>;
  } else if (l.faltaCaptura) {
    return <span className="text-warning" data-testid="captura-pendiente">Captura pendiente</span>;
  }
  if (l.cifra.valor === null) return <span title={l.nota ?? undefined}>{SIN_DATO}</span>;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1" title={l.nota ?? undefined}>
      <span className="tabular-nums">{pesos(l.cifra.valor)}</span>
      <ChipDeCifra cifra={l.cifra} mostrarMedido />
      {l.estimadoPorProrrateo && <span className="rounded-full border border-warning/30 bg-warning-tint px-1.5 text-2xs text-warning">Prorrateo</span>}
    </span>
  );
}

function variacionPct(actual: number | null, base: number | null): string | null {
  if (actual === null || base === null || base === 0) return null;
  return textoVariacion({ tipo: "pct", valor: Math.round(((actual - base) / Math.abs(base)) * 1000) / 10 });
}

function construirFilas(d: EstadoResultadosVista, comparativo: EstadoResultadosVista | null): FilaPyl[] {
  const acumulado = d.estadoResultados.acumulado;
  const total = acumulado.columnas.find((c) => c.clave === "total");
  const totalBase = comparativo?.estadoResultados.acumulado.columnas.find((c) => c.clave === "total");
  const filas: FilaPyl[] = [];
  const variacionLinea = (id: LineaId): string | null => variacionPct(total?.lineas.find((l) => l.id === id)?.cifra.valor ?? null, totalBase?.lineas.find((l) => l.id === id)?.cifra.valor ?? null);

  filas.push({
    id: "titular",
    tipo: "titular",
    etiqueta: total?.titular.etiqueta ?? "Ventas",
    celda: (c) => (
      <span className="inline-flex flex-col items-end">
        <span className="inline-flex items-center gap-1">
          <span className="tabular-nums">{pesos(c.titular.cifra.valor)}</span>
          <ChipDeCifra cifra={c.titular.cifra} mostrarMedido={c.titular.origen === "softrestaurant"} />
        </span>
        {c.titular.ventasAgenteMemo && c.titular.ventasAgenteMemo.valor !== null ? <span className="text-2xs text-muted-foreground">del cual el agente tomó {pesos(c.titular.ventasAgenteMemo.valor)}</span> : null}
      </span>
    ),
    variacion: null,
  });
  const ids = (total?.lineas ?? acumulado.columnas[0]?.lineas ?? []).map((l) => l.id);
  for (const id of ids) {
    filas.push({ id, tipo: "linea", lineaId: id, etiqueta: (total?.lineas.find((l) => l.id === id)?.etiqueta ?? NOMBRE_LINEA[id]), celda: (c) => celdaLinea(c, c.lineas.find((l) => l.id === id)), variacion: variacionLinea(id) });
  }
  filas.push({
    id: "margen",
    tipo: "margen",
    etiqueta: "Margen de contribución",
    celda: (c) => (
      <span className="inline-flex flex-wrap items-center justify-end gap-1" title={c.margenContribucion.parcial ? `Parcial: faltan ${c.margenContribucion.faltan.join(", ")}` : undefined}>
        <span className="tabular-nums">{pesos(c.margenContribucion.cifra.valor)}</span>
        {c.margenContribucion.parcial && c.margenContribucion.cifra.valor !== null ? <span className="text-2xs text-warning">parcial</span> : null}
        <ChipDeCifra cifra={c.margenContribucion.cifra} mostrarMedido />
      </span>
    ),
    variacion: variacionPct(total?.margenContribucion.cifra.valor ?? null, totalBase?.margenContribucion.cifra.valor ?? null),
  });
  const memo: Array<[string, (c: ColumnaPyl) => ColumnaPyl["memo"][keyof ColumnaPyl["memo"]]]> = [
    ["Memo: cortesías a precio de lista (estimado)", (c) => c.memo.cortesias],
    ["Memo: cancelaciones ($)", (c) => c.memo.cancelaciones],
    ["Memo: no recogidos ($)", (c) => c.memo.noRecogidos],
    ["Memo: propinas con tarjeta (fuera de ingresos)", (c) => c.memo.propinasTarjeta],
  ];
  memo.forEach(([etiqueta, f], i) =>
    filas.push({
      id: `memo-${i}`, tipo: "memo", etiqueta,
      celda: (c) => {
        const v = f(c);
        return typeof v === "number" || v === null ? SIN_DATO : <span className="inline-flex items-center justify-end gap-1"><span className="tabular-nums">{pesos(v.valor)}</span><ChipDeCifra cifra={v} /></span>;
      },
      variacion: null,
    }),
  );
  const ratios: Array<[string, (c: ColumnaPyl) => ColumnaPyl["ratios"][keyof ColumnaPyl["ratios"]], "pct" | "pesos"]> = [
    ["Margen bruto", (c) => c.ratios.margenBrutoPct, "pct"],
    ["Food cost", (c) => c.ratios.foodCostPct, "pct"],
    ["Prime cost (food cost + nómina)", (c) => c.ratios.primeCostPct, "pct"],
    ["Costo del agente sobre ventas", (c) => c.ratios.costoAgentePct, "pct"],
    ["Margen de contribución", (c) => c.ratios.margenContribucionPct, "pct"],
    ["Punto de equilibrio (ventas netas sin IVA)", (c) => c.ratios.puntoEquilibrio, "pesos"],
  ];
  ratios.forEach(([etiqueta, f, tipo], i) =>
    filas.push({
      id: `ratio-${i}`, tipo: "ratio", etiqueta: `Razón: ${etiqueta}`,
      celda: (c) => <span className="inline-flex items-center justify-end gap-1"><span className="tabular-nums">{tipo === "pct" ? porcentaje(f(c).valor) : pesos(f(c).valor)}</span><ChipDeCifra cifra={f(c)} /></span>,
      variacion: null,
    }),
  );
  return filas;
}

async function cargarConComparativo(props: CfoPaginaProps, granularidad: Granularidad): Promise<{ readonly d: EstadoResultadosVista; readonly comparativo: EstadoResultadosVista | null }> {
  const d = await fetchEstadoResultados(props.api, props.filtros, granularidad);
  const { comparadoDesde, comparadoHasta } = d.periodo;
  if (!comparadoDesde || !comparadoHasta) return { d, comparativo: null };
  try {
    // Mismo estado de resultados sobre el rango comparado (el API devuelve ese rango en `periodo`): la variación se calcula contra lo que el servidor midió.
    return { d, comparativo: await fetchEstadoResultados(props.api, { ...props.filtros, desde: comparadoDesde, hasta: comparadoHasta }, granularidad) };
  } catch {
    return { d, comparativo: null };
  }
}

export function CfoEstadoResultados(props: CfoPaginaProps) {
  const { api, filtros, role, alcance } = props;
  const [granularidad, setGranularidad] = useState<Granularidad>("mes");
  const [captura, setCaptura] = useState<{ readonly concepto?: ConceptoCosto; readonly ambito?: string } | null>(null);
  const [ajustes, setAjustes] = useState(false);
  const clave = `${filtros.desde}|${filtros.hasta}|${filtros.sucursales?.join(",") ?? ""}|${filtros.comparar}`;
  const { carga, recargando, recargar } = useCargaCfo(() => cargarConComparativo(props, granularidad), [clave, granularidad, api.propertyId, api.token]);
  const carga0 = carga;
  // Sin la migración de captura (bloques.captura === false) no hay dónde guardar, y mientras carga o si falla no está confirmado: la acción solo aparece con la captura confirmada.
  const capturaDisponible = carga0.estado === "listo" && carga0.datos.d.bloques.captura !== false;
  const puedeCapturar = puedeEn(role, "cfo.capturar") && capturaDisponible;

  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-pyl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label htmlFor="pyl-granularidad" className="text-xs text-muted-foreground">
            Detalle por
          </label>
          <NativeSelect id="pyl-granularidad" size="sm" value={granularidad} onChange={(e) => setGranularidad(e.target.value as Granularidad)} wrapperClassName="w-32" data-testid="pyl-granularidad">
            <option value="mes">Mes</option>
            <option value="semana">Semana</option>
            <option value="dia">Día</option>
          </NativeSelect>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {puedeCapturar && (
            <Button type="button" size="sm" className="gap-1.5" onClick={() => setCaptura({})} data-testid="capturar-costos">
              <SquarePen className="size-3.5" aria-hidden="true" />
              Capturar costos
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setAjustes(true)} data-testid="abrir-ajustes">
            <Settings2 className="size-3.5" aria-hidden="true" />
            Ajustes del CFO
          </Button>
        </div>
      </div>

      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando el estado de resultados…">
        {({ d, comparativo }) => <Contenido d={d} comparativo={comparativo} puedeCapturar={puedeCapturar} onCapturar={(c) => setCaptura(c)} />}
      </CargaCfoVista>

      {puedeCapturar && (
        <CapturaCostosDialogo
          abierto={captura !== null}
          onCerrar={() => setCaptura(null)}
          api={api}
          sucursales={alcance.sucursales}
          puedeOrganizacion={alcance.organizacionCompleta}
          mesInicial={`${filtros.hasta.slice(0, 7)}-01`}
          {...(captura?.concepto ? { conceptoInicial: captura.concepto } : {})}
          {...(captura?.ambito ? { ambitoInicial: captura.ambito } : {})}
          onGuardado={recargar}
        />
      )}
      <AjustesCfoDialogo abierto={ajustes} onCerrar={() => setAjustes(false)} api={api} onGuardado={recargar} />
    </PageContainer>
  );
}

function Contenido({ d, comparativo, puedeCapturar, onCapturar }: { readonly d: EstadoResultadosVista; readonly comparativo: EstadoResultadosVista | null; readonly puedeCapturar: boolean; readonly onCapturar: (c: { concepto: ConceptoCosto; ambito?: string }) => void }) {
  const er = d.estadoResultados;
  const columnas = er.acumulado.columnas;
  const filas = useMemo(() => construirFilas(d, comparativo), [d, comparativo]);
  const total = columnas.find((c) => c.clave === "total");
  const sinColumnas = columnas.length === 0;

  // Dónde falta cada línea capturable (para abrir la captura ya apuntando a la sucursal correcta).
  function primerAmbitoPendiente(id: LineaId): string | undefined {
    const col = columnas.find((c) => c.clave !== "total" && c.lineas.find((l) => l.id === id)?.faltaCaptura);
    if (!col) return undefined;
    return col.clave === "no_asignado" ? ORGANIZACION : (col.propertyId ?? undefined);
  }
  const pendienteEnAlgunaColumna = (id: LineaId): boolean => columnas.some((c) => c.lineas.find((l) => l.id === id)?.faltaCaptura);

  const variacionDisponible = comparativo !== null;
  const periodos = er.periodos.slice(-24);

  return (
    <>
      <AvisosCfo vista={d} />
      {total && total.incompleto.length > 0 && (
        <Callout tone="warning" titulo="EBITDA incompleto" data-testid="pyl-incompleto">
          Faltan {lista(total.incompleto)}. Mientras tanto se muestra el margen de contribución, que no depende de esas líneas; no se inventa ningún monto.
        </Callout>
      )}
      {total && total.notas.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {total.notas.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <ChartCard titulo="Estado de resultados operativo" subtitulo={`${er.rango.desde} al ${er.rango.hasta} · pesos${variacionDisponible ? " · variación del Total contra el periodo comparado" : " · sin variación para esta comparación"}`} tamano="S">
        {sinColumnas ? (
          <p role="status" className="py-6 text-center text-xs text-faint">
            Sin sucursales en el alcance elegido.
          </p>
        ) : (
          <DataTable<FilaPyl>
            etiqueta="Estado de resultados"
            filas={filas}
            obtenerId={(f) => f.id}
            paginacion={false}
            vista="tabla"
            atributosFila={(f) => ({ "data-linea": f.lineaId ?? f.id, "data-tipo": f.tipo })}
            columnas={[
              {
                id: "concepto",
                encabezado: "Concepto",
                principal: true,
                celda: (f) => {
                  const concepto = f.lineaId ? CONCEPTO_DE_LINEA[f.lineaId] : undefined;
                  const necesita = f.lineaId !== undefined && concepto !== undefined && pendienteEnAlgunaColumna(f.lineaId);
                  return (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className={f.lineaId && SUBTOTALES.has(f.lineaId) ? "font-semibold" : f.tipo === "memo" || f.tipo === "ratio" ? "text-muted-foreground" : undefined}>{f.etiqueta}</span>
                      {necesita && puedeCapturar && f.lineaId && concepto ? (
                        <Button type="button" size="sm" variant="outline" aria-label={`Capturar costos: ${NOMBRE_LINEA[f.lineaId]}`} onClick={() => { const ambito = primerAmbitoPendiente(f.lineaId as LineaId); onCapturar({ concepto, ...(ambito ? { ambito } : {}) }); }}>
                          Capturar costos
                        </Button>
                      ) : null}
                    </span>
                  );
                },
              },
              ...columnas.map((c) => ({
                id: claveColumna(c),
                encabezado: c.clave === "no_asignado" ? "No asignado" : c.nombre,
                alinear: "right" as const,
                className: c.clave === "total" ? "font-semibold" : undefined,
                celda: (f: FilaPyl) => f.celda(c),
              })),
              { id: "variacion", encabezado: "Variación (Total)", alinear: "right" as const, className: "tabular-nums", celda: (f: FilaPyl) => (f.variacion === null ? SIN_DATO : f.variacion) },
            ]}
          />
        )}
      </ChartCard>

      {periodos.length > 1 && total && (
        <ChartCard titulo={`Total por ${d.estadoResultados.granularidad === "mes" ? "mes" : d.estadoResultados.granularidad === "semana" ? "semana" : "día"}`} subtitulo={er.periodos.length > 24 ? `Últimos 24 de ${er.periodos.length} periodos` : undefined} tamano="S">
          <DataTable<{ readonly id: LineaId; readonly etiqueta: string }>
            etiqueta="Estado de resultados por periodo"
            filas={(periodos[0]?.columnas.find((c) => c.clave === "total")?.lineas ?? []).map((l) => ({ id: l.id, etiqueta: l.etiqueta }))}
            obtenerId={(f) => f.id}
            paginacion={false}
            vista="tabla"
            columnas={[
              { id: "linea", encabezado: "Concepto", principal: true, celda: (f) => f.etiqueta },
              ...periodos.map((p) => ({
                id: p.clave,
                encabezado: /^\d{4}-\d{2}$/.test(p.clave) ? etiquetaMes(p.clave) : p.clave,
                alinear: "right" as const,
                celda: (f: { readonly id: LineaId }) => {
                  const col = p.columnas.find((c) => c.clave === "total");
                  return col ? celdaLinea(col, col.lineas.find((l) => l.id === f.id)) : SIN_DATO;
                },
              })),
            ]}
          />
        </ChartCard>
      )}
      <p className="text-xs text-muted-foreground">
        «{SIN_DATO}» = sin dato; «Captura pendiente» = falta que captures ese costo. El EBITDA se muestra solo con todas las líneas completas. Los costos mensuales de un periodo parcial se prorratean por días.
      </p>
    </>
  );
}
