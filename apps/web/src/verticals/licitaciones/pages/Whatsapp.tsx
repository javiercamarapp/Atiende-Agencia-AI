// Configuracion de WhatsApp de licitaciones (L-05): telefono propio, consentimiento (opt-in /
// opt-out), temas de aviso (plazos, convocatorias, fallos, decisiones) y, para quien puede decidir
// go/no-go, pedir la decision de una convocatoria por WhatsApp (botones Go / No-Go).
//
// Honestidad: el opt-in SOLO se activa cuando la persona contesta SI desde su propio numero (el
// servidor lo verifica); esta pantalla nunca marca "activo" por su cuenta. Con la base sin la
// migracion 030 o sin numero remitente configurado lo dice, en vez de fingir que funciona.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer, StatusBadge, statusTone, useConfirm } from "@atiende/ui";
import { fetchOpenTenders } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchWhatsAppSettings, optOutWhatsApp, requestWhatsAppDecision, saveWhatsAppSettings } from "../lib/whatsapp-client.ts";
import type { DecisionRequestResult, WhatsAppContactStatus, WhatsAppSettings } from "../lib/whatsapp-client.ts";
import { CONTACTO_WHATSAPP_TONES } from "../lib/status-tones.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Espejo cosmetico de GO_NO_GO_ROLES (domain-licitaciones/roles.ts); el servidor es la unica barrera.
const GO_NO_GO_ROLES = new Set(["owner", "admin", "analyst", "reviewer"]);

const STATUS_TEXT: Record<WhatsAppContactStatus, string> = { pendiente: "Pendiente de confirmar", activo: "Activo", baja: "Dado de baja" };

const EVENT_TEXT: Record<string, string> = {
  consentimiento_solicitado: "Se envió la confirmación de WhatsApp",
  opt_in: "Avisos activados (contestó SI)",
  baja: "Avisos desactivados",
  token_emitido: "Se pidió una decisión por WhatsApp",
  decision_por_whatsapp: "Decisión registrada por botón",
  token_rechazado_reutilizado: "Se rechazó un botón ya usado",
  token_rechazado_expirado: "Se rechazó un botón expirado",
  token_rechazado_contacto_inactivo: "Se rechazó un botón (avisos desactivados)",
  token_rechazado_telefono_distinto: "Se rechazó un botón desde otro número",
  token_rechazado_rol: "Se rechazó un botón (rol insuficiente)",
};

const DATE_TIME = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });

