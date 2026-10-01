// C-02 -- Privacidad: seguimiento de solicitudes de derechos ARCO que los clientes
// abren por WhatsApp (ver apps/api/src/routes/verticals/citas/privacidad.ts y
// packages/domain-citas/src/arco-intent.ts). Solo owner/admin (el servidor
// revalida con 403; este gate es UX). Documentación operativa, no asesoría legal.
import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, Label, SolicitudesArcoPanel, SOLICITUD_ARCO_DERECHO_LABEL, SOLICITUD_ARCO_ESTADO_LABEL, NativeSelect } from "@atiende/ui";
import type { SolicitudArcoAccion, SolicitudArcoDerecho, SolicitudArcoEstado, SolicitudArcoVista } from "@atiende/ui";
import { actualizarEstadoSolicitudArco, fetchSolicitudesArco } from "../lib/privacidad-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const PRIVACIDAD_ROLES = new Set(["owner", "admin"]);
const PAGE_SIZE = 25;
const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";

export function PrivacidadPage({ apiBaseUrl, token, propertyId, role }: CitasShellContext) {
  const puedeLeer = PRIVACIDAD_ROLES.has(role);
  const [estado, setEstado] = useState<SolicitudArcoEstado | "">("");
  const [derecho, setDerecho] = useState<SolicitudArcoDerecho | "">("");
  const [items, setItems] = useState<readonly SolicitudArcoVista[] | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [plazos, setPlazos] = useState({ respuestaDias: 20, ejecucionDias: 15 });
  const [error, setError] = useState<string | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [reintento, setReintento] = useState(0);
  // Misma protección de "cargar más" que Auditoria.tsx: una respuesta vieja nunca se
  // anexa a una lista que ya no corresponde a los filtros vigentes.
  const generacionRef = useRef(0);

  useEffect(() => {
    if (!puedeLeer) return;
    let cancelado = false;
    generacionRef.current += 1;
    setItems(null);
    setError(null);
    (async () => {
      try {
        const pagina = await fetchSolicitudesArco(fetch, apiBaseUrl, token, propertyId, { estado: estado || null, derecho: derecho || null, limit: PAGE_SIZE, offset: 0 });
        if (cancelado) return;
        setDisponible(pagina.disponible);
        setItems(pagina.items);
        setTotal(pagina.total);
        setNextOffset(pagina.nextOffset);
        setPlazos(pagina.plazos);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las solicitudes ARCO.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, estado, derecho, puedeLeer, reintento]);

  async function cargarMas() {
    if (nextOffset === null || cargandoMas) return;
    const generacion = generacionRef.current;
    setCargandoMas(true);
    try {
      const pagina = await fetchSolicitudesArco(fetch, apiBaseUrl, token, propertyId, { estado: estado || null, derecho: derecho || null, limit: PAGE_SIZE, offset: nextOffset });
      if (generacion !== generacionRef.current) return;
      setItems((current) => [...(current ?? []), ...pagina.items]);
      setNextOffset(pagina.nextOffset);
    } catch (err) {
      if (generacion === generacionRef.current) setError(err instanceof Error ? err.message : "No se pudo cargar más.");
    } finally {
      setCargandoMas(false);
    }
  }

  async function cambiarEstado(id: string, accion: SolicitudArcoAccion, nota: string | null) {
    // El error se propaga al panel (que lo muestra junto a la fila), no a esta pantalla.
    await actualizarEstadoSolicitudArco(fetch, apiBaseUrl, token, propertyId, id, accion, nota);
    // Recarga completa: el estado de vencimiento y la nota los calcula el servidor.
    setReintento((n) => n + 1);
  }

  return (
    <div className="flex flex-col gap-5 max-w-[1000px]">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Privacidad</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Solicitudes de derechos ARCO (acceso, rectificación, cancelación y oposición) que tus clientes abren por WhatsApp. El agente solo atiende al titular desde su propio número y nunca comparte datos por chat: tú los entregas tras verificar su identidad.
        </p>
        <p className="m-0 mt-1 text-xs text-muted-foreground">Los plazos son una referencia operativa, no asesoría legal: valida tu aviso de privacidad y tu procedimiento con tu asesor jurídico.</p>
      </header>

      {!puedeLeer ? (
        <p className="m-0 text-sm text-muted-foreground">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> pueden ver las solicitudes ARCO — tu rol actual es <strong className="text-foreground">{role}</strong>.
        </p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Filtros</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-4">
              <Label className={`${LABEL_CLASES} min-w-[200px]`}>
                Estado
                <NativeSelect value={estado} onChange={(e) => setEstado(e.target.value as SolicitudArcoEstado | "")}>
                  <option value="">Todos</option>
                  {(Object.keys(SOLICITUD_ARCO_ESTADO_LABEL) as SolicitudArcoEstado[]).map((e) => (
                    <option key={e} value={e}>
                      {SOLICITUD_ARCO_ESTADO_LABEL[e]}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
              <Label className={`${LABEL_CLASES} min-w-[180px]`}>
                Derecho
                <NativeSelect value={derecho} onChange={(e) => setDerecho(e.target.value as SolicitudArcoDerecho | "")}>
                  <option value="">Todos</option>
                  {(Object.keys(SOLICITUD_ARCO_DERECHO_LABEL) as SolicitudArcoDerecho[]).map((d) => (
                    <option key={d} value={d}>
                      {SOLICITUD_ARCO_DERECHO_LABEL[d]}
                    </option>
                  ))}
                </NativeSelect>
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
          {!error && items !== null && (
            <SolicitudesArcoPanel solicitudes={items} disponible={disponible} puedeGestionar respuestaDias={plazos.respuestaDias} ejecucionDias={plazos.ejecucionDias} onCambiarEstado={cambiarEstado} />
          )}
          {!error && items !== null && disponible && items.length > 0 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" />
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
