// Aprobaciones (L-03) -- bandeja unica de los datos de empresa que esperan
// aprobacion (documentos, tarifas, capacidades, experiencia). Sin esta
// aprobacion las propuestas tecnica y economica no pueden usar el dato (un
// requisito sin dato aprobado queda PENDIENTE; nunca se rellena). Aprobar o
// rechazar es correccion de captura: WRITE_ROLES en el servidor (companyData.ts);
// la decision de riesgo real -- a que requisito se mapea cada dato -- vive en
// la propuesta tecnica. La aprobacion del expediente y de cada seccion de la
// propuesta es por convocatoria (pagina Cierre), no se duplica aqui.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, PageContainer, StatusBadge } from "@atiende/ui";
import {
  fetchApprovedRates,
  fetchCompanyCapabilities,
  fetchCompanyDocuments,
  fetchCompanyExperience,
  updateApprovedRate,
  updateCompanyCapability,
  updateCompanyDocument,
  updateCompanyExperience,
} from "../lib/company-data-client.ts";
import type { CompanyDataApprovalStatus } from "../lib/company-data-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

type Kind = "documento" | "tarifa" | "capacidad" | "experiencia";

interface PendingItem {
  readonly key: string;
  readonly kind: Kind;
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly status: CompanyDataApprovalStatus;
}

const KIND_LABEL: Record<Kind, string> = { documento: "Documento", tarifa: "Tarifa", capacidad: "Capacidad", experiencia: "Experiencia" };

export function AprobacionesPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const [items, setItems] = useState<readonly PendingItem[] | null>(null);
  const [loadErrors, setLoadErrors] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const canWrite = WRITE_ROLES.has(role);

  async function load() {
    setLoading(true);
    const [docs, rates, caps, exps] = await Promise.allSettled([
      fetchCompanyDocuments(fetch, apiBaseUrl, token, propertyId),
      fetchApprovedRates(fetch, apiBaseUrl, token, propertyId),
      fetchCompanyCapabilities(fetch, apiBaseUrl, token, propertyId),
      fetchCompanyExperience(fetch, apiBaseUrl, token, propertyId),
    ]);
    const all: PendingItem[] = [];
    const errs: string[] = [];
    const fail = (label: string, reason: unknown) => errs.push(`${label}: ${reason instanceof Error ? reason.message : "no se pudo cargar."}`);
    if (docs.status === "fulfilled") docs.value.forEach((d) => all.push({ key: `doc-${d.id}`, kind: "documento", id: d.id, title: d.label, detail: `${d.type}${d.expiresAt ? ` · vence ${d.expiresAt.slice(0, 10)}` : ""}`, status: d.approvalStatus }));
    else fail("Documentos", docs.reason);
    if (rates.status === "fulfilled") rates.value.forEach((r) => all.push({ key: `rate-${r.id}`, kind: "tarifa", id: r.id, title: r.concept, detail: `${r.unitPrice} ${r.currency} · desde ${r.validFrom.slice(0, 10)}`, status: r.approvalStatus }));
    else fail("Tarifas", rates.reason);
    if (caps.status === "fulfilled") caps.value.forEach((c) => all.push({ key: `cap-${c.id}`, kind: "capacidad", id: c.id, title: c.name, detail: c.description, status: c.approvalStatus }));
    else fail("Capacidades", caps.reason);
    if (exps.status === "fulfilled") exps.value.forEach((e) => all.push({ key: `exp-${e.id}`, kind: "experiencia", id: e.id, title: e.description, detail: `Evidencia: ${e.evidenceDocId}`, status: e.approvalStatus }));
    else fail("Experiencia", exps.reason);
    setItems(all);
    setLoadErrors(errs);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function decide(item: PendingItem, approvalStatus: CompanyDataApprovalStatus) {
    setActionError(null);
    setBusyKey(item.key);
    try {
      const input = { approvalStatus };
      if (item.kind === "documento") await updateCompanyDocument(fetch, apiBaseUrl, token, propertyId, item.id, input);
      else if (item.kind === "tarifa") await updateApprovedRate(fetch, apiBaseUrl, token, propertyId, item.id, input);
      else if (item.kind === "capacidad") await updateCompanyCapability(fetch, apiBaseUrl, token, propertyId, item.id, input);
      else await updateCompanyExperience(fetch, apiBaseUrl, token, propertyId, item.id, input);
      setItems((prev) => (prev ? prev.map((x) => (x.key === item.key ? { ...x, status: approvalStatus } : x)) : prev));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo registrar la decisión.");
    } finally {
      setBusyKey(null);
    }
  }

  const pending = (items ?? []).filter((i) => i.status === "pendiente_aprobacion");
  const rejected = (items ?? []).filter((i) => i.status === "rechazado");

  return (
    <PageContainer padding="none" size="md" className="gap-4 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Aprobaciones</h1>
        <p className="mt-1 max-w-[720px] text-sm text-muted-foreground">
          Datos de la empresa que esperan aprobación antes de poder usarse en una propuesta. Un dato pendiente o rechazado nunca se rellena ni se cita en la propuesta. La aprobación del expediente y de cada sección
          de la propuesta se hace dentro de cada convocatoria (pestaña Cierre). Para editar un dato ve a{" "}
          <Link to={`/licitaciones/${orgSlug}/datos-empresa`} className="underline">
            Datos de la empresa
          </Link>
          .
        </p>
      </header>

      {!canWrite && <p className="text-xs text-muted-foreground">Tu rol ({role}) solo puede consultar; aprobar o rechazar requiere un rol de escritura.</p>}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      {loadErrors.map((e) => (
        <EstadoError key={e} mensaje={e} onReintentar={() => void load()} />
      ))}
      {loading && !items && <EstadoCargando etiqueta="Cargando aprobaciones…" />}

      {items && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pendientes de aprobación ({pending.length})</CardTitle>
            <CardDescription>Aprobar es corrección de captura; rechazar lo deja fuera de las propuestas.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {pending.length === 0 && <EstadoVacio mensaje="No hay datos pendientes de aprobación." />}
            {pending.map((item) => (
              <div key={item.key} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusBadge dot={false}>{KIND_LABEL[item.kind]}</StatusBadge>
                    <span className="font-semibold text-foreground">{item.title}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{item.detail}</div>
                </div>
                {canWrite && (
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={busyKey !== null} onClick={() => void decide(item, "aprobado")}>
                      {busyKey === item.key ? "Guardando…" : "Aprobar"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" className="text-destructive" disabled={busyKey !== null} onClick={() => void decide(item, "rechazado")}>
                      Rechazar
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {items && rejected.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rechazados ({rejected.length})</CardTitle>
            <CardDescription>Se pueden reconsiderar aprobándolos.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {rejected.map((item) => (
              <div key={item.key} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusBadge tone="danger" dot={false}>{KIND_LABEL[item.kind]}</StatusBadge>
                    <span className="font-semibold text-foreground">{item.title}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{item.detail}</div>
                </div>
                {canWrite && (
                  <Button type="button" size="sm" variant="outline" disabled={busyKey !== null} onClick={() => void decide(item, "aprobado")}>
                    Aprobar
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}
