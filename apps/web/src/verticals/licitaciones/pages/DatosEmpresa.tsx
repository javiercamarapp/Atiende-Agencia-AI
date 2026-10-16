// Datos de la empresa (Fase 16) — cierra el hallazgo de auditoría "las
// propuestas técnica y económica nunca pueden salir de PENDIENTE porque no
// existen endpoints para escribir/actualizar los datos de la empresa que
// esas propuestas necesitan". `CompanyDataService`
// (domain-licitaciones/src/company-data.ts) resuelve documentos/tarifas/
// capacidades/experiencia/firmantes contra estas 5 tablas -- sin esta
// pantalla, el único camino para capturarlas era un INSERT manual a la base
// de datos. Org-wide (sin `tenderId`), mismo alcance que PerfilMatching.tsx:
// una organización de licitaciones tiene UNA sola empresa (§2.1 del diseño).
//
// Capturar y editar es de los roles de escritura; APROBAR/RECHAZAR es una decisión (migración 036, REQ-044/064): nunca de quien
// propuso o editó por última vez, tarifas solo owner/admin con step-up, el resto DECISION_ROLES. `roles.ts` del dominio es la
// fuente de verdad; esta pantalla solo oculta/deshabilita lo que el servidor rechazaría igual. Editar un dato aprobado lo
// regresa a pendiente (y cambia el hash del perfil, que invalida la aprobación del expediente).
//
// Fase "sistema de diseño real" (contenido) — las 5 secciones apiladas pasan a
// `Tabs` reales (una pestaña por tabla: documentos/tarifas/capacidades/
// experiencia/firmantes), sus tarjetas a `Card`, los pills de aprobación a
// `Badge` y los inputs/botones a `Input`/`Label`/`Button` de @atiende/ui. Mismo
// estado, mismos fetch, mismas ramas de rol.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, PageContainer, StatusBadge, statusTone, Tabs, TabsContent, TabsList, TabsTrigger, useConfirm } from "@atiende/ui";
import {
  createApprovedRate,
  createCompanyCapability,
  createCompanyDocument,
  createCompanyExperience,
  createCompanySigner,
  fetchApprovedRates,
  fetchCompanyCapabilities,
  fetchCompanyDocuments,
  fetchCompanyExperience,
  fetchCompanySigners,
  updateCompanySigner,
} from "../lib/company-data-client.ts";
import { DecisionButtons, useCompanyDecision } from "../components/DecisionActions.tsx";
import { authorshipLine, userIdFromToken } from "../lib/company-decision.ts";
import { APROBACION_DATO_TONES } from "../lib/status-tones.ts";
import type { ApprovedRate, CompanyCapability, CompanyDataApprovalStatus, CompanyDocument, CompanyExperienceItem, CompanySigner } from "../lib/company-data-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

const APPROVAL_LABELS: Record<CompanyDataApprovalStatus, string> = { aprobado: "Aprobado", pendiente_aprobacion: "Pendiente de aprobación", rechazado: "Rechazado" };

/** "Propuso: Ana · Aprobó: Beto" (solo si la base ya trae autoría). */
function Autoria({ item, userId }: { item: Parameters<typeof authorshipLine>[0]; userId: string | null }) {
  const linea = authorshipLine(item, userId);
  return linea ? <div className="text-xs text-muted-foreground">{linea}</div> : null;
}

function ApprovalBadge({ status }: { status: CompanyDataApprovalStatus }) {
  return (
    <StatusBadge tone={statusTone(APROBACION_DATO_TONES, status)} className="whitespace-nowrap">
      {APPROVAL_LABELS[status]}
    </StatusBadge>
  );
}

/** `<input type="date">` no trae hora ni offset -- se completa con medianoche
 * y el offset real del navegador (mismo criterio EXACTO que
 * `Convocatorias.tsx::toIsoWithOffset`, REQ-LIC-001: nunca un huso asumido). */
