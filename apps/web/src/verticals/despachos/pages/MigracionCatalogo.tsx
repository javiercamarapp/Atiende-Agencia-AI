// Panel de migración de catálogo contable -- hallazgo de auditoría (severidad ALTA,
// "Siete módulos con ruta HTTP real y sin UI", porción migración de catálogo):
// migracion-catalogo.ts expone POST /clasificar, GET /mapeos, GET /mapeos/:id y
// POST /mapeos/:id/aprobar|rechazar|editar (ver
// apps/api/.../despachos/migracion-catalogo.ts), pero ningún cliente web ni página
// los usaba. Esta página cierra el gap: clasificación del catálogo origen contra el
// destino (el clasificador determinista vive en
// @atiende/domain-despachos/migracion-catalogo/matching.ts -- exacto/alerta de
// riesgo/fuzzy/sin match), la lista de mapeos propuestos con su estado, y las 3
// decisiones humanas reales por mapeo (aprobar/rechazar/editar), incluyendo las
// guardias de cardinalidad 1:N/N:1 (REQ-MIG-008) que el servidor devuelve como 409 y
// esta UI solo muestra, nunca decide por su cuenta.
//
// El catálogo origen/destino vive en las bases del cliente, fuera de este monorepo
// (ver comentario de cabecera de cross-db-port.ts) -- por eso esta página no lo
// "descubre": el usuario lo pega como JSON (export típico de un ERP/ver ETL externo)
// y la página solo llama al clasificador ya construido con lo que recibe.
import { useEffect, useState } from "react";
import { Check, FolderInput, Pencil, X } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  FormField,
  Input,
  NativeSelect,
  PageContainer,
  PageHeader,
  StatusBadge,
  statusTone,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useConfirm,
} from "@atiende/ui";
import {
  aprobarMapeoMigracion,
  clasificarCatalogo,
  editarMapeoMigracion,
  fetchMapeosMigracion,
  rechazarMapeoMigracion,
} from "../lib/migracion-catalogo-client.ts";
import type { CuentaCatalogoInput, EstadoMapeoMigracion, MapeoMigracionCuenta } from "../lib/migracion-catalogo-client.ts";
import { formatDateTime, formatEstadoMapeoMigracion, formatTipoMatchMigracion } from "../lib/format.ts";
import { MIGRACION_ESTADO_TONES, MIGRACION_MATCH_TONES } from "../lib/status-tones.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

const ESTADO_FILTROS: ReadonlyArray<{ value: EstadoMapeoMigracion | ""; label: string }> = [
  { value: "", label: "Todos los estados" },
  { value: "pendiente", label: "Pendiente" },
  { value: "aprobado", label: "Aprobado" },
  { value: "rechazado", label: "Rechazado" },
  { value: "editado", label: "Editado" },
];

const EJEMPLO_CATALOGO = `[
  { "id": "o1", "codigo": "101-001", "nombre": "Caja General", "nivel": 1, "naturaleza": "D" }
]`;

function EstadoBadge({ estado }: { estado: EstadoMapeoMigracion }) {
  return <StatusBadge tone={statusTone(MIGRACION_ESTADO_TONES, estado)}>{formatEstadoMapeoMigracion(estado)}</StatusBadge>;
}

function TipoMatchBadge({ tipoMatch }: { tipoMatch: MapeoMigracionCuenta["tipoMatch"] }) {
  return <StatusBadge tone={statusTone(MIGRACION_MATCH_TONES, tipoMatch)}>{formatTipoMatchMigracion(tipoMatch)}</StatusBadge>;
}

interface RowActionState {
  readonly loading: boolean;
  readonly message: string | null;
  readonly isError: boolean;
}

interface RowDraft {
  readonly destinoCuentaId: string;
  readonly nota: string;
  readonly estrategiaConciliacionSaldos: string;
}

const EMPTY_DRAFT: RowDraft = { destinoCuentaId: "", nota: "", estrategiaConciliacionSaldos: "" };

/** Parsea el textarea de catálogo (JSON) a `CuentaCatalogoInput[]`, o lanza un
 * mensaje legible -- la página nunca manda al servidor un JSON que ni siquiera
 * pudo parsear como arreglo de objetos. */
