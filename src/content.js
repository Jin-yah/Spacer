/* Spacer — space visualizer content script */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let cfg = { triggerKey: 'Shift', limitSpaces: false, maxSpaces: 1 };
  let keyHeld     = false;
  let targetEl    = null;   // currently focused editable input
  let wrapDiv     = null;   // fixed-position clipping container
  let innerDiv    = null;   // scrollable mirror div with highlights
  let elScrollCb  = null;   // scroll listener attached to targetEl
  let ro          = null;   // ResizeObserver on targetEl
  let mo          = null;   // MutationObserver for ancestor layout-shift detection
  let rafId       = null;   // pending animation-frame repaint id

  // ── Settings ───────────────────────────────────────────────────────────────

  const canUseStorage = typeof chrome !== 'undefined' && chrome.storage?.sync;

  if (canUseStorage) {
    chrome.storage.sync.get(['triggerKey', 'limitSpaces', 'maxSpaces'], (r) => {
      if (chrome.runtime.lastError) return;
      if (r.triggerKey  !== undefined) cfg.triggerKey  = r.triggerKey;
      if (r.limitSpaces !== undefined) cfg.limitSpaces = r.limitSpaces;
      if (r.maxSpaces   !== undefined) cfg.maxSpaces   = r.maxSpaces;
    });

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.triggerKey)  cfg.triggerKey  = changes.triggerKey.newValue;
      if (changes.limitSpaces) cfg.limitSpaces = changes.limitSpaces.newValue;
      if (changes.maxSpaces)   cfg.maxSpaces   = changes.maxSpaces.newValue;
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function isTextInput(el) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'url', 'email', 'tel'].includes(t);
    }
    const ce = el.contentEditable;
    return ce === 'true' || ce === 'plaintext-only';
  }

  /** Walk up from el to the nearest contenteditable root, crossing shadow DOM boundaries. */
  function editableRoot(el) {
    let node = el;
    while (node) {
      if (node === document.documentElement) break;
      const ce = node.contentEditable;
      if (ce === 'true' || ce === 'plaintext-only') return node;
      if (node.parentElement) {
        node = node.parentElement;
      } else {
        // Cross shadow boundary upward
        const root = node.getRootNode();
        node = (root instanceof ShadowRoot) ? root.host : null;
      }
    }
    return null;
  }

  /** Get the plain text of any supported input element. */
  function getText(el) {
    let t;
    if ('value' in el) {
      t = el.value;
    } else {
      t = el.innerText ?? el.textContent ?? '';
      // Strip the single trailing \n browsers append to contenteditable
      if (t.endsWith('\n')) t = t.slice(0, -1);
    }
    // Browsers substitute non-breaking spaces (\u00a0) for regular spaces in
    // contenteditable to prevent CSS collapsing, producing an alternating
    // \u0020/\u00a0 pattern. Normalize so space detection is consistent.
    return t.replace(/\u00a0/g, ' ');
  }

  const COLOR_SINGLE = 'hsla(120,50%,60%,0.40)'; // green — one space
  const COLOR_MULTI  = 'hsla(28,90%,68%,0.45)';  // light orange — 2+ spaces

  // ── Overlay ────────────────────────────────────────────────────────────────

  function mount() {
    unmount();
    if (!targetEl) return;

    // Don't mount on elements with no visible area
    const testR = targetEl.getBoundingClientRect();
    if (testR.width === 0 || testR.height === 0) return;

    const el  = targetEl;
    const cs  = getComputedStyle(el);
    const r   = el.getBoundingClientRect();
    const tag  = el.tagName.toLowerCase();
    const isCE = el.contentEditable === 'true' || el.contentEditable === 'plaintext-only';
    const isTA = tag === 'textarea' || isCE;

    // Outer clipping frame.
    // Use position:absolute on <html> rather than position:fixed so that CSS
    // transforms / will-change / filter on ancestor elements (common in SPAs
    // like Google Forms/Slides) don't create a new containing block that
    // shifts fixed-position children away from the viewport.
    // We manually convert the element's viewport rect to page coordinates.
    const scrollX = window.scrollX ?? window.pageXOffset ?? 0;
    const scrollY = window.scrollY ?? window.pageYOffset ?? 0;
    wrapDiv = document.createElement('div');
    wrapDiv.setAttribute('aria-hidden', 'true');
    Object.assign(wrapDiv.style, {
      position:      'absolute',
      left:          (r.left + scrollX) + 'px',
      top:           (r.top  + scrollY) + 'px',
      width:         r.width  + 'px',
      height:        r.height + 'px',
      overflow:      'hidden',
      pointerEvents: 'none',
      zIndex:        '2147483647',
      boxSizing:     'border-box',
    });

    // Inner div — for textarea/input this mirrors font/padding/border to align text;
    // for contenteditable it is a plain transparent layer whose children are
    // absolutely-positioned highlight boxes placed via Range.getBoundingClientRect().
    innerDiv = document.createElement('div');
    if (isCE) {
      Object.assign(innerDiv.style, {
        position:     'absolute',
        top:          '0',
        left:         '0',
        width:        r.width  + 'px',
        height:       r.height + 'px',
        pointerEvents:'none',
        overflow:     'visible',
      });
    } else {
      Object.assign(innerDiv.style, {
        position:     'absolute',
        top:          '0',
        left:         '0',
        margin:       '0',
        boxSizing:    'border-box',
        width:        r.width + 'px',

        // Transparent border preserving the same offset as the real input border
        borderTopWidth:    cs.borderTopWidth,
        borderRightWidth:  cs.borderRightWidth,
        borderBottomWidth: cs.borderBottomWidth,
        borderLeftWidth:   cs.borderLeftWidth,
        borderStyle:       'solid',
        borderColor:       'transparent',

        paddingTop:    cs.paddingTop,
        paddingRight:  cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft:   cs.paddingLeft,

        fontFamily:    cs.fontFamily,
        fontSize:      cs.fontSize,
        fontWeight:    cs.fontWeight,
        fontStyle:     cs.fontStyle,
        letterSpacing: cs.letterSpacing,
        wordSpacing:   cs.wordSpacing,
        lineHeight:    cs.lineHeight,
        textAlign:     cs.textAlign,
        textIndent:    cs.textIndent,
        textTransform: cs.textTransform,

        whiteSpace:   'pre-wrap',
        wordBreak:    'break-word',
        overflowWrap: 'break-word',

        background:    'transparent',
        color:         'transparent',
        pointerEvents: 'none',
      });
    }

    wrapDiv.appendChild(innerDiv);
    document.documentElement.appendChild(wrapDiv);

    paint();
    if (!isCE) syncScroll();

    // Sync overlay scroll whenever the input scrolls.
    // For contenteditable the range-based positions are already viewport-relative,
    // so we just repaint on scroll rather than translating the mirror div.
    elScrollCb = isCE ? () => schedPaint() : () => syncScroll();
    el.addEventListener('scroll', elScrollCb, { passive: true });

    // Reposition if the input resizes
    ro = new ResizeObserver(() => reposition());
    ro.observe(el);

    // Detect surrounding DOM mutations that shift the input's position without
    // changing its own size (e.g. ChatGPT's toolbar moving from inline to below
    // the input when the first newline is typed, causing the editor to slide left).
    // Walk up to find a stable ancestor to observe — stop at a form, dialog,
    // main landmark, or fall back to body.
    const moRoot = el.closest('form, [role="dialog"], [role="main"], main') ?? document.body;
    mo = new MutationObserver(() => schedPaint());
    mo.observe(moRoot, {
      childList:      true,
      subtree:        true,
      attributes:     true,
      attributeFilter: ['class', 'style'],
    });
  }

  /**
   * Highlight spaces in a <textarea> or <input> by rendering a CSS-mirrored div.
   * Non-space text is transparent (takes up space without being visible).
   * Each run of consecutive spaces becomes a single highlighted block.
   *   • 1 space   → green,        no label
   *   • 2+ spaces → light orange, count label centred across the whole run
   */
  function paintTA() {
    if (!innerDiv || !targetEl) return;

    const text = getText(targetEl);
    const frag = document.createDocumentFragment();
    let i = 0;

    while (i < text.length) {
      if (text[i] === ' ') {
        let j = i + 1;
        while (j < text.length && text[j] === ' ') j++;
        const count = j - i;

        const sp = document.createElement('span');
        sp.style.cssText =
          'position:relative;' +
          'display:inline;' +
          'white-space:pre;' +
          `background:${count === 1 ? COLOR_SINGLE : COLOR_MULTI};` +
          'border-radius:3px;';
        sp.appendChild(document.createTextNode(text.slice(i, j)));

        if (count >= 2) {
          const lbl = document.createElement('span');
          lbl.style.cssText =
            'position:absolute;' +
            'top:50%;left:50%;' +
            'transform:translate(-50%,-50%);' +
            'font-size:12px;line-height:1;' +
            'font-family:monospace;font-weight:700;' +
            'color:rgba(0,0,0,0.55);' +
            'user-select:none;white-space:nowrap;' +
            'pointer-events:none;';
          lbl.textContent = count;
          sp.appendChild(lbl);
        }

        frag.appendChild(sp);
        i = j;
      } else {
        let j = i + 1;
        while (j < text.length && text[j] !== ' ') j++;
        const span = document.createElement('span');
        span.style.color = 'transparent';
        span.textContent = text.slice(i, j);
        frag.appendChild(span);
        i = j;
      }
    }

    innerDiv.replaceChildren(frag);
  }

  /**
   * Highlight spaces in a contenteditable element using Range.getBoundingClientRect().
   * This measures where each space actually renders in the real DOM, so it handles
   * multi-line editors with <p>/<div> structure (ChatGPT, Gmail, etc.) correctly.
   */
  function paintCE() {
    if (!innerDiv || !targetEl) return;

    const targetRect = targetEl.getBoundingClientRect();
    const frag = document.createDocumentFragment();

    const walker = document.createTreeWalker(targetEl, NodeFilter.SHOW_TEXT, null, false);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const raw  = textNode.textContent;
      const text = raw.replace(/\u00a0/g, ' ');
      let i = 0;

      while (i < text.length) {
        if (text[i] === ' ') {
          let j = i + 1;
          while (j < text.length && text[j] === ' ') j++;
          const count = j - i;

          try {
            const r2 = document.createRange();
            r2.setStart(textNode, i);
            r2.setEnd(textNode, j);
            const rect = r2.getBoundingClientRect();

            if (rect.width > 0 && rect.height > 0) {
              const hl = document.createElement('div');
              Object.assign(hl.style, {
                position:   'absolute',
                left:       (rect.left - targetRect.left) + 'px',
                top:        (rect.top  - targetRect.top)  + 'px',
                width:      rect.width  + 'px',
                height:     rect.height + 'px',
                background: count === 1 ? COLOR_SINGLE : COLOR_MULTI,
                borderRadius: '3px',
                pointerEvents: 'none',
                boxSizing: 'border-box',
              });

              if (count >= 2) {
                const lbl = document.createElement('span');
                lbl.style.cssText =
                  'position:absolute;top:50%;left:50%;' +
                  'transform:translate(-50%,-50%);' +
                  'font-size:12px;line-height:1;' +
                  'font-family:monospace;font-weight:700;' +
                  'color:rgba(0,0,0,0.55);' +
                  'user-select:none;white-space:nowrap;' +
                  'pointer-events:none;';
                lbl.textContent = count;
                hl.appendChild(lbl);
              }

              frag.appendChild(hl);
            }
          } catch (_) {}

          i = j;
        } else {
          i++;
        }
      }
    }

    innerDiv.replaceChildren(frag);
  }

  /** Route paint() to the correct implementation for the current element. */
  function paint() {
    if (!innerDiv || !targetEl) return;
    const isCE = targetEl.contentEditable === 'true' || targetEl.contentEditable === 'plaintext-only';
    if (isCE) paintCE(); else paintTA();
  }

  /**
   * Translate innerDiv to mirror the input's scroll position.
   * Only used for textarea/input; contenteditable repaints via schedPaint() instead
   * because Range.getBoundingClientRect() already returns viewport-relative coords.
   */
  function syncScroll() {
    if (!innerDiv || !targetEl) return;
    const sl = targetEl.scrollLeft ?? 0;
    const st = targetEl.scrollTop  ?? 0;
    innerDiv.style.transform = `translate(${-sl}px,${-st}px)`;
  }

  /** Reposition wrapDiv if the input has moved or resized. */
  function reposition() {
    if (!wrapDiv || !targetEl) return;
    const r = targetEl.getBoundingClientRect();
    const scrollX = window.scrollX ?? window.pageXOffset ?? 0;
    const scrollY = window.scrollY ?? window.pageYOffset ?? 0;
    Object.assign(wrapDiv.style, {
      left:   (r.left + scrollX) + 'px',
      top:    (r.top  + scrollY) + 'px',
      width:  r.width  + 'px',
      height: r.height + 'px',
    });
    innerDiv.style.width = r.width + 'px';
    // For contenteditable, highlight boxes are placed via Range.getBoundingClientRect()
    // relative to the element's current bounding rect, so we must repaint after any
    // position/size change to recalculate those offsets.
    const isCE = targetEl.contentEditable === 'true' || targetEl.contentEditable === 'plaintext-only';
    if (isCE) paint();
  }

  function unmount() {
    if (wrapDiv) { wrapDiv.remove(); wrapDiv = null; innerDiv = null; }
    if (elScrollCb && targetEl) {
      targetEl.removeEventListener('scroll', elScrollCb);
      elScrollCb = null;
    }
    if (ro) { ro.disconnect(); ro = null; }
    if (mo) { mo.disconnect(); mo = null; }
  }

  /** Debounce overlay updates to one per animation frame. */
  function schedPaint() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (keyHeld && targetEl) { reposition(); paint(); syncScroll(); }
    });
  }

  // ── Key matching ───────────────────────────────────────────────────────────

  /**
   * Walk document.activeElement through iframes and shadow roots to find
   * the deepest truly-focused element.
   */
  function deepActiveElement() {
    let el = document.activeElement;
    try {
      while (el) {
        const tag = el.tagName && el.tagName.toLowerCase();
        if (tag === 'iframe' && el.contentDocument) {
          el = el.contentDocument.activeElement;
        } else if (el.shadowRoot && el.shadowRoot.activeElement) {
          el = el.shadowRoot.activeElement;
        } else {
          break;
        }
      }
    } catch (_) {}
    return el;
  }

  function isTrigger(e) {
    return e.key === cfg.triggerKey;
  }

  /**
   * Resolve the best editable element to track.
   * Always checks the live activeElement first so we pick up focus changes
   * that happened without our focusin listener firing (e.g. Slides, jsaction).
   * Falls back to the previously-known targetEl as a last resort.
   */
  function resolveTarget() {
    const ae = deepActiveElement();
    if (ae) {
      if (isTextInput(ae)) return ae;
      const root = editableRoot(ae);
      if (root) return root;
    }
    return targetEl; // stale fallback
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    // Show overlay when trigger key is pressed
    if (isTrigger(e) && !keyHeld) {
      keyHeld = true;
      // Always re-resolve from the live activeElement — don't trust cached
      // targetEl since focus may have moved without our listeners noticing
      // (e.g. Google Slides swallows focusin in its own capture handlers).
      const resolved = resolveTarget();
      if (resolved) targetEl = resolved;
      if (targetEl) mount();
    }

    // While the trigger is held, repaint on every other keydown as a fallback
    // for pages (e.g. Google jsaction) that swallow `input` events before our
    // capture-phase listener can see them.
    if (keyHeld && targetEl && !isTrigger(e)) {
      schedPaint();
    }

    // Space limiting: block extra consecutive spaces unless trigger is held
    if (e.key === ' ' && !keyHeld && cfg.limitSpaces) {
      // Use a live resolve so targetEl being temporarily null (e.g. between focus
      // events in complex editors) doesn't silently skip the check.
      const tEl = targetEl || resolveTarget();
      if (tEl) {
        if ('value' in tEl) {
          // <input> / <textarea>
          const val = tEl.value;
          const pos = tEl.selectionStart;
          let run = 0;
          for (let i = pos - 1; i >= 0 && val[i] === ' '; i--) run++;
          if (run >= cfg.maxSpaces) e.preventDefault();
        } else {
          // contenteditable — build a range from the element start to the caret
          // so the text check crosses text-node boundaries automatically.
          // (Single-node check misses the case where the cursor lands at offset 0
          // of a new text node right after a space, common in Lexical/ProseMirror.)
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            try {
              const caretRange = sel.getRangeAt(0);
              const preRange   = document.createRange();
              preRange.selectNodeContents(tEl);
              preRange.setEnd(caretRange.startContainer, caretRange.startOffset);
              const preTxt = preRange.toString().replace(/\u00a0/g, ' ');
              let run = 0;
              for (let i = preTxt.length - 1; i >= 0 && preTxt[i] === ' '; i--) run++;
              if (run >= cfg.maxSpaces) e.preventDefault();
            } catch (_) {}
          }
        }
      }
    }
  }, true);

  document.addEventListener('keyup', (e) => {
    if (isTrigger(e)) { keyHeld = false; unmount(); }
  }, true);

  // Hide overlay if window loses focus (trigger keyup may be missed)
  window.addEventListener('blur', () => { keyHeld = false; unmount(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { keyHeld = false; unmount(); }
  });

  document.addEventListener('focusin', (e) => {
    // composedPath pierces shadow DOM; path[0] is the real target element
    const path = e.composedPath ? e.composedPath() : [];
    let el = path[0] || e.target;
    if (!isTextInput(el)) {
      const root = editableRoot(el);
      if (root) el = root; else return;
    }
    targetEl = el;
    if (keyHeld) mount();
  }, true);

  document.addEventListener('focusout', (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    const blurred = path[0] || e.target;
    if (blurred === targetEl || (targetEl && targetEl.contains && targetEl.contains(blurred))) {
      unmount();
      targetEl = null;
    }
  }, true);

  // Proactively capture the target on pointer down, before focusin fires.
  // This ensures targetEl is set on sites (e.g. Google) that call
  // stopImmediatePropagation() on focus events in their own capture listeners.
  document.addEventListener('pointerdown', (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    let el = path[0] || e.target;
    if (!isTextInput(el)) {
      const root = editableRoot(el);
      if (root) el = root; else return;
    }
    targetEl = el;
  }, true);

  // Repaint when the text changes while the overlay is visible.
  // For contenteditable the event may bubble up from a child node.
  document.addEventListener('input', (e) => {
    if (!keyHeld) return;
    // If targetEl was never set (focusin was swallowed), try activeElement now
    if (!targetEl) {
      const resolved = resolveTarget();
      if (resolved) { targetEl = resolved; mount(); return; }
    }
    const t = e.target;
    if (t === targetEl || (targetEl && targetEl.contains && targetEl.contains(t))) schedPaint();
  }, true);

  // Repaint on paste/cut — input event may not fire for these on some pages
  document.addEventListener('paste', () => { if (keyHeld && targetEl) schedPaint(); }, true);
  document.addEventListener('cut',   () => { if (keyHeld && targetEl) schedPaint(); }, true);

  // selectionchange fires in contenteditable editors (incl. Google Slides)
  // even when input events are suppressed by the page framework.
  document.addEventListener('selectionchange', () => {
    if (keyHeld && targetEl) schedPaint();
  });

  // Reposition when the page scrolls (e.g. sticky inputs shift on scroll)
  document.addEventListener('scroll', () => {
    if (keyHeld && targetEl) reposition();
  }, { capture: true, passive: true });

  window.addEventListener('resize', () => {
    if (keyHeld && targetEl) reposition();
  }, { passive: true });

})();
