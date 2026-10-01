// Grupos (H-06) -- cotizacion de grupo con vigencia, bloqueo de cuartos (allotment) con fecha de liberacion, pickup
// (confirmados vs bloqueados), rooming list y anticipos REGISTRADOS (esta pantalla NO cobra nada). Consume
// apps/api/.../hoteles/grupos.ts. Los botones se muestran segun el rol (cosmetico: el servidor es la unica barrera real,
// 403). Aceptar una cotizacion BLOQUEA cuartos sin sobreventa: si una noche no alcanza, el servidor responde 409 y no
// retiene nada. Contra una base sin la migracion 036 la pantalla avisa y no rompe (sin 500).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { UsersRound } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  DataTable,
  EstadoCargando,
  EstadoError,
  Input,
  NativeSelect,
  PageContainer,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useConfirm,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import {
  ESTADO_BLOQUEO_LABELS,
  ESTADO_COTIZACION_LABELS,
  ESTADO_HUESPED_LABELS,
  GRUPOS_MANAGE_ROLES,
  GRUPOS_ROOMING_ROLES,
  aceptarCotizacion,
  accionesCotizacion,
  agregarHuesped,
  brutoCentavos,
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
  nochesEntre,
  pesosACentavos,
  porcentajeABps,
  registrarAnticipo,
  totalConDescuento,
} from "../lib/grupos-client.ts";
import type { Bloqueo, BloqueoDetalle, BloqueosResultado, Cotizacion, CotizacionesResultado, EstadoBloqueo, EstadoCotizacion, EstadoHuesped, HuespedGrupo } from "../lib/grupos-client.ts";
import { fetchRoomTypes } from "../lib/reservas-client.ts";
import type { RoomTypeOption } from "../lib/reservas-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

type Tono = "warning" | "success" | "danger" | "neutral" | "info";
const tonoCotizacion = (e: EstadoCotizacion): Tono => (e === "aceptada" ? "success" : e === "enviada" ? "info" : e === "borrador" ? "neutral" : e === "rechazada" ? "danger" : "warning");
const tonoBloqueo = (e: EstadoBloqueo): Tono => (e === "activo" ? "success" : e === "liberado" ? "neutral" : "warning");
const tonoHuesped = (e: EstadoHuesped): Tono => (e === "confirmada" ? "success" : e === "pendiente" ? "warning" : "neutral");

const MIN_MOTIVO = 5;
const validarMotivo = (v: string) => (v.trim().length < MIN_MOTIVO ? `Escribe al menos ${MIN_MOTIVO} caracteres.` : null);
const hoyLocal = () => new Date().toLocaleDateString("en-CA");

interface RenglonForm {
  readonly tipoHabitacionId: string;
  readonly cuartos: string;
  readonly tarifa: string;
}
const FORM_VACIO = { nombreGrupo: "", contacto: "", correoContacto: "", llegada: "", salida: "", fechaLiberacion: "", vigencia: "", descuento: "0", anticipo: "0" };

