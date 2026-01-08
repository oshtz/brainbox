/**
 * macOS Trackpad Click/Tap Normalizer
 *
 * Synthesizes a click for Masonry cards when a primary pointer press/release
 * occurs without movement. Scoped to Masonry to avoid interfering with inputs
 * and the window titlebar/drag regions.
 */

let isInitialized = false;

export function initializeTrackpadFix() {
  if (isInitialized) return;
  isInitialized = true;

  type ActiveState = {
    startX: number;
    startY: number;
    targetCard: HTMLElement | null;
    cancelled: boolean;
  } | null;

  let active: ActiveState = null;

  const isMac = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

  if (!isMac()) return;

  const withinMasonry = (el: Element | null) => !!(el && (el as HTMLElement).closest('.masonry'));
  const isFormControl = (el: Element | null) => !!(el && (
    (el as HTMLElement).tagName === 'INPUT' ||
    (el as HTMLElement).tagName === 'TEXTAREA' ||
    (el as HTMLElement).tagName === 'SELECT' ||
    (el as HTMLElement).isContentEditable ||
    (el as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')
  ));
  const isDragRegion = (el: Element | null) => !!(el && (
    (el as HTMLElement).closest('[data-tauri-drag-region]') ||
    (el as HTMLElement).closest('.titlebar') ||
    (el as HTMLElement).closest('[data-nodrag]')
  ));
  const isExcludedInteractive = (el: Element | null) => !!(el && (
    (el as HTMLElement).closest('button, [role="button"], .card-action, .masonry-card-menuBtn, .masonry-card-menu, .masonry-card-actions')
  ));

  const findCard = (el: Element | null): HTMLElement | null => {
    const card = (el as HTMLElement | null)?.closest('.masonry-card') as HTMLElement | null;
    return card || null;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // primary only
    const target = e.target as HTMLElement | null;
    if (!withinMasonry(target)) return;
    if (isFormControl(target) || isDragRegion(target) || isExcludedInteractive(target)) return;

    const card = findCard(target);
    if (!card) return;

    active = { startX: e.clientX, startY: e.clientY, targetCard: card, cancelled: false };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!active) return;
    const dx = Math.abs(e.clientX - active.startX);
    const dy = Math.abs(e.clientY - active.startY);
    if (dx > 5 || dy > 5) active.cancelled = true;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!active) return;
    const { startX, startY, targetCard, cancelled } = active;
    active = null;
    if (cancelled) return;

    const target = e.target as HTMLElement | null;
    if (!targetCard || !target || !withinMasonry(target)) return;
    // Ensure up occurs on same card
    const upCard = findCard(target);
    if (upCard !== targetCard) return;

    // Avoid firing when release is on excluded interactive areas
    if (isExcludedInteractive(target)) return;

    // Synthesize a native click on the card's clickable layer
    const clickable = (targetCard.querySelector('.masonry-card-bg') as HTMLElement) || targetCard;
    // Defer a tick to let default handlers settle
    setTimeout(() => {
      const evt = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: startX,
        clientY: startY,
        button: 0
      });
      clickable.dispatchEvent(evt);
    }, 0);
  };

  const onPointerCancel = () => { active = null; };

  // Attach listeners at the document level but strictly scoped to Masonry targets
  // Use non-capturing, passive listeners to avoid interfering with native clicks
  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerup', onPointerUp, { passive: true });
  document.addEventListener('pointercancel', onPointerCancel, { passive: true });
}

// Note: Initialization is controlled by the app (see src/main.tsx).