export function WhatsappPage({ apiBaseUrl, token, propertyId, role }: LicitacionesShellContext) {
  const [settings, setSettings] = useState<WhatsAppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [phone, setPhone] = useState("");
  const [plazos, setPlazos] = useState(true);
  const [convocatorias, setConvocatorias] = useState(true);
  const [fallos, setFallos] = useState(true);
  const [decisiones, setDecisiones] = useState(true);
  const [tenders, setTenders] = useState<readonly TenderSummary[]>([]);
  const [totalAbiertas, setTotalAbiertas] = useState(0);
  const [tenderId, setTenderId] = useState("");
  const [resultado, setResultado] = useState<DecisionRequestResult | null>(null);
  const puedeDecidir = GO_NO_GO_ROLES.has(role);
  const { confirmar, dialogo } = useConfirm();

  function aplicar(s: WhatsAppSettings) {
    setSettings(s);
    if (s.contact) {
      setPhone(s.contact.phoneE164);
      setPlazos(s.contact.notifyPlazos);
      setConvocatorias(s.contact.notifyConvocatorias);
      setFallos(s.contact.notifyFallos);
      setDecisiones(s.contact.notifyDecisiones);
    }
  }

  useEffect(() => {
    let vivo = true;
    fetchWhatsAppSettings(fetch, apiBaseUrl, token, propertyId)
      .then((s) => {
        if (vivo) aplicar(s);
      })
      .catch((err: unknown) => {
        if (vivo) setError(err instanceof Error ? err.message : "No se pudo cargar la configuración de WhatsApp.");
      });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (!puedeDecidir) return;
    let vivo = true;
    fetchOpenTenders(fetch, apiBaseUrl, token, propertyId)
      .then((page) => {
        if (!vivo) return;
        setTenders(page.items);
        setTotalAbiertas(page.total);
      })
      .catch(() => {
        /* la lista de convocatorias es opcional: sin ella solo se oculta el selector */
      });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token, propertyId, puedeDecidir]);

  async function ejecutar(fn: () => Promise<void>) {
    setOcupado(true);
    setError(null);
    setAviso(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setOcupado(false);
    }
  }

  function guardar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ejecutar(async () => {
      const saved = await saveWhatsAppSettings(fetch, apiBaseUrl, token, propertyId, { phone, notifyPlazos: plazos, notifyConvocatorias: convocatorias, notifyFallos: fallos, notifyDecisiones: decisiones });
      setSettings((prev) => ({ available: true, configured: saved.configured, contact: saved.contact, events: prev?.events ?? [] }));
      setAviso(saved.contact.status === "activo" ? "Configuración guardada." : "Guardado. Te enviamos un mensaje de WhatsApp: contesta SI para activar los avisos.");
    });
  }

  async function darDeBaja() {
    // Dejar de recibir avisos es destructivo para el flujo (se pierde la confirmación SI): Cancelar / cerrar NO ejecuta nada.
    const ok = await confirmar({
      titulo: "Dejar de recibir avisos por WhatsApp",
      descripcion: "Dejarás de recibir plazos, convocatorias, fallos y solicitudes de decisión. Para volver a activarlos tendrás que contestar SI de nuevo.",
      tono: "danger",
      confirmar: "Dejar de recibir avisos",
    });
    if (!ok) return;
    await ejecutar(async () => {
      await optOutWhatsApp(fetch, apiBaseUrl, token, propertyId);
      aplicar(await fetchWhatsAppSettings(fetch, apiBaseUrl, token, propertyId));
      setAviso("Dejarás de recibir avisos por WhatsApp.");
    });
  }

  function pedirDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenderId) return;
    void ejecutar(async () => {
      setResultado(await requestWhatsAppDecision(fetch, apiBaseUrl, token, propertyId, tenderId));
    });
  }

  if (!settings && !error) return <EstadoCargando />;
  if (!settings) return <EstadoError mensaje={error ?? "No se pudo cargar."} />;

  const contacto = settings.contact;

  return (
    <PageContainer padding="none" size="sm" className="gap-4 [&>*]:min-w-0">
      <div>
        <h1 className="font-display text-xl font-semibold text-foreground">WhatsApp</h1>
        <p className="text-sm text-muted-foreground">Avisos de plazos, convocatorias y fallos, y decisiones go / no-go con un toque. Tú decides qué recibir y puedes salir cuando quieras.</p>
      </div>

      {!settings.available ? (
        <Callout tone="warning" titulo="Aún no disponible">
          Los avisos por WhatsApp todavía no están habilitados en este ambiente. Cuando se habiliten podrás configurarlos aquí.
        </Callout>
      ) : null}
      {settings.available && !settings.configured ? (
        <Callout tone="warning" titulo="Número de WhatsApp sin configurar">
          Puedes guardar tu teléfono, pero no recibirás mensajes hasta que se configure el número remitente de la plataforma.
        </Callout>
      ) : null}
      {error ? <EstadoError mensaje={error} /> : null}
      {aviso ? <Callout tone="success" titulo="Listo">{aviso}</Callout> : null}

      {settings.available ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Mi WhatsApp
              {contacto ? <StatusBadge tone={statusTone(CONTACTO_WHATSAPP_TONES, contacto.status)}>{STATUS_TEXT[contacto.status]}</StatusBadge> : null}
            </CardTitle>
            <CardDescription>Usamos tu número solo para estos avisos. Para activarlos contesta SI al mensaje de confirmación; para salir, contesta BAJA o usa el botón de abajo.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={guardar}>
              <div className="space-y-1">
                <Label htmlFor="wa-phone">Teléfono (con código de país)</Label>
                <Input id="wa-phone" aria-label="Teléfono de WhatsApp" inputMode="tel" placeholder="+52 1 55 1234 5678" value={phone} onChange={(e) => setPhone(e.target.value)} required />
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Quiero recibir</legend>
                <Checkbox label="Recordatorios de plazos" checked={plazos} onChange={(e) => setPlazos(e.target.checked)} />
                <Checkbox label="Nuevas convocatorias" checked={convocatorias} onChange={(e) => setConvocatorias(e.target.checked)} />
                <Checkbox label="Fallos publicados" checked={fallos} onChange={(e) => setFallos(e.target.checked)} />
                {puedeDecidir ? <Checkbox label="Solicitudes de decisión go / no-go" checked={decisiones} onChange={(e) => setDecisiones(e.target.checked)} /> : null}
              </fieldset>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={ocupado || phone.trim().length === 0}>
                  {contacto ? "Guardar cambios" : "Guardar y confirmar por WhatsApp"}
                </Button>
                {contacto && contacto.status !== "baja" ? (
                  <Button type="button" variant="outline" disabled={ocupado} onClick={() => void darDeBaja()}>
                    Dejar de recibir avisos
                  </Button>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {settings.available && puedeDecidir ? (
        <Card>
          <CardHeader>
            <CardTitle>Pedir una decisión por WhatsApp</CardTitle>
            <CardDescription>Envía los botones Go / No-Go de una convocatoria a quienes tienen WhatsApp activo y rol para decidir. Cada botón sirve una sola vez y vence en 24 horas; la decisión queda a nombre de quien la toca.</CardDescription>
          </CardHeader>
          <CardContent>
            {tenders.length === 0 ? (
              <EstadoVacio titulo="Sin convocatorias" mensaje="Cuando haya convocatorias podrás pedir su decisión desde aquí." compacto />
            ) : (
              <form className="flex flex-wrap items-end gap-2" onSubmit={pedirDecision}>
                <div className="min-w-64 flex-1 space-y-1">
                  <Label htmlFor="wa-tender">Convocatoria</Label>
                  <NativeSelect id="wa-tender" aria-label="Convocatoria" value={tenderId} onChange={(e) => setTenderId(e.target.value)}>
                    <option value="">Elige una convocatoria</option>
                    {tenders.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </NativeSelect>
                  {totalAbiertas > tenders.length && (
                    <p className="text-xs text-muted-foreground">
                      Se listan las {tenders.length} más recientes de {totalAbiertas} convocatorias abiertas.
                    </p>
                  )}
                </div>
                <Button type="submit" disabled={ocupado || !tenderId}>
                  Pedir decisión
                </Button>
              </form>
            )}
            {resultado ? (
              <p className="mt-3 text-sm" role="status">
                {resultado.requested > 0
                  ? `Solicitud enviada a ${resultado.requested} persona(s).`
                  : resultado.eligible === 0
                    ? "Nadie tiene WhatsApp activo con rol para decidir."
                    : "Ya había una solicitud vigente; no se envió otra."}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {settings.available && settings.events.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Bitácora reciente</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {settings.events.map((e) => (
                <li key={e.id} className="flex justify-between gap-2">
                  <span>{EVENT_TEXT[e.event] ?? e.event}</span>
                  <span className="text-muted-foreground">{DATE_TIME.format(new Date(e.createdAt))}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {dialogo}
    </PageContainer>
  );
}
