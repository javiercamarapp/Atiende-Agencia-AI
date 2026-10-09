// PM PR-9 -- Privacidad: seguimiento de solicitudes de derechos ARCO que los clientes abren por WhatsApp o
// por llamada (ver apps/api/src/routes/verticals/restaurantes/privacidad.ts y
// packages/domain-restaurantes/src/privacidad/arco-intent.ts) y configuracion del aviso de privacidad, la
// retencion y el consentimiento de grabacion. Solo owner/admin (el servidor revalida con 403; este gate es
// UX). Documentacion operativa, no asesoria legal.
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, Input, Label, Selector, PageContainer, SolicitudesArcoPanel, SOLICITUD_ARCO_DERECHO_LABEL, SOLICITUD_ARCO_ESTADO_LABEL } from "@atiende/ui";
import type { SolicitudArcoAccion, SolicitudArcoDerecho, SolicitudArcoEstado, SolicitudArcoVista } from "@atiende/ui";
import { actualizarEstadoSolicitudArco, fetchConfiguracionPrivacidad, fetchSolicitudesArco, guardarConfiguracionPrivacidad } from "../lib/privacidad-client.ts";
import type { ConfiguracionPrivacidad } from "../lib/privacidad-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const PRIVACIDAD_ROLES = new Set(["owner", "admin"]);
const PAGE_SIZE = 25;
const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";

