// Plantilla de correo de invitación de staff — mismo patrón EXACTO que
// @atiende/domain-licitaciones::emails/staff-invite-template.ts (DUPLICADO
// deliberado, mismo criterio de aislamiento por paquete que el resto del
// monorepo), sobre los 8 roles finos de hoteles (`HotelRole`, ver ../roles.ts).
//
// GAP QUE CIERRA (hallazgo de auditoría — rubro "completitud funcional": hoteles
// era, a esta fecha, la ÚNICA de las 6 verticales sin ningún camino de producto
// para dar de alta staff adicional una vez creado el primer owner/gm; el
// mecanismo genérico ya existe desde la Fase 10 de restaurantes —
// `core.staff_invite`/`core.accept_staff_invite`/`generateInviteToken`/
// `canInviteStaff` — y ya se expuso para restaurantes/citas/licitaciones/
// despachos, pero nunca para hoteles. Ver
// apps/api/src/routes/verticals/hoteles/admin-staff.ts para el resto del
// contexto): el token real que esa ruta genera se envía por correo real en vez
// de depender de que quien invita copie/pegue el token a mano.
import { escapeHtml, renderCorreo } from "./layout.ts";
import type { HotelRole } from "../roles.ts";

const ROLE_LABEL: Record<HotelRole, string> = {
  owner: "Dueño/a",
  gm: "Gerente general",
  frontdesk: "Recepción",
  reservations: "Reservaciones",
  housekeeping: "Housekeeping",
  maintenance: "Mantenimiento",
  fnb: "Alimentos y bebidas",
  accountant: "Contabilidad",
};

export interface StaffInviteCorreo {
  readonly email: string;
  readonly verticalRole: HotelRole;
  /** URL completa ya armada por el caller (`${appBaseUrl}/aceptar-invitacion?token=...`)
   * — esta plantilla nunca construye URLs, solo las embebe como botón + texto plano
   * de respaldo (mismo criterio "nunca inventar una ruta" que el resto del dominio). */
  readonly acceptUrl: string;
  /** Ya formateada en el huso del servidor — una invitación de 7 días no necesita
   * precisión de timezone del negocio. */
  readonly expiresAtTexto: string;
}

export interface Correo {
  readonly asunto: string;
  readonly html: string;
  readonly texto: string;
}

function botonPildoraHtml(url: string, texto: string): string {
  const href = escapeHtml(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 2px 0;"><tr><td bgcolor="#1D4ED8" style="border-radius:999px;"><a href="${href}" style="display:inline-block;padding:12px 26px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(texto)}</a></td></tr></table>`;
}

export function correoInvitacionStaff(c: StaffInviteCorreo): Correo {
  const roleLabel = ROLE_LABEL[c.verticalRole];
  const html = renderCorreo({
    titulo: "Te invitaron a unirte a atiende",
    preheader: `Acceso como ${roleLabel} — el enlace vence el ${c.expiresAtTexto}`,
    etiqueta: { texto: "Invitación de staff", color: "#1D4ED8" },
    parrafosHtml: [
      `Te invitaron a unirte al panel de hoteles de <strong>atiende</strong> con el rol <strong>${escapeHtml(roleLabel)}</strong>.`,
      botonPildoraHtml(c.acceptUrl, "Activar mi cuenta"),
      `Si el botón no funciona, copia y pega este enlace en tu navegador:<br><span style="word-break:break-all;color:#1D4ED8;">${escapeHtml(c.acceptUrl)}</span>`,
    ],
    tabla: { filas: [{ etiqueta: "Rol", valor: roleLabel }, { etiqueta: "Enlace vence", valor: c.expiresAtTexto }] },
    nota: "Si no esperabas esta invitación, ignora este correo — el enlace deja de funcionar solo cuando vence.",
    piePorQueLlego: `Recibes este correo porque alguien te invitó a colaborar en atiende con la dirección ${c.email}.`,
  });
  return {
    asunto: `Te invitaron a unirte a atiende · ${roleLabel}`,
    html,
    texto: `Te invitaron a unirte al panel de hoteles de atiende con el rol ${roleLabel}.\nActiva tu cuenta aquí: ${c.acceptUrl}\nEste enlace vence el ${c.expiresAtTexto}.`,
  };
}
