// Agente de voz de restaurantes: reconstruye la experiencia del panel original SIN
// ElevenLabs (sin SDK, sin widget, sin sliders de estabilidad/similitud/velocidad,
// sin filtros de acento ni gráficas fantasma) y con el motor elegido: Gemini Live,
// 30 voces predefinidas, sin clonación.
//
// Pestañas: Resumen, Voz, Conocimiento, Comportamiento, Mensaje inicial,
// Herramientas y Conversaciones (nueva). La config y las conversaciones vienen de
// endpoints de la API propia que construye otra tarea (lib/voz-client.ts): si
// responden 404/503 la pantalla lo dice, nunca inventa datos. La vista previa es una
// llamada REAL de prueba con Gemini Live por token efímero (voz/adaptador-gemini-live.ts);
// sin credencial en el servidor dice "no disponible: falta GEMINI_API_KEY" en vez de simular.
import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, CheckCircle2, Circle, Mic, Wrench } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, PageContainer, Textarea, VistaPreviaLlamada, StatusBadge } from "@atiende/ui";
import { VozNoDisponibleError, crearSesionPreviewVoz, fetchConversacionesVoz, fetchConversacionVoz, fetchSaludVoz, fetchVozConfig, updateVozConfig } from "../lib/voz-client.ts";
import type { ConversacionVoz, VozConfig, VozConfigInput } from "../lib/voz-client.ts";
import { buscarVoz } from "../lib/voz-catalogo.ts";
import { crearFabricaGeminiLive } from "../voz/adaptador-gemini-live.ts";
import type { EntornoVoz } from "../voz/adaptador-gemini-live.ts";
import { entornoNavegador } from "../voz/entorno-navegador.ts";
import { desdeError } from "../voz/carga.ts";
import type { Carga } from "../voz/carga.ts";
import { contarEjecuciones, HERRAMIENTAS_AGENTE } from "../voz/herramientas-agente.ts";
import { formatoCostoUsd, formatoDuracion } from "../voz/formato-voz.ts";
import { PestanaConversaciones } from "../voz/PestanaConversaciones.tsx";
import { PestanaIndicadores } from "../voz/PestanaIndicadores.tsx";
import { SelectorVoz } from "../voz/SelectorVoz.tsx";
import type { MuestraAudio } from "../voz/SelectorVoz.tsx";
import { useSesionVoz } from "../voz/useSesionVoz.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

type PestanaId = "resumen" | "voz" | "conocimiento" | "comportamiento" | "mensaje" | "herramientas" | "conversaciones" | "indicadores";

const PESTANAS: readonly { readonly id: PestanaId; readonly etiqueta: string }[] = [
  { id: "resumen", etiqueta: "Resumen" },
  { id: "voz", etiqueta: "Voz" },
  { id: "conocimiento", etiqueta: "Conocimiento" },
  { id: "comportamiento", etiqueta: "Comportamiento" },
  { id: "mensaje", etiqueta: "Mensaje inicial" },
  { id: "herramientas", etiqueta: "Herramientas" },
  { id: "conversaciones", etiqueta: "Conversaciones" },
  { id: "indicadores", etiqueta: "Indicadores" },
];

const PESTANAS_EDITABLES: ReadonlySet<PestanaId> = new Set(["voz", "comportamiento", "mensaje"]);

const BORRADOR_VACIO: VozConfigInput = { vozId: null, promptSistema: "", mensajeInicial: "", habilitado: false };

/** Regla de transparencia: el saludo debe presentarse como asistente virtual. */
export function mencionaAsistenteVirtual(texto: string): boolean {
  return /asistente\s+virtual/i.test(texto);
}

function aBorrador(c: VozConfig | null): VozConfigInput {
  return c ? { vozId: c.vozId, promptSistema: c.promptSistema, mensajeInicial: c.mensajeInicial, habilitado: c.habilitado } : BORRADOR_VACIO;
}

function iguales(a: VozConfigInput, b: VozConfigInput): boolean {
  return a.vozId === b.vozId && a.promptSistema === b.promptSistema && a.mensajeInicial === b.mensajeInicial && a.habilitado === b.habilitado;
}

export interface AgenteVozPageProps extends RestaurantesShellContext {
  /** Solo para pruebas: reemplaza la reproducción real de la muestra de voz. */
  readonly crearAudio?: (url: string) => MuestraAudio;
  /** Solo para pruebas: reemplaza el navegador (WebSocket, micrófono, reproducción) de la llamada de prueba. */
  readonly entornoVoz?: EntornoVoz;
}