function ConfiguracionPrivacidadForm({ apiBaseUrl, token, propertyId }: Pick<RestaurantesShellContext, "apiBaseUrl" | "token" | "propertyId">) {
  const [config, setConfig] = useState<ConfiguracionPrivacidad | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState(false);
  const [responsable, setResponsable] = useState("");
  const [avisoUrl, setAvisoUrl] = useState("");
  const [avisoVersion, setAvisoVersion] = useState("v1");
  const [diasConv, setDiasConv] = useState("180");
  const [diasVoz, setDiasVoz] = useState("30");
  const [exigirConsentimiento, setExigirConsentimiento] = useState(true);

  function aplicar(c: ConfiguracionPrivacidad) {
    setConfig(c);
    setResponsable(c.responsable ?? "");
    setAvisoUrl(c.avisoUrl ?? "");
    setAvisoVersion(c.avisoVersion);
    setDiasConv(String(c.retencionConversacionesDias));
    setDiasVoz(String(c.retencionVozDias));
    setExigirConsentimiento(c.exigirConsentimientoGrabacion);
  }

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const c = await fetchConfiguracionPrivacidad(fetch, apiBaseUrl, token, propertyId);
        if (!cancelado) aplicar(c);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar la configuración de privacidad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    setGuardado(false);
    try {
      const saved = await guardarConfiguracionPrivacidad(fetch, apiBaseUrl, token, propertyId, {
        responsable: responsable.trim() === "" ? null : responsable.trim(),
        avisoUrl: avisoUrl.trim() === "" ? null : avisoUrl.trim(),
        avisoVersion: avisoVersion.trim(),
        retencionConversacionesDias: Number(diasConv),
        retencionVozDias: Number(diasVoz),
        exigirConsentimientoGrabacion: exigirConsentimiento,
      });
      aplicar(saved);
      setGuardado(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la configuración.");
    } finally {
      setGuardando(false);
    }
  }

  if (config === null && error === null) return <EstadoCargando lineas={3} />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Aviso de privacidad, retención y grabación</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={guardar} className="flex flex-col gap-4">
          {config && !config.configurada && (
            <p className="m-0 text-xs text-muted-foreground">Todavía no guardas esta configuración: rigen los valores por defecto (conversaciones 180 días, voz 30 días, consentimiento de grabación exigido).</p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Label className={LABEL_CLASES}>
              Responsable del tratamiento (nombre en el aviso)
              <Input value={responsable} maxLength={200} onChange={(e) => setResponsable(e.target.value)} placeholder="Razón social o nombre comercial" />
            </Label>
            <Label className={LABEL_CLASES}>
              URL del aviso de privacidad integral (https)
              <Input value={avisoUrl} maxLength={500} onChange={(e) => setAvisoUrl(e.target.value)} placeholder="https://tu-sitio.mx/aviso-de-privacidad" />
            </Label>
            <Label className={LABEL_CLASES}>
              Versión del aviso (súbela para mostrarlo otra vez a todos)
              <Input value={avisoVersion} maxLength={32} onChange={(e) => setAvisoVersion(e.target.value)} />
            </Label>
            <Label className={LABEL_CLASES}>
              Conservar conversaciones de WhatsApp (días, 30 a 1095)
              <Input type="number" min={30} max={1095} value={diasConv} onChange={(e) => setDiasConv(e.target.value)} />
            </Label>
            <Label className={LABEL_CLASES}>
              Conservar transcripciones de voz (días, 0 a 365; 0 = no guardar)
              <Input type="number" min={0} max={365} value={diasVoz} onChange={(e) => setDiasVoz(e.target.value)} />
            </Label>
            <Checkbox
              checked={exigirConsentimiento}
              onChange={(e) => setExigirConsentimiento(e.target.checked)}
              label="Exigir consentimiento para grabar la llamada"
              wrapperClassName="sm:self-end"
            />
          </div>
          {error && (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          )}
          {guardado && <span className="text-xs text-muted-foreground">Configuración guardada.</span>}
          <div>
            <Button type="submit" size="sm" loading={guardando}>
              Guardar configuración
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function PrivacidadPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
  const puedeLeer = PRIVACIDAD_ROLES.has(role);
  const [estado, setEstado] = useState<SolicitudArcoEstado | "">("");
  const [derecho, setDerecho] = useState<SolicitudArcoDerecho | "">("");
  const [items, setItems] = useState<readonly SolicitudArcoVista[] | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [plazos, setPlazos] = useState({ respuestaDias: 20, ejecucionDias: 15 });
  const [error, setError] = useState<string | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [reintento, setReintento] = useState(0);
  // Una respuesta vieja nunca se anexa a una lista que ya no corresponde a los filtros vigentes.
  const generacionRef = useRef(0);

  useEffect(() => {
    if (!puedeLeer) return;
    let cancelado = false;
    generacionRef.current += 1;
    setItems(null);
    setError(null);
    (async () => {
      try {
        const pagina = await fetchSolicitudesArco(fetch, apiBaseUrl, token, propertyId, { estado: estado || null, derecho: derecho || null, limit: PAGE_SIZE, offset: 0 });
        if (cancelado) return;
        setDisponible(pagina.disponible);
        setItems(pagina.items);
        setTotal(pagina.total);
        setNextOffset(pagina.nextOffset);
        setPlazos(pagina.plazos);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las solicitudes ARCO.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, estado, derecho, puedeLeer, reintento]);

  async function cargarMas() {
    if (nextOffset === null || cargandoMas) return;
    const generacion = generacionRef.current;
    setCargandoMas(true);
    try {
      const pagina = await fetchSolicitudesArco(fetch, apiBaseUrl, token, propertyId, { estado: estado || null, derecho: derecho || null, limit: PAGE_SIZE, offset: nextOffset });
      if (generacion !== generacionRef.current) return;
      setItems((current) => [...(current ?? []), ...pagina.items]);
      setNextOffset(pagina.nextOffset);
    } catch (err) {
      if (generacion === generacionRef.current) setError(err instanceof Error ? err.message : "No se pudo cargar más.");
    } finally {
      setCargandoMas(false);
    }
  }

  async function cambiarEstado(id: string, accion: SolicitudArcoAccion, nota: string | null) {
    // El error se propaga al panel (que lo muestra junto a la fila), no a esta pantalla.
    await actualizarEstadoSolicitudArco(fetch, apiBaseUrl, token, propertyId, id, accion, nota);
    // Recarga completa: el estado de vencimiento y la nota los calcula el servidor.
    setReintento((n) => n + 1);
  }

  return (
    <PageContainer padding="none">
      <header>
        <h1 className="sr-only">Privacidad</h1>
        <p className="m-0 text-ui text-muted-foreground">
          Solicitudes de derechos ARCO (acceso, rectificación, cancelación y oposición) que tus clientes abren por WhatsApp o por llamada. El agente solo atiende al titular desde su propio número y nunca comparte datos por chat: tú los entregas tras verificar su identidad. En las solicitudes por llamada el identificador de llamada puede falsearse: verifica al titular por otra vía antes de responder.
        </p>
        <p className="m-0 mt-1 text-xs text-muted-foreground">Los plazos son una referencia operativa, no asesoría legal: valida tu aviso de privacidad y tu procedimiento con tu asesor jurídico.</p>
      </header>

      {!puedeLeer ? (
        <Callout tone="info">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> pueden ver las solicitudes ARCO — tu rol actual es <strong className="text-foreground">{role}</strong>.
        </Callout>
      ) : (
        <>
          <ConfiguracionPrivacidadForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />

          <Card>
            <CardHeader>
              <CardTitle>Filtros</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-4">
              <Label className={`${LABEL_CLASES} min-w-[200px]`}>
                Estado
                <Selector value={estado} onChange={(e) => setEstado(e.target.value as SolicitudArcoEstado | "")}>
                  <option value="">Todos</option>
                  {(Object.keys(SOLICITUD_ARCO_ESTADO_LABEL) as SolicitudArcoEstado[]).map((e) => (
                    <option key={e} value={e}>
                      {SOLICITUD_ARCO_ESTADO_LABEL[e]}
                    </option>
                  ))}
                </Selector>
              </Label>
              <Label className={`${LABEL_CLASES} min-w-[180px]`}>
                Derecho
                <Selector value={derecho} onChange={(e) => setDerecho(e.target.value as SolicitudArcoDerecho | "")}>
                  <option value="">Todos</option>
                  {(Object.keys(SOLICITUD_ARCO_DERECHO_LABEL) as SolicitudArcoDerecho[]).map((d) => (
                    <option key={d} value={d}>
                      {SOLICITUD_ARCO_DERECHO_LABEL[d]}
                    </option>
                  ))}
                </Selector>
              </Label>
            </CardContent>
          </Card>

          {error && (
            <EstadoError
              mensaje={error}
              onReintentar={() => {
                setError(null);
                setReintento((n) => n + 1);
              }}
            />
          )}
          {!error && items === null && <EstadoCargando lineas={4} />}
          {!error && items !== null && (
            <SolicitudesArcoPanel solicitudes={items} disponible={disponible} puedeGestionar respuestaDias={plazos.respuestaDias} ejecucionDias={plazos.ejecucionDias} onCambiarEstado={cambiarEstado} />
          )}
          {!error && items !== null && disponible && items.length > 0 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" />
                {items.length} de {total}
              </span>
              {nextOffset !== null && (
                <Button type="button" variant="outline" size="sm" onClick={cargarMas} loading={cargandoMas}>
                  Cargar más
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
