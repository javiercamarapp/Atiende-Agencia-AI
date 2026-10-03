// Grupos (H-06) -- cotizacion de grupo con vigencia, bloqueo de cuartos (allotment) con fecha de liberacion, pickup
// (confirmados vs bloqueados), rooming list y anticipos REGISTRADOS (esta pantalla NO cobra nada). Consume
// apps/api/.../hoteles/grupos.ts. Los botones se muestran segun el rol (cosmetico: el servidor es la unica barrera real,
// 403). Aceptar una cotizacion BLOQUEA cuartos sin sobreventa: si una noche no alcanza, el servidor responde 409 y no
// retiene nada. Contra una base sin la migracion 036 la pantalla avisa y no rompe (sin 500).
import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  Callout,
  DataTable,
  EstadoCargando,
  EstadoError,
  PageContainer,
  PageHeader,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  notify,
  useConfirm,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import {
  ESTADO_BLOQUEO_LABELS,
  ESTADO_COTIZACION_LABELS,
  GRUPOS_MANAGE_ROLES,
  GRUPOS_ROOMING_ROLES,
  aceptarCotizacion,
  accionesCotizacion,
  agregarHuesped,
  cancelarBloqueo,
  cancelarHuesped,
  cerrarCotizacion,
  confirmarHuesped,
  crearCotizacion,
  describirLiberacion,
  enviarCotizacion,
  fetchBloqueo,
  fetchBloqueos,
  fetchCotizaciones,
  formatearCentavos,
  liberarBloqueo,
  pesosACentavos,
  registrarAnticipo,
} from "../lib/grupos-client.ts";
import type { Bloqueo, BloqueoDetalle, BloqueosResultado, Cotizacion, CotizacionesResultado, EstadoBloqueo, EstadoCotizacion } from "../lib/grupos-client.ts";
import { fetchRoomTypes } from "../lib/reservas-client.ts";
import type { RoomTypeOption } from "../lib/reservas-client.ts";
import { NuevaCotizacionDialog } from "../components/grupos/NuevaCotizacionDialog.tsx";
import type { NuevaCotizacionInput } from "../components/grupos/NuevaCotizacionDialog.tsx";
import { RoomingCard } from "../components/grupos/RoomingCard.tsx";
import type { NuevoHuesped } from "../components/grupos/RoomingCard.tsx";
import { fechaCortaEsMx, hoyFechaSolo } from "../../../lib/formato-fecha.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

type Tono = "warning" | "success" | "danger" | "neutral" | "info";
const tonoCotizacion = (e: EstadoCotizacion): Tono => (e === "aceptada" ? "success" : e === "enviada" ? "info" : e === "borrador" ? "neutral" : e === "rechazada" ? "danger" : "warning");
const tonoBloqueo = (e: EstadoBloqueo): Tono => (e === "activo" ? "success" : e === "liberado" ? "neutral" : "warning");

const MIN_MOTIVO = 5;
const validarMotivo = (v: string) => (v.trim().length < MIN_MOTIVO ? `Escribe al menos ${MIN_MOTIVO} caracteres.` : null);
const hoyLocal = () => hoyFechaSolo();

