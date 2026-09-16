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
import type { FormEvent } from "react";
import { Check, CheckCircle2, FolderInput, Pencil, X } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import { ModalFormularioLateral } from "../../../components/ModalFormularioLateral.tsx";
import {
  aprobarMapeoMigracion,
  clasificarCatalogo,
  editarMapeoMigracion,
  fetchMapeosMigracion,
  rechazarMapeoMigracion,
} from "../lib/migracion-catalogo-client.ts";
import type { CuentaCatalogoInput, EstadoMapeoMigracion, MapeoMigracionCuenta } from "../lib/migracion-catalogo-client.ts";
import { formatDateTime, formatEstadoMapeoMigracion, formatTipoMatchMigracion } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

// Misma carga semántica exacta que las píldoras inline originales, ahora sobre
// el `Badge` real de @atiende/ui.
type BadgeSpec = { variant: "default" | "secondary" | "destructive" | "outline"; className?: string };

const VERDE = "border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400";
const AMBAR = "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400";

const ESTADO_BADGE: Record<EstadoMapeoMigracion, BadgeSpec> = {
  pendiente: { variant: "outline", className: AMBAR },
  aprobado: { variant: "outline", className: VERDE },
  rechazado: { variant: "destructive" },
  editado: { variant: "secondary" },
};

const TIPO_MATCH_BADGE: Record<MapeoMigracionCuenta["tipoMatch"], BadgeSpec> = {
  exacto: { variant: "outline", className: VERDE },
  alerta_riesgo: { variant: "destructive" },
  fuzzy: { variant: "outline", className: AMBAR },
  sin_match: { variant: "outline", className: "border-transparent bg-muted text-muted-foreground" },
};

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
  const { variant, className } = ESTADO_BADGE[estado];
  return (
    <Badge variant={variant} className={className}>
      {formatEstadoMapeoMigracion(estado)}
    </Badge>
  );
}

