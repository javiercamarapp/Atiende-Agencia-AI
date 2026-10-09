// Estilo comun de los controles de texto/seleccion (Input, Textarea, NativeSelect)
// identico al campo de Likida (admin/vendedores/formas.tsx:18): rounded-lg, px-3,
// text-ui (13 px), fondo de tarjeta. El borde usa --input (#8a8a93 en claro,
// 3.42:1: unica desviacion de contraste de la spec, decision 3 de Javier del 1-oct).
// Foco como Likida: el borde pasa a --muted-foreground en lugar del anillo con
// offset; se suma un ring-1 del mismo color (no ocupa espacio) para que el foco
// sea claramente visible con teclado. Estado invalido por aria-invalid (lo pone FormField).
// Ambito restaurantes (`rest:`, UNI-R0b): el campo del repo suelto: radio 10 px, fondo --background, 16 px en movil (evita el zoom de iOS) y 14 px desde md,
// foco con anillo de 2 px y offset de 2 px.
export const campoBase =
  "w-full rounded-lg border border-input bg-card px-3 text-ui text-foreground placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-fast ease-brand focus-visible:outline-none focus-visible:border-muted-foreground focus-visible:ring-1 focus-visible:ring-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:border-destructive aria-[invalid=true]:focus-visible:ring-destructive rest:rounded-field rest:bg-background rest:text-base rest:md:text-sm rest:ring-offset-background rest:focus-visible:border-input rest:focus-visible:ring-2 rest:focus-visible:ring-ring rest:focus-visible:ring-offset-2 rest:aria-[invalid=true]:focus-visible:border-destructive rest:aria-[invalid=true]:focus-visible:ring-destructive";
