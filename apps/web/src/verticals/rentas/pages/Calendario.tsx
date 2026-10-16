// Calendario de reservas y bloqueos (Fase 13) — cierra el hallazgo de auditoría
// "Calendario de reservas y bloqueos: backend completo sin UI": reservas.ts (Fase 1)
// y bloqueos.ts (Fase 4) ya exponían crear/modificar/cancelar reservas y crear/
// listar/liberar bloqueos, pero ningún cliente web los consumía. Vista real (lista
// por fecha, no un calendario visual con drag-and-drop — fuera de alcance de este
// hallazgo, ver el brief): unidad seleccionada -> lista unificada de sus ocupaciones
// (reserva de canal Y bloqueo, GET .../ocupaciones, calendario-client.ts) con
// crear/cancelar reserva, crear/cancelar bloqueo y modificar fechas de una reserva
// directa -- las 3 acciones reales que el backend ya soportaba sin UI.
//
// Ronda de portado del sistema de diseño real (@atiende/ui): Button/Card/Input/
// Label/Badge/EstadoCargando/EstadoVacio/EstadoError + clases de token en lugar de
// los `style={{...}}` hechos a mano. La confirmación de cancelar/liberar (patrón de
// 2 pasos, ver abajo) pasa a <AlertDialog> real (no ModalFormularioLateral -- una
// confirmación no es un formulario, mismo criterio que la referencia real), pero
// CONSERVA sus dos pasos exactos: el primer clic solo marca
// `confirmandoCancelarId`, la llamada al servidor sigue ocurriendo únicamente en
// el segundo clic explícito. CERO cambios de lógica de negocio: mismos efectos,
// mismas llamadas, mismas ramas de render.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { CalendarPlus, Ban, CalendarDays, Pencil } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  Input,
  Label,
  NativeSelect,
  PageContainer,
  StatusBadge,
} from "@atiende/ui";
import {
  cancelarBloqueo,
  cancelarReserva,
  crearBloqueo,
  createReserva,
  ESTADO_LABELS,
  fetchOcupaciones,
  fetchUnidades,
  modificarFechasReserva,
  RAZON_LABELS,
  RAZONES_BLOQUEO,
} from "../lib/calendario-client.ts";
import type { OcupacionCalendario, RazonBloqueo, UnidadOption } from "../lib/calendario-client.ts";
import { CalendarioVisual } from "../components/CalendarioVisual.tsx";
import { ocupacionTone } from "../lib/status-tones.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";

/** Solo las reservas SIN canal externo (o canal 'manual') aceptan modificar fechas —
 * mismo guardia que ya aplica el servidor en `PATCH .../reservas/:id`
 * ("reserva_no_directa" si `canalOrigenId` no es null/manual, ver reservas.ts). Esto
 * solo evita ofrecer un botón que el servidor rechazaría; el servidor SIEMPRE
 * re-valida. */
function esReservaDirecta(o: OcupacionCalendario): boolean {
  return o.capa === "reserva" && (o.canalCodigo === null || o.canalCodigo === "manual");
}

/** Rn-P3-29: una reserva importada de un canal externo no se cancela desde Atiende
 *  (la API responde 409 reserva_no_directa): se cancela en el canal y el siguiente
 *  sync la libera aquí. */
function esReservaDeCanal(o: OcupacionCalendario): boolean {
  return o.capa === "reserva" && o.canalCodigo !== null && o.canalCodigo !== "manual";
}

/** Rn-06: la página abre en el calendario visual (mes / línea de tiempo / agenda móvil); la lista de gestión de abajo
 * (crear, modificar y cancelar reservas y bloqueos de UNA unidad) sigue intacta como segunda pestaña y se alcanza también
 * desde el detalle de cualquier día o barra del calendario. */