export function AgenteVozPage({ apiBaseUrl, token, propertyId, crearAudio, entornoVoz }: AgenteVozPageProps) {
  const [pestana, setPestana] = useState<PestanaId>("resumen");
  const [config, setConfig] = useState<Carga<VozConfig | null>>({ estado: "cargando" });
  const [conversaciones, setConversaciones] = useState<Carga<readonly ConversacionVoz[]>>({ estado: "cargando" });
  const [guardado, setGuardado] = useState<VozConfigInput>(BORRADOR_VACIO);
  const [borrador, setBorrador] = useState<VozConfigInput>(BORRADOR_VACIO);
  const [guardando, setGuardando] = useState(false);
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);
  const [avisoGuardado, setAvisoGuardado] = useState(false);
  const [vistaPrevia, setVistaPrevia] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setConfig({ estado: "cargando" });
    (async () => {
      try {
        const c = await fetchVozConfig(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setConfig({ estado: "listo", datos: c });
        setGuardado(aBorrador(c));
        setBorrador(aBorrador(c));
      } catch (err) {
        if (!cancelado) setConfig(desdeError(err, "No se pudo cargar la configuración de voz."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version]);

  useEffect(() => {
    let cancelado = false;
    setConversaciones({ estado: "cargando" });
    (async () => {
      try {
        const lista = await fetchConversacionesVoz(fetch, apiBaseUrl, token, propertyId);
        if (!cancelado) setConversaciones({ estado: "listo", datos: lista });
      } catch (err) {
        if (!cancelado) setConversaciones(desdeError(err, "No se pudieron cargar las conversaciones."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version]);

  const reintentar = useCallback(() => setVersion((v) => v + 1), []);

  const sucio = !iguales(borrador, guardado);
  const servicioListo = config.estado === "listo";

  async function guardar() {
    if (!servicioListo || guardando || !sucio) return;
    setGuardando(true);
    setErrorGuardado(null);
    setAvisoGuardado(false);
    try {
      const c = await updateVozConfig(fetch, apiBaseUrl, token, propertyId, borrador);
      setConfig({ estado: "listo", datos: c });
      setGuardado(aBorrador(c));
      setBorrador(aBorrador(c));
      setAvisoGuardado(true);
    } catch (err) {
      setErrorGuardado(err instanceof Error ? err.message : "No se pudieron guardar los cambios.");
    } finally {
      setGuardando(false);
    }
  }

  const ejecuciones = useMemo(() => contarEjecuciones(conversaciones.estado === "listo" ? conversaciones.datos : null), [conversaciones]);

  return (
    <div className="relative min-h-[620px] h-full">
      <PageContainer padding="none">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="sr-only">Agente de voz</h1>
            <p className="text-ui text-muted-foreground">Voz, conocimiento y comportamiento del agente que atiende las llamadas de esta sucursal.</p>
          </div>
          <Button type="button" onClick={() => setVistaPrevia(true)}>
            <Mic className="h-4 w-4 mr-1.5" strokeWidth={1.75} />
            Vista previa
          </Button>
        </div>

        <div role="tablist" aria-label="Secciones del agente de voz" className="flex flex-wrap gap-1.5 border-b border-border pb-2">
          {PESTANAS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              id={`pestana-${p.id}`}
              aria-selected={pestana === p.id}
              aria-controls={`panel-${p.id}`}
              onClick={() => setPestana(p.id)}
              className={`h-8 px-3 rounded-lg text-xs font-medium border transition-colors ${pestana === p.id ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {p.etiqueta}
            </button>
          ))}
        </div>

        {config.estado === "no_disponible" ? (
          <p role="status" data-testid="aviso-servicio" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            El servicio de voz todavía no está disponible para este negocio. Los cambios no se guardarán hasta que el servicio esté activo.
          </p>
        ) : null}
        {config.estado === "error" ? <EstadoError mensaje={config.mensaje} onReintentar={reintentar} /> : null}

        <div role="tabpanel" id={`panel-${pestana}`} aria-labelledby={`pestana-${pestana}`}>
          {config.estado === "cargando" && PESTANAS_EDITABLES.has(pestana) ? <EstadoCargando etiqueta="Cargando configuración de voz…" /> : null}

          {pestana === "resumen" ? <Resumen config={config} borrador={guardado} conversaciones={conversaciones} onVistaPrevia={() => setVistaPrevia(true)} /> : null}

          {pestana === "voz" && config.estado !== "cargando" ? (
            <div className="space-y-3">
              <Checkbox
                id="voz-habilitado"
                checked={borrador.habilitado}
                onChange={(e) => setBorrador({ ...borrador, habilitado: e.target.checked })}
                label="Agente habilitado para recibir llamadas en esta sucursal"
              />
              <SelectorVoz vozId={borrador.vozId} onElegir={(id) => setBorrador({ ...borrador, vozId: id })} baseUrl={import.meta.env.BASE_URL} crearAudio={crearAudio} />
            </div>
          ) : null}

          {pestana === "conocimiento" && config.estado !== "cargando" ? (
            <div className="space-y-4">
              <p role="note" data-testid="aviso-conocimiento" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Las notas de conocimiento libres todavía no se guardan en el servicio de voz. Mientras tanto, escribe horarios, políticas y preguntas frecuentes en la pestaña Comportamiento: el agente las recibe como parte de sus instrucciones.
              </p>
              <div>
                <p className="text-sm font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                  <BookOpen className="h-4 w-4" strokeWidth={1.75} />
                  Datos que consulta en vivo
                </p>
                <p className="text-xs text-muted-foreground">El menú, los precios, las sucursales y los clientes no se copian aquí: el agente los consulta en tiempo real con sus herramientas (ver la pestaña Herramientas), así que siempre ve lo vigente.</p>
              </div>
            </div>
          ) : null}

          {pestana === "comportamiento" && config.estado !== "cargando" ? (
            <div>
              <label htmlFor="voz-prompt" className="block text-sm font-medium text-foreground mb-1.5">
                Comportamiento (prompt del sistema)
              </label>
              <Textarea
                id="voz-prompt"
                value={borrador.promptSistema}
                onChange={(e) => setBorrador({ ...borrador, promptSistema: e.target.value })}
                rows={14}
                placeholder="Cómo debe hablar y actuar el agente: tono, reglas para tomar pedidos, qué hacer si no entiende…"
                className="font-mono"
              />
              <p className="mt-1 text-xs text-muted-foreground">El español de México y el acento se piden aquí: las voces son multilingües y no vienen etiquetadas por acento.</p>
            </div>
          ) : null}

          {pestana === "mensaje" && config.estado !== "cargando" ? (
            <div className="space-y-3">
              <div role="note" data-testid="aviso-asistente-virtual" className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
                <strong>Transparencia:</strong> el primer mensaje debe presentarse como asistente virtual, por ejemplo «Le atiende el asistente virtual de …». Quien llama tiene derecho a saber que habla con una inteligencia artificial.
              </div>
              <div>
                <label htmlFor="voz-mensaje-inicial" className="block text-sm font-medium text-foreground mb-1.5">
                  Primer mensaje
                </label>
                <Textarea
                  id="voz-mensaje-inicial"
                  value={borrador.mensajeInicial}
                  onChange={(e) => setBorrador({ ...borrador, mensajeInicial: e.target.value })}
                  rows={4}
                  placeholder="Hola, le atiende el asistente virtual de …"
                />
              </div>
              {borrador.mensajeInicial.trim() !== "" && !mencionaAsistenteVirtual(borrador.mensajeInicial) ? (
                <Callout tone="warning" role="alert" data-testid="alerta-sin-asistente-virtual">
                  Este mensaje no dice que es un asistente virtual. Agrégalo antes de poner el agente en producción.
                </Callout>
              ) : null}
            </div>
          ) : null}

          {pestana === "herramientas" ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Herramientas que el agente puede usar durante una llamada.</p>
              <ul className="grid gap-2">
                {HERRAMIENTAS_AGENTE.map((h) => (
                  <li key={h.nombre} data-herramienta={h.nombre} className="rounded-xl border border-border bg-card p-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                        <Wrench className="h-3.5 w-3.5" strokeWidth={1.75} />
                        {h.titulo}
                      </p>
                      <p className="text-xs text-muted-foreground">{h.descripcion}</p>
                    </div>
                    <span data-testid={`ejecuciones-${h.nombre}`} className="shrink-0 text-xs text-muted-foreground text-right">
                      {ejecuciones.disponible ? (
                        (ejecuciones.cuentas[h.nombre] ?? 0) > 0 ? (
                          <>
                            {ejecuciones.cuentas[h.nombre]} {ejecuciones.cuentas[h.nombre] === 1 ? "ejecución" : "ejecuciones"}
                            <span className="block text-2xs">en las últimas {ejecuciones.llamadas} llamadas</span>
                          </>
                        ) : (
                          <>Sin ejecuciones en las últimas {ejecuciones.llamadas} llamadas</>
                        )
                      ) : (
                        <>Sin datos de ejecuciones</>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {!ejecuciones.disponible ? (
                <p role="status" data-testid="motivo-sin-ejecuciones" className="text-xs text-muted-foreground">
                  {ejecuciones.motivo}
                </p>
              ) : null}
            </div>
          ) : null}

          {pestana === "conversaciones" ? <PestanaConversaciones conversaciones={conversaciones} onReintentar={reintentar} cargarDetalle={(id) => fetchConversacionVoz(fetch, apiBaseUrl, token, propertyId, id)} /> : null}

          {/* R-13: se monta solo al abrir la pestaña (carga KPI, evalúa alertas del día y lee umbrales). */}
          {pestana === "indicadores" ? <PestanaIndicadores apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} /> : null}
        </div>

        {PESTANAS_EDITABLES.has(pestana) && config.estado !== "cargando" ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <Button type="button" onClick={() => void guardar()} disabled={!servicioListo || !sucio || guardando || borrador.vozId === null}>
              {guardando ? "Guardando…" : "Guardar cambios"}
            </Button>
            {sucio ? <span className="text-xs text-muted-foreground">Hay cambios sin guardar.</span> : null}
            {borrador.vozId === null ? <span data-testid="aviso-elegir-voz" className="text-xs text-muted-foreground">Elige una voz en la pestaña Voz para poder guardar.</span> : null}
            {avisoGuardado && !sucio ? (
              <span role="status" className="text-xs text-primary">
                Cambios guardados.
              </span>
            ) : null}
            {errorGuardado ? (
              <span role="alert" className="text-xs text-destructive">
                {errorGuardado}
              </span>
            ) : null}
          </div>
        ) : null}
      </PageContainer>

      {vistaPrevia ? (
        <VistaPreviaVoz apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} vozId={guardado.vozId} servicioListo={servicioListo} entorno={entornoVoz ?? entornoNavegador} onCerrar={() => setVistaPrevia(false)} />
      ) : null}
    </div>
  );
}

function Resumen({ config, borrador, conversaciones, onVistaPrevia }: { config: Carga<VozConfig | null>; borrador: VozConfigInput; conversaciones: Carga<readonly ConversacionVoz[]>; onVistaPrevia: () => void }) {
  const voz = buscarVoz(borrador.vozId);
  const tieneMensaje = borrador.mensajeInicial.trim() !== "";
  const pasos: readonly { readonly ok: boolean; readonly texto: string }[] = [
    { ok: voz !== undefined, texto: "Elegir una voz" },
    { ok: borrador.promptSistema.trim() !== "", texto: "Definir el comportamiento del agente" },
    { ok: tieneMensaje && mencionaAsistenteVirtual(borrador.mensajeInicial), texto: "Primer mensaje que se presente como asistente virtual" },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle>Servicio de voz</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-sm">
            {config.estado === "cargando" ? <EstadoCargando etiqueta="Consultando…" /> : null}
            {config.estado === "listo" ? <StatusBadge tone="success" dot={false}>Disponible</StatusBadge> : null}
            {config.estado === "no_disponible" ? <p className="text-muted-foreground">Todavía no disponible para este negocio.</p> : null}
            {config.estado === "error" ? <p className="text-destructive">No se pudo consultar: {config.mensaje}</p> : null}
            {config.estado === "listo" && config.datos === null ? <p className="mt-1 text-xs text-muted-foreground">Esta sucursal aún no tiene configuración guardada.</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle>Voz elegida</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-sm">{voz ? `${voz.nombre} · ${voz.tono}` : <span className="text-muted-foreground">Sin elegir</span>}</CardContent>
        </Card>

        <Card className="sm:col-span-2">
          <CardHeader className="p-4 pb-2">
            <CardTitle>Llamadas</CardTitle>
            <CardDescription>Datos reales del historial; sin cifras de relleno.</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-sm" data-testid="resumen-llamadas">
            {conversaciones.estado === "cargando" ? <EstadoCargando etiqueta="Cargando historial…" /> : null}
            {conversaciones.estado === "no_disponible" ? <EstadoVacio titulo="Sin historial todavía" mensaje="Las llamadas se mostrarán aquí cuando el servicio de voz esté activo." /> : null}
            {conversaciones.estado === "error" ? <p className="text-destructive">No se pudo cargar el historial: {conversaciones.mensaje}</p> : null}
            {conversaciones.estado === "listo" && conversaciones.datos.length === 0 ? <EstadoVacio titulo="Sin llamadas" mensaje="Todavía no hay conversaciones registradas." /> : null}
            {conversaciones.estado === "listo" && conversaciones.datos.length > 0 ? <ResumenLlamadas lista={conversaciones.datos} /> : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle>Antes de salir en vivo</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <ul className="space-y-1.5 text-sm">
            {pasos.map((p) => (
              <li key={p.texto} data-ok={p.ok ? "true" : "false"} className="flex items-center gap-2">
                {p.ok ? (
                  <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-success" strokeWidth={1.75} />
                ) : (
                  <Circle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                )}
                <span className={p.ok ? "text-foreground" : "text-muted-foreground"}>{p.texto}</span>
              </li>
            ))}
          </ul>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onVistaPrevia}>
            Abrir llamada de prueba
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ResumenLlamadas({ lista }: { lista: readonly ConversacionVoz[] }) {
  const conDuracion = lista.filter((c) => c.duracionSegundos !== null);
  const totalSeg = conDuracion.reduce((a, c) => a + (c.duracionSegundos ?? 0), 0);
  const conCosto = lista.filter((c) => c.costoUsd !== null);
  const totalCosto = conCosto.reduce((a, c) => a + (c.costoUsd ?? 0), 0);
  return (
    <dl className="grid grid-cols-3 gap-2">
      <div>
        <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Conversaciones</dt>
        <dd className="text-base font-semibold tabular-nums">{lista.length}</dd>
      </div>
      <div>
        <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Duración total</dt>
        <dd className="text-base font-semibold tabular-nums">{conDuracion.length > 0 ? formatoDuracion(totalSeg) : "—"}</dd>
      </div>
      <div>
        <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Costo total</dt>
        <dd className="text-base font-semibold tabular-nums">{conCosto.length > 0 ? formatoCostoUsd(totalCosto) : "—"}</dd>
      </div>
    </dl>
  );
}

interface VistaPreviaVozProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Voz GUARDADA de la sucursal (la sesión de prueba usa la guardada, no un borrador sin guardar). */
  readonly vozId: string | null;
  readonly servicioListo: boolean;
  readonly entorno: EntornoVoz;
  readonly onCerrar: () => void;
}

/** Llamada de prueba real con el agente configurado. Antes de ofrecer el botón consulta la salud del proveedor: sin credencial muestra el motivo y no simula nada. */
function VistaPreviaVoz({ apiBaseUrl, token, propertyId, vozId, servicioListo, entorno, onCerrar }: VistaPreviaVozProps) {
  const [motivo, setMotivo] = useState<string | null>(servicioListo ? "Comprobando el servicio de voz…" : "No disponible: el servicio de voz todavía no está activo para este negocio.");
  useEffect(() => {
    if (!servicioListo) return;
    let cancelado = false;
    (async () => {
      try {
        const salud = await fetchSaludVoz(fetch, apiBaseUrl, token, propertyId);
        if (!cancelado) setMotivo(salud.ok ? null : `No disponible: ${salud.detalle}`);
      } catch (err) {
        if (!cancelado) setMotivo(err instanceof VozNoDisponibleError ? "No disponible: el servicio de voz todavía no está activo para este negocio." : "No se pudo comprobar el servicio de voz. Cierre y vuelva a abrir la llamada de prueba.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, servicioListo]);

  const fabrica = useMemo(
    () => crearFabricaGeminiLive({ entorno, crearSesion: () => crearSesionPreviewVoz(fetch, apiBaseUrl, token, propertyId, vozId ? { voiceId: vozId } : {}) }),
    [entorno, apiBaseUrl, token, propertyId, vozId],
  );
  const controller = useSesionVoz(fabrica);
  return (
    <VistaPreviaLlamada
      controller={controller}
      nombreAgente="Agente de voz"
      nombreSucursal="Llamada de prueba"
      onCerrar={onCerrar}
      videoSrc={`${import.meta.env.BASE_URL}media/orbe-agente.mp4`}
      {...(motivo ? { motivoNoDisponible: motivo } : {})}
      pie={
        <Callout tone="info" role="note" data-testid="aviso-prueba" className="mx-4 mb-3">
          Es una llamada real de prueba con la voz y el comportamiento guardados. No consulta el menú ni registra pedidos, y usa su micrófono: el navegador le pedirá permiso.
        </Callout>
      }
    />
  );
}
