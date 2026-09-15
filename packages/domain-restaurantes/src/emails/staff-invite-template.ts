// Plantilla de correo de invitación de staff, construida sobre el marco de
// layout.ts. GAP QUE CIERRA (hallazgo de auditoría): `POST .../admin/staff/
// invitaciones` (ver ../../../../apps/api/src/routes/verticals/restaurantes/
// admin-staff.ts) ya genera un token real (`generateInviteToken`,
// `core.staff_invite`) pero lo devuelve UNA sola vez en la respuesta HTTP, sin
// ningún canal de envío — "quien invita copia/pega este token en el mensaje que
// le mande al invitado" (comentario original de esa ruta). Esta plantilla + el
// enqueue real en esa misma ruta cierran ese hueco: el invitado recibe el
// enlace de activación por correo real, sin que quien invita tenga que copiar
// nada a mano.
//
// El correo electrónico del invitado (`c.email`, ver CreateInviteBody de esa
// ruta) ya pasó por `EMAIL_RE` ahí mismo antes de llegar aquí — nunca se
// revalida dos veces.
import { escapeHtml, renderCorreo } from "./layout.ts";

export type StaffInviteVerticalRole = "owner" | "admin" | "staff" | "repartidor";

const ROLE_LABEL: Record<StaffInviteVerticalRole, string> = {
  owner: "Dueño/a",
  admin: "Administrador/a",
  staff: "Staff",
  repartidor: "Repartidor",
};

export interface StaffInviteCorreo {
  readonly email: string;
  readonly verticalRole: StaffInviteVerticalRole;
  /** URL completa ya armada por el caller (`${appBaseUrl}/aceptar-invitacion?token=...`)
   * — esta plantilla nunca construye URLs, solo las embebe como botón + texto plano
   * de respaldo (mismo criterio "nunca inventar una ruta" que el resto del dominio). */
  readonly acceptUrl: string;
  /** Ya formateada en el huso del servidor — una invitación de 7 días (ver
   * STAFF_INVITE_TTL_MS) no necesita precisión de timezone del negocio. */
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
      `Te invitaron a unirte al panel de restaurantes de <strong>atiende</strong> con el rol <strong>${escapeHtml(roleLabel)}</strong>.`,
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
    texto: `Te invitaron a unirte al panel de restaurantes de atiende con el rol ${roleLabel}.\nActiva tu cuenta aquí: ${c.acceptUrl}\nEste enlace vence el ${c.expiresAtTexto}.`,
  };
}
