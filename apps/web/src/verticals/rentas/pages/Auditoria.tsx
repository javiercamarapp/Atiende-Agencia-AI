// r5 -- Bitácora de auditoría del staff: cierra el hueco detectado al diseñar el
// panel de superadmin (rentas no tenía ninguna pantalla que mostrara qué hizo cada
// miembro del staff -- cambios de precio, cancelación/modificación de reservas,
// payouts, ajustes de owner statement, conexión/desconexión de canales iCal). Ver
// apps/api/src/routes/verticals/rentas/auditoria.ts.
//
// Solo lectura, gateada por rol en AMBOS lados -- mismo criterio que Precios.tsx
// (`PRICING_ESCRITURA_ROLES`): el servidor SIEMPRE re-valida (403 si el rol no es
// admin_gestora), este gate es solo UX (evitar pedirle datos a un endpoint que sabe
// que va a rechazar).
//
// Tres estados honestos, además de cargando/error de red:
//  - `disponible: false` (la migración de la bitácora todavía no se aplicó a esta
//    base) -- NUNCA se confunde con una bitácora vacía real.
//  - lista vacía real (`disponible: true, items: []`) -- "todavía no hay ninguna
//    acción registrada", un estado legítimo y distinto del anterior.
//  - lista con datos -- tabla + "cargar más" (paginado por `nextOffset`, nunca trae
//    todo el historial en un solo request).
import { useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { AUDIT_LOG_ENTITY_TYPE_LABELS, AUDIT_LOG_ENTITY_TYPES, fetchAuditoria } from "../lib/auditoria-client.ts";
import type { AuditLogEntityType, AuditLogEntry } from "../lib/auditoria-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const AUDITORIA_LECTURA_ROLES = new Set(["admin_gestora"]);
const PAGE_SIZE = 25;

const SELECT_CLASES =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
const DATE_INPUT_CLASES = SELECT_CLASES;
const LABEL_CLASES = "flex flex-col gap-1.5 text-[13px] text-foreground";

function formatearFechaHora(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

/** Texto corto de la acción, ej. "pricing.tarifa_base.actualizada" -> "tarifa base
 *  actualizada" -- puramente cosmético, la fuente de verdad sigue siendo `action`
 *  completo (visible en el título de la fila para quien necesite el valor exacto). */
function etiquetaAccion(action: string): string {
  const partes = action.split(".");
  return (partes.length > 1 ? partes.slice(1) : partes).join(" ").replace(/_/g, " ");
}

export function AuditoriaPage({ apiBaseUrl, token, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeLeer = org ? AUDITORIA_LECTURA_ROLES.has(org.rol) : false;

  const [tipo, setTipo] = useState<AuditLogEntityType | "">("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");

  const [items, setItems] = useState<readonly AuditLogEntry[] | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);

  useEffect(() => {
    if (!puedeLeer) return;
    let cancelado = false;
    setItems(null);
    setError(null);
    (async () => {
      try {
        const pagina = await fetchAuditoria(fetch, apiBaseUrl, token, orgSlug, { tipo: tipo || null, desde: desde || null, hasta: hasta || null, limit: PAGE_SIZE, offset: 0 });
        if (cancelado) return;
        setDisponible(pagina.disponible);
        setItems(pagina.items);
        setTotal(pagina.total);
        setNextOffset(pagina.nextOffset);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar la bitácora de auditoría.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, orgSlug, tipo, desde, hasta, puedeLeer]);

  async function cargarMas() {
    if (nextOffset === null || cargandoMas) return;
    setCargandoMas(true);
    try {
      const pagina = await fetchAuditoria(fetch, apiBaseUrl, token, orgSlug, { tipo: tipo || null, desde: desde || null, hasta: hasta || null, limit: PAGE_SIZE, offset: nextOffset });
      setItems((current) => [...(current ?? []), ...pagina.items]);
      setNextOffset(pagina.nextOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar más de la bitácora.");
    } finally {
      setCargandoMas(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 max-w-[900px]">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Auditoría</h1>
        <p className="m-0 text-[13px] text-muted-foreground">Qué hizo cada miembro del staff: cambios de precio, reservas, payouts, estados de cuenta y canales.</p>
      </header>

      {!puedeLeer ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          Solo el rol <strong className="text-foreground">admin_gestora</strong> puede leer la bitácora de auditoría
          {org ? (
            <>
              {" "}
              — tu rol actual es <strong className="text-foreground">{org.rol}</strong>.
            </>
          ) : (
            "."
          )}
        </p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Filtros</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-4">
              <Label className={`${LABEL_CLASES} min-w-[180px]`}>
                Tipo de acción
                <select value={tipo} onChange={(e) => setTipo(e.target.value as AuditLogEntityType | "")} className={SELECT_CLASES}>
                  <option value="">Todos</option>
                  {AUDIT_LOG_ENTITY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {AUDIT_LOG_ENTITY_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </Label>
              <Label className={`${LABEL_CLASES} min-w-[160px]`}>
                Desde
                <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={DATE_INPUT_CLASES} />
              </Label>
              <Label className={`${LABEL_CLASES} min-w-[160px]`}>
                Hasta
                <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={DATE_INPUT_CLASES} />
              </Label>
            </CardContent>
          </Card>

          {error && <EstadoError mensaje={error} onReintentar={() => setError(null)} />}

          {!error && items === null && <EstadoCargando lineas={4} />}

          {!error && items !== null && !disponible && (
            <EstadoVacio
              icon={ClipboardList}
              titulo="Bitácora no disponible aún"
              mensaje="La bitácora de auditoría todavía no está habilitada en esta base de datos. La acción que buscas se completó con normalidad -- solo el registro no quedó guardado."
            />
          )}

          {!error && items !== null && disponible && items.length === 0 && (
            <EstadoVacio icon={ClipboardList} titulo="Sin acciones registradas" mensaje="Todavía no hay ninguna acción del staff registrada con estos filtros." />
          )}

          {!error && items !== null && disponible && items.length > 0 && (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cuándo</TableHead>
                      <TableHead>Acción</TableHead>
                      <TableHead>Campo</TableHead>
                      <TableHead>Antes</TableHead>
                      <TableHead>Después</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatearFechaHora(item.creadoEn)}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <Badge variant="outline" className="w-fit text-[10px]">
                              {AUDIT_LOG_ENTITY_TYPE_LABELS[item.entityType as AuditLogEntityType] ?? item.entityType}
                            </Badge>
                            <span className="text-xs text-muted-foreground" title={item.action}>
                              {etiquetaAccion(item.action)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{item.campo ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{item.antes ?? "—"}</TableCell>
                        <TableCell className="text-xs">{item.despues ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {!error && items !== null && disponible && items.length > 0 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {items.length} de {total}
              </span>
              {nextOffset !== null && (
                <Button type="button" variant="outline" size="sm" onClick={cargarMas} disabled={cargandoMas}>
                  {cargandoMas ? "Cargando…" : "Cargar más"}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
