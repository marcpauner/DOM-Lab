const PREFIX = 'dom-lab:';

// localStorage can fail (private mode, full or blocked storage), so every
// preference always has a default value.

export function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Without storage the app still works; it just won't remember the preference.
  }
}
