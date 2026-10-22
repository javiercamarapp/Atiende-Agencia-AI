// Modo oscuro automatico del panel movil del operador: de noche (19:00 a 07:00) o si el sistema esta en oscuro, salvo que la persona haya
// elegido un tema explicito en el selector de tema (`atiende-tema` = claro | oscuro). Usa la misma clase `dark` en <html> que el selector,
// asi toma los tokens de ambito (azul marino oscuro) sin colores literales.
export const CLAVE_TEMA = "atiende-tema";

export function esHorarioNocturno(fecha: Date): boolean {
  const h = fecha.getHours();
  return h >= 19 || h < 7;
}

export function debeUsarOscuro(preferencia: string | null, fecha: Date, sistemaOscuro: boolean): boolean {
  if (preferencia === "oscuro") return true;
  if (preferencia === "claro") return false;
  if (preferencia === "sistema") return sistemaOscuro;
  return esHorarioNocturno(fecha) || sistemaOscuro;
}

/** Aplica el tema automatico y devuelve la funcion que restaura el estado anterior. */
export function aplicarTemaAutomatico(): () => void {
  if (typeof document === "undefined") return () => undefined;
  const raiz = document.documentElement;
  const antes = raiz.classList.contains("dark");
  let preferencia: string | null = null;
  try {
    preferencia = window.localStorage.getItem(CLAVE_TEMA);
  } catch {
    preferencia = null;
  }
  // El selector de tema guarda «claro» por omision al montarse; solo se respeta un valor que la persona haya elegido de verdad.
  const sistemaOscuro = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  raiz.classList.toggle("dark", debeUsarOscuro(preferencia, new Date(), sistemaOscuro));
  return () => raiz.classList.toggle("dark", antes);
}