function parseCatalogoJson(raw: string, etiqueta: string): readonly CuentaCatalogoInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${etiqueta}: JSON inválido.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${etiqueta}: se esperaba un arreglo de cuentas.`);
  return parsed.map((raw_, idx) => {
    if (typeof raw_ !== "object" || raw_ === null) throw new Error(`${etiqueta}[${idx}]: se esperaba un objeto.`);
    const c = raw_ as Record<string, unknown>;
    if (typeof c.id !== "string" || c.id.length === 0) throw new Error(`${etiqueta}[${idx}].id: se esperaba un string no vacío.`);
    if (typeof c.codigo !== "string" || c.codigo.length === 0) throw new Error(`${etiqueta}[${idx}].codigo: se esperaba un string no vacío.`);
    if (typeof c.nombre !== "string" || c.nombre.length === 0) throw new Error(`${etiqueta}[${idx}].nombre: se esperaba un string no vacío.`);
    return {
      id: c.id,
      codigo: c.codigo,
      nombre: c.nombre,
      nivel: typeof c.nivel === "number" ? c.nivel : undefined,
      naturaleza: typeof c.naturaleza === "string" ? c.naturaleza : undefined,
      tipoAgregado: typeof c.tipoAgregado === "string" ? c.tipoAgregado : undefined,
      cuentaPadreCodigo: typeof c.cuentaPadreCodigo === "string" ? c.cuentaPadreCodigo : null,
    };
  });
}

export function MigracionCatalogoPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const { confirmar, dialogo } = useConfirm();
  const [mapeos, setMapeos] = useState<readonly MapeoMigracionCuenta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<EstadoMapeoMigracion | "">("");

  const [showClasificarForm, setShowClasificarForm] = useState(false);
  const [catalogoOrigenText, setCatalogoOrigenText] = useState(EJEMPLO_CATALOGO);
  const [catalogoDestinoText, setCatalogoDestinoText] = useState(EJEMPLO_CATALOGO);
  const [clasificarError, setClasificarError] = useState<string | null>(null);
  const [clasificando, setClasificando] = useState(false);
  const [clasificarResultado, setClasificarResultado] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [rowActions, setRowActions] = useState<Record<string, RowActionState>>({});

  const puedeGestionar = GESTIONAR_ROLES.has(role);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMapeosMigracion(fetch, apiBaseUrl, token, propertyId, filtroEstado ? { estado: filtroEstado } : undefined);
      setMapeos(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los mapeos de migración.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, filtroEstado]);

  async function handleClasificar() {
    setClasificarError(null);
    setClasificarResultado(null);
    let catalogoOrigen: readonly CuentaCatalogoInput[];
    let catalogoDestino: readonly CuentaCatalogoInput[];
    try {
      catalogoOrigen = parseCatalogoJson(catalogoOrigenText, "Catálogo origen");
      catalogoDestino = parseCatalogoJson(catalogoDestinoText, "Catálogo destino");
    } catch (err) {
      setClasificarError(err instanceof Error ? err.message : "JSON inválido.");
      return;
    }
    setClasificando(true);
    try {
      const nuevos = await clasificarCatalogo(fetch, apiBaseUrl, token, propertyId, { catalogoOrigen, catalogoDestino });
      const autoAprobados = nuevos.filter((m) => m.estado === "aprobado").length;
      setClasificarResultado(`${nuevos.length} mapeo(s) propuesto(s) -- ${autoAprobados} auto-aprobado(s) por match exacto, ${nuevos.length - autoAprobados} pendiente(s) de revisión.`);
      setShowClasificarForm(false);
      await load();
    } catch (err) {
      setClasificarError(err instanceof Error ? err.message : "No se pudo clasificar el catálogo.");
    } finally {
      setClasificando(false);
    }
  }

  function draftDe(id: string): RowDraft {
    return drafts[id] ?? EMPTY_DRAFT;
  }

  function setDraft(id: string, patch: Partial<RowDraft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...draftDe(id), ...patch } }));
  }

  function setRowState(id: string, state: RowActionState) {
    setRowActions((prev) => ({ ...prev, [id]: state }));
  }

  async function handleAprobar(m: MapeoMigracionCuenta) {
    const draft = draftDe(m.id);
    const ok = await confirmar({
      titulo: "Aprobar mapeo",
      descripcion: `${m.origenCuentaId} → ${m.destinoCuentaId ?? "—"}. La decisión queda registrada y no se puede deshacer.`,
      confirmar: "Aprobar",
    });
    if (!ok) return;
    setRowState(m.id, { loading: true, message: null, isError: false });
    try {
      await aprobarMapeoMigracion(fetch, apiBaseUrl, token, propertyId, m.id, {
        nota: draft.nota.trim() || undefined,
        estrategiaConciliacionSaldos: draft.estrategiaConciliacionSaldos.trim() || undefined,
      });
      setRowState(m.id, { loading: false, message: "Aprobado.", isError: false });
      await load();
    } catch (err) {
      setRowState(m.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo aprobar el mapeo.", isError: true });
    }
  }

  async function handleRechazar(m: MapeoMigracionCuenta) {
    const draft = draftDe(m.id);
    if (!draft.nota.trim()) {
      setRowState(m.id, { loading: false, message: "Rechazar requiere una nota con el motivo.", isError: true });
      return;
    }
    const ok = await confirmar({
      titulo: "Rechazar mapeo",
      descripcion: `${m.origenCuentaId} → ${m.destinoCuentaId ?? "—"}. La decisión queda registrada y no se puede deshacer.`,
      tono: "danger",
      confirmar: "Rechazar",
    });
    if (!ok) return;
    setRowState(m.id, { loading: true, message: null, isError: false });
    try {
      await rechazarMapeoMigracion(fetch, apiBaseUrl, token, propertyId, m.id, { nota: draft.nota.trim() });
      setRowState(m.id, { loading: false, message: "Rechazado.", isError: false });
      await load();
    } catch (err) {
      setRowState(m.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo rechazar el mapeo.", isError: true });
    }
  }

  async function handleEditar(m: MapeoMigracionCuenta) {
    const draft = draftDe(m.id);
    if (!draft.destinoCuentaId.trim()) {
      setRowState(m.id, { loading: false, message: "Editar requiere el id de la cuenta destino corregida.", isError: true });
      return;
    }
    if (!draft.nota.trim()) {
      setRowState(m.id, { loading: false, message: "Editar requiere una nota con el motivo de la corrección.", isError: true });
      return;
    }
    const ok = await confirmar({
      titulo: "Editar mapeo",
      descripcion: `${m.origenCuentaId} pasará a la cuenta destino ${draft.destinoCuentaId.trim()}. La decisión queda registrada y no se puede deshacer.`,
      confirmar: "Editar",
    });
    if (!ok) return;
    setRowState(m.id, { loading: true, message: null, isError: false });
    try {
      await editarMapeoMigracion(fetch, apiBaseUrl, token, propertyId, m.id, {
        destinoCuentaId: draft.destinoCuentaId.trim(),
        nota: draft.nota.trim(),
        estrategiaConciliacionSaldos: draft.estrategiaConciliacionSaldos.trim() || undefined,
      });
      setRowState(m.id, { loading: false, message: "Editado.", isError: false });
      await load();
    } catch (err) {
      setRowState(m.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo editar el mapeo.", isError: true });
    }
  }

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        titulo="Migración de catálogo contable"
        descripcion="Clasifica el catálogo origen contra el destino y decide cada mapeo propuesto: el match exacto queda auto-aprobado, el resto espera revisión humana."
        acciones={
          puedeGestionar ? (
            <Button size="sm" onClick={() => setShowClasificarForm(true)}>
              <FolderInput />
              Clasificar catálogo
            </Button>
          ) : undefined
        }
      />

      <FormDialog
        open={showClasificarForm}
        onOpenChange={(abierto) => {
          if (!abierto && !clasificando) setShowClasificarForm(false);
        }}
        titulo="Clasificar catálogo"
        subtitulo="El catálogo del cliente vive en su propia base, fuera de este panel -- pega aquí el JSON ya exportado (arreglo de cuentas: id, codigo, nombre y opcionalmente nivel/naturaleza/tipoAgregado/cuentaPadreCodigo)."
        onGuardar={() => void handleClasificar()}
        guardando={clasificando}
        textoBotonGuardar="Clasificar"
        bloquearCierre={clasificando}
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="Catálogo origen (JSON)" required className="min-w-0">
              <Textarea id="catalogo-origen" value={catalogoOrigenText} onChange={(e) => setCatalogoOrigenText(e.target.value)} rows={8} className="font-mono text-xs" />
            </FormField>
            <FormField label="Catálogo destino (JSON)" required className="min-w-0">
              <Textarea id="catalogo-destino" value={catalogoDestinoText} onChange={(e) => setCatalogoDestinoText(e.target.value)} rows={8} className="font-mono text-xs" />
            </FormField>
          </div>
          {clasificarError && <Callout tone="danger">{clasificarError}</Callout>}
        </div>
      </FormDialog>

      {clasificarResultado && <Callout tone="success">{clasificarResultado}</Callout>}

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <FormField label="Filtrar por estado" className="w-fit">
        <NativeSelect id="migracion-filtro-estado" value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value as EstadoMapeoMigracion | "")} wrapperClassName="w-auto min-w-44">
          {ESTADO_FILTROS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      {loading && !mapeos && <EstadoCargando etiqueta="Cargando mapeos de migración…" />}

      {mapeos && mapeos.length === 0 && !loading && (
        <EstadoVacio mensaje={`No hay mapeos de migración${filtroEstado ? " con ese estado" : ""} todavía.`} />
      )}

      {mapeos && mapeos.length > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cuenta origen</TableHead>
                  <TableHead>Cuenta destino</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Estado</TableHead>
                  {puedeGestionar && <TableHead>Decisión</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {mapeos.map((m) => {
                  const rowState = rowActions[m.id];
                  const draft = draftDe(m.id);
                  const esPendiente = m.estado === "pendiente";
                  return (
                    <TableRow key={m.id} className="align-top">
                      <TableCell className="font-semibold text-foreground">{m.origenCuentaId}</TableCell>
                      <TableCell className="text-muted-foreground">{m.destinoCuentaId ?? "—"}</TableCell>
                      <TableCell>
                        <TipoMatchBadge tipoMatch={m.tipoMatch} />
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{m.score}</TableCell>
                      <TableCell>
                        <EstadoBadge estado={m.estado} />
                        {m.aprobadoPor && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {m.estado === "rechazado" ? "Rechazado" : m.estado === "editado" ? "Editado" : "Aprobado"} por {m.aprobadoPor}
                            {m.aprobadoEn ? ` · ${formatDateTime(m.aprobadoEn)}` : ""}
                          </div>
                        )}
                        {m.nota && <div className="mt-0.5 text-xs text-muted-foreground">{m.nota}</div>}
                        {m.estrategiaConciliacionSaldos && <div className="mt-0.5 text-xs text-muted-foreground">Conciliación: {m.estrategiaConciliacionSaldos}</div>}
                      </TableCell>
                      {puedeGestionar && (
                        <TableCell>
                          {esPendiente ? (
                            <div className="flex min-w-64 flex-col gap-1.5">
                              <FormField label="Cuenta destino corregida (solo para editar)">
                                <Input id={`migracion-destino-${m.id}`} type="text" placeholder="Id de la cuenta destino" value={draft.destinoCuentaId} onChange={(e) => setDraft(m.id, { destinoCuentaId: e.target.value })} />
                              </FormField>
                              <FormField label="Nota del motivo (obligatoria para rechazar o editar)">
                                <Input id={`migracion-nota-${m.id}`} type="text" placeholder="Motivo" value={draft.nota} onChange={(e) => setDraft(m.id, { nota: e.target.value })} />
                              </FormField>
                              <FormField label="Estrategia de conciliación (solo si hay N:1)">
                                <Input id={`migracion-estrategia-${m.id}`} type="text" placeholder="Estrategia" value={draft.estrategiaConciliacionSaldos} onChange={(e) => setDraft(m.id, { estrategiaConciliacionSaldos: e.target.value })} />
                              </FormField>
                              <div className="flex flex-wrap gap-1.5">
                                <Button type="button" variant="outline" onClick={() => void handleAprobar(m)} disabled={rowState?.loading}>
                                  <Check />
                                  Aprobar
                                </Button>
                                <Button type="button" variant="destructive" onClick={() => void handleRechazar(m)} disabled={rowState?.loading}>
                                  <X />
                                  Rechazar
                                </Button>
                                <Button type="button" variant="outline" onClick={() => void handleEditar(m)} disabled={rowState?.loading}>
                                  <Pencil />
                                  Editar
                                </Button>
                              </div>
                              {rowState?.message && <Callout tone={rowState.isError ? "danger" : "success"}>{rowState.message}</Callout>}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">Ya decidido.</span>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {dialogo}
    </PageContainer>
  );
}
