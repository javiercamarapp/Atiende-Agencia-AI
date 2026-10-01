// C-15 -- Agente de WhatsApp: conectar el número del negocio y editar la personalidad del agente (nombre, tono, mensaje de
// bienvenida y reglas). Solo owner/admin (el servidor revalida con 403 y la función SQL valida el rol: este gate es UX).
// Contrato: lib/whatsapp-agente-client.ts. Mismo flujo que los mensajes de C-04 y el editor del agente de restaurantes
// (revisar -> confirmar -> guardar). Estados honestos: el número se REGISTRA, pero desde aquí no se puede comprobar que Meta lo
// reconozca; la API dice qué falta (por ejemplo la credencial de envío de la plataforma) y la pantalla lo muestra tal cual.
import { useEffect, useState } from "react";
import { Bot, Phone } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, FormField, Input, NativeSelect, PageHeader, StatusBadge, Switch, Textarea, useConfirm } from "@atiende/ui";
import {
  conectarNumero,
  desconectarNumero,
  fetchPanelAgente,
  formCambio,
  formDesdeConfig,
  guardarAgente,
  restablecerAgente,
  vistaPreviaAgente,
} from "../lib/whatsapp-agente-client.ts";
import type { EstadoConexion, FormAgente, PanelAgenteWire, VistaPreviaAgenteWire } from "../lib/whatsapp-agente-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const ROLES = new Set(["owner", "admin"]);

