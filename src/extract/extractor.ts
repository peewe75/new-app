import type { Extraction, Recording, StudioProfile } from "../domain/types.js";

export interface ExtractionInput {
  recording: Recording;
  studio: StudioProfile;
  /** Momento dell'analisi: serve per risolvere "giovedì prossimo" & co. */
  now: Date;
}

/** Trasforma una trascrizione nell'elenco strutturato di fatti e azioni. */
export interface Extractor {
  readonly name: string;
  readonly model: string | null;
  extract(input: ExtractionInput): Promise<Extraction>;
}
