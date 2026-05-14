(function () {
  'use strict';

  const keyDisplay    = document.getElementById('keyDisplay');
  const changeKeyBtn  = document.getElementById('changeKeyBtn');
  const keyHint       = document.getElementById('keyHint');
  const limitToggle   = document.getElementById('limitToggle');
  const maxSpacesRow  = document.getElementById('maxSpacesRow');
  const maxSpacesInput = document.getElementById('maxSpacesInput');

  let capturing = false;

  // ── Load saved settings ─────────────────────────────────────────────────────

  chrome.storage.sync.get(['triggerKey', 'limitSpaces', 'maxSpaces'], (r) => {
    keyDisplay.textContent    = fmtKey(r.triggerKey ?? 'Shift');
    limitToggle.checked       = r.limitSpaces ?? false;
    maxSpacesInput.value      = r.maxSpaces   ?? 1;
    updateMaxRow();
  });

  // ── Keybind recording ───────────────────────────────────────────────────────

  changeKeyBtn.addEventListener('click', () => {
    if (capturing) return;
    capturing = true;
    keyDisplay.textContent = '…';
    keyDisplay.classList.add('capturing');
    keyHint.hidden = false;
    changeKeyBtn.disabled = true;
  });

  document.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      // Restore the previously saved key
      chrome.storage.sync.get(['triggerKey'], (r) => {
        keyDisplay.textContent = fmtKey(r.triggerKey ?? 'Shift');
      });
    } else {
      keyDisplay.textContent = fmtKey(e.key);
      chrome.storage.sync.set({ triggerKey: e.key });
    }

    capturing = false;
    keyDisplay.classList.remove('capturing');
    keyHint.hidden = true;
    changeKeyBtn.disabled = false;
  }, true);

  // ── Space limit toggle ──────────────────────────────────────────────────────

  limitToggle.addEventListener('change', () => {
    chrome.storage.sync.set({ limitSpaces: limitToggle.checked });
    updateMaxRow();
  });

  maxSpacesInput.addEventListener('change', () => {
    const val = Math.max(1, Math.min(99, parseInt(maxSpacesInput.value, 10) || 1));
    maxSpacesInput.value = val;
    chrome.storage.sync.set({ maxSpaces: val });
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function updateMaxRow() {
    maxSpacesRow.classList.toggle('disabled', !limitToggle.checked);
  }

  function fmtKey(key) {
    if (key === ' ')       return 'Space';
    if (key === 'Control') return 'Ctrl';
    return key;
  }

})();
