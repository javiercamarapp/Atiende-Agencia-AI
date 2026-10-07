// Campanas de reactivacion de clientes inactivos (autopiloto 2, migracion 052). Solo owner/admin con alcance a TODA la organizacion.
// El agente arma un BORRADOR por segmento (clientes CON consentimiento que llevan 30/60/90 dias sin pedir, la promocion vigente y el costo
// estimado de Meta); NADA se envia hasta que la persona aprueba con un clic. Rechazar o ignorar no envia nada. Estado honesto cuando falta un
// requisito (tarifa, plantilla aprobada de Meta, WhatsApp conectado, promocion vigente): se dice "requiere X", jamas se finge que funciona.
// Todo viene del API real; sin datos inventados. Sin telefonos ni nombres de clientes en pantalla.
import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleX, Megaphone } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, Checkbox, DataTable, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, PageContainer, StatCard, StatusBadge, notify, useConfirm } from "@atiende/ui";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import { decidirCampana, ETIQUETA_SEGMENTO, fetchMarketing, guardarConfigMarketing, recompraIncremental } from "../lib/marketing-client.ts";
import type { CampanaMarketing, ConfigMarketing, EstadoCampana, PanelMarketing } from "../lib/marketing-client.ts";
import { desdeError } from "../voz/carga.ts";
import type { Carga } from "../voz/carga.ts";
import { formatoMxn, pesosACentavos } from "../voz/formato-kpi.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ROLES_CAMPANAS: ReadonlySet<string> = new Set(["owner", "admin"]);

const TONO_ESTADO: Readonly<Record<EstadoCampana, "info" | "success" | "neutral" | "warning">> = { borrador: "info", aprobada: "success", rechazada: "neutral", expirada: "warning" };
const ETIQUETA_ESTADO: Readonly<Record<EstadoCampana, string>> = { borrador: "Por aprobar", aprobada: "Aprobada", rechazada: "Rechazada", expirada: "Expirada sin decidir" };

function centavosAPesos(c: number | null): string {
  return c === null ? "" : (c / 100).toFixed(2);
}

/** Fecha y hora de creacion en la zona del negocio (formateador canonico de lib/formato-fecha.ts). */
function fecha(iso: string): string {
  return fechaHoraEsMx(iso, "America/Merida");
}

