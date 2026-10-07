// Perfil general de la empresa (REQ-141) + estratificacion MIPyME (REQ-109). Uno por organizacion: razon social, RFC (el servidor lo valida y
// normaliza), nombre comercial, sector, año de fundacion, trabajadores, ventas anuales y sitio. La estratificacion la calcula el SERVIDOR con
// las cifras de la ficha del registro normativo, que hoy esta SIN VERIFICAR: la pantalla lo dice ("pendiente de verificacion legal") y no
// la presenta como constancia. Sin los datos necesarios dice cuales faltan; nunca inventa un estrato.
import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, StatusBadge, statusTone } from "@atiende/ui";
import { fetchCompanyProfile, MIPYME_SECTOR_LABEL, saveCompanyProfile } from "../lib/company-profile-client.ts";
import type { CompanyProfile, CompanyProfileView, MipymeEstrato, MipymeSector } from "../lib/company-profile-client.ts";
import type { CompanyDataApprovalStatus } from "../lib/company-data-client.ts";
import { authorshipLine } from "../lib/company-decision.ts";
import { formatCentavos, pesosACentavos } from "../lib/firmante-poder.ts";
import { APROBACION_DATO_TONES } from "../lib/status-tones.ts";
import { DecisionButtons } from "./DecisionActions.tsx";
import type { useCompanyDecision } from "./DecisionActions.tsx";
import { ProcedenciaLinea } from "./ProcedenciaLinea.tsx";

const APPROVAL_LABELS: Record<CompanyDataApprovalStatus, string> = { aprobado: "Aprobado", pendiente_aprobacion: "Pendiente de aprobación", rechazado: "Rechazado" };
const ESTRATO_LABEL: Record<MipymeEstrato, string> = { micro: "Microempresa", pequena: "Pequeña empresa", mediana: "Mediana empresa", grande: "Empresa grande" };

interface FormState {
  legalName: string;
  taxId: string;
  tradeName: string;
  sector: string;
  foundedYear: string;
  employeeCount: string;
  annualSales: string;
  website: string;
}

const VACIO: FormState = { legalName: "", taxId: "", tradeName: "", sector: "", foundedYear: "", employeeCount: "", annualSales: "", website: "" };

function desdePerfil(p: CompanyProfile): FormState {
  return {
    legalName: p.legalName,
    taxId: p.taxId,
    tradeName: p.tradeName ?? "",
    sector: p.sector ?? "",
    foundedYear: p.foundedYear === null ? "" : String(p.foundedYear),
    employeeCount: p.employeeCount === null ? "" : String(p.employeeCount),
    annualSales: p.annualSalesCents === null ? "" : `${Math.floor(p.annualSalesCents / 100)}.${String(p.annualSalesCents % 100).padStart(2, "0")}`,
    website: p.website ?? "",
  };
}

export interface PerfilGeneralProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly role: string;
  readonly userId: string | null;
  readonly canWrite: boolean;
  readonly decision: ReturnType<typeof useCompanyDecision>;
  readonly refreshKey: number;
  readonly onChanged: () => void;
  readonly busy: boolean;
}

