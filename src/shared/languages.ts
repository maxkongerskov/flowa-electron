// Port of Flowa/Support/LanguageOption.swift — Whisper large-v3 / large-v3-turbo
// language catalog (100 codes + Auto-detect). Same codes, same names, same order.

export interface LanguageOption {
  code: string
  displayName: string
}

const langs: LanguageOption[] = [
  { code: 'af', displayName: 'Afrikaans' },
  { code: 'sq', displayName: 'Albanian' },
  { code: 'am', displayName: 'Amharic' },
  { code: 'ar', displayName: 'Arabic' },
  { code: 'hy', displayName: 'Armenian' },
  { code: 'as', displayName: 'Assamese' },
  { code: 'az', displayName: 'Azerbaijani' },
  { code: 'ba', displayName: 'Bashkir' },
  { code: 'eu', displayName: 'Basque' },
  { code: 'be', displayName: 'Belarusian' },
  { code: 'bn', displayName: 'Bengali' },
  { code: 'bs', displayName: 'Bosnian' },
  { code: 'br', displayName: 'Breton' },
  { code: 'bg', displayName: 'Bulgarian' },
  { code: 'my', displayName: 'Burmese' },
  { code: 'yue', displayName: 'Cantonese' },
  { code: 'ca', displayName: 'Catalan' },
  { code: 'zh', displayName: 'Chinese' },
  { code: 'hr', displayName: 'Croatian' },
  { code: 'cs', displayName: 'Czech' },
  { code: 'da', displayName: 'Danish' },
  { code: 'nl', displayName: 'Dutch' },
  { code: 'en', displayName: 'English' },
  { code: 'et', displayName: 'Estonian' },
  { code: 'fo', displayName: 'Faroese' },
  { code: 'fi', displayName: 'Finnish' },
  { code: 'fr', displayName: 'French' },
  { code: 'gl', displayName: 'Galician' },
  { code: 'ka', displayName: 'Georgian' },
  { code: 'de', displayName: 'German' },
  { code: 'el', displayName: 'Greek' },
  { code: 'gu', displayName: 'Gujarati' },
  { code: 'ht', displayName: 'Haitian Creole' },
  { code: 'ha', displayName: 'Hausa' },
  { code: 'haw', displayName: 'Hawaiian' },
  { code: 'he', displayName: 'Hebrew' },
  { code: 'hi', displayName: 'Hindi' },
  { code: 'hu', displayName: 'Hungarian' },
  { code: 'is', displayName: 'Icelandic' },
  { code: 'id', displayName: 'Indonesian' },
  { code: 'it', displayName: 'Italian' },
  { code: 'ja', displayName: 'Japanese' },
  { code: 'jw', displayName: 'Javanese' },
  { code: 'kn', displayName: 'Kannada' },
  { code: 'kk', displayName: 'Kazakh' },
  { code: 'km', displayName: 'Khmer' },
  { code: 'ko', displayName: 'Korean' },
  { code: 'lo', displayName: 'Lao' },
  { code: 'la', displayName: 'Latin' },
  { code: 'lv', displayName: 'Latvian' },
  { code: 'ln', displayName: 'Lingala' },
  { code: 'lt', displayName: 'Lithuanian' },
  { code: 'lb', displayName: 'Luxembourgish' },
  { code: 'mk', displayName: 'Macedonian' },
  { code: 'mg', displayName: 'Malagasy' },
  { code: 'ms', displayName: 'Malay' },
  { code: 'ml', displayName: 'Malayalam' },
  { code: 'mt', displayName: 'Maltese' },
  { code: 'mi', displayName: 'Maori' },
  { code: 'mr', displayName: 'Marathi' },
  { code: 'mn', displayName: 'Mongolian' },
  { code: 'ne', displayName: 'Nepali' },
  { code: 'no', displayName: 'Norwegian' },
  { code: 'nn', displayName: 'Norwegian Nynorsk' },
  { code: 'oc', displayName: 'Occitan' },
  { code: 'ps', displayName: 'Pashto' },
  { code: 'fa', displayName: 'Persian' },
  { code: 'pl', displayName: 'Polish' },
  { code: 'pt', displayName: 'Portuguese' },
  { code: 'pa', displayName: 'Punjabi' },
  { code: 'ro', displayName: 'Romanian' },
  { code: 'ru', displayName: 'Russian' },
  { code: 'sa', displayName: 'Sanskrit' },
  { code: 'sr', displayName: 'Serbian' },
  { code: 'sn', displayName: 'Shona' },
  { code: 'sd', displayName: 'Sindhi' },
  { code: 'si', displayName: 'Sinhala' },
  { code: 'sk', displayName: 'Slovak' },
  { code: 'sl', displayName: 'Slovenian' },
  { code: 'so', displayName: 'Somali' },
  { code: 'es', displayName: 'Spanish' },
  { code: 'su', displayName: 'Sundanese' },
  { code: 'sw', displayName: 'Swahili' },
  { code: 'sv', displayName: 'Swedish' },
  { code: 'tl', displayName: 'Tagalog' },
  { code: 'tg', displayName: 'Tajik' },
  { code: 'ta', displayName: 'Tamil' },
  { code: 'tt', displayName: 'Tatar' },
  { code: 'te', displayName: 'Telugu' },
  { code: 'th', displayName: 'Thai' },
  { code: 'bo', displayName: 'Tibetan' },
  { code: 'tr', displayName: 'Turkish' },
  { code: 'tk', displayName: 'Turkmen' },
  { code: 'uk', displayName: 'Ukrainian' },
  { code: 'ur', displayName: 'Urdu' },
  { code: 'uz', displayName: 'Uzbek' },
  { code: 'vi', displayName: 'Vietnamese' },
  { code: 'cy', displayName: 'Welsh' },
  { code: 'yi', displayName: 'Yiddish' },
  { code: 'yo', displayName: 'Yoruba' }
]

// Swift sorts with `<` on String (code-point order); mirror that, not localeCompare.
const byName = (a: LanguageOption, b: LanguageOption): number =>
  a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0

export const allLanguages: LanguageOption[] = [
  { code: 'auto', displayName: 'Auto-detect' },
  ...[...langs].sort(byName)
]

export function languageDisplayName(code: string): string {
  return allLanguages.find((o) => o.code === code)?.displayName ?? code
}

export function filterLanguages(query: string): LanguageOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return allLanguages
  return allLanguages.filter(
    (o) => o.displayName.toLowerCase().includes(q) || o.code.toLowerCase().startsWith(q)
  )
}
