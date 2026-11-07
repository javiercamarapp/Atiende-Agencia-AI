// CFO-07 · drill-down a la lista de pedidos que respalda una cifra (`GET .../admin/cfo/pedidos`). Lista paginada por cursor, SIN PII
// (el cliente aparece como alias de 8 caracteres) y con enlace a cada pedido en Historial (historial de transiciones + pantalla de Historial).
// Se abre con `?pedidos=1&…` (el estado vive en la URL, así que el enlace de una tarjeta de «Lo más importante» llega directo aquí).
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { History } from "lucide-react";
import type { FiltroPedidosDetalle, FilaPedidoDetalle } from "@atiende/domain-restaurantes/cfo";
import { Button, DataTable, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, EstadoError, StatusBadge, statusTone, useT } from "@atiende/ui";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import { restaurantesCfo } from "@atiende/ui/i18n/restaurantes/cfo";
import { HistorialPedidoDialogo } from "../components/HistorialPedidoDialogo.tsx";
import { ORDER_STATUS_LABELS } from "../lib/orders-client.ts";
import type { OrderStatus } from "../lib/orders-client.ts";
import { ORDER_STATUS_TONES } from "../lib/status-tones.ts";
import { fetchPedidos, type ContextoCfo } from "./cfo-client.ts";
import { describirFiltro } from "./contexto.ts";
import { etiquetaCanal, etiquetaFormaPago, etiquetaSource, entero, minutos, pesosExactos, SIN_DATO } from "./formato.ts";
import { etiquetaRango, type FiltrosCfo } from "./filtros-url.ts";
import { mensajeSinAccesoCfo, CfoNoDisponibleError, CfoSinAccesoError } from "./cfo-client.ts";


export interface PedidosDrillProps {
  readonly abierto: boolean;
  readonly onCerrar: () => void;
  readonly api: ContextoCfo;
  readonly base: string;
  readonly filtros: FiltrosCfo;
  readonly filtroPedidos: FiltroPedidosDetalle;
}

interface Estado {
  readonly filas: readonly FilaPedidoDetalle[];
  readonly cursor: string | null;
  readonly cargando: boolean;
  readonly error: string | null;
  readonly avisos: readonly string[];
}

const VACIO: Estado = { filas: [], cursor: null, cargando: false, error: null, avisos: [] };