export function CalendarioPage(ctx: RentasShellContext) {
  const [modo, setModo] = useState<"visual" | "lista">("visual");
  const [unidadLista, setUnidadLista] = useState("");
  return (
    <PageContainer padding="none" size="xl" className="gap-4 [&>*]:min-w-0">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Calendario</h1>
        <div role="group" aria-label="Modo del calendario" className="flex gap-1.5">
          <Button type="button" size="sm" variant={modo === "visual" ? "default" : "outline"} aria-pressed={modo === "visual"} onClick={() => setModo("visual")}>
            Calendario
          </Button>
          <Button type="button" size="sm" variant={modo === "lista" ? "default" : "outline"} aria-pressed={modo === "lista"} onClick={() => setModo("lista")}>
            Lista
          </Button>
        </div>
      </header>
      {modo === "visual" ? (
        <CalendarioVisual
          apiBaseUrl={ctx.apiBaseUrl}
          token={ctx.token}
          propertyId={ctx.propertyId}
          orgSlug={ctx.orgSlug}
          onGestionar={(unidadId) => {
            setUnidadLista(unidadId);
            setModo("lista");
          }}
        />
      ) : (
        <CalendarioLista key={unidadLista} {...ctx} unidadInicial={unidadLista} />
      )}
    </PageContainer>
  );
}

