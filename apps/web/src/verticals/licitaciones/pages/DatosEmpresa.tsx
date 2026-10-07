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
// L-P3-03/04 (REQ-141/142/109/145): el perfil se completa con General (razón social, RFC, sector, trabajadores, ventas + estratificación
// MIPyME pendiente de verificación legal), Productos y servicios, Ubicaciones, Socios y Restricciones (ColeccionPerfil.tsx), y los firmantes
// llevan vigencia del poder con semáforo, documento de identidad y límites de actuación. Cada dato muestra quién lo capturó y cuándo
// (procedencia); un dato del perfil sin procedencia se declara bloqueado. Con la base sin la migración 040 esas pestañas dicen "no disponible aún".
//
// Fase "sistema de diseño real" (contenido) — las 5 secciones apiladas pasan a
// `Tabs` reales (una pestaña por tabla: documentos/tarifas/capacidades/
// experiencia/firmantes), sus tarjetas a `Card`, los pills de aprobación a
// `Badge` y los inputs/botones a `Input`/`Label`/`Button` de @atiende/ui. Mismo
// estado, mismos fetch, mismas ramas de rol.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer, StatusBadge, statusTone, Tabs, TabsContent, TabsList, TabsTrigger, useConfirm } from "@atiende/ui";
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
  fetchCompanySignersView,
  updateCompanySigner,
} from "../lib/company-data-client.ts";
import { DecisionButtons, useCompanyDecision } from "../components/DecisionActions.tsx";
import { ColeccionPerfil } from "../components/ColeccionPerfil.tsx";
import type { CampoDef } from "../components/ColeccionPerfil.tsx";
import { PerfilGeneral } from "../components/PerfilGeneral.tsx";
import { ProcedenciaLinea } from "../components/ProcedenciaLinea.tsx";
import { hoyLocal, PODER_LABEL, PODER_TONE, poderEstado } from "../lib/firmante-poder.ts";
import type { CompanyLocation, CompanyProductService, CompanyRestriction, CompanyStakeholder } from "../lib/company-profile-client.ts";
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

const TABS_VALIDAS: ReadonlySet<string> = new Set(["general", "productos", "ubicaciones", "socios", "restricciones", "documentos", "tarifas", "capacidades", "experiencia", "firmantes"]);

const KIND_PRODUCTO = [{ value: "servicio", label: "Servicio" }, { value: "producto", label: "Producto" }] as const;
const KIND_UBICACION = [{ value: "matriz", label: "Matriz" }, { value: "sucursal", label: "Sucursal" }, { value: "bodega", label: "Bodega" }, { value: "planta", label: "Planta" }] as const;
const KIND_RESTRICCION = [
  { value: "sancion", label: "Sanción" },
  { value: "inhabilitacion", label: "Inhabilitación" },
  { value: "conflicto_interes", label: "Conflicto de interés" },
  { value: "otra", label: "Otra" },
] as const;
const KIND_SOCIO = [{ value: "socio", label: "Socio" }, { value: "representante", label: "Representante" }] as const;
const labelDe = (opciones: ReadonlyArray<{ value: string; label: string }>, value: string) => opciones.find((o) => o.value === value)?.label ?? value;

