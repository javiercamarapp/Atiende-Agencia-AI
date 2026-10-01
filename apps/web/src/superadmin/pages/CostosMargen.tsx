// Costo por evento por organizacion, margen y alertas de tope (SA-02, estilo CFO:
// costo, ingreso, margen, riesgo). Backend real: GET /superadmin/costos/resumen y
// afines (apps/api/src/routes/superadmin-costos.ts, ver docs/SUPERADMIN_COSTOS_PLANES.md).
//
// REGLA DE LA CASA: nunca una cifra inventada. Sin tipo de cambio el costo en MXN y el
// margen se muestran como "—" con su razon; sin plan o con plan sin precio, el ingreso
// se muestra como "—" con su razon. El costo en USD siempre se muestra.
import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Coins, Percent, TrendingUp, Wallet } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, StatCard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, formatMoney } from "@atiende/ui";
import { ModalFormularioLateral } from "../../components/ModalFormularioLateral.tsx";
import { fetchConStepUp } from "../lib/stepup.ts";

type Riesgo = "alto" | "medio" | "bajo" | "desconocido";

interface Alerta {
  readonly codigo: string;
  readonly severidad: "alta" | "media" | "info";
  readonly mensaje: string;
}

interface Consumo {
  readonly metrica: string;
  readonly limite: number;
  readonly accion: string;
  readonly uso: number | null;
  readonly pct: number | null;
  readonly estado: "ok" | "aviso" | "excedido" | "sin_dato";
  readonly aplicadoPorSistema: boolean;
}

interface Fila {
  readonly organizationId: string;
  readonly nombre: string;
  readonly slug: string;
  readonly vertical: string;
  readonly planId: string | null;
  readonly planNombre: string | null;
  readonly costoMicroUsd: { readonly llm: number; readonly voz: number; readonly whatsapp: number; readonly telefonia: number; readonly otros: number; readonly total: number };
  readonly costoUsd: number;
  readonly costoMxn: number | null;
  readonly eventosTotal: number;
  readonly eventosEstimados: number;
  readonly ingresoMxn: number | null;
  readonly ingresoRazon: "sin_plan" | "precio_no_configurado" | null;
  readonly margenMxn: number | null;
  readonly margenPct: number | null;
  readonly llmUsoPct: number;
  readonly consumo: readonly Consumo[];
  readonly alertas: readonly Alerta[];
  readonly riesgo: Riesgo;
}

interface Resumen {
  readonly organizaciones: number;
  readonly costoUsd: number;
  readonly costoMxn: number | null;
  readonly ingresoMxn: number;
  readonly organizacionesSinIngreso: number;
  readonly margenMxn: number | null;
  readonly margenPct: number | null;
  readonly enRiesgoAlto: number;
  readonly enRiesgoMedio: number;
}

interface Respuesta {
  readonly disponible: boolean;
  readonly mes: string;
  readonly mensaje?: string;
  readonly tipoCambio: { readonly fecha: string; readonly mxnPorUsd: number; readonly fuente: string } | null;
  readonly umbralMargenPct: number;
  readonly resumen: Resumen | null;
  readonly organizaciones: readonly Fila[];
  readonly supuestos: readonly string[];
}

interface Evento {
  readonly id: string;
  readonly ocurrioEnMs: number;
  readonly categoria: string;
  readonly proveedor: string;
  readonly unidad: string;
  readonly cantidad: number;
  readonly costoMicroUsd: number;
  readonly costoEstimado: boolean;
}

const ETIQUETA_METRICA: Record<string, string> = {
  llm_costo_micro_usd_mes: "Costo de LLM",
  minutos_voz_mes: "Minutos de voz",
  mensajes_mes: "Mensajes",
  sucursales: "Sucursales",
  asientos: "Asientos",
};

const mxn = (n: number | null) => (n === null ? "—" : `$${formatMoney(n)}`);
const usd = (micro: number) => `US$${formatMoney(micro / 1_000_000)}`;

