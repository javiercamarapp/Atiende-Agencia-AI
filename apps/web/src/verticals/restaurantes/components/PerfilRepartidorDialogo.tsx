// R-15 -- dialogo de Staff (owner/admin): ver y editar el perfil operativo de un repartidor y, como derecho de cancelacion (ARCO), suprimirlo.
// Endpoints reales: GET|PUT|DELETE .../admin/staff/:userId/perfil-repartidor. Carga al abrirse. El servidor decide quien puede (owner/admin);
// esta pantalla solo se ofrece a ellos. Base sin migrar: estado honesto "no disponible aun", sin formulario.
import { useCallback, useEffect, useState } from "react";
import { Button, Callout, EstadoCargando, EstadoError, FormDialog, notify, useT } from "@atiende/ui";
import { restaurantesStaff } from "@atiende/ui/i18n/restaurantes/staff";
import { fetchPerfilDeRepartidor, formDesdePerfil, guardarPerfilDeRepartidor, suprimirPerfilDeRepartidor, validarPerfilForm, PERFIL_FORM_VACIO } from "../lib/repartidor-perfil-client.ts";
import type { PerfilForm, PerfilFormErrores, PerfilRespuesta } from "../lib/repartidor-perfil-client.ts";
import { AlertaLicencia, PerfilRepartidorCampos } from "./PerfilRepartidorCampos.tsx";

type Estado = { readonly estado: "cargando" } | { readonly estado: "listo"; readonly datos: PerfilRespuesta } | { readonly estado: "error"; readonly mensaje: string };

export function PerfilRepartidorDialogo({
  open,
  onOpenChange,
  repartidor,
  apiBaseUrl,
  token,
  propertyId,
  confirmar,
  fetchImpl,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly repartidor: { readonly id: string; readonly fullName: string } | null;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** `confirmar` de `useConfirm()` de la pagina que lo aloja (la baja de datos pide confirmacion). */
  readonly confirmar: (opts: { titulo: string; descripcion: string; tono: "danger"; confirmar: string }) => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
}) {
  const t = useT(restaurantesStaff);
  const [carga, setCarga] = useState<Estado>({ estado: "cargando" });
  const [form, setForm] = useState<PerfilForm>({ ...PERFIL_FORM_VACIO });
  const [errores, setErrores] = useState<PerfilFormErrores>({});
  const [guardando, setGuardando] = useState(false);
  const [suprimiendo, setSuprimiendo] = useState(false);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const repartidorId = repartidor?.id ?? null;

  const cargar = useCallback(async () => {
    if (!repartidorId) return;
    setCarga({ estado: "cargando" });
    setErrorAccion(null);
    setErrores({});
    try {
      const r = await fetchPerfilDeRepartidor(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, repartidorId);
      setCarga({ estado: "listo", datos: r });
      setForm(formDesdePerfil(r.perfil));
    } catch (err) {
      setCarga({ estado: "error", mensaje: err instanceof Error ? err.message : t("restaurantes.staff.perfilErrorCargar") });
    }
  }, [apiBaseUrl, token, propertyId, repartidorId, fetchImpl, t]);
  useEffect(() => {
    if (open) void cargar();
  }, [open, cargar]);

  async function guardar() {
    if (!repartidorId) return;
    const e = validarPerfilForm(form);
    setErrores(e);
    if (Object.keys(e).length > 0) return;
    setGuardando(true);
    setErrorAccion(null);
    try {
      const r = await guardarPerfilDeRepartidor(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, repartidorId, form);
      setCarga({ estado: "listo", datos: r });
      setForm(formDesdePerfil(r.perfil));
      notify.success(t("restaurantes.staff.perfilGuardado"));
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : t("restaurantes.staff.perfilErrorGuardar"));
    } finally {
      setGuardando(false);
    }
  }

  async function suprimir() {
    if (!repartidor) return;
    const ok = await confirmar({
      titulo: t("restaurantes.staff.suprimirTitulo", { nombre: repartidor.fullName }),
      descripcion: t("restaurantes.staff.suprimirDesc"),
      tono: "danger",
      confirmar: t("restaurantes.staff.suprimir"),
    });
    if (!ok) return;
    setSuprimiendo(true);
    setErrorAccion(null);
    try {
      const r = await suprimirPerfilDeRepartidor(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, repartidor.id);
      notify.success(t(r.borrado ? "restaurantes.staff.perfilSuprimido" : "restaurantes.staff.sinPerfil"));
      onOpenChange(false);
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : t("restaurantes.staff.perfilErrorSuprimir"));
    } finally {
      setSuprimiendo(false);
    }
  }

  const listo = carga.estado === "listo" && carga.datos.disponible;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      titulo={repartidor ? t("restaurantes.staff.perfilDe", { nombre: repartidor.fullName }) : t("restaurantes.staff.perfilRepartidor")}
      subtitulo={t("restaurantes.staff.perfilSub")}
      anchoClase="max-w-2xl"
      onGuardar={() => void guardar()}
      bloquearCierre={guardando || suprimiendo}
      footer={
        listo ? (
          <div className="flex w-full flex-col-reverse gap-2 md:w-auto md:flex-row">
            <Button type="button" variant="danger-outline" onClick={() => void suprimir()} loading={suprimiendo} disabled={guardando}>
              {t("restaurantes.staff.suprimir")}
            </Button>
            <Button type="submit" loading={guardando} disabled={suprimiendo}>
              {t("restaurantes.staff.guardarPerfil")}
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("restaurantes.staff.cerrar")}
          </Button>
        )
      }
    >
      <div className="grid gap-3">
        {carga.estado === "cargando" && <EstadoCargando etiqueta={t("restaurantes.staff.cargandoPerfil")} />}
        {carga.estado === "error" && <EstadoError mensaje={carga.mensaje} onReintentar={() => void cargar()} />}
        {carga.estado === "listo" && !carga.datos.disponible && (
          <Callout tone="info" titulo={t("restaurantes.staff.perfilNoDisponible")}>
            {t("restaurantes.staff.perfilRequiere")}

          </Callout>
        )}
        {listo && carga.estado === "listo" && (
          <>
            <AlertaLicencia perfil={carga.datos.perfil} persona="ajena" />
            {errorAccion && <Callout tone="danger">{errorAccion}</Callout>}
            <PerfilRepartidorCampos valor={form} errores={errores} deshabilitado={guardando || suprimiendo} onCambio={(campo, texto) => setForm((f) => ({ ...f, [campo]: texto }))} />
          </>
        )}
      </div>
    </FormDialog>
  );
}
