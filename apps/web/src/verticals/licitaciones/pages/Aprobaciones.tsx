// Aprobaciones (L-03) -- bandeja unica de los datos de empresa que esperan
// aprobacion (documentos, tarifas, capacidades, experiencia, firmantes y, desde la
// migracion 040, perfil general, productos y servicios, ubicaciones, restricciones
// y socios). Sin esta
// aprobacion las propuestas tecnica y economica no pueden usar el dato (un
// requisito sin dato aprobado queda PENDIENTE; nunca se rellena). Aprobar o
// rechazar es una DECISION (migracion 036): nunca de quien propuso o edito el
// dato, tarifas solo owner/admin con step-up y el resto DECISION_ROLES
// (`DecisionActions.tsx`; el servidor decide). La aprobacion del expediente y
// de cada seccion de la propuesta es por convocatoria (pagina Cierre), no se
// duplica aqui.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, PageContainer, StatusBadge } from "@atiende/ui";
import { fetchApprovedRates, fetchCompanyCapabilities, fetchCompanyDocuments, fetchCompanyExperience, fetchCompanySigners } from "../lib/company-data-client.ts";
import { fetchCompanyProfile, fetchProfileCollection } from "../lib/company-profile-client.ts";
import type { CompanyLocation, CompanyProductService, CompanyRestriction, CompanyStakeholder } from "../lib/company-profile-client.ts";
import type { CompanyDataApprovalStatus, CompanyDataAuthorship, CompanyItemKind } from "../lib/company-data-client.ts";
import { DecisionButtons, useCompanyDecision } from "../components/DecisionActions.tsx";
import { authorshipLine, userIdFromToken } from "../lib/company-decision.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

type Kind = "documento" | "tarifa" | "capacidad" | "experiencia" | "firmante" | "perfil" | "producto" | "ubicacion" | "restriccion" | "socio";

interface PendingItem extends CompanyDataAuthorship {
  readonly key: string;
  readonly kind: Kind;
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly status: CompanyDataApprovalStatus;
}

const KIND_LABEL: Record<Kind, string> = {
  documento: "Documento",
  tarifa: "Tarifa",
  capacidad: "Capacidad",
  experiencia: "Experiencia",
  firmante: "Firmante",
  perfil: "Perfil general",
  producto: "Producto o servicio",
  ubicacion: "Ubicación",
  restriccion: "Restricción",
  socio: "Socio o representante",
};
const DECISION_KIND: Record<Kind, CompanyItemKind> = {
  documento: "document",
  tarifa: "rate",
  capacidad: "capability",
  experiencia: "experience",
  firmante: "signer",
  perfil: "profile",
  producto: "product",
  ubicacion: "location",
  restriccion: "restriction",
  socio: "stakeholder",
};

