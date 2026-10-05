// C-11 -- Conversaciones: bandeja de WhatsApp de citas con handoff a humano. Una persona TOMA la conversacion (el agente deja de responder),
// responde (la respuesta se ENCOLA en el outbox de WhatsApp; este panel nunca habla con Meta), deja notas internas, la devuelve al agente o la
// cierra. Consume apps/api/.../citas/conversaciones.ts. Estados honestos: cargando, error, `disponible: false` (la migracion 031 aun no esta
// aplicada: NUNCA se confunde con una bandeja vacia) y datos. Los botones se muestran segun el estado y el rol que declara el servidor
// (cosmetico: el servidor y la base son la unica barrera real, 403/409). El telefono llega enmascarado.
// Las respuestas humanas fuera de la ventana de 24 h de WhatsApp requieren una plantilla aprobada (PL-31): la pantalla lo avisa.
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, RefreshCw } from "lucide-react";
import { Button, Card, DataTable, EstadoCargando, EstadoError, EstadoVacio, FormDialog, Input, Label, NativeSelect, PageContainer, StatusBadge, Textarea, useConfirm, useTituloBarra } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { formatoRelativo } from "../../../lib/notificaciones-presentacion.ts";
import { ESTADOS_FILTRO, ESTADO_ROTULO, NOTA_MAX, RESPUESTA_MAX, agregarNota, fetchBandeja, fetchDetalle, liberarHandoff, responderConversacion, tomarConversacion } from "../lib/conversaciones-client.ts";
import type { BandejaItemWire, BandejaWire, DetalleWire, HandoffEstado } from "../lib/conversaciones-client.ts";
import { formatDateTime } from "../lib/format.ts";
import { HANDOFF_ESTADO_TONES } from "../lib/status-tones.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

/** Sondeo de la bandeja (los mensajes llegan por el webhook): sin esto la persona tendria que recargar a mano. */
const REFRESCO_MS = 30_000;
const CITA_ESTADO_ROTULO: Readonly<Record<string, string>> = { pending: "Pendiente", confirmed: "Confirmada", completed: "Completada", cancelled: "Cancelada", no_show: "No asistió" };