function CalendarioLista({ apiBaseUrl, token, propertyId, unidadInicial }: RentasShellContext & { readonly unidadInicial: string }) {
  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [unidadId, setUnidadId] = useState<string>(unidadInicial);
  const [ocupaciones, setOcupaciones] = useState<readonly OcupacionCalendario[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showReservaForm, setShowReservaForm] = useState(false);
  const [reservaInicio, setReservaInicio] = useState("");
  const [reservaFin, setReservaFin] = useState("");
  const [huespedNombre, setHuespedNombre] = useState("");
  const [huespedContacto, setHuespedContacto] = useState("");
  const [creandoReserva, setCreandoReserva] = useState(false);
  const [reservaFormError, setReservaFormError] = useState<string | null>(null);

  const [showBloqueoForm, setShowBloqueoForm] = useState(false);
  const [bloqueoInicio, setBloqueoInicio] = useState("");
  const [bloqueoFin, setBloqueoFin] = useState("");
  const [bloqueoRazon, setBloqueoRazon] = useState<RazonBloqueo>("MANTENIMIENTO");
  const [creandoBloqueo, setCreandoBloqueo] = useState(false);
  const [bloqueoFormError, setBloqueoFormError] = useState<string | null>(null);

  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [editInicio, setEditInicio] = useState("");
  const [editFin, setEditFin] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [guardandoEdit, setGuardandoEdit] = useState(false);

  // Hallazgo de auditoría (severidad ALTA, "cancelar la reserva de un huésped ejecuta
  // con un solo clic sin confirmación") -- el primer clic solo marca CUÁL ocupación
  // está pidiendo confirmación (mismo patrón de 2 pasos que ya usa Aprobaciones.tsx
  // para "Rechazar" -> "Confirmar rechazo"); la llamada real al servidor
  // (`handleCancelar`) solo ocurre en el SEGUNDO clic, explícito ("Sí, cancelar").
  const [confirmandoCancelarId, setConfirmandoCancelarId] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const list = await fetchUnidades(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setUnidades(list);
        setUnidadId((current) => current || list[0]?.id || "");
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las unidades de esta propiedad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  async function loadOcupaciones(uid: string) {
    setError(null);
    try {
      const list = await fetchOcupaciones(fetch, apiBaseUrl, token, propertyId, uid);
      setOcupaciones(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el calendario de esta unidad.");
    }
  }

  useEffect(() => {
    if (!unidadId) return;
    setOcupaciones(null);
    void loadOcupaciones(unidadId);
  }, [apiBaseUrl, token, propertyId, unidadId]);

  async function handleCrearReserva(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReservaFormError(null);
    if (!reservaInicio || !reservaFin) return setReservaFormError("Check-in y check-out son requeridos.");
    setCreandoReserva(true);
    try {
      const resultado = await createReserva(fetch, apiBaseUrl, token, propertyId, unidadId, {
        rango: { inicio: reservaInicio, fin: reservaFin },
        huespedNombre: huespedNombre.trim() || undefined,
        huespedContacto: huespedContacto.trim() || undefined,
      });
      setReservaInicio("");
      setReservaFin("");
      setHuespedNombre("");
      setHuespedContacto("");
      setShowReservaForm(false);
      setNotice(
        resultado.conflictosCapaCruzada > 0
          ? `Reserva creada — se detectó ${resultado.conflictosCapaCruzada} conflicto(s) con un bloqueo existente en estas fechas, revisa el calendario.`
          : "Reserva creada.",
      );
      await loadOcupaciones(unidadId);
    } catch (err) {
      setReservaFormError(err instanceof Error ? err.message : "No se pudo crear la reserva.");
    } finally {
      setCreandoReserva(false);
    }
  }

  async function handleCrearBloqueo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBloqueoFormError(null);
    if (!bloqueoInicio || !bloqueoFin) return setBloqueoFormError("Inicio y fin son requeridos.");
    setCreandoBloqueo(true);
    try {
      const resultado = await crearBloqueo(fetch, apiBaseUrl, token, propertyId, unidadId, { rango: { inicio: bloqueoInicio, fin: bloqueoFin }, razon: bloqueoRazon });
      setBloqueoInicio("");
      setBloqueoFin("");
      setBloqueoRazon("MANTENIMIENTO");
      setShowBloqueoForm(false);
      setNotice(
        resultado.conflictosCapaCruzada > 0
          ? `Bloqueo creado — se detectó ${resultado.conflictosCapaCruzada} conflicto(s) con una ocupación existente en estas fechas, revisa el calendario.`
          : "Bloqueo creado.",
      );
      await loadOcupaciones(unidadId);
    } catch (err) {
      setBloqueoFormError(err instanceof Error ? err.message : "No se pudo crear el bloqueo.");
    } finally {
      setCreandoBloqueo(false);
    }
  }

  function startEdit(o: OcupacionCalendario) {
    setEditandoId(o.id);
    setEditInicio(o.rango.inicio);
    setEditFin(o.rango.fin);
    setEditError(null);
  }

  async function handleGuardarEdit(o: OcupacionCalendario) {
    setEditError(null);
    if (!editInicio || !editFin) return setEditError("Inicio y fin son requeridos.");
    setGuardandoEdit(true);
    try {
      await modificarFechasReserva(fetch, apiBaseUrl, token, propertyId, unidadId, o.id, { inicio: editInicio, fin: editFin });
      setEditandoId(null);
      setNotice("Fechas actualizadas.");
      await loadOcupaciones(unidadId);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "No se pudieron actualizar las fechas.");
    } finally {
      setGuardandoEdit(false);
    }
  }

  async function handleCancelar(o: OcupacionCalendario) {
    setConfirmandoCancelarId(null);
    setBusyId(o.id);
    setError(null);
    try {
      if (o.capa === "reserva") {
        await cancelarReserva(fetch, apiBaseUrl, token, propertyId, unidadId, o.id);
        setNotice("Reserva cancelada.");
      } else {
        await cancelarBloqueo(fetch, apiBaseUrl, token, propertyId, unidadId, o.id);
        setNotice("Bloqueo liberado.");
      }
      await loadOcupaciones(unidadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la cancelación.");
    } finally {
      setBusyId(null);
    }
  }

  if (unidades && unidades.length === 0) {
    return <EstadoError titulo="Sin unidades" mensaje="Esta propiedad todavía no tiene ninguna unidad configurada." />;
  }

  const ocupacionConfirmando = ocupaciones?.find((o) => o.id === confirmandoCancelarId) ?? null;
  const nombreUnidad = unidades?.find((u) => u.id === unidadId)?.nombre;

  return (
    <div className="flex flex-col gap-4 [&>*]:min-w-0">
      <header className="flex items-center justify-end flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => {
              setReservaFormError(null);
              setShowReservaForm(true);
            }}
          >
            <CalendarPlus className="w-4 h-4" strokeWidth={1.75} />
            + Nueva reserva
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setBloqueoFormError(null);
              setShowBloqueoForm(true);
            }}
          >
            <Ban className="w-4 h-4" strokeWidth={1.75} />
            + Nuevo bloqueo
          </Button>
        </div>
      </header>

      <Label className={`${LABEL_CLASES} max-w-[320px]`}>
        Unidad
        <NativeSelect value={unidadId} onChange={(e) => setUnidadId(e.target.value)} disabled={!unidades}>
          {!unidades && <option>Cargando…</option>}
          {unidades?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.nombre}
            </option>
          ))}
        </NativeSelect>
      </Label>

      {showReservaForm && (
        <FormDialog
          open
          onOpenChange={(abierto) => {
            if (!abierto) setShowReservaForm(false);
          }}
          titulo="Nueva reserva directa"
          subtitulo={nombreUnidad ? `Unidad: ${nombreUnidad}` : undefined}
          anchoClase="max-w-3xl"
          footer={
            <Button type="submit" form="calendario-nueva-reserva" disabled={creandoReserva}>
              {creandoReserva ? "Creando…" : "Crear reserva"}
            </Button>
          }
        >
          <form id="calendario-nueva-reserva" onSubmit={handleCrearReserva} className="flex flex-col gap-2.5">
            <div className="flex gap-2.5">
              <Label className={`${LABEL_CLASES} flex-1`}>
                Check-in
                <Input type="date" value={reservaInicio} onChange={(e) => setReservaInicio(e.target.value)} required />
              </Label>
              <Label className={`${LABEL_CLASES} flex-1`}>
                Check-out
                <Input type="date" value={reservaFin} onChange={(e) => setReservaFin(e.target.value)} required />
              </Label>
            </div>
            <Label className={LABEL_CLASES}>
              Huésped (opcional)
              <Input value={huespedNombre} onChange={(e) => setHuespedNombre(e.target.value)} placeholder="Nombre" />
            </Label>
            <Label className={LABEL_CLASES}>
              Contacto del huésped (opcional)
              <Input value={huespedContacto} onChange={(e) => setHuespedContacto(e.target.value)} placeholder="Correo o teléfono" />
            </Label>
            {reservaFormError && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {reservaFormError}
              </p>
            )}
          </form>
        </FormDialog>
      )}

      {showBloqueoForm && (
        <FormDialog
          open
          onOpenChange={(abierto) => {
            if (!abierto) setShowBloqueoForm(false);
          }}
          titulo="Nuevo bloqueo"
          subtitulo={nombreUnidad ? `Unidad: ${nombreUnidad}` : undefined}
          anchoClase="max-w-3xl"
          footer={
            <Button type="submit" form="calendario-nuevo-bloqueo" disabled={creandoBloqueo}>
              {creandoBloqueo ? "Creando…" : "Crear bloqueo"}
            </Button>
          }
        >
          <form id="calendario-nuevo-bloqueo" onSubmit={handleCrearBloqueo} className="flex flex-col gap-2.5">
            <div className="flex gap-2.5">
              <Label className={`${LABEL_CLASES} flex-1`}>
                Inicio
                <Input type="date" value={bloqueoInicio} onChange={(e) => setBloqueoInicio(e.target.value)} required />
              </Label>
              <Label className={`${LABEL_CLASES} flex-1`}>
                Fin
                <Input type="date" value={bloqueoFin} onChange={(e) => setBloqueoFin(e.target.value)} required />
              </Label>
            </div>
            <Label className={LABEL_CLASES}>
              Razón
              <NativeSelect value={bloqueoRazon} onChange={(e) => setBloqueoRazon(e.target.value as RazonBloqueo)}>
                {RAZONES_BLOQUEO.map((r) => (
                  <option key={r} value={r}>
                    {RAZON_LABELS[r]}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            {bloqueoFormError && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {bloqueoFormError}
              </p>
            )}
          </form>
        </FormDialog>
      )}

      {notice && <p className="m-0 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground">{notice}</p>}
      {error && <EstadoError mensaje={error} />}
      {!ocupaciones && !error && <EstadoCargando lineas={2} />}
      {ocupaciones && ocupaciones.length === 0 && (
        <EstadoVacio icon={CalendarDays} titulo="Calendario vacío" mensaje="Esta unidad no tiene ninguna reserva ni bloqueo registrado." />
      )}

      <div className="flex flex-col gap-2.5">
        {ocupaciones?.map((o) => {
          const puedeEditar = esReservaDirecta(o) && o.estado === "confirmado";
          const puedeCancelar = o.estado !== "cancelado" && (o.capa === "bloqueo" || esReservaDirecta(o));
          const avisoCancelarEnCanal = o.estado !== "cancelado" && esReservaDeCanal(o);
          return (
            <Card key={o.id}>
              <CardContent className="p-4">
                <div className="flex justify-between flex-wrap gap-2">
                  <div>
                    <p className="m-0 font-semibold text-foreground">
                      {o.rango.inicio} → {o.rango.fin}
                    </p>
                    <p className="mt-0.5 mb-0 text-xs text-muted-foreground">
                      {RAZON_LABELS[o.razon]}
                      {o.capa === "reserva" && o.canalCodigo ? ` · canal: ${o.canalCodigo}` : ""}
                      {o.huespedNombre ? ` · huésped: ${o.huespedNombre}` : ""}
                      {o.huespedContacto ? ` (${o.huespedContacto})` : ""}
                    </p>
                  </div>
                  <StatusBadge tone={ocupacionTone(o)} className="self-start">
                    {ESTADO_LABELS[o.estado]}
                  </StatusBadge>
                </div>

                {editandoId === o.id ? (
                  <div className="flex gap-2 items-end mt-2.5 flex-wrap">
                    <Label className={`${LABEL_CLASES} flex-1 min-w-[120px]`}>
                      Nuevo check-in
                      <Input type="date" value={editInicio} onChange={(e) => setEditInicio(e.target.value)} />
                    </Label>
                    <Label className={`${LABEL_CLASES} flex-1 min-w-[120px]`}>
                      Nuevo check-out
                      <Input type="date" value={editFin} onChange={(e) => setEditFin(e.target.value)} />
                    </Label>
                    <Button type="button" variant="outline" size="sm" onClick={() => void handleGuardarEdit(o)} disabled={guardandoEdit}>
                      {guardandoEdit ? "Guardando…" : "Guardar"}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditandoId(null)}>
                      Cancelar
                    </Button>
                    {editError && (
                      <p role="alert" className="m-0 w-full text-xs text-destructive">
                        {editError}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex gap-1.5 mt-2.5 flex-wrap">
                    {puedeEditar && (
                      <Button type="button" variant="outline" size="sm" onClick={() => startEdit(o)} disabled={busyId === o.id}>
                        <Pencil className="w-4 h-4" strokeWidth={1.75} />
                        Modificar fechas
                      </Button>
                    )}
                    {puedeCancelar && (
                      <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmandoCancelarId(o.id)} disabled={busyId === o.id}>
                        {o.capa === "reserva" ? "Cancelar reserva" : "Liberar bloqueo"}
                      </Button>
                    )}
                    {avisoCancelarEnCanal && (
                      <p className="m-0 text-xs text-muted-foreground">
                        Esta reserva viene de {o.canalCodigo}: cancélala allá; Atiende la liberará en el siguiente sync.
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Segundo paso REAL de la confirmación de 2 pasos: la llamada al servidor solo sale de "Sí, ..."; "No, mantenerla",
          Escape o clic fuera cierran sin tocar nada. Nombra la unidad y las fechas del objeto. */}
      {ocupacionConfirmando && (
        <ConfirmDialog
          open
          onOpenChange={(abierto) => {
            if (!abierto) setConfirmandoCancelarId(null);
          }}
          tono="danger"
          titulo={ocupacionConfirmando.capa === "reserva" ? "¿Cancelar esta reserva?" : "¿Liberar este bloqueo?"}
          descripcion={`${ocupacionConfirmando.capa === "reserva" ? "¿Seguro que quieres cancelar esta reserva?" : "¿Seguro que quieres liberar este bloqueo?"} Esta acción no se puede deshacer. (${nombreUnidad ? `${nombreUnidad}: ` : ""}${ocupacionConfirmando.rango.inicio} → ${ocupacionConfirmando.rango.fin})`}
          cancelar="No, mantenerla"
          confirmar={ocupacionConfirmando.capa === "reserva" ? "Sí, cancelar reserva" : "Sí, liberar bloqueo"}
          onConfirm={() => handleCancelar(ocupacionConfirmando)}
        />
      )}
    </div>
  );
}
