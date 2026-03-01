// src/utils/flags.ts
const ISO2_BY_NAME: Record<string, string> = {
  Italy: "it",
  Argentina: "ar",
  Serbia: "rs",
  France: "fr",
  Spain: "es",
  Germany: "de",
  Brazil: "br",
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
  Iran: "ir",
  Japan: "jp",
  "South Korea": "kr",
  "Korea Republic": "kr",
  "United States": "us",
  USA: "us",
  Mexico: "mx",
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
  Uruguay: "uy",
  Colombia: "co",
  Chile: "cl",
  Peru: "pe",
  Venezuela: "ve",
  Ecuador: "ec",
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