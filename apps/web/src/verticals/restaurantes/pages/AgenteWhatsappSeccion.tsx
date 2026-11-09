// R-10: editor del agente de WhatsApp dentro de Configuracion (solo owner/admin; el servidor, admin-config.ts + RLS, es el
// enforcement real). Edita SOLO lo que no toca las reglas duras: nombre, tono, tiempos de entrega, saludo, salsas incluidas,
// promociones y los motivos de escalacion que se pueden apagar. Antes de guardar se ve el prompt resultante (solo lectura) y
// las diferencias contra lo vigente. Cada guardado queda en un historial versionado; "volver al perfil por defecto" deja los
// textos en blanco. Contrato: lib/agente-whatsapp-client.ts.
import { useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, FormField, Input, NativeSelect, StatusBadge, Textarea, localeActivo, useConfirm, useT } from "@atiende/ui";
import { restaurantesAgenteWhatsapp } from "@atiende/ui/i18n/restaurantes/agenteWhatsapp";
import {
  MOTIVO_LABEL,
  PERFIL_LABEL,
  TONO_LABEL,
  camposCambiados,
  fetchAgenteWhatsapp,
  fetchHistorialAgente,
  fetchOpcionesAgente,
  formDesdeFoto,
  formDesdeWire,
  guardarAgenteWhatsapp,
  restablecerAgente,
  vistaPreviaAgente,
} from "../lib/agente-whatsapp-client.ts";
import { WidgetWhatsApp } from "../preview/WidgetWhatsApp.tsx";
import { ConocimientoNegocio } from "../components/ConocimientoNegocio.tsx";
import { fetchOrgMembers } from "../lib/staff-client.ts";
import type { AgenteWhatsappWire, AlcanceAgente, ConfigAgenteForm, HistorialEntradaWire, OpcionesAgenteWire, PerfilAgente, TonoAgente, VistaPreviaWire } from "../lib/agente-whatsapp-client.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Nombre de la sucursal activa: encabezado del chat de prueba. */
  readonly nombreSucursal?: string;
}