export function GruposPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const [cotizaciones, setCotizaciones] = useState<CotizacionesResultado | null>(null);
  const [bloqueos, setBloqueos] = useState<BloqueosResultado | null>(null);
  const [detalle, setDetalle] = useState<BloqueoDetalle | null>(null);
  const [tipos, setTipos] = useState<readonly RoomTypeOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"cotizaciones" | "bloqueos" | "nueva">("cotizaciones");
  const [form, setForm] = useState(FORM_VACIO);
  const [renglones, setRenglones] = useState<RenglonForm[]>([{ tipoHabitacionId: "", cuartos: "", tarifa: "" }]);
  const [huesped, setHuesped] = useState({ tipoHabitacionId: "", nombre: "", llegada: "", salida: "" });
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
    setAviso(null);
    try {
      await fn();
      setAviso(okMessage);
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

  async function handleAgregarHuesped(e: FormEvent) {
    e.preventDefault();
    if (!detalle) return;
    if (!huesped.tipoHabitacionId || huesped.nombre.trim().length < 2 || !huesped.llegada || !huesped.salida) {
      setError("Completa el tipo de habitación, el nombre y las fechas del huésped.");
      return;
    }
    await run("huesped", async () => {
      await agregarHuesped(fetch, apiBaseUrl, token, propertyId, detalle.id, { tipoHabitacionId: huesped.tipoHabitacionId, huesped: huesped.nombre.trim(), llegada: huesped.llegada, salida: huesped.salida });
      setHuesped({ ...huesped, nombre: "" });
    }, "Huésped agregado a la rooming list.", detalle.id);
  }

  const preview = useMemo(() => {
    const noches = nochesEntre(form.llegada, form.salida);
    const filas = renglones.map((r) => ({ cuartos: Number(r.cuartos), tarifa: pesosACentavos(r.tarifa) }));
    const completos = filas.every((r) => Number.isInteger(r.cuartos) && r.cuartos > 0 && r.tarifa !== null);
    const bps = porcentajeABps(form.descuento);
    if (noches < 1 || !completos || bps === null) return null;
    const bruto = brutoCentavos(filas.map((r) => ({ cuartos: r.cuartos, tarifaCentavos: r.tarifa! })), noches);
    return { noches, bruto, total: totalConDescuento(bruto, bps) };
  }, [form.llegada, form.salida, form.descuento, renglones]);

  async function handleCrear(e: FormEvent) {
    e.preventDefault();
    const bps = porcentajeABps(form.descuento);
    const anticipo = pesosACentavos(form.anticipo || "0");
    const filas = renglones.map((r) => ({ tipoHabitacionId: r.tipoHabitacionId, cuartos: Number(r.cuartos), tarifaCentavos: pesosACentavos(r.tarifa) }));
    if (form.nombreGrupo.trim().length < 2 || !form.llegada || !form.salida || !form.fechaLiberacion || !form.vigencia) {
      setError("Completa el nombre del grupo, las fechas, la fecha de liberación y la vigencia.");
      return;
    }
    if (bps === null || anticipo === null) {
      setError("El descuento es un porcentaje de 0 a 100 y el anticipo un importe en pesos, ambos con hasta 2 decimales.");
      return;
    }
    if (filas.some((r) => !r.tipoHabitacionId || !Number.isInteger(r.cuartos) || r.cuartos < 1 || r.tarifaCentavos === null)) {
      setError("Cada renglón necesita tipo de habitación, cuartos enteros y una tarifa en pesos (hasta 2 decimales).");
      return;
    }
    const vigenteHasta = new Date(`${form.vigencia}T23:59:00`).toISOString();
    await run("crear", async () => {
      await crearCotizacion(fetch, apiBaseUrl, token, propertyId, {
        nombreGrupo: form.nombreGrupo.trim(),
        ...(form.contacto.trim() ? { contacto: form.contacto.trim() } : {}),
        ...(form.correoContacto.trim() ? { correoContacto: form.correoContacto.trim() } : {}),
        llegada: form.llegada,
        salida: form.salida,
        fechaLiberacion: form.fechaLiberacion,
        vigenteHasta,
        descuentoBps: bps,
        anticipoRequeridoCentavos: anticipo,
        renglones: filas.map((r) => ({ tipoHabitacionId: r.tipoHabitacionId, cuartos: r.cuartos, tarifaCentavos: r.tarifaCentavos! })),
      });
      setForm(FORM_VACIO);
      setRenglones([{ tipoHabitacionId: "", cuartos: "", tarifa: "" }]);
      setTab("cotizaciones");
    }, "Cotización creada en borrador: envíala para que corra su vigencia.");
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
          <span>Vigente hasta {new Date(c.vigenteHasta).toLocaleDateString("es-MX")}</span>
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

  const columnasHuesped: DataTableColumna<HuespedGrupo>[] = [
    { id: "huesped", encabezado: "Huésped", principal: true, valorOrden: (h) => h.huesped, celda: (h) => <span className="font-medium">{h.huesped}</span> },
    { id: "tipo", encabezado: "Habitación", celda: (h) => nombreTipo(h.tipoHabitacionId) },
    { id: "fechas", encabezado: "Estancia", valorOrden: (h) => h.llegada, celda: (h) => `${h.llegada} → ${h.salida}` },
    { id: "estado", encabezado: "Estado", valorOrden: (h) => h.estado, celda: (h) => <StatusBadge tone={tonoHuesped(h.estado)}>{ESTADO_HUESPED_LABELS[h.estado]}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (h) =>
        puedeRooming && h.estado !== "cancelada" && detalle ? (
          <div className="flex flex-wrap gap-2">
            {h.estado === "pendiente" && detalle.estado === "activo" && (
              <Button type="button" size="sm" disabled={busy === h.id} onClick={() => void run(h.id, () => confirmarHuesped(fetch, apiBaseUrl, token, propertyId, h.id), "Pickup confirmado.", detalle.id)}>
                Confirmar pickup
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" disabled={busy === h.id} onClick={() => void run(h.id, () => cancelarHuesped(fetch, apiBaseUrl, token, propertyId, h.id), "Huésped cancelado.", detalle.id)}>
              Cancelar
            </Button>
          </div>
        ) : null,
    },
  ];

  const cargando = !cotizaciones && !error;
  const noDisponible = cotizaciones && !cotizaciones.disponible;

  return (
    <PageContainer padding="none" className="gap-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-display font-semibold text-foreground flex items-center gap-2">
          <UsersRound className="w-5 h-5" strokeWidth={1.75} />
          Grupos
        </h1>
        {bloqueos?.disponible && <p className="text-sm text-muted-foreground">{bloqueos.bloqueos.filter((b) => b.estado === "activo").length} bloqueos activos</p>}
      </header>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {aviso && <p role="status" className="text-sm text-foreground">{aviso}</p>}
      {cargando && <EstadoCargando etiqueta="Cargando grupos…" />}

      {noDisponible && (
        <Card>
          <CardContent className="p-4 text-sm text-foreground">
            Los grupos (cotización, bloqueo de cuartos y rooming list) aún no están activos en esta base de datos: se activan cuando se aplique la actualización pendiente. Mientras tanto no se bloquea ningún cuarto.
          </CardContent>
        </Card>
      )}

      {cotizaciones?.disponible && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="cotizaciones">Cotizaciones</TabsTrigger>
            <TabsTrigger value="bloqueos">Bloqueos y pickup</TabsTrigger>
            {puedeGestionar && <TabsTrigger value="nueva">Nueva cotización</TabsTrigger>}
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
              <Card>
                <CardContent className="p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h2 className="text-sm font-semibold text-foreground">Rooming list — {detalle.nombreGrupo}</h2>
                    <div className="flex flex-wrap gap-2">
                      <StatusBadge tone="neutral" dot={false}>{describirLiberacion(detalle, hoyLocal())}</StatusBadge>
                      {puedeGestionar && detalle.estado === "activo" && (
                        <>
                          <Button type="button" size="sm" variant="outline" disabled={busy === detalle.id} onClick={() => void liberar(detalle)}>
                            Liberar no confirmados
                          </Button>
                          <Button type="button" size="sm" variant="outline" disabled={busy === detalle.id} onClick={() => void cancelarElBloqueo(detalle)}>
                            Cancelar bloqueo
                          </Button>
                        </>
                      )}
                      <Button type="button" size="sm" variant="ghost" onClick={() => setDetalle(null)}>
                        Cerrar
                      </Button>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Pickup: {detalle.pickup.cuartosNocheConfirmados} de {detalle.pickup.cuartosNocheBloqueados} cuartos-noche confirmados ({detalle.pickup.porcentaje} %) ·{" "}
                    {detalle.pickup.cuartosNochePendientes} sin confirmar · {detalle.pickup.cuartosNocheLiberados} liberados.
                  </p>
                  <DataTable etiqueta="Huéspedes del grupo" columnas={columnasHuesped} filas={detalle.rooming} obtenerId={(h) => h.id} vacio={{ mensaje: "Aún no hay huéspedes en la rooming list." }} />
                  {puedeRooming && detalle.estado === "activo" && (
                    <form className="grid gap-3 sm:grid-cols-4 items-end" onSubmit={(e) => void handleAgregarHuesped(e)}>
                      <label className="text-xs text-muted-foreground flex flex-col gap-1">
                        Habitación
                        <NativeSelect value={huesped.tipoHabitacionId} onChange={(e) => setHuesped({ ...huesped, tipoHabitacionId: e.target.value })}>
                          <option value="">Elige…</option>
                          {[...new Set(detalle.noches.map((n) => n.tipoHabitacionId))].map((id) => (
                            <option key={id} value={id}>
                              {nombreTipo(id)}
                            </option>
                          ))}
                        </NativeSelect>
                      </label>
                      <label className="text-xs text-muted-foreground flex flex-col gap-1">
                        Nombre del huésped
                        <Input value={huesped.nombre} maxLength={120} onChange={(e) => setHuesped({ ...huesped, nombre: e.target.value })} className="h-11" />
                      </label>
                      <label className="text-xs text-muted-foreground flex flex-col gap-1">
                        Llegada
                        <Input type="date" value={huesped.llegada} min={detalle.llegada} max={detalle.salida} onChange={(e) => setHuesped({ ...huesped, llegada: e.target.value })} className="h-11" />
                      </label>
                      <label className="text-xs text-muted-foreground flex flex-col gap-1">
                        Salida
                        <Input type="date" value={huesped.salida} min={detalle.llegada} max={detalle.salida} onChange={(e) => setHuesped({ ...huesped, salida: e.target.value })} className="h-11" />
                      </label>
                      <div className="sm:col-span-4">
                        <Button type="submit" disabled={busy === "huesped"}>
                          {busy === "huesped" ? "Agregando…" : "Agregar huésped"}
                        </Button>
                      </div>
                    </form>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {puedeGestionar && (
            <TabsContent value="nueva" className="mt-4">
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground mb-3">
                    Importes en pesos con hasta 2 decimales (se guardan en centavos enteros). La fecha de liberación es el primer día en que se devuelven al inventario los cuartos sin confirmar, a las 00:00 en la zona horaria del hotel. Un descuento por encima del tope vigente solo lo autoriza dirección o gerencia.
                  </p>
                  <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => void handleCrear(e)}>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1 sm:col-span-2">
                      Nombre del grupo
                      <Input value={form.nombreGrupo} maxLength={120} onChange={(e) => setForm({ ...form, nombreGrupo: e.target.value })} placeholder="Ej. Boda García-López" className="h-11" />
                    </label>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Contacto (opcional)
                      <Input value={form.contacto} maxLength={120} onChange={(e) => setForm({ ...form, contacto: e.target.value })} className="h-11" />
                    </label>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Correo del contacto (opcional)
                      <Input type="email" value={form.correoContacto} maxLength={200} onChange={(e) => setForm({ ...form, correoContacto: e.target.value })} className="h-11" />
                    </label>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Llegada
                      <Input type="date" value={form.llegada} onChange={(e) => setForm({ ...form, llegada: e.target.value })} className="h-11" />
                    </label>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Salida
                      <Input type="date" value={form.salida} onChange={(e) => setForm({ ...form, salida: e.target.value })} className="h-11" />
                    </label>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Fecha de liberación (cutoff)
                      <Input type="date" value={form.fechaLiberacion} max={form.llegada || undefined} onChange={(e) => setForm({ ...form, fechaLiberacion: e.target.value })} className="h-11" />
                    </label>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Propuesta vigente hasta
                      <Input type="date" value={form.vigencia} onChange={(e) => setForm({ ...form, vigencia: e.target.value })} className="h-11" />
                    </label>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Descuento (%)
                      <Input inputMode="decimal" value={form.descuento} onChange={(e) => setForm({ ...form, descuento: e.target.value })} className="h-11" />
                    </label>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Anticipo requerido (MXN, solo se registra)
                      <Input inputMode="decimal" value={form.anticipo} onChange={(e) => setForm({ ...form, anticipo: e.target.value })} className="h-11" />
                    </label>

                    <div className="sm:col-span-2 flex flex-col gap-2">
                      <span className="text-xs text-muted-foreground">Cuartos por tipo de habitación</span>
                      {renglones.map((r, i) => (
                        <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] items-end">
                          <NativeSelect aria-label={`Tipo de habitación ${i + 1}`} value={r.tipoHabitacionId} onChange={(e) => setRenglones(renglones.map((x, j) => (j === i ? { ...x, tipoHabitacionId: e.target.value } : x)))}>
                            <option value="">Tipo de habitación…</option>
                            {tipos.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.nombre}
                              </option>
                            ))}
                          </NativeSelect>
                          <Input aria-label={`Cuartos ${i + 1}`} inputMode="numeric" placeholder="Cuartos" value={r.cuartos} onChange={(e) => setRenglones(renglones.map((x, j) => (j === i ? { ...x, cuartos: e.target.value } : x)))} className="h-11" />
                          <Input aria-label={`Tarifa por noche ${i + 1}`} inputMode="decimal" placeholder="Tarifa por noche (MXN)" value={r.tarifa} onChange={(e) => setRenglones(renglones.map((x, j) => (j === i ? { ...x, tarifa: e.target.value } : x)))} className="h-11" />
                          {renglones.length > 1 && (
                            <Button type="button" size="sm" variant="ghost" onClick={() => setRenglones(renglones.filter((_, j) => j !== i))}>
                              Quitar
                            </Button>
                          )}
                        </div>
                      ))}
                      <div>
                        <Button type="button" size="sm" variant="outline" onClick={() => setRenglones([...renglones, { tipoHabitacionId: "", cuartos: "", tarifa: "" }])}>
                          Agregar tipo de habitación
                        </Button>
                      </div>
                    </div>

                    <p className="sm:col-span-2 text-sm text-foreground" aria-live="polite">
                      {preview ? `Total estimado: ${formatearCentavos(preview.total)} (${preview.noches} noches; bruto ${formatearCentavos(preview.bruto)}). El servidor recalcula el importe final.` : "Completa fechas, cuartos y tarifas para ver el total estimado."}
                    </p>
                    <div className="sm:col-span-2">
                      <Button type="submit" disabled={busy === "crear"}>
                        {busy === "crear" ? "Creando…" : "Crear cotización"}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      )}
      {dialogo}
    </PageContainer>
  );
}
