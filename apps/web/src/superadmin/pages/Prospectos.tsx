// "Cerebro de ventas" -- prospectos del back office de plataforma (SA-L-37, SA-L-38, SA-L-41). El cerebro PROPONE y el humano
// envia: esta pantalla no contacta a nadie. Cada fila tiene su detalle desplegable con las barras de score (ajuste ICP, urgencia,
// cierre y completitud) y el "por que" punto por punto (regla, puntos y evidencia con fuente y fecha); con menos de 3 senales dice
// "SENAL INSUFICIENTE: falta X, como conseguirlo".
//
// Backend real: GET/POST/PUT /superadmin/cerebro/prospectos, GET .../:id/detalle y POST .../:id/personas
// (apps/api/src/routes/superadmin-cerebro.ts, ver docs/SUPERADMIN_CEREBRO.md); el cambio de etapa sigue usando PATCH
// /superadmin/prospectos/:id (cada cambio escribe un evento en la linea de tiempo). Base sin migrar (disponible:false): la lista y
// el alta de hoy siguen funcionando con los campos de siempre y los controles nuevos no se muestran (aviso honesto).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Brain, ChevronDown, ChevronRight, Building2, Pencil, Plus, TrendingUp, UserPlus, Tags } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, FormDialog, FormField, Input, NativeSelect, PageContainer, PageHeader, StatCard, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, statusTone } from "@atiende/ui";
import { BarraProgreso } from "../../components/BarraProgreso.tsx";
import type { BarraProgresoTono } from "../../components/BarraProgreso.tsx";
import { fechaCortaEsMx, fechaHoraEsMx } from "../../lib/formato-fecha.ts";
import { fetchJson } from "../lib/fetch-json.ts";
import { PROSPECTO_ESTADO_TONES } from "../lib/status-tones.ts";

interface Senal {
  readonly tipo: string;
  readonly valor: string | null;
  readonly fuente: string;
  readonly url: string | null;
  readonly observadoEn: string;
}

interface Prospecto {
  readonly id: string;
  readonly empresa: string;
  readonly vertical: string;
  readonly ciudad: string | null;
  readonly contactoNombre: string | null;
  readonly telefono: string | null;
  readonly correo: string | null;
  readonly estado: string;
  readonly fuente: string | null;
  readonly notas: string | null;
  readonly updatedAt: string;
  readonly subtipo?: string | null;
  readonly tamano?: string | null;
  readonly entidad?: string | null;
  readonly municipio?: string | null;
  readonly zona?: string | null;
  readonly sitioWeb?: string | null;
  readonly sitioVerificado?: boolean;
  readonly senales?: readonly Senal[];
  readonly baseLicitud?: string | null;
  readonly consentimientoEn?: string | null;
  readonly scoreAjuste?: number | null;
  readonly scoreUrgencia?: number | null;
  readonly scoreCierre?: number | null;
  readonly scoreCompletitud?: number | null;
  readonly scoreExplicacion?: ExplicacionScore | null;
  readonly scoreVersion?: string | null;
  readonly siguientePaso?: string | null;
  readonly siguientePasoEn?: string | null;
  readonly contactoLegado?: boolean;
}

interface Evidencia {
  readonly fuente: string;
  readonly fecha: string;
  readonly url?: string;
  readonly valor?: string;
}
interface ItemScore {
  readonly regla: string;
  readonly puntos: number;
  readonly evidencia: Evidencia;
}
interface DimensionScore {
  readonly puntaje: number | null;
  readonly items: readonly ItemScore[];
}
interface ExplicacionScore {
  readonly version: string;
  readonly dimensiones: Readonly<Record<DimensionClave, DimensionScore>>;
  readonly insuficiente: { readonly mensaje: string } | null;
}
type DimensionClave = "ajuste" | "urgencia" | "cierre" | "completitud";

interface TaxonomiaVigente {
  readonly vertical: string;
  readonly version: number;
  readonly subtipos: readonly { readonly clave: string; readonly nombre: string }[];
  readonly rangosTamano: { readonly unidad: string; readonly rangos: readonly { readonly clave: string; readonly etiqueta: string }[] };
  readonly senales: readonly { readonly tipo: string; readonly nombre: string; readonly dimension: string; readonly puntos: number; readonly comoConseguirla: string }[];
}

interface Respuesta {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly prospectos: readonly Prospecto[];
  readonly taxonomias: readonly TaxonomiaVigente[];
}

interface Persona {
  readonly id: string;
  readonly nombre: string;
  readonly cargo: string | null;
  readonly canal: string;
  readonly origen: string;
  readonly confianza: string;
  readonly evidenciaUrl: string;
}
interface Evento {
  readonly id: string;
  readonly tipo: string;
  readonly detalle: Readonly<Record<string, unknown>>;
  readonly creadoEn: string;
}

