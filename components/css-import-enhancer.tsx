"use client";

/**
 * CSS import now lives in the shared CSSSchemeBar, which covers every
 * custom-CSS editor that uses the scheme controls. Keep this mount as a
 * no-op for compatibility with existing layouts.
 */
export function CSSImportEnhancer() {
  return null;
}
