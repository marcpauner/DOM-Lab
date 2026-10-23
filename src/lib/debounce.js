/**
 * Returns a version of `fn` that only runs once `wait` ms have passed since
 * the last call. Ideal for reacting to typing without recomputing
 * everything on every keystroke.
 */
export function debounce(fn, wait) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
