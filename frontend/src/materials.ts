/** Decorative light follows fine pointers only; no app state or content is read. */
export function startMaterialLight(): void {
  const motion = matchMedia("(prefers-reduced-motion: no-preference)");
  const fine = matchMedia("(hover: hover) and (pointer: fine) and (forced-colors: none)");
  let frame = 0;
  let pending: { node: HTMLElement; x: number; y: number } | undefined;
  let lit: HTMLElement | undefined;
  const clear = () => {
    cancelAnimationFrame(frame); frame = 0; pending = undefined;
    lit?.style.removeProperty("--light-x");
    lit?.style.removeProperty("--light-y");
    lit = undefined;
  };
  document.addEventListener("pointermove", event => {
    if (!motion.matches || !fine.matches || event.pointerType !== "mouse") return;
    const node = event.target instanceof Element
      ? event.target.closest<HTMLElement>("header nav a, .primary, .card, .galaxy-controls button")
      : null;
    if (node !== lit) clear();
    if (!node) return;
    pending = { node, x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const point = pending;
      pending = undefined;
      if (!point?.node.isConnected) return;
      const { node, x, y } = point;
      const bounds = node.getBoundingClientRect();
      node.style.setProperty("--light-x", `${Math.max(0, Math.min(bounds.width, x - bounds.left))}px`);
      node.style.setProperty("--light-y", `${Math.max(0, Math.min(bounds.height, y - bounds.top))}px`);
      lit = node;
      pending = undefined;
    });
  }, { passive: true });
  document.addEventListener("pointerleave", clear);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clear(); });
  motion.addEventListener("change", clear);
  fine.addEventListener("change", clear);
}
