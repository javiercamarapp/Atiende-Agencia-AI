// CFO-07 · drill-down a la lista de pedidos que respalda una cifra (`GET .../admin/cfo/pedidos`). Lista paginada por cursor, SIN PII
// (el cliente aparece como alias de 8 caracteres) y con enlace a cada pedido en Historial (historial de transiciones + pantalla de Historial).
// Se abre con `?pedidos=1&…` (el estado vive en la URL, así que el enlace de una tarjeta de «Lo más importante» llega directo aquí).
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { History } from "lucide-react";
import type { FiltroPedidosDetalle, FilaPedidoDetalle } from "@atiende/domain-restaurantes/cfo";
import { Button, DataTable, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, EstadoError, StatusBadge, statusTone } from "@atiende/ui";
import { HistorialPedidoDialogo } from "../components/HistorialPedidoDialogo.tsx";
import { ORDER_STATUS_LABELS } from "../lib/orders-client.ts";
import type { OrderStatus } from "../lib/orders-client.ts";
import { ORDER_STATUS_TONES } from "../lib/status-tones.ts";
import { fetchPedidos, type ContextoCfo } from "./cfo-client.ts";
import { describirFiltro } from "./contexto.ts";
import { etiquetaCanal, etiquetaFormaPago, etiquetaSource, entero, minutos, pesosExactos, SIN_DATO } from "./formato.ts";
import { etiquetaRango, type FiltrosCfo } from "./filtros-url.ts";
import { MENSAJE_SIN_ACCESO_CFO, CfoSinAccesoError } from "./cfo-client.ts";
import { VozNoDisponibleError } from "../lib/voz-client.ts";

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
  const [estado, setEstado] = useState<Estado>(VACIO);
  const [historial, setHistorial] = useState<FilaPedidoDetalle | null>(null);
  const claveFiltro = JSON.stringify(filtroPedidos);
  const claveFiltros = `${filtros.desde}|${filtros.hasta}|${filtros.sucursales?.join(",") ?? ""}|${filtros.comparar}`;

  const cargar = useCallback(
    async (cursor: string | null, reiniciar: boolean) => {
      setEstado((e) => ({ ...(reiniciar ? VACIO : e), cargando: true, error: null }));
      try {
        const v = await fetchPedidos(api, filtros, { filtro: filtroPedidos, cursor });
        setEstado((e) => ({ filas: reiniciar ? v.pedidos : [...e.filas, ...v.pedidos], cursor: v.cursor, cargando: false, error: null, avisos: v.avisos }));
      } catch (err) {
        const mensaje = err instanceof CfoSinAccesoError ? MENSAJE_SIN_ACCESO_CFO : err instanceof VozNoDisponibleError ? "La lista de pedidos del CFO aún no está disponible en este negocio." : err instanceof Error ? err.message : "No se pudieron cargar los pedidos.";
        setEstado((e) => ({ ...e, cargando: false, error: mensaje }));
      }
    },
    // `filtros` y `filtroPedidos` se resumen en sus claves: el objeto cambia de identidad en cada render de la página.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            <DialogTitle>Pedidos que respaldan esta cifra</DialogTitle>
            <DialogDescription>
              {etiquetaRango(filtros.desde, filtros.hasta)}
              {chips.length > 0 ? ` · ${chips.join(" · ")}` : " · todos los pedidos del periodo"}. Sin nombres, teléfonos ni direcciones: el cliente aparece como un código corto.
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
                etiqueta="Pedidos del periodo"
                filas={[...estado.filas]}
                obtenerId={(p) => p.orderId}
                estado={estado.cargando && estado.filas.length === 0 ? "loading" : undefined}
                vacio={{ titulo: "Sin pedidos", mensaje: "No hay pedidos con ese filtro en el periodo." }}
                paginacion={false}
                atributosFila={(p) => ({ "data-pedido": p.orderId })}
                columnas={[
                  { id: "numero", encabezado: "Pedido", principal: true, celda: (p) => `#${p.orderNumber}` },
                  { id: "dia", encabezado: "Día", celda: (p) => `${p.diaNegocio} · ${p.horaLocal} h` },
                  { id: "canal", encabezado: "Canal", celda: (p) => `${etiquetaCanal(p.canal)} · ${etiquetaSource(p.source)}` },
                  { id: "estado", encabezado: "Estado", celda: (p) => <StatusBadge tone={statusTone(ORDER_STATUS_TONES, p.status)}>{ORDER_STATUS_LABELS[p.status as OrderStatus] ?? p.status}</StatusBadge> },
                  { id: "pago", encabezado: "Pago", celda: (p) => (p.paymentMethod ? etiquetaFormaPago(p.paymentMethod) : SIN_DATO) },
                  { id: "bruta", encabezado: "Bruta", alinear: "right", className: "tabular-nums", celda: (p) => pesosExactos(p.brutaCentavos) },
                  { id: "desc", encabezado: "Desc.", alinear: "right", className: "tabular-nums", celda: (p) => pesosExactos(p.descCentavos) },
                  { id: "neta", encabezado: "Neta", alinear: "right", className: "tabular-nums", celda: (p) => pesosExactos(p.netaCentavos) },
                  { id: "entrega", encabezado: "Entrega", alinear: "right", className: "tabular-nums", celda: (p) => minutos(p.entregadoMin) },
                  { id: "cliente", encabezado: "Cliente", celda: (p) => p.clienteAlias ?? SIN_DATO },
                  {
                    id: "ver",
                    encabezado: "",
                    alinear: "right",
                    ocultarEnTarjeta: false,
                    celda: (p) => (
                      <Button type="button" size="sm" variant="ghost" className="gap-1" onClick={() => setHistorial(p)} aria-label={`Ver el historial del pedido ${p.orderNumber}`}>
                        <History className="size-3.5" aria-hidden="true" />
                        Historial
                      </Button>
                    ),
                  },
                ]}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground" data-testid="pedidos-conteo">
                  {entero(estado.filas.length)} pedidos cargados{estado.cursor ? " · hay más" : ""}
                </p>
                <div className="flex items-center gap-2">
                  <Button asChild variant="ghost" size="sm">
                    <Link to={`${base}/historial`}>Abrir Historial</Link>
                  </Button>
                  {estado.cursor && (
                    <Button type="button" variant="outline" size="sm" loading={estado.cargando} disabled={estado.cargando} onClick={() => void cargar(estado.cursor, false)}>
                      Cargar más
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
        titulo={historial ? `Historial del pedido #${historial.orderNumber}` : ""}
        onClose={() => setHistorial(null)}
        apiBaseUrl={api.apiBaseUrl}
        token={api.token}
        propertyId={historial?.propertyId ?? api.propertyId}
      />
    </>
  );
}
