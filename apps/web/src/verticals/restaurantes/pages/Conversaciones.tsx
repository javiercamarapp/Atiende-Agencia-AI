// R-21: bandeja de conversaciones por sucursal (WhatsApp y llamadas), toma por una persona (el agente deja de
// responder), devolucion al agente, notas internas, cobertura de turno (quien esta de guardia) y registro de
// callbacks. Contrato: lib/conversaciones-client.ts. Tres estados honestos: cargando, `disponible: false` (la
// migracion 028 todavia no esta aplicada: NUNCA se confunde con una bandeja vacia) y datos.
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Selector, PageContainer, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, localeActivo, statusTone, traductorActivo, useT } from "@atiende/ui";
import { restaurantesConversaciones } from "@atiende/ui/i18n/restaurantes/conversaciones";
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


/** Quien escribio cada mensaje del hilo: el cliente, el asistente, una persona del panel (por nombre) o el personal desde la app de WhatsApp Business. */
function etiquetaAutor(m: { readonly rol: string; readonly autor?: string | null }): string {
  const tr = traductorActivo(restaurantesConversaciones);
  if (m.rol === "cliente") return tr("restaurantes.conversaciones.autor.cliente");
  if (m.rol === "agente") return tr("restaurantes.conversaciones.autor.agente");
  if (m.rol === "humano") return m.autor ? tr("restaurantes.conversaciones.autor.persona", { autor: m.autor }) : tr("restaurantes.conversaciones.autor.personaEquipo");
  if (m.rol === "humano_app") return tr("restaurantes.conversaciones.autor.personalApp");
  return tr("restaurantes.conversaciones.autor.herramienta");
}

