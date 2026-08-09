import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  resolveLocale,
  SUPPORTED_LOCALES,
  translate,
  type LocaleCode,
  type TranslationKey,
  type TranslationParams,
} from ".";

const STORAGE_KEY = "mely.locale";

interface I18nContextValue {
  locale: LocaleCode;
  locales: readonly LocaleCode[];
  setLocale: (locale: LocaleCode) => void;
  t: (key: TranslationKey, params?: TranslationParams) => string;
  number: (value: number) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const initialLocale = () => {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (SUPPORTED_LOCALES.includes(saved as LocaleCode)) return saved as LocaleCode;
  return resolveLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(initialLocale);
  const setLocale = useCallback((nextLocale: LocaleCode) => {
    if (!SUPPORTED_LOCALES.includes(nextLocale)) return;
    window.localStorage.setItem(STORAGE_KEY, nextLocale);
    setLocaleState(nextLocale);
  }, []);
  const t = useCallback((key: TranslationKey, params?: TranslationParams) => (
    translate(locale, key, params)
  ), [locale]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const number = useCallback((value: number) => numberFormatter.format(value), [numberFormatter]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.documentTitle");
  }, [locale, t]);

  const value = useMemo(() => ({ locale, locales: SUPPORTED_LOCALES, setLocale, t, number }), [locale, number, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => {
  const context = useContext(I18nContext);
  if (!context) throw new Error("I18N_PROVIDER_MISSING");
  return context;
};
