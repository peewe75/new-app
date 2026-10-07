/**
 * Regole comuni per collegare un nome a un cliente del gestionale, usate sia
 * nella costruzione della proposta sia nell'esecuzione: nessun collegamento
 * automatico sulla sola corrispondenza del cognome.
 */
import type { ClientMatch } from "../domain/types.js";

/** Punteggio minimo per il collegamento automatico (nome e cognome, email, telefono, ragione sociale). */
export const CLIENT_LINK_MIN_SCORE = 0.7;
/** Punteggio minimo di un candidato da far verificare all'avvocato (per esempio lo stesso cognome). */
export const CLIENT_CANDIDATE_MIN_SCORE = 0.6;

/** Titoli e forme societarie ignorati nel confronto dei nomi (già privi di punti). */
const IGNORED_NAME_TOKENS: ReadonlySet<string> = new Set(
  "sig sigra signor signora dott dottssa dottor dottoressa avv avvocato ing geom rag prof srl srls spa snc sas".split(
    " ",
  ),
);

/** Il candidato con il punteggio più alto, null se l'elenco è vuoto. */
export function strongestMatch(matches: readonly ClientMatch[]): ClientMatch | null {
  return matches.reduce<ClientMatch | null>((top, m) => (top === null || m.score > top.score ? m : top), null);
}

/** Il miglior candidato se supera la soglia del collegamento automatico. */
export function linkableMatch(matches: readonly ClientMatch[]): ClientMatch | null {
  const best = strongestMatch(matches);
  return best !== null && best.score >= CLIENT_LINK_MIN_SCORE ? best : null;
}

/**
 * Cliente indicato per nome (per esempio il campo «Cliente» dell'incarico): il
 * cliente già collegato vale solo se il nome è compatibile con lui, altrimenti
 * il miglior candidato sicuro; null se nessuno, e allora il nome prevale.
 */
export function clientForName(byName: readonly ClientMatch[], linked: ClientMatch | null): ClientMatch | null {
  const agrees =
    linked !== null && byName.some((m) => m.clientId === linked.clientId && m.score >= CLIENT_CANDIDATE_MIN_SCORE);
  return agrees ? linked : linkableMatch(byName);
}

/** Parole del nome: senza accenti, minuscole, senza punti, titoli e forme societarie. */
export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "" && !IGNORED_NAME_TOKENS.has(t));
}

/**
 * Vera se tutte le parole di `partial` (almeno una) compaiono come parole
 * intere in `full`; una sola lettera vale come iniziale («Mario R.»).
 */
export function nameIncludes(full: string | null | undefined, partial: string | null | undefined): boolean {
  const wanted = nameTokens(partial);
  if (wanted.length === 0) return false;
  const own = nameTokens(full);
  return wanted.every((t) => own.some((o) => o === t || (t.length === 1 && o.startsWith(t))));
}

/** Stessa persona plausibile: le parole di un nome sono tutte nell'altro («Sig. Verdi» e «Paolo Verdi»). */
export function namesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  return nameIncludes(a, b) || nameIncludes(b, a);
}
