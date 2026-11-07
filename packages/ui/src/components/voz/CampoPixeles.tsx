import { useEffect, useRef } from 'react';

/**
 * La nube de píxeles del hero de "Pregúntale a tus datos" — puerto directo del
 * componente real de Likida (dashboard/pixeles.tsx: "el efecto animado de
 * píxeles como el de usehandle"). Mismo algoritmo exacto: un canvas con
 * puntitos en rejilla cuya densidad modulan 3 nubes que derivan lento (en
 * tres lugares fijos, no toda la retícula moviéndose), con el centro limpio
 * porque ahí vive el contenido. El umbral de dithering es FIJO por celda —
 * los puntos aparecen/desaparecen porque la densidad cruza ese umbral, no
 * porque se desplacen.
 *
 * Diferencia a propósito con el original: color azul (--primary) en vez de
 * gris (--g3), y alpha algo más alta — "más visual" pedido explícitamente,
 * el resto del algoritmo es idéntico.
 */
export function CampoPixeles({ color = 'hsl(var(--primary))' }: { color?: string } = {}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    // «Reducir movimiento» se consulta en vivo: si cambia con la pantalla abierta, el campo se congela (un cuadro fijo) o vuelve a moverse.
    const preferencia = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const reducido = () => preferencia?.matches === true;
    // Fuera de pantalla (scroll, panel cerrado) no se dibuja: cuesta CPU y bateria sin que nadie lo vea.
    let visible = true;

    const CELDA = 10;
    const PUNTO = 2.4;
    let raf = 0;
    let vivo = true;
    let ultimo = 0;

    const umbral = (x: number, y: number) => {
      const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return n - Math.floor(n);
    };

    function medir() {
      if (!canvas || !ctx) return;
      const r = canvas.getBoundingClientRect();
      // Densidad de pixeles con tope 2: en pantallas 3x el costo se triplica sin diferencia visible a 2.4 px por punto.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function dibujar(t: number) {
      if (!canvas || !ctx) return;
      const r = canvas.getBoundingClientRect();
      const W = r.width, H = r.height;
      if (W === 0 || H === 0) return;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = getComputedStyle(canvas).color;

      const nubes = [
        { x: W * 0.84 + Math.sin(t * 0.00021) * W * 0.05, y: H * 0.14 + Math.cos(t * 0.00017) * H * 0.06, r: W * 0.26 },
        { x: W * 0.10 + Math.cos(t * 0.00019) * W * 0.05, y: H * 0.80 + Math.sin(t * 0.00023) * H * 0.06, r: W * 0.24 },
        { x: W * 0.30 + Math.sin(t * 0.00013) * W * 0.05, y: H * 0.08 + Math.cos(t * 0.00011) * H * 0.04, r: W * 0.15 },
      ];
      const cx = W / 2, cy = H * 0.45;

      for (let gx = 0; gx < W; gx += CELDA) {
        for (let gy = 0; gy < H; gy += CELDA) {
          let d = 0;
          for (const n of nubes) {
            const dx = (gx - n.x) / n.r, dy = (gy - n.y) / n.r;
            d += Math.max(0, 1 - (dx * dx + dy * dy));
          }
          const dcx = (gx - cx) / (W * 0.42), dcy = (gy - cy) / (H * 0.5);
          d *= Math.min(1, Math.max(0, dcx * dcx + dcy * dcy - 0.15) * 2.2);
          if (d > umbral(gx, gy)) {
            ctx.globalAlpha = Math.min(0.65, 0.22 + d * 0.4);
            ctx.fillRect(gx, gy, PUNTO, PUNTO);
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    function loop(ts: number) {
      if (!vivo || !visible || document.hidden || reducido()) { raf = 0; return; }
      if (ts - ultimo > 50) { ultimo = ts; dibujar(ts); }
      raf = requestAnimationFrame(loop);
    }

    const arrancar = () => {
      if (!raf && vivo && visible && !document.hidden && !reducido()) raf = requestAnimationFrame(loop);
    };
    const parar = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    medir();
    dibujar(0);
    arrancar();

    const alCambiarTamano = () => { medir(); dibujar(reducido() ? 0 : performance.now()); };
    const alCambiarVisibilidad = () => {
      if (document.hidden) parar();
      else arrancar();
    };
    const alCambiarPreferencia = () => {
      if (reducido()) { parar(); dibujar(0); } else arrancar();
    };
    preferencia?.addEventListener?.('change', alCambiarPreferencia);
    const enPantalla = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((es) => {
      visible = es.some((e) => e.isIntersecting);
      if (visible) arrancar(); else parar();
    });
    enPantalla?.observe(canvas);
    window.addEventListener('resize', alCambiarTamano);
    document.addEventListener('visibilitychange', alCambiarVisibilidad);

    // El `resize` de window no alcanza: este canvas vive dentro de un panel
    // flex cuyo tamaño cambia solo (datos que cargan, sidebar que se
    // colapsa, historial que se abre) sin que la ventana cambie de tamaño.
    // Sin esto, el buffer del canvas se queda con la medida vieja (a veces
    // más angosta, tomada antes de que el layout asentara) y el patrón no
    // llega hasta los bordes reales del contenedor.
    const observador = new ResizeObserver(alCambiarTamano);
    observador.observe(canvas);

    return () => {
      vivo = false;
      parar();
      preferencia?.removeEventListener?.('change', alCambiarPreferencia);
      enPantalla?.disconnect();
      window.removeEventListener('resize', alCambiarTamano);
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
      observador.disconnect();
    };
  }, []);

  return (
    <canvas ref={ref} aria-hidden
      className="absolute inset-0 h-full w-full pointer-events-none"
      style={{ color }} />
  );
}
