// Plantilla de correo de invitación de staff — puerto literal de
// domain-restaurantes/src/emails/staff-invite-template.ts (única vertical con esto
// ya construido), adaptada al vocabulario de citas: 3 roles (owner/admin/staff, ver
// roles.ts — sin "repartidor", que es propio de restaurantes) y "panel de citas" en
// vez de "panel de restaurantes".
//
// GAP QUE CIERRA (hallazgo de auditoría, ver apps/api/.../citas/admin-staff.ts):
// citas definía 3 roles de plataforma (roles.ts) sin NINGÚN flujo real que diera de
// alta staff con ellos — ni ruta HTTP, ni correo de invitación. Esta plantilla + el
// enqueue real en admin-staff.ts cierran ese hueco: el invitado recibe el enlace de
// activación por correo real, sin que quien invita tenga que copiar nada a mano.
import { escapeHtml, renderCorreo } from "./layout.ts";

export type StaffInviteVerticalRole = "owner" | "admin" | "staff";

const ROLE_LABEL: Record<StaffInviteVerticalRole, string> = {
  owner: "Dueño/a",
  admin: "Administrador/a",
  staff: "Staff",
};

export interface StaffInviteCorreo {
  readonly email: string;
  readonly verticalRole: StaffInviteVerticalRole;
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
      `Te invitaron a unirte al panel de citas de <strong>atiende</strong> con el rol <strong>${escapeHtml(roleLabel)}</strong>.`,
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
    texto: `Te invitaron a unirte al panel de citas de atiende con el rol ${roleLabel}.\nActiva tu cuenta aquí: ${c.acceptUrl}\nEste enlace vence el ${c.expiresAtTexto}.`,
  };
}
