// Conversaciones (H-20) -- bandeja de WhatsApp del hotel con handoff a humano. Lista + hilo: una persona TOMA la conversacion (el agente
// deja de responder), responde (la respuesta se encola en messaging_outbox; sin credenciales de Meta queda "Pendiente de envio" y la
// pantalla lo dice), deja notas internas, la devuelve al agente o la cierra. Consume apps/api/.../hoteles/conversaciones.ts.
// Estados honestos: cargando, error, `disponible: false` (la migracion 043 aun no esta aplicada: NUNCA se confunde con una bandeja
// vacia) y datos. Los botones se muestran segun el rol y el estado (cosmetico: el servidor es la unica barrera real, 403/409).
// El telefono y el texto llegan ya minimizados segun el rol (owner/gm lo ven completo; recepcion/reservas, enmascarado).
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MessageSquare, RefreshCw, UserRound } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, NativeSelect, PageContainer, PageHeader, StatusBadge, Textarea } from "@atiende/ui";
import {
  CONVERSACIONES_REASIGNAR_ROLES,
  CONVERSACIONES_ROLES,
  ENVIO_LABELS,
  ESTADO_FILTRO_LABELS,
  agregarNota,
  cerrarConversacion,
  devolverAlAgente,
  etiquetaEstado,
  fetchBandeja,
  fetchDetalle,
  marcarLeida,
  responderConversacion,
  textoTieneDatoSensible,
  tomarConversacion,
  tonoEstado,
} from "../lib/conversaciones-client.ts";
import type { BandejaWire, ConversacionFiltroEstado, ConversacionItemWire, DetalleWire } from "../lib/conversaciones-client.ts";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

/** Sondeo de la bandeja (los mensajes llegan por el webhook): sin esto la persona tendria que recargar a mano. */
const REFRESCO_MS = 30_000;

function hora(iso: string | null): string {
  if (!iso) return "";
  try {
    return fechaHoraEsMx(iso);
  } catch {
    return iso;
  }
}

