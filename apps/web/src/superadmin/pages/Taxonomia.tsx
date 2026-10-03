// Taxonomia por vertical del Cerebro de ventas (SA-L-38): subtipos, rangos de tamano, senales (las reglas del scoring), ICP, objeciones y
// mensajes base es-MX sin promesas de cifras, mas el plan sugerido. Cada vertical tiene versiones: editar crea una version NUEVA
// (la anterior queda en el historial) y exige step-up MFA. El precio sale de core.plan; sin precio dice "Precio por definir".
// La semilla viene de la especificacion y esta marcada "Propuesta, validar con Javier".
//
// Backend real: GET /superadmin/cerebro/taxonomia y PUT /superadmin/cerebro/taxonomia/:vertical
// (apps/api/src/routes/superadmin-cerebro.ts, ver docs/SUPERADMIN_CEREBRO.md). Base sin migrar: aviso honesto y sin boton de editar.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Pencil, Plus } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, FormDialog, FormField, Input, NativeSelect, PageContainer, PageHeader, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@atiende/ui";
import { fechaHoraEsMx } from "../../lib/formato-fecha.ts";
import { fetchJson } from "../lib/fetch-json.ts";

interface Senal {
  readonly tipo: string;
  readonly nombre: string;
  readonly dimension: string;
  readonly puntos: number;
  readonly comoConseguirla: string;
}
interface Version {
  readonly id: string;
  readonly vertical: string;
  readonly version: number;
  readonly vigente: boolean;
  readonly subtipos: readonly { readonly clave: string; readonly nombre: string }[];
  readonly rangosTamano: { readonly unidad: string; readonly rangos: readonly { readonly clave: string; readonly etiqueta: string }[] };
  readonly senales: readonly Senal[];
  readonly icp: { readonly descripcion: string; readonly subtiposObjetivo: readonly string[]; readonly tamanosObjetivo: readonly string[] };
  readonly objeciones: readonly { readonly objecion: string; readonly respuesta: string }[];
  readonly mensajesBase: readonly { readonly canal: string; readonly variante: string; readonly texto: string }[];
  readonly contexto: Readonly<Record<string, unknown>>;
  readonly planId: string | null;
  readonly planNombre: string | null;
  readonly precio: { readonly estado: "definido" | "por_definir"; readonly texto: string };
  readonly estadoValidacion: string;
  readonly notaCambio: string | null;
  readonly creadoEn: string;
}
interface Respuesta {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly verticales: readonly string[];
  readonly versiones: readonly Version[];
}
interface PlanOpcion {
  readonly id: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly activo: boolean;
}

const NOMBRE_VERTICAL: Record<string, string> = {
  hoteles: "Hoteles",
  restaurantes: "Restaurantes",
  citas: "Citas",
  licitaciones: "Licitaciones",
  despachos: "Despachos",
  rentas: "Rentas vacacionales",
};
const NOMBRE_DIMENSION: Record<string, string> = { ajuste: "Ajuste ICP", urgencia: "Urgencia", cierre: "Cierre" };

interface SenalForm {
  tipo: string;
  nombre: string;
  dimension: string;
  puntos: string;
  comoConseguirla: string;
}
interface EditorState {
  subtipos: { clave: string; nombre: string }[];
  unidad: string;
  rangos: { clave: string; etiqueta: string }[];
  senales: SenalForm[];
  icpDescripcion: string;
  subtiposObjetivo: string[];
  tamanosObjetivo: string[];
  objeciones: { objecion: string; respuesta: string }[];
  mensajes: { canal: string; variante: string; texto: string }[];
  planId: string;
  nota: string;
  validada: boolean;
}

function editorDe(v: Version): EditorState {
  return {
    subtipos: v.subtipos.map((s) => ({ ...s })),
    unidad: v.rangosTamano.unidad,
    rangos: v.rangosTamano.rangos.map((r) => ({ ...r })),
    senales: v.senales.map((s) => ({ tipo: s.tipo, nombre: s.nombre, dimension: s.dimension, puntos: String(s.puntos), comoConseguirla: s.comoConseguirla })),
    icpDescripcion: v.icp.descripcion,
    subtiposObjetivo: [...v.icp.subtiposObjetivo],
    tamanosObjetivo: [...v.icp.tamanosObjetivo],
    objeciones: v.objeciones.map((o) => ({ ...o })),
    mensajes: v.mensajesBase.map((m) => ({ ...m })),
    planId: v.planId ?? "",
    nota: "",
    validada: false,
  };
}

