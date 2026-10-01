// Estilo común de los controles de texto/selección de DS v2 (Input, Textarea,
// NativeSelect): radio de campo (10 px, igual al rounded-md de hoy), alto por
// token de control y estado inválido por aria-invalid (lo pone FormField).
export const campoBase =
  "w-full rounded-field border border-input bg-background px-3 text-base text-foreground ring-offset-background placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-fast ease-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive md:text-sm";
