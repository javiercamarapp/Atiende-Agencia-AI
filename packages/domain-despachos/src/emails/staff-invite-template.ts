// Plantilla de correo de invitación de staff, construida sobre el marco de
// layout.ts — port EXACTO de packages/domain-restaurantes/src/emails/staff-invite-template.ts
// (leído primero como plantilla) con el catálogo de roles de despachos
// (DESPACHOS_ROLES: admin/contador/auditor/readonly) en vez del de restaurantes.
//
// GAP QUE CIERRA (hallazgo de auditoría, severidad ALTA, "Alta de organización/
// staff imposible sin SQL"): despachos era la única vertical (junto con las otras
// 4 fuera de restaurantes) sin ninguna ruta HTTP para dar de alta staff nuevo —
// el mecanismo genérico (core.staff_invite, generateInviteToken, canInviteStaff)
// ya existía en los paquetes compartidos desde que restaurantes lo construyó; a
// despachos solo le faltaba exponer el lado del INVITADOR (ver
// apps/api/src/routes/verticals/despachos/admin-staff.ts) y esta plantilla de
// correo real.
import { escapeHtml, renderCorreo } from "./layout.ts";
import type { DespachosRole } from "../roles.ts";

const ROLE_LABEL: Record<DespachosRole, string> = {
  admin: "Administrador/a",
  contador: "Contador/a",
  auditor: "Auditor/a",
  readonly: "Solo lectura",
};

export interface StaffInviteCorreo {
  readonly email: string;
  readonly verticalRole: DespachosRole;
  /** URL completa ya armada por el caller (`${appBaseUrl}/aceptar-invitacion?token=...`)
   * — esta plantilla nunca construye URLs, solo las embebe como botón + texto plano
   * de respaldo (mismo criterio "nunca inventar una ruta" que el resto del dominio). */
  readonly acceptUrl: string;
  /** Ya formateada en el huso del servidor — una invitación de 7 días (ver
   * STAFF_INVITE_TTL_MS en admin-staff.ts) no necesita precisión de timezone del
   * negocio. */
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
      `Te invitaron a unirte al panel de despachos de <strong>atiende</strong> con el rol <strong>${escapeHtml(roleLabel)}</strong>.`,
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
    texto: `Te invitaron a unirte al panel de despachos de atiende con el rol ${roleLabel}.\nActiva tu cuenta aquí: ${c.acceptUrl}\nEste enlace vence el ${c.expiresAtTexto}.`,
  };
}