const NOMBRE_VERTICAL: Record<string, string> = {
  hoteles: "Hoteles",
  restaurantes: "Restaurantes",
  citas: "Citas",
  licitaciones: "Licitaciones",
  despachos: "Despachos",
  rentas: "Rentas vacacionales",
};

// Mismo orden real del embudo que la migracion 0012 -- 5 etapas de avance + 3 desenlaces terminales.
const ESTADOS: readonly string[] = ["nuevo", "contactado", "demo", "propuesta", "negociacion", "ganado", "perdido", "descartado"];

const NOMBRE_ESTADO: Record<string, string> = {
  nuevo: "Nuevo",
  contactado: "Contactado",
  demo: "Demo",
  propuesta: "Propuesta",
  negociacion: "Negociación",
  ganado: "Ganado",
  perdido: "Perdido",
  descartado: "Descartado",
};

const NOMBRE_BASE: Record<string, string> = {
  interes_declarado: "Interés declarado",
  relacion_previa: "Relación previa",
  fuente_publica_b2b: "Fuente pública B2B",
  referido_con_consentimiento: "Referido con consentimiento",
};
const BASES_CON_CONSENTIMIENTO = new Set(["interes_declarado", "referido_con_consentimiento"]);

const NOMBRE_ORIGEN: Record<string, string> = {
  sitio_web_oficial: "Sitio web oficial",
  directorio_publico: "Directorio público",
  perfil_profesional_publico: "Perfil profesional público",
  formulario_propio: "Formulario propio",
  referido_documentado: "Referido documentado",
};
const NOMBRE_CANAL: Record<string, string> = { telefono: "Teléfono", correo: "Correo", whatsapp: "WhatsApp", otro: "Otro" };
const NOMBRE_EVENTO: Record<string, string> = {
  toque_saliente: "Toque saliente",
  toque_entrante: "Toque entrante",
  cambio_etapa: "Cambio de etapa",
  nota: "Nota",
  importacion: "Importación",
  enriquecimiento: "Enriquecimiento",
};

const DIMENSIONES: readonly { readonly clave: DimensionClave; readonly etiqueta: string }[] = [
  { clave: "ajuste", etiqueta: "Ajuste ICP" },
  { clave: "urgencia", etiqueta: "Urgencia" },
  { clave: "cierre", etiqueta: "Cierre" },
  { clave: "completitud", etiqueta: "Completitud" },
];

function badgeDeEstado(estado: string) {
  return <StatusBadge tone={statusTone(PROSPECTO_ESTADO_TONES, estado)}>{NOMBRE_ESTADO[estado] ?? estado}</StatusBadge>;
}

function tonoDeScore(valor: number): BarraProgresoTono {
  if (valor >= 70) return "success";
  if (valor >= 40) return "primary";
  return "warning";
}

function describirEvento(e: Evento): string {
  const d = e.detalle;
  if (e.tipo === "cambio_etapa") return `${NOMBRE_ESTADO[String(d.de)] ?? String(d.de)} → ${NOMBRE_ESTADO[String(d.a)] ?? String(d.a)}`;
  if (e.tipo === "nota" && d.accion === "alta") return "Alta del prospecto";
  if (e.tipo === "enriquecimiento" && d.accion === "persona_agregada") return "Persona de contacto agregada";
  return NOMBRE_EVENTO[e.tipo] ?? e.tipo;
}

interface FormState {
  empresa: string;
  vertical: string;
  subtipo: string;
  tamano: string;
  ciudad: string;
  entidad: string;
  municipio: string;
  zona: string;
  sitioWeb: string;
  sitioVerificado: boolean;
  contactoNombre: string;
  telefono: string;
  correo: string;
  baseLicitud: string;
  consentimientoEn: string;
  fuente: string;
  siguientePaso: string;
  siguientePasoEn: string;
  notas: string;
}
interface SenalForm {
  tipo: string;
  valor: string;
  fuente: string;
  url: string;
  observadoEn: string;
}

const FORM_VACIO: FormState = {
  empresa: "",
  vertical: "hoteles",
  subtipo: "",
  tamano: "",
  ciudad: "",
  entidad: "",
  municipio: "",
  zona: "",
  sitioWeb: "",
  sitioVerificado: false,
  contactoNombre: "",
  telefono: "",
  correo: "",
  baseLicitud: "",
  consentimientoEn: "",
  fuente: "",
  siguientePaso: "",
  siguientePasoEn: "",
  notas: "",
};
const SENAL_VACIA: SenalForm = { tipo: "", valor: "", fuente: "", url: "", observadoEn: "" };

const aDia = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");

