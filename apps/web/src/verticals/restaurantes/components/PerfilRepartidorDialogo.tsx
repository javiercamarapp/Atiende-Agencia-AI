// R-15 -- dialogo de Staff (owner/admin): ver y editar el perfil operativo de un repartidor y, como derecho de cancelacion (ARCO), suprimirlo.
// Endpoints reales: GET|PUT|DELETE .../admin/staff/:userId/perfil-repartidor. Carga al abrirse. El servidor decide quien puede (owner/admin);
// esta pantalla solo se ofrece a ellos. Base sin migrar: estado honesto "no disponible aun", sin formulario.
import { useCallback, useEffect, useState } from "react";
import { Button, Callout, EstadoCargando, EstadoError, FormDialog, notify } from "@atiende/ui";
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
      setCarga({ estado: "error", mensaje: err instanceof Error ? err.message : "No se pudo cargar el perfil." });
    }
  }, [apiBaseUrl, token, propertyId, repartidorId, fetchImpl]);
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
      notify.success("Perfil guardado.");
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : "No se pudo guardar el perfil.");
    } finally {
      setGuardando(false);
    }
  }

  async function suprimir() {
    if (!repartidor) return;
    const ok = await confirmar({
      titulo: `Suprimir el perfil de ${repartidor.fullName}`,
      descripcion: "Borra vehículo, placas, turno, licencia y contacto de emergencia. No se puede deshacer. La bitácora solo conserva que se hizo, sin los datos.",
      tono: "danger",
      confirmar: "Suprimir perfil",
    });
    if (!ok) return;
    setSuprimiendo(true);
    setErrorAccion(null);
    try {
      const r = await suprimirPerfilDeRepartidor(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, repartidor.id);
      notify.success(r.borrado ? "Perfil suprimido." : "Ese repartidor no tenía perfil guardado.");
      onOpenChange(false);
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : "No se pudo suprimir el perfil.");
    } finally {
      setSuprimiendo(false);
    }
  }

  const listo = carga.estado === "listo" && carga.datos.disponible;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      titulo={repartidor ? `Perfil de ${repartidor.fullName}` : "Perfil del repartidor"}
      subtitulo="Vehículo, disponibilidad, licencia y contacto de emergencia. Solo dueños y administradores lo ven."
      anchoClase="max-w-2xl"
      onGuardar={() => void guardar()}
      bloquearCierre={guardando || suprimiendo}
      footer={
        listo ? (
          <div className="flex w-full flex-col-reverse gap-2 md:w-auto md:flex-row">
            <Button type="button" variant="danger-outline" onClick={() => void suprimir()} loading={suprimiendo} disabled={guardando}>
              Suprimir perfil
            </Button>
            <Button type="submit" loading={guardando} disabled={suprimiendo}>
              Guardar perfil
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
        )
      }
    >
      <div className="grid gap-3">
        {carga.estado === "cargando" && <EstadoCargando etiqueta="Cargando el perfil…" />}
        {carga.estado === "error" && <EstadoError mensaje={carga.mensaje} onReintentar={() => void cargar()} />}
        {carga.estado === "listo" && !carga.datos.disponible && (
          <Callout tone="info" titulo="El perfil aún no está disponible">
            No disponible aún: requiere la actualización de base de datos del perfil del repartidor (migración 044).
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
