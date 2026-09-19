// Resumen diario automático -- segunda pieza del "cerebro" de backoffice del
// superadmin, después de Salud operativa (ver Salud.tsx, mismo patrón: sin
// librerías de gráficas/fecha nuevas). Backend real: GET/POST
// /superadmin/resumen[...] (apps/api/src/routes/superadmin-resumen.ts),
// agregador determinista en apps/api/src/resumen-diario/motor.ts (los
// NÚMEROS y ALERTAS son siempre deterministas -- un LLM, si se usó, solo
// redactó la narrativa a partir de esos números ya calculados).
import { useEffect, useState } from "react";
import { AlertTriangle, CircleAlert, CircleCheck, Clock, Mail, RefreshCw, Sparkles } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";

type GeneradoPor = "llm" | "determinista";
type SeveridadAlerta = "critica" | "alta" | "media";

interface Alerta {
  readonly severidad: SeveridadAlerta;
  readonly titulo: string;
  readonly detalle: string;
  readonly href: string;
}

interface DiarioAgregados {
  readonly fecha: string;
  readonly zonaHoraria: string;
  readonly salud: { readonly alertas: readonly Alerta[]; readonly crons: { total: number; ok: number } | null; readonly colas: { muertos: number; pendientes: number } | null };
  readonly gastoLlm: { readonly costoHoyMicroUsd: number | null; readonly pctTopePlataforma: number | null };
  readonly facturacion: { readonly altas: number; readonly bajas: number; readonly morososNuevos: number; readonly activasTotal: number } | null;
  readonly prospectos: { readonly altas: number; readonly cambiosEstado: number; readonly sinMovimiento: number; readonly umbralSinMovimientoDias: number } | null;
  readonly organizacionesStaff: { readonly organizacionesNuevas: number; readonly nombresOrganizacionesNuevas: readonly string[]; readonly staffNuevos: number } | null;
  readonly mensajeria: readonly { readonly queueName: string; readonly enviados: number | null; readonly fallidosHoy: number; readonly muertosHoy: number }[] | null;
  readonly breakGlassAbiertos: number | null;
  readonly deltas: Record<string, number | null> | null;
}

