import ISO6391 from "iso-639-1";
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";

countries.registerLocale(enLocale);

export interface LocaleOption {
  value: string;
  label: string;
}

export function getLanguageOptions(): LocaleOption[] {
  return ISO6391.getAllCodes()
    .map((code) => ({ value: code, label: ISO6391.getName(code) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getCountryOptions(): LocaleOption[] {
  const names = countries.getNames("en", { select: "official" });
  return Object.entries(names)
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