const CAMPOS_PRODUCTOS: readonly CampoDef[] = [
  { key: "kind", label: "Tipo", tipo: "select", requerido: true, opciones: KIND_PRODUCTO, soloAlta: true },
  { key: "name", label: "Nombre", tipo: "texto", requerido: true, placeholder: "p. ej. Mantenimiento de flotilla" },
  { key: "description", label: "Descripción", tipo: "texto" },
  { key: "classifierCode", label: "Clasificador (CPV/CUCoP)", tipo: "texto", placeholder: "p. ej. 50111100" },
];
const CAMPOS_UBICACIONES: readonly CampoDef[] = [
  { key: "kind", label: "Tipo", tipo: "select", requerido: true, opciones: KIND_UBICACION },
  { key: "name", label: "Nombre", tipo: "texto", requerido: true, placeholder: "p. ej. Oficinas centrales" },
  { key: "state", label: "Entidad federativa", tipo: "texto", requerido: true, placeholder: "p. ej. Yucatán" },
  { key: "municipality", label: "Municipio", tipo: "texto" },
  { key: "address", label: "Domicilio", tipo: "texto" },
];
const CAMPOS_RESTRICCIONES: readonly CampoDef[] = [
  { key: "kind", label: "Tipo", tipo: "select", requerido: true, opciones: KIND_RESTRICCION },
  { key: "description", label: "Descripción", tipo: "texto", requerido: true },
  { key: "validFrom", label: "Vigente desde", tipo: "fecha", requerido: true },
  { key: "validUntil", label: "Vigente hasta", tipo: "fecha", ayuda: "Vacío = sin fecha de término conocida." },
];
const CAMPOS_SOCIOS: readonly CampoDef[] = [
  { key: "kind", label: "Tipo", tipo: "select", requerido: true, opciones: KIND_SOCIO, soloAlta: true },
  { key: "fullName", label: "Nombre completo o razón social", tipo: "texto", requerido: true },
  { key: "rfc", label: "RFC", tipo: "texto", placeholder: "p. ej. PEPA800101AB1" },
  { key: "participationPct", label: "Participación (%)", tipo: "texto", requerido: true, placeholder: "p. ej. 33.33", visible: (f) => f.kind === "socio", ayuda: "De 0 a 100 con dos decimales; la suma de los socios no pasa de 100." },
];