interface Resumen {
  readonly fecha: string;
  readonly agregados: DiarioAgregados;
  readonly narrativa: string;
  readonly generadoPor: GeneradoPor;
  readonly costoLlmMicroUsd: number | null;
  readonly modeloLlm: string | null;
  readonly proveedorLlm: string | null;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
  readonly correoEnviadoEn: string | null;
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

function moneda(microUsd: number | null): string {
  if (microUsd === null) return "no disponible";
  return `$${(microUsd / 1_000_000).toFixed(2)} USD`;
}

function porcentaje(p: number | null): string {
  return p === null ? "no disponible" : `${p.toFixed(1)}%`;
}

function fechaLegible(iso: string): string {
  return new Date(`${iso}T12:00:00.000Z`).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Mexico_City" });
}

function delta(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  if (n === 0) return "(sin cambio vs. ayer)";
  return n > 0 ? `(+${n} vs. ayer)` : `(${n} vs. ayer)`;
}

function IconoSemaforo({ alertas }: { readonly alertas: readonly Alerta[] }) {
  if (alertas.length === 0) return <CircleCheck className="w-5 h-5 text-emerald-600" strokeWidth={1.75} />;
  if (alertas.some((a) => a.severidad === "critica")) return <CircleAlert className="w-5 h-5 text-destructive" strokeWidth={1.75} />;
  return <AlertTriangle className="w-5 h-5 text-amber-500" strokeWidth={1.75} />;
}

function BadgeGeneradoPor({ generadoPor }: { readonly generadoPor: GeneradoPor }) {
  return generadoPor === "llm" ? (
    <Badge className="gap-1 bg-violet-600 text-white hover:bg-violet-600">
      <Sparkles className="w-3 h-3" strokeWidth={2} /> generado por LLM
    </Badge>
  ) : (
    <Badge variant="outline">plantilla determinista</Badge>
  );
}

function TarjetaResumen({ resumen }: { readonly resumen: Resumen }) {
  const a = resumen.agregados;
  const d = a.deltas;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <IconoSemaforo alertas={a.salud.alertas} />
          <div>
            <h2 className="text-lg font-semibold text-foreground">{fechaLegible(resumen.fecha)}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{a.zonaHoraria} · actualizado {new Date(resumen.actualizadoEn).toLocaleString("es-MX")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <BadgeGeneradoPor generadoPor={resumen.generadoPor} />
          {resumen.correoEnviadoEn ? (
            <Badge variant="outline" className="gap-1">
              <Mail className="w-3 h-3" strokeWidth={1.75} /> correo enviado
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Mail className="w-3 h-3" strokeWidth={1.75} /> sin correo
            </Badge>
          )}
        </div>
      </div>

      <p className="text-sm text-foreground leading-relaxed whitespace-pre-line rounded-lg border border-border bg-muted/30 p-4">{resumen.narrativa}</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Alertas de salud</p>
          <p className="text-lg font-semibold text-foreground">
            {a.salud.alertas.length} <span className="text-xs font-normal text-muted-foreground">{delta(d?.alertasSalud)}</span>
          </p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Gasto de LLM hoy</p>
          <p className="text-lg font-semibold text-foreground">{moneda(a.gastoLlm.costoHoyMicroUsd)}</p>
          <p className="text-[11px] text-muted-foreground">{porcentaje(a.gastoLlm.pctTopePlataforma)} del tope de plataforma</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Altas de facturación</p>
          <p className="text-lg font-semibold text-foreground">
            {a.facturacion === null ? "no disponible" : a.facturacion.altas} <span className="text-xs font-normal text-muted-foreground">{delta(d?.facturacionAltas)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">{a.facturacion === null ? "" : `${a.facturacion.morososNuevos} moroso(s) nuevo(s)`}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Prospectos nuevos</p>
          <p className="text-lg font-semibold text-foreground">
            {a.prospectos === null ? "no disponible" : a.prospectos.altas} <span className="text-xs font-normal text-muted-foreground">{delta(d?.prospectosAltas)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">{a.prospectos === null ? "" : `${a.prospectos.sinMovimiento} sin movimiento > ${a.prospectos.umbralSinMovimientoDias} d`}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Organizaciones nuevas</p>
          <p className="text-lg font-semibold text-foreground">
            {a.organizacionesStaff === null ? "no disponible" : a.organizacionesStaff.organizacionesNuevas} <span className="text-xs font-normal text-muted-foreground">{delta(d?.organizacionesNuevas)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            {a.organizacionesStaff === null
              ? ""
              : `${a.organizacionesStaff.staffNuevos} staff nuevo(s)${a.organizacionesStaff.nombresOrganizacionesNuevas.length > 0 ? ` — ${a.organizacionesStaff.nombresOrganizacionesNuevas.join(", ")}` : ""}`}
          </p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Break-glass abiertos</p>
          <p className="text-lg font-semibold text-foreground">{a.breakGlassAbiertos === null ? "no disponible" : a.breakGlassAbiertos}</p>
        </div>
      </div>

      {a.salud.alertas.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Alertas de salud operativa</p>
          <ul className="flex flex-col gap-2">
            {a.salud.alertas.map((al, i) => (
              <li key={`${al.titulo}-${i}`} className="flex items-start gap-3 rounded-lg border border-border p-3">
                <Badge variant={al.severidad === "critica" ? "destructive" : "secondary"} className={al.severidad === "alta" ? "bg-amber-500 text-white hover:bg-amber-500" : ""}>
                  {al.severidad}
                </Badge>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{al.titulo}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{al.detalle}</p>
                </div>
                <a href={al.href} className="text-xs text-primary shrink-0 hover:underline">
                  ver
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function SuperAdminResumenPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [resumenes, setResumenes] = useState<readonly Resumen[] | null>(null);
  const [seleccionado, setSeleccionado] = useState<Resumen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [generando, setGenerando] = useState(false);

  async function cargar() {
    setError(null);
    setCargando(true);
    try {
      const r = await fetchJson<{ resumenes: Resumen[] }>(apiBaseUrl, token, "/superadmin/resumen?limit=30");
      setResumenes(r.resumenes);
      setSeleccionado((actual) => actual ?? r.resumenes[0] ?? null);
    } catch {
      setError("No se pudo cargar el historial de resúmenes.");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  async function generarAhora() {
    setError(null);
    setGenerando(true);
    try {
      await fetchJson(apiBaseUrl, token, "/superadmin/resumen/generar", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setSeleccionado(null);
      await cargar();
    } catch {
      setError("No se pudo generar el resumen ahora.");
    } finally {
      setGenerando(false);
    }
  }

  if (error && !resumenes) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!resumenes) return <EstadoCargando etiqueta="Cargando resumen diario…" />;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Resumen diario</h1>
          <p className="text-sm text-muted-foreground mt-1">Un minuto para saber cómo amaneció la plataforma — informativo, no ejecuta ninguna acción.</p>
        </div>
        <Button type="button" onClick={() => void generarAhora()} disabled={generando} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${generando ? "animate-spin" : ""}`} strokeWidth={1.75} />
          {generando ? "Generando…" : "Generar ahora"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      {resumenes.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="pt-6">
            <EstadoVacio mensaje="Aún no hay resúmenes: el primero se genera con el cron diario o con el botón 'Generar ahora'." />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="pt-6">{seleccionado && <TarjetaResumen resumen={seleccionado} />}</CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Historial ({resumenes.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fecha</TableHead>
                      <TableHead>Generado por</TableHead>
                      <TableHead>Alertas</TableHead>
                      <TableHead>Correo</TableHead>
                      <TableHead className="flex items-center gap-1">
                        <Clock className="w-3 h-3" strokeWidth={1.75} /> Actualizado
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {resumenes.map((r) => (
                      <TableRow key={r.fecha} className={`cursor-pointer ${seleccionado?.fecha === r.fecha ? "bg-muted/50" : ""}`} onClick={() => setSeleccionado(r)}>
                        <TableCell className="font-medium text-foreground">{r.fecha}</TableCell>
                        <TableCell>
                          <BadgeGeneradoPor generadoPor={r.generadoPor} />
                        </TableCell>
                        <TableCell className={r.agregados.salud.alertas.length > 0 ? "text-destructive font-medium" : "text-muted-foreground"}>{r.agregados.salud.alertas.length}</TableCell>
                        <TableCell className="text-muted-foreground">{r.correoEnviadoEn ? "enviado" : "no enviado"}</TableCell>
                        <TableCell className="text-muted-foreground">{new Date(r.actualizadoEn).toLocaleString("es-MX")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {cargando && <p className="text-xs text-muted-foreground">Actualizando…</p>}
    </div>
  );
}
