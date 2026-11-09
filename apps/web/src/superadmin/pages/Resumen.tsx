// Resumen diario automático -- segunda pieza del "cerebro" de backoffice del
// superadmin, después de Salud operativa (ver Salud.tsx, mismo patrón: sin
// librerías de gráficas/fecha nuevas). Backend real: GET/POST
// /superadmin/resumen[...] (apps/api/src/routes/superadmin-resumen.ts),
// agregador determinista en apps/api/src/resumen-diario/motor.ts (los
// NÚMEROS y ALERTAS son siempre deterministas -- un LLM, si se usó, solo
// redactó la narrativa a partir de esos números ya calculados).
import { useEffect, useState } from "react";
import { AlertTriangle, CircleAlert, CircleCheck, Clock, Mail, RefreshCw, Sparkles } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, PageContainer, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, localeActivo, statusTone, traductorActivo, useT } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { superadminComun } from "@atiende/ui/i18n/superadmin/comun";
import { superadminResumen } from "@atiende/ui/i18n/superadmin/resumen";
import { SEVERIDAD_ALERTA_TONES } from "../lib/status-tones.ts";

// Helpers fuera de React: traducen al idioma activo (la pagina, que usa `useT`, se repinta al cambiarlo).
const tr = traductorActivo(superadminComun, superadminResumen);

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
    throw new Error(body?.message ?? tr("superadmin.comun.error.solicitud"));
  }
  return res.json() as Promise<T>;
}

function moneda(microUsd: number | null): string {
  if (microUsd === null) return tr("superadmin.comun.noDisponible");
  return `$${(microUsd / 1_000_000).toFixed(2)} USD`;
}

function porcentaje(p: number | null): string {
  return p === null ? tr("superadmin.comun.noDisponible") : `${p.toFixed(1)}%`;
}

function fechaLegible(iso: string): string {
  return new Date(`${iso}T12:00:00.000Z`).toLocaleDateString(localeActivo(), { day: "numeric", month: "long", year: "numeric", timeZone: "America/Mexico_City" });
}

function delta(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  if (n === 0) return tr("superadmin.resumen.delta.sinCambio");
  return tr("superadmin.resumen.delta.vsAyer", { n: n > 0 ? `+${n}` : String(n) });
}

/** Severidad de una alerta (enum del servidor): etiqueta traducida; una desconocida se pinta tal cual. */
const SEVERIDADES: readonly SeveridadAlerta[] = ["critica", "alta", "media"];
function etiquetaSeveridad(s: string): string {
  return (SEVERIDADES as readonly string[]).includes(s) ? tr(`superadmin.resumen.severidad.${s}` as Clave) : s;
}

function IconoSemaforo({ alertas }: { readonly alertas: readonly Alerta[] }) {
  if (alertas.length === 0) return <CircleCheck className="w-5 h-5 text-success" strokeWidth={1.75} />;
  if (alertas.some((a) => a.severidad === "critica")) return <CircleAlert className="w-5 h-5 text-destructive" strokeWidth={1.75} />;
  return <AlertTriangle className="w-5 h-5 text-warning" strokeWidth={1.75} />;
}

function BadgeGeneradoPor({ generadoPor }: { readonly generadoPor: GeneradoPor }) {
  const t = useT(superadminResumen);
  return generadoPor === "llm" ? (
    <StatusBadge tone="info" dot={false} className="gap-1">
      <Sparkles className="w-3 h-3" strokeWidth={2} /> {t("superadmin.resumen.generadoLlm")}
    </StatusBadge>
  ) : (
    <StatusBadge tone="neutral" dot={false}>{t("superadmin.resumen.plantilla")}</StatusBadge>
  );
}