export function AprobacionesPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const userId = userIdFromToken(token);
  const [items, setItems] = useState<readonly PendingItem[] | null>(null);
  const [loadErrors, setLoadErrors] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [docs, rates, caps, exps, signers, perfil, productos, ubicaciones, restricciones, socios] = await Promise.allSettled([
      fetchCompanyDocuments(fetch, apiBaseUrl, token, propertyId),
      fetchApprovedRates(fetch, apiBaseUrl, token, propertyId),
      fetchCompanyCapabilities(fetch, apiBaseUrl, token, propertyId),
      fetchCompanyExperience(fetch, apiBaseUrl, token, propertyId),
      fetchCompanySigners(fetch, apiBaseUrl, token, propertyId),
      fetchCompanyProfile(fetch, apiBaseUrl, token, propertyId),
      fetchProfileCollection<CompanyProductService>(fetch, apiBaseUrl, token, propertyId, "products"),
      fetchProfileCollection<CompanyLocation>(fetch, apiBaseUrl, token, propertyId, "locations"),
      fetchProfileCollection<CompanyRestriction>(fetch, apiBaseUrl, token, propertyId, "restrictions"),
      fetchProfileCollection<CompanyStakeholder>(fetch, apiBaseUrl, token, propertyId, "stakeholders"),
    ]);
    const all: PendingItem[] = [];
    const errs: string[] = [];
    const fail = (label: string, reason: unknown) => errs.push(`${label}: ${reason instanceof Error ? reason.message : "no se pudo cargar."}`);
    if (docs.status === "fulfilled") docs.value.forEach((d) => all.push({ key: `doc-${d.id}`, kind: "documento", id: d.id, title: d.label, detail: `${d.type}${d.expiresAt ? ` · vence ${d.expiresAt.slice(0, 10)}` : ""}`, status: d.approvalStatus, proposedBy: d.proposedBy, approvedBy: d.approvedBy, proposedByName: d.proposedByName, approvedByName: d.approvedByName }));
    else fail("Documentos", docs.reason);
    if (rates.status === "fulfilled") rates.value.forEach((r) => all.push({ key: `rate-${r.id}`, kind: "tarifa", id: r.id, title: r.concept, detail: `${r.unitPrice} ${r.currency} · desde ${r.validFrom.slice(0, 10)}`, status: r.approvalStatus, proposedBy: r.proposedBy, approvedBy: r.approvedBy, proposedByName: r.proposedByName, approvedByName: r.approvedByName }));
    else fail("Tarifas", rates.reason);
    if (caps.status === "fulfilled") caps.value.forEach((c) => all.push({ key: `cap-${c.id}`, kind: "capacidad", id: c.id, title: c.name, detail: c.description, status: c.approvalStatus, proposedBy: c.proposedBy, approvedBy: c.approvedBy, proposedByName: c.proposedByName, approvedByName: c.approvedByName }));
    else fail("Capacidades", caps.reason);
    if (exps.status === "fulfilled") exps.value.forEach((e) => all.push({ key: `exp-${e.id}`, kind: "experiencia", id: e.id, title: e.description, detail: `Evidencia: ${e.evidenceDocId}`, status: e.approvalStatus, proposedBy: e.proposedBy, approvedBy: e.approvedBy, proposedByName: e.proposedByName, approvedByName: e.approvedByName }));
    else fail("Experiencia", exps.reason);
    const aut = (x: CompanyDataAuthorship) => ({ proposedBy: x.proposedBy, approvedBy: x.approvedBy, proposedByName: x.proposedByName, approvedByName: x.approvedByName });
    if (signers.status === "fulfilled") signers.value.forEach((g) => all.push({ key: `sig-${g.id}`, kind: "firmante", id: g.id, title: g.name, detail: `${g.role}${g.validFrom ? ` · poder ${g.validFrom}${g.validUntil ? ` a ${g.validUntil}` : ""}` : ""}`, status: g.approvalStatus ?? "aprobado", ...aut(g) }));
    else fail("Firmantes", signers.reason);
    // Perfil completo (040): una base sin la migracion responde vacio con `disponible: false`, no un error.
    if (perfil.status === "fulfilled") {
      const p = perfil.value.profile;
      if (p) all.push({ key: `perfil-${p.id}`, kind: "perfil", id: p.id, title: p.legalName, detail: `RFC ${p.taxId}`, status: p.approvalStatus, ...aut(p) });
    } else fail("Perfil general", perfil.reason);
    if (productos.status === "fulfilled") productos.value.items.forEach((x) => all.push({ key: `prod-${x.id}`, kind: "producto", id: x.id, title: x.name, detail: x.kind === "servicio" ? "Servicio" : "Producto", status: x.approvalStatus, ...aut(x) }));
    else fail("Productos y servicios", productos.reason);
    if (ubicaciones.status === "fulfilled") ubicaciones.value.items.forEach((x) => all.push({ key: `ubi-${x.id}`, kind: "ubicacion", id: x.id, title: x.name, detail: x.state, status: x.approvalStatus, ...aut(x) }));
    else fail("Ubicaciones", ubicaciones.reason);
    if (restricciones.status === "fulfilled") restricciones.value.items.forEach((x) => all.push({ key: `res-${x.id}`, kind: "restriccion", id: x.id, title: x.description, detail: `${x.kind} · desde ${x.validFrom}${x.validUntil ? ` hasta ${x.validUntil}` : ""}`, status: x.approvalStatus, ...aut(x) }));
    else fail("Restricciones", restricciones.reason);
    if (socios.status === "fulfilled") socios.value.items.forEach((x) => all.push({ key: `soc-${x.id}`, kind: "socio", id: x.id, title: x.fullName, detail: `${x.kind === "socio" ? "Socio" : "Representante"}${x.participationPct ? ` · ${x.participationPct}%` : ""}`, status: x.approvalStatus, ...aut(x) }));
    else fail("Socios y representantes", socios.reason);
    setItems(all);
    setLoadErrors(errs);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  const decision = useCompanyDecision({ apiBaseUrl, token, propertyId, onChanged: load, onError: setActionError });

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

      {!["owner", "admin", "analyst"].includes(role) && <p className="text-xs text-muted-foreground">Tu rol ({role}) solo puede consultar; aprobar o rechazar requiere un rol de decisión (propietario, administrador o analista).</p>}
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
            <CardDescription>Quien propuso o editó un dato no lo decide: lo decide otra persona. Las tarifas piden además tu código de dos pasos. Rechazar lo deja fuera de las propuestas.</CardDescription>
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
                  {authorshipLine({ ...item, approvalStatus: item.status }, userId) && <div className="text-xs text-muted-foreground">{authorshipLine({ ...item, approvalStatus: item.status }, userId)}</div>}
                </div>
                <DecisionButtons kind={DECISION_KIND[item.kind]} id={item.id} etiqueta={item.title} item={{ ...item, approvalStatus: item.status }} role={role} userId={userId} decision={decision} busy={false} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {items && rejected.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rechazados ({rejected.length})</CardTitle>
            <CardDescription>Para reconsiderarlos, edítalos en Datos de la empresa: vuelven a pendiente y otra persona los decide.</CardDescription>
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
                  {authorshipLine({ ...item, approvalStatus: item.status }, userId) && <div className="text-xs text-muted-foreground">{authorshipLine({ ...item, approvalStatus: item.status }, userId)}</div>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {decision.dialogo}
    </PageContainer>
  );
}
