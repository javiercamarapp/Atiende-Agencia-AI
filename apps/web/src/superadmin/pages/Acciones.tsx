// Acciones sugeridas con confirmación + automatizaciones -- TERCERA y
// última pieza del "cerebro" de backoffice del superadmin, después de Salud
// operativa (Salud.tsx) y Resumen diario (Resumen.tsx). Backend real: GET/
// POST /superadmin/acciones/* (apps/api/src/routes/superadmin-acciones.ts).
//
// Principio rector (repetido aquí a propósito): ninguna acción con efecto
// real se ejecuta porque este panel mande un flag -- SIEMPRE crea un intent
// primero (POST .../intents) y exige un SEGUNDO clic explícito
// (.../confirmar, con un AlertDialog que muestra el texto real del efecto)
// para ejecutarlo. Sin librerías nuevas.
import { useCallback, useEffect, useState } from "react";
import { Clock, RefreshCw } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@atiende/ui";

type IntentEstado = "pending" | "executed" | "failed" | "expired" | "cancelled";
type IntentTipo = "reencolar_mensaje_muerto" | "cerrar_prospecto" | "ejecutar_mantenimiento_ahora";

interface Intent {
  readonly id: string;
  readonly tipo: IntentTipo;
  readonly payload: Record<string, unknown>;
  readonly resumen: string;
  readonly estado: IntentEstado;
  readonly creadoEn: string;
  readonly venceEn: string;
  readonly ejecutadoEn: string | null;
  readonly resultado: unknown;
  readonly error: string | null;
}

interface Sugerencia {
  readonly id: string;
  readonly titulo: string;
  readonly detalle: string;
  readonly tipoAccion: "reencolar_mensaje_muerto" | "cerrar_prospecto";
  readonly payloadSugerido: Record<string, unknown>;
}

