// Aviso de Privacidad — página real mínima, ver el comentario de cabecera de
// Terminos.tsx (mismo alcance, mismo marco `PaginaLegal` y mismo criterio honesto).
import { PaginaLegal } from "../components/PaginaLegal.tsx";
import type { SeccionLegal } from "../components/PaginaLegal.tsx";

const SECCIONES: readonly SeccionLegal[] = [
  {
    titulo: "1. Qué guardamos de ti",
    parrafos: [
      "Para entrar a tu panel guardamos tu correo, tu nombre y, si inicias sesión con Google, el identificador estable de tu cuenta de Google — nunca tu contraseña de Google, y nunca tu contraseña en texto plano en ningún caso (se guarda hasheada).",
      'Si usas "Continuar con correo", el enlace que te enviamos expira en 15 minutos y solo funciona una vez — no lo compartas, es equivalente a tu contraseña por ese tiempo.',
    ],
  },
  {
    titulo: "2. Datos de tu organización",
    parrafos: [
      "Los datos operativos de tu vertical (reservas, pedidos, mensajes de WhatsApp, documentos y expedientes) pertenecen a tu organización, no a atiende.ai — los tratamos únicamente para operar el panel que tu organización contrató.",
    ],
  },
  {
    titulo: "3. Revocar tu acceso",
    parrafos: ["Puedes pedir a quien administra tu organización que revoque tu acceso en cualquier momento; eso cierra todas tus sesiones activas."],
  },
];

export function PrivacidadPage() {
  return (
    <PaginaLegal
      etiqueta="atiende.ai · Legal"
      titulo="Aviso de Privacidad"
      bajada="Resumen operativo de qué datos guardamos y para qué."
      secciones={SECCIONES}
      aviso="Este es un resumen operativo, no un aviso de privacidad redactado conforme a la legislación de cada jurisdicción donde opere tu organización. Si lo necesitas, contáctanos."
    />
  );
}
