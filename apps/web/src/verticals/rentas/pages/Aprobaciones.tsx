// Bandeja de aprobación de mensajería (cierra el hallazgo de auditoría ALTA
// "Mensajería con aprobación humana obligatoria: la cola de aprobación no tiene botón
// de aprobar"): mensajeria-conversaciones.ts/mensajeria-borradores.ts ya exponían
// GET/POST generar borrador, POST aprobar y POST rechazar desde antes de esta fase,
// pero ningún cliente web los consumía -- en la práctica nadie podía aprobar nada, el
// principio de diseño "un agente redacta y no sale hasta que alguien lo aprueba"
// vivía solo en el backend.
//
// Vista real: agrega, con `fetchBandejaAprobacion` (lib/mensajeria-client.ts), cada
// conversación de la property con sus borradores todavía `pendiente_aprobacion` --
// las que sí tienen algo por revisar aparecen primero. Cada tarjeta trae Aprobar
// (POST .../aprobar, sin confirmación adicional: el texto ya está a la vista) y
// Rechazar (revela un textarea de motivo, obligatorio -- mismo criterio de
// confirmación inline que "Modificar fechas" en Calendario.tsx). Aprobar/Rechazar se
// gatean en el CLIENTE por `MENSAJERIA_ESCRITURA_ROLES`
// (packages/domain-rentas/src/roles.ts), mismo patrón que
// `PRICING_ESCRITURA_ROLES` en Precios.tsx -- el servidor SIEMPRE re-valida con
// `assertVerticalRole`, este gate es solo UX para no ofrecer un botón que el
// servidor rechazaría con 403.
//
// Nota honesta (fuera de alcance de esta fase, NO se oculta): aprobar un borrador
// hoy dispara `SimuladorCanalMensajeria`, no un adaptador real de WhatsApp/Airbnb/
// Vrbo -- ver el aviso fijo debajo del encabezado y README.md de este vertical.
//
// Fase siguiente -- "la bandeja siempre estará vacía en producción" (hallazgo de
// auditoría: Aprobaciones.tsx solo aprobaba/rechazaba lo que YA existía, pero no
// había forma de sembrar una conversación desde cero): agrega el bloque
// `SimuladorMensajeEntrante`, que encadena los 3 POST que
// mensajeria-conversaciones-client.ts expone (crear conversación si hace falta,
// registrar el mensaje entrante, pedirle al agente un borrador) en una sola acción de
// staff. Sigue siendo, honestamente, un registro MANUAL -- no hay adaptador real de
// canal conectado (mismo aviso que ya tenía esta página para SimuladorCanalMensajeria,
// ver más abajo).
//
// Ronda de portado del sistema de diseño real (@atiende/ui): Card/Button/Badge/Input/
// Label/EstadoCargando/EstadoVacio/EstadoError y clases de token en lugar de los
// `style={{...}}` hechos a mano. El rechazo conserva EXACTAMENTE sus dos pasos
// (revelar textarea de motivo -> "Confirmar rechazo") y el motivo sigue siendo
// obligatorio; el paso de confirmación pasa a <AlertDialog> real (no
// ModalFormularioLateral -- una confirmación no es un formulario, mismo criterio
// que la referencia real). CERO cambios de lógica.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Check, Inbox, MessageSquarePlus, X } from "lucide-react";
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
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
} from "@atiende/ui";
import { aprobarBorrador, CANAL_LABELS, CANALES_MENSAJERIA, fetchBandejaAprobacion, fetchConversaciones, fetchUnidades, rechazarBorrador } from "../lib/mensajeria-client.ts";
import type { BorradorRecord, CanalMensajeriaCodigo, ConversacionRecord, ItemBandeja, UnidadOption } from "../lib/mensajeria-client.ts";
import { crearConversacion, generarBorrador, registrarMensajeEntrante } from "../lib/mensajeria-conversaciones-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const MENSAJERIA_ESCRITURA_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]);

const NUEVA_CONVERSACION = "__nueva__";

/** Mismos tokens que el <Input> de @atiende/ui aplicados a los controles nativos que
 * siguen siendo nativos a propósito: <select> de datos reales (unidad, conversación,
 * canal) con su estado `<option>Cargando…</option>`, y <textarea> (no hay primitivo
 * de textarea en packages/ui). */
