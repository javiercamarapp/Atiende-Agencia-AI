import { createGlyphAtlas } from "./particle-glyph-atlas.ts";
type Shape = "sphere" | "torus" | "diamond" | "octahedron" | "cube" | "helix" | "double-ring";
const symbols: Partial<Record<Shape, number[][][]>> = {};
const glyphs = "01{}[]<>/\\+=:;%&!?$#()*-0123456789";

/** Original typographic geometry, blue depth lighting and eased pointer orbit. */
export function mountParticleGlobe(
  canvas: HTMLCanvasElement,
  shape: Shape,
  crop = false,
  compact = false,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const surface =
    canvas.closest<HTMLElement>(
      ".demo-editorial, .login-story-surface, .agent-constellation",
    ) ?? canvas;
  const styles = getComputedStyle(canvas);
  const color = (name: string) => styles.getPropertyValue(`--login-particle-${name}`).trim() || "transparent";
  const palette = { glow: color("glow"), wash: color("wash"), clear: color("clear"), front: color("front"), middle: color("middle"), rear: color("rear"), ambient: color("ambient") };
  const atlas = createGlyphAtlas(glyphs, [palette.front, palette.middle, palette.rear]);
  let width = 0,
    height = 0,
    raf = 0,
    visible = false,
    last = 0,
    angle = 0.28;
  let targetX = 0,
    targetY = 0,
    pointerX = 0,
    pointerY = 0;
  let cursorX = -10000, cursorY = -10000, elapsed = 0, frameSeconds = 0;
  let hovered = false, energy = 0, flowTime = 0;
  const count = compact ? 650 : crop ? 4200 : 1600;
  const segments = (symbols[shape] ?? []).flatMap((path) =>
    path.slice(1).map((b, i) => ({
      a: path[i]!,
      b,
      length: Math.hypot(b[0]! - path[i]![0]!, b[1]! - path[i]![1]!),
    })),
  );
  const totalLength = segments.reduce((sum, line) => sum + line.length, 0);
  const points = Array.from({ length: count }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / count;
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    const r = Math.sqrt(1 - y * y);
    let x = r * Math.cos(phi),
      z = r * Math.sin(phi),
      py = y;
    if (shape === "torus" || shape === "double-ring") {
      const u = i * 2.39996,
        v = i * 0.677;
      x = (0.7 + 0.3 * Math.cos(v)) * Math.cos(u);
      py = 0.3 * Math.sin(v);
      z = (0.7 + 0.3 * Math.cos(v)) * Math.sin(u);
      if (shape === "double-ring" && i % 2 === 0) [py, z] = [z, py];
    } else if (shape === "diamond" || shape === "octahedron") {
      const scale = 1.25 / (Math.abs(x) + Math.abs(py) + Math.abs(z));
      x *= scale;
      py *= scale;
      z *= scale;
    } else if (shape === "cube") {
      const scale = 0.76 / Math.max(Math.abs(x), Math.abs(py), Math.abs(z));
      x *= scale;
      py *= scale;
      z *= scale;
    } else if (shape === "helix") {
      const turn = (i / count) * Math.PI * 5 + (i % 2 ? Math.PI : 0);
      x = (0.54 + 0.1 * Math.cos(phi)) * Math.cos(turn);
      z = (0.54 + 0.1 * Math.sin(phi)) * Math.sin(turn);
    }
    if (segments.length) {
      let along = ((i + 0.5) / count) * totalLength;
      let line = segments[segments.length - 1]!;
      for (const candidate of segments) {
        if (along <= candidate.length) {
          line = candidate;
          break;
        }
        along -= candidate.length;
      }
      const t = along / line.length,
        jitter = Math.sin(i * 12.9898) * 0.027;
      x = line.a[0]! + (line.b[0]! - line.a[0]!) * t + jitter;
      py =
        line.a[1]! + (line.b[1]! - line.a[1]!) * t + Math.cos(i * 7.31) * 0.027;
      z = Math.sin(i * 4.79) * 0.12;
    }
    return { x, y: py, z, glyph: glyphs[i % glyphs.length] ?? "+", seed: i, ox: 0, oy: 0, vx: 0, vy: 0 };
  });
  function draw() {
    if (!ctx || !width || !height) return;
    ctx.clearRect(0, 0, width, height);
    const radius = crop
      ? Math.max(width * 0.63, height * 0.77)
      : Math.min(width, height) * 0.39;
    const cx = width * 0.5 + pointerX * 9;
    const cy = crop ? radius * 1.06 + height * 0.045 : height * 0.5;
    const glow = ctx.createRadialGradient(
      cx,
      cy - radius * 0.25,
      0,
      cx,
      cy,
      radius * 1.18,
    );
    glow.addColorStop(0, palette.glow);
    glow.addColorStop(0.6, palette.wash);
    glow.addColorStop(1, palette.clear);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    const yaw =
        (segments.length ? Math.sin(angle) * 0.08 : angle) + pointerX * 0.22,
      pitch = -0.12 + pointerY * 0.12;
    const c = Math.cos(yaw),
      s = Math.sin(yaw),
      cp = Math.cos(pitch),
      sp = Math.sin(pitch);
    const projected = points
      .map((p) => {
        // Several travelling waves deform the surface continuously, not just its orbit.
        const wave = Math.sin(p.x * 4.7 + p.y * 3.2 + flowTime * 1.2)
          * Math.cos(p.z * 3.8 - flowTime * 0.73);
        const ripple = Math.sin(p.y * 8.2 - p.z * 3.1 + flowTime * 1.65);
        const amplitude = motion.matches ? 0.025 : 0.07 + energy * 0.09;
        const radial = 1 + amplitude * wave + amplitude * 0.38 * ripple;
        const shear = Math.sin(p.y * 3.4 + flowTime * 0.8) * amplitude;
        const px = p.x * radial + p.z * shear;
        const py = p.y * radial + Math.sin(p.x * 5 + flowTime) * amplitude * 0.28;
        const pz = p.z * radial;
        const x = px * c - pz * s, z = px * s + pz * c;
        return { ...p, x, y: py * cp - z * sp, z: py * sp + z * cp };
      })
      .sort((a, b) => a.z - b.z);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of projected) {
      const depth = segments.length
        ? 0.48 + (p.seed % 9) / 18
        : Math.max(0, Math.min(1, (p.z + 1.2) / 2.4));
      const scale = 2.9 / (2.9 - p.z * 0.35);
      const original = points[p.seed]!;
      const baseX = cx + p.x * radius * scale, baseY = cy + p.y * radius * scale;
      if (frameSeconds && !motion.matches) {
        const dx = baseX + original.ox - cursorX, dy = baseY + original.oy - cursorY;
        const distance = Math.hypot(dx, dy), reach = Math.min(245, radius * 0.58);
        const force = distance < reach ? (1 - distance / reach) ** 2 * 2600 * (0.3 + depth) : 0;
        original.vx += (((dx - dy * 0.85) / Math.max(1, distance)) * force - original.ox * 20 - original.vx * 8) * frameSeconds;
        original.vy += (((dy + dx * 0.85) / Math.max(1, distance)) * force - original.oy * 20 - original.vy * 8) * frameSeconds;
        original.ox += original.vx * frameSeconds;
        original.oy += original.vy * frameSeconds;
      }
      const x = baseX + original.ox, y = baseY + original.oy;
      const glyph = glyphs[(p.seed + Math.floor((elapsed + p.seed * 173) / (1800 + p.seed % 7 * 240))) % glyphs.length]!;
      if (y < -20 || y > height + 20 || x < -20 || x > width + 20) continue;
      const variation = 0.71 + (p.seed % 7) * 0.065;
      const size =
        Math.max(7, Math.min(22, radius * (compact ? 0.075 : 0.037))) *
        (0.38 + depth * 1.08) *
        variation;
      const rim = Math.max(0, -p.y) * (0.5 + depth * 0.5);
      const illumination = depth * 0.82 + rim * 0.42 - p.x * 0.18;
      ctx.globalAlpha = Math.min(1, (crop ? 0.18 : 0.12) + depth * 0.75 + rim * 0.45);
      atlas?.draw(ctx, glyph, x, y, size, illumination > 0.78 ? 0 : depth > 0.4 ? 1 : 2);
    }
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = palette.ambient;
    ctx.font = "11px monospace";
    for (let i = 0; i < 15; i++)
      ctx.fillText(
        glyphs[i] ?? "+",
        (((i * 97) % 101) / 101) * width,
        (((i * 53) % 101) / 101) * height,
      );
    ctx.globalAlpha = 1;
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  }
  function tick(now: number) {
    // Media preferences can change before the browser delivers its change event.
    // Paint the stable frame and update the public state before stopping RAF.
    if (motion.matches) {
      sync();
      return;
    }
    if (!visible || document.hidden || motion.matches) {
      stop();
      return;
    }
    if (!last || now - last >= 33) {
      const dt = last ? Math.min(now - last, 80) : 33;
      frameSeconds = dt / 1000;
      elapsed += dt;
      energy += ((hovered ? 1 : 0) - energy) * (1 - Math.exp(-dt / (hovered ? 240 : 950)));
      flowTime += dt * 0.00055 * (1 + energy * 3.2);
      angle += dt * 0.000045 * (1 + energy * 4.5);
      const ease = 1 - Math.exp(-dt / 190);
      pointerX += (targetX - pointerX) * ease;
      pointerY += (targetY - pointerY) * ease;
      last = now;
      draw();
    }
    raf = requestAnimationFrame(tick);
  }
  function sync() {
    stop();
    frameSeconds = 0;
    if (motion.matches) {
      hovered = false;
      energy = 0;
      pointerX = pointerY = targetX = targetY = 0;
      cursorX = cursorY = -10000;
      for (const p of points) p.ox = p.oy = p.vx = p.vy = 0;
    }
    canvas.dataset.motion = motion.matches ? "reduced" : "interactive";
    draw();
    if (visible && !document.hidden && !motion.matches)
      raf = requestAnimationFrame(tick);
  }
  function pointer(event: PointerEvent) {
    if (motion.matches || event.pointerType === "touch") return;
    hovered = true;
    const canvasBounds = canvas.getBoundingClientRect();
    cursorX = event.clientX - canvasBounds.left;
    cursorY = event.clientY - canvasBounds.top;
    const bounds = surface.getBoundingClientRect();
    targetX = Math.max(
      -1,
      Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1),
    );
    targetY = Math.max(
      -1,
      Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1),
    );
  }
  function leave() {
    hovered = false;
    targetX = targetY = 0;
    cursorX = cursorY = -10000;
  }
  const resize = new ResizeObserver(() => {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  });
  const observer = new IntersectionObserver(([entry]) => {
    visible = Boolean(entry?.isIntersecting);
    sync();
  });
  resize.observe(canvas);
  observer.observe(canvas);
  surface.addEventListener("pointermove", pointer, { passive: true });
  surface.addEventListener("pointerleave", leave);
  document.addEventListener("visibilitychange", sync);
  motion.addEventListener("change", sync);
  sync();
  return () => {
    stop();
    resize.disconnect();
    observer.disconnect();
    surface.removeEventListener("pointermove", pointer);
    surface.removeEventListener("pointerleave", leave);
    document.removeEventListener("visibilitychange", sync);
    motion.removeEventListener("change", sync);
  };
}
