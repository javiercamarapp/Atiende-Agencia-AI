// Conocimiento del negocio (migracion 053): politicas, preguntas frecuentes y avisos temporales que el dueno le da al agente SIN tocar el
// prompt. Es el MISMO contenido para el agente de voz y el de WhatsApp (una sola fuente), por eso la misma seccion se monta en la pestana
// Conocimiento de Agente de voz y en el editor del agente de WhatsApp. Solo owner/admin (el servidor, admin-conocimiento.ts + RLS, es el
// enforcement real). Nunca precios ni productos: el servidor rechaza el texto y aqui se muestra su mensaje. Las entradas importadas de un
// documento llegan como BORRADOR y no entran al agente hasta que una persona las aprueba una por una. Contrato: lib/conocimiento-client.ts.
import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, Selector, StatusBadge, Textarea, resolverFormato, useConfirm } from "@atiende/ui";
import { fetchAdminBranches } from "../lib/branches-client.ts";
import type { BranchDetail } from "../lib/branches-client.ts";
import { TEXTO_MAX, TIPO_CONOCIMIENTO_LABEL, TITULO_MAX, actualizarConocimiento, borrarConocimiento, crearConocimiento, fetchConocimiento } from "../lib/conocimiento-client.ts";
import type { EntradaConocimiento, EntradaConocimientoInput, ListaConocimiento, TipoConocimiento } from "../lib/conocimiento-client.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Solo cambia el texto de apoyo: el contenido es el mismo para voz y WhatsApp. */
  readonly canal: "voz" | "whatsapp";
}

interface Formulario {
  readonly id: string | null;
  readonly titulo: string;
  readonly texto: string;
  readonly tipo: TipoConocimiento;
  /** "" = toda la organizacion. */
  readonly sucursalId: string;
  readonly reemplazaId: string;
  readonly prioridad: string;
  readonly vigenteDesde: string;
  readonly vigenteHasta: string;
}

const FORM_VACIO: Formulario = { id: null, titulo: "", texto: "", tipo: "faq", sucursalId: "", reemplazaId: "", prioridad: "50", vigenteDesde: "", vigenteHasta: "" };

function formDe(e: EntradaConocimiento): Formulario {
  return {
    id: e.id,
    titulo: e.titulo,
    texto: e.texto,
    tipo: e.tipo,
    sucursalId: e.sucursalId ?? "",
    reemplazaId: e.reemplazaId ?? "",
    prioridad: String(e.prioridad),
    vigenteDesde: e.vigenteDesde ?? "",
    vigenteHasta: e.vigenteHasta ?? "",
  };
}

const entero = resolverFormato("entero");

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

function vigenciaTexto(e: EntradaConocimiento): string | null {
  if (!e.vigenteDesde && !e.vigenteHasta) return null;
  if (e.vigenteDesde && e.vigenteHasta) return e.vigenteDesde === e.vigenteHasta ? `Solo el ${e.vigenteDesde}` : `Del ${e.vigenteDesde} al ${e.vigenteHasta}`;
  return e.vigenteDesde ? `Desde el ${e.vigenteDesde}` : `Hasta el ${e.vigenteHasta}`;
}

