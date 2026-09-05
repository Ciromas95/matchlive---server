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
  "Republic of Ireland": "ie",
  "IRL": "ie",
  Latvia: "lv",
  Lithuania: "lt",
  Estonia: "ee",
  "Faroe Islands": "fo",
  Andorra: "ad",
  Liechtenstein: "li",
  "San Marino": "sm",
  Gibraltar: "gi",
  Canada: "ca",
  Paraguay: "py",
  Bolivia: "bo",
  Honduras: "hn",
  Guatemala: "gt",
  "El Salvador": "sv",
  Nicaragua: "ni",
  "Costa Rica": "cr",
  Panama: "pa",
  Cuba: "cu",
  Jamaica: "jm",
  Haiti: "ht",
  "Dominican Republic": "do",
  "Trinidad and Tobago": "tt",
  Curacao: "cw",
  "Curaçao": "cw",
  "Cape Verde": "cv",
  Guinea: "gn",
  "Guinea Bissau": "gw",
  "Guinea-Bissau": "gw",
  Liberia: "lr",
  Mauritania: "mr",
  "Sierra Leone": "sl",
  Togo: "tg",
  Benin: "bj",
  "Burkina Faso": "bf",
  Madagascar: "mg",
  Malawi: "mw",
  Botswana: "bw",
  Namibia: "na",
  Lesotho: "ls",
  Eswatini: "sz",
  Angola: "ao",
  Ethiopia: "et",
  Libya: "ly",
  Mali: "ml",
  Mozambique: "mz",
  Niger: "ne",
  Rwanda: "rw",
  Sudan: "sd",
  Tanzania: "tz",
  Uganda: "ug",
  Zambia: "zm",
  Zimbabwe: "zw",
  Syria: "sy",
  Lebanon: "lb",
  Jordan: "jo",
  Kuwait: "kw",
  Oman: "om",
  Yemen: "ye",
  Pakistan: "pk",
  Bangladesh: "bd",
  "Sri Lanka": "lk",
  Nepal: "np",
  Philippines: "ph",
  Singapore: "sg",
  "Hong Kong": "hk",
  Taiwan: "tw",
  "New Zealand": "nz",
  Kazakhstan: "kz",
  Uzbekistan: "uz",
  Kyrgyzstan: "kg",
  Tajikistan: "tj",
  Turkmenistan: "tm",
  Afghanistan: "af",
  Palestine: "ps",
};

const ISO2_BY_NORMALIZED_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(ISO2_BY_NAME).map(([name, code]) => [
    normalizeKey(name),
    code,
  ])
);

const DIRECT_CODES = new Set([
  "xk",
  "gb-eng",
  "gb-sct",
  "gb-wls",
  "gb-nir",
]);

function normalizeKey(name: string): string {
  return (name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

  const direct = n.trim().toLowerCase();
  const code =
    /^[a-z]{2}$/.test(direct) || DIRECT_CODES.has(direct)
      ? direct
      : ISO2_BY_NAME[n] ?? ISO2_BY_NORMALIZED_NAME[normalizeKey(n)];
  if (!code) return null;

  return `https://flagcdn.com/w${size}/${code}.png`;
}
