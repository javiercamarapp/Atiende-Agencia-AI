// Reservas — recepción (Fase 7): crear/listar/transicionar/cancelar reservas reales
// contra la máquina de estados de @atiende/domain-hoteles (reservationStateMachine.ts,
// ver reservas-client.ts). El servidor SIEMPRE re-valida cada transición — los
// botones ofrecidos aquí son solo un espejo de NEXT_GENERIC_STATUS para no mostrar
// una acción que el servidor rechazaría (mismo criterio que PedidosPage de
// restaurantes).
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza
// botones/pills/tarjetas/inputs de estilos inline por Button/Tabs/Card/Badge/Input/
// Label reales — mismo criterio ya aplicado en HotelesShell.tsx/Login.tsx. El modal
// de confirmación de cancelación (antes `<ConfirmModal>` de estilos inline, ver
// components/ConfirmModal.tsx, ahora eliminado por no usarse en ningún lado) usa
// `AlertDialog` real del design system (no `Dialog`/`ModalFormularioLateral` --
// mismo criterio que la referencia real, atiende-restaurantes/PedidosSection.tsx:
// una confirmación sí/no no es un formulario) — mismo contrato
// (open/onConfirm/onCancel/busy), sin cambiar cuándo se abre ni qué confirma.
// Ningún cambio de lógica: mismos props, mismo estado, mismas llamadas de red,
// misma condición de cada rama.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
import {
  assignRoom,
  cancelReservation,
  createGuest,
  createReservation,
  fetchReservations,
  fetchRooms,
  fetchRoomTypes,
  folioDetailPath,
  isCancellable,
  NEXT_GENERIC_STATUS,
  RESERVATION_STATUS_LABELS,
  searchGuests,
  transitionReservation,
} from "../lib/reservas-client.ts";
import type { GuestOption, ReservationStatus, ReservationSummary, RoomOption, RoomTypeOption } from "../lib/reservas-client.ts";
import { fetchFoliosByReservation } from "../lib/folios-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const FILTERS: ReadonlyArray<ReservationStatus | "todas"> = ["todas", "confirmada", "check_in", "en_estancia", "check_out", "cerrada", "cancelada"];
const selectClass =
  "mt-1 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function ReservasPage({ apiBaseUrl, token, propertyId, orgSlug }: HotelesShellContext) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ReservationStatus | "todas">("todas");
  const [reservations, setReservations] = useState<readonly ReservationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  // Hallazgo de auditoría (severidad ALTA, "acciones destructivas sin
  // confirmación: cancelar reserva... ejecuta de inmediato con un clic"): la
  // reserva pendiente de confirmar cancelación en el <Dialog> de abajo -- `null`
  // significa que el modal está cerrado.
  const [pendingCancel, setPendingCancel] = useState<ReservationSummary | null>(null);

  // Fix hallazgo ALTA — catálogos reales en vez de UUIDs a mano (ver reservas-client.ts
  // fetchRoomTypes/searchGuests). `roomTypes` se carga completo una vez (catálogo
  // acotado a la property, ver GET /tipos-habitacion); `guestOptions` es un
  // autocomplete real contra el servidor: se re-busca en cada tecleo de `guestQuery`
  // (con debounce), nunca una lista fija cargada una sola vez, porque el catálogo de
  // huéspedes puede crecer sin límite (a diferencia de tipos de habitación).
  const [roomTypes, setRoomTypes] = useState<readonly RoomTypeOption[] | null>(null);
  const [roomTypeId, setRoomTypeId] = useState("");
  const [checkInDate, setCheckInDate] = useState("");
  const [checkOutDate, setCheckOutDate] = useState("");
  const [guestQuery, setGuestQuery] = useState("");
  const [guestOptions, setGuestOptions] = useState<readonly GuestOption[]>([]);
  const [guestId, setGuestId] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-habitación/
  // tarifas/huéspedes imposible sin SQL directo") — alta de huésped inline, sin
  // salir del formulario de "crear reserva". `showNewGuestForm` alterna un
  // formulario mínimo (nombre/email/teléfono); al crear, el huésped nuevo queda
  // seleccionado de inmediato (mismo `guestId` que ya usaba el <select> existente).
  const [showNewGuestForm, setShowNewGuestForm] = useState(false);
  const [newGuestName, setNewGuestName] = useState("");
  const [newGuestEmail, setNewGuestEmail] = useState("");
  const [newGuestPhone, setNewGuestPhone] = useState("");
  const [creatingGuest, setCreatingGuest] = useState(false);

  // Fix hallazgo CRÍTICO ("asignación de habitación al reservar") — `assigningId`
  // es la reserva cuyo selector de habitación está abierto (`null` = ninguno);
  // `roomsByReservation` cachea las habitaciones YA pedidas por reservationId, para
  // no volver a pedir el mismo tipo de habitación dos veces si el staff abre/cierra
  // el selector varias veces.
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [roomsByReservation, setRoomsByReservation] = useState<Record<string, readonly RoomOption[]>>({});
  const [assigningRoomId, setAssigningRoomId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const list = await fetchReservations(fetch, apiBaseUrl, token, propertyId);
      setReservations([...list].sort((a, b) => b.creadaEn.localeCompare(a.creadaEn)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las reservas.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  // El catálogo de tipos de habitación solo se necesita mientras el formulario está
  // abierto -- se carga la primera vez que se abre, no en cada render del panel.
  useEffect(() => {
    if (!showForm || roomTypes !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const tipos = await fetchRoomTypes(fetch, apiBaseUrl, token, propertyId);
        if (!cancelled) setRoomTypes(tipos);
      } catch (err) {
        if (!cancelled) setFormError(err instanceof Error ? err.message : "No se pudo cargar el catálogo de tipos de habitación.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showForm, roomTypes, apiBaseUrl, token, propertyId]);

  // Autocomplete real de huéspedes -- vuelve a preguntarle al servidor en cada
  // cambio de `guestQuery` (con debounce de 300ms), incluyendo query vacía (trae el
  // catálogo completo en orden alfabético, insumo del autocomplete recién abierto
  // antes de que el staff escriba nada). Solo corre mientras el formulario está
  // visible -- no dispara peticiones de fondo con el formulario cerrado.
  useEffect(() => {
    if (!showForm) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const results = await searchGuests(fetch, apiBaseUrl, token, propertyId, guestQuery);
          if (!cancelled) setGuestOptions(results);
        } catch {
          if (!cancelled) setGuestOptions([]);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [showForm, guestQuery, apiBaseUrl, token, propertyId]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!roomTypeId) return setFormError("Selecciona un tipo de habitación.");
    if (!checkInDate || !checkOutDate) return setFormError("Check-in y check-out son requeridos.");
    setCreating(true);
    try {
      await createReservation(fetch, apiBaseUrl, token, propertyId, { roomTypeId, checkInDate, checkOutDate, guestId: guestId || undefined }, newIdempotencyKey());
      setRoomTypeId("");
      setCheckInDate("");
      setCheckOutDate("");
      setGuestQuery("");
      setGuestId("");
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo crear la reserva.");
    } finally {
      setCreating(false);
    }
  }

  // Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-habitación/
  // tarifas/huéspedes imposible sin SQL directo") — alta real de huésped desde el
  // mismo formulario de "crear reserva" (antes de esto, `guestId` solo podía
  // apuntar a un huésped ya sembrado por SQL directo). El huésped nuevo queda
  // seleccionado de inmediato (`setGuestId`), listo para "Crear reserva". Función
  // plana (NO un handler de <form onSubmit>) a propósito: este formulario mínimo
  // vive DENTRO del <form onSubmit={handleCreate}> de "crear reserva" -- HTML no
  // permite anidar un <form> dentro de otro, así que el botón de abajo la invoca
  // directo por `onClick`, sin evento de submit que prevenir.
  async function handleCreateGuest() {
    setFormError(null);
    if (!newGuestName.trim()) return setFormError("El nombre del huésped es requerido.");
    setCreatingGuest(true);
    try {
      const guest = await createGuest(fetch, apiBaseUrl, token, propertyId, {
        nombreCompleto: newGuestName.trim(),
        email: newGuestEmail.trim() || undefined,
        telefono: newGuestPhone.trim() || undefined,
      });
      setGuestOptions((prev) => [guest, ...prev]);
      setGuestId(guest.id);
      setGuestQuery(guest.nombreCompleto);
      setNewGuestName("");
      setNewGuestEmail("");
      setNewGuestPhone("");
      setShowNewGuestForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo crear el huésped.");
    } finally {
      setCreatingGuest(false);
    }
  }

  // Fix hallazgo CRÍTICO ("asignación de habitación al reservar") — abre/cierra el
  // selector de habitación de una reserva; pide las habitaciones del TIPO de
  // habitación de esa reserva la primera vez que se abre (cacheadas por
  // reservationId en `roomsByReservation`, nunca vuelve a pedirlas si ya las tiene).
  async function handleToggleAssign(reservation: ReservationSummary) {
    if (assigningId === reservation.id) {
      setAssigningId(null);
      return;
    }
    setAssigningId(reservation.id);
    setAssigningRoomId(reservation.roomId);
    if (roomsByReservation[reservation.id]) return;
    try {
      const rooms = await fetchRooms(fetch, apiBaseUrl, token, propertyId, reservation.roomTypeId);
      setRoomsByReservation((prev) => ({ ...prev, [reservation.id]: rooms }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las habitaciones de este tipo.");
    }
  }

  async function handleConfirmAssign(reservation: ReservationSummary) {
    if (!assigningRoomId) return;
    setBusyId(reservation.id);
    setError(null);
    try {
      await assignRoom(fetch, apiBaseUrl, token, propertyId, reservation.id, assigningRoomId);
      setAssigningId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo asignar la habitación.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleTransition(reservation: ReservationSummary, toStatus: ReservationStatus) {
    setBusyId(reservation.id);
    setError(null);
    try {
      await transitionReservation(fetch, apiBaseUrl, token, propertyId, reservation.id, toStatus);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el estado de la reserva.");
    } finally {
      setBusyId(null);
    }
  }

  // Hallazgo de auditoría (severidad ALTA, "acciones destructivas sin
  // confirmación"): abrir el modal ya NO cancela nada por sí solo -- solo la
  // ejecuta `handleConfirmCancel`, disparada por el botón de confirmar del <Dialog>
  // real de abajo ("modal, no window.confirm").
  function handleCancel(reservation: ReservationSummary) {
    setPendingCancel(reservation);
  }

  async function handleConfirmCancel() {
    const reservation = pendingCancel;
    if (!reservation) return;
    setBusyId(reservation.id);
    setError(null);
    try {
      await cancelReservation(fetch, apiBaseUrl, token, propertyId, reservation.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cancelar la reserva.");
    } finally {
      // Cierra el modal SIEMPRE (éxito o error) -- un fallo del servidor debe ser
      // visible en el banner de error de la página, nunca quedar oculto detrás del
      // overlay del modal.
      setPendingCancel(null);
      setBusyId(null);
    }
  }

  async function handleVerFolio(reservation: ReservationSummary) {
    setBusyId(reservation.id);
    setError(null);
    try {
      const folios = await fetchFoliosByReservation(fetch, apiBaseUrl, token, propertyId, reservation.id);
      const primary = folios.find((f) => f.esPrincipal) ?? folios[0];
      if (!primary) {
        setError("Esta reserva todavía no tiene ningún folio.");
        return;
      }
      // Fix hallazgo auditoría — ruta absoluta con orgSlug vía folioDetailPath()
      // (mismo patrón que CfdiListado.tsx). Un navigate relativo ("folios/x") se
      // resolvía como hijo de la ruta actual
      // ("/hoteles/:orgSlug/reservas/folios/x"), que no existe: la ruta real del
      // folio es "/hoteles/:orgSlug/folios/:folioId" (ver App.tsx).
      navigate(folioDetailPath(orgSlug, primary.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo abrir el folio de esta reserva.");
    } finally {
      setBusyId(null);
    }
  }

  const visible = reservations?.filter((r) => filter === "todas" || r.estado === filter) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-display font-semibold text-foreground">Reservas</h1>
        <Button type="button" variant={showForm ? "outline" : "default"} onClick={() => setShowForm((v) => !v)}>
          {!showForm && <Plus className="w-4 h-4" strokeWidth={1.75} />}
          {showForm ? "Cancelar" : "Nueva reserva"}
        </Button>
      </header>

      {showForm && (
        <Card className="max-w-md">
          <CardContent className="p-4">
            <form onSubmit={handleCreate} className="flex flex-col gap-3">
              <div>
                <Label htmlFor="res-tipo-habitacion">Tipo de habitación</Label>
                <select id="res-tipo-habitacion" value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)} required className={selectClass}>
                  <option value="" disabled>
                    {roomTypes === null ? "Cargando…" : "Selecciona un tipo de habitación"}
                  </option>
                  {roomTypes?.map((rt) => (
                    <option key={rt.id} value={rt.id}>
                      {rt.nombre} (máx. {rt.capacidadMaxima} huéspedes)
                    </option>
                  ))}
                </select>
                {roomTypes !== null && roomTypes.length === 0 && (
                  <span className="block mt-1 text-xs text-destructive">Esta property todavía no tiene tipos de habitación configurados.</span>
                )}
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <Label htmlFor="res-checkin">Check-in</Label>
                  <Input id="res-checkin" type="date" value={checkInDate} onChange={(e) => setCheckInDate(e.target.value)} required className="mt-1" />
                </div>
                <div className="flex-1">
                  <Label htmlFor="res-checkout">Check-out</Label>
                  <Input id="res-checkout" type="date" value={checkOutDate} onChange={(e) => setCheckOutDate(e.target.value)} required className="mt-1" />
                </div>
              </div>
              <div>
                <Label htmlFor="res-guest-query">Huésped (opcional — busca por nombre, correo o teléfono)</Label>
                <Input
                  id="res-guest-query"
                  type="text"
                  value={guestQuery}
                  onChange={(e) => {
                    setGuestQuery(e.target.value);
                    setGuestId("");
                  }}
                  placeholder="Buscar huésped…"
                  className="mt-1"
                />
                <select
                  value={guestId}
                  onChange={(e) => setGuestId(e.target.value)}
                  size={Math.min(5, guestOptions.length + 1)}
                  className="mt-1.5 flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">Sin huésped asignado</option>
                  {guestOptions.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.nombreCompleto}
                      {g.telefono ? ` · ${g.telefono}` : ""}
                      {g.email ? ` · ${g.email}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              {/* Fix hallazgo CRÍTICO ("...huéspedes imposible sin SQL directo") --
                  alta real de huésped sin salir de este formulario. */}
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setShowNewGuestForm((v) => !v)}>
                {showNewGuestForm ? "Cancelar alta de huésped" : "+ Huésped nuevo"}
              </Button>
              {showNewGuestForm && (
                <div className="flex flex-col gap-2 border border-dashed border-border rounded-lg p-3">
                  <div>
                    <Label htmlFor="res-guest-nombre" className="text-xs font-normal">Nombre completo</Label>
                    <Input id="res-guest-nombre" value={newGuestName} onChange={(e) => setNewGuestName(e.target.value)} className="mt-1 h-9" />
                  </div>
                  <div>
                    <Label htmlFor="res-guest-email" className="text-xs font-normal">Email (opcional)</Label>
                    <Input id="res-guest-email" value={newGuestEmail} onChange={(e) => setNewGuestEmail(e.target.value)} className="mt-1 h-9" />
                  </div>
                  <div>
                    <Label htmlFor="res-guest-telefono" className="text-xs font-normal">Teléfono (opcional)</Label>
                    <Input id="res-guest-telefono" value={newGuestPhone} onChange={(e) => setNewGuestPhone(e.target.value)} className="mt-1 h-9" />
                  </div>
                  <Button type="button" size="sm" onClick={() => void handleCreateGuest()} disabled={creatingGuest}>
                    {creatingGuest ? "Creando…" : "Crear y seleccionar huésped"}
                  </Button>
                </div>
              )}
              {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
              <Button type="submit" disabled={creating}>
                {creating ? "Creando…" : "Crear reserva"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Tabs value={filter} onValueChange={(v) => setFilter(v as ReservationStatus | "todas")}>
        <TabsList className="flex-wrap h-auto">
          {FILTERS.map((f) => (
            <TabsTrigger key={f} value={f}>
              {f === "todas" ? "Todas" : RESERVATION_STATUS_LABELS[f]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={filter} className="flex flex-col gap-4 mt-4">
          {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
          {!visible && !error && <EstadoCargando etiqueta="Cargando reservas…" />}
          {visible && visible.length === 0 && <EstadoVacio mensaje="No hay reservas en este filtro." />}

          <div className="flex flex-col gap-3">
            {visible?.map((r) => {
              const next = NEXT_GENERIC_STATUS[r.estado];
              const cancelable = isCancellable(r.estado);
              return (
                <Card key={r.id}>
                  <CardContent className="p-4">
                    <div className="flex justify-between flex-wrap gap-2">
                      <div>
                        <p className="font-semibold text-foreground">
                          {r.checkInDate} → {r.checkOutDate} · {formatMoney(r.montoTotal)}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Tipo de habitación: {r.roomTypeId} · {r.guestId ? `Huésped: ${r.guestId}` : "Sin huésped asignado"}
                        </p>
                        {/* Fix hallazgo CRÍTICO ("asignación de habitación al reservar") */}
                        <p className="mt-0.5 text-xs text-muted-foreground">{r.roomId ? `Habitación asignada: ${r.roomId}` : "Sin habitación asignada"}</p>
                      </div>
                      <Badge variant={r.estado === "cancelada" ? "destructive" : "secondary"} className="self-start">
                        {RESERVATION_STATUS_LABELS[r.estado]}
                      </Badge>
                    </div>
                    {r.penalizacionCancelacion != null && (
                      <p className="mt-1.5 text-xs text-destructive">Penalización de cancelación: {formatMoney(r.penalizacionCancelacion)}</p>
                    )}
                    <div className="flex gap-2 mt-2.5 flex-wrap">
                      <Button type="button" variant="outline" size="sm" onClick={() => void handleVerFolio(r)} disabled={busyId === r.id}>
                        Ver folio
                      </Button>
                      {next && (
                        <Button type="button" size="sm" onClick={() => void handleTransition(r, next)} disabled={busyId === r.id}>
                          {busyId === r.id ? "…" : `Marcar ${RESERVATION_STATUS_LABELS[next]}`}
                        </Button>
                      )}
                      {r.estado !== "cancelada" && (
                        <Button type="button" variant="outline" size="sm" onClick={() => void handleToggleAssign(r)} disabled={busyId === r.id}>
                          {assigningId === r.id ? "Cerrar" : r.roomId ? "Cambiar habitación" : "Asignar habitación"}
                        </Button>
                      )}
                      {cancelable && (
                        <Button type="button" variant="outline" size="sm" className="text-destructive border-destructive/40 hover:border-destructive" onClick={() => handleCancel(r)} disabled={busyId === r.id}>
                          Cancelar
                        </Button>
                      )}
                    </div>
                    {/* Fix hallazgo CRÍTICO ("asignación de habitación al reservar") --
                        selector inline, sin salir de la lista de reservas. */}
                    {assigningId === r.id && (
                      <div className="flex gap-2 items-center mt-2.5 flex-wrap">
                        <select
                          value={assigningRoomId ?? ""}
                          onChange={(e) => setAssigningRoomId(e.target.value || null)}
                          className="flex h-9 rounded-md border border-input bg-background px-2.5 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          <option value="" disabled>
                            {roomsByReservation[r.id] === undefined ? "Cargando…" : "Selecciona una habitación"}
                          </option>
                          {roomsByReservation[r.id]?.map((room) => (
                            <option key={room.id} value={room.id}>
                              {room.codigo} ({room.estado})
                            </option>
                          ))}
                        </select>
                        {roomsByReservation[r.id]?.length === 0 && (
                          <span className="text-xs text-destructive">Este tipo de habitación no tiene habitaciones físicas creadas todavía (ver Catálogo).</span>
                        )}
                        <Button type="button" size="sm" onClick={() => void handleConfirmAssign(r)} disabled={busyId === r.id || !assigningRoomId}>
                          {busyId === r.id ? "…" : "Confirmar asignación"}
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>

      <AlertDialog open={pendingCancel !== null} onOpenChange={(open) => { if (!open) setPendingCancel(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar reserva</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCancel
                ? `¿Cancelar la reserva ${pendingCancel.checkInDate} → ${pendingCancel.checkOutDate}? Esta acción libera la disponibilidad reservada y puede aplicar una penalización de cancelación.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingCancel !== null && busyId === pendingCancel.id}>Volver</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              // preventDefault: AlertDialogAction cierra solo por defecto -- este modal
              // sigue controlado por `pendingCancel`/`busyId` (mismo criterio que antes de
              // migrar de Dialog), no queremos que se cierre antes de que termine
              // `handleConfirmCancel`.
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmCancel();
              }}
              disabled={pendingCancel !== null && busyId === pendingCancel.id}
            >
              Sí, cancelar reserva
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
