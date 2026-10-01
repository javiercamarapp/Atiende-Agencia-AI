// Privacidad — aviso de privacidad versionado, consentimientos, ARCO con plazos, incidentes/vulneraciones,
// retención legal y acceso excepcional a identidades bloqueadas (H-02, P0). Vive como pestaña "Privacidad"
// dentro de Identidad.tsx (mismo shell y mismos componentes de @atiende/ui). Consume
// apps/api/src/routes/verticals/hoteles/privacidad.ts.
//
// AVISO: herramienta de registro y control; NO es asesoría legal (el texto viene del servidor junto con la
// lista "un abogado debe confirmar"). El sistema NUNCA envía nada al titular ni a una autoridad: el recordatorio
// de notificar una vulneración es solo informativo.
//
// El servidor es la barrera real de roles (owner/gm gestionan; front-of-house captura consentimientos y reporta
// incidentes); aquí solo se ordena la UX. Base sin la migración 032: estado honesto "no disponible aún".
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Card, CardContent, Checkbox, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, statusTone, toast } from "@atiende/ui";
import {
  ARCO_CANAL_LABELS,
  ARCO_DERECHO_LABELS,
  ARCO_ESTADO_LABELS,
  INCIDENTE_ESTADO_LABELS,
  INCIDENTE_TIPO_LABELS,
  PLAZO_ESTADO_LABELS,
  actIncidente,
  advanceArco,
  decideAcceso,
  etiquetaHoras,
  extendArco,
  fetchAccesos,
  fetchArco,
  fetchAvisos,
  fetchBitacora,
  fetchConfiguracion,
  fetchConsentimientos,
  fetchIncidentes,
  fetchPrivacidadInfo,
  fetchRetenciones,
  openArco,
  publishAviso,
  releaseRetencion,
  reportIncidente,
  revealAccesoExcepcional,
  revokeConsentimiento,
  saveVentanaBloqueo,
  textoPlazo,
} from "../lib/privacidad-client.ts";
import type {
  AccesoSummary,
  ArcoCanal,
  ArcoDerecho,
  ArcoSummary,
  AvisoSummary,
  ConfiguracionPrivacidad,
  ConsentimientoSummary,
  EventoSummary,
  IncidenteSeveridad,
  IncidenteSummary,
  IncidenteTipo,
  Lista,
  PrivacidadInfo,
  RetencionSummary,
} from "../lib/privacidad-client.ts";
import type { DocumentoRevelado } from "../lib/identidad-client.ts";
import { ARCO_PLAZO_TONES } from "../lib/status-tones.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** owner/gm (cosmético: el servidor es la barrera real). */
  readonly isAdmin: boolean;
}

type Sub = "aviso" | "arco" | "incidentes" | "retencion";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

export function PrivacidadTab({ apiBaseUrl, token, propertyId, isAdmin }: Props) {
  const [sub, setSub] = useState<Sub>("aviso");
  const [info, setInfo] = useState<PrivacidadInfo | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchPrivacidadInfo(fetch, apiBaseUrl, token, propertyId)
      .then((i) => !cancelado && setInfo(i))
      .catch(() => undefined); // el aviso legal es informativo: si falla, la pestaña sigue (el texto fijo de abajo cubre lo esencial)
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground" role="note" aria-label="Aviso legal de privacidad">
        <p className="font-medium text-foreground" data-testid="aviso-legal">
          {info?.avisoLegal ?? "Esta pantalla es una herramienta de registro y control. NO es asesoría legal ni garantiza el cumplimiento de la LFPDPPP."}
        </p>
        {info && (
          <details className="mt-2">
            <summary className="cursor-pointer text-foreground">Un abogado debe confirmar ({info.unAbogadoDebeConfirmar.length} puntos)</summary>
            <ul className="mt-1 list-disc pl-5 flex flex-col gap-1">
              {info.unAbogadoDebeConfirmar.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <Tabs value={sub} onValueChange={(v) => setSub(v as Sub)}>
        <TabsList>
          <TabsTrigger value="aviso">Aviso y consentimientos</TabsTrigger>
          {isAdmin && <TabsTrigger value="arco">ARCO</TabsTrigger>}
          <TabsTrigger value="incidentes">Incidentes</TabsTrigger>
          {isAdmin && <TabsTrigger value="retencion">Retención y bloqueo</TabsTrigger>}
        </TabsList>
        <TabsContent value="aviso" className="mt-4">
          <AvisoSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} isAdmin={isAdmin} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="arco" className="mt-4">
            <ArcoSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} isAdmin={isAdmin} />
          </TabsContent>
        )}
        <TabsContent value="incidentes" className="mt-4">
          <IncidentesSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} isAdmin={isAdmin} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="retencion" className="mt-4">
            <RetencionSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} isAdmin={isAdmin} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function NoDisponible() {
  return <EstadoVacio mensaje="Esta sección aún no está disponible en esta base (migración 032 pendiente de aplicar)." />;
}

