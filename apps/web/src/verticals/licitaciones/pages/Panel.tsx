// Panel (L-03, REQ-169) -- resumen operativo con metricas honestas: cada cifra
// sale de una lectura real de la API y, si esa lectura falla, la tarjeta dice
// "No disponible" en vez de mostrar un cero inventado. No hay graficas ni
// metricas de desempeno (tasa de exito, ahorro) porque el sistema todavia no las
// calcula; solo cuenta lo que existe. Cada tarjeta enlaza a la pagina donde se
// actua sobre ese numero.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando } from "@atiende/ui";
import { fetchTenders } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchSourceFreshness } from "../lib/sources-client.ts";
import { fetchDeadlineReminders, fetchTenderChangeNotifications } from "../lib/seguimiento-client.ts";
import { fetchRenewalAlerts } from "../lib/renewal-radar-client.ts";
import { fetchApprovedRates, fetchCompanyCapabilities, fetchCompanyDocuments, fetchCompanyExperience, fetchCompanySigners } from "../lib/company-data-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const DIA_MS = 24 * 60 * 60 * 1000;
const VENTANA_PLAZO_DIAS = 7;

/** Resultado de una lectura: valor, o null cuando fallo (la tarjeta lo muestra como "No disponible"). */
type Medida<T> = T | null;

interface Resumen {
  tenders: Medida<readonly TenderSummary[]>;
  fuentesObsoletas: Medida<{ obsoletas: number; total: number }>;
  recordatoriosPendientes: Medida<number>;
  cambiosPendientes: Medida<number>;
  renovacionesPendientes: Medida<number>;
  aprobacionesPendientes: Medida<number>;
  firmantesAutorizados: Medida<number>;
}

const ok = <T,>(r: PromiseSettledResult<T>): Medida<T> => (r.status === "fulfilled" ? r.value : null);

