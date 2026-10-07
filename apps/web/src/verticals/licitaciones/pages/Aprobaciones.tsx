// Aprobaciones (L-03) -- bandeja unica de los datos de empresa que esperan
// aprobacion (documentos, tarifas, capacidades, experiencia). Sin esta
// aprobacion las propuestas tecnica y economica no pueden usar el dato (un
// requisito sin dato aprobado queda PENDIENTE; nunca se rellena). Aprobar o
// rechazar es una DECISION (migracion 036): nunca de quien propuso o edito el
// dato, tarifas solo owner/admin con step-up y el resto DECISION_ROLES
// (`DecisionActions.tsx`; el servidor decide). La aprobacion del expediente y
// de cada seccion de la propuesta es por convocatoria (pagina Cierre), no se
// duplica aqui.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Send } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Label, NativeSelect, PageContainer, StatusBadge, Textarea } from "@atiende/ui";
import { fetchApprovedRates, fetchCompanyCapabilities, fetchCompanyDocuments, fetchCompanyExperience } from "../lib/company-data-client.ts";
import type { CompanyDataApprovalStatus, CompanyDataAuthorship, CompanyItemKind } from "../lib/company-data-client.ts";
import { DecisionButtons, useCompanyDecision } from "../components/DecisionActions.tsx";
import { authorshipLine, userIdFromToken } from "../lib/company-decision.ts";
import { fetchTenders } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { requestReview } from "../lib/revision-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

type Kind = "documento" | "tarifa" | "capacidad" | "experiencia";

interface PendingItem extends CompanyDataAuthorship {
  readonly key: string;
  readonly kind: Kind;
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly status: CompanyDataApprovalStatus;
}

const KIND_LABEL: Record<Kind, string> = { documento: "Documento", tarifa: "Tarifa", capacidad: "Capacidad", experiencia: "Experiencia" };
const DECISION_KIND: Record<Kind, CompanyItemKind> = { documento: "document", tarifa: "rate", capacidad: "capability", experiencia: "experience" };

// Quién puede enviar a revisión (SUBMITTER_ROLES del servidor); cosmético, el servidor decide.
const SUBMITTER_ROLES = new Set(["owner", "admin", "analyst", "writer"]);

export function AprobacionesPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const userId = userIdFromToken(token);
  const [items, setItems] = useState<readonly PendingItem[] | null>(null);
  const [loadErrors, setLoadErrors] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const canRequestReview = SUBMITTER_ROLES.has(role);

  // paridad3 (L-P3-07): pedir la revisión del expediente de una convocatoria (avisa a los revisores por la campana).
  const [tenders, setTenders] = useState<readonly TenderSummary[] | null>(null);
  const [reviewTenderId, setReviewTenderId] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMsg, setReviewMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!canRequestReview) return;
    fetchTenders(fetch, apiBaseUrl, token, propertyId)
      .then((list) => setTenders(list))
      .catch(() => setTenders([]));
  }, [apiBaseUrl, token, propertyId, canRequestReview]);

  async function handleRequestReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reviewTenderId === "") {
      setReviewMsg({ tone: "error", text: "Elige la convocatoria cuyo expediente quieres enviar a revisión." });
      return;
    }
    setReviewBusy(true);
    setReviewMsg(null);
    try {
      await requestReview(fetch, apiBaseUrl, token, propertyId, reviewTenderId, { sectionKey: null, note: reviewNote.trim() });
      setReviewMsg({ tone: "ok", text: "Revisión solicitada: los revisores recibieron el aviso en la campana. Quien la pide no puede aprobar el expediente." });
      setReviewNote("");
    } catch (err) {
      setReviewMsg({ tone: "error", text: err instanceof Error ? err.message : "No se pudo pedir la revisión." });
    } finally {
      setReviewBusy(false);
    }
  }

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
    if (docs.status === "fulfilled") docs.value.forEach((d) => all.push({ key: `doc-${d.id}`, kind: "documento", id: d.id, title: d.label, detail: `${d.type}${d.expiresAt ? ` · vence ${d.expiresAt.slice(0, 10)}` : ""}`, status: d.approvalStatus, proposedBy: d.proposedBy, approvedBy: d.approvedBy, proposedByName: d.proposedByName, approvedByName: d.approvedByName }));
    else fail("Documentos", docs.reason);
    if (rates.status === "fulfilled") rates.value.forEach((r) => all.push({ key: `rate-${r.id}`, kind: "tarifa", id: r.id, title: r.concept, detail: `${r.unitPrice} ${r.currency} · desde ${r.validFrom.slice(0, 10)}`, status: r.approvalStatus, proposedBy: r.proposedBy, approvedBy: r.approvedBy, proposedByName: r.proposedByName, approvedByName: r.approvedByName }));
    else fail("Tarifas", rates.reason);
    if (caps.status === "fulfilled") caps.value.forEach((c) => all.push({ key: `cap-${c.id}`, kind: "capacidad", id: c.id, title: c.name, detail: c.description, status: c.approvalStatus, proposedBy: c.proposedBy, approvedBy: c.approvedBy, proposedByName: c.proposedByName, approvedByName: c.approvedByName }));
    else fail("Capacidades", caps.reason);
    if (exps.status === "fulfilled") exps.value.forEach((e) => all.push({ key: `exp-${e.id}`, kind: "experiencia", id: e.id, title: e.description, detail: `Evidencia: ${e.evidenceDocId}`, status: e.approvalStatus, proposedBy: e.proposedBy, approvedBy: e.approvedBy, proposedByName: e.proposedByName, approvedByName: e.approvedByName }));
    else fail("Experiencia", exps.reason);
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

      {canRequestReview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pedir revisión de un expediente</CardTitle>
            <CardDescription>Envía el expediente de una convocatoria a revisión: los revisores reciben un aviso y la solicitud queda en el hilo de la propuesta. Quien la pide no puede aprobar ese alcance.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void handleRequestReview(e)} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="revision-convocatoria">Convocatoria</Label>
                <NativeSelect id="revision-convocatoria" value={reviewTenderId} onChange={(e) => setReviewTenderId(e.target.value)} disabled={tenders === null}>
                  <option value="">{tenders === null ? "Cargando…" : tenders.length === 0 ? "No hay convocatorias" : "Elige una convocatoria"}</option>
                  {(tenders ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="revision-nota">Nota para el revisor (opcional)</Label>
                <Textarea id="revision-nota" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={2} maxLength={4000} />
              </div>
              {reviewMsg && (
                <p role={reviewMsg.tone === "error" ? "alert" : "status"} className={reviewMsg.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
                  {reviewMsg.text}
                </p>
              )}
              <Button type="submit" size="sm" className="self-start" disabled={reviewBusy || reviewTenderId === ""}>
                <Send />
                {reviewBusy ? "Enviando…" : "Pedir revisión"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

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