export function GruposPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const [cotizaciones, setCotizaciones] = useState<CotizacionesResultado | null>(null);
  const [bloqueos, setBloqueos] = useState<BloqueosResultado | null>(null);
  const [detalle, setDetalle] = useState<BloqueoDetalle | null>(null);
  const [tipos, setTipos] = useState<readonly RoomTypeOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"cotizaciones" | "bloqueos">("cotizaciones");
  const [creando, setCreando] = useState(false);
  const { pedirTexto, confirmar, dialogo } = useConfirm();

  const puedeGestionar = GRUPOS_MANAGE_ROLES.has(role);
  const puedeRooming = GRUPOS_ROOMING_ROLES.has(role);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCotizaciones(await fetchCotizaciones(fetch, apiBaseUrl, token, propertyId));
      setBloqueos(await fetchBloqueos(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los grupos.");
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!puedeGestionar) return;
    void fetchRoomTypes(fetch, apiBaseUrl, token, propertyId).then(setTipos).catch(() => setTipos([]));
  }, [apiBaseUrl, token, propertyId, puedeGestionar]);

  async function run(key: string, fn: () => Promise<unknown>, okMessage: string, recargarDetalle?: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      notify.success(okMessage);
      await load();
      if (recargarDetalle) setDetalle(await fetchBloqueo(fetch, apiBaseUrl, token, propertyId, recargarDetalle));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la accion.");
    } finally {
      setBusy(null);
    }
  }

  async function accionCotizacion(c: Cotizacion, accion: "enviar" | "aceptar" | "rechazar" | "cancelar" | "anticipo") {
    if (accion === "enviar") return run(c.id, () => enviarCotizacion(fetch, apiBaseUrl, token, propertyId, c.id), "Cotización enviada: corre su vigencia.");
    if (accion === "aceptar") {
      const ok = await confirmar({
        titulo: "Aceptar y bloquear cuartos",
        descripcion: `Se retienen los cuartos de ${c.nombreGrupo} del ${c.llegada} al ${c.salida} hasta el ${c.fechaLiberacion} (después se liberan los que no se confirmen). Si una noche no tiene cupo suficiente no se bloquea nada. No hay sobreventa.`,
        confirmar: "Bloquear cuartos",
        cancelar: "Volver",
      });
      if (!ok) return;
      return run(c.id, async () => {
        const b = await aceptarCotizacion(fetch, apiBaseUrl, token, propertyId, c.id);
        setDetalle(b);
        setTab("bloqueos");
      }, "Cuartos bloqueados.");
    }
    if (accion === "anticipo") {
      const monto = await pedirTexto({
        titulo: "Registrar anticipo",
        descripcion: "Solo se REGISTRA el anticipo recibido (no se cobra nada desde aquí). Importe en pesos, hasta el saldo de la cotización.",
        confirmar: "Continuar",
        cancelar: "Volver",
        campo: { etiqueta: "Importe (MXN)", maxLength: 20, validar: (v) => (pesosACentavos(v) === null || pesosACentavos(v) === 0 ? "Escribe un importe en pesos con hasta 2 decimales (ej. 5000 o 5000.50)." : null) },
      });
      if (monto === null) return;
      const referencia = await pedirTexto({
        titulo: "Referencia del anticipo",
        descripcion: "Folio, transferencia o recibo que respalda el anticipo. No se puede repetir en la misma cotización.",
        confirmar: "Registrar",
        cancelar: "Volver",
        campo: { etiqueta: "Referencia", minLength: 3, maxLength: 120, validar: (v) => (v.trim().length < 3 ? "Escribe al menos 3 caracteres." : null) },
      });
      if (referencia === null) return;
      return run(c.id, () => registrarAnticipo(fetch, apiBaseUrl, token, propertyId, c.id, pesosACentavos(monto)!, referencia.trim()), "Anticipo registrado.");
    }
    const motivo = await pedirTexto({
      titulo: accion === "rechazar" ? "Rechazar la cotización" : "Cancelar la cotización",
      descripcion: `${c.nombreGrupo}. El motivo queda en la bitácora.`,
      tono: "danger",
      confirmar: accion === "rechazar" ? "Rechazar" : "Cancelar cotización",
      cancelar: "Volver",
      campo: { etiqueta: "Motivo", multilinea: true, minLength: MIN_MOTIVO, maxLength: 300, validar: validarMotivo },
    });
    if (motivo === null) return;
    return run(c.id, () => cerrarCotizacion(fetch, apiBaseUrl, token, propertyId, c.id, accion === "rechazar" ? "rechazada" : "cancelada", motivo), accion === "rechazar" ? "Cotización rechazada." : "Cotización cancelada.");
  }

  async function verBloqueo(b: Bloqueo) {
    setError(null);
    try {
      setDetalle(await fetchBloqueo(fetch, apiBaseUrl, token, propertyId, b.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el bloqueo.");
    }
  }

  async function liberar(b: BloqueoDetalle) {
    const ok = await confirmar({
      titulo: "Liberar los cuartos no confirmados",
      descripcion: `Se devuelven al inventario ${b.pickup.cuartosNochePendientes} cuartos-noche sin confirmar; los ${b.pickup.cuartosNocheConfirmados} confirmados se quedan. El bloqueo queda liberado y ya no admite más huéspedes.`,
      tono: "danger",
      confirmar: "Liberar",
      cancelar: "Volver",
    });
    if (!ok) return;
    await run(b.id, () => liberarBloqueo(fetch, apiBaseUrl, token, propertyId, b.id), "Cuartos no confirmados liberados.", b.id);
  }

  async function cancelarElBloqueo(b: BloqueoDetalle) {
    const motivo = await pedirTexto({
      titulo: "Cancelar el bloqueo",
      descripcion: "Libera todos los cuartos. Solo se puede si no hay huéspedes confirmados.",
      tono: "danger",
      confirmar: "Cancelar bloqueo",
      cancelar: "Volver",
      campo: { etiqueta: "Motivo", multilinea: true, minLength: MIN_MOTIVO, maxLength: 300, validar: validarMotivo },
    });
    if (motivo === null) return;
    await run(b.id, () => cancelarBloqueo(fetch, apiBaseUrl, token, propertyId, b.id, motivo), "Bloqueo cancelado.", b.id);
  }

  async function agregarAlGrupo(input: NuevoHuesped) {
    if (!detalle) return;
    await agregarHuesped(fetch, apiBaseUrl, token, propertyId, detalle.id, input);
    notify.success("Huésped agregado a la rooming list.");
    await load();
    setDetalle(await fetchBloqueo(fetch, apiBaseUrl, token, propertyId, detalle.id));
  }

  async function crearNuevaCotizacion(input: NuevaCotizacionInput) {
    await crearCotizacion(fetch, apiBaseUrl, token, propertyId, input);
    notify.success("Cotización creada en borrador: envíala para que corra su vigencia.");
    await load();
    setCreando(false);
    setTab("cotizaciones");
  }

  const nombreTipo = (id: string) => tipos.find((t) => t.id === id)?.nombre ?? "Tipo de habitación";

  const columnasCotizacion: DataTableColumna<Cotizacion>[] = [
    {
      id: "grupo",
      encabezado: "Grupo",
      principal: true,
      valorOrden: (c) => c.nombreGrupo,
      celda: (c) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{c.nombreGrupo}</span>
          <span className="text-xs text-muted-foreground">{c.llegada} → {c.salida} · {c.noches} noches</span>
        </div>
      ),
    },
    {
      id: "total",
      encabezado: "Total",
      valorOrden: (c) => c.totalCentavos,
      celda: (c) => (
        <div className="flex flex-col gap-0.5">
          <span>{formatearCentavos(c.totalCentavos)}</span>
          {c.descuentoBps > 0 && <span className="text-xs text-muted-foreground">Incluye {c.descuentoBps / 100} % de descuento</span>}
        </div>
      ),
    },
    {
      id: "anticipo",
      encabezado: "Anticipo registrado",
      celda: (c) => `${formatearCentavos(c.anticipoRegistradoCentavos)} de ${formatearCentavos(c.anticipoRequeridoCentavos)}`,
    },
    {
      id: "vigencia",
      encabezado: "Vigencia / liberación",
      valorOrden: (c) => c.vigenteHasta,
      celda: (c) => (
        <div className="flex flex-col gap-0.5 text-xs">
          <span>Vigente hasta {fechaCortaEsMx(new Date(c.vigenteHasta))}</span>
          <span className="text-muted-foreground">Libera el {c.fechaLiberacion}</span>
        </div>
      ),
    },
    { id: "estado", encabezado: "Estado", valorOrden: (c) => c.estado, celda: (c) => <StatusBadge tone={tonoCotizacion(c.estado)}>{ESTADO_COTIZACION_LABELS[c.estado]}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (c) => (
        <div className="flex flex-wrap gap-2">
          {accionesCotizacion(c, role).map((acc) => (
            <Button key={acc} type="button" size="sm" variant={acc === "aceptar" || acc === "enviar" ? "default" : "outline"} disabled={busy === c.id} onClick={() => void accionCotizacion(c, acc)}>
              {{ enviar: "Enviar", aceptar: "Aceptar y bloquear", rechazar: "Rechazar", cancelar: "Cancelar", anticipo: "Registrar anticipo" }[acc]}
            </Button>
          ))}
        </div>
      ),
    },
  ];

  const columnasBloqueo: DataTableColumna<Bloqueo>[] = [
    {
      id: "grupo",
      encabezado: "Grupo",
      principal: true,
      valorOrden: (b) => b.nombreGrupo,
      celda: (b) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{b.nombreGrupo}</span>
          <span className="text-xs text-muted-foreground">{b.llegada} → {b.salida}</span>
        </div>
      ),
    },
    {
      id: "pickup",
      encabezado: "Pickup",
      valorOrden: (b) => b.pickup.porcentaje,
      celda: (b) => (
        <div className="flex flex-col gap-0.5">
          <span>{b.pickup.cuartosNocheConfirmados} de {b.pickup.cuartosNocheBloqueados} cuartos-noche ({b.pickup.porcentaje} %)</span>
          <span className="text-xs text-muted-foreground">{b.pickup.cuartosNocheRetenidos} retenidos · {b.pickup.cuartosNochePendientes} sin confirmar</span>
        </div>
      ),
    },
    { id: "liberacion", encabezado: "Liberación", valorOrden: (b) => b.fechaLiberacion, celda: (b) => <span className="text-xs">{describirLiberacion(b, hoyLocal())}</span> },
    { id: "estado", encabezado: "Estado", valorOrden: (b) => b.estado, celda: (b) => <StatusBadge tone={tonoBloqueo(b.estado)}>{ESTADO_BLOQUEO_LABELS[b.estado]}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (b) => (
        <Button type="button" size="sm" variant="outline" onClick={() => void verBloqueo(b)}>
          Ver rooming list
        </Button>
      ),
    },
  ];

  const cargando = !cotizaciones && !error;
  const noDisponible = cotizaciones && !cotizaciones.disponible;

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader
        titulo="Grupos"
        descripcion="Cotización de grupo, bloqueo de cuartos con fecha de liberación, pickup y rooming list."
        meta={bloqueos?.disponible ? <span>{bloqueos.bloqueos.filter((b) => b.estado === "activo").length} bloqueos activos</span> : undefined}
        acciones={
          puedeGestionar && cotizaciones?.disponible ? (
            <Button type="button" iconLeft={<Plus className="size-4" strokeWidth={1.75} />} onClick={() => setCreando(true)}>
              Nueva cotización
            </Button>
          ) : undefined
        }
      />

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {cargando && <EstadoCargando etiqueta="Cargando grupos…" />}

      {noDisponible && (
        <Callout tone="info">
          Los grupos (cotización, bloqueo de cuartos y rooming list) aún no están activos en esta base de datos: se activan cuando se aplique la actualización pendiente. Mientras tanto no se bloquea ningún cuarto.
        </Callout>
      )}

      {cotizaciones?.disponible && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="cotizaciones">Cotizaciones</TabsTrigger>
            <TabsTrigger value="bloqueos">Bloqueos y pickup</TabsTrigger>
          </TabsList>

          <TabsContent value="cotizaciones" className="mt-4">
            <DataTable
              etiqueta="Cotizaciones de grupo"
              columnas={columnasCotizacion}
              filas={cotizaciones.cotizaciones}
              obtenerId={(c) => c.id}
              vacio={{ mensaje: "Todavía no hay cotizaciones de grupo." }}
            />
          </TabsContent>

          <TabsContent value="bloqueos" className="mt-4 flex flex-col gap-4">
            <DataTable
              etiqueta="Bloqueos de cuartos"
              columnas={columnasBloqueo}
              filas={bloqueos?.bloqueos ?? []}
              obtenerId={(b) => b.id}
              estado={bloqueos ? undefined : "loading"}
              vacio={{ mensaje: "No hay bloqueos. Al aceptar una cotización enviada se bloquean los cuartos del grupo." }}
            />
            {detalle && (
              <RoomingCard
                detalle={detalle}
                hoy={hoyLocal()}
                puedeGestionar={puedeGestionar}
                puedeRooming={puedeRooming}
                busy={busy}
                nombreTipo={nombreTipo}
                onLiberar={() => void liberar(detalle)}
                onCancelarBloqueo={() => void cancelarElBloqueo(detalle)}
                onCerrar={() => setDetalle(null)}
                onConfirmarHuesped={(id) => void run(id, () => confirmarHuesped(fetch, apiBaseUrl, token, propertyId, id), "Pickup confirmado.", detalle.id)}
                onCancelarHuesped={(id) => void run(id, () => cancelarHuesped(fetch, apiBaseUrl, token, propertyId, id), "Huésped cancelado.", detalle.id)}
                onAgregarHuesped={agregarAlGrupo}
              />
            )}
          </TabsContent>
        </Tabs>
      )}

      <NuevaCotizacionDialog open={creando} onClose={() => setCreando(false)} tipos={tipos} crear={crearNuevaCotizacion} />
      {dialogo}
    </PageContainer>
  );
}