export function ConocimientoNegocio({ apiBaseUrl, token, propertyId, canal }: Props) {
  const { confirmar, dialogo } = useConfirm();
  const [lista, setLista] = useState<ListaConocimiento | null>(null);
  const [sucursales, setSucursales] = useState<readonly BranchDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [form, setForm] = useState<Formulario | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const [datos, ramas] = await Promise.all([fetchConocimiento(fetch, apiBaseUrl, token, propertyId), fetchAdminBranches(fetch, apiBaseUrl, token, propertyId).catch(() => [] as readonly BranchDetail[])]);
        if (cancelado) return;
        setLista(datos);
        setSucursales(ramas);
        setError(null);
      } catch (err) {
        if (!cancelado) setError(mensaje(err, "No se pudo cargar el conocimiento del negocio."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, recarga]);

  const nombreSucursal = useCallback((id: string | null) => (id === null ? "Toda la organización" : (sucursales.find((s) => s.propertyId === id)?.name ?? "Sucursal")), [sucursales]);
  const borradores = useMemo(() => (lista?.entradas ?? []).filter((e) => e.estado === "borrador"), [lista]);
  const publicadas = useMemo(() => (lista?.entradas ?? []).filter((e) => e.estado === "publicado"), [lista]);
  const generales = useMemo(() => publicadas.filter((e) => e.sucursalId === null), [publicadas]);
  const caracteres = useMemo(() => publicadas.filter((e) => e.activo).reduce((n, e) => n + e.titulo.length + e.texto.length, 0), [publicadas]);

  function cambiar<K extends keyof Formulario>(campo: K, valor: Formulario[K]) {
    setForm((f) => (f ? { ...f, [campo]: valor } : f));
  }

  async function guardar() {
    if (!form) return;
    const prioridad = Number(form.prioridad);
    if (!form.titulo.trim() || !form.texto.trim()) {
      setFallo("El título y el texto no pueden quedar vacíos.");
      return;
    }
    if (!Number.isInteger(prioridad) || prioridad < 0 || prioridad > 100) {
      setFallo("La prioridad debe ser un entero de 0 a 100.");
      return;
    }
    if (form.vigenteDesde && form.vigenteHasta && form.vigenteHasta < form.vigenteDesde) {
      setFallo("La fecha final no puede ser anterior a la inicial.");
      return;
    }
    setOcupado(true);
    setFallo(null);
    setAviso(null);
    const comun = { titulo: form.titulo, texto: form.texto, tipo: form.tipo, prioridad, vigenteDesde: form.vigenteDesde || null, vigenteHasta: form.vigenteHasta || null, reemplazaId: form.reemplazaId || null };
    try {
      if (form.id) await actualizarConocimiento(fetch, apiBaseUrl, token, propertyId, form.id, comun);
      else await crearConocimiento(fetch, apiBaseUrl, token, propertyId, { ...comun, sucursalId: form.sucursalId || null } satisfies EntradaConocimientoInput);
      setAviso(form.id ? "Cambios guardados." : "Entrada guardada: el agente ya la usa.");
      setForm(null);
      setRecarga((n) => n + 1);
    } catch (err) {
      setFallo(mensaje(err, "No se pudo guardar la entrada."));
    } finally {
      setOcupado(false);
    }
  }

  async function cambiarEstado(e: EntradaConocimiento, patch: { activo?: boolean; estado?: "publicado" }, ok: string) {
    setOcupado(true);
    setFallo(null);
    setAviso(null);
    try {
      await actualizarConocimiento(fetch, apiBaseUrl, token, propertyId, e.id, patch);
      setAviso(ok);
      setRecarga((n) => n + 1);
    } catch (err) {
      setFallo(mensaje(err, "No se pudo actualizar la entrada."));
    } finally {
      setOcupado(false);
    }
  }

  async function borrar(e: EntradaConocimiento) {
    const ok = await confirmar({
      titulo: e.estado === "borrador" ? "Descartar borrador" : "Eliminar entrada",
      descripcion: `«${e.titulo}» dejará de estar disponible para el agente. ¿Continuar?`,
      tono: "danger",
      confirmar: e.estado === "borrador" ? "Descartar" : "Eliminar",
      cancelar: "Volver",
    });
    if (!ok) return;
    setOcupado(true);
    setFallo(null);
    setAviso(null);
    try {
      await borrarConocimiento(fetch, apiBaseUrl, token, propertyId, e.id);
      setAviso("Entrada eliminada.");
      setRecarga((n) => n + 1);
    } catch (err) {
      setFallo(mensaje(err, "No se pudo eliminar la entrada."));
    } finally {
      setOcupado(false);
    }
  }

  const fila = (e: EntradaConocimiento) => (
    <li key={e.id} data-entrada={e.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border bg-card p-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <p className="m-0 flex flex-wrap items-center gap-1.5 font-semibold text-foreground">
          {e.titulo}
          <StatusBadge tone="info">{TIPO_CONOCIMIENTO_LABEL[e.tipo]}</StatusBadge>
          {e.estado === "borrador" ? <StatusBadge tone="warning">Borrador por aprobar</StatusBadge> : e.activo ? <StatusBadge tone="success">Activa</StatusBadge> : <StatusBadge tone="neutral">Apagada</StatusBadge>}
        </p>
        <p className="mt-1 line-clamp-3 whitespace-pre-line text-xs text-muted-foreground">{e.texto}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {nombreSucursal(e.sucursalId)}
          {vigenciaTexto(e) ? ` · ${vigenciaTexto(e)}` : ""}
          {e.origen === "importado" ? " · Importada de un documento" : ""}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {e.estado === "borrador" ? (
          <Button type="button" size="sm" disabled={ocupado} onClick={() => void cambiarEstado(e, { estado: "publicado" }, "Borrador aprobado: el agente ya lo usa.")}>
            Aprobar
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={() => void cambiarEstado(e, { activo: !e.activo }, e.activo ? "Entrada apagada: el agente ya no la usa." : "Entrada encendida.")}>
            {e.activo ? "Apagar" : "Encender"}
          </Button>
        )}
        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Editar ${e.titulo}`} disabled={ocupado} onClick={() => setForm(formDe(e))}>
          <Pencil className="h-4 w-4" strokeWidth={1.75} />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Eliminar ${e.titulo}`} disabled={ocupado} onClick={() => void borrar(e)}>
          <Trash2 className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </div>
    </li>
  );

  const editandoSucursal = form !== null && (form.id ? form.sucursalId !== "" : form.sucursalId !== "");
  const candidatasReemplazo = generales.filter((g) => g.id !== form?.id);

  return (
    <Card data-testid="conocimiento-negocio">
      <CardHeader className="p-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4" strokeWidth={1.75} />
          Conocimiento del negocio
        </CardTitle>
        <CardDescription>
          Políticas, preguntas frecuentes y avisos del día que el agente de {canal === "voz" ? "voz" : "WhatsApp"} usa al contestar; es el mismo contenido para voz y WhatsApp. No son reglas ni cambian precios: el menú y los precios los toma siempre del menú real con la cotización, así que aquí no se escriben.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0">
        {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
        {!lista && !error && <EstadoCargando etiqueta="Cargando el conocimiento del negocio…" />}
        {lista && !lista.disponible && (
          <Callout tone="warning" titulo="No disponible aún" data-testid="conocimiento-no-disponible">
            Esta base de datos todavía no tiene el conocimiento del negocio: requiere aplicar la migración 053. Mientras tanto el agente funciona sin él y no se puede guardar nada aquí.
          </Callout>
        )}
        {lista?.disponible && (
          <>
            {aviso && (
              <p role="status" className="m-0 text-xs text-primary">
                {aviso}
              </p>
            )}
            {fallo && (
              <p role="alert" className="m-0 text-xs text-destructive">
                {fallo}
              </p>
            )}

            {borradores.length > 0 && (
              <section aria-label="Borradores por aprobar" className="flex flex-col gap-2">
                <h3 className="m-0 text-sm font-semibold">Borradores por aprobar</h3>
                <p className="m-0 text-xs text-muted-foreground">Nada de esto llega al agente hasta que usted lo apruebe.</p>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">{borradores.map(fila)}</ul>
              </section>
            )}

            <section aria-label="Entradas de conocimiento" className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="m-0 text-sm font-semibold">Entradas</h3>
                <span data-testid="conocimiento-uso" className="text-xs text-muted-foreground">
                  En uso: {entero(caracteres)} de {entero(lista.topeCaracteres)} caracteres que caben en el agente
                </span>
              </div>
              {publicadas.length === 0 ? (
                <EstadoVacio compacto titulo="Sin conocimiento cargado" mensaje="Agregue sus políticas, preguntas frecuentes (por ejemplo «¿hay estacionamiento?») o un aviso de hoy, y el agente las usará al contestar." />
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">{publicadas.map(fila)}</ul>
              )}
              {caracteres > lista.topeCaracteres && (
                <Callout tone="warning">Hay más texto del que cabe: el agente usa las entradas de mayor prioridad y deja fuera las últimas. Apague o acorte entradas.</Callout>
              )}
            </section>

            {form === null ? (
              <div>
                <Button type="button" size="sm" onClick={() => setForm(FORM_VACIO)} disabled={ocupado}>
                  <Plus className="mr-1.5 h-4 w-4" strokeWidth={1.75} />
                  Agregar entrada
                </Button>
              </div>
            ) : (
              <section aria-label={form.id ? "Editar entrada" : "Nueva entrada"} className="flex flex-col gap-3 rounded-card border border-border p-3">
                <h3 className="m-0 text-sm font-semibold">{form.id ? "Editar entrada" : "Nueva entrada"}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="Título" hint={`${form.titulo.length}/${TITULO_MAX}`}>
                    <Input value={form.titulo} maxLength={TITULO_MAX} placeholder="Estacionamiento" onChange={(e) => cambiar("titulo", e.target.value)} />
                  </FormField>
                  <FormField label="Tipo">
                    <Selector value={form.tipo} onChange={(e) => cambiar("tipo", e.target.value as TipoConocimiento)}>
                      {(Object.keys(TIPO_CONOCIMIENTO_LABEL) as TipoConocimiento[]).map((t) => (
                        <option key={t} value={t}>
                          {TIPO_CONOCIMIENTO_LABEL[t]}
                        </option>
                      ))}
                    </Selector>
                  </FormField>
                  <FormField label="Aplica a" hint={form.id ? "No se puede cambiar: cree otra entrada para otra sucursal." : undefined}>
                    <Selector value={form.sucursalId} disabled={form.id !== null} onChange={(e) => setForm((f) => (f ? { ...f, sucursalId: e.target.value, reemplazaId: "" } : f))}>
                      <option value="">Toda la organización</option>
                      {sucursales.map((s) => (
                        <option key={s.propertyId} value={s.propertyId}>
                          Solo {s.name}
                        </option>
                      ))}
                    </Selector>
                  </FormField>
                  <FormField label="Prioridad (0 a 100)" hint="Las de mayor prioridad entran primero si no cabe todo.">
                    <Input type="number" min={0} max={100} value={form.prioridad} onChange={(e) => cambiar("prioridad", e.target.value)} />
                  </FormField>
                </div>
                <FormField label="Texto" hint={`${form.texto.length}/${TEXTO_MAX}. Sin precios ni nombres de productos del menú.`}>
                  <Textarea rows={5} value={form.texto} maxLength={TEXTO_MAX} placeholder="Hay estacionamiento gratuito para clientes." onChange={(e) => cambiar("texto", e.target.value)} />
                </FormField>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="Vigente desde (opcional)" hint="Fecha local de la sucursal.">
                    <Input type="date" value={form.vigenteDesde} onChange={(e) => cambiar("vigenteDesde", e.target.value)} />
                  </FormField>
                  <FormField label="Vigente hasta (opcional)" hint="Pasada esa fecha el agente deja de usarla.">
                    <Input type="date" value={form.vigenteHasta} onChange={(e) => cambiar("vigenteHasta", e.target.value)} />
                  </FormField>
                </div>
                {editandoSucursal && candidatasReemplazo.length > 0 && (
                  <FormField label="Sustituye a una entrada general (opcional)" hint="En esta sucursal el agente usa esta entrada en lugar de la general elegida.">
                    <Selector value={form.reemplazaId} onChange={(e) => cambiar("reemplazaId", e.target.value)}>
                      <option value="">No sustituye ninguna</option>
                      {candidatasReemplazo.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.titulo}
                        </option>
                      ))}
                    </Selector>
                  </FormField>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" loading={ocupado} onClick={() => void guardar()}>
                    Guardar entrada
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={() => setForm(null)}>
                    Cancelar
                  </Button>
                </div>
              </section>
            )}
          </>
        )}
        {dialogo}
      </CardContent>
    </Card>
  );
}