// ---------------------------------------------------------------------------
// Aviso de privacidad, consentimientos y ventana de bloqueo
// ---------------------------------------------------------------------------
function AvisoSection({ apiBaseUrl, token, propertyId, isAdmin }: Props) {
  const [avisos, setAvisos] = useState<Lista<AvisoSummary> | null>(null);
  const [consents, setConsents] = useState<Lista<ConsentimientoSummary> | null>(null);
  const [config, setConfig] = useState<ConfiguracionPrivacidad | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const [texto, setTexto] = useState("");
  const [obligatorias, setObligatorias] = useState("");
  const [opcionales, setOpcionales] = useState("");
  const [url, setUrl] = useState("");
  const [dias, setDias] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      const [a, c, cfg] = await Promise.all([
        fetchAvisos(fetch, apiBaseUrl, token, propertyId),
        fetchConsentimientos(fetch, apiBaseUrl, token, propertyId),
        isAdmin ? fetchConfiguracion(fetch, apiBaseUrl, token, propertyId) : Promise.resolve(null),
      ]);
      setAvisos(a);
      setConsents(c);
      setConfig(cfg);
      if (cfg) setDias(String(cfg.ventanaBloqueoDias));
    } catch (err) {
      setError(errorMessage(err, "No se pudo cargar el aviso de privacidad."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, isAdmin]);

  async function handlePublish(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await publishAviso(fetch, apiBaseUrl, token, propertyId, {
        version,
        textoSimplificado: texto,
        finalidadesObligatorias: lines(obligatorias),
        finalidadesOpcionales: lines(opcionales),
        urlIntegral: url.trim() || undefined,
      });
      toast.success("Aviso publicado como versión vigente.");
      setVersion("");
      setTexto("");
      setObligatorias("");
      setOpcionales("");
      setUrl("");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo publicar el aviso."));
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke(c: ConsentimientoSummary) {
    const motivo = window.prompt("Motivo de la revocación pedida por el titular (mínimo 10 caracteres):");
    if (motivo === null) return;
    try {
      await revokeConsentimiento(fetch, apiBaseUrl, token, propertyId, c.id, motivo);
      toast.success("Consentimiento revocado.");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo revocar el consentimiento."));
    }
  }

  async function handleWindow(e: FormEvent) {
    e.preventDefault();
    try {
      await saveVentanaBloqueo(fetch, apiBaseUrl, token, propertyId, Number(dias));
      toast.success("Ventana de bloqueo actualizada.");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo guardar la ventana de bloqueo."));
    }
  }

  const vigente = avisos?.items.find((a) => a.vigente) ?? null;
  return (
    <div className="flex flex-col gap-4">
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!avisos && !error && <EstadoCargando etiqueta="Cargando aviso de privacidad…" />}
      {avisos && !avisos.disponible && <NoDisponible />}
      {avisos?.disponible && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">Aviso vigente</p>
            {vigente ? (
              <div data-testid="aviso-vigente" className="text-xs text-muted-foreground flex flex-col gap-1">
                <p>
                  Versión <strong className="text-foreground">{vigente.version}</strong> · publicado {vigente.publicadoEn}
                </p>
                <p>{vigente.textoSimplificado}</p>
                <p>Obligatorias: {vigente.finalidadesObligatorias.join("; ")}</p>
                <p>Opcionales: {vigente.finalidadesOpcionales.length > 0 ? vigente.finalidadesOpcionales.join("; ") : "ninguna"}</p>
                {vigente.urlIntegral && <p>Aviso integral: {vigente.urlIntegral}</p>}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Todavía no hay un aviso publicado: sin versión vigente no se puede registrar el consentimiento ligado a la captura.</p>
            )}
          </CardContent>
        </Card>
      )}
      {avisos?.disponible && isAdmin && (
        <Card>
          <CardContent className="p-4">
            <form onSubmit={(e) => void handlePublish(e)} className="grid gap-3 sm:grid-cols-2" aria-label="Publicar aviso de privacidad">
              <div>
                <Label htmlFor="aviso-version">Versión nueva</Label>
                <Input id="aviso-version" value={version} onChange={(e) => setVersion(e.target.value)} required maxLength={40} />
              </div>
              <div>
                <Label htmlFor="aviso-url">Enlace al aviso integral (https)</Label>
                <Input id="aviso-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="aviso-texto">Aviso simplificado (se muestra en el punto de captura)</Label>
                <Textarea id="aviso-texto" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} required minLength={20} maxLength={2000} />
              </div>
              <div>
                <Label htmlFor="aviso-obligatorias">Finalidades obligatorias (una por línea)</Label>
                <Textarea id="aviso-obligatorias" rows={3} value={obligatorias} onChange={(e) => setObligatorias(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="aviso-opcionales">Finalidades opcionales (una por línea; casilla distinta y sin marcar)</Label>
                <Textarea id="aviso-opcionales" rows={3} value={opcionales} onChange={(e) => setOpcionales(e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" disabled={saving}>
                  {saving ? "Publicando…" : "Publicar versión nueva"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      {isAdmin && config?.disponible && (
        <Card>
          <CardContent className="p-4">
            <form onSubmit={(e) => void handleWindow(e)} className="flex items-end gap-3 flex-wrap" aria-label="Ventana de bloqueo">
              <div>
                <Label htmlFor="ventana-dias">Ventana de bloqueo antes de purgar (días, 3 a 30)</Label>
                <Input id="ventana-dias" type="number" min={3} max={30} step={1} value={dias} onChange={(e) => setDias(e.target.value)} className="w-32" />
              </div>
              <Button type="submit" variant="outline">
                Guardar
              </Button>
              <p className="text-xs text-muted-foreground">
                {config.esDefault ? "Valor por defecto (7 días)." : `Cambiado por ${config.actualizadoPor ?? "—"} el ${config.actualizadoEn ?? "—"}.`} Durante la ventana la identidad no tiene acceso operativo.
              </p>
            </form>
          </CardContent>
        </Card>
      )}
      {consents?.disponible && (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-foreground">Consentimientos registrados</p>
          {consents.items.length === 0 && <EstadoVacio mensaje="Todavía no hay consentimientos registrados." />}
          {consents.items.map((c) => (
            <Card key={c.id}>
              <CardContent className="p-4 flex flex-col gap-1">
                <div className="flex justify-between gap-2 flex-wrap">
                  <p className="text-sm text-foreground">
                    Aviso {c.versionAviso} · {c.canal} · {c.metodo}
                    {c.datosSensibles ? " · datos sensibles (expreso y por escrito)" : ""}
                  </p>
                  <StatusBadge tone={c.revocadoEn ? "neutral" : "success"}>{c.revocadoEn ? "Revocado" : "Vigente"}</StatusBadge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Huésped {c.huespedId} · {c.consentidoEn} · obligatorias: {c.finalidadesObligatorias.join("; ")}
                  {c.finalidadesOpcionales.length > 0 ? ` · opcionales: ${c.finalidadesOpcionales.join("; ")}` : ""}
                </p>
                {c.revocadoEn && <p className="text-xs text-muted-foreground">Revocado: {c.motivoRevocacion}</p>}
                {!c.revocadoEn && (
                  <div className="mt-1">
                    <Button type="button" size="sm" variant="outline" onClick={() => void handleRevoke(c)}>
                      Revocar consentimiento
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ARCO
// ---------------------------------------------------------------------------

function ArcoSection({ apiBaseUrl, token, propertyId }: Props) {
  const [data, setData] = useState<(Lista<ArcoSummary> & { hoy: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [derecho, setDerecho] = useState<ArcoDerecho>("acceso");
  const [solicitante, setSolicitante] = useState("");
  const [canal, setCanal] = useState<ArcoCanal>("mostrador");
  const [contacto, setContacto] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      setData(await fetchArco(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(errorMessage(err, "No se pudieron cargar las solicitudes ARCO."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleOpen(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await openArco(fetch, apiBaseUrl, token, propertyId, { derecho, solicitante, canal, contacto: contacto.trim() || undefined, descripcion: descripcion.trim() || undefined });
      toast.success("Solicitud ARCO registrada; el plazo de respuesta ya corre.");
      setSolicitante("");
      setContacto("");
      setDescripcion("");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo registrar la solicitud."));
    } finally {
      setSaving(false);
    }
  }

  async function handleAdvance(a: ArcoSummary, estado: "en_revision" | "procedente" | "improcedente" | "ejecutada") {
    const nota = window.prompt(`Nota para pasar la solicitud a "${ARCO_ESTADO_LABELS[estado]}" (10 a 300 caracteres; queda en la bitácora):`);
    if (nota === null) return;
    try {
      await advanceArco(fetch, apiBaseUrl, token, propertyId, a.id, estado, nota);
      toast.success(`Solicitud ${ARCO_ESTADO_LABELS[estado].toLowerCase()}.`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo actualizar la solicitud."));
    }
  }

  async function handleExtend(a: ArcoSummary) {
    const motivo = window.prompt(`Motivo documentado de la prórroga (+${a.prorrogaDisponible.dias} días; solo se puede usar una vez):`);
    if (motivo === null) return;
    try {
      await extendArco(fetch, apiBaseUrl, token, propertyId, a.id, motivo);
      toast.success("Prórroga registrada.");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo registrar la prórroga."));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Plazos (días naturales; un abogado debe confirmar el cómputo): 20 días para responder y 15 para ejecutar; una prórroga por igual plazo, una sola vez y con motivo. Una cancelación procedente bloquea la identidad ligada; la supresión pasa por la ventana de bloqueo y no ocurre si hay retención legal.
      </p>
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!data && !error && <EstadoCargando etiqueta="Cargando solicitudes ARCO…" />}
      {data && !data.disponible && <NoDisponible />}
      {data?.disponible && (
        <Card>
          <CardContent className="p-4">
            <form onSubmit={(e) => void handleOpen(e)} className="grid gap-3 sm:grid-cols-2" aria-label="Registrar solicitud ARCO">
              <div>
                <Label htmlFor="arco-derecho">Derecho</Label>
                <NativeSelect id="arco-derecho" value={derecho} onChange={(e) => setDerecho(e.target.value as ArcoDerecho)}>
                  {(Object.keys(ARCO_DERECHO_LABELS) as ArcoDerecho[]).map((d) => (
                    <option key={d} value={d}>
                      {ARCO_DERECHO_LABELS[d]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div>
                <Label htmlFor="arco-canal">Canal de recepción</Label>
                <NativeSelect id="arco-canal" value={canal} onChange={(e) => setCanal(e.target.value as ArcoCanal)}>
                  {(Object.keys(ARCO_CANAL_LABELS) as ArcoCanal[]).map((c) => (
                    <option key={c} value={c}>
                      {ARCO_CANAL_LABELS[c]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div>
                <Label htmlFor="arco-solicitante">Titular que solicita</Label>
                <Input id="arco-solicitante" value={solicitante} onChange={(e) => setSolicitante(e.target.value)} required minLength={2} />
              </div>
              <div>
                <Label htmlFor="arco-contacto">Contacto (opcional)</Label>
                <Input id="arco-contacto" value={contacto} onChange={(e) => setContacto(e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="arco-descripcion">Descripción (opcional)</Label>
                <Input id="arco-descripcion" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" disabled={saving || solicitante.trim().length < 2}>
                  {saving ? "Registrando…" : "Registrar solicitud"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      {data?.disponible && data.items.length === 0 && <EstadoVacio mensaje="No hay solicitudes ARCO registradas." />}
      {data?.items.map((a) => (
        <Card key={a.id}>
          <CardContent className="p-4 flex flex-col gap-2">
            <div className="flex justify-between gap-2 flex-wrap">
              <div>
                <p className="font-medium text-foreground">
                  {a.folio} · {ARCO_DERECHO_LABELS[a.derecho]} · {a.solicitante}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground" data-testid="plazo-arco">
                  {textoPlazo(a.plazo)} · recibida {a.recibidaEn} por {ARCO_CANAL_LABELS[a.canal]}
                </p>
              </div>
              <div className="flex gap-1 self-start">
                <Badge variant="secondary">{ARCO_ESTADO_LABELS[a.estado]}</Badge>
                <StatusBadge tone={statusTone(ARCO_PLAZO_TONES, a.plazo.estado)}>{PLAZO_ESTADO_LABELS[a.plazo.estado]}</StatusBadge>
              </div>
            </div>
            {a.descripcion && <p className="text-xs text-muted-foreground">{a.descripcion}</p>}
            {a.notaDecision && <p className="text-xs text-muted-foreground">Última nota: {a.notaDecision}</p>}
            {a.prorroga && <p className="text-xs text-muted-foreground">Prórroga de {a.prorroga.fase}: {a.prorroga.motivo}</p>}
            <div className="flex gap-2 flex-wrap mt-1">
              {a.estado === "recibida" && (
                <Button type="button" size="sm" variant="outline" onClick={() => void handleAdvance(a, "en_revision")}>
                  Pasar a revisión
                </Button>
              )}
              {(a.estado === "recibida" || a.estado === "en_revision") && (
                <>
                  <Button type="button" size="sm" variant="outline" onClick={() => void handleAdvance(a, "procedente")}>
                    Procedente
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => void handleAdvance(a, "improcedente")}>
                    Improcedente
                  </Button>
                </>
              )}
              {a.estado === "procedente" && (
                <Button type="button" size="sm" onClick={() => void handleAdvance(a, "ejecutada")}>
                  Marcar ejecutada
                </Button>
              )}
              {a.prorrogaDisponible.disponible && (
                <Button type="button" size="sm" variant="outline" onClick={() => void handleExtend(a)}>
                  Prórroga (+{a.prorrogaDisponible.dias} d)
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Incidentes / vulneraciones
// ---------------------------------------------------------------------------
function IncidentesSection({ apiBaseUrl, token, propertyId, isAdmin }: Props) {
  const [data, setData] = useState<Lista<IncidenteSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tipo, setTipo] = useState<IncidenteTipo>("acceso_no_autorizado");
  const [severidad, setSeveridad] = useState<IncidenteSeveridad>("media");
  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [riesgo, setRiesgo] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    if (!isAdmin) return; // solo owner/gm leen; front-of-house reporta
    setError(null);
    try {
      setData(await fetchIncidentes(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(errorMessage(err, "No se pudieron cargar los incidentes."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, isAdmin]);

  async function handleReport(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await reportIncidente(fetch, apiBaseUrl, token, propertyId, { tipo, severidad, titulo, descripcion, riesgoSignificativo: riesgo });
      toast.success("Incidente registrado. Avisa a owner/gm.");
      setTitulo("");
      setDescripcion("");
      setRiesgo(false);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo registrar el incidente."));
    } finally {
      setSaving(false);
    }
  }

  async function act(i: IncidenteSummary, accion: "contener" | "registrar_notificacion" | "cerrar") {
    try {
      if (accion === "contener") {
        const nota = window.prompt("Cómo se contuvo (opcional):");
        if (nota === null) return;
        await actIncidente(fetch, apiBaseUrl, token, propertyId, i.id, { accion, nota: nota || undefined });
      } else if (accion === "registrar_notificacion") {
        const canal = window.prompt("Canal por el que SE NOTIFICÓ al titular (el sistema no envía nada; solo se registra):");
        if (canal === null) return;
        const constancia = window.prompt("Constancia o referencia de la notificación:");
        if (constancia === null) return;
        await actIncidente(fetch, apiBaseUrl, token, propertyId, i.id, { accion, canal, constancia });
      } else {
        const nota = window.prompt("Nota de cierre (10 a 300 caracteres):");
        if (nota === null) return;
        let motivoNoNotificar: string | undefined;
        if (i.riesgoSignificativo && !i.notificacion) {
          const m = window.prompt("Hay riesgo significativo y no se registró la notificación al titular: indica el motivo de no notificar (10 a 300 caracteres):");
          if (m === null) return;
          motivoNoNotificar = m;
        }
        await actIncidente(fetch, apiBaseUrl, token, propertyId, i.id, { accion, nota, motivoNoNotificar });
      }
      toast.success("Incidente actualizado.");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo actualizar el incidente."));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Registro de vulneraciones de datos. Si afectan de forma significativa derechos patrimoniales o morales, la ley pide notificar al titular de inmediato (art. 19): el sistema solo lo recuerda y lleva el registro; NO envía ninguna notificación.
      </p>
      <Card>
        <CardContent className="p-4">
          <form onSubmit={(e) => void handleReport(e)} className="grid gap-3 sm:grid-cols-2" aria-label="Reportar incidente">
            <div>
              <Label htmlFor="inc-tipo">Tipo</Label>
              <NativeSelect id="inc-tipo" value={tipo} onChange={(e) => setTipo(e.target.value as IncidenteTipo)}>
                {(Object.keys(INCIDENTE_TIPO_LABELS) as IncidenteTipo[]).map((t) => (
                  <option key={t} value={t}>
                    {INCIDENTE_TIPO_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="inc-severidad">Severidad</Label>
              <NativeSelect id="inc-severidad" value={severidad} onChange={(e) => setSeveridad(e.target.value as IncidenteSeveridad)}>
                <option value="baja">Baja</option>
                <option value="media">Media</option>
                <option value="alta">Alta</option>
              </NativeSelect>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="inc-titulo">Título</Label>
              <Input id="inc-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} required minLength={3} maxLength={120} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="inc-descripcion">Qué pasó (10 a 1000 caracteres)</Label>
              <Textarea id="inc-descripcion" rows={3} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} required minLength={10} maxLength={1000} />
            </div>
            <label className="sm:col-span-2 flex items-center gap-2 text-xs text-foreground">
              <Checkbox checked={riesgo} onChange={(e) => setRiesgo(e.target.checked)} />
              Puede afectar de forma significativa derechos patrimoniales o morales del titular (lo decide el hotel con su abogado)
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={saving || titulo.trim().length < 3 || descripcion.trim().length < 10}>
                {saving ? "Registrando…" : "Reportar incidente"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {!isAdmin && <p className="text-xs text-muted-foreground">Solo owner/gm ven y gestionan los incidentes reportados.</p>}
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {isAdmin && !data && !error && <EstadoCargando etiqueta="Cargando incidentes…" />}
      {data && !data.disponible && <NoDisponible />}
      {data?.disponible && data.items.length === 0 && <EstadoVacio mensaje="No hay incidentes registrados." />}
      {data?.items.map((i) => (
        <Card key={i.id}>
          <CardContent className="p-4 flex flex-col gap-2">
            <div className="flex justify-between gap-2 flex-wrap">
              <div>
                <p className="font-medium text-foreground">
                  {i.folio} · {i.titulo}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {INCIDENTE_TIPO_LABELS[i.tipo]} · severidad {i.severidad} · detectado {i.detectadoEn}
                  {i.afectados !== null ? ` · ${i.afectados} afectado(s)` : ""}
                </p>
              </div>
              <StatusBadge tone={i.estado === "cerrada" ? "neutral" : "warning"} className="self-start">
                {INCIDENTE_ESTADO_LABELS[i.estado]}
              </StatusBadge>
            </div>
            <p className="text-xs text-muted-foreground">{i.descripcion}</p>
            {i.recordatorio.requerido && (
              <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-2 text-xs text-foreground" data-testid="recordatorio-notificar">
                {i.recordatorio.mensaje} ({etiquetaHoras(i.recordatorio.horasDesdeDeteccion)})
              </div>
            )}
            {i.notificacion && (
              <p className="text-xs text-muted-foreground">
                Titular notificado el {i.notificacion.en} por {i.notificacion.canal} (constancia: {i.notificacion.constancia}).
              </p>
            )}
            {i.motivoNoNotificar && <p className="text-xs text-muted-foreground">No se notificó: {i.motivoNoNotificar}</p>}
            {i.estado !== "cerrada" && (
              <div className="flex gap-2 flex-wrap mt-1">
                {i.estado === "detectada" && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void act(i, "contener")}>
                    Marcar contenido
                  </Button>
                )}
                {!i.notificacion && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void act(i, "registrar_notificacion")}>
                    Registrar notificación al titular
                  </Button>
                )}
                <Button type="button" size="sm" onClick={() => void act(i, "cerrar")}>
                  Cerrar incidente
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Retención legal, acceso excepcional y bitácora
// ---------------------------------------------------------------------------
const REVISION_LABELS: Record<RetencionSummary["revision"], string> = { vigente: "Revisión vigente", revision_proxima: "Revisión próxima", revision_vencida: "Revisión vencida", liberada: "Liberada" };

function RetencionSection({ apiBaseUrl, token, propertyId }: Props) {
  const [holds, setHolds] = useState<Lista<RetencionSummary> | null>(null);
  const [accesos, setAccesos] = useState<Lista<AccesoSummary> | null>(null);
  const [bitacora, setBitacora] = useState<Lista<EventoSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ readonly id: string; readonly doc: DocumentoRevelado } | null>(null);

  async function load() {
    setError(null);
    try {
      const [h, a, b] = await Promise.all([
        fetchRetenciones(fetch, apiBaseUrl, token, propertyId),
        fetchAccesos(fetch, apiBaseUrl, token, propertyId),
        fetchBitacora(fetch, apiBaseUrl, token, propertyId),
      ]);
      setHolds(h);
      setAccesos(a);
      setBitacora(b);
    } catch (err) {
      setError(errorMessage(err, "No se pudo cargar la retención y el bloqueo."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleRelease(h: RetencionSummary) {
    const nota = window.prompt(`Nota para liberar la retención del caso ${h.folio} (10 a 300 caracteres). Tras liberarla, la identidad podrá purgarse al vencer su ventana:`);
    if (nota === null) return;
    try {
      await releaseRetencion(fetch, apiBaseUrl, token, propertyId, h.id, nota);
      toast.success("Retención liberada.");
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo liberar la retención."));
    }
  }

  async function handleDecide(a: AccesoSummary, aprobar: boolean) {
    const nota = window.prompt(aprobar ? "Nota de aprobación (la aprobación caduca en 2 horas y se usa una sola vez):" : "Motivo del rechazo (opcional):");
    if (nota === null) return;
    try {
      await decideAcceso(fetch, apiBaseUrl, token, propertyId, a.id, aprobar, nota || undefined);
      toast.success(aprobar ? "Acceso excepcional aprobado." : "Acceso excepcional rechazado.");
      await load();
    } catch (err) {
      // Doble control: si quien decide es quien pidió, el servidor responde 403 con el motivo.
      toast.error(errorMessage(err, "No se pudo resolver la solicitud."));
    }
  }

  async function handleReveal(a: AccesoSummary) {
    try {
      setRevealed({ id: a.id, doc: await revealAccesoExcepcional(fetch, apiBaseUrl, token, propertyId, a.id) });
      await load();
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo revelar el documento."));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Una identidad vencida o con purga aprobada pasa primero a <strong>bloqueada</strong> (sin acceso operativo) y solo se purga al vencer la ventana y si no tiene una retención legal activa. Desde la bóveda puedes bloquear, aplicar una retención legal (folio, motivo y quién autoriza) o pedir acceso excepcional (doble control).
      </p>
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!holds && !error && <EstadoCargando etiqueta="Cargando retenciones…" />}
      {holds && !holds.disponible && <NoDisponible />}
      {holds?.disponible && (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-foreground">Retenciones legales</p>
          {holds.items.length === 0 && <EstadoVacio mensaje="No hay retenciones legales." />}
          {holds.items.map((h) => (
            <Card key={h.id}>
              <CardContent className="p-4 flex flex-col gap-1">
                <div className="flex justify-between gap-2 flex-wrap">
                  <p className="font-medium text-foreground">
                    Caso {h.folio} · identidad {h.identidadId}
                  </p>
                  <StatusBadge tone={h.estado === "activa" ? "info" : "neutral"}>{h.estado === "activa" ? "Activa" : "Liberada"}</StatusBadge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {h.motivo} · autoriza: {h.autorizacion}
                </p>
                <p className="text-xs text-muted-foreground">
                  {REVISION_LABELS[h.revision]} · revisar antes del {h.revisarAntesDe}
                </p>
                {h.estado === "activa" && (
                  <div className="mt-1">
                    <Button type="button" size="sm" variant="outline" onClick={() => void handleRelease(h)}>
                      Liberar retención
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {accesos?.disponible && (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-foreground">Accesos excepcionales a identidades bloqueadas</p>
          <p className="text-xs text-muted-foreground">Doble control: quien pide el acceso no puede aprobarlo; la aprobación caduca a las 2 horas y se consume una sola vez, solo por quien la pidió.</p>
          {accesos.items.length === 0 && <EstadoVacio mensaje="No hay solicitudes de acceso excepcional." />}
          {accesos.items.map((a) => (
            <Card key={a.id}>
              <CardContent className="p-4 flex flex-col gap-1">
                <div className="flex justify-between gap-2 flex-wrap">
                  <p className="text-sm text-foreground">
                    Identidad {a.identidadId} · {a.motivo}
                  </p>
                  <StatusBadge tone={a.estado === "pendiente" || a.estado === "aprobada" ? "info" : "neutral"}>{a.estado}</StatusBadge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Solicitada por {a.solicitadaPor}
                  {a.caducaEn ? ` · caduca ${a.caducaEn}` : ""}
                </p>
                <div className="flex gap-2 flex-wrap mt-1">
                  {a.estado === "pendiente" && (
                    <>
                      <Button type="button" size="sm" onClick={() => void handleDecide(a, true)}>
                        Aprobar acceso
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => void handleDecide(a, false)}>
                        Rechazar acceso
                      </Button>
                    </>
                  )}
                  {a.estado === "aprobada" && (
                    <Button type="button" size="sm" variant="outline" onClick={() => void handleReveal(a)}>
                      Revelar documento (un solo uso)
                    </Button>
                  )}
                </div>
                {revealed?.id === a.id && (
                  <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm mt-2" data-testid="documento-acceso-excepcional">
                    <p>
                      <span className="text-muted-foreground">Nombre:</span> {revealed.doc.nombreCompleto}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Documento:</span> {revealed.doc.numeroDocumento}
                    </p>
                    <div className="mt-1">
                      <Button type="button" variant="outline" size="sm" onClick={() => setRevealed(null)}>
                        Ocultar
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {bitacora?.disponible && bitacora.items.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">Bitácora de privacidad (últimos 50)</p>
          <ul className="text-xs text-muted-foreground flex flex-col gap-0.5">
            {bitacora.items.map((e) => (
              <li key={e.id}>
                {e.creadaEn} · {e.tipo} · {e.accion}
                {e.nota ? ` · ${e.nota}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
