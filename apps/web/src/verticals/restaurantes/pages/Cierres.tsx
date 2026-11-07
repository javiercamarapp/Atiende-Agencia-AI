// Cierre del día y resumen semanal (R-42): ventas, canales, cancelaciones y tiempos de entrega por sucursal, congelados por fecha de
// negocio (día local de la sucursal). Solo owner/admin. Todo es agregado: sin teléfonos, nombres ni direcciones. Los periodos ya
// terminados que aún no tienen cierre se ofrecen con un botón REAL que llama al API (idempotente: repetirlo devuelve el mismo cierre).
// Un cierre generado no se recalcula: se rotula con su hora de generación. Sin dato = "—" con su razón (nunca 0 inventado).
import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, CircleSlash, Clock, DollarSign, ShoppingBag, Receipt } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, EstadoVacio, Selector, PageContainer, StatCard, notify, useT } from "@atiende/ui";
import type { Traductor } from "@atiende/ui";
import { restaurantesCierres } from "@atiende/ui/i18n/restaurantes/cierres";
import { fetchCierres, generarCierre } from "../lib/cierres-client.ts";
import type { CierreFila, CierreTipo, CierresLista } from "../lib/cierres-client.ts";
import { desdeError } from "../voz/carga.ts";
import type { Carga } from "../voz/carga.ts";
import { formatoDia, formatoMxn, formatoPct } from "../voz/formato-kpi.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ROLES_CIERRES: ReadonlySet<string> = new Set(["owner", "admin"]);

function etiquetaCanal(canal: CierreFila["porCanal"][number]["canal"], t: Traductor): string {
  return canal === "whatsapp" ? "WhatsApp" : t(`restaurantes.cierres.canal.${canal}` as const);
}

function formatoMin(min: number | null): string {
  return min === null ? "—" : `${min} min`;
}

/** "2026-03-02" + "2026-03-08" -> "2 mar al 8 mar"; un día -> "10 mar". */
function etiquetaPeriodo(c: Pick<CierreFila, "fechaInicio" | "fechaFin">, t: Traductor): string {
  return c.fechaInicio === c.fechaFin ? formatoDia(c.fechaInicio) : t("restaurantes.cierres.periodo", { inicio: formatoDia(c.fechaInicio), fin: formatoDia(c.fechaFin) });
}

function delta(pct: number | null | undefined): { readonly pct: number; readonly bueno: boolean } | null {
  return pct === null || pct === undefined ? null : { pct, bueno: pct >= 0 };
}

