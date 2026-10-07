// H-P3-06 -- "Primeros pasos": checklist del hotel calculado por el servidor con datos reales (tipos, habitaciones, tarifas de 30 dias,
// impuestos, politica, zona horaria, aviso de privacidad, WhatsApp, voz, equipo, reservas). Cada paso lleva su responsable y el enlace a la
// pantalla donde se cierra; nada se marca como hecho a mano. "Ir al panel de todos modos" omite el gate y queda en la bitacora.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, PageContainer, StatusBadge, toast } from "@atiende/ui";
import { ESTADO_LABEL, fetchOnboarding, omitirGate, ONBOARDING_ROLES, RESPONSABLE_LABEL } from "../lib/onboarding-client.ts";
import type { OnboardingChecklist, OnboardingEstado, OnboardingItem } from "../lib/onboarding-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const TONO: Record<OnboardingEstado, "success" | "warning" | "danger"> = { hecho: "success", parcial: "warning", pendiente: "danger" };

/** Enlace a la pantalla donde se cierra el paso. */
export function enlaceDePaso(orgSlug: string, item: OnboardingItem): string {
  const base = `/hoteles/${orgSlug}/${item.pantalla}`;
  return item.pantalla === "configuracion" && item.pestana ? `${base}?tab=${item.pestana}` : base;
}

export function PrimerosPasosPage({ apiBaseUrl, token, propertyId, orgSlug, role }: HotelesShellContext) {
  const navigate = useNavigate();
  const [estado, setEstado] = useState<OnboardingChecklist | "cargando" | { error: string }>("cargando");
  const [omitiendo, setOmitiendo] = useState(false);
  const permitido = ONBOARDING_ROLES.has(role);

  const cargar = useCallback(() => {
    if (!permitido) return;
    setEstado("cargando");
    fetchOnboarding(fetch, apiBaseUrl, token, propertyId)
      .then(setEstado)
      .catch((e: unknown) => setEstado({ error: e instanceof Error ? e.message : "No se pudo cargar el checklist." }));
  }, [apiBaseUrl, token, propertyId, permitido]);
  useEffect(cargar, [cargar]);

  async function omitir() {
    setOmitiendo(true);
    try {
      const r = await omitirGate(fetch, apiBaseUrl, token, propertyId, orgSlug);
      if (!r.registrada) toast.info("Omitido en esta sesión (la bitácora aún no está disponible en esta base).");
      navigate(`/hoteles/${orgSlug}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo omitir el gate.");
    } finally {
      setOmitiendo(false);
    }
  }

  if (!permitido) {
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">Primeros pasos</h1>
        <p className="m-0 text-sm text-muted-foreground">Los primeros pasos del hotel los revisa el propietario o el gerente general.</p>
      </PageContainer>
    );
  }

  const checklist = typeof estado === "object" && "items" in estado ? estado : null;
  return (
    <PageContainer padding="none">
      {/* El nombre de la pagina ya lo muestra la barra superior del shell: solo queda el h1 para lectores de pantalla. */}
      <h1 className="sr-only">Primeros pasos</h1>
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={cargar} disabled={estado === "cargando"}>
          <RefreshCw className={estado === "cargando" ? "animate-spin" : undefined} />
          Actualizar
        </Button>
      </div>

      {estado === "cargando" && <EstadoCargando etiqueta="Revisando la configuración…" />}
      {typeof estado === "object" && "error" in estado && <EstadoError mensaje={estado.error} onReintentar={cargar} />}

      {checklist && (
        <>
          <Callout
            tone={checklist.listoParaOperar ? "success" : "warning"}
            titulo={checklist.listoParaOperar ? "Listo para operar" : "Faltan puntos obligatorios"}
            accion={
              checklist.bloquea ? (
                <Button type="button" variant="outline" size="sm" loading={omitiendo} onClick={() => void omitir()}>
                  Ir al panel de todos modos
                </Button>
              ) : undefined
            }
          >
            {checklist.resumen.hechos} de {checklist.resumen.total} puntos listos
            {checklist.resumen.obligatoriosPendientes > 0 ? ` · ${checklist.resumen.obligatoriosPendientes} obligatorio(s) pendiente(s).` : "."} El estado se calcula con los datos reales de tu hotel.
            {checklist.operaConReservas && checklist.resumen.obligatoriosPendientes > 0 ? " Tu hotel ya opera con reservas: esto no bloquea el panel." : ""}
          </Callout>
          <ul className="flex flex-col gap-2">
            {checklist.items.map((item) => (
              <li key={item.id}>
                <Card>
                  <CardContent className="flex flex-col gap-1.5 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="m-0 text-sm font-medium text-foreground">
                        {item.titulo}
                        {item.obligatorio && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(obligatorio)</span>}
                      </p>
                      <StatusBadge tone={TONO[item.estado]}>{ESTADO_LABEL[item.estado]}</StatusBadge>
                    </div>
                    <p className="m-0 text-xs text-muted-foreground">{item.detalle}</p>
                    {item.estado !== "hecho" && (
                      <p className="m-0 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        <span>Lo cierra: {RESPONSABLE_LABEL[item.responsable]}</span>
                        <Link className="underline underline-offset-2" to={enlaceDePaso(orgSlug, item)}>
                          Ir a la pantalla
                        </Link>
                      </p>
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </PageContainer>
  );
}
