import { createSignal } from "solid-js";
import enUS from "./en-US.json";

type Translations = Record<string, string>;

const locales: Record<string, Translations> = {
  "en-US": enUS,
};

const [currentLocale, setCurrentLocale] = createSignal("en-US");

/** Load additional locale data at runtime. */
export function registerLocale(locale: string, translations: Translations): void {
  locales[locale] = translations;
}

/** Get the current locale code. */
export function getLocale(): string {
  return currentLocale();
}

/** Set the active locale. Must be previously registered or built-in. */
export function setLocale(locale: string): void {
  if (!locales[locale]) {
    console.warn(`[i18n] Locale "${locale}" not registered, falling back to en-US`);
    return;
  }
  setCurrentLocale(locale);
}

/**
 * Translate a dot-separated key.
 * Returns the key itself when no translation is found.
 */
export function t(key: string): string {
  const dict = locales[currentLocale()];
  return dict?.[key] ?? key;
}
