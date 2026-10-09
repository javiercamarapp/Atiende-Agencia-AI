// R-21: bandeja de conversaciones por sucursal (WhatsApp y llamadas), toma por una persona (el agente deja de
// responder), devolucion al agente, notas internas, cobertura de turno (quien esta de guardia) y registro de
// callbacks. Contrato: lib/conversaciones-client.ts. Tres estados honestos: cargando, `disponible: false` (la
// migracion 028 todavia no esta aplicada: NUNCA se confunde con una bandeja vacia) y datos.
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Selector, PageContainer, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, statusTone } from "@atiende/ui";
import {
  CANAL_LABEL,
  ESTADO_LABEL,
  agregarNota,
  fetchBandeja,
  fetchDetalle,
  liberarHandoff,
  responderWhatsapp,
  textoEscalacion,
  tomarConversacion,
} from "../lib/conversaciones-client.ts";
import type { BandejaWire, BandejaItemWire, ConversacionCanal, DetalleWire, HandoffEstado } from "../lib/conversaciones-client.ts";
import { HANDOFF_ESTADO_TONES } from "../lib/status-tones.ts";
import { CallbacksPanel } from "./CallbacksPanel.tsx";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";


function hora(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function ConversacionesPage(ctx: RestaurantesShellContext) {
  const { apiBaseUrl, token, propertyId } = ctx;
  const [estado, setEstado] = useState<HandoffEstado | "">("");
  const [canal, setCanal] = useState<ConversacionCanal | "">("");
  const [data, setData] = useState<BandejaWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reintento, setReintento] = useState(0);
  const [seleccion, setSeleccion] = useState<{ canal: ConversacionCanal; id: string } | null>(null);

  const recargar = useCallback(() => setReintento((n) => n + 1), []);

  // Al cambiar un filtro se muestra el esqueleto; al RECARGAR tras una accion (tomar/devolver...) se conserva la lista
  // para no desmontar el detalle abierto (perderia su aviso y el texto en curso).
  const filtroActual = `${estado}|${canal}`;
  const ultimoFiltro = useRef(filtroActual);

  useEffect(() => {
    let cancelado = false;
    if (ultimoFiltro.current !== filtroActual) {
      ultimoFiltro.current = filtroActual;
      setData(null);
    }
    setError(null);
    (async () => {
      try {
        const b = await fetchBandeja(fetch, apiBaseUrl, token, propertyId, { estado, canal });
        if (!cancelado) setData(b);
      } catch (err) {
        if (!cancelado) setError(mensaje(err, "No se pudo cargar la bandeja."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, estado, canal, reintento, filtroActual]);

  return (
    <PageContainer padding="none">
      <header>
        <h1 className="sr-only">Conversaciones</h1>
        <p className="m-0 text-ui text-muted-foreground">WhatsApp y llamadas de esta sucursal. Toma una conversación para atenderla tú: mientras la tengas, el agente no responde.</p>
      </header>

      <Tabs defaultValue="bandeja">
        <TabsList>
          <TabsTrigger value="bandeja">Bandeja</TabsTrigger>
          <TabsTrigger value="callbacks">Callbacks</TabsTrigger>
        </TabsList>

        <TabsContent value="bandeja" className="flex flex-col gap-4">
          {data && (
            <Card>
              <CardHeader>
                <CardTitle>De guardia ahora</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {data.cobertura.sinCobertura ? (
                  <p className="m-0 text-destructive">Nadie está de guardia en este momento: las solicitudes escalan a administración. Define los turnos en «Turnos».</p>
                ) : (
                  <ul className="m-0 pl-4">
                    {data.cobertura.guardia.map((g) => (
                      <li key={g.userId}>
                        {g.nombre ?? "Sin nombre"} — {g.turno} ({g.orden === 1 ? "principal" : `respaldo ${g.orden - 1}`})
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          <div className="flex flex-wrap gap-3">
            <Selector aria-label="Estado" value={estado} onChange={(e) => setEstado(e.target.value as HandoffEstado | "")} wrapperClassName="w-auto min-w-48">
              <option value="">Todos los estados</option>
              {(Object.keys(ESTADO_LABEL) as HandoffEstado[]).map((e) => (
                <option key={e} value={e}>
                  {ESTADO_LABEL[e]}
                </option>
              ))}
            </Selector>
            <Selector aria-label="Canal" value={canal} onChange={(e) => setCanal(e.target.value as ConversacionCanal | "")} wrapperClassName="w-auto min-w-48">
              <option value="">WhatsApp y llamadas</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="voz">Llamadas</option>
            </Selector>
          </div>

          {error && <EstadoError mensaje={error} onReintentar={recargar} />}
          {!error && data === null && <EstadoCargando lineas={4} />}
          {!error && data && !data.disponible && (
            <EstadoVacio icon={MessageSquare} titulo="Conversaciones no disponibles aún" mensaje="La bandeja con atención humana todavía no está habilitada en esta base de datos. El agente sigue respondiendo con normalidad." />
          )}
          {!error && data && data.disponible && data.items.length === 0 && <EstadoVacio icon={MessageSquare} titulo="Sin conversaciones" mensaje="No hay conversaciones con estos filtros." />}

          {!error && data && data.disponible && data.items.length > 0 && (
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <ul className="m-0 p-0 list-none flex flex-col gap-2" aria-label="Conversaciones">
                {data.items.map((i) => (
                  <FilaConversacion key={`${i.canal}:${i.conversationId}`} item={i} activa={seleccion?.id === i.conversationId} onElegir={() => setSeleccion({ canal: i.canal, id: i.conversationId })} />
                ))}
              </ul>
              {seleccion ? <DetalleConversacion key={`${seleccion.canal}:${seleccion.id}`} ctx={ctx} canal={seleccion.canal} conversationId={seleccion.id} onCambio={recargar} /> : <p className="m-0 text-sm text-muted-foreground">Elige una conversación para verla.</p>}
            </div>
          )}
        </TabsContent>

        <TabsContent value="callbacks">
          <CallbacksPanel ctx={ctx} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

function FilaConversacion({ item, activa, onElegir }: { item: BandejaItemWire; activa: boolean; onElegir: () => void }) {
  const esc = textoEscalacion(item.escalacion);
  return (
    <li>
      <button type="button" onClick={onElegir} className={`w-full text-left rounded-md border p-3 ${activa ? "border-primary" : "border-border"} bg-card`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">
            {CANAL_LABEL[item.canal]} {item.telefono ? `· ${item.telefono}` : ""}
          </span>
          <StatusBadge tone={statusTone(HANDOFF_ESTADO_TONES, item.estado)}>{ESTADO_LABEL[item.estado]}</StatusBadge>
        </div>
        <p className="m-0 mt-1 text-xs text-muted-foreground truncate">{item.vistaPrevia || "Sin mensajes"}</p>
        <p className="m-0 mt-1 text-xs text-muted-foreground">
          {hora(item.actividadEn)}
          {item.tomadaPorNombre ? ` · la tiene ${item.tomadaPorNombre}` : ""}
          {item.motivo ? ` · motivo: ${item.motivo}` : ""}
        </p>
        {esc && <p className="m-0 mt-1 text-xs text-destructive">{esc}</p>}
      </button>
    </li>
  );
}

function DetalleConversacion({ ctx, canal, conversationId, onCambio }: { ctx: RestaurantesShellContext; canal: ConversacionCanal; conversationId: string; onCambio: () => void }) {
  const { apiBaseUrl, token, propertyId, staffEmail } = ctx;
  const [d, setD] = useState<DetalleWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  // El resultado de una accion: un exito se anuncia como estado y un fallo como alerta con estilo de error (QA-restaurantes-R1-botones-04).
  const [aviso, setAviso] = useState<{ readonly tipo: "ok" | "error"; readonly texto: string } | null>(null);
  const [nota, setNota] = useState("");
  const [respuesta, setRespuesta] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const r = await fetchDetalle(fetch, apiBaseUrl, token, propertyId, canal, conversationId);
        if (!cancelado) {
          setD(r);
          setError(null);
        }
      } catch (err) {
        if (!cancelado) setError(mensaje(err, "No se pudo cargar la conversación."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, canal, conversationId, version]);

  async function ejecutar(accion: () => Promise<unknown>, ok: string) {
    setOcupado(true);
    setAviso(null);
    try {
      await accion();
      setAviso({ tipo: "ok", texto: ok });
      setVersion((n) => n + 1);
      onCambio();
    } catch (err) {
      setAviso({ tipo: "error", texto: mensaje(err, "No se pudo completar la acción.") });
    } finally {
      setOcupado(false);
    }
  }

  if (error) return <EstadoError mensaje={error} onReintentar={() => setVersion((n) => n + 1)} />;
  if (!d) return <EstadoCargando lineas={4} />;
  const h = d.handoff;
  const abierta = h?.estado === "pendiente" || h?.estado === "tomada";

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {CANAL_LABEL[canal]} — {h ? ESTADO_LABEL[h.estado] : ESTADO_LABEL.agente}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {aviso &&
          (aviso.tipo === "error" ? (
            <p role="alert" className="m-0 text-destructive">
              {aviso.texto}
            </p>
          ) : (
            <p role="status" className="m-0 text-foreground">
              {aviso.texto}
            </p>
          ))}

        <div className="flex flex-wrap gap-2">
          {(!h || !abierta || h.estado === "pendiente") && (
            <Button disabled={ocupado} onClick={() => ejecutar(() => tomarConversacion(fetch, apiBaseUrl, token, propertyId, canal, conversationId), "La conversación es tuya: el agente ya no responde.")}>
              Tomar conversación
            </Button>
          )}
          {h && abierta && (
            <>
              <Button variant="outline" disabled={ocupado} onClick={() => ejecutar(() => liberarHandoff(fetch, apiBaseUrl, token, propertyId, h.handoffId, "devolver"), "Devuelta al agente.")}>
                Devolver al agente
              </Button>
              <Button variant="outline" disabled={ocupado} onClick={() => ejecutar(() => liberarHandoff(fetch, apiBaseUrl, token, propertyId, h.handoffId, "cerrar"), "Conversación resuelta.")}>
                Marcar como resuelta
              </Button>
            </>
          )}
        </div>
        {h?.tomadaPorNombre && <p className="m-0 text-muted-foreground">La tiene: {h.tomadaPorNombre}</p>}
        {h?.motivo && <p className="m-0 text-muted-foreground">Motivo de la solicitud: {h.motivo}</p>}

        <section aria-label="Mensajes" className="flex flex-col gap-1 max-h-[280px] overflow-auto">
          {!d.transcripcionDisponible && <p className="m-0 text-muted-foreground">La transcripción de esta llamada solo se muestra a quien la toma o a owner/admin.</p>}
          {d.mensajes.map((m, i) => (
            <p key={i} className="m-0">
              <strong>{m.rol === "cliente" ? "Cliente" : m.rol === "humano" ? "Persona" : m.rol === "agente" ? "Agente" : "Herramienta"}:</strong> {m.texto}
            </p>
          ))}
        </section>

        {h?.estado === "tomada" && canal === "whatsapp" && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!respuesta.trim()) return;
              void ejecutar(async () => {
                await responderWhatsapp(fetch, apiBaseUrl, token, propertyId, h.handoffId, respuesta.trim());
                setRespuesta("");
              }, "Respuesta enviada al cliente.");
            }}
          >
            <label className="flex flex-col gap-1">
              Responder por WhatsApp
              <Textarea value={respuesta} maxLength={1000} onChange={(e) => setRespuesta(e.target.value)} rows={2} />
            </label>
            <Button type="submit" disabled={ocupado || !respuesta.trim()}>
              Enviar respuesta
            </Button>
          </form>
        )}

        {h && (
          <section aria-label="Notas internas" className="flex flex-col gap-2">
            <h2 className="m-0 text-sm font-semibold">Notas internas (el cliente no las ve)</h2>
            {d.notas.length === 0 && <p className="m-0 text-muted-foreground">Sin notas.</p>}
            {d.notas.map((n) => (
              <p key={n.id} className="m-0">
                <span className="text-muted-foreground">{hora(n.creadoEn)} · {n.autor ?? staffEmail}:</span> {n.texto}
              </p>
            ))}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!nota.trim()) return;
                void ejecutar(async () => {
                  await agregarNota(fetch, apiBaseUrl, token, propertyId, h.handoffId, nota.trim());
                  setNota("");
                }, "Nota guardada.");
              }}
            >
              <Input aria-label="Nueva nota" value={nota} maxLength={2000} onChange={(e) => setNota(e.target.value)} className="flex-1" />
              <Button type="submit" variant="outline" disabled={ocupado || !nota.trim()}>
                Agregar
              </Button>
            </form>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