function formDe(p: Prospecto): FormState {
  return {
    empresa: p.empresa,
    vertical: p.vertical,
    subtipo: p.subtipo ?? "",
    tamano: p.tamano ?? "",
    ciudad: p.ciudad ?? "",
    entidad: p.entidad ?? "",
    municipio: p.municipio ?? "",
    zona: p.zona ?? "",
    sitioWeb: p.sitioWeb ?? "",
    sitioVerificado: p.sitioVerificado === true,
    contactoNombre: p.contactoNombre ?? "",
    telefono: p.telefono ?? "",
    correo: p.correo ?? "",
    baseLicitud: p.baseLicitud ?? "",
    consentimientoEn: aDia(p.consentimientoEn),
    fuente: p.fuente ?? "",
    siguientePaso: p.siguientePaso ?? "",
    siguientePasoEn: aDia(p.siguientePasoEn),
    notas: p.notas ?? "",
  };
}

const orNull = (v: string): string | null => (v.trim() === "" ? null : v.trim());

function SeccionScore({ p }: { readonly p: Prospecto }) {
  const exp = p.scoreExplicacion;
  if (!p.scoreVersion || !exp) {
    return <p className="text-sm text-muted-foreground">Sin calificar todavía: el score se calcula al guardar el prospecto.</p>;
  }
  return (
    <div className="grid gap-3">
      {exp.insuficiente && (
        <Callout tone="warning" titulo="Señal insuficiente">
          {exp.insuficiente.mensaje}
        </Callout>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {DIMENSIONES.map(({ clave, etiqueta }) => {
          const dim = exp.dimensiones[clave];
          const valor = dim.puntaje;
          return (
            <div key={clave} className="grid gap-1.5 rounded-xl border border-line2 bg-canvas p-3" data-testid={`score-${clave}`}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium text-foreground">{etiqueta}</span>
                <span className="text-muted-foreground">{valor === null ? "Sin calificar" : `${valor} / 100`}</span>
              </div>
              <BarraProgreso valor={valor ?? 0} tono={valor === null ? "warning" : tonoDeScore(valor)} aria-label={`${etiqueta}: ${valor === null ? "sin calificar" : valor}`} />
              {dim.items.length > 0 && (
                <ul className="grid gap-1 text-xs text-muted-foreground">
                  {dim.items.map((i, idx) => (
                    <li key={`${i.regla}-${idx}`}>
                      <span className="font-medium text-foreground">+{i.puntos}</span> {i.regla} (fuente: {i.evidencia.fuente}, {i.evidencia.fecha}
                      {i.evidencia.url ? (
                        <>
                          {", "}
                          <a href={i.evidencia.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                            enlace
                          </a>
                        </>
                      ) : null}
                      )
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Reglas: {p.scoreVersion}. Determinista, sin IA: la misma información da el mismo score.</p>
    </div>
  );
}

function SeccionPersonas({ prospecto, personas, apiBaseUrl, token, onCambio }: { readonly prospecto: Prospecto; readonly personas: readonly Persona[]; readonly apiBaseUrl: string; readonly token: string; readonly onCambio: () => void }) {
  const [abierto, setAbierto] = useState(false);
  const [form, setForm] = useState({ nombre: "", cargo: "", canal: "correo", dato: "", origen: "sitio_web_oficial", confianza: "alta", evidenciaUrl: "" });
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const sinBase = !prospecto.baseLicitud;

  async function agregar(e: FormEvent) {
    e.preventDefault();
    if (form.nombre.trim().length < 2) return setError("Escribe el nombre de la persona.");
    if (!/^https?:\/\/\S{4,}$/iu.test(form.evidenciaUrl.trim())) return setError("La evidencia es obligatoria: indica la URL (http o https) donde viste este dato.");
    setError(null);
    setGuardando(true);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/cerebro/prospectos/${prospecto.id}/personas`, {
        method: "POST",
        body: JSON.stringify({ nombre: form.nombre, cargo: orNull(form.cargo), canal: form.canal, dato: orNull(form.dato), origen: form.origen, confianza: form.confianza, evidenciaUrl: form.evidenciaUrl.trim() }),
      });
      setAbierto(false);
      setForm({ nombre: "", cargo: "", canal: "correo", dato: "", origen: "sitio_web_oficial", confianza: "alta", evidenciaUrl: "" });
      onCambio();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo agregar la persona.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Personas de contacto</h3>
        {!sinBase && (
          <Button type="button" size="sm" variant="outline" className="rounded-full gap-1.5" onClick={() => setAbierto((v) => !v)}>
            <UserPlus className="w-4 h-4" strokeWidth={1.75} />
            Agregar persona
          </Button>
        )}
      </div>
      {sinBase && <p className="text-xs text-muted-foreground">Registra primero la base de licitud del prospecto (Editar) para poder agregar personas de contacto.</p>}
      {personas.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin personas registradas. Cada una exige la evidencia pública de donde salió el dato; no se aceptan correos deducidos por patrón.</p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {personas.map((x) => (
            <li key={x.id} className="rounded-lg border border-line2 bg-canvas px-3 py-2">
              <span className="font-medium text-foreground">{x.nombre}</span>
              {x.cargo ? <span className="text-muted-foreground"> · {x.cargo}</span> : null}
              <span className="block text-xs text-muted-foreground">
                {NOMBRE_CANAL[x.canal] ?? x.canal} · {NOMBRE_ORIGEN[x.origen] ?? x.origen} · confianza {x.confianza} ·{" "}
                <a href={x.evidenciaUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  evidencia
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
      {abierto && (
        <form onSubmit={agregar} className="grid gap-3 rounded-xl border border-line2 bg-canvas p-3" aria-label="Agregar persona de contacto">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Nombre" required>
              <Input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
            </FormField>
            <FormField label="Cargo">
              <Input value={form.cargo} onChange={(e) => setForm({ ...form, cargo: e.target.value })} />
            </FormField>
            <FormField label="Canal">
              <NativeSelect value={form.canal} onChange={(e) => setForm({ ...form, canal: e.target.value })}>
                {Object.entries(NOMBRE_CANAL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Dato de contacto">
              <Input value={form.dato} onChange={(e) => setForm({ ...form, dato: e.target.value })} autoComplete="off" />
            </FormField>
            <FormField label="Origen del dato" required>
              <NativeSelect value={form.origen} onChange={(e) => setForm({ ...form, origen: e.target.value })}>
                {Object.entries(NOMBRE_ORIGEN).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Confianza">
              <NativeSelect value={form.confianza} onChange={(e) => setForm({ ...form, confianza: e.target.value })}>
                <option value="alta">Alta</option>
                <option value="media">Media</option>
                <option value="baja">Baja</option>
              </NativeSelect>
            </FormField>
          </div>
          <FormField label="Evidencia (URL donde viste el dato)" required hint="Obligatoria. Sin evidencia el dato se rechaza.">
            <Input value={form.evidenciaUrl} onChange={(e) => setForm({ ...form, evidenciaUrl: e.target.value })} inputMode="url" placeholder="https://" />
          </FormField>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setAbierto(false)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" className="rounded-full px-6" disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar persona"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function DetalleProspecto({ p, apiBaseUrl, token, onEditar, onCambio }: { readonly p: Prospecto; readonly apiBaseUrl: string; readonly token: string; readonly onEditar: () => void; readonly onCambio: () => void }) {
  const [detalle, setDetalle] = useState<{ readonly disponible: boolean; readonly personas: readonly Persona[]; readonly eventos: readonly Evento[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      setDetalle(await fetchJson(apiBaseUrl, token, `/superadmin/cerebro/prospectos/${p.id}/detalle`));
    } catch {
      setError("No se pudo cargar el detalle del prospecto.");
    }
  }, [apiBaseUrl, token, p.id]);

  useEffect(() => {
    void cargar();
  }, [cargar, p.updatedAt]);

  return (
    <div className="grid gap-4 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {p.subtipo && <span>Subtipo: {p.subtipo}</span>}
          {p.tamano && <span>Tamaño: {p.tamano}</span>}
          {p.baseLicitud ? <StatusBadge tone="info">Base: {NOMBRE_BASE[p.baseLicitud] ?? p.baseLicitud}</StatusBadge> : null}
          {p.contactoLegado && !p.baseLicitud ? <StatusBadge tone="warning">Sin base de licitud registrada: no contactar</StatusBadge> : null}
        </div>
        <Button type="button" size="sm" variant="outline" className="rounded-full gap-1.5" onClick={onEditar}>
          <Pencil className="w-4 h-4" strokeWidth={1.75} />
          Editar
        </Button>
      </div>

      <SeccionScore p={p} />

      <div className="grid gap-2">
        <h3 className="text-sm font-semibold text-foreground">Señales</h3>
        {(p.senales ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin señales registradas. Cada señal lleva su fuente y la fecha en que se observó.</p>
        ) : (
          <ul className="grid gap-1 text-sm text-muted-foreground">
            {(p.senales ?? []).map((s) => (
              <li key={s.tipo}>
                <span className="font-medium text-foreground">{s.tipo}</span>
                {s.valor ? `: ${s.valor}` : ""} (fuente: {s.fuente}, {aDia(s.observadoEn)})
              </li>
            ))}
          </ul>
        )}
      </div>

      {(p.siguientePaso || p.siguientePasoEn) && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Siguiente paso:</span> {p.siguientePaso ?? "—"} {p.siguientePasoEn ? `(${aDia(p.siguientePasoEn)})` : ""}
        </p>
      )}

      {error && (
        <Callout tone="danger" accion={<Button size="sm" variant="outline" onClick={() => void cargar()}>Reintentar</Button>}>
          {error}
        </Callout>
      )}
      {!detalle && !error && <EstadoCargando etiqueta="Cargando detalle…" />}
      {detalle && !detalle.disponible && <p className="text-sm text-muted-foreground">Personas y línea de tiempo: no disponible aún, requiere la migración 0051.</p>}
      {detalle?.disponible && (
        <>
          <SeccionPersonas prospecto={p} personas={detalle.personas} apiBaseUrl={apiBaseUrl} token={token} onCambio={onCambio} />
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold text-foreground">Línea de tiempo</h3>
            {detalle.eventos.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no hay eventos.</p>
            ) : (
              <ul className="grid gap-1 text-sm text-muted-foreground">
                {detalle.eventos.map((e) => (
                  <li key={e.id}>
                    <span className="font-medium text-foreground">{describirEvento(e)}</span> · {fechaHoraEsMx(e.creadoEn)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function SuperAdminProspectosPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtroVertical, setFiltroVertical] = useState<string>("todos");
  const [filtroEstado, setFiltroEstado] = useState<string>("todos");
  const [expandido, setExpandido] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(FORM_VACIO);
  const [senales, setSenales] = useState<SenalForm[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cambiandoId, setCambiandoId] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      setDatos(await fetchJson<Respuesta>(apiBaseUrl, token, "/superadmin/cerebro/prospectos"));
    } catch {
      setError("No se pudieron cargar los prospectos.");
    }
  }, [apiBaseUrl, token]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const cerebro = datos?.disponible === true;
  const taxonomiaDe = (vertical: string): TaxonomiaVigente | undefined => datos?.taxonomias.find((t) => t.vertical === vertical);

  function abrirAlta() {
    setEditandoId(null);
    setForm(FORM_VACIO);
    setSenales([]);
    setFormError(null);
    setShowForm(true);
  }

  function abrirEdicion(p: Prospecto) {
    setEditandoId(p.id);
    setForm(formDe(p));
    setSenales((p.senales ?? []).map((s) => ({ tipo: s.tipo, valor: s.valor ?? "", fuente: s.fuente, url: s.url ?? "", observadoEn: aDia(s.observadoEn) })));
    setFormError(null);
    setShowForm(true);
  }

  async function handleGuardar(e: FormEvent) {
    e.preventDefault();
    if (!form.empresa.trim()) return setFormError("La empresa es requerida.");
    const hayContacto = Boolean(form.telefono.trim() || form.correo.trim() || form.contactoNombre.trim());
    if (cerebro) {
      if (hayContacto && !form.baseLicitud) return setFormError("La base de licitud es obligatoria para guardar con datos de contacto.");
      if (BASES_CON_CONSENTIMIENTO.has(form.baseLicitud) && !form.consentimientoEn) return setFormError("Esta base de licitud exige la fecha de consentimiento.");
      if (senales.some((s) => !s.tipo || !s.fuente.trim() || !s.observadoEn)) return setFormError("Cada señal necesita tipo, fuente y fecha de observación.");
    }
    setFormError(null);
    setSubmitting(true);
    try {
      if (!cerebro) {
        // Base sin migrar: el alta de siempre, con los campos de siempre.
        await fetchJson(apiBaseUrl, token, "/superadmin/prospectos", {
          method: "POST",
          body: JSON.stringify({ empresa: form.empresa.trim(), vertical: form.vertical, ciudad: orNull(form.ciudad), contactoNombre: orNull(form.contactoNombre), telefono: orNull(form.telefono), correo: orNull(form.correo), fuente: orNull(form.fuente), notas: orNull(form.notas) }),
        });
      } else {
        const cuerpo = {
          empresa: form.empresa.trim(),
          vertical: form.vertical,
          subtipo: orNull(form.subtipo),
          tamano: orNull(form.tamano),
          ciudad: orNull(form.ciudad),
          entidad: orNull(form.entidad),
          municipio: orNull(form.municipio),
          zona: orNull(form.zona),
          sitioWeb: orNull(form.sitioWeb),
          sitioVerificado: form.sitioVerificado,
          contactoNombre: orNull(form.contactoNombre),
          telefono: orNull(form.telefono),
          correo: orNull(form.correo),
          baseLicitud: orNull(form.baseLicitud),
          consentimientoEn: orNull(form.consentimientoEn),
          fuente: orNull(form.fuente),
          siguientePaso: orNull(form.siguientePaso),
          siguientePasoEn: orNull(form.siguientePasoEn),
          notas: orNull(form.notas),
          senales: senales.map((s) => ({ tipo: s.tipo, valor: orNull(s.valor), fuente: s.fuente.trim(), url: orNull(s.url), observadoEn: s.observadoEn })),
        };
        await fetchJson(apiBaseUrl, token, editandoId ? `/superadmin/cerebro/prospectos/${editandoId}` : "/superadmin/cerebro/prospectos", { method: editandoId ? "PUT" : "POST", body: JSON.stringify(cuerpo) });
      }
      setShowForm(false);
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo guardar el prospecto.");
    } finally {
      setSubmitting(false);
    }
  }

  // Actualización optimista: la fila cambia de etapa al instante y el PATCH real corre en segundo plano; si falla, se revierte y se
  // muestra el error (nunca deja la UI mintiendo sobre la etapa real). Cada cambio real escribe un evento de línea de tiempo.
  async function handleCambiarEstado(prospecto: Prospecto, nuevoEstado: string) {
    const anterior = datos;
    setDatos((cur) => (cur ? { ...cur, prospectos: cur.prospectos.map((p) => (p.id === prospecto.id ? { ...p, estado: nuevoEstado } : p)) } : cur));
    setCambiandoId(prospecto.id);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/prospectos/${prospecto.id}`, { method: "PATCH", body: JSON.stringify({ estado: nuevoEstado }) });
      if (expandido === prospecto.id) await cargar();
    } catch {
      setDatos(anterior);
      setError("No se pudo mover ese prospecto de etapa. Intenta de nuevo.");
    } finally {
      setCambiandoId(null);
    }
  }

  if (error && !datos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!datos) return <EstadoCargando etiqueta="Cargando prospectos…" />;

  const prospectos = datos.prospectos;
  const visibles = prospectos.filter((p) => (filtroVertical === "todos" || p.vertical === filtroVertical) && (filtroEstado === "todos" || p.estado === filtroEstado));
  const activos = prospectos.filter((p) => !["ganado", "perdido", "descartado"].includes(p.estado));
  const ganados = prospectos.filter((p) => p.estado === "ganado").length;
  const sinCalificar = prospectos.filter((p) => p.scoreAjuste === null || p.scoreAjuste === undefined).length;
  const tax = taxonomiaDe(form.vertical);

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <PageHeader
        titulo="Cerebro de ventas"
        descripcion="A quién podemos venderle cada solución, con su score explicado. El cerebro propone y tú decides: aquí no se envía nada."
        acciones={
          <div className="flex flex-wrap items-center gap-2">
            {cerebro && (
              <Button asChild variant="outline" className="rounded-full gap-1.5">
                <Link to="/superadmin/cerebro/taxonomia">
                  <Tags className="w-4 h-4" strokeWidth={1.75} />
                  Taxonomía por vertical
                </Link>
              </Button>
            )}
            <Button onClick={abrirAlta} className="rounded-full gap-1.5">
              <Plus className="w-4 h-4" strokeWidth={1.75} />
              Nuevo prospecto
            </Button>
          </div>
        }
      />

      {!cerebro && (
        <Callout tone="warning" titulo="Cerebro de ventas: no disponible aún">
          {datos.mensaje ?? "Requiere aplicar la migración 0051_cerebro_ventas_base."} Mientras tanto la lista, el alta y el cambio de etapa siguen como antes; el score, la base de licitud y las personas de contacto aparecen al aplicarla.
        </Callout>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard variante="neutra" label="Prospectos totales" value={String(prospectos.length)} icon={Building2} />
        <StatCard variante="neutra" label="En proceso" value={String(activos.length)} icon={TrendingUp} />
        <StatCard variante="neutra" label="Ganados" value={String(ganados)} icon={Building2} />
        {cerebro && <StatCard variante="neutra" label="Sin calificar" value={String(sinCalificar)} icon={Brain} />}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <NativeSelect size="sm" wrapperClassName="w-auto" value={filtroVertical} onChange={(e) => setFiltroVertical(e.target.value)} aria-label="Filtrar por vertical">
          <option value="todos">Todas las verticales</option>
          {Object.entries(NOMBRE_VERTICAL).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect size="sm" wrapperClassName="w-auto" value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)} aria-label="Filtrar por etapa">
          <option value="todos">Todas las etapas</option>
          {ESTADOS.map((estado) => (
            <option key={estado} value={estado}>
              {NOMBRE_ESTADO[estado]}
            </option>
          ))}
        </NativeSelect>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{visibles.length === prospectos.length ? "Todos los prospectos" : `${visibles.length} de ${prospectos.length} prospectos`}</CardTitle>
        </CardHeader>
        <CardContent>
          {prospectos.length === 0 ? (
            <EstadoVacio mensaje="Todavía no hay prospectos registrados. Agrega el primero con “Nuevo prospecto”." />
          ) : visibles.length === 0 ? (
            <EstadoVacio mensaje="Ningún prospecto coincide con este filtro." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Empresa</TableHead>
                    <TableHead>Solución</TableHead>
                    <TableHead>Contacto</TableHead>
                    <TableHead>Etapa</TableHead>
                    {cerebro && <TableHead>Score</TableHead>}
                    <TableHead>Fuente</TableHead>
                    <TableHead>Actualizado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibles.flatMap((p) => {
                    const abierto = expandido === p.id;
                    const filas = [
                      <TableRow key={p.id}>
                        <TableCell>
                          {cerebro && (
                            <button
                              type="button"
                              className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-expanded={abierto}
                              aria-label={`${abierto ? "Ocultar" : "Ver"} el detalle de ${p.empresa}`}
                              onClick={() => setExpandido(abierto ? null : p.id)}
                            >
                              {abierto ? <ChevronDown className="w-4 h-4" strokeWidth={1.75} /> : <ChevronRight className="w-4 h-4" strokeWidth={1.75} />}
                            </button>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="font-medium text-foreground">{p.empresa}</span>
                          {(p.ciudad || p.subtipo) && <span className="block text-xs text-muted-foreground">{[p.ciudad, p.subtipo].filter(Boolean).join(" · ")}</span>}
                        </TableCell>
                        <TableCell>{NOMBRE_VERTICAL[p.vertical] ?? p.vertical}</TableCell>
                        <TableCell>
                          {p.contactoNombre && <span className="block text-foreground">{p.contactoNombre}</span>}
                          {(p.telefono || p.correo) && <span className="block text-xs text-muted-foreground">{[p.telefono, p.correo].filter(Boolean).join(" · ")}</span>}
                          {!p.contactoNombre && !p.telefono && !p.correo && <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {badgeDeEstado(p.estado)}
                            <NativeSelect
                              size="sm"
                              wrapperClassName="w-auto"
                              value={p.estado}
                              onChange={(e) => void handleCambiarEstado(p, e.target.value)}
                              disabled={cambiandoId === p.id}
                              aria-label={`Cambiar etapa de ${p.empresa}`}
                            >
                              {ESTADOS.map((estado) => (
                                <option key={estado} value={estado}>
                                  {NOMBRE_ESTADO[estado]}
                                </option>
                              ))}
                            </NativeSelect>
                          </div>
                        </TableCell>
                        {cerebro && (
                          <TableCell className="text-xs text-muted-foreground">
                            {p.scoreVersion ? (
                              <span>
                                ICP {p.scoreAjuste ?? "—"} · Urg. {p.scoreUrgencia ?? "—"} · Cierre {p.scoreCierre ?? "—"}
                              </span>
                            ) : (
                              "Sin calificar"
                            )}
                          </TableCell>
                        )}
                        <TableCell className="text-muted-foreground">{p.fuente || "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{fechaCortaEsMx(new Date(p.updatedAt))}</TableCell>
                      </TableRow>,
                    ];
                    if (abierto) {
                      filas.push(
                        <TableRow key={`${p.id}-detalle`}>
                          <TableCell colSpan={8} className="bg-canvas/40">
                            <DetalleProspecto p={p} apiBaseUrl={apiBaseUrl} token={token} onEditar={() => abrirEdicion(p)} onCambio={() => void cargar()} />
                          </TableCell>
                        </TableRow>,
                      );
                    }
                    return filas;
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <FormDialog
        open={showForm}
        onOpenChange={(open) => {
          setShowForm(open);
          if (!open) setFormError(null);
        }}
        titulo={editandoId ? "Editar prospecto" : "Nuevo prospecto"}
        subtitulo="A qué negocio podemos venderle cuál de las 6 soluciones."
        anchoClase="max-w-3xl"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setShowForm(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" form="form-prospecto" className="rounded-full px-6" disabled={submitting}>
              {submitting ? "Guardando…" : "Guardar prospecto"}
            </Button>
          </>
        }
      >
        <form id="form-prospecto" onSubmit={handleGuardar} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Empresa" required>
              <Input value={form.empresa} onChange={(e) => setForm({ ...form, empresa: e.target.value })} />
            </FormField>
            <FormField label="Solución de interés" required>
              <NativeSelect value={form.vertical} onChange={(e) => setForm({ ...form, vertical: e.target.value, subtipo: "", tamano: "" })} disabled={editandoId !== null}>
                {Object.entries(NOMBRE_VERTICAL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </div>
          {cerebro && tax && (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Subtipo">
                <NativeSelect value={form.subtipo} onChange={(e) => setForm({ ...form, subtipo: e.target.value })}>
                  <option value="">Sin definir</option>
                  {tax.subtipos.map((s) => (
                    <option key={s.clave} value={s.clave}>
                      {s.nombre}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label={`Tamaño (${tax.rangosTamano.unidad})`}>
                <NativeSelect value={form.tamano} onChange={(e) => setForm({ ...form, tamano: e.target.value })}>
                  <option value="">Sin definir</option>
                  {tax.rangosTamano.rangos.map((r) => (
                    <option key={r.clave} value={r.clave}>
                      {r.etiqueta}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
          )}
          {cerebro && !tax && <p className="text-xs text-muted-foreground">Esta vertical no tiene una taxonomía vigente todavía: el subtipo y el tamaño se habilitan al crearla.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Ciudad">
              <Input value={form.ciudad} onChange={(e) => setForm({ ...form, ciudad: e.target.value })} />
            </FormField>
            <FormField label="Fuente" hint="p. ej. referido, LinkedIn, feria">
              <Input value={form.fuente} onChange={(e) => setForm({ ...form, fuente: e.target.value })} />
            </FormField>
          </div>
          {cerebro && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField label="Entidad">
                  <Input value={form.entidad} onChange={(e) => setForm({ ...form, entidad: e.target.value })} />
                </FormField>
                <FormField label="Municipio">
                  <Input value={form.municipio} onChange={(e) => setForm({ ...form, municipio: e.target.value })} />
                </FormField>
                <FormField label="Zona">
                  <Input value={form.zona} onChange={(e) => setForm({ ...form, zona: e.target.value })} />
                </FormField>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Sitio web" hint="Empieza con http:// o https://">
                  <Input value={form.sitioWeb} onChange={(e) => setForm({ ...form, sitioWeb: e.target.value })} inputMode="url" />
                </FormField>
                <div className="flex items-end pb-2">
                  <Checkbox label="Sitio verificado a mano" checked={form.sitioVerificado} onChange={(e) => setForm({ ...form, sitioVerificado: e.target.checked })} />
                </div>
              </div>
            </>
          )}
          <FormField label="Nombre de contacto">
            <Input value={form.contactoNombre} onChange={(e) => setForm({ ...form, contactoNombre: e.target.value })} />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Teléfono">
              <Input value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
            </FormField>
            <FormField label="Correo">
              <Input type="email" value={form.correo} onChange={(e) => setForm({ ...form, correo: e.target.value })} />
            </FormField>
          </div>
          {cerebro && (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Base de licitud" required={Boolean(form.telefono.trim() || form.correo.trim() || form.contactoNombre.trim())} hint="Obligatoria para guardar con datos de contacto.">
                <NativeSelect value={form.baseLicitud} onChange={(e) => setForm({ ...form, baseLicitud: e.target.value })}>
                  <option value="">Sin registrar</option>
                  {Object.entries(NOMBRE_BASE).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Fecha de consentimiento" required={BASES_CON_CONSENTIMIENTO.has(form.baseLicitud)} hint="Obligatoria con interés declarado o referido con consentimiento.">
                <Input type="date" value={form.consentimientoEn} onChange={(e) => setForm({ ...form, consentimientoEn: e.target.value })} />
              </FormField>
            </div>
          )}
          {cerebro && (
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">Señales observadas</span>
                <Button type="button" size="sm" variant="outline" className="rounded-full gap-1.5" onClick={() => setSenales([...senales, { ...SENAL_VACIA }])}>
                  <Plus className="w-4 h-4" strokeWidth={1.75} />
                  Agregar señal
                </Button>
              </div>
              {senales.length === 0 && <p className="text-xs text-muted-foreground">Con menos de 3 señales (cada una con fuente y fecha) el score queda como “señal insuficiente”.</p>}
              {senales.map((s, i) => (
                <div key={i} className="grid gap-2 rounded-xl border border-line2 bg-canvas p-3 sm:grid-cols-2" data-testid="fila-senal">
                  <FormField label="Tipo de señal" required>
                    <NativeSelect value={s.tipo} onChange={(e) => setSenales(senales.map((x, j) => (j === i ? { ...x, tipo: e.target.value } : x)))}>
                      <option value="">Elige una señal</option>
                      {(tax?.senales ?? []).map((d) => (
                        <option key={d.tipo} value={d.tipo}>
                          {d.nombre}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormField>
                  <FormField label="Fecha observada" required>
                    <Input type="date" value={s.observadoEn} onChange={(e) => setSenales(senales.map((x, j) => (j === i ? { ...x, observadoEn: e.target.value } : x)))} />
                  </FormField>
                  <FormField label="Fuente" required>
                    <Input value={s.fuente} onChange={(e) => setSenales(senales.map((x, j) => (j === i ? { ...x, fuente: e.target.value } : x)))} placeholder="p. ej. Google Maps" />
                  </FormField>
                  <FormField label="URL de la evidencia">
                    <Input value={s.url} onChange={(e) => setSenales(senales.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} inputMode="url" placeholder="https://" />
                  </FormField>
                  <div className="sm:col-span-2 flex justify-end">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setSenales(senales.filter((_, j) => j !== i))}>
                      Quitar señal
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {cerebro && (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Siguiente paso">
                <Input value={form.siguientePaso} onChange={(e) => setForm({ ...form, siguientePaso: e.target.value })} />
              </FormField>
              <FormField label="Fecha del siguiente paso">
                <Input type="date" value={form.siguientePasoEn} onChange={(e) => setForm({ ...form, siguientePasoEn: e.target.value })} />
              </FormField>
            </div>
          )}
          <FormField label="Notas">
            <Textarea value={form.notas} onChange={(e) => setForm({ ...form, notas: e.target.value })} rows={3} />
          </FormField>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </form>
      </FormDialog>
    </PageContainer>
  );
}