export function DatosEmpresaPage({ apiBaseUrl, token, propertyId, role }: LicitacionesShellContext) {
  const canWrite = WRITE_ROLES.has(role);
  const { confirmar, pedirTexto, dialogo } = useConfirm();
  const hoy = hoyLocal();
  const userId = userIdFromToken(token);
  // `?tab=firmantes` (etc.) abre directo esa pestaña -- lo usan /firmantes y el Panel; un valor desconocido cae a "documentos".
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tabInicial = tabParam && TABS_VALIDAS.has(tabParam) ? tabParam : "general";

  const [documents, setDocuments] = useState<readonly CompanyDocument[]>([]);
  const [rates, setRates] = useState<readonly ApprovedRate[]>([]);
  const [capabilities, setCapabilities] = useState<readonly CompanyCapability[]>([]);
  const [experience, setExperience] = useState<readonly CompanyExperienceItem[]>([]);
  const [signers, setSigners] = useState<readonly CompanySigner[]>([]);
  // La base ya soporta la vigencia del poder (migracion 040). Sin ella el formulario de firmantes no la ofrece.
  const [vigenciaDisponible, setVigenciaDisponible] = useState(false);
  // Sube cuando una decision o un cambio de las pestañas del perfil obliga a recargarlas.
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [docForm, setDocForm] = useState({ type: "", label: "", expiresAt: "" });
  const [rateForm, setRateForm] = useState({ concept: "", unitPrice: "" });
  const [capabilityForm, setCapabilityForm] = useState({ name: "", description: "" });
  const [experienceForm, setExperienceForm] = useState({ description: "", evidenceDocId: "" });
  const [signerForm, setSignerForm] = useState({ name: "", role: "", validFrom: "", validUntil: "", identityDocId: "", actionLimits: "" });
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
        fetchCompanySignersView(fetch, apiBaseUrl, token, propertyId),
      ]);
      setDocuments(d);
      setRates(r);
      setCapabilities(c);
      setExperience(e);
      setSigners(s.signers);
      setVigenciaDisponible(s.vigenciaDisponible);
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

  const busy = submittingSection !== null;
  const recargarTodo = async () => {
    await load();
    setRefreshKey((k) => k + 1);
  };
  const decision = useCompanyDecision({ apiBaseUrl, token, propertyId, onChanged: recargarTodo, onError: setActionError });
  const comunes = { apiBaseUrl, token, propertyId, role, userId, canWrite, decision, confirmar, refreshKey, onChanged: () => setRefreshKey((k) => k + 1), busy };

  async function renovarPoder(s: CompanySigner) {
    const texto = await pedirTexto({
      titulo: `Renovar el poder de ${s.name}`,
      descripcion: "Escribe la nueva fecha en que vence el poder. Queda pendiente de aprobación otra vez.",
      confirmar: "Renovar poder",
      campo: { etiqueta: "Vence el (AAAA-MM-DD)", placeholder: "p. ej. 2027-12-31", requerido: true, validar: (v) => (/^\d{4}-\d{2}-\d{2}$/u.test(v.trim()) ? null : "Escribe la fecha como AAAA-MM-DD.") },
    });
    if (texto === null) return;
    await withAction(`signer-${s.id}`, () => updateCompanySigner(fetch, apiBaseUrl, token, propertyId, s.id, { validUntil: texto.trim() }).then(() => undefined));
  }

  if (loading && documents.length === 0 && rates.length === 0) return <EstadoCargando etiqueta="Cargando datos de la empresa…" />;

  return (
    <PageContainer padding="none" size="md" className="gap-4 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Datos de la empresa</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Perfil general, productos y servicios, ubicaciones, socios, restricciones, documentos, tarifas aprobadas, capacidades, experiencia y firmantes con la vigencia de su poder. Las propuestas técnica y económica solo usan lo que aquí está en estado "Aprobado" y vigente -- un dato ausente, sin aprobar o sin procedencia queda "PENDIENTE" o bloqueado en la propuesta, nunca inventado.
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
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="productos">Productos y servicios</TabsTrigger>
          <TabsTrigger value="ubicaciones">Ubicaciones</TabsTrigger>
          <TabsTrigger value="socios">Socios</TabsTrigger>
          <TabsTrigger value="restricciones">Restricciones</TabsTrigger>
          <TabsTrigger value="documentos">Documentos</TabsTrigger>
          <TabsTrigger value="tarifas">Tarifas</TabsTrigger>
          <TabsTrigger value="capacidades">Capacidades</TabsTrigger>
          <TabsTrigger value="experiencia">Experiencia</TabsTrigger>
          <TabsTrigger value="firmantes">Firmantes</TabsTrigger>
        </TabsList>

        {/* ---- General (perfil + MIPyME) ---- */}
        <TabsContent value="general">
          <PerfilGeneral {...comunes} />
        </TabsContent>

        {/* ---- Productos y servicios ---- */}
        <TabsContent value="productos">
          <ColeccionPerfil
            {...comunes}
            name="products"
            kind="product"
            titulo="Productos y servicios"
            descripcion="Lo que la empresa vende. Alimenta el expediente y, con el clasificador, la búsqueda de convocatorias."
            vacio="Aún no capturas productos ni servicios. Agrega el primero abajo: nombre, tipo y, si lo conoces, su clasificador."
            campos={CAMPOS_PRODUCTOS}
            singular="producto o servicio"
            canDelete={canWrite}
            etiqueta={(i: CompanyProductService) => i.name}
            resumen={(i: CompanyProductService) => (
              <>
                <strong>{i.name}</strong> — {labelDe(KIND_PRODUCTO, i.kind)}
                {i.classifierCode && <span className="text-muted-foreground"> · clasificador {i.classifierCode}</span>}
                {i.description && <div className="text-xs text-muted-foreground">{i.description}</div>}
              </>
            )}
          />
        </TabsContent>

        {/* ---- Ubicaciones ---- */}
        <TabsContent value="ubicaciones">
          <ColeccionPerfil
            {...comunes}
            name="locations"
            kind="location"
            titulo="Ubicaciones"
            descripcion="Matriz, sucursales, bodegas y plantas. Muchas convocatorias exigen domicilio o presencia en una entidad."
            vacio="Aún no capturas ubicaciones. Agrega la matriz abajo: nombre y entidad federativa."
            campos={CAMPOS_UBICACIONES}
            singular="ubicación"
            canDelete={canWrite}
            etiqueta={(i: CompanyLocation) => i.name}
            resumen={(i: CompanyLocation) => (
              <>
                <strong>{i.name}</strong> — {labelDe(KIND_UBICACION, i.kind)} · {i.state}
                {i.municipality && <span className="text-muted-foreground"> · {i.municipality}</span>}
                {i.address && <div className="text-xs text-muted-foreground">{i.address}</div>}
              </>
            )}
          />
        </TabsContent>

        {/* ---- Socios y representantes ---- */}
        <TabsContent value="socios">
          <ColeccionPerfil
            {...comunes}
            name="stakeholders"
            kind="stakeholder"
            titulo="Socios y representantes"
            descripcion="Quién es dueño y quién representa a la empresa. Es la base para detectar interpósita persona. Eliminar un socio o representante lo decide un rol de decisión."
            vacio="Aún no capturas socios ni representantes. Agrega a cada socio con su RFC y su participación."
            campos={CAMPOS_SOCIOS}
            singular="socio o representante"
            canDelete={canWrite && ["owner", "admin", "analyst"].includes(role)}
            etiqueta={(i: CompanyStakeholder) => i.fullName}
            resumen={(i: CompanyStakeholder) => (
              <>
                <strong>{i.fullName}</strong> — {labelDe(KIND_SOCIO, i.kind)}
                {i.participationPct !== null && <span className="text-muted-foreground"> · {i.participationPct}%</span>}
                {i.rfc && <span className="text-muted-foreground"> · {i.rfc}</span>}
              </>
            )}
          />
        </TabsContent>

        {/* ---- Restricciones ---- */}
        <TabsContent value="restricciones">
          <ColeccionPerfil
            {...comunes}
            name="restrictions"
            kind="restriction"
            titulo="Restricciones"
            descripcion="Sanciones, inhabilitaciones y conflictos de interés vigentes. Una sanción o inhabilitación aprobada y con procedencia vuelve no elegible a la empresa en el matching. Eliminar una restricción lo decide un rol de decisión."
            vacio="No hay restricciones capturadas. Si la empresa no tiene ninguna, no hace falta capturar nada; si tiene una, regístrala con su vigencia."
            campos={CAMPOS_RESTRICCIONES}
            singular="restricción"
            canDelete={canWrite && ["owner", "admin", "analyst"].includes(role)}
            etiqueta={(i: CompanyRestriction) => labelDe(KIND_RESTRICCION, i.kind)}
            resumen={(i: CompanyRestriction) => (
              <>
                <strong>{labelDe(KIND_RESTRICCION, i.kind)}</strong> — {i.description}
                <span className="text-muted-foreground">
                  {" "}
                  · desde {i.validFrom}
                  {i.validUntil ? ` hasta ${i.validUntil}` : " (sin fecha de término)"}
                </span>
              </>
            )}
          />
        </TabsContent>

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
              <CardDescription>
                Puede haber varios firmantes por cargo. Cada uno declara desde cuándo y hasta cuándo rige su poder: la propuesta usa al que esté vigente en la fecha límite de la convocatoria, no a la de hoy. Si ninguno lo está, el requisito queda pendiente.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              {!vigenciaDisponible && signers.length > 0 && (
                <p className="text-xs text-muted-foreground">No disponible aún: la vigencia del poder requiere la migración 040 en tu base de datos. Mientras tanto los firmantes se usan sin evaluar vigencia.</p>
              )}
              {signers.length === 0 && <EstadoVacio mensaje="Aún no registras firmantes. Agrega al representante legal con la vigencia de su poder para poder firmar propuestas." compacto />}
              {signers.map((s) => {
                const estado = vigenciaDisponible || s.validFrom !== undefined ? poderEstado(s.validFrom, s.validUntil, hoy) : null;
                const documento = s.identityDocId ? documents.find((d) => d.id === s.identityDocId) : undefined;
                return (
                  <div key={s.id} className={FILA}>
                    <div className="min-w-0 text-foreground">
                      <strong>{s.name}</strong> — {s.role}
                      {estado && estado !== "sin_vigencia" && (
                        <div className="text-xs text-muted-foreground">
                          Poder desde {s.validFrom}
                          {s.validUntil ? ` hasta ${s.validUntil}` : " (sin fecha de vencimiento)"}
                          {documento ? ` · documento: ${documento.label}` : ""}
                        </div>
                      )}
                      {s.actionLimits && <div className="text-xs text-muted-foreground">Límites de actuación: {s.actionLimits}</div>}
                      <Autoria item={{ ...s, approvalStatus: s.approvalStatus ?? "aprobado" }} userId={userId} />
                      <ProcedenciaLinea item={s} userId={userId} />
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {estado && <StatusBadge tone={PODER_TONE[estado]}>{PODER_LABEL[estado]}</StatusBadge>}
                      <ApprovalBadge status={s.approvalStatus ?? "aprobado"} />
                      <StatusBadge tone={s.authorized ? "success" : "danger"}>{s.authorized ? "Autorizado" : "No autorizado"}</StatusBadge>
                      <DecisionButtons kind="signer" id={s.id} etiqueta={s.name} item={{ ...s, approvalStatus: s.approvalStatus ?? "aprobado" }} role={role} userId={userId} decision={decision} busy={busy} />
                      {canWrite && vigenciaDisponible && (
                        <Button type="button" variant="outline" size="sm" disabled={submittingSection !== null} onClick={() => void renovarPoder(s)}>
                          Renovar poder
                        </Button>
                      )}
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
                );
              })}
              {canWrite && (
                <form
                  className={FORM_ALTA}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void withAction("signer-new", async () => {
                      await createCompanySigner(fetch, apiBaseUrl, token, propertyId, {
                        name: signerForm.name,
                        role: signerForm.role,
                        authorized: true,
                        ...(vigenciaDisponible
                          ? {
                              validFrom: signerForm.validFrom,
                              validUntil: signerForm.validUntil || null,
                              identityDocId: signerForm.identityDocId || null,
                              actionLimits: signerForm.actionLimits.trim() || null,
                            }
                          : {}),
                      });
                      setSignerForm({ name: "", role: "", validFrom: "", validUntil: "", identityDocId: "", actionLimits: "" });
                    });
                  }}
                >
                  <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="firmante-nombre">Nombre</Label>
                    <Input id="firmante-nombre" required placeholder="Nombre" value={signerForm.name} onChange={(e) => setSignerForm({ ...signerForm, name: e.target.value })} />
                  </div>
                  <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                    <Label htmlFor="firmante-rol">Cargo</Label>
                    <Input id="firmante-rol" required placeholder="p. ej. representante_legal" value={signerForm.role} onChange={(e) => setSignerForm({ ...signerForm, role: e.target.value })} />
                  </div>
                  {vigenciaDisponible && (
                    <>
                      <div className="flex min-w-[160px] flex-col gap-1.5">
                        <Label htmlFor="firmante-desde">Poder vigente desde</Label>
                        <Input id="firmante-desde" type="date" required value={signerForm.validFrom} onChange={(e) => setSignerForm({ ...signerForm, validFrom: e.target.value })} />
                      </div>
                      <div className="flex min-w-[160px] flex-col gap-1.5">
                        <Label htmlFor="firmante-hasta">Vigente hasta (opcional)</Label>
                        <Input id="firmante-hasta" type="date" value={signerForm.validUntil} onChange={(e) => setSignerForm({ ...signerForm, validUntil: e.target.value })} />
                      </div>
                      <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                        <Label htmlFor="firmante-documento">Documento de identidad o poder (opcional)</Label>
                        <NativeSelect id="firmante-documento" value={signerForm.identityDocId} onChange={(e) => setSignerForm({ ...signerForm, identityDocId: e.target.value })}>
                          <option value="">Sin documento</option>
                          {documents.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.label}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                      <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                        <Label htmlFor="firmante-limites">Límites de actuación (opcional)</Label>
                        <Input id="firmante-limites" placeholder="p. ej. contratos hasta 5 millones" value={signerForm.actionLimits} onChange={(e) => setSignerForm({ ...signerForm, actionLimits: e.target.value })} />
                      </div>
                    </>
                  )}
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
