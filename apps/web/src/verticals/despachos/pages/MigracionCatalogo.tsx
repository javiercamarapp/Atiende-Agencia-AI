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

const ESTADO_COLORS: Record<EstadoMapeoMigracion, { bg: string; fg: string }> = {
  pendiente: { bg: "#fef9c3", fg: "#854d0e" },
  aprobado: { bg: "#dcfce7", fg: "#166534" },
  rechazado: { bg: "#fee2e2", fg: "#991b1b" },
  editado: { bg: "#dbeafe", fg: "#1e40af" },
};

const TIPO_MATCH_COLORS: Record<MapeoMigracionCuenta["tipoMatch"], { bg: string; fg: string }> = {
  exacto: { bg: "#dcfce7", fg: "#166534" },
  alerta_riesgo: { bg: "#fee2e2", fg: "#991b1b" },
  fuzzy: { bg: "#fef9c3", fg: "#854d0e" },
  sin_match: { bg: "#e5e7eb", fg: "#374151" },
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
  const colors = ESTADO_COLORS[estado];
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, fontWeight: 600 }}>{formatEstadoMapeoMigracion(estado)}</span>;
}

function TipoMatchBadge({ tipoMatch }: { tipoMatch: MapeoMigracionCuenta["tipoMatch"] }) {
  const colors = TIPO_MATCH_COLORS[tipoMatch];
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, fontWeight: 600 }}>{formatTipoMatchMigracion(tipoMatch)}</span>;
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

  const [decididoPor, setDecididoPor] = useState("");
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
    if (!decididoPor.trim()) {
      setRowState(m.id, { loading: false, message: "Falta indicar quién decide (\"Decidido por\", arriba de la tabla).", isError: true });
      return;
    }
    const draft = draftDe(m.id);
    setRowState(m.id, { loading: true, message: null, isError: false });
    try {
      await aprobarMapeoMigracion(fetch, apiBaseUrl, token, propertyId, m.id, {
        decididoPor: decididoPor.trim(),
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
    if (!decididoPor.trim()) {
      setRowState(m.id, { loading: false, message: "Falta indicar quién decide (\"Decidido por\", arriba de la tabla).", isError: true });
      return;
    }
    const draft = draftDe(m.id);
    if (!draft.nota.trim()) {
      setRowState(m.id, { loading: false, message: "Rechazar requiere una nota con el motivo.", isError: true });
      return;
    }
    setRowState(m.id, { loading: true, message: null, isError: false });
    try {
      await rechazarMapeoMigracion(fetch, apiBaseUrl, token, propertyId, m.id, { decididoPor: decididoPor.trim(), nota: draft.nota.trim() });
      setRowState(m.id, { loading: false, message: "Rechazado.", isError: false });
      await load();
    } catch (err) {
      setRowState(m.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo rechazar el mapeo.", isError: true });
    }
  }

  async function handleEditar(m: MapeoMigracionCuenta) {
    if (!decididoPor.trim()) {
      setRowState(m.id, { loading: false, message: "Falta indicar quién decide (\"Decidido por\", arriba de la tabla).", isError: true });
      return;
    }
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
        decididoPor: decididoPor.trim(),
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
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Migración de catálogo contable</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
            Clasifica el catálogo origen contra el destino (match exacto/alerta de riesgo/aproximado) y decide cada mapeo propuesto -- el match exacto queda auto-aprobado, el resto espera revisión humana.
          </p>
        </div>
        {puedeGestionar && (
          <button
            onClick={() => setShowClasificarForm((v) => !v)}
            style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: showClasificarForm ? "#fff" : "#111827", color: showClasificarForm ? "#111827" : "#fff", cursor: "pointer", fontSize: 13 }}
          >
            {showClasificarForm ? "Cancelar" : "+ Clasificar catálogo"}
          </button>
        )}
      </header>

      {showClasificarForm && (
        <form onSubmit={handleClasificar} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
          <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>
            El catálogo del cliente vive en su propia base, fuera de este panel -- pega aquí el JSON ya exportado (arreglo de cuentas: id, codigo, nombre y opcionalmente nivel/naturaleza/tipoAgregado/cuentaPadreCodigo).
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, minWidth: 0 }}>
              Catálogo origen (JSON) *
              <textarea
                value={catalogoOrigenText}
                onChange={(e) => setCatalogoOrigenText(e.target.value)}
                rows={8}
                required
                style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontFamily: "monospace", fontSize: 12 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, minWidth: 0 }}>
              Catálogo destino (JSON) *
              <textarea
                value={catalogoDestinoText}
                onChange={(e) => setCatalogoDestinoText(e.target.value)}
                rows={8}
                required
                style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontFamily: "monospace", fontSize: 12 }}
              />
            </label>
          </div>
          {clasificarError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {clasificarError}
            </p>
          )}
          <button type="submit" disabled={clasificando} style={{ padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, maxWidth: 220 }}>
            {clasificando ? "Clasificando…" : "Clasificar"}
          </button>
        </form>
      )}

      {clasificarResultado && (
        <p style={{ fontSize: 13, color: "#166534", margin: 0, background: "#dcfce7", padding: "8px 12px", borderRadius: 8 }}>{clasificarResultado}</p>
      )}

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151" }}>
          Filtrar por estado
          <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value as EstadoMapeoMigracion | "")} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}>
            {ESTADO_FILTROS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {puedeGestionar && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151" }}>
            Decidido por *
            <input
              type="text"
              placeholder="tu nombre o usuario"
              value={decididoPor}
              onChange={(e) => setDecididoPor(e.target.value)}
              style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
            />
          </label>
        )}
      </div>

      {loading && !mapeos && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      {mapeos && mapeos.length === 0 && !loading && <p style={{ color: "#6b7280" }}>No hay mapeos de migración{filtroEstado ? " con ese estado" : ""} todavía.</p>}

      {mapeos && mapeos.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                <th style={{ padding: "6px 8px" }}>Cuenta origen</th>
                <th style={{ padding: "6px 8px" }}>Cuenta destino</th>
                <th style={{ padding: "6px 8px" }}>Match</th>
                <th style={{ padding: "6px 8px" }}>Score</th>
                <th style={{ padding: "6px 8px" }}>Estado</th>
                {puedeGestionar && <th style={{ padding: "6px 8px" }}>Decisión</th>}
              </tr>
            </thead>
            <tbody>
              {mapeos.map((m) => {
                const rowState = rowActions[m.id];
                const draft = draftDe(m.id);
                const esPendiente = m.estado === "pendiente";
                return (
                  <tr key={m.id} style={{ borderBottom: "1px solid #f3f4f6", verticalAlign: "top" }}>
                    <td style={{ padding: "8px", fontWeight: 600, color: "#111827" }}>{m.origenCuentaId}</td>
                    <td style={{ padding: "8px", color: "#374151" }}>{m.destinoCuentaId ?? "—"}</td>
                    <td style={{ padding: "8px" }}>
                      <TipoMatchBadge tipoMatch={m.tipoMatch} />
                    </td>
                    <td style={{ padding: "8px", color: "#374151" }}>{m.score}</td>
                    <td style={{ padding: "8px" }}>
                      <EstadoBadge estado={m.estado} />
                      {m.aprobadoPor && (
                        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
                          {m.estado === "rechazado" ? "Rechazado" : m.estado === "editado" ? "Editado" : "Aprobado"} por {m.aprobadoPor}
                          {m.aprobadoEn ? ` · ${formatDateTime(m.aprobadoEn)}` : ""}
                        </div>
                      )}
                      {m.nota && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{m.nota}</div>}
                      {m.estrategiaConciliacionSaldos && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>Conciliación: {m.estrategiaConciliacionSaldos}</div>}
                    </td>
                    {puedeGestionar && (
                      <td style={{ padding: "8px" }}>
                        {esPendiente ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 260 }}>
                            <input
                              type="text"
                              placeholder="Cuenta destino corregida (solo para editar)"
                              value={draft.destinoCuentaId}
                              onChange={(e) => setDraft(m.id, { destinoCuentaId: e.target.value })}
                              style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }}
                            />
                            <input
                              type="text"
                              placeholder="Nota (motivo, obligatoria para rechazar/editar)"
                              value={draft.nota}
                              onChange={(e) => setDraft(m.id, { nota: e.target.value })}
                              style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }}
                            />
                            <input
                              type="text"
                              placeholder="Estrategia de conciliación (solo si hay N:1)"
                              value={draft.estrategiaConciliacionSaldos}
                              onChange={(e) => setDraft(m.id, { estrategiaConciliacionSaldos: e.target.value })}
                              style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }}
                            />
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <button
                                type="button"
                                onClick={() => void handleAprobar(m)}
                                disabled={rowState?.loading}
                                style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #166534", background: "#fff", color: "#166534", cursor: "pointer", fontSize: 12 }}
                              >
                                {rowState?.loading ? "…" : "Aprobar"}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleRechazar(m)}
                                disabled={rowState?.loading}
                                style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", cursor: "pointer", fontSize: 12 }}
                              >
                                Rechazar
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleEditar(m)}
                                disabled={rowState?.loading}
                                style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #1e40af", background: "#fff", color: "#1e40af", cursor: "pointer", fontSize: 12 }}
                              >
                                Editar
                              </button>
                            </div>
                            {rowState?.message && (
                              <span style={{ fontSize: 11, color: rowState.isError ? "#b91c1c" : "#166534" }} role={rowState.isError ? "alert" : undefined}>
                                {rowState.message}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, color: "#9ca3af" }}>Ya decidido.</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
