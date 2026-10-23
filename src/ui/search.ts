import { LngLat } from '../core/geo';
import { Place, searchPlaces } from '../geocode/photon';
import { announce } from './a11y';

/**
 * Accessible combobox: type, ↑/↓ through suggestions, Enter to pick, Esc to close.
 */
export function attachSearch(
  input: HTMLInputElement,
  list: HTMLUListElement,
  near: () => LngLat,
  onPick: (place: Place) => void,
): void {
  let results: Place[] = [];
  let active = -1;
  let timer: number | undefined;
  let abort: AbortController | null = null;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');

  const render = () => {
    list.innerHTML = '';
    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.role = 'option';
      li.textContent = r.label;
      li.setAttribute('aria-selected', String(i === active));
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(i);
      });
      list.appendChild(li);
    });
    input.setAttribute('aria-expanded', String(results.length > 0));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const close = () => {
    results = [];
    active = -1;
    render();
  };

  const pick = (i: number) => {
    const place = results[i];
    if (!place) return;
    input.value = place.label;
    close();
    onPick(place);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = window.setTimeout(async () => {
      abort?.abort();
      abort = new AbortController();
      try {
        results = await searchPlaces(q, near(), abort.signal);
        active = results.length ? 0 : -1;
        render();
        announce(results.length ? `${results.length} suggestions. Use up and down arrows.` : 'No places found.');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') announce(`Search failed: ${(e as Error).message}`);
      }
    }, 300);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Enter' && results.length) {
      e.preventDefault();
      pick(Math.max(0, active));
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}
