/**
 * Curated list of commonly leaked / dictionary passwords with 12+ characters.
 *
 * These are the kinds of passwords users tend to invent specifically to
 * satisfy a "12 chars + letter + digit" rule (e.g. "password1234"), so the
 * length and complexity rules alone do not catch them. Match is exact and
 * case-insensitive — pre-lowercase before lookup.
 *
 * Sourced from publicly known top-leaked password lists (have-i-been-pwned,
 * SecLists rockyou-top, NCSC top-100k). Only entries with length >= 12 are
 * kept here; shorter entries are already rejected by the length check.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "passwordpassword",
  "password1234",
  "password12345",
  "password123456",
  "password1234567",
  "password12345678",
  "passwordpass",
  "passw0rdpassw0rd",
  "p@ssw0rdp@ssw0rd",
  "p@ssword1234",
  "pa$$word1234",
  "1234567890ab",
  "1234567890abcd",
  "12345678901234",
  "123456789012",
  "123456abcdef",
  "abcdef123456",
  "abcdefgh1234",
  "abcdefghij12",
  "abc123abc123",
  "qwerty123456",
  "qwertyuiopas",
  "qwertyuiop12",
  "qwerty1234567",
  "qwertyqwerty",
  "qwerty12345678",
  "1q2w3e4r5t6y",
  "1q2w3e4r5t6y7u",
  "q1w2e3r4t5y6",
  "q1w2e3r4t5y6u7",
  "asdfghjkl123",
  "asdfasdf1234",
  "zxcvbnm12345",
  "iloveyou1234",
  "iloveyou12345",
  "iloveyou123456",
  "letmein123456",
  "letmein1234567",
  "welcome123456",
  "welcome1234567",
  "welcome12345678",
  "admin1234567",
  "admin12345678",
  "administrator1",
  "administrator12",
  "monkey1234567",
  "trustno1trustno1",
  "dragon123456",
  "master123456",
  "football1234",
  "baseball1234",
  "superman1234",
  "batman1234567",
  "princess1234",
  "starwars1234",
  "sunshine1234",
  "shadow1234567",
  "michael12345",
  "jennifer1234",
  "passw0rd1234",
  "changeme1234",
  "default1234567",
]);

/**
 * Returns true if the password is in the common-password list (case-insensitive).
 */
export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}
