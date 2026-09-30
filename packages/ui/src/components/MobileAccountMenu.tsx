import { useState, type ReactNode } from "react";
import { LogOut, UserRound } from "lucide-react";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { ThemeSelector } from "./ThemeSelector";

export interface MobileAccountMenuProps {
  user: { email: string; rol?: string } | null;
  onLogout: () => void;
  /** Mientras el cierre de sesión está en vuelo: deshabilita el botón y cambia su texto. */
  loggingOut?: boolean;
  /** Controles extra de la cuenta (p. ej. el botón "Chatea con tus datos"). */
  children?: ReactNode;
}

/**
 * Menú de cuenta para el `MobileHeader`. En móvil el `<Sidebar>` (donde viven
 * el chip de usuario, el tema y "Cerrar sesión") está oculto (`hidden md:flex`),
 * y antes solo licitaciones ofrecía un "Salir". Este botón abre una hoja con la
 * cuenta, el tema, los controles extra que pase el Shell y el cierre de sesión.
 */
export function MobileAccountMenu({ user, onLogout, loggingOut = false, children }: MobileAccountMenuProps) {
  const [abierto, setAbierto] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        aria-label="Abrir menú de cuenta"
        aria-haspopup="dialog"
        className="w-11 h-11 shrink-0 rounded-full flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
      >
        <UserRound className="w-5 h-5" strokeWidth={1.75} />
      </button>
      <Sheet open={abierto} onOpenChange={setAbierto}>
        <SheetContent side="right" className="flex flex-col gap-4 pt-10">
          <SheetHeader>
            <SheetTitle>Tu cuenta</SheetTitle>
            <SheetDescription>
              {user?.email ?? "Sin sesión"}
              {user?.rol ? ` · ${user.rol}` : ""}
            </SheetDescription>
          </SheetHeader>
          {children}
          <div className="flex justify-center">
            <ThemeSelector />
          </div>
          <Button type="button" variant="outline" onClick={onLogout} disabled={loggingOut} className="mt-auto text-destructive">
            <LogOut className="w-4 h-4" strokeWidth={1.75} />
            {loggingOut ? "Saliendo…" : "Cerrar sesión"}
          </Button>
        </SheetContent>
      </Sheet>
    </>
  );
}
