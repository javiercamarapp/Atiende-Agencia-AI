// FASE 3 (producto) — Bitácora de auditoría del staff: citas no tenía ninguna
// pantalla que mostrara qué hizo cada miembro del staff (tarifas de servicios,
// cancelación forzada de citas, invitación/baja/cambio de rol de staff,
// horarios/disponibilidad, resolución manual de lista de espera). Copiado del
// patrón ya en `main` para restaurantes (apps/web/src/verticals/restaurantes/
// pages/Auditoria.tsx, PR #183, el más reciente y ya corregido) — ver
// apps/api/src/routes/verticals/citas/auditoria.ts.
//
// Solo lectura, gateada por rol en AMBOS lados -- el servidor SIEMPRE re-valida
// (403 si el rol no es owner/admin), este gate es solo UX. `CitasShellContext`
// ya trae `role` resuelto (ver CitasShell.tsx).
//
// Tres estados honestos, además de cargando/error de red:
//  - `disponible: false` (la migración de la bitácora todavía no se aplicó a esta
//    base) -- NUNCA se confunde con una bitácora vacía real.
//  - lista vacía real (`disponible: true, items: []`) -- "todavía no hay ninguna
//    acción registrada", un estado legítimo y distinto del anterior.
//  - lista con datos -- tabla + "cargar más" (paginado por `nextOffset`, nunca
//    trae todo el historial en un solo request).
import { useEffect, useRef, useState } from "react";
import { ClipboardList } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { AUDIT_LOG_ENTITY_TYPE_LABELS, AUDIT_LOG_ENTITY_TYPES, fetchAuditoria } from "../lib/auditoria-client.ts";
import type { AuditLogEntityType, AuditLogEntry } from "../lib/auditoria-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const AUDITORIA_LECTURA_ROLES = new Set(["owner", "admin"]);
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

/** Texto corto de la acción, ej. "servicio.tarifa_actualizada" -> "tarifa
 *  actualizada" -- puramente cosmético, la fuente de verdad sigue siendo `action`
 *  completo (visible en el título de la fila para quien necesite el valor exacto). */
function etiquetaAccion(action: string): string {
  const partes = action.split(".");
  return (partes.length > 1 ? partes.slice(1) : partes).join(" ").replace(/_/g, " ");
}

export function AuditoriaPage({ apiBaseUrl, token, propertyId, role }: CitasShellContext) {
  const puedeLeer = AUDITORIA_LECTURA_ROLES.has(role);

  const [tipo, setTipo] = useState<AuditLogEntityType | "">("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");

  const [items, setItems] = useState<readonly AuditLogEntry[] | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  // Contador incrementado por "Reintentar" -- entra en las deps del efecto de abajo
  // a propósito, para que reintentar SIEMPRE dispare un fetch nuevo aunque ningún
  // filtro haya cambiado (mismo hallazgo de revisión que cerró rentas/restaurantes:
  // si solo se limpia `error`, la pantalla se queda en el skeleton de carga para
  // siempre).
  const [reintento, setReintento] = useState(0);
  // Generación de la carga vigente: la incrementa el mismo efecto que dispara la
  // carga inicial (por filtro nuevo o reintento), y `cargarMas` la captura al
  // arrancar. Si los filtros cambian mientras una página de "cargar más" sigue en
  // vuelo, la generación capturada queda vieja y esa respuesta se descarta en vez
  // de anexarse a una lista que ya no corresponde a los filtros actuales.
  const generacionRef = useRef(0);

  useEffect(() => {
    if (!puedeLeer) return;
    let cancelado = false;
    generacionRef.current += 1;
    setItems(null);
    setError(null);
    (async () => {
      try {
        const pagina = await fetchAuditoria(fetch, apiBaseUrl, token, propertyId, { tipo: tipo || null, desde: desde || null, hasta: hasta || null, limit: PAGE_SIZE, offset: 0 });
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
  }, [apiBaseUrl, token, propertyId, tipo, desde, hasta, puedeLeer, reintento]);

  async function cargarMas() {
    if (nextOffset === null || cargandoMas) return;
    const generacion = generacionRef.current;
    setCargandoMas(true);
    try {
      const pagina = await fetchAuditoria(fetch, apiBaseUrl, token, propertyId, { tipo: tipo || null, desde: desde || null, hasta: hasta || null, limit: PAGE_SIZE, offset: nextOffset });
      // Los filtros cambiaron (o se disparó un reintento) mientras esta página
      // estaba en vuelo: esta respuesta ya no corresponde a la carga vigente --
      // descartarla en vez de anexarla a la lista actual.
      if (generacion !== generacionRef.current) return;
      setItems((current) => [...(current ?? []), ...pagina.items]);
      setNextOffset(pagina.nextOffset);
    } catch (err) {
      if (generacion === generacionRef.current) {
        setError(err instanceof Error ? err.message : "No se pudo cargar más de la bitácora.");
      }
    } finally {
      // Incondicional (mismo hallazgo de revisión ya corregido en rentas/
      // restaurantes): sin importar si esta respuesta sigue vigente o ya se
      // descartó arriba, el botón "Cargar más" debe volver a quedar disponible
      // para la carga (nueva o vieja) que sí esté vigente.
      setCargandoMas(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 max-w-[900px]">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Auditoría</h1>
        <p className="m-0 text-[13px] text-muted-foreground">Qué hizo cada miembro del staff: tarifas, citas canceladas, horarios, lista de espera y staff.</p>
      </header>

      {!puedeLeer ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> pueden leer la bitácora de auditoría — tu rol actual es{" "}
          <strong className="text-foreground">{role}</strong>.
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

          {error && (
            <EstadoError
              mensaje={error}
              onReintentar={() => {
                setError(null);
                setReintento((n) => n + 1);
              }}
            />
          )}

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
                      <TableHead>Quién</TableHead>
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
                        {/* La ruta hoy solo trae el uuid del staff (`actorUserId`, ver
                            auditoria-client.ts) -- sin resolver a nombre/email todavía
                            (mismo hueco conocido que restaurantes/rentas dejaron
                            documentado). Mostrar el uuid completo, con truncamiento
                            visual + title, es mejor que omitir por completo QUIÉN
                            hizo la acción. */}
                        <TableCell className="text-xs font-mono text-muted-foreground max-w-[110px] truncate" title={item.actorUserId}>
                          {item.actorUserId}
                        </TableCell>
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