export function CampanasPage({ apiBaseUrl, token, propertyId, role, fetchImpl }: RestaurantesShellContext & { readonly fetchImpl?: typeof fetch }) {
  const puedeVer = ROLES_CAMPANAS.has(role);
  const f = fetchImpl ?? fetch;
  const [datos, setDatos] = useState<Carga<PanelMarketing>>({ estado: "cargando" });
  const [version, setVersion] = useState(0);
  const [decidiendo, setDecidiendo] = useState<string | null>(null);
  const { confirmar, dialogo } = useConfirm();
  const recargar = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelado = false;
    setDatos({ estado: "cargando" });
    (async () => {
      try {
        const panel = await fetchMarketing(f, apiBaseUrl, token, propertyId);
        if (!cancelado) setDatos({ estado: "listo", datos: panel });
      } catch (err) {
        if (!cancelado) setDatos(desdeError(err, "No se pudieron cargar las campañas."));
      }
    })();
    return () => {
      cancelado = true;
    };
    // `f` cambia de identidad solo si cambia fetchImpl (prop de prueba).
  }, [apiBaseUrl, token, propertyId, version, puedeVer, f]);

  async function decidir(c: CampanaMarketing, accion: "aprobar" | "rechazar") {
    if (accion === "aprobar") {
      const ok = await confirmar({
        titulo: "Aprobar campaña",
        descripcion: `Se enviará la promoción ${c.promoCodigo} por WhatsApp a unos ${c.conteo} clientes que dieron su consentimiento (la cifra exacta se recalcula al aprobar, solo con quienes sigan con consentimiento). Costo estimado de Meta (aprox.): ${formatoMxn(c.costoEstimadoCentavos)}. Los mensajes salen en horario de atención.`,
        confirmar: "Aprobar y enviar",
        cancelar: "Volver",
      });
      if (!ok) return;
    }
    setDecidiendo(c.id);
    try {
      const r = await decidirCampana(f, apiBaseUrl, token, propertyId, c.id, accion);
      notify.success(r.estado === "aprobada" ? `Campaña aprobada: ${r.encolados} mensajes en cola.` : "Campaña rechazada: no se envió nada.");
      recargar();
    } catch (err) {
      // El servidor responde "requiere X" (tarifa, plantilla aprobada, WhatsApp conectado, tope mensual): se muestra tal cual.
      notify.error(err instanceof Error ? err.message : "No se pudo registrar la decisión.");
    } finally {
      setDecidiendo(null);
    }
  }

  return (
    <PageContainer padding="none">
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display truncate text-xl font-semibold">Campañas</h1>
          <p className="mt-1 truncate text-ui text-muted-foreground">Reactiva a clientes que llevan tiempo sin pedir. Nada se envía hasta que apruebes.</p>
        </div>
      </header>

      {!puedeVer ? (
        <Callout tone="info">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> con acceso a toda la organización ven las campañas — tu rol actual es <strong className="text-foreground">{role}</strong>.
        </Callout>
      ) : datos.estado === "cargando" ? (
        <EstadoCargando etiqueta="Cargando campañas…" />
      ) : datos.estado === "no_disponible" ? (
        <EstadoVacio
          icon={Megaphone}
          titulo="Campañas no disponibles todavía"
          mensaje="Las campañas de reactivación aún no están activas en este negocio (requieren la actualización de base de datos pendiente). Cuando lo estén, aquí verás los borradores para aprobar."
        />
      ) : datos.estado === "error" ? (
        <EstadoError mensaje={datos.mensaje} onReintentar={recargar} />
      ) : (
        <Contenido panel={datos.datos} decidiendo={decidiendo} onDecidir={decidir} onGuardado={recargar} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} fetchImpl={f} />
      )}
      {dialogo}
    </PageContainer>
  );
}

