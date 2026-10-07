// H-26 -- paneles residuales de Housekeeping: Blancos, Opt-out de limpieza y Configuracion, mas el dialogo de fotos de una tarea.
// Cada control llama a un endpoint real (apps/api/.../hoteles/housekeeping-residual.ts); contra una base sin la migracion 039 la
// pantalla muestra el estado honesto "no disponible aun" en lugar de aparentar funcionar. La vision artificial de las fotos NO esta
// construida: se declara asi, sin ningun control que la simule.
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, FormDialog, FormField, Input, NativeSelect, StatusBadge, Switch } from "@atiende/ui";
import {
  HK_CONFIG_ROLES,
  LINEN_LABELS,
  PHOTO_ACCEPT,
  archivoABase64,
  descargarFoto,
  fetchBlancos,
  fetchConfigHk,
  fetchFotos,
  fetchOptOuts,
  guardarBlancos,
  registrarOptOut,
  retirarFoto,
  revertirOptOut,
  saveConfigHk,
  subirFoto,
} from "../lib/housekeeping-residual-client.ts";
import type { BlancosResponse, FotosTareaResponse, HkConfig, LinenItem, OptOutResponse } from "../lib/housekeeping-residual-client.ts";
import type { TableroHabitacion, TareaTipo } from "../lib/limpieza-client.ts";
import { HK_TASK_ROLES, TAREA_TIPO_LABELS } from "../lib/limpieza-client.ts";

interface PanelProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly role: string;
  readonly fecha: string;
}

const NO_DISPONIBLE = "Esta función aún no está disponible en tu base de datos: requiere la actualización 039 de housekeeping. Cuando se aplique, se activa sola.";