function mesActual(): string {
  return new Date().toISOString().slice(0, 7);
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

function badgeRiesgo(r: Riesgo) {
  if (r === "alto") return <Badge variant="destructive">Riesgo alto</Badge>;
  if (r === "medio") return <Badge variant="secondary">Riesgo medio</Badge>;
  if (r === "bajo") return <Badge>Sano</Badge>;
  return <Badge variant="outline">Sin datos</Badge>;
}

function textoIngreso(f: Fila): string {
  if (f.ingresoMxn !== null) return mxn(f.ingresoMxn);
  return f.ingresoRazon === "sin_plan" ? "— sin plan asignado" : "— plan sin precio";
}

export function SuperAdminCostosMargenPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [mes, setMes] = useState(mesActual());
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [fxAbierto, setFxAbierto] = useState(false);
  const [fxFecha, setFxFecha] = useState(new Date().toISOString().slice(0, 10));
  const [fxValor, setFxValor] = useState("");
  const [fxFuente, setFxFuente] = useState("");
  const [fxError, setFxError] = useState<string | null>(null);
  const [fxEnviando, setFxEnviando] = useState(false);

  const [detalle, setDetalle] = useState<Fila | null>(null);
  const [eventos, setEventos] = useState<readonly Evento[] | null>(null);
  const [eventosError, setEventosError] = useState<string | null>(null);

  async function cargar() {
    setError(null);
    try {
      setDatos(await fetchJson<Respuesta>(apiBaseUrl, token, `/superadmin/costos/resumen?mes=${encodeURIComponent(mes)}`));
    } catch {
      setError("No se pudo cargar el reporte de costos.");
    }
  }

  useEffect(() => {
    setDatos(null);
    void cargar();
  }, [apiBaseUrl, token, mes]);

  async function abrirDetalle(f: Fila) {
    setDetalle(f);
    setEventos(null);
    setEventosError(null);
    try {
      const r = await fetchJson<{ eventos: Evento[] }>(apiBaseUrl, token, `/superadmin/costos/organizaciones/${f.organizationId}/eventos?limit=100`);
      setEventos(r.eventos);
    } catch {
      setEventosError("No se pudieron cargar los eventos.");
    }
  }

  async function guardarFx(e: FormEvent) {
    e.preventDefault();
    const valor = Number(fxValor);
    if (!Number.isFinite(valor) || valor <= 0 || valor >= 1000) {
      setFxError("Indica un tipo de cambio mayor a 0 (MXN por 1 USD).");
      return;
    }
    if (fxFuente.trim().length < 3) {
      setFxError("Indica la fuente del dato (por ejemplo, Banxico FIX).");
      return;
    }
    setFxEnviando(true);
    setFxError(null);
    try {
      await fetchJson(apiBaseUrl, token, "/superadmin/costos/tipo-cambio", { method: "PUT", body: JSON.stringify({ fecha: fxFecha, mxnPorUsd: valor, fuente: fxFuente.trim() }) });
      setFxAbierto(false);
      setAviso("Tipo de cambio guardado.");
      await cargar();
    } catch (err) {
      setFxError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setFxEnviando(false);
    }
  }

  if (error && !datos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!datos) return <EstadoCargando etiqueta="Calculando costos y margen…" />;

  const r = datos.resumen;
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <Coins className="w-5 h-5" strokeWidth={1.75} />
            Costos y margen por organización
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Costo de LLM, voz, WhatsApp y telefonía contra el ingreso esperado de su plan. Las cifras sin dato se muestran como «—», nunca como cero.</p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="costos-mes">Mes</Label>
            <Input id="costos-mes" type="month" value={mes} max={mesActual()} onChange={(e) => e.target.value && setMes(e.target.value)} />
          </div>
          {datos.disponible && (
            <Button variant="outline" className="rounded-full" onClick={() => setFxAbierto(true)}>
              Capturar tipo de cambio
            </Button>
          )}
        </div>
      </div>

      {!datos.disponible && (
        <p role="alert" className="text-[13px] text-muted-foreground">
          El costo por evento todavía no está disponible en esta base (migración 0028 pendiente de aplicar).
        </p>
      )}
      {aviso && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {aviso}
        </p>
      )}

      {datos.disponible && r && (
        <>
          {datos.tipoCambio === null && (
            <p role="alert" className="text-[13px] flex items-center gap-1.5 text-muted-foreground">
              <AlertTriangle className="w-3.5 h-3.5" strokeWidth={1.75} />
              No hay tipo de cambio configurado: el costo en pesos y el margen no se calculan hasta capturar uno.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={TrendingUp} label="Ingreso esperado" value={mxn(r.ingresoMxn)} nota={r.organizacionesSinIngreso > 0 ? `${r.organizacionesSinIngreso} organización(es) sin precio conocido` : "según el plan de cada organización"} />
            <StatCard icon={Wallet} label="Costo del mes" value={r.costoMxn === null ? `US$${formatMoney(r.costoUsd)}` : mxn(r.costoMxn)} nota={r.costoMxn === null ? "en USD: falta tipo de cambio" : `US$${formatMoney(r.costoUsd)}`} />
            <StatCard icon={Percent} label="Margen" value={r.margenPct === null ? "—" : `${r.margenPct.toFixed(1)}%`} nota={r.margenMxn === null ? undefined : mxn(r.margenMxn)} sinDato={r.margenPct === null ? "Falta tipo de cambio o plan con precio" : undefined} />
            <StatCard icon={AlertTriangle} label="En riesgo" value={String(r.enRiesgoAlto + r.enRiesgoMedio)} nota={`${r.enRiesgoAlto} alto · ${r.enRiesgoMedio} medio · umbral de margen ${datos.umbralMargenPct}%`} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Por organización — {datos.mes}</CardTitle>
            </CardHeader>
            <CardContent>
              {datos.organizaciones.length === 0 ? (
                <EstadoVacio mensaje="Todavía no hay organizaciones." />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Organización</TableHead>
                        <TableHead>Costo (LLM · voz · WhatsApp · telefonía · otros)</TableHead>
                        <TableHead>Costo total</TableHead>
                        <TableHead>Ingreso</TableHead>
                        <TableHead>Margen</TableHead>
                        <TableHead>Riesgo y alertas</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {datos.organizaciones.map((f) => (
                        <TableRow key={f.organizationId}>
                          <TableCell>
                            <span className="font-medium">{f.nombre}</span>
                            <div className="text-xs text-muted-foreground">
                              {f.vertical} · {f.planNombre ?? "sin plan"}
                            </div>
                          </TableCell>
                          <TableCell className="text-[13px] text-muted-foreground">
                            {usd(f.costoMicroUsd.llm)} · {usd(f.costoMicroUsd.voz)} · {usd(f.costoMicroUsd.whatsapp)} · {usd(f.costoMicroUsd.telefonia)} · {usd(f.costoMicroUsd.otros)}
                            {f.eventosEstimados > 0 && <div className="text-xs">{f.eventosEstimados} de {f.eventosTotal} eventos con costo estimado</div>}
                          </TableCell>
                          <TableCell>{f.costoMxn === null ? usd(f.costoMicroUsd.total) : `${mxn(f.costoMxn)} (${usd(f.costoMicroUsd.total)})`}</TableCell>
                          <TableCell className={f.ingresoMxn === null ? "text-muted-foreground" : ""}>{textoIngreso(f)}</TableCell>
                          <TableCell>{f.margenPct === null ? <span className="text-muted-foreground">—</span> : `${f.margenPct.toFixed(1)}% (${mxn(f.margenMxn)})`}</TableCell>
                          <TableCell>
                            {badgeRiesgo(f.riesgo)}
                            {f.alertas.length > 0 && (
                              <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                                {f.alertas.map((a) => (
                                  <li key={a.codigo + a.mensaje}>{a.mensaje}</li>
                                ))}
                              </ul>
                            )}
                          </TableCell>
                          <TableCell>
                            <Button variant="outline" size="sm" onClick={() => void abrirDetalle(f)}>
                              Detalle
                            </Button>
                          </TableCell>
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
              <CardTitle>Supuestos de este reporte</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc pl-5 text-[13px] text-muted-foreground flex flex-col gap-1">
                {datos.supuestos.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}

      <ModalFormularioLateral
        open={fxAbierto}
        onOpenChange={setFxAbierto}
        titulo="Tipo de cambio"
        subtitulo="MXN por 1 USD, con fecha y fuente. Lo piden las cifras en pesos del reporte."
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setFxAbierto(false)} disabled={fxEnviando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-fx" className="rounded-full px-6" disabled={fxEnviando}>
              {fxEnviando ? "Guardando…" : "Guardar"}
            </Button>
          </>
        }
      >
        <form id="form-fx" onSubmit={guardarFx} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fx-fecha">Fecha</Label>
            <Input id="fx-fecha" type="date" value={fxFecha} onChange={(e) => setFxFecha(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fx-valor">MXN por USD</Label>
            <Input id="fx-valor" inputMode="decimal" value={fxValor} onChange={(e) => setFxValor(e.target.value)} placeholder="18.25" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fx-fuente">Fuente</Label>
            <Input id="fx-fuente" value={fxFuente} onChange={(e) => setFxFuente(e.target.value)} placeholder="Banxico FIX" />
          </div>
          {fxError && (
            <p role="alert" className="text-[13px] text-destructive">
              {fxError}
            </p>
          )}
        </form>
      </ModalFormularioLateral>

      <ModalFormularioLateral
        open={detalle !== null}
        onOpenChange={(open) => !open && setDetalle(null)}
        titulo={detalle?.nombre ?? ""}
        subtitulo="Consumo contra los límites de su plan y últimos eventos de costo."
        anchoClase="max-w-2xl"
        footer={
          <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setDetalle(null)}>
            Cerrar
          </Button>
        }
      >
        {detalle && (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="text-sm font-medium mb-1">Tope mensual de LLM</h3>
              <p className="text-[13px] text-muted-foreground">Usado: {detalle.llmUsoPct.toFixed(0)}% de su tope del mes.</p>
              <div className="h-2 rounded-full bg-muted mt-1.5 overflow-hidden" aria-hidden>
                <div className={`h-full ${detalle.llmUsoPct >= 100 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${Math.min(100, detalle.llmUsoPct)}%` }} />
              </div>
            </div>
            <div>
              <h3 className="text-sm font-medium mb-1">Límites de su plan</h3>
              {detalle.consumo.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">Su plan no define límites (o no tiene plan asignado).</p>
              ) : (
                <ul className="flex flex-col gap-1 text-[13px]">
                  {detalle.consumo.map((c) => (
                    <li key={c.metrica} className="flex items-center justify-between gap-2">
                      <span>{ETIQUETA_METRICA[c.metrica] ?? c.metrica}</span>
                      <span className="text-muted-foreground">
                        {c.uso === null ? "sin dato" : `${c.uso} / ${c.limite}${c.pct === null ? "" : ` (${c.pct.toFixed(0)}%)`}`} · {c.estado} · {c.accion}
                        {c.aplicadoPorSistema ? " · el sistema lo corta" : " · solo avisa"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-medium mb-1">Últimos eventos de costo</h3>
              {eventosError ? (
                <p role="alert" className="text-[13px] text-destructive">
                  {eventosError}
                </p>
              ) : eventos === null ? (
                <p className="text-[13px] text-muted-foreground">Cargando…</p>
              ) : eventos.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">Sin eventos de voz, WhatsApp o telefonía registrados todavía. El costo de LLM sale de su propio agregado diario.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Fecha</TableHead>
                        <TableHead>Categoría</TableHead>
                        <TableHead>Cantidad</TableHead>
                        <TableHead>Costo</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {eventos.map((ev) => (
                        <TableRow key={ev.id}>
                          <TableCell>{new Date(ev.ocurrioEnMs).toLocaleString("es-MX")}</TableCell>
                          <TableCell>
                            {ev.categoria} · {ev.proveedor}
                          </TableCell>
                          <TableCell>
                            {ev.cantidad} {ev.unidad}
                          </TableCell>
                          <TableCell>
                            {usd(ev.costoMicroUsd)}
                            {ev.costoEstimado ? " (estimado)" : ""}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        )}
      </ModalFormularioLateral>
    </div>
  );
}
