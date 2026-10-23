let speechEnabled = false;
let toastTimer: number | undefined;

export function setSpeech(on: boolean): void {
  speechEnabled = on;
  if (!on) speechSynthesis?.cancel();
}

/**
 * Status message for everyone: screen readers (ARIA live region), optional built-in speech,
 * and a short visual toast. Speech is opt-in, so it never talks over the audio cues uninvited.
 */
export function announce(message: string, opts: { speak?: boolean } = {}): void {
  const live = document.getElementById('live')!;
  live.textContent = '';
  // Re-set on the next frame so repeated identical messages are still read out.
  requestAnimationFrame(() => (live.textContent = message));

  const toast = document.getElementById('toast')!;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600);

  if ((speechEnabled || opts.speak) && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(message);
    u.rate = 1.1;
    speechSynthesis.speak(u);
  }
}
