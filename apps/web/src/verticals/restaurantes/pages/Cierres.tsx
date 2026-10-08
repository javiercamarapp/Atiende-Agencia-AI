// Cierre del día y resumen semanal (R-42): ventas, canales, cancelaciones y tiempos de entrega por sucursal, congelados por fecha de
// negocio (día local de la sucursal). Solo owner/admin. Todo es agregado: sin teléfonos, nombres ni direcciones. Los periodos ya
// terminados que aún no tienen cierre se ofrecen con un botón REAL que llama al API (idempotente: repetirlo devuelve el mismo cierre).
// Un cierre generado no se recalcula: se rotula con su hora de generación. Sin dato = "—" con su razón (nunca 0 inventado).
import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, CircleSlash, Clock, DollarSign, ShoppingBag, Receipt } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, EstadoVacio, NativeSelect, PageContainer, StatCard, notify } from "@atiende/ui";
import { fetchCierres, generarCierre } from "../lib/cierres-client.ts";
import type { CierreFila, CierreTipo, CierresLista } from "../lib/cierres-client.ts";
import { desdeError } from "../voz/carga.ts";
import type { Carga } from "../voz/carga.ts";
import { formatoDia, formatoMxn, formatoPct } from "../voz/formato-kpi.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ROLES_CIERRES: ReadonlySet<string> = new Set(["owner", "admin"]);
const ETIQUETA_CANAL: Readonly<Record<CierreFila["porCanal"][number]["canal"], string>> = { web: "Pedido en línea (histórico)", whatsapp: "WhatsApp", voice: "Llamada", admin: "Capturado por el equipo" };

function formatoMin(min: number | null): string {
  return min === null ? "—" : `${min} min`;
}

/** "2026-03-02" + "2026-03-08" -> "2 mar al 8 mar"; un día -> "10 mar". */
function etiquetaPeriodo(c: Pick<CierreFila, "fechaInicio" | "fechaFin">): string {
  return c.fechaInicio === c.fechaFin ? formatoDia(c.fechaInicio) : `${formatoDia(c.fechaInicio)} al ${formatoDia(c.fechaFin)}`;
}

function delta(pct: number | null | undefined): { readonly pct: number; readonly bueno: boolean } | null {
  return pct === null || pct === undefined ? null : { pct, bueno: pct >= 0 };
}

