// Bitacora de escrituras de la organizacion (L-P3-17, REQ-083/084/171) -- quien cambio que y cuando, con antes y despues, filtrable por
// entidad, persona, fecha y `correlation_id`, con paginacion por llave y la traza de una convocatoria de punta a punta (ingesta, version,
// aprobaciones y manifiesto comparten correlacion). Solo owner/admin (el servidor y la RLS lo exigen; aqui solo se oculta lo que rechazarian).
// Solo lectura: ningun boton escribe nada. Base sin la migracion 038: estado honesto "no disponible aun".
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, DataTable, EstadoError, Input, Label, NativeSelect, PageContainer, StatusBadge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { ENTIDAD_LABEL, accionLegible, cambiosDe, fetchAuditTrace, fetchAuditTrail } from "../lib/audit-trail-client.ts";
import type { AuditTrailEntry, AuditTrailFilters } from "../lib/audit-trail-client.ts";
import { fetchOrgMembers } from "../lib/staff-client.ts";
import type { OrgMember } from "../lib/staff-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const PAGE_SIZE = 25;
const ROLES_BITACORA: ReadonlySet<string> = new Set(["owner", "admin"]);
const FECHA = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });

export function BitacoraPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const puede = ROLES_BITACORA.has(role);
  const [params, setParams] = useSearchParams();
  const convocatoria = params.get("convocatoria");

  const [entity, setEntity] = useState("");
  const [actorId, setActorId] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [correlationId, setCorrelationId] = useState(params.get("correlacion") ?? "");

  const [items, setItems] = useState<readonly AuditTrailEntry[]>([]);
  const [people, setPeople] = useState<Readonly<Record<string, string>>>({});
  const [entities, setEntities] = useState<readonly string[]>(Object.keys(ENTIDAD_LABEL));
  const [members, setMembers] = useState<readonly OrgMember[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMas, setLoadingMas] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtros: AuditTrailFilters = { entity: entity || undefined, actorId: actorId || undefined, desde: desde || undefined, hasta: hasta || undefined, correlationId: correlationId.trim() || undefined };

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (convocatoria) {
        const t = await fetchAuditTrace(fetch, apiBaseUrl, token, propertyId, convocatoria);
        setItems(t.items);
        setPeople(t.people);
        setNextCursor(t.nextCursor);
        setAvailable(t.available);
      } else {
        const p = await fetchAuditTrail(fetch, apiBaseUrl, token, propertyId, filtros, null, PAGE_SIZE);
        setItems(p.items);
        setPeople(p.people);
        setEntities(p.entities);
        setNextCursor(p.nextCursor);
        setAvailable(p.available);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la bitácora.");
    } finally {
      setLoading(false);
    }
    // eslint: el proyecto no configura eslint-plugin-react-hooks; `filtros` se reconstruye en cada render a partir de estos estados.
  }, [apiBaseUrl, token, propertyId, convocatoria, entity, actorId, desde, hasta, correlationId]);

  useEffect(() => {
    if (puede) void cargar();
  }, [puede, cargar]);

  useEffect(() => {
    if (!puede) return;
    void fetchOrgMembers(fetch, apiBaseUrl, token, propertyId).then(setMembers).catch(() => setMembers([]));
  }, [puede, apiBaseUrl, token, propertyId]);

  async function verMas() {
    if (!nextCursor) return;
    setLoadingMas(true);
    setError(null);
    try {
      const p = await fetchAuditTrail(fetch, apiBaseUrl, token, propertyId, filtros, nextCursor, PAGE_SIZE);
      setItems((prev) => [...prev, ...p.items]);
      setPeople((prev) => ({ ...prev, ...p.people }));
      setNextCursor(p.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar más.");
    } finally {
      setLoadingMas(false);
    }
  }

  if (!puede) return <EstadoError mensaje="Solo el owner o un admin de la organización puede ver la bitácora de cambios." />;

  const hayFiltros = Boolean(entity || actorId || desde || hasta || correlationId.trim());
  const quien = (e: AuditTrailEntry): string => (e.actorId === null ? "Sistema (ingesta automática)" : (people[e.actorId] ?? "Otra persona"));

  const columnas: readonly DataTableColumna<AuditTrailEntry>[] = [
    { id: "fecha", encabezado: "Fecha", celda: (e) => <span className="whitespace-nowrap text-xs text-muted-foreground">{FECHA.format(new Date(e.createdAt))}</span> },
    { id: "evento", encabezado: "Cambio", principal: true, celda: (e) => <span className="text-foreground">{accionLegible(e.entity, e.action)}</span> },
    {
      id: "detalle",
      encabezado: "Antes → después",
      celda: (e) => {
        const cambios = cambiosDe(e.before, e.after);
        if (cambios.length === 0) return <span className="text-xs text-muted-foreground">Sin cambios de campo registrados.</span>;
        return (
          <ul className="flex flex-col gap-0.5 text-xs">
            {cambios.map((c) => (
              <li key={c.campo} className="break-words">
                <span className="font-medium text-foreground">{c.campo}</span>: <span className="text-muted-foreground">{c.antes}</span> → <span className="text-foreground">{c.despues}</span>
              </li>
            ))}
          </ul>
        );
      },
    },
    { id: "quien", encabezado: "Quién", celda: (e) => <span className="text-xs text-muted-foreground">{quien(e)}</span> },
    {
      id: "correlacion",
      encabezado: "Correlación",
      celda: (e) =>
        e.correlationId ? (
          <button
            type="button"
            className="max-w-40 truncate rounded-md border border-border px-1.5 py-0.5 font-mono text-xs text-foreground hover:bg-muted"
            title={`Ver toda la traza ${e.correlationId}`}
            onClick={() => {
              setParams({});
              setCorrelationId(e.correlationId!);
            }}
          >
            {e.correlationId}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <PageContainer padding="none" size="md" className="gap-4 [&>*]:min-w-0">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{convocatoria ? "Traza de la convocatoria" : "Bitácora de cambios"}</CardTitle>
          <CardDescription>
            {convocatoria
              ? "Todo lo que pasó con esta convocatoria de punta a punta: ingesta, versiones, aprobaciones y manifiesto, en orden cronológico."
              : "Quién cambió qué, con el valor anterior y el nuevo. Solo se agrega: ningún renglón se edita ni se borra. Del más reciente al más antiguo."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {convocatoria ? (
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge dot={false}>Convocatoria</StatusBadge>
              <Link to={`/licitaciones/${orgSlug}/convocatorias/${convocatoria}`} className="text-sm text-foreground underline">
                Volver a la convocatoria
              </Link>
              <Button type="button" size="sm" variant="outline" onClick={() => setParams({})}>
                Ver toda la bitácora
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="bit-entidad">Entidad</Label>
                <NativeSelect id="bit-entidad" size="sm" wrapperClassName="w-52" value={entity} onChange={(e) => setEntity(e.target.value)}>
                  <option value="">Todas</option>
                  {entities.map((x) => (
                    <option key={x} value={x}>
                      {ENTIDAD_LABEL[x] ?? x}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="bit-actor">Persona</Label>
                <NativeSelect id="bit-actor" size="sm" wrapperClassName="w-52" value={actorId} onChange={(e) => setActorId(e.target.value)}>
                  <option value="">Todas</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.fullName}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="bit-desde">Desde</Label>
                <Input id="bit-desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="bit-hasta">Hasta</Label>
                <Input id="bit-hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="bit-correlacion">Correlación</Label>
                <Input id="bit-correlacion" placeholder="c-…" maxLength={64} className="w-52 font-mono" value={correlationId} onChange={(e) => setCorrelationId(e.target.value)} />
              </div>
              {hayFiltros && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEntity("");
                    setActorId("");
                    setDesde("");
                    setHasta("");
                    setCorrelationId("");
                  }}
                >
                  Limpiar filtros
                </Button>
              )}
            </div>
          )}

          {!available && (
            <p role="status" className="text-xs text-muted-foreground">
              No disponible aún: la bitácora de cambios requiere la migración 038 en esta base. Los cambios que se hagan mientras tanto no quedan registrados aquí.
            </p>
          )}

          <DataTable
            etiqueta="Bitácora de cambios de la organización"
            columnas={columnas}
            filas={items}
            obtenerId={(e) => e.id}
            estado={loading && items.length === 0 ? "loading" : error && items.length === 0 ? "error" : undefined}
            error={{ mensaje: error ?? undefined, onReintentar: () => void cargar() }}
            vacio={{ mensaje: !available ? "Sin datos: la bitácora aún no está disponible en esta base." : hayFiltros || convocatoria ? "Ningún cambio coincide con los filtros." : "Todavía no hay cambios registrados." }}
            paginacion={false}
          />

          {error && items.length > 0 && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {!convocatoria && nextCursor && (
            <div className="flex justify-end">
              <Button type="button" size="sm" variant="outline" disabled={loadingMas} onClick={() => void verMas()}>
                {loadingMas ? "Cargando…" : "Cargar más"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