function fecha(iso: string): string {
  try {
    return new Date(iso).toLocaleString(localeActivo(), { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function AgenteWhatsappSeccion({ apiBaseUrl, token, propertyId, nombreSucursal }: Props) {
  const t = useT(restaurantesAgenteWhatsapp);
  const { confirmar, dialogo } = useConfirm();
  const [datos, setDatos] = useState<AgenteWhatsappWire | null>(null);
  const [opciones, setOpciones] = useState<OpcionesAgenteWire | null>(null);
  const [alcance, setAlcance] = useState<AlcanceAgente>("organizacion");
  const [form, setForm] = useState<ConfigAgenteForm>(() => formDesdeWire(null));
  const [historial, setHistorial] = useState<readonly HistorialEntradaWire[]>([]);
  // La base solo deja ver el nombre de uno mismo (RLS de core.staff_user): el de las demas personas sale de la lista del equipo.
  const [nombresEquipo, setNombresEquipo] = useState<Readonly<Record<string, string>>>({});
  const [previa, setPrevia] = useState<VistaPreviaWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Tono del aviso: exito (guardado, restablecido) o fallo; antes se deducia del texto en espanol.
  const [avisoExito, setAvisoExito] = useState(false);
  const [conflicto, setConflicto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [recarga, setRecarga] = useState(0);

  const actual = datos ? (alcance === "sucursal" ? datos.sucursal : datos.organizacion) : null;
  /** Version que la pantalla vio: 0 = no habia fila; null = base sin la migracion 033. */
  const versionVista = actual === null ? (datos?.organizacion?.version === null || datos?.sucursal?.version === null ? null : 0) : actual.version;
  const sin033 = Boolean((datos?.organizacion && datos.organizacion.version === null) || (datos?.sucursal && datos.sucursal.version === null));
  const pm = form.perfil === "taqueria_pm";

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const [d, o] = await Promise.all([fetchAgenteWhatsapp(fetch, apiBaseUrl, token, propertyId), fetchOpcionesAgente(fetch, apiBaseUrl, token, propertyId)]);
        if (cancelado) return;
        setDatos(d);
        setOpciones(o);
        setError(null);
        setConflicto(false);
      } catch (err) {
        if (!cancelado) setError(mensaje(err, t("restaurantes.agenteWhatsapp.errorCarga")));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, recarga]);

  // Al cambiar de alcance (o recargar) el formulario parte de lo vigente en ese alcance; una sucursal sin config propia parte de la de la organizacion.
  useEffect(() => {
    if (!datos) return;
    setForm(formDesdeWire((alcance === "sucursal" ? datos.sucursal : null) ?? datos.organizacion));
    setPrevia(null);
  }, [datos, alcance]);

  useEffect(() => {
    if (!datos || sin033) {
      setHistorial([]);
      return;
    }
    let cancelado = false;
    fetchHistorialAgente(fetch, apiBaseUrl, token, propertyId, alcance)
      .then((h) => {
        if (!cancelado) setHistorial(h);
      })
      .catch(() => {
        if (!cancelado) setHistorial([]);
      });
    return () => {
      cancelado = true;
    };
  }, [datos, alcance, sin033, apiBaseUrl, token, propertyId]);

  useEffect(() => {
    let cancelado = false;
    fetchOrgMembers(fetch, apiBaseUrl, token, propertyId)
      .then((m) => {
        if (!cancelado) setNombresEquipo(Object.fromEntries((Array.isArray(m) ? m : []).map((x) => [x.id, x.fullName])));
      })
      .catch(() => {
        if (!cancelado) setNombresEquipo({});
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  const defaults = useMemo(() => opciones?.perfiles.find((p) => p.perfil === form.perfil) ?? null, [opciones, form.perfil]);

  function cambiar<K extends keyof ConfigAgenteForm>(campo: K, valor: ConfigAgenteForm[K]) {
    setForm((f) => ({ ...f, [campo]: valor }));
    setPrevia(null);
    setAviso(null);
  }

  function falloDeEscritura(err: unknown, porDefecto: string) {
    const texto = mensaje(err, porDefecto);
    setError(null);
    setAviso(texto);
    setAvisoExito(false);
    setConflicto(/cambió mientras|otra versión|conflict/i.test(texto));
  }

  async function revisar() {
    setOcupado(true);
    setAviso(null);
    try {
      setPrevia(await vistaPreviaAgente(fetch, apiBaseUrl, token, propertyId, form, alcance));
    } catch (err) {
      falloDeEscritura(err, t("restaurantes.agenteWhatsapp.errorVistaPrevia"));
    } finally {
      setOcupado(false);
    }
  }

  async function guardar() {
    setOcupado(true);
    setAviso(null);
    try {
      await guardarAgenteWhatsapp(fetch, apiBaseUrl, token, propertyId, form, alcance, versionVista);
      setAviso(t("restaurantes.agenteWhatsapp.guardado"));
      setAvisoExito(true);
      setConflicto(false);
      setRecarga((n) => n + 1);
    } catch (err) {
      falloDeEscritura(err, t("restaurantes.agenteWhatsapp.errorGuardar"));
    } finally {
      setOcupado(false);
    }
  }

  async function restablecer() {
    const ok = await confirmar({
      titulo: t("restaurantes.agenteWhatsapp.restablecer"),
      descripcion: t("restaurantes.agenteWhatsapp.restablecerDescripcion"),
      tono: "danger",
      confirmar: t("restaurantes.agenteWhatsapp.restablecer"),
    });
    if (!ok) return;
    setOcupado(true);
    setAviso(null);
    try {
      await restablecerAgente(fetch, apiBaseUrl, token, propertyId, alcance, versionVista);
      setAviso(t("restaurantes.agenteWhatsapp.restablecido"));
      setAvisoExito(true);
      setRecarga((n) => n + 1);
    } catch (err) {
      falloDeEscritura(err, t("restaurantes.agenteWhatsapp.errorRestablecer"));
    } finally {
      setOcupado(false);
    }
  }

  const lim = opciones?.limites;
  const contador = (valor: string, max: number | undefined) => (max ? `${valor.length}/${max}` : undefined);

  return (
    <div className="flex flex-col gap-4">
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-4 w-4" strokeWidth={1.75} />
          {t("restaurantes.agenteWhatsapp.titulo")}
        </CardTitle>
        <CardDescription>
          {t("restaurantes.agenteWhatsapp.descripcion")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4 pt-0">
        {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
        {!datos && !error && <EstadoCargando etiqueta={t("restaurantes.agenteWhatsapp.cargando")} />}
        {datos && opciones && (
          <>
            {sin033 && (
              <Callout tone="warning" titulo={t("restaurantes.agenteWhatsapp.edicionLimitada")}>
                {t("restaurantes.agenteWhatsapp.edicionLimitadaTexto")}
              </Callout>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t("restaurantes.agenteWhatsapp.aplicarA")}>
                <NativeSelect value={alcance} onChange={(e) => setAlcance(e.target.value as AlcanceAgente)}>
                  <option value="organizacion">{t("restaurantes.agenteWhatsapp.todaOrganizacion")}</option>
                  <option value="sucursal">{t("restaurantes.agenteWhatsapp.soloSucursal")}</option>
                </NativeSelect>
              </FormField>
              <FormField label={t("restaurantes.agenteWhatsapp.perfilAgente")}>
                <NativeSelect value={form.perfil} onChange={(e) => cambiar("perfil", e.target.value as PerfilAgente)}>
                  {(Object.keys(PERFIL_LABEL) as PerfilAgente[]).map((p) => (
                    <option key={p} value={p}>
                      {PERFIL_LABEL[p]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label={t("restaurantes.agenteWhatsapp.campo.agentName")} hint={contador(form.agentName, lim?.agentName)}>
                <Input value={form.agentName} maxLength={lim?.agentName} placeholder={defaults?.agentName ?? t("restaurantes.agenteWhatsapp.comoSePresenta")} onChange={(e) => cambiar("agentName", e.target.value)} />
              </FormField>
              <FormField label={t("restaurantes.agenteWhatsapp.campo.businessName")} hint={contador(form.businessName, lim?.businessName)}>
                <Input value={form.businessName} maxLength={lim?.businessName} placeholder={defaults?.businessName} onChange={(e) => cambiar("businessName", e.target.value)} />
              </FormField>
              <FormField label={t("restaurantes.agenteWhatsapp.campo.toneStyle")}>
                <NativeSelect value={form.toneStyle} onChange={(e) => cambiar("toneStyle", e.target.value as TonoAgente | "")}>
                  <option value="">{t("restaurantes.agenteWhatsapp.usarTonoPerfil", { tono: defaults ? TONO_LABEL[defaults.toneStyle] : "" })}</option>
                  {opciones.tonos.map((t) => (
                    <option key={t} value={t}>
                      {TONO_LABEL[t]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              {pm && (
                <FormField label={t("restaurantes.agenteWhatsapp.campo.greetingText")} hint={t("restaurantes.agenteWhatsapp.saludoAyuda", { contador: contador(form.greetingText, lim?.greetingText) ?? "" })}>
                  <Input value={form.greetingText} maxLength={lim?.greetingText} placeholder={t("restaurantes.agenteWhatsapp.saludoEjemplo")} onChange={(e) => cambiar("greetingText", e.target.value)} />
                </FormField>
              )}
            </div>

            <FormField label={t("restaurantes.agenteWhatsapp.tiempos")} hint={t("restaurantes.agenteWhatsapp.tiemposAyuda", { contador: contador(form.deliveryTimeText, lim?.deliveryTimeText) ?? "" })}>
              <Textarea rows={2} value={form.deliveryTimeText} maxLength={lim?.deliveryTimeText} placeholder={defaults?.deliveryTimeText} onChange={(e) => cambiar("deliveryTimeText", e.target.value)} />
            </FormField>

            {pm && (
              <>
                <FormField label={t("restaurantes.agenteWhatsapp.salsas")} hint={t("restaurantes.agenteWhatsapp.salsasAyuda", { contador: contador(form.salsasText, lim?.salsasText) ?? "" })}>
                  <Textarea rows={2} value={form.salsasText} maxLength={lim?.salsasText} placeholder={defaults?.salsasText ?? ""} onChange={(e) => cambiar("salsasText", e.target.value)} />
                </FormField>
                <FormField label={t("restaurantes.agenteWhatsapp.promos")} hint={t("restaurantes.agenteWhatsapp.promosAyuda", { contador: contador(form.promosText, lim?.promosText) ?? "" })}>
                  <Textarea rows={2} value={form.promosText} maxLength={lim?.promosText} placeholder={defaults?.promosText ?? ""} onChange={(e) => cambiar("promosText", e.target.value)} />
                </FormField>
                <FormField label={t("restaurantes.agenteWhatsapp.campo.largeOrderText")} hint={t("restaurantes.agenteWhatsapp.umbralAyuda", { contador: contador(form.largeOrderText, lim?.largeOrderText) ?? "" })}>
                  <Textarea rows={2} value={form.largeOrderText} maxLength={lim?.largeOrderText} placeholder={defaults?.largeOrderText ?? ""} onChange={(e) => cambiar("largeOrderText", e.target.value)} />
                </FormField>
                <FormField label={t("restaurantes.agenteWhatsapp.campo.replyDebounceSeconds")} hint={t("restaurantes.agenteWhatsapp.rafagasAyuda", { max: opciones.esperaRafagasMaxSegundos ?? 10 })}>
                  <Input type="number" inputMode="numeric" min={0} max={opciones.esperaRafagasMaxSegundos ?? 10} step={1} value={form.replyDebounceSeconds} placeholder={t("restaurantes.agenteWhatsapp.apagada")} onChange={(e) => cambiar("replyDebounceSeconds", e.target.value)} />
                </FormField>
                <fieldset className="flex flex-col gap-2 rounded-card border border-border p-3">
                  <legend className="px-1 text-sm font-medium">{t("restaurantes.agenteWhatsapp.motivosLeyenda")}</legend>
                  <p className="m-0 text-xs text-muted-foreground">{t("restaurantes.agenteWhatsapp.motivosAyuda")}</p>
                  {opciones.motivosDesactivables.map((m) => (
                    <Checkbox
                      key={m}
                      label={MOTIVO_LABEL[m] ?? m}
                      checked={!form.escalationReasonsOff.includes(m)}
                      onChange={(e) => cambiar("escalationReasonsOff", e.target.checked ? form.escalationReasonsOff.filter((x) => x !== m) : [...form.escalationReasonsOff, m])}
                    />
                  ))}
                </fieldset>
              </>
            )}

            {aviso && (
              <Callout tone={conflicto ? "warning" : avisoExito ? "success" : "danger"}>
                {aviso}
                {conflicto && (
                  <Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => setRecarga((n) => n + 1)}>
                    {t("restaurantes.agenteWhatsapp.recargar")}
                  </Button>
                )}
              </Callout>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={ocupado} onClick={() => void revisar()}>
                {t("restaurantes.agenteWhatsapp.revisar")}
              </Button>
              {actual && (
                <Button type="button" variant="outline" disabled={ocupado} onClick={() => void restablecer()}>
                  {t("restaurantes.agenteWhatsapp.restablecer")}
                </Button>
              )}
            </div>

            {previa && (
              <section aria-label={t("restaurantes.agenteWhatsapp.vistaPrevia")} className="flex flex-col gap-3 rounded-card border border-border p-3">
                <h3 className="m-0 text-sm font-semibold">{t("restaurantes.agenteWhatsapp.queCambia")}</h3>
                {previa.diferenciasCampos.length === 0 ? (
                  <p className="m-0 text-sm text-muted-foreground">{t("restaurantes.agenteWhatsapp.sinCambios")}</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                    {previa.diferenciasCampos.map((d) => (
                      <li key={d.campo}>
                        <strong>{d.campo}:</strong> <span className="text-muted-foreground line-through">{d.antes || t("restaurantes.agenteWhatsapp.delPerfil")}</span> → <span>{d.despues || t("restaurantes.agenteWhatsapp.delPerfil")}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary className="cursor-pointer text-sm font-medium">{t("restaurantes.agenteWhatsapp.lineasPrompt")}</summary>
                  <div className="mt-2 flex flex-col gap-1 font-mono text-xs">
                    {previa.diferenciasPrompt.filter((l) => l.tipo !== "igual").length === 0 && <span className="text-muted-foreground">{t("restaurantes.agenteWhatsapp.promptIgual")}</span>}
                    {previa.diferenciasPrompt
                      .filter((l) => l.tipo !== "igual")
                      .map((l, i) => (
                        <div key={i} className={l.tipo === "agregada" ? "rounded bg-success-tint px-2 py-1" : "rounded bg-destructive-tint px-2 py-1"}>
                          {l.tipo === "agregada" ? "+ " : "− "}
                          {l.texto}
                        </div>
                      ))}
                  </div>
                </details>
                <details>
                  <summary className="cursor-pointer text-sm font-medium">{t("restaurantes.agenteWhatsapp.promptCompleto")}</summary>
                  <Textarea readOnly rows={14} className="mt-2 font-mono text-xs" value={previa.prompt} aria-label={t("restaurantes.agenteWhatsapp.promptResultante")} />
                </details>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={ocupado || previa.diferenciasCampos.length === 0} onClick={() => void guardar()}>
                    {t("restaurantes.agenteWhatsapp.confirmarGuardar")}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setPrevia(null)}>
                    {t("restaurantes.agenteWhatsapp.seguirEditando")}
                  </Button>
                </div>
              </section>
            )}

            {!sin033 && (
              <section aria-label={t("restaurantes.agenteWhatsapp.historialCambios")} className="flex flex-col gap-2">
                <h3 className="m-0 text-sm font-semibold">{t("restaurantes.agenteWhatsapp.historial")}</h3>
                {historial.length === 0 && <p className="m-0 text-sm text-muted-foreground">{t("restaurantes.agenteWhatsapp.historialVacio")}</p>}
                {historial.map((h) => (
                  <div key={h.version} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-2.5 text-sm">
                    <div>
                      <p className="m-0 font-semibold">
                        {t("restaurantes.agenteWhatsapp.version", { version: h.version })} <StatusBadge tone={h.accion === "restablecido" ? "warning" : "info"}>{t(h.accion === "restablecido" ? "restaurantes.agenteWhatsapp.restablecidoEtiqueta" : "restaurantes.agenteWhatsapp.actualizado")}</StatusBadge>
                      </p>
                      <p className="m-0 text-xs text-muted-foreground">
                        {fecha(h.creadoEn)}
                        {(h.actorNombre ?? (h.actorUserId ? nombresEquipo[h.actorUserId] : null)) ? ` · ${h.actorNombre ?? nombresEquipo[h.actorUserId ?? ""]}` : ""}
                        {camposCambiados(h.anterior, h.nuevo).length > 0 ? t("restaurantes.agenteWhatsapp.cambio", { campos: camposCambiados(h.anterior, h.nuevo).join(", ") }) : ""}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setForm(formDesdeFoto(h.nuevo));
                        setPrevia(null);
                        setAviso(t("restaurantes.agenteWhatsapp.versionCargada", { version: h.version }));
                        setAvisoExito(false);
                        setConflicto(false);
                      }}
                    >
                      {t("restaurantes.agenteWhatsapp.usarVersion")}
                    </Button>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
        {dialogo}
      </CardContent>
    </Card>
    <ConocimientoNegocio apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} canal="whatsapp" />
    {datos && <WidgetWhatsApp apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} borrador={form} {...(nombreSucursal ? { nombreNegocio: nombreSucursal } : {})} />}
    </div>
  );
}