export function CierresPage({ apiBaseUrl, token, propertyId, role, fetchImpl }: RestaurantesShellContext & { readonly fetchImpl?: typeof fetch }) {
  const puedeVer = ROLES_CIERRES.has(role);
  const [tipo, setTipo] = useState<CierreTipo>("dia");
  const [datos, setDatos] = useState<Carga<CierresLista>>({ estado: "cargando" });
  const [version, setVersion] = useState(0);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const [generando, setGenerando] = useState<string | null>(null);
  const reintentar = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelado = false;
    setDatos({ estado: "cargando" });
    (async () => {
      try {
        const lista = await fetchCierres(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, tipo);
        if (!cancelado) setDatos({ estado: "listo", datos: lista });
      } catch (err) {
        if (!cancelado) setDatos(desdeError(err, "No se pudieron cargar los cierres."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, tipo, version, fetchImpl, puedeVer]);

  async function generar(fecha: string) {
    setGenerando(fecha);
    try {
      const r = await generarCierre(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, tipo, fecha);
      notify.success(r.estado === "creado" ? `Cierre de ${etiquetaPeriodo(r.cierre)} generado.` : `El cierre de ${etiquetaPeriodo(r.cierre)} ya existía.`);
      setSeleccion(r.cierre.id);
      reintentar();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "No se pudo generar el cierre.");
    } finally {
      setGenerando(null);
    }
  }

  return (
    <PageContainer padding="none">
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display truncate text-xl font-semibold">Cierre del día</h1>
          <p className="mt-1 truncate text-ui text-muted-foreground">Ventas, canales, cancelaciones y tiempos de entrega, congelados por día de negocio de la sucursal.</p>
        </div>
        {puedeVer ? (
          <div className="shrink-0">
            <label htmlFor="tipo-cierre" className="sr-only">
              Tipo de cierre
            </label>
            <NativeSelect
              id="tipo-cierre"
              value={tipo}
              onChange={(e) => {
                setSeleccion(null);
                setTipo(e.target.value as CierreTipo);
              }}
            >
              <option value="dia">Cierre del día</option>
              <option value="semana">Resumen semanal</option>
            </NativeSelect>
          </div>
        ) : null}
      </header>

      {!puedeVer ? (
        <Callout tone="info">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> ven los cierres — tu rol actual es <strong className="text-foreground">{role}</strong>.
        </Callout>
      ) : datos.estado === "cargando" ? (
        <EstadoCargando etiqueta="Cargando cierres…" />
      ) : datos.estado === "no_disponible" ? (
        <EstadoVacio
          icon={CalendarCheck}
          titulo="Cierres no disponibles todavía"
          mensaje="El cierre del día y el resumen semanal aún no están activos en este negocio (requieren la actualización de base de datos pendiente). Cuando lo estén, aquí verás cada cierre."
        />
      ) : datos.estado === "error" ? (
        <EstadoError mensaje={datos.mensaje} onReintentar={reintentar} />
      ) : (
        <Contenido lista={datos.datos} seleccion={seleccion} onSeleccion={setSeleccion} generando={generando} onGenerar={generar} />
      )}
    </PageContainer>
  );
}

function Contenido({
  lista,
  seleccion,
  onSeleccion,
  generando,
  onGenerar,
}: {
  readonly lista: CierresLista;
  readonly seleccion: string | null;
  readonly onSeleccion: (id: string) => void;
  readonly generando: string | null;
  readonly onGenerar: (fecha: string) => void;
}) {
  const actual = lista.cierres.find((c) => c.id === seleccion) ?? lista.cierres[0] ?? null;
  const esDia = lista.tipo === "dia";
  return (
    <div className="space-y-2.5" data-testid="cierres">
      <p className="text-xs text-muted-foreground">
        Zona horaria de la sucursal: {lista.zonaHoraria}. Hoy es {formatoDia(lista.hoy)}: el día en curso no se cierra hasta que termina. Cifras agregadas: no incluyen teléfonos ni nombres ni el tráfico del widget de demostración.
      </p>

      {lista.pendientes.length > 0 ? (
        <Callout tone="info" data-testid="cierres-pendientes">
          <p className="mb-1.5">{esDia ? "Estos días ya terminaron y todavía no tienen cierre:" : "Estas semanas ya terminaron y todavía no tienen resumen:"}</p>
          <div className="flex flex-wrap gap-1.5">
            {lista.pendientes.map((f) => (
              <Button key={f} type="button" size="sm" variant="outline" loading={generando === f} disabled={generando !== null} onClick={() => onGenerar(f)} data-fecha={f}>
                {esDia ? `Generar ${formatoDia(f)}` : `Generar semana del ${formatoDia(f)}`}
              </Button>
            ))}
          </div>
        </Callout>
      ) : null}

      {actual === null ? (
        <EstadoVacio
          icon={CalendarCheck}
          titulo={esDia ? "Aún no hay cierres del día" : "Aún no hay resúmenes semanales"}
          mensaje={lista.pendientes.length > 0 ? "Genera el primero con los botones de arriba." : "Cuando termine un periodo con pedidos, aquí aparecerá su cierre."}
        />
      ) : (
        <Detalle cierre={actual} esDia={esDia} />
      )}

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>{esDia ? "Cierres anteriores" : "Resúmenes anteriores"}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<CierreFila>
            etiqueta={esDia ? "Cierres del día" : "Resúmenes semanales"}
            filas={[...lista.cierres]}
            obtenerId={(c) => c.id}
            atributosFila={(c) => ({ "data-cierre": c.fechaInicio })}
            vacio={{ titulo: "Sin cierres", mensaje: "Todavía no se ha generado ninguno." }}
            paginacion={false}
            columnas={[
              { id: "periodo", encabezado: esDia ? "Día" : "Semana", principal: true, celda: (c) => etiquetaPeriodo(c) },
              { id: "pedidos", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (c) => c.pedidos },
              { id: "ventas", encabezado: "Ventas", alinear: "right", className: "tabular-nums", celda: (c) => formatoMxn(c.ventasCentavos) },
              { id: "cancelados", encabezado: "Cancelados", alinear: "right", className: "tabular-nums", celda: (c) => c.cancelados },
              {
                id: "ver",
                encabezado: "",
                alinear: "right",
                celda: (c) => (
                  <Button type="button" size="sm" variant={c.id === actual?.id ? "secondary" : "ghost"} onClick={() => onSeleccion(c.id)} aria-label={`Ver el cierre de ${etiquetaPeriodo(c)}`}>
                    Ver
                  </Button>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Detalle({ cierre, esDia }: { readonly cierre: CierreFila; readonly esDia: boolean }) {
  const comp = cierre.comparativo;
  const notaComp = esDia ? "vs mismo día de la semana pasada" : "vs semana anterior";
  const t = cierre.tiempos;
  return (
    <div className="space-y-2.5" data-testid="cierre-detalle" data-cierre-id={cierre.id}>
      <p className="text-xs text-muted-foreground">
        {esDia ? "Cierre del" : "Resumen de la semana del"} {etiquetaPeriodo(cierre)} · generado {cierre.generadoPor === "sistema" ? "automáticamente" : "por el equipo"}. Un cierre generado no se recalcula.
      </p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <StatCard icon={DollarSign} label="Ventas" value={formatoMxn(cierre.ventasCentavos)} delta={delta(comp?.variacionVentasPct)} deltaNota={notaComp} nota="Sin cancelados, no recogidos ni programados pendientes" />
        <StatCard icon={ShoppingBag} label="Pedidos" value={String(cierre.pedidos)} delta={delta(comp?.variacionPedidosPct)} deltaNota={notaComp} nota={cierre.conProblema > 0 ? `${cierre.conProblema} con problema` : undefined} />
        <StatCard
          icon={Receipt}
          label="Ticket promedio"
          value={formatoMxn(cierre.ticketPromedioCentavos)}
          {...(cierre.ticketPromedioCentavos === null ? { sinDato: "Sin pedidos en el periodo." } : { nota: "Ventas entre pedidos" })}
        />
        <StatCard
          icon={CircleSlash}
          label="Cancelaciones"
          value={String(cierre.cancelados)}
          {...(cierre.cancelacionPct === null ? { nota: "Sin cancelaciones ni pedidos en el periodo" } : { nota: `${formatoPct(cierre.cancelacionPct)} de los pedidos · ${formatoMxn(cierre.canceladosCentavos)} · ${cierre.noRecogidos} no recogidos` })}
        />
        <StatCard
          icon={Clock}
          label="Tiempo de entrega promedio"
          value={formatoMin(t.promedioMin)}
          {...(t.entregados === 0
            ? { sinDato: "Ningún pedido entregado con hora registrada en el periodo." }
            : { nota: `Mediana ${formatoMin(t.medianaMin)} · 9 de cada 10 en ${formatoMin(t.p90Min)} o menos (${t.entregados} entregados)` })}
        />
      </div>

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>Por canal</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<CierreFila["porCanal"][number]>
            etiqueta="Ventas por canal"
            filas={cierre.porCanal.filter((c) => c.canal !== "web" || c.pedidos > 0 || c.cancelados > 0 || c.ventasCentavos > 0)}
            obtenerId={(c) => c.canal}
            vacio={{ titulo: "Sin canales", mensaje: "Sin pedidos en el periodo." }}
            paginacion={false}
            columnas={[
              { id: "canal", encabezado: "Canal", principal: true, celda: (c) => ETIQUETA_CANAL[c.canal] },
              { id: "pedidos", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (c) => c.pedidos },
              { id: "ventas", encabezado: "Ventas", alinear: "right", className: "tabular-nums", celda: (c) => formatoMxn(c.ventasCentavos) },
              { id: "cancelados", encabezado: "Cancelados", alinear: "right", className: "tabular-nums", celda: (c) => c.cancelados },
            ]}
          />
        </CardContent>
      </Card>

      {cierre.porDia ? (
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle>Por día de la semana</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable<NonNullable<CierreFila["porDia"]>[number]>
              etiqueta="Ventas por día de la semana"
              filas={[...cierre.porDia]}
              obtenerId={(d) => d.fecha}
              atributosFila={(d) => ({ "data-dia": d.fecha })}
              vacio={{ titulo: "Sin días", mensaje: "Sin datos." }}
              paginacion={false}
              columnas={[
                { id: "dia", encabezado: "Día", principal: true, celda: (d) => formatoDia(d.fecha) },
                { id: "pedidos", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (d) => d.pedidos },
                { id: "ventas", encabezado: "Ventas", alinear: "right", className: "tabular-nums", celda: (d) => formatoMxn(d.ventasCentavos) },
              ]}
            />
          </CardContent>
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground" data-testid="notas-definiciones">
        Definiciones: el día es el día calendario en la zona horaria de la sucursal y la semana va de lunes a domingo. Un pedido cuenta en el momento en que entra a operar (los programados, al promoverse). El tiempo de entrega solo cuenta pedidos con estado entregado y hora de entrega
        registrada. {comp ? `Comparativo: ${etiquetaPeriodo(comp)} (${comp.pedidos} pedidos, ${formatoMxn(comp.ventasCentavos)}).` : ""}
      </p>
    </div>
  );
}