function mensajeDe(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

type Accion = "tomar" | "devolver" | "cerrar";

export function ConversacionesPage({ apiBaseUrl, token, propertyId }: CitasShellContext) {
  useTituloBarra("Conversaciones", MessageSquare);
  const [estado, setEstado] = useState<HandoffEstado | "">("");
  const [data, setData] = useState<BandejaWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reintento, setReintento] = useState(0);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const recargar = useCallback(() => setReintento((n) => n + 1), []);

  // Al cambiar el filtro se muestra el esqueleto; al RECARGAR (sondeo o tras una accion) se conserva la lista para no desmontar el hilo abierto
  // (perderia el texto en curso).
  const ultimoFiltro = useRef(estado);
  useEffect(() => {
    let cancelado = false;
    if (ultimoFiltro.current !== estado) {
      ultimoFiltro.current = estado;
      setData(null);
    }
    setError(null);
    (async () => {
      try {
        const b = await fetchBandeja(fetch, apiBaseUrl, token, propertyId, { estado });
        if (!cancelado) setData(b);
      } catch (err) {
        if (!cancelado) setError(mensajeDe(err, "No se pudo cargar la bandeja."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, estado, reintento]);

  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") recargar();
    }, REFRESCO_MS);
    return () => clearInterval(t);
  }, [recargar]);

  const columnas: readonly DataTableColumna<BandejaItemWire>[] = [
    {
      id: "cliente",
      encabezado: "Cliente",
      principal: true,
      celda: (i) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="text-ui font-medium text-foreground">{i.telefono}</span>
          {i.crisis && <StatusBadge tone="danger">Crisis</StatusBadge>}
        </span>
      ),
    },
    { id: "mensaje", encabezado: "Último mensaje", celda: (i) => <span className="block max-w-[28ch] truncate text-muted-foreground">{i.vistaPrevia || "Sin mensajes"}</span> },
    { id: "estado", encabezado: "Estado", celda: (i) => <StatusBadge tone={HANDOFF_ESTADO_TONES[i.estado] ?? "neutral"}>{ESTADO_ROTULO[i.estado]}</StatusBadge>, valorOrden: (i) => i.estado },
    { id: "atiende", encabezado: "Atiende", celda: (i) => <span className="text-muted-foreground">{i.estado === "tomada" ? (i.esMia ? "Tú" : (i.tomadaPorNombre ?? "Otra persona")) : "—"}</span> },
    {
      id: "cita",
      encabezado: "Cita",
      celda: (i) => (i.cita ? <span className="text-muted-foreground">{[i.cita.iniciaEn ? formatDateTime(i.cita.iniciaEn) : null, i.cita.estado ? (CITA_ESTADO_ROTULO[i.cita.estado] ?? i.cita.estado) : null].filter(Boolean).join(" · ")}</span> : <span className="text-faint">—</span>),
    },
    { id: "actividad", encabezado: "Actividad", celda: (i) => <span className="text-muted-foreground">{formatoRelativo(i.actividadEn)}</span>, valorOrden: (i) => new Date(i.actividadEn) },
  ];

  const porAtender = data?.disponible ? data.items.filter((i) => i.estado === "pendiente" || i.crisis).length : 0;

  return (
    <PageContainer>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect aria-label="Estado" value={estado} onChange={(e) => setEstado(e.target.value as HandoffEstado | "")} wrapperClassName="w-auto min-w-48">
          <option value="">Todas las conversaciones</option>
          {ESTADOS_FILTRO.map((e) => (
            <option key={e} value={e}>
              {ESTADO_ROTULO[e]}
            </option>
          ))}
        </NativeSelect>
        <Button type="button" variant="outline" size="xs" onClick={recargar} aria-label="Actualizar">
          <RefreshCw className="size-[13px]" strokeWidth={1.75} />
        </Button>
        {data?.disponible && (
          <span className="text-eyebrow text-faint">
            {porAtender} por atender · {data.total} en total
          </span>
        )}
      </div>
      <p className="text-eyebrow text-faint">Toma una conversación para atenderla tú: mientras la tengas, el agente no responde y solo guarda lo que escriba el cliente.</p>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={recargar} compacto />}
      {!error && data === null && <EstadoCargando variante="tarjeta" etiqueta="Cargando conversaciones…" />}
      {data && !data.disponible && (
        <EstadoVacio
          icon={MessageSquare}
          titulo="Conversaciones no disponibles aún"
          mensaje="La bandeja con atención humana se activa cuando se aplique la actualización pendiente de la base de datos. Mientras tanto el agente sigue respondiendo con normalidad."
        />
      )}
      {/* El grid y el hilo NO se desmontan cuando falla un refresco (boton Actualizar o el sondeo de 30 s): el error se muestra arriba y lo que el humano
          escribia (nota o respuesta, justo en los handoffs de crisis) sigue ahi. */}
      {data?.disponible && (
        <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <DataTable
            etiqueta="Conversaciones de WhatsApp"
            columnas={columnas}
            filas={data.items}
            obtenerId={(i) => i.conversationId}
            onFilaClick={(i) => setSeleccion(i.conversationId)}
            atributosFila={(i) => ({ "data-conversation-id": i.conversationId })}
            vacio={{ titulo: "Sin conversaciones", mensaje: "No hay conversaciones con este filtro. Aparecen aquí cuando un cliente escribe al WhatsApp del negocio." }}
            paginacion={{ tamano: 15 }}
          />
          {seleccion ? (
            <HiloConversacion key={seleccion} id={seleccion} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} onCambio={recargar} />
          ) : (
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Elige una conversación para verla.</p>
            </Card>
          )}
        </div>
      )}
    </PageContainer>
  );
}

interface HiloProps {
  readonly id: string;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly onCambio: () => void;
}

