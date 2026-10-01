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
import { useEffect, useRef, useState } from "react";
import { ClipboardList } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer, StatusBadge } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { AUDIT_LOG_ENTITY_TYPE_LABELS, AUDIT_LOG_ENTITY_TYPES, fetchAuditoria } from "../lib/auditoria-client.ts";
import type { AuditLogEntityType, AuditLogEntry } from "../lib/auditoria-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const AUDITORIA_LECTURA_ROLES = new Set(["admin_gestora"]);
const PAGE_SIZE = 25;

const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";

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

/** Columnas de la bitácora. La ruta solo trae el uuid del staff (`actorUserId`, ver auditoria-client.ts) -- sin resolver a
 *  nombre/email todavía (hallazgo de revisión r5, gap conocido). Mostrar el uuid completo, con truncamiento visual + title,
 *  es mejor que omitir por completo QUIÉN hizo la acción en una bitácora de auditoría. */
const COLUMNAS: readonly DataTableColumna<AuditLogEntry>[] = [
  { id: "cuando", encabezado: "Cuándo", celda: (item) => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatearFechaHora(item.creadoEn)}</span>, className: "whitespace-nowrap" },
  {
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
    principal: true,
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
];

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
  // Contador incrementado por "Reintentar" -- entra en las deps del efecto de abajo
  // a propósito, para que reintentar SIEMPRE dispare un fetch nuevo aunque ningún
  // filtro haya cambiado (de lo contrario `onReintentar` solo limpiaba `error` y la
  // pantalla se quedaba en el skeleton de carga para siempre, ver hallazgo de
  // revisión r5).
  const [reintento, setReintento] = useState(0);
  // Generación de la carga vigente: la incrementa el mismo efecto que dispara la
  // carga inicial (por filtro nuevo o reintento), y `cargarMas` la captura al
  // arrancar. Si los filtros cambian mientras una página de "cargar más" sigue en
  // vuelo, la generación capturada queda vieja y esa respuesta se descarta en vez
  // de anexarse a una lista que ya no corresponde a los filtros actuales
  // (hallazgo de revisión r5).
  const generacionRef = useRef(0);

  useEffect(() => {
    if (!puedeLeer) return;
    let cancelado = false;
    generacionRef.current += 1;
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
  }, [apiBaseUrl, token, orgSlug, tipo, desde, hasta, puedeLeer, reintento]);

  async function cargarMas() {
    if (nextOffset === null || cargandoMas) return;
    const generacion = generacionRef.current;
    setCargandoMas(true);
    try {
      const pagina = await fetchAuditoria(fetch, apiBaseUrl, token, orgSlug, { tipo: tipo || null, desde: desde || null, hasta: hasta || null, limit: PAGE_SIZE, offset: nextOffset });
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
      if (generacion === generacionRef.current) setCargandoMas(false);
    }
  }

  return (
    <PageContainer padding="none" size="lg" className="gap-5 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Auditoría</h1>
        <p className="m-0 text-sm text-muted-foreground">Qué hizo cada miembro del staff: cambios de precio, reservas, payouts, estados de cuenta y canales.</p>
      </header>

      {!puedeLeer ? (
        <p className="m-0 text-sm text-muted-foreground">
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
                <NativeSelect value={tipo} onChange={(e) => setTipo(e.target.value as AuditLogEntityType | "")}>
                  <option value="">Todos</option>
                  {AUDIT_LOG_ENTITY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {AUDIT_LOG_ENTITY_TYPE_LABELS[t]}
                    </option>
                  ))}
                </NativeSelect>
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
            <DataTable
              etiqueta="Bitácora de auditoría del staff"
              columnas={COLUMNAS}
              filas={items}
              obtenerId={(item) => item.id}
              paginacion={false}
            />
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
    </PageContainer>
  );
}
