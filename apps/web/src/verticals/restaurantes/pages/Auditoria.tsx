// FASE 3 (producto) — Bitácora de auditoría del staff: restaurantes no tenía
// ninguna pantalla que mostrara qué hizo cada miembro del staff (cambios de
// precio/disponibilidad, promociones, cancelación de pedidos, asignación de
// repartidor, invitación/baja/cambio de rol de staff). Copiado del patrón ya en
// `main` para rentas (apps/web/src/verticals/rentas/pages/Auditoria.tsx, PR #165/
// #173) — ver apps/api/src/routes/verticals/restaurantes/auditoria.ts.
//
// Solo lectura, gateada por rol en AMBOS lados -- el servidor SIEMPRE re-valida
// (403 si el rol no es owner/admin), este gate es solo UX. A diferencia de
// rentas (que resuelve el rol desde `session.organizations`), este Shell YA trae
// `role` resuelto en el contexto (ver RestaurantesShell.tsx).
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
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, DataTable, Input, Label, Selector, PageContainer, StatusBadge } from "@atiende/ui";
import { AUDIT_LOG_ENTITY_TYPE_LABELS, AUDIT_LOG_ENTITY_TYPES, fetchAuditoria } from "../lib/auditoria-client.ts";
import type { AuditLogEntityType, AuditLogEntry } from "../lib/auditoria-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const AUDITORIA_LECTURA_ROLES = new Set(["owner", "admin"]);
const PAGE_SIZE = 25;

const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";

function formatearFechaHora(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

/** Texto corto de la acción, ej. "producto.precio_actualizado" -> "precio
 *  actualizado" -- puramente cosmético, la fuente de verdad sigue siendo `action`
 *  completo (visible en el título de la fila para quien necesite el valor exacto). */
function etiquetaAccion(action: string): string {
  const partes = action.split(".");
  return (partes.length > 1 ? partes.slice(1) : partes).join(" ").replace(/_/g, " ");
}

export function AuditoriaPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
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
  // filtro haya cambiado (mismo hallazgo de revisión que cerró rentas: si solo se
  // limpia `error`, la pantalla se queda en el skeleton de carga para siempre).
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
      // Incondicional (a diferencia de una versión anterior de este mismo patrón
      // en rentas, que lo dejaba pegado en `true` si la generación cambiaba
      // mientras esta página seguía en vuelo -- regresión detectada en revisión
      // r5 ronda 2 de rentas): sin importar si esta respuesta sigue vigente o
      // ya se descartó arriba, el botón "Cargar más" debe volver a quedar
      // disponible para la carga (nueva o vieja) que sí esté vigente.
      setCargandoMas(false);
    }
  }

  return (
    <PageContainer padding="none">
      <header>
        <h1 className="sr-only">Auditoría</h1>
        <p className="m-0 text-ui text-muted-foreground">Qué hizo cada miembro del staff: precios, promociones, pedidos cancelados, repartidor y staff.</p>
      </header>

      {!puedeLeer ? (
        <Callout tone="info">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> pueden leer la bitácora de auditoría — tu rol actual es{" "}
          <strong className="text-foreground">{role}</strong>.
        </Callout>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Filtros</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-4">
              <Label className={`${LABEL_CLASES} min-w-[180px]`}>
                Tipo de acción
                <Selector value={tipo} onChange={(e) => setTipo(e.target.value as AuditLogEntityType | "")}>
                  <option value="">Todos</option>
                  {AUDIT_LOG_ENTITY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {AUDIT_LOG_ENTITY_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Selector>
              </Label>
              <Label className={`${LABEL_CLASES} min-w-[160px]`}>
                Desde
                <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
              </Label>
              <Label className={`${LABEL_CLASES} min-w-[160px]`}>
                Hasta
                <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
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
              <CardHeader className="p-3 pb-2">
                <CardTitle>Acciones del staff</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <DataTable<AuditLogEntry>
                  etiqueta="Acciones del staff de esta sucursal"
                  filas={items}
                  obtenerId={(item) => item.id}
                  paginacion={false}
                  columnas={[
                    {
                      id: "cuando",
                      encabezado: "Cuándo",
                      principal: true,
                      className: "whitespace-nowrap",
                      celda: (item) => <span className="text-xs text-muted-foreground">{formatearFechaHora(item.creadoEn)}</span>,
                    },
                    {
                      // La ruta hoy solo trae el uuid del staff (`actorUserId`, ver auditoria-client.ts) -- sin resolver a nombre/email
                      // todavía (mismo hueco conocido que rentas dejó documentado). Mostrar el uuid completo, con truncamiento
                      // visual + title, es mejor que omitir por completo QUIÉN hizo la acción.
                      id: "quien",
                      encabezado: "Quién",
                      celda: (item) => (
                        <span className="block max-w-[110px] truncate font-mono text-xs text-muted-foreground" title={item.actorUserId}>
                          {item.actorUserId}
                        </span>
                      ),
                    },
                    {
                      id: "accion",
                      encabezado: "Acción",
                      celda: (item) => (
                        <div className="flex flex-col gap-1">
                          <StatusBadge tone="neutral" dot={false} className="w-fit text-2xs">
                            {AUDIT_LOG_ENTITY_TYPE_LABELS[item.entityType as AuditLogEntityType] ?? item.entityType}
                          </StatusBadge>
                          <span className="text-xs text-muted-foreground" title={item.action}>
                            {etiquetaAccion(item.action)}
                          </span>
                        </div>
                      ),
                    },
                    { id: "campo", encabezado: "Campo", celda: (item) => <span className="text-xs">{item.campo ?? "—"}</span> },
                    { id: "antes", encabezado: "Antes", celda: (item) => <span className="text-xs text-muted-foreground">{item.antes ?? "—"}</span> },
                    { id: "despues", encabezado: "Después", celda: (item) => <span className="text-xs">{item.despues ?? "—"}</span> },
                  ]}
                />
              </CardContent>
            </Card>
          )}

          {!error && items !== null && disponible && items.length > 0 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {items.length} de {total}
              </span>
              {nextOffset !== null && (
                <Button type="button" variant="outline" size="sm" onClick={cargarMas} loading={cargandoMas}>
                  Cargar más
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