function HiloConversacion({ id, apiBaseUrl, token, propertyId, onCambio }: HiloProps) {
  const [d, setD] = useState<DetalleWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [accion, setAccion] = useState<Accion | null>(null);
  const [version, setVersion] = useState(0);
  const [respondiendo, setRespondiendo] = useState(false);
  const [respuesta, setRespuesta] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [nota, setNota] = useState("");
  const [guardandoNota, setGuardandoNota] = useState(false);
  const { confirmar, dialogo } = useConfirm();

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const r = await fetchDetalle(fetch, apiBaseUrl, token, propertyId, id);
        if (cancelado) return;
        setD(r);
        setError(null);
      } catch (err) {
        if (!cancelado) setError(mensajeDe(err, "No se pudo cargar la conversación."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, id, version]);

  async function ejecutar(nombre: Accion, hacer: () => Promise<unknown>, ok: string) {
    setAccion(nombre);
    setAviso(null);
    try {
      await hacer();
      setAviso({ tipo: "ok", texto: ok });
    } catch (err) {
      setAviso({ tipo: "error", texto: mensajeDe(err, "No se pudo completar la acción.") });
    } finally {
      setAccion(null);
      setVersion((n) => n + 1);
      onCambio();
    }
  }

  async function cerrar(handoffId: string) {
    const si = await confirmar({
      titulo: "Cerrar la conversación",
      descripcion: "La conversación queda resuelta y el agente vuelve a atender al cliente si escribe de nuevo.",
      tono: "danger",
      confirmar: "Cerrar conversación",
      cancelar: "Cancelar",
    });
    if (!si) return;
    await ejecutar("cerrar", () => liberarHandoff(fetch, apiBaseUrl, token, propertyId, handoffId, "cerrar"), "Conversación cerrada.");
  }

  async function enviar(handoffId: string) {
    const texto = respuesta.trim();
    if (!texto) return;
    setEnviando(true);
    setAviso(null);
    try {
      await responderConversacion(fetch, apiBaseUrl, token, propertyId, handoffId, texto);
      setRespuesta("");
      setRespondiendo(false);
      setAviso({ tipo: "ok", texto: "Respuesta en cola: sale por WhatsApp en cuanto el despachador la envíe." });
      setVersion((n) => n + 1);
      onCambio();
    } catch (err) {
      setAviso({ tipo: "error", texto: mensajeDe(err, "No se pudo enviar la respuesta.") });
    } finally {
      setEnviando(false);
    }
  }

  async function guardarNota(handoffId: string) {
    const texto = nota.trim();
    if (!texto) return;
    setGuardandoNota(true);
    setAviso(null);
    try {
      await agregarNota(fetch, apiBaseUrl, token, propertyId, handoffId, texto);
      setNota("");
      setAviso({ tipo: "ok", texto: "Nota guardada." });
      setVersion((n) => n + 1);
    } catch (err) {
      setAviso({ tipo: "error", texto: mensajeDe(err, "No se pudo guardar la nota.") });
    } finally {
      setGuardandoNota(false);
    }
  }

  if (error) return <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => setVersion((n) => n + 1)} compacto />;
  if (!d) return <EstadoCargando variante="tarjeta" etiqueta="Cargando conversación…" />;

  const h = d.handoff;
  const abierta = h !== null && (h.estado === "pendiente" || h.estado === "tomada");
  const tomadaPorOtra = h?.estado === "tomada" && !h.esMia;
  const puedeTomar = !tomadaPorOtra && !(h?.estado === "tomada" && h.esMia);
  const puedeLiberar = abierta && (h.esMia || d.puedeGestionar || h.estado === "pendiente");

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-ui font-medium text-foreground">
          {d.telefono}
          {h?.crisis && <StatusBadge tone="danger">Crisis</StatusBadge>}
          <StatusBadge tone={HANDOFF_ESTADO_TONES[h?.estado ?? "agente"] ?? "neutral"}>{ESTADO_ROTULO[h?.estado ?? "agente"]}</StatusBadge>
        </p>
      </div>

      <div className="mt-2.5 space-y-2.5">
        {aviso && (
          <p role={aviso.tipo === "error" ? "alert" : "status"} className={aviso.tipo === "error" ? "text-xs text-destructive" : "text-xs text-foreground"}>
            {aviso.texto}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {puedeTomar && (
            <Button size="xs" loading={accion === "tomar"} disabled={accion !== null} onClick={() => void ejecutar("tomar", () => tomarConversacion(fetch, apiBaseUrl, token, propertyId, id), "La conversación es tuya: el agente ya no responde.")}>
              Tomar conversación
            </Button>
          )}
          {puedeLiberar && h && (
            <Button variant="outline" size="xs" loading={accion === "devolver"} disabled={accion !== null} onClick={() => void ejecutar("devolver", () => liberarHandoff(fetch, apiBaseUrl, token, propertyId, h.handoffId, "devolver"), "Devuelta al agente: vuelve a responder.")}>
              Devolver al agente
            </Button>
          )}
          {puedeLiberar && h && (
            <Button variant="outline" size="xs" loading={accion === "cerrar"} disabled={accion !== null} onClick={() => void cerrar(h.handoffId)}>
              Cerrar conversación
            </Button>
          )}
          {h?.estado === "tomada" && h.esMia && (
            <Button variant="outline" size="xs" onClick={() => setRespondiendo(true)}>
              Responder
            </Button>
          )}
        </div>

        {h?.estado === "tomada" && h.tomadaPorNombre && !h.esMia && <p className="text-xs text-muted-foreground">La tiene {h.tomadaPorNombre}{h.tomadaEn ? ` desde ${formatDateTime(h.tomadaEn)}` : ""}. Solo ella puede responder.</p>}
        {h?.estado === "pendiente" && <p className="text-xs text-muted-foreground">Nadie la ha tomado. {h.motivo ?? ""} El agente no responde mientras espera a una persona.</p>}

        <section aria-label="Mensajes" className="flex max-h-[360px] flex-col gap-2 overflow-auto rounded-lg border border-border bg-background p-3">
          {d.mensajes.length === 0 && <p className="text-xs text-muted-foreground">Sin mensajes.</p>}
          {d.mensajes.map((m, i) => (
            <div key={i} className={`flex flex-col gap-0.5 ${m.rol === "cliente" ? "items-start" : "items-end"}`}>
              <p className="text-eyebrow text-faint">{m.rol === "cliente" ? "Cliente" : m.rol === "humano" ? "Personal" : "Agente"}</p>
              <p className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-ui text-foreground ${m.rol === "cliente" ? "bg-muted" : "bg-primary/10"}`}>{m.texto}</p>
            </div>
          ))}
        </section>

        {h?.estado === "tomada" && h.esMia && <p className="text-eyebrow text-faint">Las respuestas fuera de la ventana de 24 h de WhatsApp requieren una plantilla aprobada y pueden no entregarse.</p>}

        <section aria-label="Notas internas" className="space-y-2">
          <p className="text-ui font-medium text-foreground">Notas internas</p>
          {d.notas.length === 0 && <p className="text-xs text-muted-foreground">Sin notas.</p>}
          {d.notas.map((n) => (
            <p key={n.id} className="text-xs text-foreground">
              <span className="text-muted-foreground">
                {formatDateTime(n.creadoEn)} · {n.autor ?? "Personal"}:
              </span>{" "}
              {n.texto}
            </p>
          ))}
          {h ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void guardarNota(h.handoffId);
              }}
            >
              <Input aria-label="Nueva nota" value={nota} maxLength={NOTA_MAX} onChange={(e) => setNota(e.target.value)} className="flex-1" />
              <Button type="submit" variant="outline" size="xs" loading={guardandoNota} disabled={!nota.trim()}>
                Agregar
              </Button>
            </form>
          ) : (
            <p className="text-xs text-muted-foreground">Toma la conversación para dejar notas internas.</p>
          )}
        </section>
      </div>

      {h && (
        <FormDialog
          open={respondiendo}
          onOpenChange={setRespondiendo}
          titulo="Responder por WhatsApp"
          subtitulo={`Se enviará a ${d.telefono} desde el número del negocio.`}
          onGuardar={() => void enviar(h.handoffId)}
          guardando={enviando}
          textoBotonGuardar="Enviar respuesta"
          guardarDeshabilitado={!respuesta.trim()}
          anchoClase="max-w-xl"
          bloquearCierre={enviando}
        >
          <div className="space-y-1.5">
            <Label htmlFor="respuesta-humana">Mensaje</Label>
            <Textarea id="respuesta-humana" value={respuesta} maxLength={RESPUESTA_MAX} onChange={(e) => setRespuesta(e.target.value)} rows={5} />
            <p className="text-eyebrow text-faint">{respuesta.length} / {RESPUESTA_MAX}</p>
          </div>
        </FormDialog>
      )}
      {dialogo}
    </Card>
  );
}