const SELECT_CLASES =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const TEXTAREA_CLASES =
  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const LABEL_CLASES = "flex flex-col gap-1.5 text-[13px] text-foreground";

function contextoLinea(item: ItemBandeja): string {
  const partes: string[] = [item.unidad.nombre, CANAL_LABELS[item.conversacion.canal]];
  if (item.conversacion.huespedNombre) partes.push(`huésped: ${item.conversacion.huespedNombre}`);
  if (item.conversacion.fechaCheckIn || item.conversacion.fechaCheckOut) {
    partes.push(`${item.conversacion.fechaCheckIn ?? "?"} → ${item.conversacion.fechaCheckOut ?? "?"}`);
  }
  if (item.conversacion.reservaConfirmada) partes.push("reserva confirmada");
  return partes.join(" · ");
}

/** Mismo criterio que la versión previa (enviado = principal, rechazado = destructivo,
 * resto = apagado), ahora sobre las variantes reales de <Badge>. */
function historialBadge(b: BorradorRecord): { variante: "default" | "destructive" | "outline"; label: string } {
  if (b.estado === "enviado") return { variante: "default", label: "Enviado" };
  if (b.estado === "rechazado") return { variante: "destructive", label: "Rechazado" };
  return { variante: "outline", label: "Aprobado" };
}

interface BorradorCardProps {
  readonly item: ItemBandeja;
  readonly borrador: BorradorRecord;
  readonly puedeEscribir: boolean;
  readonly busy: boolean;
  readonly onAprobar: (borradorId: string) => void;
  readonly onRechazar: (borradorId: string, motivo: string) => void;
}