/** "Menú en línea" -> "menu_en_linea" (clave estable en minusculas, sin acentos). */
export function claveDe(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 60);
}

function alternar(lista: string[], clave: string, activo: boolean): string[] {
  return activo ? [...new Set([...lista, clave])] : lista.filter((c) => c !== clave);
}

export function SuperAdminTaxonomiaPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [planes, setPlanes] = useState<readonly PlanOpcion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [vertical, setVertical] = useState<string>("restaurantes");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      const r = await fetchJson<Respuesta>(apiBaseUrl, token, "/superadmin/cerebro/taxonomia");
      setDatos(r);
      const p = await fetchJson<{ planes?: PlanOpcion[] }>(apiBaseUrl, token, "/superadmin/planes").catch(() => ({ planes: [] as PlanOpcion[] }));
      setPlanes(p.planes ?? []);
    } catch {
      setError("No se pudo cargar la taxonomía.");
    }
  }, [apiBaseUrl, token]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (error && !datos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!datos) return <EstadoCargando etiqueta="Cargando taxonomía…" />;

  const versiones = datos.versiones.filter((v) => v.vertical === vertical);
  const vigente = versiones.find((v) => v.vigente);
  const historial = versiones.filter((v) => !v.vigente);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (!editor || !vigente) return;
    const senales = editor.senales.map((s) => ({ tipo: s.tipo || claveDe(s.nombre), nombre: s.nombre.trim(), dimension: s.dimension, puntos: Number(s.puntos), como_conseguirla: s.comoConseguirla.trim() }));
    if (senales.some((s) => !s.tipo || !s.nombre || !s.como_conseguirla || !Number.isInteger(s.puntos) || s.puntos < 1 || s.puntos > 100)) {
      return setFormError("Cada señal necesita nombre, puntos enteros de 1 a 100 y cómo conseguirla.");
    }
    if (editor.mensajes.length === 0 || editor.mensajes.some((m) => !m.canal.trim() || !m.variante.trim() || !m.texto.trim())) return setFormError("Cada mensaje base necesita canal, variante y texto.");
    setFormError(null);
    setGuardando(true);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/cerebro/taxonomia/${vigente.vertical}`, {
        method: "PUT",
        body: JSON.stringify({
          contenido: {
            subtipos: editor.subtipos.map((s) => ({ clave: s.clave || claveDe(s.nombre), nombre: s.nombre.trim() })),
            rangos_tamano: { unidad: editor.unidad.trim(), rangos: editor.rangos.map((r) => ({ clave: r.clave || claveDe(r.etiqueta), etiqueta: r.etiqueta.trim() })) },
            senales,
            icp: { descripcion: editor.icpDescripcion.trim(), subtipos_objetivo: editor.subtiposObjetivo, tamanos_objetivo: editor.tamanosObjetivo },
            objeciones: editor.objeciones.map((o) => ({ objecion: o.objecion.trim(), respuesta: o.respuesta.trim() })),
            mensajes_base: editor.mensajes.map((m) => ({ canal: m.canal.trim(), variante: m.variante.trim(), texto: m.texto.trim() })),
          },
          planId: editor.planId || null,
          nota: editor.nota.trim() || null,
          validada: editor.validada,
        }),
      });
      setEditor(null);
      setAviso("Listo: se creó una versión nueva y el scoring de los prospectos nuevos o editados la usará. La versión anterior queda en el historial.");
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo guardar la taxonomía.");
    } finally {
      setGuardando(false);
    }
  }

  const opcionesPlan = planes.filter((p) => p.vertical === vertical && p.activo);

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <PageHeader
        titulo="Taxonomía por vertical"
        descripcion="Subtipos, tamaños, señales (las reglas del score), perfil de cliente ideal, objeciones y mensajes base de cada solución. Editar crea una versión nueva."
        atras={{ etiqueta: "Cerebro de ventas", to: "/superadmin/cerebro" }}
        acciones={
          datos.disponible && vigente ? (
            <Button
              className="rounded-full gap-1.5"
              onClick={() => {
                setEditor(editorDe(vigente));
                setFormError(null);
              }}
            >
              <Pencil className="w-4 h-4" strokeWidth={1.75} />
              Editar (versión nueva)
            </Button>
          ) : undefined
        }
      />

      {!datos.disponible && (
        <Callout tone="warning" titulo="Todavía no disponible en esta base">
          {datos.mensaje ?? "Requiere aplicar la migración 0051_cerebro_ventas_base."} Mientras tanto no hay taxonomía que ver ni editar.
        </Callout>
      )}
      {aviso && (
        <Callout tone="success" titulo="Listo" onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}

      {datos.disponible && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <NativeSelect size="sm" wrapperClassName="w-auto" value={vertical} onChange={(e) => setVertical(e.target.value)} aria-label="Vertical">
              {datos.verticales.map((v) => (
                <option key={v} value={v}>
                  {NOMBRE_VERTICAL[v] ?? v}
                </option>
              ))}
            </NativeSelect>
            {vigente && (
              <>
                <StatusBadge tone="info">Versión {vigente.version} vigente</StatusBadge>
                <StatusBadge tone={vigente.estadoValidacion === "validada" ? "success" : "warning"}>{vigente.estadoValidacion === "validada" ? "Validada" : "Propuesta, validar con Javier"}</StatusBadge>
              </>
            )}
          </div>

          {!vigente ? (
            <Callout tone="info" titulo="Sin taxonomía para esta vertical">
              Esta vertical todavía no tiene una taxonomía. Por eso sus prospectos no tienen subtipo ni tamaño de catálogo y el score solo usa señales sin reglas.
            </Callout>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Perfil de cliente ideal</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm">
                  <p className="text-foreground">{vigente.icp.descripcion}</p>
                  <p className="text-muted-foreground">Subtipos objetivo: {vigente.icp.subtiposObjetivo.map((c) => vigente.subtipos.find((s) => s.clave === c)?.nombre ?? c).join(", ") || "—"}</p>
                  <p className="text-muted-foreground">
                    Tamaños objetivo ({vigente.rangosTamano.unidad}): {vigente.icp.tamanosObjetivo.map((c) => vigente.rangosTamano.rangos.find((r) => r.clave === c)?.etiqueta ?? c).join(", ") || "—"}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Plan sugerido</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-1 text-sm">
                  <p className="text-foreground">{vigente.planNombre ?? "Sin plan sugerido"}</p>
                  <p className={vigente.precio.estado === "definido" ? "text-foreground" : "text-muted-foreground"}>{vigente.precio.texto}</p>
                  <p className="text-xs text-muted-foreground">El precio se lee del catálogo de planes; nunca se guarda aquí ni se inventa.</p>
                </CardContent>
              </Card>
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>Señales (reglas del score)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Señal</TableHead>
                          <TableHead>Dimensión</TableHead>
                          <TableHead className="text-right">Puntos</TableHead>
                          <TableHead>Cómo conseguirla</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {vigente.senales.map((s) => (
                          <TableRow key={s.tipo}>
                            <TableCell className="font-medium text-foreground">{s.nombre}</TableCell>
                            <TableCell>{NOMBRE_DIMENSION[s.dimension] ?? s.dimension}</TableCell>
                            <TableCell className="text-right">{s.puntos}</TableCell>
                            <TableCell className="text-muted-foreground">{s.comoConseguirla}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Subtipos y tamaños</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm text-muted-foreground">
                  <p>{vigente.subtipos.map((s) => s.nombre).join(" · ")}</p>
                  <p>
                    {vigente.rangosTamano.unidad}: {vigente.rangosTamano.rangos.map((r) => r.etiqueta).join(" · ")}. Son propuestas de segmentación, no hechos.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Objeciones</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm">
                  {vigente.objeciones.map((o) => (
                    <p key={o.objecion} className="text-muted-foreground">
                      <span className="font-medium text-foreground">{o.objecion}.</span> {o.respuesta}
                    </p>
                  ))}
                </CardContent>
              </Card>
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>Mensajes base (es-MX, sin promesas de cifras)</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm">
                  {vigente.mensajesBase.map((m) => (
                    <p key={`${m.canal}-${m.variante}`} className="rounded-lg border border-line2 bg-canvas px-3 py-2 text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {m.canal} · variante {m.variante}:
                      </span>{" "}
                      {m.texto}
                    </p>
                  ))}
                </CardContent>
              </Card>
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>Historial de versiones</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-1 text-sm text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">Versión {vigente.version} (vigente)</span> · {fechaHoraEsMx(vigente.creadoEn)}
                    {vigente.notaCambio ? ` · ${vigente.notaCambio}` : ""}
                  </p>
                  {historial.map((v) => (
                    <p key={v.id}>
                      Versión {v.version} · {fechaHoraEsMx(v.creadoEn)}
                      {v.notaCambio ? ` · ${v.notaCambio}` : ""}
                    </p>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}

      <FormDialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        titulo={`Editar la taxonomía de ${NOMBRE_VERTICAL[vertical] ?? vertical}`}
        subtitulo="Guardar crea una versión nueva y pide tu código MFA. La versión anterior queda en el historial."
        anchoClase="max-w-3xl"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setEditor(null)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-taxonomia" className="rounded-full px-6" disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar versión nueva"}
            </Button>
          </>
        }
      >
        {editor && (
          <form id="form-taxonomia" onSubmit={guardar} className="flex flex-col gap-4">
            <FormField label="Perfil de cliente ideal (descripción)" required>
              <Textarea rows={2} value={editor.icpDescripcion} onChange={(e) => setEditor({ ...editor, icpDescripcion: e.target.value })} />
            </FormField>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium text-foreground">Subtipos</legend>
              {editor.subtipos.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input aria-label={`Nombre del subtipo ${i + 1}`} value={s.nombre} onChange={(e) => setEditor({ ...editor, subtipos: editor.subtipos.map((x, j) => (j === i ? { ...x, nombre: e.target.value } : x)) })} />
                  <Checkbox
                    label="Es del ICP"
                    checked={editor.subtiposObjetivo.includes(s.clave || claveDe(s.nombre))}
                    onChange={(e) => setEditor({ ...editor, subtiposObjetivo: alternar(editor.subtiposObjetivo, s.clave || claveDe(s.nombre), e.target.checked) })}
                  />
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditor({ ...editor, subtipos: editor.subtipos.filter((_, j) => j !== i), subtiposObjetivo: editor.subtiposObjetivo.filter((c) => c !== s.clave) })}>
                    Quitar
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" className="w-fit rounded-full gap-1.5" onClick={() => setEditor({ ...editor, subtipos: [...editor.subtipos, { clave: "", nombre: "" }] })}>
                <Plus className="w-4 h-4" strokeWidth={1.75} />
                Agregar subtipo
              </Button>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium text-foreground">Rangos de tamaño</legend>
              <FormField label="Unidad">
                <Input value={editor.unidad} onChange={(e) => setEditor({ ...editor, unidad: e.target.value })} />
              </FormField>
              {editor.rangos.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input aria-label={`Etiqueta del rango ${i + 1}`} value={r.etiqueta} onChange={(e) => setEditor({ ...editor, rangos: editor.rangos.map((x, j) => (j === i ? { ...x, etiqueta: e.target.value } : x)) })} />
                  <Checkbox
                    label="Es del ICP"
                    checked={editor.tamanosObjetivo.includes(r.clave || claveDe(r.etiqueta))}
                    onChange={(e) => setEditor({ ...editor, tamanosObjetivo: alternar(editor.tamanosObjetivo, r.clave || claveDe(r.etiqueta), e.target.checked) })}
                  />
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditor({ ...editor, rangos: editor.rangos.filter((_, j) => j !== i), tamanosObjetivo: editor.tamanosObjetivo.filter((c) => c !== r.clave) })}>
                    Quitar
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" className="w-fit rounded-full gap-1.5" onClick={() => setEditor({ ...editor, rangos: [...editor.rangos, { clave: "", etiqueta: "" }] })}>
                <Plus className="w-4 h-4" strokeWidth={1.75} />
                Agregar rango
              </Button>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium text-foreground">Señales (reglas del score)</legend>
              {editor.senales.map((s, i) => (
                <div key={i} className="grid gap-2 rounded-xl border border-line2 bg-canvas p-3 sm:grid-cols-3" data-testid="fila-senal-def">
                  <FormField label="Nombre" className="sm:col-span-2">
                    <Input value={s.nombre} onChange={(e) => setEditor({ ...editor, senales: editor.senales.map((x, j) => (j === i ? { ...x, nombre: e.target.value } : x)) })} />
                  </FormField>
                  <FormField label="Puntos (1 a 100)">
                    <Input inputMode="numeric" value={s.puntos} onChange={(e) => setEditor({ ...editor, senales: editor.senales.map((x, j) => (j === i ? { ...x, puntos: e.target.value } : x)) })} />
                  </FormField>
                  <FormField label="Dimensión">
                    <NativeSelect value={s.dimension} onChange={(e) => setEditor({ ...editor, senales: editor.senales.map((x, j) => (j === i ? { ...x, dimension: e.target.value } : x)) })}>
                      {Object.entries(NOMBRE_DIMENSION).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormField>
                  <FormField label="Cómo conseguirla" className="sm:col-span-2">
                    <Input value={s.comoConseguirla} onChange={(e) => setEditor({ ...editor, senales: editor.senales.map((x, j) => (j === i ? { ...x, comoConseguirla: e.target.value } : x)) })} />
                  </FormField>
                  <div className="sm:col-span-3 flex justify-end">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditor({ ...editor, senales: editor.senales.filter((_, j) => j !== i) })}>
                      Quitar señal
                    </Button>
                  </div>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" className="w-fit rounded-full gap-1.5" onClick={() => setEditor({ ...editor, senales: [...editor.senales, { tipo: "", nombre: "", dimension: "ajuste", puntos: "10", comoConseguirla: "" }] })}>
                <Plus className="w-4 h-4" strokeWidth={1.75} />
                Agregar señal
              </Button>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium text-foreground">Objeciones</legend>
              {editor.objeciones.map((o, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-2">
                  <Input aria-label={`Objeción ${i + 1}`} value={o.objecion} onChange={(e) => setEditor({ ...editor, objeciones: editor.objeciones.map((x, j) => (j === i ? { ...x, objecion: e.target.value } : x)) })} />
                  <div className="flex gap-2">
                    <Input aria-label={`Respuesta a la objeción ${i + 1}`} value={o.respuesta} onChange={(e) => setEditor({ ...editor, objeciones: editor.objeciones.map((x, j) => (j === i ? { ...x, respuesta: e.target.value } : x)) })} />
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditor({ ...editor, objeciones: editor.objeciones.filter((_, j) => j !== i) })}>
                      Quitar
                    </Button>
                  </div>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" className="w-fit rounded-full gap-1.5" onClick={() => setEditor({ ...editor, objeciones: [...editor.objeciones, { objecion: "", respuesta: "" }] })}>
                <Plus className="w-4 h-4" strokeWidth={1.75} />
                Agregar objeción
              </Button>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium text-foreground">Mensajes base (sin promesas de cifras: nada de porcentajes, montos ni garantías)</legend>
              {editor.mensajes.map((m, i) => (
                <div key={i} className="grid gap-2 rounded-xl border border-line2 bg-canvas p-3" data-testid="fila-mensaje">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <FormField label="Canal">
                      <Input value={m.canal} onChange={(e) => setEditor({ ...editor, mensajes: editor.mensajes.map((x, j) => (j === i ? { ...x, canal: e.target.value } : x)) })} />
                    </FormField>
                    <FormField label="Variante">
                      <Input value={m.variante} onChange={(e) => setEditor({ ...editor, mensajes: editor.mensajes.map((x, j) => (j === i ? { ...x, variante: e.target.value } : x)) })} />
                    </FormField>
                  </div>
                  <FormField label="Texto">
                    <Textarea rows={3} value={m.texto} onChange={(e) => setEditor({ ...editor, mensajes: editor.mensajes.map((x, j) => (j === i ? { ...x, texto: e.target.value } : x)) })} />
                  </FormField>
                  <div className="flex justify-end">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditor({ ...editor, mensajes: editor.mensajes.filter((_, j) => j !== i) })}>
                      Quitar mensaje
                    </Button>
                  </div>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" className="w-fit rounded-full gap-1.5" onClick={() => setEditor({ ...editor, mensajes: [...editor.mensajes, { canal: "whatsapp", variante: "A", texto: "" }] })}>
                <Plus className="w-4 h-4" strokeWidth={1.75} />
                Agregar mensaje
              </Button>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Plan sugerido" hint="El precio se lee del plan; si no tiene, dirá “Precio por definir”.">
                <NativeSelect value={editor.planId} onChange={(e) => setEditor({ ...editor, planId: e.target.value })}>
                  <option value="">Sin plan sugerido</option>
                  {opcionesPlan.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Nota del cambio">
                <Input value={editor.nota} onChange={(e) => setEditor({ ...editor, nota: e.target.value })} />
              </FormField>
            </div>
            <Checkbox label="Marcar esta versión como validada" descripcion="Sin marcar queda como “Propuesta, validar con Javier”." checked={editor.validada} onChange={(e) => setEditor({ ...editor, validada: e.target.checked })} />
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
          </form>
        )}
      </FormDialog>
    </PageContainer>
  );
}
