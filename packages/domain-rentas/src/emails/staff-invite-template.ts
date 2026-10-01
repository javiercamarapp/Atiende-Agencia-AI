// Plantilla de correo de invitación de staff de rentas (Rn-20) — mismo patrón EXACTO que
// @atiende/domain-hoteles::emails/staff-invite-template.ts (DUPLICADO deliberado, mismo criterio de
// aislamiento por paquete que el resto del monorepo), sobre los 6 roles finos de rentas
// (`RentasVerticalRole`, ver ../roles.ts). El mecanismo de invitación (token con expiración,
// `core.staff_invite`, `core.accept_staff_invite`) es genérico y vive en core.
import { escapeHtml, renderCorreo } from "./layout.ts";
import type { RentasVerticalRole } from "../roles.ts";

export const ROLE_LABEL: Record<RentasVerticalRole, string> = {
  admin_gestora: "Administrador/a de la gestora",
  "operador:acceso_total": "Operador/a (acceso total)",
  "operador:calendario_mensajeria": "Operador/a (calendario y mensajería)",
  "operador:solo_calendario": "Operador/a (solo calendario)",
  contador: "Contador/a",
  limpieza: "Limpieza",
};

export interface StaffInviteCorreo {
  readonly email: string;
  readonly verticalRole: RentasVerticalRole;
  /** URL completa ya armada por el caller (`${appBaseUrl}/aceptar-invitacion?token=...`)
   * — esta plantilla nunca construye URLs, solo las embebe como botón + texto plano de respaldo. */
  readonly acceptUrl: string;
  /** Ya formateada en el huso del servidor. */
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
      `Te invitaron a unirte al panel de rentas de <strong>atiende</strong> con el rol <strong>${escapeHtml(roleLabel)}</strong>.`,
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
    texto: `Te invitaron a unirte al panel de rentas de atiende con el rol ${roleLabel}.\nActiva tu cuenta aquí: ${c.acceptUrl}\nEste enlace vence el ${c.expiresAtTexto}.`,
  };
}