interface AutomationLog {
  readonly id: string;
  readonly tipo: string;
  readonly tabla: string;
  readonly objetivoId: string;
  readonly ejecutadoEn: string;
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

/** `mm:ss` hasta `venceEn`, o `"vencido"` -- nunca negativo. */
function cuentaRegresiva(venceEn: string, ahoraMs: number): string {
  const restanteMs = new Date(venceEn).getTime() - ahoraMs;
  if (restanteMs <= 0) return "vencido";
  const segundos = Math.floor(restanteMs / 1000);
  const minutos = Math.floor(segundos / 60);
  return `${minutos}:${String(segundos % 60).padStart(2, "0")}`;
}

const TIPO_LABEL: Record<IntentTipo, string> = {
  reencolar_mensaje_muerto: "Reencolar mensaje muerto",
  cerrar_prospecto: "Cerrar prospecto",
  ejecutar_mantenimiento_ahora: "Ejecutar mantenimiento ahora",
};

function BadgeEstado({ estado }: { readonly estado: IntentEstado }) {
  if (estado === "executed") return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">ejecutado</Badge>;
  if (estado === "failed") return <Badge variant="destructive">falló</Badge>;
  if (estado === "expired") return <Badge variant="secondary">vencido</Badge>;
  if (estado === "cancelled") return <Badge variant="outline">cancelado</Badge>;
  return <Badge variant="outline">pendiente</Badge>;
}

export function SuperAdminAccionesPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [sugerencias, setSugerencias] = useState<readonly Sugerencia[] | null>(null);
  const [intents, setIntents] = useState<readonly Intent[] | null>(null);
  const [automatizaciones, setAutomatizaciones] = useState<readonly AutomationLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [creandoId, setCreandoId] = useState<string | null>(null);
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null);
  const [cancelandoId, setCancelandoId] = useState<string | null>(null);
  const [ahoraMs, setAhoraMs] = useState(() => Date.now());

  const cargar = useCallback(async () => {
    setError(null);
    setCargando(true);
    try {
      const [s, i, a] = await Promise.all([
        fetchJson<{ sugerencias: Sugerencia[] }>(apiBaseUrl, token, "/superadmin/acciones/sugerencias"),
        fetchJson<{ intents: Intent[] }>(apiBaseUrl, token, "/superadmin/acciones/intents?limit=100"),
        fetchJson<{ automatizaciones: AutomationLog[] }>(apiBaseUrl, token, "/superadmin/acciones/automatizaciones?limit=100"),
      ]);
      setSugerencias(s.sugerencias);
      setIntents(i.intents);
      setAutomatizaciones(a.automatizaciones);
    } catch {
      setError("No se pudo cargar el panel de acciones.");
    } finally {
      setCargando(false);
    }
  }, [apiBaseUrl, token]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Cuenta regresiva en vivo de los intents pendientes -- solo re-renderiza
  // mientras haya alguno (evita un timer permanente en pantallas sin
  // pendientes).
  useEffect(() => {
    if (!intents || !intents.some((i) => i.estado === "pending")) return;
    const id = setInterval(() => setAhoraMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [intents]);

  async function crearDesdeSugerencia(s: Sugerencia) {
    setCreandoId(s.id);
    try {
      await fetchJson(apiBaseUrl, token, "/superadmin/acciones/intents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tipo: s.tipoAccion, payload: s.payloadSugerido }) });
      toast("Acción creada -- confírmala en 'Pendientes de confirmar'.");
      await cargar();
    } catch (err) {
      toast(err instanceof Error ? err.message : "No se pudo crear la acción.");
    } finally {
      setCreandoId(null);
    }
  }

  async function confirmar(intentId: string) {
    setConfirmandoId(intentId);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/acciones/intents/${intentId}/confirmar`, { method: "POST" });
      toast("Acción confirmada.");
      await cargar();
    } catch (err) {
      toast(err instanceof Error ? err.message : "No se pudo confirmar la acción.");
    } finally {
      setConfirmandoId(null);
    }
  }

  async function cancelar(intentId: string) {
    setCancelandoId(intentId);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/acciones/intents/${intentId}/cancelar`, { method: "POST" });
      toast("Acción cancelada.");
      await cargar();
    } catch (err) {
      toast(err instanceof Error ? err.message : "No se pudo cancelar la acción.");
    } finally {
      setCancelandoId(null);
    }
  }

  if (error && !sugerencias) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!sugerencias || !intents || !automatizaciones) return <EstadoCargando etiqueta="Cargando acciones…" />;

  const pendientes = [...intents].filter((i) => i.estado === "pending").sort((a, b) => a.venceEn.localeCompare(b.venceEn));
  const historial = [...intents].filter((i) => i.estado !== "pending").sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Acciones</h1>
          <p className="text-sm text-muted-foreground mt-1">Sugerencias deterministas, confirmación humana explícita por pieza, todo auditado.</p>
        </div>
        <Button type="button" variant="outline" onClick={() => void cargar()} disabled={cargando} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${cargando ? "animate-spin" : ""}`} strokeWidth={1.75} />
          Actualizar
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      <Tabs defaultValue="sugerencias">
        <TabsList>
          <TabsTrigger value="sugerencias">Sugerencias ({sugerencias.length})</TabsTrigger>
          <TabsTrigger value="pendientes">Pendientes de confirmar ({pendientes.length})</TabsTrigger>
          <TabsTrigger value="bitacora">Bitácora</TabsTrigger>
        </TabsList>

        <TabsContent value="sugerencias" className="flex flex-col gap-3 mt-4">
          {sugerencias.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="pt-6">
                <EstadoVacio mensaje="Sin sugerencias por ahora -- todo tranquilo." />
              </CardContent>
            </Card>
          ) : (
            sugerencias.map((s) => (
              <Card key={s.id}>
                <CardContent className="pt-6 flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">{s.titulo}</p>
                    <p className="text-xs text-muted-foreground mt-1">{s.detalle}</p>
                  </div>
                  <Button type="button" size="sm" onClick={() => void crearDesdeSugerencia(s)} disabled={creandoId === s.id} className="shrink-0">
                    {creandoId === s.id ? "Creando…" : "Crear acción"}
                  </Button>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="pendientes" className="flex flex-col gap-3 mt-4">
          {pendientes.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="pt-6">
                <EstadoVacio mensaje="No hay acciones esperando confirmación." />
              </CardContent>
            </Card>
          ) : (
            pendientes.map((i) => {
              const restante = cuentaRegresiva(i.venceEn, ahoraMs);
              const vencido = restante === "vencido";
              return (
                <Card key={i.id}>
                  <CardContent className="pt-6 flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <Badge variant="outline" className="mb-2">
                          {TIPO_LABEL[i.tipo]}
                        </Badge>
                        <p className="text-sm text-foreground">{i.resumen}</p>
                      </div>
                      <div className={`flex items-center gap-1 text-xs shrink-0 ${vencido ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                        <Clock className="w-3 h-3" strokeWidth={1.75} />
                        {vencido ? "vencido" : `vence en ${restante}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button type="button" size="sm" disabled={confirmandoId === i.id || vencido}>
                            {confirmandoId === i.id ? "Confirmando…" : "Confirmar"}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>¿Confirmar esta acción?</AlertDialogTitle>
                            <AlertDialogDescription>{i.resumen}</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void confirmar(i.id)}>Sí, confirmar</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                      <Button type="button" size="sm" variant="outline" onClick={() => void cancelar(i.id)} disabled={cancelandoId === i.id}>
                        {cancelandoId === i.id ? "Cancelando…" : "Cancelar"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </TabsContent>

        <TabsContent value="bitacora" className="flex flex-col gap-6 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Acciones confirmadas, fallidas, vencidas o canceladas ({historial.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {historial.length === 0 ? (
                <EstadoVacio mensaje="Sin historial todavía." />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tipo</TableHead>
                        <TableHead>Estado</TableHead>
                        <TableHead>Resumen</TableHead>
                        <TableHead>Resultado / error</TableHead>
                        <TableHead>Ejecutado</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {historial.map((i) => (
                        <TableRow key={i.id}>
                          <TableCell className="whitespace-nowrap">{TIPO_LABEL[i.tipo]}</TableCell>
                          <TableCell>
                            <BadgeEstado estado={i.estado} />
                          </TableCell>
                          <TableCell className="max-w-xs truncate" title={i.resumen}>
                            {i.resumen}
                          </TableCell>
                          <TableCell className={`max-w-xs truncate ${i.error ? "text-destructive" : "text-muted-foreground"}`} title={i.error ?? undefined}>
                            {i.error ?? (i.resultado ? "ok" : "--")}
                          </TableCell>
                          <TableCell className="text-muted-foreground whitespace-nowrap">{i.ejecutadoEn ? new Date(i.ejecutadoEn).toLocaleString("es-MX") : "--"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Automatizaciones internas ({automatizaciones.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {automatizaciones.length === 0 ? (
                <EstadoVacio mensaje="Sin automatizaciones registradas todavía -- el cron corre diario, o usa 'Ejecutar mantenimiento ahora' en Sugerencias." />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tipo</TableHead>
                        <TableHead>Tabla</TableHead>
                        <TableHead>Objetivo</TableHead>
                        <TableHead>Cuándo</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {automatizaciones.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell className="whitespace-nowrap">{a.tipo === "outbox_desatascado" ? "Outbox desatascado" : "Prospecto marcado para seguimiento"}</TableCell>
                          <TableCell className="text-muted-foreground">{a.tabla}</TableCell>
                          <TableCell className="text-muted-foreground font-mono text-xs">{a.objetivoId}</TableCell>
                          <TableCell className="text-muted-foreground whitespace-nowrap">{new Date(a.ejecutadoEn).toLocaleString("es-MX")}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