function BorradorPendienteCard({ item, borrador, puedeEscribir, busy, onAprobar, onRechazar }: BorradorCardProps) {
  const [rechazando, setRechazando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [motivoError, setMotivoError] = useState<string | null>(null);

  function confirmarRechazo() {
    if (!motivo.trim()) {
      setMotivoError("El motivo es requerido para rechazar un borrador.");
      return;
    }
    onRechazar(borrador.id, motivo.trim());
  }

  return (
    <Card className="border-dashed bg-muted/40">
      <CardContent className="p-3 flex flex-col gap-2">
        <div className="flex justify-between gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">
            {borrador.generadoPor === "agente_llm" ? "Generado por agente IA" : "Generado por motor de plantillas"} · {new Date(borrador.creadoEn).toLocaleString("es-MX")}
          </span>
          <Badge variant="secondary">Pendiente de aprobación</Badge>
        </div>
        <p className="m-0 text-sm text-foreground whitespace-pre-wrap">{borrador.texto}</p>
        {puedeEscribir ? (
          <>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => onAprobar(borrador.id)} disabled={busy}>
                <Check className="w-4 h-4" strokeWidth={1.75} />
                {busy ? "Aprobando…" : "Aprobar y enviar"}
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={() => setRechazando(true)} disabled={busy}>
                <X className="w-4 h-4" strokeWidth={1.75} />
                Rechazar
              </Button>
            </div>

            {/* Paso 2 del rechazo: el motivo sigue siendo obligatorio y la llamada al
                servidor solo sale de "Confirmar rechazo", igual que antes. */}
            <AlertDialog
              open={rechazando}
              onOpenChange={(abierto) => {
                if (!abierto) {
                  setRechazando(false);
                  setMotivo("");
                  setMotivoError(null);
                }
              }}
            >
              <AlertDialogContent className="max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle>Rechazar este borrador</AlertDialogTitle>
                  <AlertDialogDescription>El motivo queda registrado en el historial de la conversación y es obligatorio.</AlertDialogDescription>
                </AlertDialogHeader>
                <Label className={LABEL_CLASES}>
                  Motivo del rechazo
                  <textarea
                    value={motivo}
                    onChange={(e) => {
                      setMotivo(e.target.value);
                      setMotivoError(null);
                    }}
                    rows={3}
                    className={TEXTAREA_CLASES}
                    placeholder="Por qué se rechaza este borrador"
                  />
                </Label>
                {motivoError && (
                  <p role="alert" className="m-0 text-xs text-destructive">
                    {motivoError}
                  </p>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel
                    onClick={() => {
                      setRechazando(false);
                      setMotivo("");
                      setMotivoError(null);
                    }}
                    disabled={busy}
                  >
                    Cancelar
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    // preventDefault: `confirmarRechazo` puede rechazar el intento (motivo
                    // vacío -> `setMotivoError`, sin cerrar) -- el cierre solo lo decide
                    // `onRechazar`/el estado `rechazando`, nunca el clic en sí.
                    onClick={(e) => {
                      e.preventDefault();
                      confirmarRechazo();
                    }}
                    disabled={busy}
                  >
                    {busy ? "Rechazando…" : "Confirmar rechazo"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">
            Tu rol no puede aprobar ni rechazar mensajería. Contacta a un admin_gestora u operador con acceso a calendario/mensajería. (Conversación: {item.conversacion.id})
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface SimuladorMensajeEntranteProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly puedeEscribir: boolean;
  /** Se llama tras registrar el mensaje Y generar el borrador con éxito -- el padre
   * recarga la bandeja (`fetchBandejaAprobacion`) para que el borrador recién nacido
   * en `pendiente_aprobacion` aparezca de inmediato. */
  readonly onGenerado: () => void;
}

/** Cierra el tramo que faltaba antes de esta fase: no existía ningún cliente web para
 * abrir una conversación (`POST .../conversaciones`), registrar el mensaje entrante de
 * un huésped (`POST .../mensajes`) ni pedirle al agente que redacte un borrador
 * (`POST .../borradores`) -- sin esto, la bandeja de arriba SIEMPRE estaba vacía en
 * producción. Es, honestamente, un registro MANUAL: no hay adaptador real de
 * WhatsApp/Airbnb/Vrbo conectado (mismo aviso que ya usa esta página para
 * `SimuladorCanalMensajeria` al aprobar). Las 3 llamadas (crear conversación si hace
 * falta, registrar mensaje, generar borrador) se disparan en una sola acción de staff
 * -- un mensaje sin pedir borrador no tiene ningún efecto visible en la bandeja de
 * aprobación, así que separarlas en dos botones no le compra nada al operador. */
function SimuladorMensajeEntrante({ apiBaseUrl, token, propertyId, puedeEscribir, onGenerado }: SimuladorMensajeEntranteProps) {
  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [unidadId, setUnidadId] = useState<string>("");
  const [conversaciones, setConversaciones] = useState<readonly ConversacionRecord[] | null>(null);
  const [conversacionId, setConversacionId] = useState<string>(NUEVA_CONVERSACION);
  const [canal, setCanal] = useState<CanalMensajeriaCodigo>(CANALES_MENSAJERIA[0]);
  const [propiedadNombre, setPropiedadNombre] = useState("");
  const [texto, setTexto] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!puedeEscribir) return;
    let cancelado = false;
    (async () => {
      try {
        const list = await fetchUnidades(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setUnidades(list);
        setUnidadId((current) => current || list[0]?.id || "");
      } catch (err) {
        if (!cancelado) setFormError(err instanceof Error ? err.message : "No se pudieron cargar las unidades de esta propiedad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puedeEscribir]);

  const cargarConversaciones = useCallback(
    async (uid: string) => {
      if (!uid) {
        setConversaciones([]);
        return;
      }
      try {
        const list = await fetchConversaciones(fetch, apiBaseUrl, token, propertyId, uid);
        setConversaciones(list);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "No se pudieron cargar las conversaciones de esta unidad.");
      }
    },
    [apiBaseUrl, token, propertyId],
  );

  useEffect(() => {
    setConversacionId(NUEVA_CONVERSACION);
    const unidad = unidades?.find((u) => u.id === unidadId);
    setPropiedadNombre(unidad?.nombre ?? "");
    void cargarConversaciones(unidadId);
  }, [unidadId, unidades, cargarConversaciones]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!unidadId) {
      setFormError("Selecciona una unidad.");
      return;
    }
    if (!texto.trim()) {
      setFormError("El mensaje del huésped no puede estar vacío.");
      return;
    }
    if (conversacionId === NUEVA_CONVERSACION && !propiedadNombre.trim()) {
      setFormError("propiedadNombre es requerido para abrir una conversación nueva.");
      return;
    }

    setBusy(true);
    try {
      let targetConversacionId = conversacionId;
      if (conversacionId === NUEVA_CONVERSACION) {
        const conversacion = await crearConversacion(fetch, apiBaseUrl, token, propertyId, unidadId, {
          canal,
          propiedadNombre: propiedadNombre.trim(),
        });
        targetConversacionId = conversacion.id;
      }

      const mensaje = await registrarMensajeEntrante(fetch, apiBaseUrl, token, propertyId, unidadId, targetConversacionId, texto.trim());
      await generarBorrador(fetch, apiBaseUrl, token, propertyId, targetConversacionId, { mensajeEntranteId: mensaje.id });

      setTexto("");
      await cargarConversaciones(unidadId);
      setConversacionId(targetConversacionId);
      onGenerado();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo registrar el mensaje y generar el borrador.");
    } finally {
      setBusy(false);
    }
  }

  if (!puedeEscribir) {
    return (
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-[15px] font-semibold">Simular mensaje entrante de huésped</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <p className="m-0 text-xs text-muted-foreground">
            Tu rol no puede registrar mensajes ni pedir borradores. Contacta a un admin_gestora u operador con acceso a calendario/mensajería.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-[15px] font-semibold">Simular mensaje entrante de huésped</CardTitle>
        <CardDescription className="text-xs">
          Registro <strong>manual</strong>: no hay adaptador real de WhatsApp, Airbnb ni Vrbo conectado todavía. Usa esto para transcribir un mensaje que el huésped mandó por fuera
          de este panel y pedirle al agente un borrador de respuesta.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
          <Label className={LABEL_CLASES}>
            Unidad
            <select value={unidadId} onChange={(e) => setUnidadId(e.target.value)} className={SELECT_CLASES} disabled={!unidades}>
              {!unidades && <option value="">Cargando…</option>}
              {unidades?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nombre}
                </option>
              ))}
            </select>
          </Label>

          <Label className={LABEL_CLASES}>
            Conversación
            <select value={conversacionId} onChange={(e) => setConversacionId(e.target.value)} className={SELECT_CLASES} disabled={!conversaciones}>
              <option value={NUEVA_CONVERSACION}>+ Nueva conversación</option>
              {conversaciones?.map((c) => (
                <option key={c.id} value={c.id}>
                  {CANAL_LABELS[c.canal]} · {c.huespedNombre ?? "sin nombre de huésped"} ({c.id})
                </option>
              ))}
            </select>
          </Label>

          {conversacionId === NUEVA_CONVERSACION && (
            <>
              <Label className={LABEL_CLASES}>
                Canal
                <select value={canal} onChange={(e) => setCanal(e.target.value as CanalMensajeriaCodigo)} className={SELECT_CLASES}>
                  {CANALES_MENSAJERIA.map((c) => (
                    <option key={c} value={c}>
                      {CANAL_LABELS[c]}
                    </option>
                  ))}
                </select>
              </Label>
              <Label className={LABEL_CLASES}>
                Nombre de la propiedad (para las plantillas del borrador)
                <Input type="text" value={propiedadNombre} onChange={(e) => setPropiedadNombre(e.target.value)} maxLength={200} />
              </Label>
            </>
          )}

          <Label className={LABEL_CLASES}>
            Mensaje del huésped
            <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} className={TEXTAREA_CLASES} placeholder="Ej. ¿Cuál es la clave del wifi?" />
          </Label>

          {formError && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {formError}
            </p>
          )}

          <div>
            <Button type="submit" size="sm" disabled={busy || !unidadId}>
              <MessageSquarePlus className="w-4 h-4" strokeWidth={1.75} />
              {busy ? "Registrando…" : "Registrar mensaje y generar borrador"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function AprobacionesPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeEscribir = org ? MENSAJERIA_ESCRITURA_ROLES.has(org.rol) : false;

  const [items, setItems] = useState<readonly ItemBandeja[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandidoHistorial, setExpandidoHistorial] = useState<Record<string, boolean>>({});

  const cargar = useCallback(async () => {
    setError(null);
    try {
      const bandeja = await fetchBandejaAprobacion(fetch, apiBaseUrl, token, propertyId);
      setItems(bandeja);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la bandeja de aprobación.");
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    setItems(null);
    void cargar();
  }, [cargar]);

  async function handleAprobar(borradorId: string) {
    setBusyId(borradorId);
    setError(null);
    try {
      await aprobarBorrador(fetch, apiBaseUrl, token, propertyId, borradorId);
      setNotice("Borrador aprobado y enviado (canal simulado, ver nota abajo).");
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo aprobar el borrador.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRechazar(borradorId: string, motivo: string) {
    setBusyId(borradorId);
    setError(null);
    try {
      await rechazarBorrador(fetch, apiBaseUrl, token, propertyId, borradorId, motivo);
      setNotice("Borrador rechazado.");
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo rechazar el borrador.");
    } finally {
      setBusyId(null);
    }
  }

  const totalPendientes = items?.reduce((acc, item) => acc + item.pendientes.length, 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Bandeja de aprobación de mensajería</h1>
        <p className="mt-1 mb-0 text-[13px] text-muted-foreground">
          Todo borrador generado para un huésped queda en <strong className="text-foreground">pendiente_aprobacion</strong> hasta que alguien lo aprueba o lo rechaza aquí — ningún
          proceso automático puede enviarlo (ver POST .../intento-automatico, que siempre es rechazado).
        </p>
      </header>

      <p className="m-0 rounded-lg border border-dashed border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
        Nota honesta: aprobar un borrador aquí lo envía a través de un <strong className="text-foreground">simulador de canal</strong> (SimuladorCanalMensajeria) — todavía no hay un
        adaptador real de WhatsApp, Airbnb ni Vrbo conectado en este vertical. El mensaje queda registrado como enviado en este panel, pero el huésped real no lo recibe.
      </p>

      <SimuladorMensajeEntrante
        apiBaseUrl={apiBaseUrl}
        token={token}
        propertyId={propertyId}
        puedeEscribir={puedeEscribir}
        onGenerado={() => {
          setNotice("Mensaje entrante registrado y borrador generado — revísalo abajo en la bandeja de aprobación.");
          void cargar();
        }}
      />

      {notice && <p className="m-0 rounded-lg border border-border bg-muted px-3 py-2 text-[13px] text-foreground">{notice}</p>}
      {error && <EstadoError mensaje={error} />}
      {!items && !error && <EstadoCargando lineas={2} />}
      {items && items.length === 0 && (
        <EstadoVacio icon={Inbox} titulo="Sin conversaciones" mensaje="No hay ninguna conversación con mensajería en esta propiedad todavía." />
      )}
      {items && items.length > 0 && (
        <p className={totalPendientes > 0 ? "m-0 text-[13px] font-medium text-foreground" : "m-0 text-[13px] text-muted-foreground"}>
          {totalPendientes > 0 ? `${totalPendientes} borrador(es) esperando aprobación.` : "No hay ningún borrador pendiente de aprobación en este momento."}
        </p>
      )}

      <div className="flex flex-col gap-3">
        {items?.map((item) => (
          <Card key={item.conversacion.id}>
            <CardContent className="p-4 flex flex-col gap-2.5">
              <div className="flex justify-between flex-wrap gap-2">
                <p className="m-0 text-sm font-semibold text-foreground">{contextoLinea(item)}</p>
                {item.pendientes.length === 0 && <Badge variant="outline">Sin pendientes</Badge>}
              </div>

              {item.pendientes.map((borrador) => (
                <BorradorPendienteCard
                  key={borrador.id}
                  item={item}
                  borrador={borrador}
                  puedeEscribir={puedeEscribir}
                  busy={busyId === borrador.id}
                  onAprobar={handleAprobar}
                  onRechazar={handleRechazar}
                />
              ))}

              {item.historial.length > 0 && (
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-xs"
                    onClick={() => setExpandidoHistorial((prev) => ({ ...prev, [item.conversacion.id]: !prev[item.conversacion.id] }))}
                  >
                    {expandidoHistorial[item.conversacion.id] ? "Ocultar historial" : `Ver historial (${item.historial.length})`}
                  </Button>
                  {expandidoHistorial[item.conversacion.id] && (
                    <div className="flex flex-col gap-1.5 mt-2">
                      {item.historial.map((b) => {
                        const badge = historialBadge(b);
                        return (
                          <Card key={b.id}>
                            <CardContent className="p-2.5">
                              <div className="flex justify-between gap-2 flex-wrap">
                                <span className="text-[11px] text-muted-foreground">{new Date(b.creadoEn).toLocaleString("es-MX")}</span>
                                <Badge variant={badge.variante}>{badge.label}</Badge>
                              </div>
                              <p className="mt-1 mb-0 text-[13px] text-foreground whitespace-pre-wrap">{b.texto}</p>
                              {b.estado === "rechazado" && b.motivoRechazo && <p className="mt-1 mb-0 text-xs text-destructive">Motivo: {b.motivoRechazo}</p>}
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