const ESTADO_ETIQUETA: Record<EstadoConexion, { etiqueta: string; tono: "neutral" | "warning" | "success" | "info" }> = {
  sin_numero: { etiqueta: "Sin número", tono: "neutral" },
  pausado: { etiqueta: "Pausado", tono: "warning" },
  sin_credenciales_de_envio: { etiqueta: "Registrado, sin envío", tono: "warning" },
  registrado: { etiqueta: "Registrado", tono: "success" },
};

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function AgenteWhatsappPage({ apiBaseUrl, token, propertyId, role }: CitasShellContext) {
  const puede = ROLES.has(role);
  const { confirmar, dialogo } = useConfirm();
  const [panel, setPanel] = useState<PanelAgenteWire | null>(null);
  const [form, setForm] = useState<FormAgente | null>(null);
  const [numero, setNumero] = useState("");
  const [activo, setActivo] = useState(true);
  const [previa, setPrevia] = useState<VistaPreviaAgenteWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avisoNumero, setAvisoNumero] = useState<{ texto: string; tono: "success" | "danger" } | null>(null);
  const [avisoAgente, setAvisoAgente] = useState<{ texto: string; tono: "success" | "danger" | "warning" } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    if (!puede) return;
    let cancelado = false;
    (async () => {
      try {
        const datos = await fetchPanelAgente(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setPanel(datos);
        setForm(formDesdeConfig(datos.agente.config));
        setNumero(datos.conexion.numero?.phoneNumberId ?? "");
        setActivo(datos.conexion.numero?.activo ?? true);
        setPrevia(null);
        setError(null);
      } catch (err) {
        if (!cancelado) setError(mensaje(err, "No se pudo cargar la configuración del agente."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puede, recarga]);

  function cambiar<K extends keyof FormAgente>(campo: K, valor: FormAgente[K]) {
    setForm((f) => (f ? { ...f, [campo]: valor } : f));
    setPrevia(null);
    setAvisoAgente(null);
  }

  async function guardarNumero() {
    setOcupado(true);
    setAvisoNumero(null);
    try {
      await conectarNumero(fetch, apiBaseUrl, token, propertyId, numero.trim(), activo);
      setAvisoNumero({ texto: "Número guardado.", tono: "success" });
      setRecarga((n) => n + 1);
    } catch (err) {
      setAvisoNumero({ texto: mensaje(err, "No se pudo guardar el número."), tono: "danger" });
    } finally {
      setOcupado(false);
    }
  }

  async function quitarNumero() {
    const ok = await confirmar({
      titulo: "Desconectar el número",
      descripcion: "El agente deja de recibir mensajes en este número y los avisos (recordatorios, confirmaciones) dejan de salir hasta que conectes uno otra vez. Las citas y los clientes no se tocan.",
      tono: "danger",
      confirmar: "Desconectar",
    });
    if (!ok) return;
    setOcupado(true);
    setAvisoNumero(null);
    try {
      await desconectarNumero(fetch, apiBaseUrl, token, propertyId);
      setAvisoNumero({ texto: "Número desconectado.", tono: "success" });
      setRecarga((n) => n + 1);
    } catch (err) {
      setAvisoNumero({ texto: mensaje(err, "No se pudo desconectar el número."), tono: "danger" });
    } finally {
      setOcupado(false);
    }
  }

  async function revisar() {
    if (!form) return;
    setOcupado(true);
    setAvisoAgente(null);
    try {
      setPrevia(await vistaPreviaAgente(fetch, apiBaseUrl, token, propertyId, form));
    } catch (err) {
      setAvisoAgente({ texto: mensaje(err, "No se pudo generar la vista previa."), tono: "danger" });
    } finally {
      setOcupado(false);
    }
  }

  function falloDeEscritura(err: unknown, porDefecto: string) {
    const texto = mensaje(err, porDefecto);
    setAvisoAgente({ texto, tono: /cambió mientras/i.test(texto) ? "warning" : "danger" });
  }

  async function guardar() {
    if (!form || !panel) return;
    setOcupado(true);
    setAvisoAgente(null);
    try {
      await guardarAgente(fetch, apiBaseUrl, token, propertyId, form, panel.agente.version);
      setAvisoAgente({ texto: "Guardado. El agente usa esta personalidad desde su próximo mensaje.", tono: "success" });
      setRecarga((n) => n + 1);
    } catch (err) {
      falloDeEscritura(err, "No se pudo guardar.");
    } finally {
      setOcupado(false);
    }
  }

  async function restablecer() {
    if (!panel) return;
    const ok = await confirmar({
      titulo: "Volver a los valores por defecto",
      descripcion: "Se borran el nombre, el tono, el mensaje de bienvenida y las reglas propias. El agente vuelve a hablar como siempre. Las reglas duras (nunca inventar horarios, no duplicar citas) no cambian.",
      tono: "danger",
      confirmar: "Volver a los valores por defecto",
    });
    if (!ok) return;
    setOcupado(true);
    setAvisoAgente(null);
    try {
      await restablecerAgente(fetch, apiBaseUrl, token, propertyId, panel.agente.version);
      setAvisoAgente({ texto: "Se restablecieron los valores por defecto.", tono: "success" });
      setRecarga((n) => n + 1);
    } catch (err) {
      falloDeEscritura(err, "No se pudo restablecer.");
    } finally {
      setOcupado(false);
    }
  }

  const editable = Boolean(panel?.disponible);
  const lim = panel?.opciones.limites;
  const estado = panel ? ESTADO_ETIQUETA[panel.conexion.estado] : null;
  const numeroCambio = Boolean(panel) && (numero.trim() !== (panel?.conexion.numero?.phoneNumberId ?? "") || activo !== (panel?.conexion.numero?.activo ?? true));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        titulo="Agente de WhatsApp"
        descripcion="Conecta el número por el que el agente atiende a tus clientes y define cómo se presenta: nombre, tono, bienvenida y reglas de tu negocio."
      />

      {!puede ? (
        <p className="m-0 text-sm text-muted-foreground">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> pueden conectar el número y editar al agente — tu rol actual es <strong className="text-foreground">{role}</strong>.
        </p>
      ) : (
        <>
          {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
          {!panel && !error && <EstadoCargando etiqueta="Cargando el agente…" />}
          {panel && form && lim && estado && (
            <>
              {!panel.disponible && (
                <Callout tone="warning" titulo="Edición todavía no disponible">
                  Esta base aún no tiene la configuración del agente (migración pendiente). Mientras tanto el agente sigue hablando como siempre y el número se administra por soporte.
                </Callout>
              )}

              <Card>
                <CardHeader className="p-4 pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    <Phone className="h-4 w-4" strokeWidth={1.75} />
                    Número de WhatsApp
                    <StatusBadge tone={estado.tono}>{estado.etiqueta}</StatusBadge>
                  </CardTitle>
                  <CardDescription>{panel.conexion.nota}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 p-4 pt-0">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <FormField label="Identificador del número de teléfono" hint="Solo dígitos. Lo encuentras en Meta → WhatsApp → API Setup, como «Phone number ID». No es el número de teléfono.">
                      <Input inputMode="numeric" autoComplete="off" value={numero} disabled={!editable} onChange={(e) => setNumero(e.target.value.replace(/\s+/g, ""))} placeholder="109876543210987" />
                    </FormField>
                    <label className="flex items-center gap-2 pb-2 text-sm">
                      <Switch aria-label="Número activo" checked={activo} disabled={!editable} onCheckedChange={setActivo} />
                      Activo
                    </label>
                  </div>
                  {avisoNumero && <Callout tone={avisoNumero.tono}>{avisoNumero.texto}</Callout>}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={ocupado || !editable || numero.trim() === "" || !numeroCambio} onClick={() => void guardarNumero()}>
                      {panel.conexion.numero ? "Guardar número" : "Conectar número"}
                    </Button>
                    {panel.conexion.numero && (
                      <Button type="button" variant="outline" disabled={ocupado || !editable} onClick={() => void quitarNumero()}>
                        Desconectar
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-4 pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    <Bot className="h-4 w-4" strokeWidth={1.75} />
                    Personalidad del agente
                  </CardTitle>
                  <CardDescription>
                    Cambia cómo habla el agente, no lo que puede hacer: las reglas duras (nunca inventar horarios, no duplicar citas, resolver ids reales) no se pueden quitar desde aquí.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 p-4 pt-0">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label="Nombre del agente" hint={`Opcional. Hasta ${lim.agentName} caracteres. Por defecto no usa nombre.`}>
                      <Input value={form.agentName} maxLength={lim.agentName} disabled={!editable} onChange={(e) => cambiar("agentName", e.target.value)} placeholder="Sofi" />
                    </FormField>
                    <FormField label="Tono" hint="Por defecto: cálido y directo.">
                      <NativeSelect value={form.toneStyle} disabled={!editable} onChange={(e) => cambiar("toneStyle", e.target.value)}>
                        <option value="">Por defecto</option>
                        {panel.opciones.tonos.map((t) => (
                          <option key={t.valor} value={t.valor}>
                            {t.etiqueta}
                          </option>
                        ))}
                      </NativeSelect>
                    </FormField>
                  </div>
                  <FormField label="Mensaje de bienvenida" hint={`${form.greetingText.length}/${lim.greetingText}. Opcional: se dice una vez, tras el saludo según la hora.`}>
                    <Input value={form.greetingText} maxLength={lim.greetingText} disabled={!editable} onChange={(e) => cambiar("greetingText", e.target.value)} placeholder="Bienvenido a Clínica Sol, estamos para ayudarte." />
                  </FormField>
                  <FormField label="Reglas de tu negocio" hint={`Una por línea, hasta ${lim.rulesMaxLines} de ${lim.ruleLength} caracteres. Van después de las reglas duras y nunca las contradicen.`}>
                    <Textarea rows={5} value={form.rulesText} disabled={!editable} onChange={(e) => cambiar("rulesText", e.target.value)} placeholder={"No des diagnósticos médicos\nPide siempre el nombre completo"} />
                  </FormField>

                  {avisoAgente && <Callout tone={avisoAgente.tono}>{avisoAgente.texto}{avisoAgente.tono === "warning" && (
                    <Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => setRecarga((n) => n + 1)}>
                      Recargar lo vigente
                    </Button>
                  )}</Callout>}

                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={ocupado || !editable || !formCambio(form, panel.agente.config)} onClick={() => void revisar()}>
                      Revisar cambios
                    </Button>
                    {panel.agente.version > 0 && (
                      <Button type="button" variant="outline" disabled={ocupado || !editable} onClick={() => void restablecer()}>
                        Volver a los valores por defecto
                      </Button>
                    )}
                  </div>

                  {previa && (
                    <section aria-label="Vista previa de los cambios" className="flex flex-col gap-3 rounded-card border border-border p-3">
                      <h3 className="m-0 text-sm font-semibold">Qué cambia</h3>
                      {previa.diferencias.length === 0 ? (
                        <p className="m-0 text-sm text-muted-foreground">No hay cambios respecto a lo vigente.</p>
                      ) : (
                        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                          {previa.diferencias.map((d) => (
                            <li key={d.campo}>
                              <strong>{d.campo}:</strong> <span className="whitespace-pre-line text-muted-foreground line-through">{d.antes || "(por defecto)"}</span> → <span className="whitespace-pre-line">{d.despues || "(por defecto)"}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <details className="text-sm">
                        <summary className="cursor-pointer font-semibold">Ver el prompt completo que usaría el agente</summary>
                        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-card p-2.5 font-mono text-xs">{previa.prompt}</pre>
                      </details>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" disabled={ocupado || previa.diferencias.length === 0} onClick={() => void guardar()}>
                          Confirmar y guardar
                        </Button>
                        <Button type="button" variant="outline" onClick={() => setPrevia(null)}>
                          Seguir editando
                        </Button>
                      </div>
                    </section>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
      {dialogo}
    </div>
  );
}