function dateOnlyToIsoWithOffset(dateOnly: string): string {
  const d = new Date(`${dateOnly}T00:00:00`);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${dateOnly}T00:00:00${sign}${hh}:${mm}`;
}

function isoToDateOnly(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

/** Fila de una tabla de datos de empresa: contenido a la izquierda, estado +
 * acciones a la derecha. Antes era `rowStyle` inline. */
const FILA = "flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2 text-sm";
/** Formulario de alta al pie de cada sección. Antes era un `style` inline. */
const FORM_ALTA = "flex flex-wrap items-end gap-2 pt-1";

const TABS_VALIDAS: ReadonlySet<string> = new Set(["documentos", "tarifas", "capacidades", "experiencia", "firmantes"]);

export function DatosEmpresaPage({ apiBaseUrl, token, propertyId, role }: LicitacionesShellContext) {
  const canWrite = WRITE_ROLES.has(role);
  const { confirmar, dialogo } = useConfirm();
  const userId = userIdFromToken(token);
  // `?tab=firmantes` (etc.) abre directo esa pestaña -- lo usan /firmantes y el Panel; un valor desconocido cae a "documentos".
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tabInicial = tabParam && TABS_VALIDAS.has(tabParam) ? tabParam : "documentos";

  const [documents, setDocuments] = useState<readonly CompanyDocument[]>([]);
  const [rates, setRates] = useState<readonly ApprovedRate[]>([]);
  const [capabilities, setCapabilities] = useState<readonly CompanyCapability[]>([]);
  const [experience, setExperience] = useState<readonly CompanyExperienceItem[]>([]);
  const [signers, setSigners] = useState<readonly CompanySigner[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [docForm, setDocForm] = useState({ type: "", label: "", expiresAt: "" });
  const [rateForm, setRateForm] = useState({ concept: "", unitPrice: "" });
  const [capabilityForm, setCapabilityForm] = useState({ name: "", description: "" });
  const [experienceForm, setExperienceForm] = useState({ description: "", evidenceDocId: "" });
  const [signerForm, setSignerForm] = useState({ name: "", role: "" });
  const [submittingSection, setSubmittingSection] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [d, r, c, e, s] = await Promise.all([
        fetchCompanyDocuments(fetch, apiBaseUrl, token, propertyId),
        fetchApprovedRates(fetch, apiBaseUrl, token, propertyId),
        fetchCompanyCapabilities(fetch, apiBaseUrl, token, propertyId),
        fetchCompanyExperience(fetch, apiBaseUrl, token, propertyId),
        fetchCompanySigners(fetch, apiBaseUrl, token, propertyId),
      ]);
      setDocuments(d);
      setRates(r);
      setCapabilities(c);
      setExperience(e);
      setSigners(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los datos de la empresa.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel (Convocatorias.tsx) -- este
    // proyecto no tiene eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId]);

  async function withAction(section: string, action: () => Promise<void>) {
    setActionError(null);
    setSubmittingSection(section);
    try {
      await action();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo completar la operación.");
    } finally {
      setSubmittingSection(null);
    }
  }

  async function toggleSigner(s: CompanySigner) {
    // Revocar la autorización de un firmante es destructivo (sin firmante autorizado no se puede firmar una propuesta):
    // Cancelar / cerrar el diálogo NO la revoca.
    if (s.authorized) {
      const ok = await confirmar({
        titulo: `Revocar la autorización de ${s.name}`,
        descripcion: "Dejará de poder firmar propuestas. Puedes volver a autorizarlo después.",
        tono: "danger",
        confirmar: "Revocar autorización",
      });
      if (!ok) return;
    }
    await withAction(`signer-${s.id}`, () => updateCompanySigner(fetch, apiBaseUrl, token, propertyId, s.id, { authorized: !s.authorized }).then(() => undefined));
  }

  const decision = useCompanyDecision({ apiBaseUrl, token, propertyId, onChanged: load, onError: setActionError });
  const busy = submittingSection !== null;

  if (loading && documents.length === 0 && rates.length === 0) return <EstadoCargando etiqueta="Cargando datos de la empresa…" />;

  return (
    <PageContainer padding="none" size="md" className="gap-4 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Datos de la empresa</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Documentos, tarifas aprobadas, capacidades, experiencia y firmantes autorizados. Las propuestas técnica y económica solo usan lo que aquí está en estado "Aprobado" y vigente -- un dato ausente o sin aprobar queda "PENDIENTE" en la propuesta, nunca inventado.
          Quien captura o edita un dato no lo aprueba: lo decide otra persona con rol de decisión (las tarifas, además, con verificación en dos pasos). Editar un dato aprobado lo regresa a pendiente.
        </p>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      {!canWrite && <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede capturar datos de empresa. Se muestran de solo lectura.</p>}

      <Tabs defaultValue={tabInicial} className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="documentos">Documentos</TabsTrigger>
          <TabsTrigger value="tarifas">Tarifas</TabsTrigger>
          <TabsTrigger value="capacidades">Capacidades</TabsTrigger>
          <TabsTrigger value="experiencia">Experiencia</TabsTrigger>
          <TabsTrigger value="firmantes">Firmantes</TabsTrigger>
        </TabsList>

        {/* ---- Documentos ---- */}
        <TabsContent value="documentos">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Documentos</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              {documents.length === 0 && <EstadoVacio mensaje="Sin documentos capturados todavía." />}
              {documents.map((d) => (
                <div key={d.id} className={FILA}>
                  <div className="min-w-0 text-foreground">
                    <strong>{d.type}</strong> — {d.label}
                    {d.expiresAt && <span className="text-muted-foreground"> · vence {isoToDateOnly(d.expiresAt)}</span>}
                    <Autoria item={d} userId={userId} />
                  </div>
                  <div className="flex items-center gap-2">
                    <ApprovalBadge status={d.approvalStatus} />
                    <DecisionButtons kind="document" id={d.id} etiqueta={d.label} item={d} role={role} userId={userId} decision={decision} busy={busy} />
                  </div>
                </div>
              ))}
              {canWrite && (
                <form
                  className={FORM_ALTA}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void withAction("doc-new", async () => {
                      await createCompanyDocument(fetch, apiBaseUrl, token, propertyId, { type: docForm.type, label: docForm.label, expiresAt: docForm.expiresAt ? dateOnlyToIsoWithOffset(docForm.expiresAt) : null });
                      setDocForm({ type: "", label: "", expiresAt: "" });
                    });
                  }}
                >
                  <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="doc-tipo">Tipo</Label>
                    <Input id="doc-tipo" required placeholder="p. ej. opinion_cumplimiento" value={docForm.type} onChange={(e) => setDocForm({ ...docForm, type: e.target.value })} />
                  </div>
                  <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="doc-etiqueta">Etiqueta</Label>
                    <Input id="doc-etiqueta" required placeholder="Etiqueta" value={docForm.label} onChange={(e) => setDocForm({ ...docForm, label: e.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="doc-vigencia">Vigencia (opcional)</Label>
                    <Input id="doc-vigencia" type="date" value={docForm.expiresAt} onChange={(e) => setDocForm({ ...docForm, expiresAt: e.target.value })} />
                  </div>
                  <Button type="submit" size="sm" disabled={submittingSection !== null}>
                    <Plus />
                    {submittingSection === "doc-new" ? "Guardando…" : "Agregar documento"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Tarifas aprobadas ---- */}
        <TabsContent value="tarifas">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tarifas aprobadas</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              {rates.length === 0 && <EstadoVacio mensaje="Sin tarifas capturadas todavía -- la propuesta económica no puede generar ningún total sin al menos una." />}
              {rates.map((r) => (
                <div key={r.id} className={FILA}>
                  <div className="min-w-0 text-foreground">
                    <strong>{r.concept}</strong> — ${r.unitPrice} {r.currency}
                    <span className="text-muted-foreground">
                      {" "}
                      · vigente desde {isoToDateOnly(r.validFrom)}
                      {r.validUntil ? ` hasta ${isoToDateOnly(r.validUntil)}` : ""}
                    </span>
                    <Autoria item={r} userId={userId} />
                  </div>
                  <div className="flex items-center gap-2">
                    <ApprovalBadge status={r.approvalStatus} />
                    <DecisionButtons kind="rate" id={r.id} etiqueta={r.concept} item={r} role={role} userId={userId} decision={decision} busy={busy} />
                  </div>
                </div>
              ))}
              {canWrite && (
                <form
                  className={FORM_ALTA}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void withAction("rate-new", async () => {
                      await createApprovedRate(fetch, apiBaseUrl, token, propertyId, { concept: rateForm.concept, unitPrice: rateForm.unitPrice });
                      setRateForm({ concept: "", unitPrice: "" });
                    });
                  }}
                >
                  <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="tarifa-concepto">Concepto</Label>
                    <Input id="tarifa-concepto" required placeholder="p. ej. consultoria_hora" value={rateForm.concept} onChange={(e) => setRateForm({ ...rateForm, concept: e.target.value })} />
                  </div>
                  <div className="flex min-w-[160px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="tarifa-precio">Precio unitario</Label>
                    <Input id="tarifa-precio" required placeholder="p. ej. 500.00" value={rateForm.unitPrice} onChange={(e) => setRateForm({ ...rateForm, unitPrice: e.target.value })} />
                  </div>
                  <Button type="submit" size="sm" disabled={submittingSection !== null}>
                    <Plus />
                    {submittingSection === "rate-new" ? "Guardando…" : "Agregar tarifa"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Capacidades ---- */}
        <TabsContent value="capacidades">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Capacidades</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              {capabilities.length === 0 && <EstadoVacio mensaje="Sin capacidades capturadas todavía." />}
              {capabilities.map((cap) => (
                <div key={cap.id} className={FILA}>
                  <div className="min-w-0 text-foreground">
                    <strong>{cap.name}</strong> — {cap.description}
                    <Autoria item={cap} userId={userId} />
                  </div>
                  <div className="flex items-center gap-2">
                    <ApprovalBadge status={cap.approvalStatus} />
                    <DecisionButtons kind="capability" id={cap.id} etiqueta={cap.name} item={cap} role={role} userId={userId} decision={decision} busy={busy} />
                  </div>
                </div>
              ))}
              {canWrite && (
                <form
                  className={FORM_ALTA}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void withAction("cap-new", async () => {
                      await createCompanyCapability(fetch, apiBaseUrl, token, propertyId, { name: capabilityForm.name, description: capabilityForm.description });
                      setCapabilityForm({ name: "", description: "" });
                    });
                  }}
                >
                  <div className="flex min-w-[180px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="cap-nombre">Nombre</Label>
                    <Input id="cap-nombre" required placeholder="Nombre" value={capabilityForm.name} onChange={(e) => setCapabilityForm({ ...capabilityForm, name: e.target.value })} />
                  </div>
                  <div className="flex min-w-[260px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="cap-descripcion">Descripción</Label>
                    <Input id="cap-descripcion" required placeholder="Descripción" value={capabilityForm.description} onChange={(e) => setCapabilityForm({ ...capabilityForm, description: e.target.value })} />
                  </div>
                  <Button type="submit" size="sm" disabled={submittingSection !== null}>
                    <Plus />
                    {submittingSection === "cap-new" ? "Guardando…" : "Agregar capacidad"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Experiencia ---- */}
        <TabsContent value="experiencia">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Experiencia</CardTitle>
              <CardDescription>
                El ID de evidencia debe corresponder a un documento ya capturado en la pestaña "Documentos" -- sin uno real, la experiencia queda bloqueada como "evidencia_no_verificable" al generar la propuesta.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              {experience.length === 0 && <EstadoVacio mensaje="Sin experiencia capturada todavía." />}
              {experience.map((exp) => (
                <div key={exp.id} className={FILA}>
                  <div className="min-w-0 text-foreground">
                    {exp.description} <span className="text-muted-foreground">· evidencia: {exp.evidenceDocId}</span>
                    <Autoria item={exp} userId={userId} />
                  </div>
                  <div className="flex items-center gap-2">
                    <ApprovalBadge status={exp.approvalStatus} />
                    <DecisionButtons kind="experience" id={exp.id} etiqueta={exp.description} item={exp} role={role} userId={userId} decision={decision} busy={busy} />
                  </div>
                </div>
              ))}
              {canWrite && (
                <form
                  className={FORM_ALTA}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void withAction("exp-new", async () => {
                      await createCompanyExperience(fetch, apiBaseUrl, token, propertyId, { description: experienceForm.description, evidenceDocId: experienceForm.evidenceDocId });
                      setExperienceForm({ description: "", evidenceDocId: "" });
                    });
                  }}
                >
                  <div className="flex min-w-[260px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="exp-descripcion">Descripción del proyecto/experiencia</Label>
                    <Input id="exp-descripcion" required placeholder="Descripción del proyecto/experiencia" value={experienceForm.description} onChange={(e) => setExperienceForm({ ...experienceForm, description: e.target.value })} />
                  </div>
                  <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="exp-evidencia">ID del documento de evidencia</Label>
                    <Input id="exp-evidencia" required placeholder="ID del documento de evidencia" value={experienceForm.evidenceDocId} onChange={(e) => setExperienceForm({ ...experienceForm, evidenceDocId: e.target.value })} />
                  </div>
                  <Button type="submit" size="sm" disabled={submittingSection !== null}>
                    <Plus />
                    {submittingSection === "exp-new" ? "Guardando…" : "Agregar experiencia"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Firmantes autorizados ---- */}
        <TabsContent value="firmantes">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Firmantes autorizados</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              {signers.length === 0 && <EstadoVacio mensaje="Sin firmantes capturados todavía." />}
              {signers.map((s) => (
                <div key={s.id} className={FILA}>
                  <div className="min-w-0 text-foreground">
                    <strong>{s.name}</strong> — {s.role}
                    <Autoria item={{ ...s, approvalStatus: s.approvalStatus ?? "aprobado" }} userId={userId} />
                  </div>
                  <div className="flex items-center gap-2">
                    <ApprovalBadge status={s.approvalStatus ?? "aprobado"} />
                    <StatusBadge tone={s.authorized ? "success" : "danger"}>{s.authorized ? "Autorizado" : "No autorizado"}</StatusBadge>
                    <DecisionButtons kind="signer" id={s.id} etiqueta={s.name} item={{ ...s, approvalStatus: s.approvalStatus ?? "aprobado" }} role={role} userId={userId} decision={decision} busy={busy} />
                    {canWrite && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className={s.authorized ? "text-destructive" : undefined}
                        disabled={submittingSection !== null}
                        onClick={() => void toggleSigner(s)}
                      >
                        {s.authorized ? "Revocar" : "Autorizar"}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {canWrite && (
                <form
                  className={FORM_ALTA}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void withAction("signer-new", async () => {
                      await createCompanySigner(fetch, apiBaseUrl, token, propertyId, { name: signerForm.name, role: signerForm.role, authorized: true });
                      setSignerForm({ name: "", role: "" });
                    });
                  }}
                >
                  <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="firmante-nombre">Nombre</Label>
                    <Input id="firmante-nombre" required placeholder="Nombre" value={signerForm.name} onChange={(e) => setSignerForm({ ...signerForm, name: e.target.value })} />
                  </div>
                  <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="firmante-rol">Rol</Label>
                    <Input id="firmante-rol" required placeholder="p. ej. representante_legal" value={signerForm.role} onChange={(e) => setSignerForm({ ...signerForm, role: e.target.value })} />
                  </div>
                  <Button type="submit" size="sm" disabled={submittingSection !== null}>
                    <Plus />
                    {submittingSection === "signer-new" ? "Guardando…" : "Agregar firmante (autorizado)"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      {dialogo}
      {decision.dialogo}
    </PageContainer>
  );
}
