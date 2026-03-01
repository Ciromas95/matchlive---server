// src/utils/flags.ts
const ISO2_BY_NAME: Record<string, string> = {
  // EUROPA
  Italy: "it",
  Spain: "es",
  France: "fr",
  Germany: "de",
  Portugal: "pt",
  Netherlands: "nl",
  Belgium: "be",
  Switzerland: "ch",
  Austria: "at",
  Poland: "pl",
  Sweden: "se",
  Norway: "no",
  Denmark: "dk",
  Turkey: "tr",
  Greece: "gr",
  Ukraine: "ua",
  Russia: "ru",
  Croatia: "hr",
  Serbia: "rs",
  Albania: "al",
  Bosnia: "ba",
  Montenegro: "me",
  Kosovo: "xk",
  "North Macedonia": "mk",
  Slovakia: "sk",
  Slovenia: "si",
  Romania: "ro",
  Bulgaria: "bg",
  Hungary: "hu",
  "Czech Republic": "cz",
  Ireland: "ie",

  // UK (flagcdn supporta solo ISO2)
  England: "gb",
  Scotland: "gb",
  Wales: "gb",
  "Northern Ireland": "gb",

  // SUD AMERICA
  Argentina: "ar",
  Brazil: "br",
  Uruguay: "uy",
  Colombia: "co",
  Chile: "cl",
  Peru: "pe",
  Venezuela: "ve",
  Ecuador: "ec",

  // NORD AMERICA
  "United States": "us",
  USA: "us",
  Mexico: "mx",

  // AFRICA
  Morocco: "ma",
  Algeria: "dz",
  Tunisia: "tn",
  Egypt: "eg",
  Nigeria: "ng",
  Ghana: "gh",
  Senegal: "sn",
  Cameroon: "cm",
  "Ivory Coast": "ci",
  "Côte d'Ivoire": "ci",
  "Cote d'Ivoire": "ci",
  Gambia: "gm",

  // ASIA
  Iran: "ir",
  Japan: "jp",
  "South Korea": "kr",
  "Korea Republic": "kr",
  "Bosnia and Herzegovina": "ba",
  "Türkiye": "tr",
};

export function normalizeCountryName(name: string): string {
  const n = (name || "").trim();
  if (!n) return n;

  const map: Record<string, string> = {
    "IR Iran": "Iran",
    "Russian Federation": "Russia",
    Czechia: "Czech Republic",
    "Curaçao": "Curacao",
  };

  return map[n] ?? n;
}

export function flagUrlFromCountryName(
  name: string,
  size: 40 | 48 | 64 = 40
): string | null {
  const n = normalizeCountryName(name);
  if (!n) return null;

  const code = ISO2_BY_NAME[n];
  if (!code) return null;

  return `https://flagcdn.com/w${size}/${code}.png`;
}