function mensajeDe(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function ConversacionesPage({ apiBaseUrl, token, propertyId, orgSlug, role }: HotelesShellContext) {
  const [params, setParams] = useSearchParams();
  const huespedId = params.get("huesped") ?? undefined;
  const [estado, setEstado] = useState<ConversacionFiltroEstado | "">("");
  const [soloNoLeidas, setSoloNoLeidas] = useState(false);
  const [data, setData] = useState<BandejaWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reintento, setReintento] = useState(0);
  const [seleccion, setSeleccion] = useState<string | null>(params.get("id"));
  const puedeVer = CONVERSACIONES_ROLES.has(role);

  const recargar = useCallback(() => setReintento((n) => n + 1), []);

  // Al cambiar un filtro se muestra el esqueleto; al RECARGAR (sondeo o tras una accion) se conserva la lista para no
  // desmontar el hilo abierto (perderia el texto en curso).
  const filtroActual = `${estado}|${soloNoLeidas}|${huespedId ?? ""}|${propertyId}`;
  const ultimoFiltro = useRef(filtroActual);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelado = false;
    if (ultimoFiltro.current !== filtroActual) {
      ultimoFiltro.current = filtroActual;
      setData(null);
    }
    setError(null);
    (async () => {
      try {
        const b = await fetchBandeja(fetch, apiBaseUrl, token, propertyId, { estado, soloNoLeidas, ...(huespedId ? { huespedId } : {}) });
        if (!cancelado) setData(b);
      } catch (err) {
        if (!cancelado) setError(mensajeDe(err, "No se pudo cargar la bandeja."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, estado, soloNoLeidas, huespedId, reintento, filtroActual, puedeVer]);

  useEffect(() => {
    if (!puedeVer) return;
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") recargar();
    }, REFRESCO_MS);
    return () => clearInterval(t);
  }, [puedeVer, recargar]);

  function limpiarHuesped() {
    const p = new URLSearchParams(params);
    p.delete("huesped");
    setParams(p, { replace: true });
  }

  if (!puedeVer) {
    return (
      <PageContainer padding="none" className="gap-4">
        <PageHeader titulo="Conversaciones" />
        <EstadoVacio icon={MessageSquare} titulo="Sin acceso" mensaje="Tu rol no tiene acceso a las conversaciones de WhatsApp del hotel." />
      </PageContainer>
    );
  }

  const porAtender = data?.disponible ? data.items.filter((i) => i.porAtender).length : 0;

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader
        titulo="Conversaciones"
        descripcion="WhatsApp del hotel. Toma una conversación para atenderla tú: mientras la tengas, el agente no responde."
        acciones={
          <Button type="button" variant="outline" onClick={recargar} aria-label="Actualizar">
            <RefreshCw className="size-4" strokeWidth={1.75} />
          </Button>
        }
        meta={data?.disponible ? <span className="text-xs text-muted-foreground">{porAtender} por atender · {data.total} en total</span> : undefined}
      />

      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Estado" className="min-w-48">
          <NativeSelect value={estado} onChange={(e) => setEstado(e.target.value as ConversacionFiltroEstado | "")}>
            <option value="">Todas las conversaciones</option>
            {(Object.keys(ESTADO_FILTRO_LABELS) as ConversacionFiltroEstado[]).map((e) => (
              <option key={e} value={e}>
                {ESTADO_FILTRO_LABELS[e]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <Checkbox label="Solo no leídas" checked={soloNoLeidas} onChange={(e) => setSoloNoLeidas(e.target.checked)} />
        {huespedId && (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            Filtrando por un huésped
            <Button type="button" size="sm" variant="outline" onClick={limpiarHuesped}>
              Quitar filtro
            </Button>
          </span>
        )}
      </div>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={recargar} />}
      {!error && data === null && <EstadoCargando etiqueta="Cargando conversaciones…" />}
      {!error && data && !data.disponible && (
        <EstadoVacio
          icon={MessageSquare}
          titulo="Conversaciones no disponibles aún"
          mensaje="La bandeja con atención humana se activa cuando se aplique la actualización pendiente de la base de datos. Mientras tanto el agente sigue respondiendo con normalidad."
        />
      )}
      {!error && data?.disponible && data.sinTelefono && <EstadoVacio icon={MessageSquare} titulo="Este huésped no tiene teléfono" mensaje="Sin teléfono registrado no se puede enlazar con una conversación de WhatsApp." />}
      {!error && data?.disponible && !data.sinTelefono && data.items.length === 0 && <EstadoVacio icon={MessageSquare} titulo="Sin conversaciones" mensaje="No hay conversaciones con estos filtros. Aparecen aquí cuando un huésped escribe al WhatsApp del hotel." />}

      {!error && data?.disponible && data.items.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <ul className="m-0 p-0 list-none flex flex-col gap-2" aria-label="Conversaciones">
            {data.items.map((i) => (
              <FilaConversacion key={i.id} item={i} activa={seleccion === i.id} onElegir={() => setSeleccion(i.id)} />
            ))}
          </ul>
          {seleccion ? (
            <HiloConversacion key={seleccion} id={seleccion} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} role={role} onCambio={recargar} />
          ) : (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">Elige una conversación para verla.</CardContent>
            </Card>
          )}
        </div>
      )}
    </PageContainer>
  );
}

function FilaConversacion({ item, activa, onElegir }: { item: ConversacionItemWire; activa: boolean; onElegir: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onElegir}
        aria-current={activa ? "true" : undefined}
        className={`w-full text-left rounded-lg border p-3 bg-card transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${activa ? "border-primary" : "border-border"}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-ui font-medium text-foreground truncate inline-flex items-center gap-1.5">
            {item.noLeidos > 0 && <span role="img" aria-label={`${item.noLeidos} sin leer`} className="size-2 rounded-full bg-destructive shrink-0" />}
            {item.huesped?.nombre ?? item.telefono}
          </span>
          <StatusBadge tone={tonoEstado(item)}>{etiquetaEstado(item)}</StatusBadge>
        </div>
        {item.huesped?.nombre && <p className="m-0 mt-0.5 text-xs text-muted-foreground">{item.telefono}</p>}
        <p className="m-0 mt-1 text-xs text-muted-foreground truncate">{item.vistaPrevia || "Sin mensajes"}</p>
        <p className="m-0 mt-1 text-xs text-muted-foreground">
          {hora(item.actividadEn)}
          {item.responsable ? ` · la tiene ${item.responsable.nombre ?? "otra persona"}` : ""}
          {item.motivoTexto && item.estado === "humano" ? ` · ${item.motivoTexto}` : ""}
        </p>
      </button>
    </li>
  );
}

interface HiloProps {
  readonly id: string;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  readonly role: string;
  readonly onCambio: () => void;
}

function HiloConversacion({ id, apiBaseUrl, token, propertyId, orgSlug, role, onCambio }: HiloProps) {
  const [d, setD] = useState<DetalleWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [respuesta, setRespuesta] = useState("");
  const [nota, setNota] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [version, setVersion] = useState(0);
  const leida = useRef(false);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const r = await fetchDetalle(fetch, apiBaseUrl, token, propertyId, id);
        if (cancelado) return;
        setD(r);
        setError(null);
        // Abrir el hilo = leerlo: apaga el punto rojo de la lista (una sola vez por apertura y por mensaje nuevo).
        if (r.noLeidos > 0 && !leida.current) {
          leida.current = true;
          void marcarLeida(fetch, apiBaseUrl, token, propertyId, id).then(onCambio, () => undefined);
        }
        if (r.noLeidos === 0) leida.current = false;
      } catch (err) {
        if (!cancelado) setError(mensajeDe(err, "No se pudo cargar la conversación."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, id, version, onCambio]);

  async function ejecutar(accion: () => Promise<unknown>, ok: string) {
    setOcupado(true);
    setAviso(null);
    try {
      await accion();
      setAviso({ tipo: "ok", texto: ok });
      setVersion((n) => n + 1);
      onCambio();
    } catch (err) {
      setAviso({ tipo: "error", texto: mensajeDe(err, "No se pudo completar la acción.") });
      setVersion((n) => n + 1);
      onCambio();
    } finally {
      setOcupado(false);
    }
  }

  if (error) return <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => setVersion((n) => n + 1)} />;
  if (!d) return <EstadoCargando etiqueta="Cargando conversación…" />;

  const cerrada = d.estado === "cerrada";
  const esMia = d.esResponsable && d.estado === "humano";
  const tomadaPorOtra = d.estado === "humano" && d.responsable !== null && !d.esResponsable;
  const puedeReasignar = CONVERSACIONES_REASIGNAR_ROLES.has(role);
  const sensible = textoTieneDatoSensible(respuesta);
  const pendientes = d.mensajes.filter((m) => m.envio === "pendiente_envio").length;

  function enviar(e: FormEvent) {
    e.preventDefault();
    const texto = respuesta.trim();
    if (!texto || sensible) return;
    void ejecutar(async () => {
      await responderConversacion(fetch, apiBaseUrl, token, propertyId, id, texto);
      setRespuesta("");
    }, "Respuesta guardada. Se envía por WhatsApp en cuanto el canal esté conectado.");
  }

  function guardarNota(e: FormEvent) {
    e.preventDefault();
    const texto = nota.trim();
    if (!texto || textoTieneDatoSensible(texto)) return;
    void ejecutar(async () => {
      await agregarNota(fetch, apiBaseUrl, token, propertyId, id, texto);
      setNota("");
    }, "Nota guardada.");
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
        <CardTitle className="inline-flex items-center gap-2">
          {d.huesped?.nombre ?? d.telefono}
          <StatusBadge tone={tonoEstado(d)}>{etiquetaEstado(d)}</StatusBadge>
        </CardTitle>
        {d.huesped && (
          <Link to={`/hoteles/${orgSlug}/huespedes/${d.huesped.id}`} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5">
            <UserRound className="size-4" strokeWidth={1.75} />
            Ficha del huésped
          </Link>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {aviso && <Callout tone={aviso.tipo === "error" ? "danger" : "success"}>{aviso.texto}</Callout>}

        <div className="flex flex-wrap gap-2">
          {!cerrada && !esMia && !tomadaPorOtra && (
            <Button disabled={ocupado} onClick={() => void ejecutar(() => tomarConversacion(fetch, apiBaseUrl, token, propertyId, id), "La conversación es tuya: el agente ya no responde.")}>
              Tomar conversación
            </Button>
          )}
          {tomadaPorOtra && puedeReasignar && (
            <Button variant="outline" disabled={ocupado} onClick={() => void ejecutar(() => tomarConversacion(fetch, apiBaseUrl, token, propertyId, id, true), "Ahora la conversación es tuya.")}>
              Reasignarme la conversación
            </Button>
          )}
          {d.estado === "humano" && (esMia || puedeReasignar || d.responsable === null) && (
            <Button variant="outline" disabled={ocupado} onClick={() => void ejecutar(() => devolverAlAgente(fetch, apiBaseUrl, token, propertyId, id), "Devuelta al agente: vuelve a responder.")}>
              Devolver al agente
            </Button>
          )}
          {!cerrada && (esMia || puedeReasignar || d.estado === "agente" || d.responsable === null) && (
            <Button variant="outline" disabled={ocupado} onClick={() => void ejecutar(() => cerrarConversacion(fetch, apiBaseUrl, token, propertyId, id), "Conversación cerrada.")}>
              Cerrar conversación
            </Button>
          )}
        </div>
        {d.estado === "humano" && d.responsable && <p className="m-0 text-muted-foreground">La tiene: {d.responsable.nombre ?? "otra persona"}{d.tomadaEn ? ` desde ${hora(d.tomadaEn)}` : ""}</p>}
        {d.estado === "humano" && !d.responsable && <p className="m-0 text-muted-foreground">Nadie la ha tomado. {d.motivoTexto ? `${d.motivoTexto}.` : ""} El agente no responde mientras esté en atención humana.</p>}
        {cerrada && <p className="m-0 text-muted-foreground">Cerrada{d.cerradaEn ? ` el ${hora(d.cerradaEn)}` : ""}. Se reabre con el agente si el huésped vuelve a escribir.</p>}

        <section aria-label="Mensajes" className="flex flex-col gap-2 max-h-[360px] overflow-auto rounded-lg border border-border bg-background p-3">
          {d.totalMensajes > d.mensajes.length && <p className="m-0 text-xs text-muted-foreground">Mostrando los últimos {d.mensajes.length} de {d.totalMensajes} mensajes.</p>}
          {d.mensajes.length === 0 && <p className="m-0 text-muted-foreground">Sin mensajes.</p>}
          {d.mensajes.map((m, i) => (
            <div key={i} className={`flex flex-col gap-0.5 ${m.origen === "huesped" ? "items-start" : "items-end"}`}>
              <p className="m-0 text-xs text-muted-foreground">
                {m.origen === "huesped" ? "Huésped" : m.origen === "personal" ? "Personal del hotel" : "Agente"}
                {m.creadoEn ? ` · ${hora(m.creadoEn)}` : ""}
              </p>
              <p className={`m-0 max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 ${m.origen === "huesped" ? "bg-muted text-foreground" : "bg-primary/10 text-foreground"}`}>{m.texto}</p>
              {m.envio && <p className={`m-0 text-xs ${m.envio === "fallido" ? "text-destructive" : "text-muted-foreground"}`}>{ENVIO_LABELS[m.envio]}</p>}
            </div>
          ))}
        </section>
        {pendientes > 0 && (
          <p role="status" className="m-0 text-xs text-muted-foreground">
            {pendientes === 1 ? "Hay 1 respuesta pendiente de envío" : `Hay ${pendientes} respuestas pendientes de envío`}: el canal de WhatsApp aún no las ha entregado (se envían en cuanto el hotel conecte su número de WhatsApp).
          </p>
        )}

        {esMia ? (
          <form className="flex flex-col gap-2" onSubmit={enviar}>
            <FormField label="Responder por WhatsApp" error={sensible ? "No envíes números de tarjeta ni de documento por WhatsApp." : undefined}>
              <Textarea value={respuesta} maxLength={1000} onChange={(e) => setRespuesta(e.target.value)} rows={3} />
            </FormField>
            <div>
              <Button type="submit" loading={ocupado} disabled={ocupado || !respuesta.trim() || sensible}>
                Enviar respuesta
              </Button>
            </div>
          </form>
        ) : (
          d.estado === "humano" && <p className="m-0 text-xs text-muted-foreground">Solo la persona que tomó la conversación puede responder.</p>
        )}

        <section aria-label="Notas internas" className="flex flex-col gap-2">
          <h2 className="m-0 text-sm font-semibold">Notas internas (el huésped no las ve)</h2>
          {d.notas.length === 0 && <p className="m-0 text-muted-foreground">Sin notas.</p>}
          {d.notas.map((n) => (
            <p key={n.id} className="m-0">
              <span className="text-muted-foreground">
                {hora(n.creadaEn)} · {n.autor ?? "Personal"}:
              </span>{" "}
              {n.texto}
            </p>
          ))}
          <form className="flex gap-2" onSubmit={guardarNota}>
            <Input aria-label="Nueva nota" value={nota} maxLength={1000} onChange={(e) => setNota(e.target.value)} className="flex-1" />
            <Button type="submit" variant="outline" disabled={ocupado || !nota.trim() || textoTieneDatoSensible(nota)}>
              Agregar
            </Button>
          </form>
        </section>
      </CardContent>
    </Card>
  );
}
