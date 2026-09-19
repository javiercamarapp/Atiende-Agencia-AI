// Back office de plataforma — estado de integraciones externas, consultable en
// vivo. Backend real: GET /superadmin/integraciones (ya existente en main, ver
// apps/api/src/routes/superadmin-integraciones.ts + apps/api/src/integrations-status.ts).
// Esta pantalla es SOLO lectura -- el backend jamás expone un valor de secreto,
// solo `{ id, nombre, configurada, faltantes: string[], habilita }` por
// integración -- así que el frontend tampoco puede inventar ni mostrar nada más
// que eso. Mismo patrón exacto de sesión/fetch/estados que GastoApi.tsx
// (fetch directo con Bearer, sin cliente separado, EstadoCargando/EstadoError/
// EstadoVacio de @atiende/ui, botón "Actualizar" mismo criterio que
// verticals/restaurantes/pages/Dashboard.tsx).
//
// El backend NO manda ningún campo estructurado que distinga "secreto propio
// obligatorio para arrancar la API" del resto (ver integrations-status.ts:
// STARTUP_REQUIRED_ENV_VARS existe ahí pero nunca viaja en la respuesta HTTP) --
// por disciplina de "nunca inventar dato que el backend no trae", esta pantalla
// NO agrega ese distintivo visual. El texto de `habilita` (que sí describe en
// prosa cuándo algo bloquea el arranque) se muestra tal cual, íntegro.
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, PlugZap, RefreshCw } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, StatCard } from "@atiende/ui";

interface Integracion {
  readonly id: string;
  readonly nombre: string;
  readonly configurada: boolean;
  readonly faltantes: readonly string[];
  readonly habilita: string;
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

function TarjetaIntegracion({ integracion }: { readonly integracion: Integracion }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <CardTitle className="text-base">{integracion.nombre}</CardTitle>
        {integracion.configurada ? (
          <Badge className="shrink-0">Configurada</Badge>
        ) : (
          <Badge variant="secondary" className="shrink-0">
            Falta configurar
          </Badge>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{integracion.habilita}</p>
        {integracion.faltantes.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg bg-muted px-3 py-2.5">
            <p className="text-xs font-medium text-foreground">Variables de entorno faltantes</p>
            <div className="flex flex-wrap gap-1.5">
              {integracion.faltantes.map((nombre) => (
                <code key={nombre} className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground border border-border">
                  {nombre}
                </code>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Se pegan como variables de entorno del despliegue (nunca aquí) — ver <code className="font-mono">docs/CREDENCIALES.md</code> para cómo generarlas u obtenerlas.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SuperAdminIntegracionesPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [integraciones, setIntegraciones] = useState<readonly Integracion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function cargar() {
    setError(null);
    setCargando(true);
    try {
      const body = await fetchJson<{ integraciones: Integracion[] }>(apiBaseUrl, token, "/superadmin/integraciones");
      setIntegraciones(body.integraciones);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el estado de las integraciones.");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  if (error && !integraciones) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!integraciones) return <EstadoCargando etiqueta="Cargando estado de integraciones…" />;

  const listas = integraciones.filter((i) => i.configurada);
  const faltantes = integraciones.filter((i) => !i.configurada);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Integraciones</h1>
          <p className="text-sm text-muted-foreground mt-1">Qué está listo y qué falta pegar en el ambiente de despliegue — nunca se muestra un valor de secreto, solo nombres de variable.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void cargar()} disabled={cargando}>
          <RefreshCw className={cargando ? "animate-spin" : undefined} />
          {cargando ? "Actualizando…" : "Actualizar"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <StatCard icon={PlugZap} label="Integraciones configuradas" value={`${listas.length} de ${integraciones.length}`} />
        <StatCard icon={AlertTriangle} label="Falta pegar credenciales" value={String(faltantes.length)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
            Listas
          </CardTitle>
        </CardHeader>
        <CardContent>
          {listas.length === 0 ? (
            <EstadoVacio mensaje="Todavía ninguna integración está completamente configurada en este ambiente." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {listas.map((i) => (
                <TarjetaIntegracion key={i.id} integracion={i} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
            Falta pegar credenciales
          </CardTitle>
        </CardHeader>
        <CardContent>
          {faltantes.length === 0 ? (
            <EstadoVacio icon={CheckCircle2} titulo="Todo configurado" mensaje="Todas las integraciones de este inventario están completas en este ambiente." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {faltantes.map((i) => (
                <TarjetaIntegracion key={i.id} integracion={i} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