function hora(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(localeActivo(), { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function ConversacionesPage(ctx: RestaurantesShellContext) {
  const { apiBaseUrl, token, propertyId } = ctx;
  const t = useT(restaurantesConversaciones);
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
        if (!cancelado) setError(mensaje(err, t("restaurantes.conversaciones.error.bandeja")));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, estado, canal, reintento, filtroActual]);

  return (
    <PageContainer padding="none">
      <header>
        <h1 className="sr-only">{t("restaurantes.conversaciones.titulo")}</h1>
        <p className="m-0 text-ui text-muted-foreground">{t("restaurantes.conversaciones.intro")}</p>
      </header>

      <Tabs defaultValue="bandeja">
        <TabsList>
          <TabsTrigger value="bandeja">{t("restaurantes.conversaciones.tab.bandeja")}</TabsTrigger>
          <TabsTrigger value="callbacks">{t("restaurantes.conversaciones.tab.callbacks")}</TabsTrigger>
        </TabsList>

        <TabsContent value="bandeja" className="flex flex-col gap-4">
          {data && (
            <Card>
              <CardHeader>
                <CardTitle>{t("restaurantes.conversaciones.guardia.titulo")}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {data.cobertura.sinCobertura ? (
                  <p className="m-0 text-destructive">{t("restaurantes.conversaciones.guardia.nadie")}</p>
                ) : (
                  <ul className="m-0 pl-4">
                    {data.cobertura.guardia.map((g) => (
                      <li key={g.userId}>
                        {g.nombre ?? t("restaurantes.conversaciones.guardia.sinNombre")} — {g.turno} ({g.orden === 1 ? t("restaurantes.conversaciones.guardia.principal") : t("restaurantes.conversaciones.guardia.respaldo", { n: g.orden - 1 })})
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          <div className="flex flex-wrap gap-3">
            <Selector aria-label={t("restaurantes.conversaciones.filtro.estado")} value={estado} onChange={(e) => setEstado(e.target.value as HandoffEstado | "")} wrapperClassName="w-auto min-w-48">
              <option value="">{t("restaurantes.conversaciones.filtro.todosEstados")}</option>
              {(Object.keys(ESTADO_LABEL) as HandoffEstado[]).map((e) => (
                <option key={e} value={e}>
                  {ESTADO_LABEL[e]}
                </option>
              ))}
            </Selector>
            <Selector aria-label={t("restaurantes.conversaciones.filtro.canal")} value={canal} onChange={(e) => setCanal(e.target.value as ConversacionCanal | "")} wrapperClassName="w-auto min-w-48">
              <option value="">{t("restaurantes.conversaciones.filtro.todosCanales")}</option>
              <option value="whatsapp">{t("restaurantes.conversaciones.canal.whatsapp")}</option>
              <option value="voz">{t("restaurantes.conversaciones.filtro.llamadas")}</option>
            </Selector>
          </div>

          {error && <EstadoError mensaje={error} onReintentar={recargar} />}
          {!error && data === null && <EstadoCargando lineas={4} />}
          {!error && data && !data.disponible && (
            <EstadoVacio icon={MessageSquare} titulo={t("restaurantes.conversaciones.noDisponible.titulo")} mensaje={t("restaurantes.conversaciones.noDisponible.mensaje")} />
          )}
          {!error && data && data.disponible && data.items.length === 0 && <EstadoVacio icon={MessageSquare} titulo={t("restaurantes.conversaciones.vacio.titulo")} mensaje={t("restaurantes.conversaciones.vacio.mensaje")} />}

          {!error && data && data.disponible && data.items.length > 0 && (
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <ul className="m-0 p-0 list-none flex flex-col gap-2" aria-label={t("restaurantes.conversaciones.lista")}>
                {data.items.map((i) => (
                  <FilaConversacion key={`${i.canal}:${i.conversationId}`} item={i} activa={seleccion?.id === i.conversationId} onElegir={() => setSeleccion({ canal: i.canal, id: i.conversationId })} />
                ))}
              </ul>
              {seleccion ? <DetalleConversacion key={`${seleccion.canal}:${seleccion.id}`} ctx={ctx} canal={seleccion.canal} conversationId={seleccion.id} onCambio={recargar} /> : <p className="m-0 text-sm text-muted-foreground">{t("restaurantes.conversaciones.elige")}</p>}
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
  const t = useT(restaurantesConversaciones);
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
        <p className="m-0 mt-1 text-xs text-muted-foreground truncate">{item.vistaPrevia || t("restaurantes.conversaciones.sinMensajes")}</p>
        <p className="m-0 mt-1 text-xs text-muted-foreground">
          {hora(item.actividadEn)}
          {item.tomadaPorNombre ? t("restaurantes.conversaciones.laTiene", { nombre: item.tomadaPorNombre }) : ""}
          {item.motivo ? t("restaurantes.conversaciones.motivoFila", { motivo: item.motivo }) : ""}
        </p>
        {esc && <p className="m-0 mt-1 text-xs text-destructive">{esc}</p>}
      </button>
    </li>
  );
}

function DetalleConversacion({ ctx, canal, conversationId, onCambio }: { ctx: RestaurantesShellContext; canal: ConversacionCanal; conversationId: string; onCambio: () => void }) {
  const { apiBaseUrl, token, propertyId, staffEmail } = ctx;
  const t = useT(restaurantesConversaciones);
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
        if (!cancelado) setError(mensaje(err, t("restaurantes.conversaciones.error.conversacion")));
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
      setAviso({ tipo: "error", texto: mensaje(err, t("restaurantes.conversaciones.error.accion")) });
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
            <Button disabled={ocupado} onClick={() => ejecutar(() => tomarConversacion(fetch, apiBaseUrl, token, propertyId, canal, conversationId), t("restaurantes.conversaciones.ok.tomada"))}>
              {t("restaurantes.conversaciones.tomar")}
            </Button>
          )}
          {h && abierta && (
            <>
              <Button variant="outline" disabled={ocupado} onClick={() => ejecutar(() => liberarHandoff(fetch, apiBaseUrl, token, propertyId, h.handoffId, "devolver"), t("restaurantes.conversaciones.ok.devuelta"))}>
                {t("restaurantes.conversaciones.devolver")}
              </Button>
              <Button variant="outline" disabled={ocupado} onClick={() => ejecutar(() => liberarHandoff(fetch, apiBaseUrl, token, propertyId, h.handoffId, "cerrar"), t("restaurantes.conversaciones.ok.resuelta"))}>
                {t("restaurantes.conversaciones.resolver")}
              </Button>
            </>
          )}
        </div>
        {h?.tomadaPorNombre && <p className="m-0 text-muted-foreground">{t("restaurantes.conversaciones.laTieneDetalle", { nombre: h.tomadaPorNombre })}</p>}
        {h?.motivo === "personal_app" ? (
          <p className="m-0 text-muted-foreground">{t("restaurantes.conversaciones.personalApp")}</p>
        ) : (
          h?.motivo && <p className="m-0 text-muted-foreground">{t("restaurantes.conversaciones.motivoSolicitud", { motivo: h.motivo })}</p>
        )}

        <section aria-label={t("restaurantes.conversaciones.mensajes")} className="flex flex-col gap-1 max-h-[280px] overflow-auto">
          {!d.transcripcionDisponible && <p className="m-0 text-muted-foreground">{t("restaurantes.conversaciones.transcripcionPrivada")}</p>}
          {d.mensajes.map((m, i) => (
            <p key={i} className="m-0">
              {m.creadoEn && <span className="text-muted-foreground">{hora(m.creadoEn)} · </span>}
              <strong>{etiquetaAutor(m)}:</strong> {m.texto}
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
              }, t("restaurantes.conversaciones.ok.respuesta"));
            }}
          >
            <label className="flex flex-col gap-1">
              {t("restaurantes.conversaciones.responder")}
              <Textarea value={respuesta} maxLength={1000} onChange={(e) => setRespuesta(e.target.value)} rows={2} />
            </label>
            <Button type="submit" disabled={ocupado || !respuesta.trim()}>
              {t("restaurantes.conversaciones.enviar")}
            </Button>
          </form>
        )}

        {h && (
          <section aria-label={t("restaurantes.conversaciones.notas.aria")} className="flex flex-col gap-2">
            <h2 className="m-0 text-sm font-semibold">{t("restaurantes.conversaciones.notas.titulo")}</h2>
            {d.notas.length === 0 && <p className="m-0 text-muted-foreground">{t("restaurantes.conversaciones.notas.vacio")}</p>}
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
                }, t("restaurantes.conversaciones.ok.nota"));
              }}
            >
              <Input aria-label={t("restaurantes.conversaciones.notas.nueva")} value={nota} maxLength={2000} onChange={(e) => setNota(e.target.value)} className="flex-1" />
              <Button type="submit" variant="outline" disabled={ocupado || !nota.trim()}>
                {t("restaurantes.conversaciones.notas.agregar")}

              </Button>
            </form>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