function TarjetaResumen({ resumen }: { readonly resumen: Resumen }) {
  const t = useT(superadminComun, superadminResumen);
  const a = resumen.agregados;
  const d = a.deltas;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <IconoSemaforo alertas={a.salud.alertas} />
          <div>
            <h2 className="text-lg font-semibold text-foreground">{fechaLegible(resumen.fecha)}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{t("superadmin.resumen.actualizado", { zona: a.zonaHoraria, fecha: new Date(resumen.actualizadoEn).toLocaleString(localeActivo()) })}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <BadgeGeneradoPor generadoPor={resumen.generadoPor} />
          {resumen.correoEnviadoEn ? (
            <StatusBadge tone="success" dot={false} className="gap-1">
              <Mail className="w-3 h-3" strokeWidth={1.75} /> {t("superadmin.resumen.correoEnviado")}
            </StatusBadge>
          ) : (
            <StatusBadge tone="neutral" dot={false} className="gap-1">
              <Mail className="w-3 h-3" strokeWidth={1.75} /> {t("superadmin.resumen.sinCorreo")}
            </StatusBadge>
          )}
        </div>
      </div>

      <p className="text-sm text-foreground leading-relaxed whitespace-pre-line rounded-lg border border-border bg-muted/30 p-4">{resumen.narrativa}</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("superadmin.resumen.kpi.alertas")}</p>
          <p className="text-lg font-semibold text-foreground">
            {a.salud.alertas.length} <span className="text-xs font-normal text-muted-foreground">{delta(d?.alertasSalud)}</span>
          </p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("superadmin.resumen.kpi.gastoLlm")}</p>
          <p className="text-lg font-semibold text-foreground">{moneda(a.gastoLlm.costoHoyMicroUsd)}</p>
          <p className="text-xs text-muted-foreground">{t("superadmin.resumen.kpi.delTope", { pct: porcentaje(a.gastoLlm.pctTopePlataforma) })}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("superadmin.resumen.kpi.altasFacturacion")}</p>
          <p className="text-lg font-semibold text-foreground">
            {a.facturacion === null ? t("superadmin.comun.noDisponible") : a.facturacion.altas} <span className="text-xs font-normal text-muted-foreground">{delta(d?.facturacionAltas)}</span>
          </p>
          <p className="text-xs text-muted-foreground">{a.facturacion === null ? "" : t("superadmin.resumen.kpi.morosos", { n: String(a.facturacion.morososNuevos) })}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("superadmin.resumen.kpi.prospectos")}</p>
          <p className="text-lg font-semibold text-foreground">
            {a.prospectos === null ? t("superadmin.comun.noDisponible") : a.prospectos.altas} <span className="text-xs font-normal text-muted-foreground">{delta(d?.prospectosAltas)}</span>
          </p>
          <p className="text-xs text-muted-foreground">{a.prospectos === null ? "" : t("superadmin.resumen.kpi.sinMovimiento", { n: String(a.prospectos.sinMovimiento), dias: String(a.prospectos.umbralSinMovimientoDias) })}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("superadmin.resumen.kpi.organizaciones")}</p>
          <p className="text-lg font-semibold text-foreground">
            {a.organizacionesStaff === null ? t("superadmin.comun.noDisponible") : a.organizacionesStaff.organizacionesNuevas} <span className="text-xs font-normal text-muted-foreground">{delta(d?.organizacionesNuevas)}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {a.organizacionesStaff === null
              ? ""
              : `${t("superadmin.resumen.kpi.staffNuevos", { n: String(a.organizacionesStaff.staffNuevos) })}${a.organizacionesStaff.nombresOrganizacionesNuevas.length > 0 ? ` — ${a.organizacionesStaff.nombresOrganizacionesNuevas.join(", ")}` : ""}`}
          </p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("superadmin.resumen.kpi.breakGlass")}</p>
          <p className="text-lg font-semibold text-foreground">{a.breakGlassAbiertos === null ? t("superadmin.comun.noDisponible") : a.breakGlassAbiertos}</p>
        </div>
      </div>

      {a.salud.alertas.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("superadmin.resumen.alertasOperativa")}</p>
          <ul className="flex flex-col gap-2">
            {a.salud.alertas.map((al, i) => (
              <li key={`${al.titulo}-${i}`} className="flex items-start gap-3 rounded-lg border border-border p-3">
                <StatusBadge tone={statusTone(SEVERIDAD_ALERTA_TONES, al.severidad)}>{etiquetaSeveridad(al.severidad)}</StatusBadge>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{al.titulo}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{al.detalle}</p>
                </div>
                <a href={al.href} className="text-xs text-primary shrink-0 hover:underline">
                  {t("superadmin.resumen.ver")}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Contrato API<->web (hallazgo de auditoría del 19-sep, rubro A): la base
// Supabase real todavía NO tiene aplicada la migración del resumen diario --
// `GET /superadmin/resumen`/`GET /superadmin/resumen/:fecha`
// (`apps/api/src/routes/superadmin-resumen.ts`) responden 200 con
// `disponible: false` en ese caso, NUNCA una lista vacía real (que esta
// página ya distinguía como "aún no hay resúmenes") ni un error. `disponible`
// puede faltar en la respuesta (contrato previo a este fix, o un backend
// viejo) -- `?? true` trata su ausencia como "sí disponible", nunca como "no
// disponible" por accidente.
export function SuperAdminResumenPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const t = useT(superadminComun, superadminResumen);
  const [resumenes, setResumenes] = useState<readonly Resumen[] | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [seleccionado, setSeleccionado] = useState<Resumen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [generando, setGenerando] = useState(false);

  async function cargar() {
    setError(null);
    setCargando(true);
    try {
      const r = await fetchJson<{ disponible?: boolean; resumenes: Resumen[] }>(apiBaseUrl, token, "/superadmin/resumen?limit=30");
      setDisponible(r.disponible ?? true);
      setResumenes(r.resumenes);
      setSeleccionado((actual) => actual ?? r.resumenes[0] ?? null);
    } catch {
      setError(t("superadmin.resumen.error.historial"));
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
      setError(t("superadmin.resumen.error.generar"));
    } finally {
      setGenerando(false);
    }
  }

  if (error && !resumenes) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!resumenes) return <EstadoCargando etiqueta={t("superadmin.resumen.cargando")} />;

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t("superadmin.resumen.titulo")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("superadmin.resumen.subtitulo")}</p>
        </div>
        <Button
          type="button"
          onClick={() => void generarAhora()}
          disabled={generando || !disponible}
          title={!disponible ? t("superadmin.resumen.noDisponible") : undefined}
          className="gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${generando ? "animate-spin" : ""}`} strokeWidth={1.75} />
          {generando ? t("superadmin.resumen.generando") : t("superadmin.resumen.generar")}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {!disponible ? (
        <Card className="border-dashed">
          <CardContent className="pt-6">
            <EstadoVacio mensaje={t("superadmin.resumen.noDisponible")} />
          </CardContent>
        </Card>
      ) : resumenes.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="pt-6">
            <EstadoVacio mensaje={t("superadmin.resumen.vacio")} />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="pt-6">{seleccionado && <TarjetaResumen resumen={seleccionado} />}</CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("superadmin.resumen.historial", { n: resumenes.length })}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("superadmin.resumen.col.fecha")}</TableHead>
                      <TableHead>{t("superadmin.resumen.col.generadoPor")}</TableHead>
                      <TableHead>{t("superadmin.resumen.col.alertas")}</TableHead>
                      <TableHead>{t("superadmin.resumen.col.correo")}</TableHead>
                      <TableHead className="flex items-center gap-1">
                        <Clock className="w-3 h-3" strokeWidth={1.75} /> {t("superadmin.resumen.col.actualizado")}
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
                        <TableCell className="text-muted-foreground">{r.correoEnviadoEn ? t("superadmin.resumen.enviado") : t("superadmin.resumen.noEnviado")}</TableCell>
                        <TableCell className="text-muted-foreground">{new Date(r.actualizadoEn).toLocaleString(localeActivo())}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {cargando && <p className="text-xs text-muted-foreground">{t("superadmin.resumen.actualizando")}</p>}
    </PageContainer>
  );
}
