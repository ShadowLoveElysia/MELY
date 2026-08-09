import { enUS } from "./locales/en-US";
import { jaJP } from "./locales/ja-JP";
import { zhCN, type TranslationKey } from "./locales/zh-CN";
import type { LocaleCode, TranslationDictionary, TranslationParams } from "./localeTypes";

export type { LocaleCode, TranslationParams } from "./localeTypes";
export type { TranslationKey } from "./locales/zh-CN";

export const DEFAULT_LOCALE: LocaleCode = "en-US";
export const SUPPORTED_LOCALES: readonly LocaleCode[] = ["zh-CN", "en-US", "ja-JP"];

const dictionaries: Record<LocaleCode, TranslationDictionary> = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "ja-JP": jaJP,
};

export const resolveLocale = (languages: readonly string[]): LocaleCode => {
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized.startsWith("zh")) return "zh-CN";
    if (normalized.startsWith("ja")) return "ja-JP";
    if (normalized.startsWith("en")) return "en-US";
  }
  return DEFAULT_LOCALE;
};

export const translate = (
  locale: LocaleCode,
  key: TranslationKey,
  params: TranslationParams = {},
) => {
  const template = dictionaries[locale][key] ?? dictionaries[DEFAULT_LOCALE][key];
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name] ?? `{{${name}}}`));
};

export const translationKeyExists = (key: string): key is TranslationKey => (
  SUPPORTED_LOCALES.every((locale) => key in dictionaries[locale])
);

export const translationEntries = (locale: LocaleCode): Readonly<TranslationDictionary> => dictionaries[locale];