function mensaje(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function numero(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Blancos
// ---------------------------------------------------------------------------------------------------------------

export function BlancosPanel({ apiBaseUrl, token, propertyId, role, fecha }: PanelProps) {
  const [data, setData] = useState<BlancosResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ articulo: LinenItem; limpias: string; sucias: string; enLavanderia: string; danadas: string }>({ articulo: "sabanas", limpias: "0", sucias: "0", enLavanderia: "0", danadas: "0" });
  const puedeContar = HK_TASK_ROLES.has(role);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchBlancos(fetch, apiBaseUrl, token, propertyId, fecha));
    } catch (err) {
      setError(mensaje(err, "No se pudo cargar el conteo de blancos."));
    }
  }, [apiBaseUrl, token, propertyId, fecha]);
  useEffect(() => {
    void load();
  }, [load]);

  function elegir(articulo: LinenItem) {
    const actual = data?.articulos.find((a) => a.articulo === articulo);
    setForm({ articulo, limpias: String(actual?.limpias ?? 0), sucias: String(actual?.sucias ?? 0), enLavanderia: String(actual?.enLavanderia ?? 0), danadas: String(actual?.danadas ?? 0) });
  }

  async function guardar() {
    setBusy(true);
    setError(null);
    setAviso(null);
    try {
      await guardarBlancos(fetch, apiBaseUrl, token, propertyId, {
        fecha,
        articulo: form.articulo,
        limpias: numero(form.limpias),
        sucias: numero(form.sucias),
        enLavanderia: numero(form.enLavanderia),
        danadas: numero(form.danadas),
      });
      setAviso(`Conteo de ${LINEN_LABELS[form.articulo].toLowerCase()} guardado.`);
      await load();
    } catch (err) {
      setError(mensaje(err, "No se pudo guardar el conteo."));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />;
  if (!data) return <EstadoCargando etiqueta="Cargando blancos…" />;
  return (
    <div className="flex flex-col gap-4">
      {!data.disponible && <Callout tone="warning">{NO_DISPONIBLE}</Callout>}
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {aviso && <p role="status" className="text-sm text-foreground">{aviso}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.articulos.map((a) => (
          <Card key={a.articulo}>
            <CardContent className="p-4 flex flex-col gap-1.5">
              <p className="font-medium text-foreground">{LINEN_LABELS[a.articulo]}</p>
              {a.total === null ? (
                <p className="text-xs text-muted-foreground">Sin conteo el {fecha}.</p>
              ) : (
                <>
                  <p className="text-xs text-foreground">
                    {a.limpias} limpias · {a.sucias} sucias · {a.enLavanderia} en lavandería · {a.danadas} dañadas
                  </p>
                  <p className="text-xs text-muted-foreground">Total {a.total}</p>
                </>
              )}
              {a.diferencia !== null && a.conteoAnterior && (
                <p className="text-xs">
                  <StatusBadge tone={a.diferencia < 0 ? "danger" : "success"}>
                    {a.diferencia === 0 ? "Sin diferencia" : a.diferencia < 0 ? `Faltan ${Math.abs(a.diferencia)}` : `Sobran ${a.diferencia}`}
                  </StatusBadge>{" "}
                  <span className="text-muted-foreground">vs. conteo del {a.conteoAnterior.fecha} ({a.conteoAnterior.total})</span>
                </p>
              )}
              {puedeContar && data.disponible && (
                <Button type="button" size="sm" variant="outline" className="self-start mt-1" onClick={() => elegir(a.articulo)}>
                  {a.total === null ? "Contar" : "Corregir"}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {puedeContar && data.disponible && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-3">
            <p className="font-medium text-foreground">Registrar conteo del {fecha}</p>
            <div className="grid gap-3 sm:grid-cols-5">
              <FormField label="Artículo">
                <NativeSelect value={form.articulo} onChange={(e) => elegir(e.target.value as LinenItem)}>
                  {(Object.keys(LINEN_LABELS) as LinenItem[]).map((k) => (
                    <option key={k} value={k}>{LINEN_LABELS[k]}</option>
                  ))}
                </NativeSelect>
              </FormField>
              {([["limpias", "Limpias"], ["sucias", "Sucias"], ["enLavanderia", "En lavandería"], ["danadas", "Dañadas"]] as const).map(([k, label]) => (
                <FormField key={k} label={label}>
                  <Input type="number" min={0} max={100000} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                </FormField>
              ))}
            </div>
            <Button type="button" className="self-start" disabled={busy} onClick={() => void guardar()}>
              {busy ? "Guardando…" : "Guardar conteo"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Opt-out de limpieza
// ---------------------------------------------------------------------------------------------------------------

export function OptOutPanel({ apiBaseUrl, token, propertyId, role, fecha, habitaciones }: PanelProps & { readonly habitaciones: readonly TableroHabitacion[] }) {
  const [data, setData] = useState<OptOutResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [roomId, setRoomId] = useState("");
  const [origen, setOrigen] = useState<"huesped" | "recepcion">("huesped");
  const [nota, setNota] = useState("");
  const puede = HK_TASK_ROLES.has(role);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchOptOuts(fetch, apiBaseUrl, token, propertyId, fecha));
    } catch (err) {
      setError(mensaje(err, "No se pudo cargar los opt-out de limpieza."));
    }
  }, [apiBaseUrl, token, propertyId, fecha]);
  useEffect(() => {
    void load();
  }, [load]);

  async function registrar() {
    if (!roomId) return;
    setBusy("registrar");
    setError(null);
    setAviso(null);
    try {
      const r = await registrarOptOut(fetch, apiBaseUrl, token, propertyId, { roomId, fecha, origen, ...(nota.trim() ? { nota: nota.trim() } : {}) });
      setAviso(`Habitación ${r.habitacion}: sin limpieza de estancia el ${fecha}. ${r.tareasCanceladas} tarea(s) pendiente(s) cancelada(s).`);
      setRoomId("");
      setNota("");
      await load();
    } catch (err) {
      setError(mensaje(err, "No se pudo registrar el opt-out."));
    } finally {
      setBusy(null);
    }
  }

  async function revertir(id: string) {
    setBusy(id);
    setError(null);
    try {
      await revertirOptOut(fetch, apiBaseUrl, token, propertyId, id);
      await load();
    } catch (err) {
      setError(mensaje(err, "No se pudo revertir el opt-out."));
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) return <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />;
  if (!data) return <EstadoCargando etiqueta="Cargando opt-out…" />;
  const activos = data.optOuts.filter((o) => o.estado === "activo");
  return (
    <div className="flex flex-col gap-4">
      {!data.disponible && <Callout tone="warning">{NO_DISPONIBLE}</Callout>}
      <p className="text-sm text-muted-foreground">
        El huésped que no quiere servicio de limpieza un día: no se generan tareas de estancia ni de repaso de esa habitación. La limpieza de salida y la profunda no se omiten. No se guarda ningún dato del huésped.
      </p>
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {aviso && <p role="status" className="text-sm text-foreground">{aviso}</p>}
      {puede && data.disponible && (
        <Card>
          <CardContent className="p-4 grid gap-3 sm:grid-cols-4 items-end">
            <FormField label="Habitación">
              <NativeSelect value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                <option value="">Elige una habitación</option>
                {habitaciones.map((h) => (
                  <option key={h.roomId} value={h.roomId}>{h.codigo}</option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Quién lo pide">
              <NativeSelect value={origen} onChange={(e) => setOrigen(e.target.value as "huesped" | "recepcion")}>
                <option value="huesped">El huésped</option>
                <option value="recepcion">Recepción</option>
              </NativeSelect>
            </FormField>
            <FormField label="Nota (opcional)">
              <Input value={nota} maxLength={200} onChange={(e) => setNota(e.target.value)} />
            </FormField>
            <Button type="button" disabled={!roomId || busy === "registrar"} onClick={() => void registrar()}>
              {busy === "registrar" ? "Registrando…" : "Registrar opt-out"}
            </Button>
          </CardContent>
        </Card>
      )}
      {data.optOuts.length === 0 && data.disponible && <EstadoVacio mensaje={`Ninguna habitación pidió omitir la limpieza el ${fecha}.`} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.optOuts.map((o) => (
          <Card key={o.id}>
            <CardContent className="p-4 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-foreground">Habitación {o.habitacion}</p>
                <StatusBadge tone={o.estado === "activo" ? "info" : "neutral"}>{o.estado === "activo" ? "Activo" : "Revertido"}</StatusBadge>
              </div>
              <p className="text-xs text-muted-foreground">Pedido por {o.origen === "huesped" ? "el huésped" : o.origen === "recepcion" ? "recepción" : "WhatsApp"}{o.nota ? ` · ${o.nota}` : ""}</p>
              {puede && o.estado === "activo" && (
                <Button type="button" size="sm" variant="outline" className="self-start mt-1" disabled={busy === o.id} onClick={() => void revertir(o.id)}>
                  Revertir
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {activos.length > 0 && <p className="text-xs text-muted-foreground">{activos.length} habitación(es) sin limpieza de estancia hoy.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Configuracion
// ---------------------------------------------------------------------------------------------------------------

const TIPOS: readonly TareaTipo[] = ["salida", "estancia", "profunda", "repaso"];

export function ConfiguracionHkPanel({ apiBaseUrl, token, propertyId, role }: Omit<PanelProps, "fecha">) {
  const [cfg, setCfg] = useState<HkConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ max: string; jornada: string; fotos: string; hora: string; minutos: Record<TareaTipo, string> } | null>(null);
  const puedeEditar = HK_CONFIG_ROLES.has(role);

  const aplicar = useCallback((c: HkConfig) => {
    setCfg(c);
    setDraft({
      max: String(c.maxTareasPorCamarista),
      jornada: String(c.minutosJornada),
      fotos: String(c.maxFotosPorTarea),
      hora: String(c.horaArranque),
      minutos: { salida: String(c.minutosPorTipo.salida), estancia: String(c.minutosPorTipo.estancia), profunda: String(c.minutosPorTipo.profunda), repaso: String(c.minutosPorTipo.repaso) },
    });
  }, []);
  const load = useCallback(async () => {
    setError(null);
    try {
      aplicar(await fetchConfigHk(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(mensaje(err, "No se pudo cargar la configuración."));
    }
  }, [apiBaseUrl, token, propertyId, aplicar]);
  useEffect(() => {
    void load();
  }, [load]);

  async function guardar(patch: Parameters<typeof saveConfigHk>[4], ok: string) {
    setBusy(true);
    setError(null);
    setAviso(null);
    try {
      aplicar(await saveConfigHk(fetch, apiBaseUrl, token, propertyId, patch));
      setAviso(ok);
    } catch (err) {
      setError(mensaje(err, "No se pudo guardar la configuración."));
    } finally {
      setBusy(false);
    }
  }

  if (error && !cfg) return <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />;
  if (!cfg || !draft) return <EstadoCargando etiqueta="Cargando configuración…" />;
  const editable = puedeEditar && cfg.disponible;
  return (
    <div className="flex flex-col gap-4">
      {!cfg.disponible && <Callout tone="warning">{NO_DISPONIBLE}</Callout>}
      {!puedeEditar && <p className="text-sm text-muted-foreground">Solo el dueño o la gerencia pueden cambiar esta configuración. Aquí ves los valores vigentes.</p>}
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {aviso && <p role="status" className="text-sm text-foreground">{aviso}</p>}
      <Card>
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-foreground">Asignación automática de camaristas</p>
              <p className="text-xs text-muted-foreground">Reparte las tareas sin responsable equilibrando minutos de trabajo, con prioridad alta primero, sin pasar de la jornada ni del tope de tareas.</p>
            </div>
            <Switch aria-label="Asignación automática" checked={cfg.asignacionAutomatica} disabled={!editable || busy} onCheckedChange={(v) => void guardar({ asignacionAutomatica: v }, v ? "Asignación automática encendida." : "Asignación automática apagada.")} />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-foreground">Fotos obligatorias para aprobar una inspección</p>
              <p className="text-xs text-muted-foreground">Sin al menos una foto de la tarea no se puede aprobar. Rechazar nunca exige foto.</p>
            </div>
            <Switch aria-label="Fotos obligatorias en inspección" checked={cfg.fotosObligatoriasEnInspeccion} disabled={!editable || busy} onCheckedChange={(v) => void guardar({ fotosObligatoriasEnInspeccion: v }, v ? "Las inspecciones exigen foto." : "Las inspecciones ya no exigen foto.")} />
          </div>
          <p className="text-xs text-muted-foreground">
            Análisis automático de las fotos con visión por computadora: no disponible aún ({cfg.vision.requiere}). Hoy las fotos son evidencia que revisa una persona; no se envía ninguna imagen a un modelo ni se genera gasto.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4 flex flex-col gap-3">
          <p className="font-medium text-foreground">Cargas y tiempos</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Máx. tareas por camarista" hint="1 a 60">
              <Input type="number" min={1} max={60} value={draft.max} disabled={!editable} onChange={(e) => setDraft({ ...draft, max: e.target.value })} />
            </FormField>
            <FormField label="Minutos de jornada" hint="60 a 720">
              <Input type="number" min={60} max={720} value={draft.jornada} disabled={!editable} onChange={(e) => setDraft({ ...draft, jornada: e.target.value })} />
            </FormField>
            <FormField label="Máx. fotos por tarea" hint="1 a 10">
              <Input type="number" min={1} max={10} value={draft.fotos} disabled={!editable} onChange={(e) => setDraft({ ...draft, fotos: e.target.value })} />
            </FormField>
            <FormField label="Hora de arranque del día" hint={cfg.horaArranqueDisponible ? "0 a 23, hora local del hotel" : "No disponible aún: requiere la actualización 045"}>
              <Input type="number" min={0} max={23} value={draft.hora} disabled={!editable || !cfg.horaArranqueDisponible} onChange={(e) => setDraft({ ...draft, hora: e.target.value })} />
            </FormField>
          </div>
          <p className="text-xs text-muted-foreground">A esa hora el sistema genera solo las tareas del día (respetando los opt-out de limpieza) y, si la asignación automática está encendida, las reparte entre las camaristas.</p>
          <div className="grid gap-3 sm:grid-cols-4">
            {TIPOS.map((t) => (
              <FormField key={t} label={`Minutos: ${TAREA_TIPO_LABELS[t].toLowerCase()}`} hint="5 a 240">
                <Input type="number" min={5} max={240} value={draft.minutos[t]} disabled={!editable} onChange={(e) => setDraft({ ...draft, minutos: { ...draft.minutos, [t]: e.target.value } })} />
              </FormField>
            ))}
          </div>
          {editable && (
            <Button
              type="button"
              className="self-start"
              disabled={busy}
              onClick={() =>
                void guardar(
                  {
                    maxTareasPorCamarista: numero(draft.max),
                    minutosJornada: numero(draft.jornada),
                    maxFotosPorTarea: numero(draft.fotos),
                    ...(cfg.horaArranqueDisponible ? { horaArranque: numero(draft.hora) } : {}),
                    minutosPorTipo: { salida: numero(draft.minutos.salida), estancia: numero(draft.minutos.estancia), profunda: numero(draft.minutos.profunda), repaso: numero(draft.minutos.repaso) },
                  },
                  "Configuración guardada.",
                )
              }
            >
              {busy ? "Guardando…" : "Guardar cambios"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Fotos de una tarea
// ---------------------------------------------------------------------------------------------------------------

export interface FotosDialogProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly role: string;
  readonly taskId: string;
  readonly habitacion: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function FotosDialog({ apiBaseUrl, token, propertyId, role, taskId, habitacion, open, onOpenChange }: FotosDialogProps) {
  const [data, setData] = useState<FotosTareaResponse | null>(null);
  const [miniaturas, setMiniaturas] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const puede = HK_TASK_ROLES.has(role);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetchFotos(fetch, apiBaseUrl, token, propertyId, taskId);
      setData(r);
      const next: Record<string, string> = {};
      for (const f of r.fotos) {
        try {
          next[f.id] = URL.createObjectURL(await descargarFoto(fetch, apiBaseUrl, token, propertyId, taskId, f.id));
        } catch {
          // una miniatura que no carga no debe tapar la lista: se muestra sin vista previa
        }
      }
      setMiniaturas((prev) => {
        for (const url of Object.values(prev)) URL.revokeObjectURL(url);
        return next;
      });
    } catch (err) {
      setError(mensaje(err, "No se pudieron cargar las fotos."));
    }
  }, [apiBaseUrl, token, propertyId, taskId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  const miniaturasRef = useRef(miniaturas);
  miniaturasRef.current = miniaturas;
  useEffect(
    () => () => {
      for (const url of Object.values(miniaturasRef.current)) URL.revokeObjectURL(url);
    },
    [],
  );

  async function subir(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await subirFoto(fetch, apiBaseUrl, token, propertyId, taskId, await archivoABase64(file));
      await load();
    } catch (err) {
      setError(mensaje(err, "No se pudo subir la foto."));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function retirar(id: string) {
    setBusy(true);
    setError(null);
    try {
      await retirarFoto(fetch, apiBaseUrl, token, propertyId, taskId, id);
      await load();
    } catch (err) {
      setError(mensaje(err, "No se pudo retirar la foto."));
    } finally {
      setBusy(false);
    }
  }

  const lleno = data ? data.fotos.length >= data.maximo : false;
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} titulo={`Fotos de la habitación ${habitacion}`} subtitulo="Evidencia de la limpieza para la inspección." anchoClase="max-w-2xl" footer={<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cerrar</Button>}>
      <div className="flex flex-col gap-3">
        {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
        {!data && !error && <EstadoCargando etiqueta="Cargando fotos…" />}
        {data && !data.disponible && <Callout tone="warning">{NO_DISPONIBLE}</Callout>}
        {data && data.disponible && data.fotos.length === 0 && <EstadoVacio mensaje="Esta tarea aún no tiene fotos." />}
        {data && data.fotos.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-3">
            {data.fotos.map((f) => (
              <li key={f.id} className="flex flex-col gap-1.5">
                {miniaturas[f.id] ? (
                  <img src={miniaturas[f.id]} alt={f.descripcion ?? `Foto de la habitación ${habitacion}`} className="aspect-square w-full rounded-md border border-border object-cover" />
                ) : (
                  <div className="aspect-square w-full rounded-md border border-border bg-muted" />
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{Math.max(1, Math.round(f.bytes / 1024))} KB</span>
                  {puede && (
                    <Button type="button" size="sm" variant="outline" aria-label="Retirar foto" disabled={busy} onClick={() => void retirar(f.id)}>
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {data && data.disponible && puede && (
          <div className="flex items-center gap-3 flex-wrap">
            <input ref={inputRef} type="file" accept={PHOTO_ACCEPT} capture="environment" className="sr-only" aria-label="Elegir foto" onChange={(e) => void subir(e.target.files?.[0])} />
            <Button type="button" disabled={busy || lleno} onClick={() => inputRef.current?.click()}>
              <Camera className="w-4 h-4" strokeWidth={1.75} />
              {busy ? "Subiendo…" : "Agregar foto"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {data.fotos.length} de {data.maximo} · JPEG, PNG o WebP hasta 1.5 MB{lleno ? " · tope alcanzado" : ""}
            </span>
          </div>
        )}
      </div>
    </FormDialog>
  );
}
