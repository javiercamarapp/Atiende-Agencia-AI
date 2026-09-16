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
// Aprobar/rechazar un dato es corrección de captura (mismo criterio que el
// servidor, `companyData.ts`: WRITE_ROLES, nunca DECISION_ROLES) -- la
// decisión de riesgo real es a qué requisito se mapea ese dato
// (`PropuestaTecnica.tsx::requirement-mappings`, DECISION_ROLES).
//
// Fase "sistema de diseño real" (contenido) — las 5 secciones apiladas pasan a
// `Tabs` reales (una pestaña por tabla: documentos/tarifas/capacidades/
// experiencia/firmantes), sus tarjetas a `Card`, los pills de aprobación a
// `Badge` y los inputs/botones a `Input`/`Label`/`Button` de @atiende/ui. Mismo
// estado, mismos fetch, mismas ramas de rol.
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
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
  updateApprovedRate,
  updateCompanyCapability,
  updateCompanyDocument,
  updateCompanyExperience,
  updateCompanySigner,
} from "../lib/company-data-client.ts";
import type { ApprovedRate, CompanyCapability, CompanyDataApprovalStatus, CompanyDocument, CompanyExperienceItem, CompanySigner } from "../lib/company-data-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

const APPROVAL_BADGE: Record<CompanyDataApprovalStatus, { variant: "default" | "secondary" | "destructive" | "outline"; className?: string; label: string }> = {
  aprobado: { variant: "default", label: "Aprobado" },
  pendiente_aprobacion: { variant: "outline", className: "border-amber-500/60 text-amber-600 dark:text-amber-400", label: "Pendiente de aprobación" },
  rechazado: { variant: "destructive", label: "Rechazado" },
};

function ApprovalBadge({ status }: { status: CompanyDataApprovalStatus }) {
  const c = APPROVAL_BADGE[status];
  return (
    <Badge variant={c.variant} className={c.className ? `${c.className} whitespace-nowrap` : "whitespace-nowrap"}>
      {c.label}
    </Badge>
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
const FILA = "flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2 text-[13px]";
/** Formulario de alta al pie de cada sección. Antes era un `style` inline. */
const FORM_ALTA = "flex flex-wrap items-end gap-2 pt-1";

export function DatosEmpresaPage({ apiBaseUrl, token, propertyId, role }: LicitacionesShellContext) {
  const canWrite = WRITE_ROLES.has(role);

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

  if (loading && documents.length === 0 && rates.length === 0) return <EstadoCargando etiqueta="Cargando datos de la empresa…" />;

  return (
    <div className="flex max-w-[860px] flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-foreground">Datos de la empresa</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Documentos, tarifas aprobadas, capacidades, experiencia y firmantes autorizados. Las propuestas técnica y económica solo usan lo que aquí está en estado "Aprobado" y vigente -- un dato ausente o sin aprobar queda "PENDIENTE" en la propuesta, nunca inventado.
        </p>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {actionError && (
        <p role="alert" className="text-[13px] text-destructive">
          {actionError}
        </p>
      )}
      {!canWrite && <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede capturar ni aprobar datos de empresa. Se muestran de solo lectura.</p>}

      <Tabs defaultValue="documentos" className="w-full">
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
                  </div>
                  <div className="flex items-center gap-2">
                    <ApprovalBadge status={d.approvalStatus} />
                    {canWrite && d.approvalStatus !== "aprobado" && (
                      <Button type="button" variant="outline" size="sm" disabled={submittingSection !== null} onClick={() => void withAction(`doc-${d.id}`, () => updateCompanyDocument(fetch, apiBaseUrl, token, propertyId, d.id, { approvalStatus: "aprobado" }).then(() => undefined))}>
                        Aprobar
                      </Button>
                    )}
                    {canWrite && d.approvalStatus !== "rechazado" && (
                      <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={submittingSection !== null} onClick={() => void withAction(`doc-${d.id}`, () => updateCompanyDocument(fetch, apiBaseUrl, token, propertyId, d.id, { approvalStatus: "rechazado" }).then(() => undefined))}>
                        Rechazar
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
                  </div>
                  <div className="flex items-center gap-2">
                    <ApprovalBadge status={r.approvalStatus} />
                    {canWrite && r.approvalStatus !== "aprobado" && (
                      <Button type="button" variant="outline" size="sm" disabled={submittingSection !== null} onClick={() => void withAction(`rate-${r.id}`, () => updateApprovedRate(fetch, apiBaseUrl, token, propertyId, r.id, { approvalStatus: "aprobado" }).then(() => undefined))}>
                        Aprobar
                      </Button>
                    )}
                    {canWrite && r.approvalStatus !== "rechazado" && (
                      <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={submittingSection !== null} onClick={() => void withAction(`rate-${r.id}`, () => updateApprovedRate(fetch, apiBaseUrl, token, propertyId, r.id, { approvalStatus: "rechazado" }).then(() => undefined))}>
                        Rechazar
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
                  </div>
                  <div className="flex items-center gap-2">
                    <ApprovalBadge status={cap.approvalStatus} />
                    {canWrite && cap.approvalStatus !== "aprobado" && (
                      <Button type="button" variant="outline" size="sm" disabled={submittingSection !== null} onClick={() => void withAction(`cap-${cap.id}`, () => updateCompanyCapability(fetch, apiBaseUrl, token, propertyId, cap.id, { approvalStatus: "aprobado" }).then(() => undefined))}>
                        Aprobar
                      </Button>
                    )}
                    {canWrite && cap.approvalStatus !== "rechazado" && (
                      <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={submittingSection !== null} onClick={() => void withAction(`cap-${cap.id}`, () => updateCompanyCapability(fetch, apiBaseUrl, token, propertyId, cap.id, { approvalStatus: "rechazado" }).then(() => undefined))}>
                        Rechazar
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
                  </div>
                  <div className="flex items-center gap-2">
                    <ApprovalBadge status={exp.approvalStatus} />
                    {canWrite && exp.approvalStatus !== "aprobado" && (
                      <Button type="button" variant="outline" size="sm" disabled={submittingSection !== null} onClick={() => void withAction(`exp-${exp.id}`, () => updateCompanyExperience(fetch, apiBaseUrl, token, propertyId, exp.id, { approvalStatus: "aprobado" }).then(() => undefined))}>
                        Aprobar
                      </Button>
                    )}
                    {canWrite && exp.approvalStatus !== "rechazado" && (
                      <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={submittingSection !== null} onClick={() => void withAction(`exp-${exp.id}`, () => updateCompanyExperience(fetch, apiBaseUrl, token, propertyId, exp.id, { approvalStatus: "rechazado" }).then(() => undefined))}>
                        Rechazar
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
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={s.authorized ? "default" : "destructive"}>{s.authorized ? "Autorizado" : "No autorizado"}</Badge>
                    {canWrite && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className={s.authorized ? "text-destructive" : undefined}
                        disabled={submittingSection !== null}
                        onClick={() => void withAction(`signer-${s.id}`, () => updateCompanySigner(fetch, apiBaseUrl, token, propertyId, s.id, { authorized: !s.authorized }).then(() => undefined))}
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
    </div>
  );
}