function Requisito({ cumplido, texto, falta }: { readonly cumplido: boolean; readonly texto: string; readonly falta: string }) {
  const Icono = cumplido ? CircleCheck : CircleX;
  return (
    <li className="flex items-start gap-1.5 text-sm" data-requisito={cumplido ? "ok" : "falta"}>
      <Icono className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${cumplido ? "text-success" : "text-warning"}`} strokeWidth={1.75} aria-hidden />
      <span>{cumplido ? texto : falta}</span>
    </li>
  );
}

function Contenido({
  panel,
  decidiendo,
  onDecidir,
  onGuardado,
  apiBaseUrl,
  token,
  propertyId,
  fetchImpl,
}: {
  readonly panel: PanelMarketing;
  readonly decidiendo: string | null;
  readonly onDecidir: (c: CampanaMarketing, accion: "aprobar" | "rechazar") => void;
  readonly onGuardado: () => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly fetchImpl: typeof fetch;
}) {
  const { config, campanas } = panel;
  const requisitosOk = config.tarifaCentavos !== null && config.plantillaAprobada && config.whatsappConectado;
  return (
    <div className="space-y-2.5" data-testid="campanas">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <StatCard icon={Megaphone} label="Con consentimiento" value={String(config.consentimientosVigentes)} nota="Clientes que aceptaron promociones por WhatsApp" />
        <StatCard icon={Megaphone} label="Gastado este mes" value={formatoMxn(config.gastadoMesCentavos)} nota={config.topeMensualCentavos === null ? "Sin tope mensual" : `Tope mensual ${formatoMxn(config.topeMensualCentavos)}`} />
        <StatCard icon={Megaphone} label="Campañas por aprobar" value={String(campanas.filter((c) => c.estado === "borrador").length)} nota="Nada se envía sin tu aprobación" />
      </div>

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>Para poder enviar</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 p-3 pt-0">
          <ul className="m-0 list-none space-y-1 p-0">
            <Requisito cumplido={config.activo} texto="Las campañas están activadas." falta="Las campañas están apagadas: actívalas abajo para que se armen borradores." />
            <Requisito cumplido={config.hayPromocionVigente} texto="Hay una promoción vigente (la campaña nunca inventa descuentos)." falta="Requiere una promoción vigente en Promociones: sin ella no se arma ningún borrador." />
            <Requisito cumplido={config.tarifaCentavos !== null} texto={`Tarifa por mensaje de Meta: ${formatoMxn(config.tarifaCentavos)}.`} falta="Requiere la tarifa por mensaje de marketing de Meta para mostrar el costo antes de aprobar." />
            <Requisito cumplido={config.plantillaAprobada} texto={`Plantilla de marketing aprobada por Meta: ${config.plantillaNombre ?? ""}.`} falta="Requiere una plantilla de marketing aprobada por Meta (con 2 variables: nombre y código de la promoción)." />
            <Requisito cumplido={config.whatsappConectado} texto="WhatsApp conectado." falta="Requiere WhatsApp conectado." />
          </ul>
          {!requisitosOk ? (
            <p className="m-0 text-xs text-muted-foreground">Mientras falte algo de lo anterior, los borradores se arman pero no se pueden aprobar: el envío queda como «requiere…».</p>
          ) : null}
        </CardContent>
      </Card>

      <ConfigForm config={config} onGuardado={onGuardado} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} fetchImpl={fetchImpl} />

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>Campañas</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<CampanaMarketing>
            etiqueta="Campañas de reactivación"
            filas={[...campanas]}
            obtenerId={(c) => c.id}
            atributosFila={(c) => ({ "data-campana": c.id, "data-estado": c.estado })}
            vacio={{ titulo: "Sin campañas", mensaje: "Cuando haya clientes con consentimiento que lleven días sin pedir, una promoción vigente y las campañas estén activas, aquí aparecerá el borrador." }}
            paginacion={false}
            columnas={[
              { id: "segmento", encabezado: "Segmento", principal: true, celda: (c) => ETIQUETA_SEGMENTO[c.segmento] },
              { id: "estado", encabezado: "Estado", celda: (c) => <StatusBadge tone={TONO_ESTADO[c.estado]}>{ETIQUETA_ESTADO[c.estado]}</StatusBadge> },
              { id: "promo", encabezado: "Promoción", celda: (c) => `${c.promoNombre} (${c.promoCodigo})` },
              { id: "clientes", encabezado: "Clientes", alinear: "right", className: "tabular-nums", celda: (c) => (c.estado === "aprobada" ? (c.encolados ?? 0) : c.conteo) },
              { id: "costo", encabezado: "Costo estimado", alinear: "right", className: "tabular-nums", celda: (c) => formatoMxn(c.costoEstimadoCentavos) },
              { id: "creada", encabezado: "Creada", alinear: "right", celda: (c) => fecha(c.creadaAt) },
              {
                id: "resultado",
                encabezado: "Recompra a 7 días",
                celda: (c) => <Resultado c={c} />,
              },
              {
                id: "acciones",
                encabezado: "",
                alinear: "right",
                celda: (c) =>
                  c.estado === "borrador" ? (
                    <div className="flex justify-end gap-1.5">
                      <Button type="button" size="sm" variant="outline" disabled={decidiendo !== null} onClick={() => onDecidir(c, "rechazar")} aria-label={`Rechazar la campaña de ${ETIQUETA_SEGMENTO[c.segmento]}`}>
                        Rechazar
                      </Button>
                      <Button type="button" size="sm" loading={decidiendo === c.id} disabled={decidiendo !== null} onClick={() => onDecidir(c, "aprobar")} aria-label={`Aprobar la campaña de ${ETIQUETA_SEGMENTO[c.segmento]}`}>
                        Aprobar
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Resultado({ c }: { readonly c: CampanaMarketing }) {
  if (c.estado !== "aprobada") return <span className="text-muted-foreground">—</span>;
  const inc = recompraIncremental(c);
  const tratados = `${c.recompraTratados} de ${c.encolados ?? 0} con mensaje`;
  const control = `${c.recompraControl} de ${c.conteoControl} sin mensaje`;
  return (
    <div className="text-xs" data-testid={`resultado-${c.id}`}>
      <div>{tratados}</div>
      <div className="text-muted-foreground">{control}</div>
      <div className="font-medium">{inc === null ? (c.ventanaCerrada ? "Sin grupo de control para comparar" : "Ventana de 7 días en curso") : `Incremental: ${inc > 0 ? "+" : ""}${inc} puntos`}</div>
    </div>
  );
}

function ConfigForm({
  config,
  onGuardado,
  apiBaseUrl,
  token,
  propertyId,
  fetchImpl,
}: {
  readonly config: ConfigMarketing;
  readonly onGuardado: () => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly fetchImpl: typeof fetch;
}) {
  const [activo, setActivo] = useState(config.activo);
  const [tarifa, setTarifa] = useState(centavosAPesos(config.tarifaCentavos));
  const [tope, setTope] = useState(centavosAPesos(config.topeMensualCentavos));
  const [minimo, setMinimo] = useState(String(config.minimoSegmento));
  const [plantilla, setPlantilla] = useState(config.plantillaNombre ?? "");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    const tarifaCentavos = pesosACentavos(tarifa);
    const topeCentavos = pesosACentavos(tope);
    const minimoN = Number(minimo);
    if (tarifaCentavos === undefined || (tarifaCentavos !== null && tarifaCentavos > 10000)) return setError("La tarifa por mensaje debe ser un monto en pesos entre $0.01 y $100.00 (o vacío si aún no la conoces).");
    if (topeCentavos === undefined) return setError("El tope mensual debe ser un monto en pesos válido (o vacío para no poner tope).");
    if (!Number.isInteger(minimoN) || minimoN < 1 || minimoN > 10000) return setError("El mínimo de clientes por campaña debe ser un entero entre 1 y 10,000.");
    if (plantilla.trim() !== "" && !/^[a-z0-9_]{1,255}$/.test(plantilla.trim())) return setError("El nombre de la plantilla usa minúsculas, dígitos y guion bajo, igual que en Meta.");
    setError(null);
    setGuardando(true);
    try {
      await guardarConfigMarketing(fetchImpl, apiBaseUrl, token, propertyId, { activo, tarifaCentavos, topeMensualCentavos: topeCentavos, minimoSegmento: minimoN, plantillaNombre: plantilla.trim() === "" ? null : plantilla.trim(), plantillaIdioma: config.plantillaIdioma });
      notify.success("Configuración de campañas guardada.");
      onGuardado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la configuración.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-3 pb-2">
        <CardTitle>Configuración</CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <form onSubmit={guardar} className="space-y-2.5" data-testid="campanas-config">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={activo} onChange={(e) => setActivo(e.target.checked)} aria-label="Activar campañas de reactivación" />
            <span>Activar campañas de reactivación (se arman borradores a diario; nada se envía sin aprobación).</span>
          </label>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <FormField label="Tarifa por mensaje de Meta (MXN)">{(p) => <Input {...p} inputMode="decimal" value={tarifa} onChange={(e) => setTarifa(e.target.value)} placeholder="0.80" />}</FormField>
            <FormField label="Tope mensual de marketing (MXN, opcional)">{(p) => <Input {...p} inputMode="decimal" value={tope} onChange={(e) => setTope(e.target.value)} placeholder="Sin tope" />}</FormField>
            <FormField label="Mínimo de clientes por campaña">{(p) => <Input {...p} inputMode="numeric" value={minimo} onChange={(e) => setMinimo(e.target.value)} />}</FormField>
            <FormField label="Plantilla de marketing aprobada en Meta">{(p) => <Input {...p} value={plantilla} onChange={(e) => setPlantilla(e.target.value)} placeholder="reactivacion_promo" />}</FormField>
          </div>
          {error ? (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <Button type="submit" size="sm" loading={guardando}>
            Guardar configuración
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