export function PedidosDrill({ abierto, onCerrar, api, base, filtros, filtroPedidos }: PedidosDrillProps) {
  const t = useT(restaurantesComun, restaurantesCfo);
  const [estado, setEstado] = useState<Estado>(VACIO);
  const [historial, setHistorial] = useState<FilaPedidoDetalle | null>(null);
  // Contador de petición: una respuesta de una petición anterior (otro filtro, o «Cargar más» de una lista que ya cambió) se descarta.
  const peticion = useRef(0);
  const claveFiltro = JSON.stringify(filtroPedidos);
  const claveFiltros = `${filtros.desde}|${filtros.hasta}|${filtros.sucursales?.join(",") ?? ""}|${filtros.comparar}`;

  const cargar = useCallback(
    async (cursor: string | null, reiniciar: boolean) => {
      const mia = ++peticion.current;
      setEstado((e) => ({ ...(reiniciar ? VACIO : e), cargando: true, error: null }));
      try {
        const v = await fetchPedidos(api, filtros, { filtro: filtroPedidos, cursor });
        if (mia !== peticion.current) return;
        setEstado((e) => ({ filas: reiniciar ? v.pedidos : [...e.filas, ...v.pedidos], cursor: v.cursor, cargando: false, error: null, avisos: v.avisos }));
      } catch (err) {
        const mensaje = err instanceof CfoSinAccesoError ? mensajeSinAccesoCfo() : err instanceof CfoNoDisponibleError ? t("restaurantes.cfo.pedidos.noDisponible") : err instanceof Error ? err.message : t("restaurantes.cfo.pedidos.error");
        if (mia !== peticion.current) return;
        setEstado((e) => ({ ...e, cargando: false, error: mensaje }));
      }
    },
    // `filtros` y `filtroPedidos` se resumen en sus claves: el objeto cambia de identidad en cada render de la página.
    [api.apiBaseUrl, api.propertyId, api.token, api.fetchImpl, claveFiltros, claveFiltro],
  );

  useEffect(() => {
    if (abierto) void cargar(null, true);
  }, [abierto, cargar]);

  const chips = describirFiltro(filtroPedidos);
  return (
    <>
      <Dialog open={abierto} onOpenChange={(o) => !o && onCerrar()}>
        <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto" data-testid="pedidos-drill">
          <DialogHeader>
            <DialogTitle>{t("restaurantes.cfo.pedidos.titulo")}</DialogTitle>
            <DialogDescription>
              {etiquetaRango(filtros.desde, filtros.hasta)}
              {chips.length > 0 ? ` · ${chips.join(" · ")}` : t("restaurantes.cfo.pedidos.todos")}
              {t("restaurantes.cfo.pedidos.sinPii")}
            </DialogDescription>
          </DialogHeader>
          {estado.error ? (
            <EstadoError mensaje={estado.error} onReintentar={() => void cargar(null, true)} />
          ) : (
            <>
              {estado.avisos.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                  {estado.avisos.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              )}
              <DataTable<FilaPedidoDetalle>
                etiqueta={t("restaurantes.cfo.pedidos.tabla")}
                filas={[...estado.filas]}
                obtenerId={(p) => p.orderId}
                estado={estado.cargando && estado.filas.length === 0 ? "loading" : undefined}
                vacio={{ titulo: t("restaurantes.cfo.pedidos.vacioTitulo"), mensaje: t("restaurantes.cfo.pedidos.vacio") }}
                paginacion={false}
                atributosFila={(p) => ({ "data-pedido": p.orderId })}
                columnas={[
                  { id: "numero", encabezado: t("restaurantes.cfo.pedidos.col.pedido"), principal: true, celda: (p) => `#${p.orderNumber}` },
                  { id: "dia", encabezado: t("restaurantes.cfo.pedidos.col.dia"), celda: (p) => `${p.diaNegocio} · ${p.horaLocal} h` },
                  { id: "canal", encabezado: t("restaurantes.cfo.pedidos.col.canal"), celda: (p) => `${etiquetaCanal(p.canal)} · ${etiquetaSource(p.source)}` },
                  { id: "estado", encabezado: t("restaurantes.cfo.pedidos.col.estado"), celda: (p) => <StatusBadge tone={statusTone(ORDER_STATUS_TONES, p.status)}>{ORDER_STATUS_LABELS[p.status as OrderStatus] ?? p.status}</StatusBadge> },
                  { id: "pago", encabezado: t("restaurantes.cfo.pedidos.col.pago"), celda: (p) => (p.paymentMethod ? etiquetaFormaPago(p.paymentMethod) : SIN_DATO) },
                  { id: "bruta", encabezado: t("restaurantes.cfo.pedidos.col.bruta"), alinear: "right", className: "tabular-nums", celda: (p) => pesosExactos(p.brutaCentavos) },
                  { id: "desc", encabezado: t("restaurantes.cfo.pedidos.col.desc"), alinear: "right", className: "tabular-nums", celda: (p) => pesosExactos(p.descCentavos) },
                  { id: "neta", encabezado: t("restaurantes.cfo.pedidos.col.neta"), alinear: "right", className: "tabular-nums", celda: (p) => pesosExactos(p.netaCentavos) },
                  { id: "entrega", encabezado: t("restaurantes.cfo.pedidos.col.entrega"), alinear: "right", className: "tabular-nums", celda: (p) => minutos(p.entregadoMin) },
                  { id: "cliente", encabezado: t("restaurantes.cfo.pedidos.col.cliente"), celda: (p) => p.clienteAlias ?? SIN_DATO },
                  {
                    id: "ver",
                    encabezado: "",
                    alinear: "right",
                    ocultarEnTarjeta: false,
                    celda: (p) => (
                      <Button type="button" size="sm" variant="ghost" className="gap-1" onClick={() => setHistorial(p)} aria-label={t("restaurantes.cfo.pedidos.verHistorial", { n: String(p.orderNumber) })}>
                        <History className="size-3.5" aria-hidden="true" />
                        {t("restaurantes.historial")}
                      </Button>
                    ),
                  },
                ]}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground" data-testid="pedidos-conteo">
                  {t("restaurantes.cfo.pedidos.cargados", { n: entero(estado.filas.length) })}
                  {estado.cursor ? t("restaurantes.cfo.pedidos.hayMas") : ""}
                </p>
                <div className="flex items-center gap-2">
                  <Button asChild variant="ghost" size="sm">
                    <Link to={`${base}/historial`}>{t("restaurantes.cfo.pedidos.abrirHistorial")}</Link>
                  </Button>
                  {estado.cursor && (
                    <Button type="button" variant="outline" size="sm" loading={estado.cargando} disabled={estado.cargando} onClick={() => void cargar(estado.cursor, false)}>
                      {t("restaurantes.cfo.pedidos.cargarMas")}
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <HistorialPedidoDialogo
        orderId={historial?.orderId ?? null}
        titulo={historial ? t("restaurantes.cfo.pedidos.historialTitulo", { n: String(historial.orderNumber) }) : ""}

        onClose={() => setHistorial(null)}
        apiBaseUrl={api.apiBaseUrl}
        token={api.token}
        propertyId={historial?.propertyId ?? api.propertyId}
      />
    </>
  );
}
