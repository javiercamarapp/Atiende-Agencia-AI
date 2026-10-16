// R-10: editor del agente de WhatsApp dentro de Configuracion (solo owner/admin; el servidor, admin-config.ts + RLS, es el
// enforcement real). Edita SOLO lo que no toca las reglas duras: nombre, tono, tiempos de entrega, saludo, salsas incluidas,
// promociones y los motivos de escalacion que se pueden apagar. Antes de guardar se ve el prompt resultante (solo lectura) y
// las diferencias contra lo vigente. Cada guardado queda en un historial versionado; "volver al perfil por defecto" deja los
// textos en blanco. Contrato: lib/agente-whatsapp-client.ts.
import { useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, FormField, Input, NativeSelect, StatusBadge, Textarea, useConfirm } from "@atiende/ui";
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
    return new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function AgenteWhatsappSeccion({ apiBaseUrl, token, propertyId, nombreSucursal }: Props) {
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
        if (!cancelado) setError(mensaje(err, "No se pudo cargar la configuración del agente."));
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
    setConflicto(/cambió mientras|otra versión|conflict/i.test(texto));
  }

  async function revisar() {
    setOcupado(true);
    setAviso(null);
    try {
      setPrevia(await vistaPreviaAgente(fetch, apiBaseUrl, token, propertyId, form, alcance));
    } catch (err) {
      falloDeEscritura(err, "No se pudo generar la vista previa.");
    } finally {
      setOcupado(false);
    }
  }

  async function guardar() {
    setOcupado(true);
    setAviso(null);
    try {
      await guardarAgenteWhatsapp(fetch, apiBaseUrl, token, propertyId, form, alcance, versionVista);
      setAviso("Guardado. El agente usa estos valores desde el siguiente mensaje.");
      setConflicto(false);
      setRecarga((n) => n + 1);
    } catch (err) {
      falloDeEscritura(err, "No se pudo guardar.");
    } finally {
      setOcupado(false);
    }
  }

  async function restablecer() {
    const ok = await confirmar({
      titulo: "Volver al perfil por defecto",
      descripcion: "Se borran el nombre, el tono, los tiempos de entrega, el saludo, las salsas, las promociones y los motivos desactivados de este alcance. El agente vuelve a usar los valores del perfil. Queda en el historial y se puede revisar.",
      tono: "danger",
      confirmar: "Volver al perfil por defecto",
    });
    if (!ok) return;
    setOcupado(true);
    setAviso(null);
    try {
      await restablecerAgente(fetch, apiBaseUrl, token, propertyId, alcance, versionVista);
      setAviso("Se restableció el perfil por defecto.");
      setRecarga((n) => n + 1);
    } catch (err) {
      falloDeEscritura(err, "No se pudo restablecer.");
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
          Agente de WhatsApp
        </CardTitle>
        <CardDescription>
          Cómo se presenta y qué datos del negocio da el agente. Las reglas duras (mínimo a domicilio, alcohol, zona, quejas, alergias, pagos) no se editan aquí: las aplica el sistema.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4 pt-0">
        {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
        {!datos && !error && <EstadoCargando etiqueta="Cargando el agente…" />}
        {datos && opciones && (
          <>
            {sin033 && (
              <Callout tone="warning" titulo="Edición limitada">
                Esta base todavía no tiene el editor completo: se puede cambiar el perfil, el nombre, el tono y los tiempos de entrega, pero no el saludo, las salsas, las promociones, los motivos de escalación ni ver el historial.
              </Callout>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Aplicar a">
                <NativeSelect value={alcance} onChange={(e) => setAlcance(e.target.value as AlcanceAgente)}>
                  <option value="organizacion">Toda la organización</option>
                  <option value="sucursal">Solo esta sucursal</option>
                </NativeSelect>
              </FormField>
              <FormField label="Perfil del agente">
                <NativeSelect value={form.perfil} onChange={(e) => cambiar("perfil", e.target.value as PerfilAgente)}>
                  {(Object.keys(PERFIL_LABEL) as PerfilAgente[]).map((p) => (
                    <option key={p} value={p}>
                      {PERFIL_LABEL[p]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Nombre del agente" hint={contador(form.agentName, lim?.agentName)}>
                <Input value={form.agentName} maxLength={lim?.agentName} placeholder={defaults?.agentName ?? "Como se presenta"} onChange={(e) => cambiar("agentName", e.target.value)} />
              </FormField>
              <FormField label="Nombre del negocio" hint={contador(form.businessName, lim?.businessName)}>
                <Input value={form.businessName} maxLength={lim?.businessName} placeholder={defaults?.businessName} onChange={(e) => cambiar("businessName", e.target.value)} />
              </FormField>
              <FormField label="Tono">
                <NativeSelect value={form.toneStyle} onChange={(e) => cambiar("toneStyle", e.target.value as TonoAgente | "")}>
                  <option value="">Usar el del perfil ({defaults ? TONO_LABEL[defaults.toneStyle] : ""})</option>
                  {opciones.tonos.map((t) => (
                    <option key={t} value={t}>
                      {TONO_LABEL[t]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              {pm && (
                <FormField label="Saludo" hint={`Reemplaza el saludo según la hora. ${contador(form.greetingText, lim?.greetingText) ?? ""}`}>
                  <Input value={form.greetingText} maxLength={lim?.greetingText} placeholder="Buenos días / Buenas tardes / Buenas noches" onChange={(e) => cambiar("greetingText", e.target.value)} />
                </FormField>
              )}
            </div>

            <FormField label="Tiempos de entrega y de recogida" hint={`Texto que el agente dice al cliente: domicilio y recoger, normal y en hora pico (por ejemplo «a domicilio de 60 a 75 min (pico: 75 a 90); para recoger de 25 a 35 min (pico: 45 a 60)»). ${contador(form.deliveryTimeText, lim?.deliveryTimeText) ?? ""}`}>
              <Textarea rows={2} value={form.deliveryTimeText} maxLength={lim?.deliveryTimeText} placeholder={defaults?.deliveryTimeText} onChange={(e) => cambiar("deliveryTimeText", e.target.value)} />
            </FormField>

            {pm && (
              <>
                <FormField label="Salsas incluidas sin costo" hint={`Una lista corta. ${contador(form.salsasText, lim?.salsasText) ?? ""}`}>
                  <Textarea rows={2} value={form.salsasText} maxLength={lim?.salsasText} placeholder={defaults?.salsasText ?? ""} onChange={(e) => cambiar("salsasText", e.target.value)} />
                </FormField>
                <FormField label="Promociones (solo para recoger)" hint={`El agente solo las menciona; el descuento lo calcula el sistema. ${contador(form.promosText, lim?.promosText) ?? ""}`}>
                  <Textarea rows={2} value={form.promosText} maxLength={lim?.promosText} placeholder={defaults?.promosText ?? ""} onChange={(e) => cambiar("promosText", e.target.value)} />
                </FormField>
                <FormField label="Umbral de pedido grande" hint={`A partir de aquí el agente toma los datos y avisa a la sucursal para que lo confirme; por debajo lo toma normal. ${contador(form.largeOrderText, lim?.largeOrderText) ?? ""}`}>
                  <Textarea rows={2} value={form.largeOrderText} maxLength={lim?.largeOrderText} placeholder={defaults?.largeOrderText ?? ""} onChange={(e) => cambiar("largeOrderText", e.target.value)} />
                </FormField>
                <FormField label="Espera de ráfagas (segundos)" hint={`Cuántos segundos espera el agente tras el último mensaje del cliente antes de responder, para contestar todo junto. Vacío o 0 = responde enseguida; máximo ${opciones.esperaRafagasMaxSegundos ?? 10}.`}>
                  <Input type="number" inputMode="numeric" min={0} max={opciones.esperaRafagasMaxSegundos ?? 10} step={1} value={form.replyDebounceSeconds} placeholder="Apagada" onChange={(e) => cambiar("replyDebounceSeconds", e.target.value)} />
                </FormField>
                <fieldset className="flex flex-col gap-2 rounded-card border border-border p-3">
                  <legend className="px-1 text-sm font-medium">Motivos por los que el agente avisa a una persona</legend>
                  <p className="m-0 text-xs text-muted-foreground">Estos se pueden apagar. Los demás (quejas, alergias, cliente que pide a una persona, fallas, transferencias, cancelaciones y reposiciones) siempre escalan.</p>
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
              <Callout tone={conflicto ? "warning" : aviso.startsWith("Guardado") || aviso.startsWith("Se restableció") ? "success" : "danger"}>
                {aviso}
                {conflicto && (
                  <Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => setRecarga((n) => n + 1)}>
                    Recargar lo vigente
                  </Button>
                )}
              </Callout>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={ocupado} onClick={() => void revisar()}>
                Revisar cambios
              </Button>
              {actual && (
                <Button type="button" variant="outline" disabled={ocupado} onClick={() => void restablecer()}>
                  Volver al perfil por defecto
                </Button>
              )}
            </div>

            {previa && (
              <section aria-label="Vista previa de los cambios" className="flex flex-col gap-3 rounded-card border border-border p-3">
                <h3 className="m-0 text-sm font-semibold">Qué cambia</h3>
                {previa.diferenciasCampos.length === 0 ? (
                  <p className="m-0 text-sm text-muted-foreground">No hay cambios respecto a lo vigente.</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                    {previa.diferenciasCampos.map((d) => (
                      <li key={d.campo}>
                        <strong>{d.campo}:</strong> <span className="text-muted-foreground line-through">{d.antes || "(del perfil)"}</span> → <span>{d.despues || "(del perfil)"}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary className="cursor-pointer text-sm font-medium">Líneas del prompt que cambian (solo lectura)</summary>
                  <div className="mt-2 flex flex-col gap-1 font-mono text-xs">
                    {previa.diferenciasPrompt.filter((l) => l.tipo !== "igual").length === 0 && <span className="text-muted-foreground">El prompt queda igual.</span>}
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
                  <summary className="cursor-pointer text-sm font-medium">Prompt completo que usaría el agente (solo lectura)</summary>
                  <Textarea readOnly rows={14} className="mt-2 font-mono text-xs" value={previa.prompt} aria-label="Prompt resultante" />
                </details>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={ocupado || previa.diferenciasCampos.length === 0} onClick={() => void guardar()}>
                    Confirmar y guardar
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setPrevia(null)}>
                    Seguir editando
                  </Button>
                </div>
              </section>
            )}

            {!sin033 && (
              <section aria-label="Historial de cambios" className="flex flex-col gap-2">
                <h3 className="m-0 text-sm font-semibold">Historial</h3>
                {historial.length === 0 && <p className="m-0 text-sm text-muted-foreground">Todavía no hay cambios guardados en este alcance.</p>}
                {historial.map((h) => (
                  <div key={h.version} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-2.5 text-sm">
                    <div>
                      <p className="m-0 font-semibold">
                        Versión {h.version} <StatusBadge tone={h.accion === "restablecido" ? "warning" : "info"}>{h.accion === "restablecido" ? "Restablecido" : "Actualizado"}</StatusBadge>
                      </p>
                      <p className="m-0 text-xs text-muted-foreground">
                        {fecha(h.creadoEn)}
                        {(h.actorNombre ?? (h.actorUserId ? nombresEquipo[h.actorUserId] : null)) ? ` · ${h.actorNombre ?? nombresEquipo[h.actorUserId ?? ""]}` : ""}
                        {camposCambiados(h.anterior, h.nuevo).length > 0 ? ` · Cambió: ${camposCambiados(h.anterior, h.nuevo).join(", ")}` : ""}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setForm(formDesdeFoto(h.nuevo));
                        setPrevia(null);
                        setAviso(`Se cargó la versión ${h.version} en el formulario. Revise los cambios y guárdelos para aplicarla.`);
                        setConflicto(false);
                      }}
                    >
                      Usar esta versión
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