export function PerfilGeneral({ apiBaseUrl, token, propertyId, role, userId, canWrite, decision, refreshKey, onChanged, busy }: PerfilGeneralProps) {
  const [view, setView] = useState<CompanyProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(VACIO);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const v = await fetchCompanyProfile(fetch, apiBaseUrl, token, propertyId);
      setView(v);
      setForm(v.profile ? desdePerfil(v.profile) : VACIO);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el perfil de la empresa.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, refreshKey]);

  async function guardar() {
    setActionError(null);
    const entero = (texto: string, campo: string): number | null | undefined => {
      if (texto.trim() === "") return null;
      const n = Number(texto);
      if (!Number.isInteger(n) || n < 0) {
        setActionError(`${campo}: escribe un número entero.`);
        return undefined;
      }
      return n;
    };
    const foundedYear = entero(form.foundedYear, "Año de fundación");
    const employeeCount = entero(form.employeeCount, "Número de trabajadores");
    if (foundedYear === undefined || employeeCount === undefined) return;
    let annualSalesCents: number | null = null;
    if (form.annualSales.trim() !== "") {
      annualSalesCents = pesosACentavos(form.annualSales);
      if (annualSalesCents === null) {
        setActionError("Ventas anuales: escribe un monto en pesos con hasta dos decimales (p. ej. 1500000.00).");
        return;
      }
    }
    setSaving(true);
    try {
      await saveCompanyProfile(fetch, apiBaseUrl, token, propertyId, {
        legalName: form.legalName,
        taxId: form.taxId,
        tradeName: form.tradeName.trim() === "" ? null : form.tradeName,
        sector: form.sector === "" ? null : (form.sector as MipymeSector),
        foundedYear,
        employeeCount,
        annualSalesCents,
        website: form.website.trim() === "" ? null : form.website,
      });
      await load();
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo guardar el perfil.");
    } finally {
      setSaving(false);
    }
  }

  if (loading && !view) return <EstadoCargando etiqueta="Cargando el perfil de la empresa…" />;
  if (error && !view) return <EstadoError mensaje={error} onReintentar={() => void load()} />;
  if (!view) return null;

  const { profile, mipyme, norma } = view;
  const pendienteLegal = (mipyme?.validarConAbogado ?? norma?.validarConAbogado ?? true) || (mipyme?.verificacion ?? norma?.estadoVerificacion) !== "verificado_fuente_primaria";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Perfil general</CardTitle>
          <CardDescription>
            Razón social, RFC, sector, plantilla y ventas de la empresa. Los usan la estratificación MIPyME, el expediente y el matching; cada dato guarda quién lo capturó y cuándo.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
          {actionError && (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          )}
          {!view.disponible && (
            <EstadoVacio titulo="No disponible aún" mensaje="El perfil completo de la empresa requiere la migración 040 en la base de datos de tu organización. Mientras tanto no se usa ni se inventa ningún dato de perfil." compacto />
          )}
          {view.disponible && profile && (
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3 text-sm">
              <div className="min-w-0 text-foreground">
                <strong>{profile.legalName}</strong> · {profile.taxId}
                {profile.tradeName && <span className="text-muted-foreground"> · {profile.tradeName}</span>}
                <div className="text-xs text-muted-foreground">
                  {profile.sector ? MIPYME_SECTOR_LABEL[profile.sector] : "Sin sector"} · {profile.employeeCount === null ? "trabajadores sin capturar" : `${profile.employeeCount} trabajadores`} · ventas {formatCentavos(profile.annualSalesCents)}
                  {profile.foundedYear ? ` · fundada en ${profile.foundedYear}` : ""}
                </div>
                {authorshipLine(profile, userId) && <div className="text-xs text-muted-foreground">{authorshipLine(profile, userId)}</div>}
                <ProcedenciaLinea item={profile} userId={userId} exige />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={statusTone(APROBACION_DATO_TONES, profile.approvalStatus)} className="whitespace-nowrap">
                  {APPROVAL_LABELS[profile.approvalStatus]}
                </StatusBadge>
                <DecisionButtons kind="profile" id={profile.id} etiqueta={profile.legalName} item={profile} role={role} userId={userId} decision={decision} busy={busy || saving} />
              </div>
            </div>
          )}
          {view.disponible && !profile && <EstadoVacio mensaje="Aún no capturas el perfil de la empresa. Empieza con la razón social y el RFC; con el sector, los trabajadores y las ventas se calcula la estratificación MIPyME." compacto />}
          {view.disponible && canWrite && (
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                void guardar();
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-razon">Razón social</Label>
                <Input id="perfil-razon" required value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-rfc">RFC</Label>
                <Input id="perfil-rfc" required placeholder="p. ej. ACM010101AB1" value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-comercial">Nombre comercial (opcional)</Label>
                <Input id="perfil-comercial" value={form.tradeName} onChange={(e) => setForm({ ...form, tradeName: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-sector">Sector (opcional)</Label>
                <NativeSelect id="perfil-sector" value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })}>
                  <option value="">Sin definir</option>
                  {(Object.keys(MIPYME_SECTOR_LABEL) as MipymeSector[]).map((s) => (
                    <option key={s} value={s}>
                      {MIPYME_SECTOR_LABEL[s]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-fundacion">Año de fundación (opcional)</Label>
                <Input id="perfil-fundacion" inputMode="numeric" value={form.foundedYear} onChange={(e) => setForm({ ...form, foundedYear: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-trabajadores">Número de trabajadores (opcional)</Label>
                <Input id="perfil-trabajadores" inputMode="numeric" value={form.employeeCount} onChange={(e) => setForm({ ...form, employeeCount: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-ventas">Ventas anuales en pesos (opcional)</Label>
                <Input id="perfil-ventas" inputMode="decimal" placeholder="p. ej. 1500000.00" value={form.annualSales} onChange={(e) => setForm({ ...form, annualSales: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-sitio">Sitio web (opcional)</Label>
                <Input id="perfil-sitio" placeholder="https://" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" size="sm" disabled={busy || saving}>
                  <Save />
                  {saving ? "Guardando…" : profile ? "Guardar cambios" : "Guardar perfil"}
                </Button>
                {profile && profile.approvalStatus === "aprobado" && <span className="ml-2 text-xs text-muted-foreground">Editar un perfil aprobado lo regresa a pendiente.</span>}
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {view.disponible && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Estratificación MIPyME</CardTitle>
              {pendienteLegal && <StatusBadge tone="warning">Pendiente de verificación legal</StatusBadge>}
            </div>
            <CardDescription>REQ-109: el tamaño de la empresa sale del número de trabajadores y de las ventas anuales; es un manifiesto que piden casi todas las convocatorias.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {!mipyme && <EstadoVacio mensaje="Captura el perfil general (sector, trabajadores y ventas anuales) para calcular la estratificación." compacto />}
            {mipyme?.status === "calculado" && (
              <p className="text-foreground" data-testid="mipyme-resultado">
                <strong>{ESTRATO_LABEL[mipyme.estrato]}</strong> · puntaje combinado {mipyme.puntajeCombinado}
              </p>
            )}
            {mipyme?.status === "no_evaluable" && (
              <p className="text-foreground" data-testid="mipyme-resultado">
                No evaluable: falta {mipyme.faltan.join(", ")}. Captúralo en el perfil general; no se asume ningún valor.
              </p>
            )}
            {pendienteLegal && (
              <p className="text-xs text-muted-foreground">
                Las cifras de la estratificación están en el registro normativo en estado «{norma?.estadoVerificacion ?? "sin verificar"}»: un abogado debe confirmarlas antes de presentar el manifiesto. {norma?.nota}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
