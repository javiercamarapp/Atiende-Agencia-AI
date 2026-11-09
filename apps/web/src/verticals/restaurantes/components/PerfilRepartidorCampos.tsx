// R-15 -- campos del perfil del repartidor, compartidos por la pestana "Mi perfil" (el propio repartidor) y el dialogo de Staff (owner/admin).
// Solo presentacion: el estado y el guardado viven en quien lo usa. Primitivos de @atiende/ui (FormField, Input, Selector, Callout).
import { Callout, FormField, Input, Selector, useT } from "@atiende/ui";
import { restaurantesStaff } from "@atiende/ui/i18n/restaurantes/staff";
import { DISPONIBILIDAD_ETIQUETAS, VEHICULO_ETIQUETAS } from "../lib/repartidor-perfil-client.ts";
import type { Disponibilidad, PerfilForm, PerfilFormErrores, PerfilRepartidor, VehiculoTipo } from "../lib/repartidor-perfil-client.ts";

/** Alerta de licencia: menos de 30 dias = aviso; vencida = peligro. Sin licencia o vigente no pinta nada. */
export function AlertaLicencia({ perfil, persona }: { readonly perfil: PerfilRepartidor | null; readonly persona: "propia" | "ajena" }) {
  const t = useT(restaurantesStaff);
  if (!perfil || perfil.licenciaDias === null) return null;
  const propia = persona === "propia";
  if (perfil.licenciaEstado === "vencida") {
    const d = Math.abs(perfil.licenciaDias);
    return (
      <Callout tone="danger" titulo={t(propia ? "restaurantes.staff.lic.vencidaPropia" : "restaurantes.staff.lic.vencidaAjena")}>
        {t("restaurantes.staff.lic.vencio", { count: d })}
        {t(propia ? "restaurantes.staff.lic.renuevaPropia" : "restaurantes.staff.lic.renuevaAjena")}
      </Callout>
    );
  }
  if (perfil.licenciaEstado === "por_vencer") {
    const d = perfil.licenciaDias;
    return (
      <Callout tone="warning" titulo={t(propia ? "restaurantes.staff.lic.prontoPropia" : "restaurantes.staff.lic.prontoAjena")}>
        {d === 0 ? t("restaurantes.staff.lic.hoy") : t("restaurantes.staff.lic.enDias", { count: d })}
        {propia ? t("restaurantes.staff.lic.renuevaPropia") : ""}
      </Callout>
    );
  }
  return null;
}

export function PerfilRepartidorCampos({
  valor,
  errores,
  onCambio,
  deshabilitado = false,
}: {
  readonly valor: PerfilForm;
  readonly errores: PerfilFormErrores;
  readonly onCambio: (campo: keyof PerfilForm, texto: string) => void;
  readonly deshabilitado?: boolean;
}) {
  const t = useT(restaurantesStaff);
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t("restaurantes.staff.campo.vehiculo")} error={errores.vehiculoTipo}>
          <Selector value={valor.vehiculoTipo} disabled={deshabilitado} onChange={(e) => onCambio("vehiculoTipo", e.target.value)}>
            <option value="">{t("restaurantes.staff.campo.sinIndicar")}</option>
            {(Object.keys(VEHICULO_ETIQUETAS) as VehiculoTipo[]).map((v) => (
              <option key={v} value={v}>
                {VEHICULO_ETIQUETAS[v]}
              </option>
            ))}
          </Selector>
        </FormField>
        <FormField label={t("restaurantes.staff.campo.placas")} error={errores.placas}>
          <Input value={valor.placas} maxLength={15} disabled={deshabilitado} onChange={(e) => onCambio("placas", e.target.value)} />
        </FormField>
        <FormField label={t("restaurantes.staff.campo.disponibilidad")} error={errores.disponibilidad}>
          <Selector value={valor.disponibilidad} disabled={deshabilitado} onChange={(e) => onCambio("disponibilidad", e.target.value)}>
            {(Object.keys(DISPONIBILIDAD_ETIQUETAS) as Disponibilidad[]).map((d) => (
              <option key={d} value={d}>
                {DISPONIBILIDAD_ETIQUETAS[d]}
              </option>
            ))}
          </Selector>
        </FormField>
        <FormField label={t("restaurantes.staff.campo.turno")} hint={t("restaurantes.staff.campo.turnoAyuda")} error={errores.turno}>
          <Input value={valor.turno} maxLength={120} disabled={deshabilitado} onChange={(e) => onCambio("turno", e.target.value)} />
        </FormField>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t("restaurantes.staff.campo.licencia")} error={errores.licenciaNumero}>
          <Input value={valor.licenciaNumero} maxLength={40} disabled={deshabilitado} onChange={(e) => onCambio("licenciaNumero", e.target.value)} />
        </FormField>
        <FormField label={t("restaurantes.staff.campo.vigencia")} error={errores.licenciaVigencia}>
          <Input type="date" value={valor.licenciaVigencia} disabled={deshabilitado} onChange={(e) => onCambio("licenciaVigencia", e.target.value)} />
        </FormField>
        <FormField label={t("restaurantes.staff.campo.emergencia")} error={errores.emergenciaNombre}>
          <Input value={valor.emergenciaNombre} maxLength={100} disabled={deshabilitado} onChange={(e) => onCambio("emergenciaNombre", e.target.value)} />
        </FormField>
        <FormField label={t("restaurantes.staff.campo.emergenciaTel")} hint={t("restaurantes.staff.campo.diezDigitos")} error={errores.emergenciaTelefono}>

          <Input type="tel" inputMode="tel" value={valor.emergenciaTelefono} disabled={deshabilitado} onChange={(e) => onCambio("emergenciaTelefono", e.target.value)} />
        </FormField>
      </div>
    </div>
  );
}
