// C-04 -- Mensajes de WhatsApp: plantillas de recordatorio / confirmación / cancelación / reagendado, anticipación del
// recordatorio y horario de envío, con vista previa, historial versionado y "volver a los valores por defecto". Solo
// owner/admin (el servidor revalida con 403 y la función SQL valida el rol: este gate es UX). Contrato:
// lib/whatsapp-mensajes-client.ts. Mismo flujo que el editor del agente de restaurantes (revisar -> confirmar -> guardar).
import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, FormField, Input, NativeSelect, StatusBadge, Switch, Textarea, useConfirm } from "@atiende/ui";
import {
  MENSAJE_KINDS,
  TEXTO_CAMPO,
  fetchHistorialMensajes,
  fetchMensajes,
  fetchOpcionesMensajes,
  formDesdeConfig,
  guardarMensajes,
  restablecerMensajes,
  vistaPreviaMensajes,
} from "../lib/whatsapp-mensajes-client.ts";
import type { FormMensajes, HistorialMensajesEntradaWire, MensajeKind, MensajesWire, OpcionesMensajesWire, VistaPreviaWire } from "../lib/whatsapp-mensajes-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const ROLES = new Set(["owner", "admin"]);
const HORAS_INICIO = Array.from({ length: 24 }, (_, h) => h);
const HORAS_FIN = Array.from({ length: 24 }, (_, h) => h + 1);