export function CierresPage({ apiBaseUrl, token, propertyId, role, fetchImpl }: RestaurantesShellContext & { readonly fetchImpl?: typeof fetch }) {
  const t = useT(restaurantesCierres);
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
        if (!cancelado) setDatos(desdeError(err, t("restaurantes.cierres.error.cargar")));
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
      notify.success(t(r.estado === "creado" ? "restaurantes.cierres.exito.creado" : "restaurantes.cierres.exito.existia", { periodo: etiquetaPeriodo(r.cierre, t) }));
      setSeleccion(r.cierre.id);
      reintentar();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t("restaurantes.cierres.error.generar"));
    } finally {
      setGenerando(null);
    }
  }

  return (
    <PageContainer padding="none">
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display truncate text-xl font-semibold">{t("restaurantes.cierres.titulo")}</h1>
          <p className="mt-1 truncate text-ui text-muted-foreground">{t("restaurantes.cierres.descripcion")}</p>
        </div>
        {puedeVer ? (
          <div className="shrink-0">
            <label htmlFor="tipo-cierre" className="sr-only">
              {t("restaurantes.cierres.tipo.aria")}
            </label>
            <Selector
              id="tipo-cierre"
              value={tipo}
              onChange={(e) => {
                setSeleccion(null);
                setTipo(e.target.value as CierreTipo);
              }}
            >
              <option value="dia">{t("restaurantes.cierres.titulo")}</option>
              <option value="semana">{t("restaurantes.cierres.tipo.semana")}</option>
            </Selector>
          </div>
        ) : null}
      </header>

      {!puedeVer ? (
        <Callout tone="info">
          {t("restaurantes.cierres.soloRoles.inicio")}
          {/* // i18n-ignorar: owner/admin son los nombres de rol del sistema, iguales en ambos idiomas */}
          <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong>
          {t("restaurantes.cierres.soloRoles.fin")}
          <strong className="text-foreground">{role}</strong>.
        </Callout>
      ) : datos.estado === "cargando" ? (
        <EstadoCargando etiqueta={t("restaurantes.cierres.cargando")} />
      ) : datos.estado === "no_disponible" ? (
        <EstadoVacio
          icon={CalendarCheck}
          titulo={t("restaurantes.cierres.noDisponible.titulo")}
          mensaje={t("restaurantes.cierres.noDisponible.mensaje")}
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
  const t = useT(restaurantesCierres);
  const actual = lista.cierres.find((c) => c.id === seleccion) ?? lista.cierres[0] ?? null;
  const esDia = lista.tipo === "dia";
  return (
    <div className="space-y-2.5" data-testid="cierres">
      <p className="text-xs text-muted-foreground">
        {t("restaurantes.cierres.zona", { zona: lista.zonaHoraria, hoy: formatoDia(lista.hoy) })}
      </p>

      {lista.pendientes.length > 0 ? (
        <Callout tone="info" data-testid="cierres-pendientes">
          <p className="mb-1.5">{esDia ? t("restaurantes.cierres.pendientes.dia") : t("restaurantes.cierres.pendientes.semana")}</p>
          <div className="flex flex-wrap gap-1.5">
            {lista.pendientes.map((f) => (
              <Button key={f} type="button" size="sm" variant="outline" loading={generando === f} disabled={generando !== null} onClick={() => onGenerar(f)} data-fecha={f}>
                {t(esDia ? "restaurantes.cierres.generar.dia" : "restaurantes.cierres.generar.semana", { fecha: formatoDia(f) })}
              </Button>
            ))}
          </div>
        </Callout>
      ) : null}

      {actual === null ? (
        <EstadoVacio
          icon={CalendarCheck}
          titulo={esDia ? t("restaurantes.cierres.vacio.dia") : t("restaurantes.cierres.vacio.semana")}
          mensaje={lista.pendientes.length > 0 ? t("restaurantes.cierres.vacio.conPendientes") : t("restaurantes.cierres.vacio.sinPendientes")}
        />
      ) : (
        <Detalle cierre={actual} esDia={esDia} />
      )}

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>{esDia ? t("restaurantes.cierres.anteriores.dia") : t("restaurantes.cierres.anteriores.semana")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<CierreFila>
            etiqueta={esDia ? t("restaurantes.cierres.tabla.dia") : t("restaurantes.cierres.tabla.semana")}
            filas={[...lista.cierres]}
            obtenerId={(c) => c.id}
            atributosFila={(c) => ({ "data-cierre": c.fechaInicio })}
            vacio={{ titulo: t("restaurantes.cierres.tabla.vacioTitulo"), mensaje: t("restaurantes.cierres.tabla.vacioMensaje") }}
            paginacion={false}
            columnas={[
              { id: "periodo", encabezado: esDia ? t("restaurantes.cierres.col.dia") : t("restaurantes.cierres.col.semana"), principal: true, celda: (c) => etiquetaPeriodo(c, t) },
              { id: "pedidos", encabezado: t("restaurantes.cierres.col.pedidos"), alinear: "right", className: "tabular-nums", celda: (c) => c.pedidos },
              { id: "ventas", encabezado: t("restaurantes.cierres.col.ventas"), alinear: "right", className: "tabular-nums", celda: (c) => formatoMxn(c.ventasCentavos) },
              { id: "cancelados", encabezado: t("restaurantes.cierres.col.cancelados"), alinear: "right", className: "tabular-nums", celda: (c) => c.cancelados },
              {
                id: "ver",
                encabezado: "",
                alinear: "right",
                celda: (c) => (
                  <Button type="button" size="sm" variant={c.id === actual?.id ? "secondary" : "ghost"} onClick={() => onSeleccion(c.id)} aria-label={t("restaurantes.cierres.ver.aria", { periodo: etiquetaPeriodo(c, t) })}>
                    {t("restaurantes.cierres.ver")}
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
  const t = useT(restaurantesCierres);
  const comp = cierre.comparativo;
  const notaComp = esDia ? t("restaurantes.cierres.comp.dia") : t("restaurantes.cierres.comp.semana");
  const tiempos = cierre.tiempos;
  return (
    <div className="space-y-2.5" data-testid="cierre-detalle" data-cierre-id={cierre.id}>
      <p className="text-xs text-muted-foreground">
        {t(esDia ? "restaurantes.cierres.detalle.dia" : "restaurantes.cierres.detalle.semana", {
          periodo: etiquetaPeriodo(cierre, t),
          quien: cierre.generadoPor === "sistema" ? t("restaurantes.cierres.generado.sistema") : t("restaurantes.cierres.generado.equipo"),
        })}
      </p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <StatCard icon={DollarSign} label={t("restaurantes.cierres.col.ventas")} value={formatoMxn(cierre.ventasCentavos)} delta={delta(comp?.variacionVentasPct)} deltaNota={notaComp} nota={t("restaurantes.cierres.kpi.ventasNota")} />
        <StatCard icon={ShoppingBag} label={t("restaurantes.cierres.col.pedidos")} value={String(cierre.pedidos)} delta={delta(comp?.variacionPedidosPct)} deltaNota={notaComp} nota={cierre.conProblema > 0 ? t("restaurantes.cierres.kpi.conProblema", { n: String(cierre.conProblema) }) : undefined} />
        <StatCard
          icon={Receipt}
          label={t("restaurantes.cierres.kpi.ticket")}
          value={formatoMxn(cierre.ticketPromedioCentavos)}
          {...(cierre.ticketPromedioCentavos === null ? { sinDato: t("restaurantes.cierres.kpi.sinPedidos") } : { nota: t("restaurantes.cierres.kpi.ticketNota") })}
        />
        <StatCard
          icon={CircleSlash}
          label={t("restaurantes.cierres.kpi.cancelaciones")}
          value={String(cierre.cancelados)}
          {...(cierre.cancelacionPct === null
            ? { nota: t("restaurantes.cierres.kpi.sinCancelaciones") }
            : { nota: t("restaurantes.cierres.kpi.cancelacionesNota", { pct: formatoPct(cierre.cancelacionPct), monto: formatoMxn(cierre.canceladosCentavos), n: String(cierre.noRecogidos) }) })}
        />
        <StatCard
          icon={Clock}
          label={t("restaurantes.cierres.kpi.tiempo")}
          value={formatoMin(tiempos.promedioMin)}
          {...(tiempos.entregados === 0
            ? { sinDato: t("restaurantes.cierres.kpi.sinEntregas") }
            : { nota: t("restaurantes.cierres.kpi.tiempoNota", { mediana: formatoMin(tiempos.medianaMin), p90: formatoMin(tiempos.p90Min), n: String(tiempos.entregados) }) })}
        />
      </div>

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>{t("restaurantes.cierres.porCanal")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<CierreFila["porCanal"][number]>
            etiqueta={t("restaurantes.cierres.porCanal.aria")}
            filas={cierre.porCanal.filter((c) => c.canal !== "web" || c.pedidos > 0 || c.cancelados > 0 || c.ventasCentavos > 0)}
            obtenerId={(c) => c.canal}
            vacio={{ titulo: t("restaurantes.cierres.porCanal.vacio"), mensaje: t("restaurantes.cierres.kpi.sinPedidos") }}
            paginacion={false}
            columnas={[
              { id: "canal", encabezado: t("restaurantes.cierres.col.canal"), principal: true, celda: (c) => etiquetaCanal(c.canal, t) },
              { id: "pedidos", encabezado: t("restaurantes.cierres.col.pedidos"), alinear: "right", className: "tabular-nums", celda: (c) => c.pedidos },
              { id: "ventas", encabezado: t("restaurantes.cierres.col.ventas"), alinear: "right", className: "tabular-nums", celda: (c) => formatoMxn(c.ventasCentavos) },
              { id: "cancelados", encabezado: t("restaurantes.cierres.col.cancelados"), alinear: "right", className: "tabular-nums", celda: (c) => c.cancelados },
            ]}
          />
        </CardContent>
      </Card>

      {cierre.porDia ? (
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle>{t("restaurantes.cierres.porDia")}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable<NonNullable<CierreFila["porDia"]>[number]>
              etiqueta={t("restaurantes.cierres.porDia.aria")}
              filas={[...cierre.porDia]}
              obtenerId={(d) => d.fecha}
              atributosFila={(d) => ({ "data-dia": d.fecha })}
              vacio={{ titulo: t("restaurantes.cierres.porDia.vacio"), mensaje: t("restaurantes.cierres.sinDatos") }}
              paginacion={false}
              columnas={[
                { id: "dia", encabezado: t("restaurantes.cierres.col.dia"), principal: true, celda: (d) => formatoDia(d.fecha) },
                { id: "pedidos", encabezado: t("restaurantes.cierres.col.pedidos"), alinear: "right", className: "tabular-nums", celda: (d) => d.pedidos },
                { id: "ventas", encabezado: t("restaurantes.cierres.col.ventas"), alinear: "right", className: "tabular-nums", celda: (d) => formatoMxn(d.ventasCentavos) },
              ]}
            />
          </CardContent>
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground" data-testid="notas-definiciones">
        {t("restaurantes.cierres.definiciones")} {comp ? t("restaurantes.cierres.comparativo", { periodo: etiquetaPeriodo(comp, t), count: comp.pedidos, n: String(comp.pedidos), ventas: formatoMxn(comp.ventasCentavos) }) : ""}
      </p>
    </div>
  );
}
