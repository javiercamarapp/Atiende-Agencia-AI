// Finanzas (Fase 16) — cierra el hallazgo de auditoría ALTA "Finanzas (movimientos,
// owner statements, payouts/conciliación) sin UI para admin_gestora ni contador":
// finanzas.ts (POST/GET .../reservas/:ocupacionId/movimiento), finanzas-statements.ts
// (POST/GET .../owners/:ownerId/statements, GET .../statements/:id) y
// finanzas-payouts.ts (POST .../payouts, GET .../payouts/:id) ya estaban montados y
// probados en apps/api sin que ninguna página de apps/web los invocara.
//
// Tres secciones independientes, mismo patrón de "gate en el CLIENTE solo por UX,
// el servidor SIEMPRE re-valida vía assertVerticalRole" que ya usa Precios.tsx:
//  1. Movimiento financiero por reserva -- LECTURA para FINANZAS_LECTURA_ROLES
//     (admin_gestora + contador), ESCRITURA (registrar) solo admin_gestora
//     (FINANZAS_ESCRITURA_ROLES en packages/domain-rentas/src/roles.ts).
//  2. Owner statements -- misma separación lectura/escritura. Generar exige
//     motivoVersion cuando ya existe una versión previa (el servidor lo exige; esta
//     UI lo pide siempre que haya al menos un statement listado, para no
//     sorprender con un 400).
//  3. Payouts de canal + conciliación -- crear (POST) es escritura; ver el detalle
//     de un payout ya creado es lectura.
//
// Límite real (documentado también en finanzas-client.ts): ningún endpoint expone
// un catálogo de propietarios de una property ni una lista de payouts ya
// importados -- `ownerId`/`payoutId` se piden como texto libre, igual que
// pricing-client.ts documenta la ausencia de un GET de configuración de pricing.
//
// Portal de propietario (Fase 3 backend, UI de esta fase): "Invitar a este
// propietario" en la sección de owner statements llama
// POST .../owners/:ownerId/portal-invite (owner-portal-invite.ts) -- mismo
// FINANZAS_LECTURA_ROLES que ya gatea esta sección completa, el servidor
// re-valida con assertVerticalRole igual que el resto de esta página. El token
// de invitación se muestra UNA sola vez (nunca se puede recuperar de nuevo) para
// que staff lo copie/pegue en el mensaje que le mande al propietario -- no hay
// envío de correo real en este monorepo todavía (ver el comentario de cabecera
// de owner-portal-invite.ts). El propietario activa su cuenta y consulta sus
// statements en una superficie SEPARADA de este panel de staff (ver
// pages/OwnerPortalLogin.tsx/OwnerPortalActivar.tsx/OwnerPortalDashboard.tsx --
// login propio contra el JWT del portal, nunca el de staff).
//
// Rn-15/UNI-C-rentas: la página solo compone las secciones de pages/finanzas/ (cada una con su propio fetch); el contrato de
// diseño de Likida (PageHeader con el único h1, Cards, FormDialog, DataTable, useConfirm de dos pasos antes de cada escritura
// irreversible, notify, dinero y fechas con los formateadores únicos) vive en esas secciones. La barra superior con icono +
// nombre de la página la pinta el shell (VerticalShell/BarraPagina).
import { Callout, PageContainer, PageHeader } from "@atiende/ui";
import { ReglasComisionSection } from "../components/ReglasComision.tsx";
import type { RentasShellContext } from "../RentasShell.tsx";
import { FINANZAS_ESCRITURA_ROLES, FINANZAS_LECTURA_ROLES } from "./finanzas/comunes.tsx";
import { MovimientoSection } from "./finanzas/MovimientoSection.tsx";
import { OwnerStatementsSection } from "./finanzas/OwnerStatementsSection.tsx";
import { PayoutsSection } from "./finanzas/PayoutsSection.tsx";

export function FinanzasPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeLeer = org ? FINANZAS_LECTURA_ROLES.has(org.rol) : false;
  const puedeEscribir = org ? FINANZAS_ESCRITURA_ROLES.has(org.rol) : false;

  if (!puedeLeer) {
    return (
      <PageContainer>
        <PageHeader titulo="Finanzas" />
        <Callout tone="info" titulo="Sin acceso de lectura a Finanzas">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso. Roles con acceso: <strong className="text-foreground">admin_gestora</strong> y{" "}
          <strong className="text-foreground">contador</strong>.
        </Callout>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        titulo="Finanzas"
        descripcion={
          <>
            Comisiones de canal, movimiento financiero por reserva, owner statements y payouts de canal.
            {!puedeEscribir && (
              <>
                {" "}
                Tu rol (<strong className="text-foreground">{org?.rol}</strong>) es de solo lectura: registrar y generar es exclusivo de <strong className="text-foreground">admin_gestora</strong>.
              </>
            )}
          </>
        }
      />

      <ReglasComisionSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeEscribir={puedeEscribir} />
      <MovimientoSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeEscribir={puedeEscribir} />
      <OwnerStatementsSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeEscribir={puedeEscribir} />
      <PayoutsSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeEscribir={puedeEscribir} />
    </PageContainer>
  );
}