export function PanelPage({ apiBaseUrl, token, propertyId, orgSlug, staffFullName }: LicitacionesShellContext) {
  const [resumen, setResumen] = useState<Resumen | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const [tenders, fuentes, recs, cambios, renov, docs, rates, caps, exps, firmantes] = await Promise.allSettled([
        fetchTenders(fetch, apiBaseUrl, token, propertyId),
        fetchSourceFreshness(fetch, apiBaseUrl, token, propertyId),
        fetchDeadlineReminders(fetch, apiBaseUrl, token, propertyId),
        fetchTenderChangeNotifications(fetch, apiBaseUrl, token, propertyId),
        fetchRenewalAlerts(fetch, apiBaseUrl, token, propertyId),
        fetchCompanyDocuments(fetch, apiBaseUrl, token, propertyId),
        fetchApprovedRates(fetch, apiBaseUrl, token, propertyId),
        fetchCompanyCapabilities(fetch, apiBaseUrl, token, propertyId),
        fetchCompanyExperience(fetch, apiBaseUrl, token, propertyId),
        fetchCompanySigners(fetch, apiBaseUrl, token, propertyId),
      ]);
      if (cancelado) return;
      const datosEmpresa = [docs, rates, caps, exps];
      // Las aprobaciones solo se cuentan si las 4 lecturas respondieron: una suma parcial parecería "todo al día".
      const aprobaciones = datosEmpresa.every((r) => r.status === "fulfilled")
        ? datosEmpresa.reduce((acc, r) => acc + (r as PromiseFulfilledResult<readonly { approvalStatus: string }[]>).value.filter((x) => x.approvalStatus === "pendiente_aprobacion").length, 0)
        : null;
      const f = ok(fuentes);
      const r = ok(recs);
      const c = ok(cambios);
      const rn = ok(renov);
      const fi = ok(firmantes);
      setResumen({
        tenders: ok(tenders),
        fuentesObsoletas: f ? { obsoletas: f.filter((x) => x.stale).length, total: f.length } : null,
        recordatoriosPendientes: r ? r.filter((x) => x.acknowledgedAt === null).length : null,
        cambiosPendientes: c ? c.filter((x) => x.acknowledgedAt === null).length : null,
        renovacionesPendientes: rn ? rn.filter((x) => x.status === "pendiente").length : null,
        aprobacionesPendientes: aprobaciones,
        firmantesAutorizados: fi ? fi.filter((x) => x.authorized).length : null,
      });
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  const base = `/licitaciones/${orgSlug}`;

  if (!resumen) {
    return <EstadoCargando etiqueta="Cargando panel…" />;
  }

  const ahora = Date.now();
  const abiertas = resumen.tenders?.filter((t) => t.status !== "won" && t.status !== "lost" && t.status !== "cancelled" && t.status !== "no_go") ?? null;
  // Solo convocatorias abiertas: el plazo de una ya ganada, perdida, cancelada o descartada no requiere acción.
  const proximas =
    abiertas?.filter((t) => {
      if (!t.submissionDeadline) return false;
      const ms = new Date(t.submissionDeadline).getTime() - ahora;
      return ms >= 0 && ms <= VENTANA_PLAZO_DIAS * DIA_MS;
    }) ?? null;

  const tarjetas: { titulo: string; valor: ReactNode; ayuda: string; to: string; enlace: string; alerta?: boolean }[] = [
    { titulo: "Convocatorias abiertas", valor: abiertas?.length ?? null, ayuda: "Sin resolver: no ganadas, perdidas, canceladas ni descartadas (no-go).", to: `${base}/convocatorias`, enlace: "Ver convocatorias" },
    { titulo: `Cierran en ${VENTANA_PLAZO_DIAS} días`, valor: proximas?.length ?? null, ayuda: "Plazo de presentación de propuestas dentro de la ventana.", to: `${base}/seguimiento`, enlace: "Ver seguimiento", alerta: (proximas?.length ?? 0) > 0 },
    { titulo: "Recordatorios de plazo", valor: resumen.recordatoriosPendientes, ayuda: "Pendientes de reconocer.", to: `${base}/seguimiento`, enlace: "Ver seguimiento" },
    { titulo: "Cambios de convocatoria", valor: resumen.cambiosPendientes, ayuda: "Modificaciones a bases o anexos por revisar.", to: `${base}/seguimiento`, enlace: "Ver seguimiento", alerta: (resumen.cambiosPendientes ?? 0) > 0 },
    { titulo: "Renovaciones por vencer", valor: resumen.renovacionesPendientes, ayuda: "Alertas del radar sin reconocer.", to: `${base}/radar-renovaciones`, enlace: "Ver radar" },
    { titulo: "Datos por aprobar", valor: resumen.aprobacionesPendientes, ayuda: "Documentos, tarifas, capacidades y experiencia pendientes.", to: `${base}/aprobaciones`, enlace: "Ver aprobaciones" },
    {
      titulo: "Firmantes autorizados",
      valor: resumen.firmantesAutorizados,
      ayuda: resumen.firmantesAutorizados === 0 ? "Sin firmante autorizado no se puede firmar una propuesta." : "Personas que pueden firmar propuestas.",
      to: `${base}/firmantes`,
      enlace: "Ver firmantes",
      alerta: resumen.firmantesAutorizados === 0,
    },
    {
      titulo: "Fuentes obsoletas",
      valor: resumen.fuentesObsoletas ? `${resumen.fuentesObsoletas.obsoletas} de ${resumen.fuentesObsoletas.total}` : null,
      ayuda: "Fuentes sin corrida exitosa dentro de su umbral.",
      to: `${base}/fuentes`,
      enlace: "Ver fuentes",
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-foreground">{staffFullName ? `Hola, ${staffFullName}` : "Panel"}</h1>
        <p className="mt-1 max-w-[720px] text-[13px] text-muted-foreground">
          Estado actual de tus licitaciones. Cada cifra viene de datos reales; si una lectura falla se indica como &quot;No disponible&quot; en lugar de mostrar cero.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tarjetas.map((t) => (
          <Card key={t.titulo} className={t.alerta ? "border-amber-500/60" : undefined}>
            <CardHeader className="pb-2">
              <CardDescription>{t.titulo}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{t.valor === null ? <span className="text-base font-medium text-muted-foreground">No disponible</span> : t.valor}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <p className="text-[12px] text-muted-foreground">{t.ayuda}</p>
              <Link to={t.to} className="text-[13px] font-medium text-foreground underline">
                {t.enlace}
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