function hora(h: number): string {
  return `${String(h % 24).padStart(2, "0")}:00`;
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

export function WhatsappMensajesPage({ apiBaseUrl, token, propertyId, role }: CitasShellContext) {
  const puede = ROLES.has(role);
  const { confirmar, dialogo } = useConfirm();
  const [datos, setDatos] = useState<MensajesWire | null>(null);
  const [opciones, setOpciones] = useState<OpcionesMensajesWire | null>(null);
  const [form, setForm] = useState<FormMensajes | null>(null);
  const [historial, setHistorial] = useState<readonly HistorialMensajesEntradaWire[]>([]);
  const [previa, setPrevia] = useState<VistaPreviaWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [conflicto, setConflicto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    if (!puede) return;
    let cancelado = false;
    (async () => {
      try {
        const [d, o] = await Promise.all([fetchMensajes(fetch, apiBaseUrl, token, propertyId), fetchOpcionesMensajes(fetch, apiBaseUrl, token, propertyId)]);
        if (cancelado) return;
        setDatos(d);
        setOpciones(o);
        setForm(formDesdeConfig(d.config));
        setPrevia(null);
        setError(null);
        setConflicto(false);
        if (d.disponible) {
          const h = await fetchHistorialMensajes(fetch, apiBaseUrl, token, propertyId).catch(() => ({ disponible: false, entradas: [] as readonly HistorialMensajesEntradaWire[] }));
          if (!cancelado) setHistorial(h.entradas);
        } else {
          setHistorial([]);
        }
      } catch (err) {
        if (!cancelado) setError(mensaje(err, "No se pudo cargar la configuración de mensajes."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puede, recarga]);

  function cambiar<K extends keyof FormMensajes>(campo: K, valor: FormMensajes[K]) {
    setForm((f) => (f ? { ...f, [campo]: valor } : f));
    setPrevia(null);
    setAviso(null);
  }

  function falloDeEscritura(err: unknown, porDefecto: string) {
    const texto = mensaje(err, porDefecto);
    setError(null);
    setAviso(texto);
    setConflicto(/cambió mientras/i.test(texto));
  }

  async function revisar() {
    if (!form) return;
    setOcupado(true);
    setAviso(null);
    try {
      setPrevia(await vistaPreviaMensajes(fetch, apiBaseUrl, token, propertyId, form));
    } catch (err) {
      falloDeEscritura(err, "No se pudo generar la vista previa.");
    } finally {
      setOcupado(false);
    }
  }

  async function guardar() {
    if (!form || !datos) return;
    setOcupado(true);
    setAviso(null);
    try {
      await guardarMensajes(fetch, apiBaseUrl, token, propertyId, form, datos.version);
      setAviso("Guardado. Los mensajes nuevos usan estos textos desde ahora.");
      setConflicto(false);
      setRecarga((n) => n + 1);
    } catch (err) {
      falloDeEscritura(err, "No se pudo guardar.");
    } finally {
      setOcupado(false);
    }
  }

  async function restablecer() {
    if (!datos) return;
    const ok = await confirmar({
      titulo: "Volver a los valores por defecto",
      descripcion:
        "Se borran los textos propios, la anticipación y el horario de envío. El recordatorio vuelve a salir 24 horas antes con el texto de siempre y los avisos de confirmación, cancelación y reagendado se apagan. Queda en el historial.",
      tono: "danger",
      confirmar: "Volver a los valores por defecto",
    });
    if (!ok) return;
    setOcupado(true);
    setAviso(null);
    try {
      await restablecerMensajes(fetch, apiBaseUrl, token, propertyId, datos.version);
      setAviso("Se restablecieron los valores por defecto.");
      setRecarga((n) => n + 1);
    } catch (err) {
      falloDeEscritura(err, "No se pudo restablecer.");
    } finally {
      setOcupado(false);
    }
  }

  const lim = opciones?.limites;
  const editable = Boolean(datos?.disponible);

  return (
    <div className="flex flex-col gap-5 max-w-[1000px]">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Mensajes de WhatsApp</h1>
        <p className="m-0 text-[13px] text-muted-foreground">
          Los textos que tus clientes reciben por WhatsApp: recordatorio de cita, confirmación, cancelación y reagendado. Puedes usar variables como {"{{nombre}}"} y {"{{hora}}"}; la vista previa muestra datos de ejemplo.
        </p>
      </header>

      {!puede ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> pueden editar estos mensajes — tu rol actual es <strong className="text-foreground">{role}</strong>.
        </p>
      ) : (
        <Card>
          <CardHeader className="p-4 pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <MessageSquareText className="h-4 w-4" strokeWidth={1.75} />
              Plantillas y horario de envío
            </CardTitle>
            <CardDescription>
              Para escribirle primero a un cliente fuera de las 24 horas de su último mensaje, WhatsApp exige una plantilla aprobada por Meta. Estos textos cambian lo que enviamos, pero la aprobación de esa plantilla sigue siendo un paso aparte.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 p-4 pt-0">
            {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
            {!datos && !error && <EstadoCargando etiqueta="Cargando los mensajes…" />}
            {datos && opciones && form && (
              <>
                {!datos.disponible && (
                  <Callout tone="warning" titulo="Edición todavía no disponible">
                    Esta base aún no tiene la configuración de mensajes (migración pendiente). Mientras tanto se siguen enviando los mensajes de siempre: el recordatorio 24 horas antes.
                  </Callout>
                )}

                <section aria-label="Recordatorio" className="flex flex-col gap-3 rounded-card border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="m-0 text-sm font-semibold">Recordatorio de cita</h3>
                    <label className="flex items-center gap-2 text-[13px]">
                      <Switch aria-label="Enviar recordatorio de cita" checked={form.reminderEnabled} disabled={!editable} onCheckedChange={(v) => cambiar("reminderEnabled", v)} />
                      Enviar
                    </label>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <FormField label="Horas antes de la cita" hint={`De ${lim?.anticipacionMin ?? 1} a ${lim?.anticipacionMax ?? 72}. Por defecto 24.`}>
                      <Input type="number" inputMode="numeric" min={lim?.anticipacionMin ?? 1} max={lim?.anticipacionMax ?? 72} value={form.reminderLeadHours} disabled={!editable} onChange={(e) => cambiar("reminderLeadHours", e.target.value)} />
                    </FormField>
                    <FormField label="Enviar desde">
                      <NativeSelect value={form.sendWindowStart} disabled={!editable} onChange={(e) => cambiar("sendWindowStart", e.target.value)}>
                        <option value="">Cualquier hora</option>
                        {HORAS_INICIO.map((h) => (
                          <option key={h} value={h}>
                            {hora(h)}
                          </option>
                        ))}
                      </NativeSelect>
                    </FormField>
                    <FormField label="Enviar hasta" hint="Hora local del negocio. Fuera del horario el recordatorio espera.">
                      <NativeSelect value={form.sendWindowEnd} disabled={!editable} onChange={(e) => cambiar("sendWindowEnd", e.target.value)}>
                        <option value="">Cualquier hora</option>
                        {HORAS_FIN.map((h) => (
                          <option key={h} value={h}>
                            {hora(h)}
                          </option>
                        ))}
                      </NativeSelect>
                    </FormField>
                  </div>
                </section>

                {MENSAJE_KINDS.map((kind) => (
                  <PlantillaCampo key={kind} kind={kind} form={form} opciones={opciones} editable={editable} cambiar={cambiar} />
                ))}

                {aviso && (
                  <Callout tone={conflicto ? "warning" : aviso.startsWith("Guardado") || aviso.startsWith("Se restablecieron") ? "success" : "danger"}>
                    {aviso}
                    {conflicto && (
                      <Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => setRecarga((n) => n + 1)}>
                        Recargar lo vigente
                      </Button>
                    )}
                  </Callout>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={ocupado || !editable} onClick={() => void revisar()}>
                    Revisar cambios
                  </Button>
                  {datos.version > 0 && (
                    <Button type="button" variant="outline" disabled={ocupado || !editable} onClick={() => void restablecer()}>
                      Volver a los valores por defecto
                    </Button>
                  )}
                </div>

                {previa && (
                  <section aria-label="Vista previa de los cambios" className="flex flex-col gap-3 rounded-card border border-border p-3">
                    <h3 className="m-0 text-sm font-semibold">Así se verían (datos de ejemplo)</h3>
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {previa.vistaPrevia.map((m) => (
                        <li key={m.kind} className="rounded-lg border border-border bg-card p-2.5 text-[13px]">
                          <p className="m-0 mb-1 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                            {opciones.mensajes.find((x) => x.kind === m.kind)?.etiqueta}
                            <StatusBadge tone={m.activo ? "success" : "neutral"}>{m.activo ? "Activo" : "Apagado"}</StatusBadge>
                          </p>
                          <p className="m-0 whitespace-pre-line">{m.texto}</p>
                        </li>
                      ))}
                    </ul>
                    <h3 className="m-0 text-sm font-semibold">Qué cambia</h3>
                    {previa.diferencias.length === 0 ? (
                      <p className="m-0 text-[13px] text-muted-foreground">No hay cambios respecto a lo vigente.</p>
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                        {previa.diferencias.map((d) => (
                          <li key={d.campo}>
                            <strong>{d.campo}:</strong> <span className="text-muted-foreground line-through">{d.antes || "(por defecto)"}</span> → <span>{d.despues || "(por defecto)"}</span>
                          </li>
                        ))}
                      </ul>
                    )}
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

                {datos.disponible && (
                  <section aria-label="Historial de cambios" className="flex flex-col gap-2">
                    <h3 className="m-0 text-sm font-semibold">Historial</h3>
                    {historial.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">Todavía no hay cambios guardados.</p>}
                    {historial.map((h) => (
                      <div key={h.version} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-2.5 text-[13px]">
                        <div>
                          <p className="m-0 font-semibold">
                            Versión {h.version} <StatusBadge tone={h.accion === "restablecido" ? "warning" : "info"}>{h.accion === "restablecido" ? "Restablecido" : "Actualizado"}</StatusBadge>
                          </p>
                          <p className="m-0 text-xs text-muted-foreground">
                            {fecha(h.creadoEn)}
                            {h.actorNombre ? ` · ${h.actorNombre}` : ""}
                            {h.diferencias.length > 0 ? ` · Cambió: ${h.diferencias.map((d) => d.campo).join(", ")}` : ""}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setForm(formDesdeConfig({ ...datos.config, ...(h.nuevo as Partial<typeof datos.config>) }));
                            setPrevia(null);
                            setAviso(`Se cargó la versión ${h.version} en el formulario. Revisa los cambios y guárdalos para aplicarla.`);
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
      )}
    </div>
  );
}

interface PlantillaCampoProps {
  readonly kind: MensajeKind;
  readonly form: FormMensajes;
  readonly opciones: OpcionesMensajesWire;
  readonly editable: boolean;
  readonly cambiar: <K extends keyof FormMensajes>(campo: K, valor: FormMensajes[K]) => void;
}

function PlantillaCampo({ kind, form, opciones, editable, cambiar }: PlantillaCampoProps) {
  const info = opciones.mensajes.find((m) => m.kind === kind);
  if (!info) return null;
  const { texto, activo } = TEXTO_CAMPO[kind];
  const valor = form[texto] as string;
  const prendido = form[activo] as boolean;
  const max = opciones.limites.texto;
  return (
    <section aria-label={info.etiqueta} className="flex flex-col gap-2 rounded-card border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-semibold">{info.etiqueta}</h3>
        {kind !== "recordatorio" && (
          <label className="flex items-center gap-2 text-[13px]">
            <Switch aria-label={`Enviar ${info.etiqueta.toLowerCase()}`} checked={prendido} disabled={!editable} onCheckedChange={(v) => cambiar(activo, v as never)} />
            Enviar
          </label>
        )}
      </div>
      <FormField label="Texto" hint={`${valor.length}/${max}. Déjalo vacío para usar el texto por defecto.`}>
        <Textarea rows={3} value={valor} maxLength={max} disabled={!editable} placeholder={info.textoPorOmision} onChange={(e) => cambiar(texto, e.target.value as never)} />
      </FormField>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>Variables:</span>
        {info.variables.map((v) => (
          <button
            key={v}
            type="button"
            disabled={!editable}
            className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground disabled:opacity-50"
            onClick={() => cambiar(texto, `${valor}{{${v}}}` as never)}
          >
            {`{{${v}}}`}
          </button>
        ))}
      </div>
    </section>
  );
}
