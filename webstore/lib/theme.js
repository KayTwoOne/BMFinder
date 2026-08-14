/* Material 3 style dynamic colour.

   Material 3 does not ship a palette, it ships a system: one seed colour is
   expanded into tonal ramps, and every UI role (primary, surface, outline and so
   on) is a fixed tone off one of those ramps. That is why the same components can
   be purple, teal or orange without restyling anything. This does the same job in
   about a hundred lines instead of pulling in the full HCT library.

   Tones are expressed in OKLCH, which is perceptually uniform: equal lightness
   steps look equal to the eye, unlike HSL where yellows blow out and blues go
   muddy. Chromium supports oklch() natively, and this only ever runs in Chromium.

   Roles are emitted as --md-* custom properties, so switching seed or mode is one
   style recalculation with no reflow and no rebuilt DOM. */

/** Perceptual lightness per role, by mode. Mirrors M3's tone assignments
 *  (light primary is tone 40, dark primary is tone 80, and so on). */
const TONES = {
  light: {
    primary: [0.50, 1.00], onPrimary: [0.99, 0.02],
    primaryContainer: [0.90, 0.55], onPrimaryContainer: [0.30, 0.90],
    secondary: [0.55, 0.45], onSecondary: [0.99, 0.02],
    secondaryContainer: [0.92, 0.28], onSecondaryContainer: [0.32, 0.60],
    surface: [0.985, 0.06], surfaceDim: [0.90, 0.10],
    surfaceContainerLowest: [1.00, 0.02], surfaceContainerLow: [0.972, 0.07],
    surfaceContainer: [0.955, 0.09], surfaceContainerHigh: [0.935, 0.11],
    surfaceContainerHighest: [0.915, 0.13],
    onSurface: [0.22, 0.12], onSurfaceVariant: [0.44, 0.16],
    outline: [0.60, 0.14], outlineVariant: [0.84, 0.10],
    inverseSurface: [0.28, 0.10], inverseOnSurface: [0.96, 0.06],
  },
  dark: {
    primary: [0.80, 0.85], onPrimary: [0.28, 0.90],
    primaryContainer: [0.42, 0.80], onPrimaryContainer: [0.92, 0.50],
    secondary: [0.78, 0.35], onSecondary: [0.30, 0.50],
    secondaryContainer: [0.40, 0.35], onSecondaryContainer: [0.92, 0.30],
    surface: [0.17, 0.14], surfaceDim: [0.14, 0.14],
    surfaceContainerLowest: [0.12, 0.12], surfaceContainerLow: [0.20, 0.14],
    surfaceContainer: [0.23, 0.15], surfaceContainerHigh: [0.27, 0.16],
    surfaceContainerHighest: [0.32, 0.17],
    onSurface: [0.93, 0.08], onSurfaceVariant: [0.78, 0.12],
    outline: [0.60, 0.14], outlineVariant: [0.38, 0.12],
    inverseSurface: [0.92, 0.08], inverseOnSurface: [0.24, 0.10],
  },
};

// Semantic roles keep their own hue: a red error stays red whatever the seed is.
const FIXED = {
  light: {
    error: "oklch(0.52 0.20 27)", onError: "oklch(0.99 0.01 27)",
    errorContainer: "oklch(0.91 0.06 27)", onErrorContainer: "oklch(0.33 0.13 27)",
    success: "oklch(0.55 0.14 152)", successContainer: "oklch(0.91 0.06 152)",
    onSuccessContainer: "oklch(0.32 0.09 152)",
    warning: "oklch(0.62 0.14 75)", warningContainer: "oklch(0.92 0.07 75)",
    onWarningContainer: "oklch(0.35 0.09 75)",
  },
  dark: {
    error: "oklch(0.78 0.13 27)", onError: "oklch(0.28 0.11 27)",
    errorContainer: "oklch(0.42 0.13 27)", onErrorContainer: "oklch(0.92 0.05 27)",
    success: "oklch(0.80 0.13 152)", successContainer: "oklch(0.38 0.09 152)",
    onSuccessContainer: "oklch(0.92 0.06 152)",
    warning: "oklch(0.83 0.12 75)", warningContainer: "oklch(0.40 0.08 75)",
    onWarningContainer: "oklch(0.94 0.05 75)",
  },
};

/** Seed presets. Hue is the only thing that really changes; chroma is tuned per
 *  hue because some hues carry saturation better than others at the same value. */
export const SEEDS = [
  { id: "violet", name: "Violet", hue: 296, chroma: 0.15 },
  { id: "indigo", name: "Indigo", hue: 275, chroma: 0.15 },
  { id: "blue", name: "Blue", hue: 250, chroma: 0.14 },
  { id: "teal", name: "Teal", hue: 195, chroma: 0.11 },
  { id: "green", name: "Green", hue: 152, chroma: 0.12 },
  { id: "lime", name: "Lime", hue: 128, chroma: 0.13 },
  { id: "amber", name: "Amber", hue: 75, chroma: 0.13 },
  { id: "orange", name: "Orange", hue: 52, chroma: 0.14 },
  { id: "rose", name: "Rose", hue: 12, chroma: 0.14 },
  { id: "magenta", name: "Magenta", hue: 330, chroma: 0.15 },
];

const kebab = (s) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

/**
 * Build the full role set for a seed hue and mode.
 * @param {number} hue      OKLCH hue angle, 0-360
 * @param {number} chroma   base chroma, scaled per role
 * @param {'light'|'dark'} mode
 * @returns {Record<string,string>} css custom property name -> colour
 */
export function buildTheme(hue, chroma, mode) {
  const tones = TONES[mode] || TONES.dark;
  const out = {};
  for (const [role, [l, cScale]] of Object.entries(tones)) {
    out["--md-" + kebab(role)] = `oklch(${l.toFixed(3)} ${(chroma * cScale).toFixed(4)} ${hue})`;
  }
  for (const [role, value] of Object.entries(FIXED[mode] || FIXED.dark)) {
    out["--md-" + kebab(role)] = value;
  }
  return out;
}

export function applyTheme(root, { seed = "violet", hue, chroma, mode = "dark" } = {}) {
  const preset = SEEDS.find((s) => s.id === seed) || SEEDS[0];
  const h = Number.isFinite(hue) ? hue : preset.hue;
  const c = Number.isFinite(chroma) ? chroma : preset.chroma;
  const vars = buildTheme(h, c, mode === "light" ? "light" : "dark");
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.mode = mode;
  return vars;
}

/** 'system' follows the OS; anything else is taken literally. */
export function resolveMode(pref) {
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light" : "dark";
}

/** A swatch to show in the picker, independent of the current mode. */
export const seedSwatch = (s) => `oklch(0.62 ${s.chroma} ${s.hue})`;