function TipoMatchBadge({ tipoMatch }: { tipoMatch: MapeoMigracionCuenta["tipoMatch"] }) {
  const { variant, className } = TIPO_MATCH_BADGE[tipoMatch];
  return (
    <Badge variant={variant} className={className}>
      {formatTipoMatchMigracion(tipoMatch)}
    </Badge>
  );
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

  async function handleClasificar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    <div className="flex flex-col gap-4 px-1">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">Migración de catálogo contable</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Clasifica el catálogo origen contra el destino (match exacto/alerta de riesgo/aproximado) y decide cada mapeo propuesto -- el match exacto queda auto-aprobado, el resto espera revisión humana.
          </p>
        </div>
        {puedeGestionar && (
          <Button variant={showClasificarForm ? "outline" : "default"} size="sm" onClick={() => setShowClasificarForm((v) => !v)}>
            <FolderInput />
            {showClasificarForm ? "Cancelar" : "Clasificar catálogo"}
          </Button>
        )}
      </header>

      {/* El formulario de clasificación (dos JSON grandes pegados a mano) pasó al
          `ModalFormularioLateral` compartido: es exactamente la forma
          "formulario ancho en riel lateral" para la que existe ese shell, y
          además deja de empujar la tabla de mapeos hacia abajo. El estado
          `showClasificarForm` y `handleClasificar` son los mismos de antes. */}
      {showClasificarForm && (
        <ModalFormularioLateral
          open
          onOpenChange={(abierto) => {
            if (!abierto) setShowClasificarForm(false);
          }}
          titulo="Clasificar catálogo"
          subtitulo="El catálogo del cliente vive en su propia base, fuera de este panel -- pega aquí el JSON ya exportado (arreglo de cuentas: id, codigo, nombre y opcionalmente nivel/naturaleza/tipoAgregado/cuentaPadreCodigo)."
          footer={
            <Button type="submit" form="migracion-clasificar" disabled={clasificando} className="rounded-full px-6">
              {clasificando ? "Clasificando…" : "Clasificar"}
            </Button>
          }
        >
          <form id="migracion-clasificar" onSubmit={handleClasificar} className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="catalogo-origen">Catálogo origen (JSON) *</Label>
                <textarea
                  id="catalogo-origen"
                  value={catalogoOrigenText}
                  onChange={(e) => setCatalogoOrigenText(e.target.value)}
                  rows={8}
                  required
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="catalogo-destino">Catálogo destino (JSON) *</Label>
                <textarea
                  id="catalogo-destino"
                  value={catalogoDestinoText}
                  onChange={(e) => setCatalogoDestinoText(e.target.value)}
                  rows={8}
                  required
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
            </div>
            {clasificarError && (
              <p role="alert" className="text-destructive text-sm">
                {clasificarError}
              </p>
            )}
          </form>
        </ModalFormularioLateral>
      )}

      {clasificarResultado && (
        <p className="flex items-start gap-2 rounded-lg bg-green-100 px-3 py-2 text-[13px] text-green-800 dark:bg-green-500/15 dark:text-green-400">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          {clasificarResultado}
        </p>
      )}

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Label htmlFor="migracion-filtro-estado" className="text-[13px] text-foreground">
            Filtrar por estado
          </Label>
          <select
            id="migracion-filtro-estado"
            value={filtroEstado}
            onChange={(e) => setFiltroEstado(e.target.value as EstadoMapeoMigracion | "")}
            className="h-9 rounded-md border border-input bg-background px-2 text-[13px] text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {ESTADO_FILTROS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>

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
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {m.estado === "rechazado" ? "Rechazado" : m.estado === "editado" ? "Editado" : "Aprobado"} por {m.aprobadoPor}
                            {m.aprobadoEn ? ` · ${formatDateTime(m.aprobadoEn)}` : ""}
                          </div>
                        )}
                        {m.nota && <div className="mt-0.5 text-[11px] text-muted-foreground">{m.nota}</div>}
                        {m.estrategiaConciliacionSaldos && <div className="mt-0.5 text-[11px] text-muted-foreground">Conciliación: {m.estrategiaConciliacionSaldos}</div>}
                      </TableCell>
                      {puedeGestionar && (
                        <TableCell>
                          {esPendiente ? (
                            <div className="flex min-w-64 flex-col gap-1.5">
                              <Label htmlFor={`migracion-destino-${m.id}`} className="sr-only">
                                Cuenta destino corregida
                              </Label>
                              <Input
                                id={`migracion-destino-${m.id}`}
                                type="text"
                                placeholder="Cuenta destino corregida (solo para editar)"
                                value={draft.destinoCuentaId}
                                onChange={(e) => setDraft(m.id, { destinoCuentaId: e.target.value })}
                                className="h-9 text-xs"
                              />
                              <Label htmlFor={`migracion-nota-${m.id}`} className="sr-only">
                                Nota del motivo
                              </Label>
                              <Input
                                id={`migracion-nota-${m.id}`}
                                type="text"
                                placeholder="Nota (motivo, obligatoria para rechazar/editar)"
                                value={draft.nota}
                                onChange={(e) => setDraft(m.id, { nota: e.target.value })}
                                className="h-9 text-xs"
                              />
                              <Label htmlFor={`migracion-estrategia-${m.id}`} className="sr-only">
                                Estrategia de conciliación
                              </Label>
                              <Input
                                id={`migracion-estrategia-${m.id}`}
                                type="text"
                                placeholder="Estrategia de conciliación (solo si hay N:1)"
                                value={draft.estrategiaConciliacionSaldos}
                                onChange={(e) => setDraft(m.id, { estrategiaConciliacionSaldos: e.target.value })}
                                className="h-9 text-xs"
                              />
                              <div className="flex flex-wrap gap-1.5">
                                <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={() => void handleAprobar(m)} disabled={rowState?.loading}>
                                  <Check />
                                  {rowState?.loading ? "…" : "Aprobar"}
                                </Button>
                                <Button type="button" variant="outline" size="sm" className="h-9 border-destructive/40 px-3 text-xs text-destructive hover:border-destructive" onClick={() => void handleRechazar(m)} disabled={rowState?.loading}>
                                  <X />
                                  Rechazar
                                </Button>
                                <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={() => void handleEditar(m)} disabled={rowState?.loading}>
                                  <Pencil />
                                  Editar
                                </Button>
                              </div>
                              {rowState?.message && (
                                <span className={`text-[11px] ${rowState.isError ? "text-destructive" : "text-green-700 dark:text-green-400"}`} role={rowState.isError ? "alert" : undefined}>
                                  {rowState.message}
                                </span>
                              )}
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
    </div>
  );
}
