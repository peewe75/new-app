import type { Recording, RecordingRef, RecordingSourceName } from "../domain/types.js";

/** Una fonte di registrazioni già trascritte (Plaud, cartella di file, ...). */
export interface RecordingSource {
  readonly name: RecordingSourceName;
  /** Registrazioni recenti, dalla più nuova. `since` esclude quelle iniziate prima. */
  listRecent(opts?: { since?: Date; limit?: number }): Promise<RecordingRef[]>;
  /** Scarica trascrizione (e riassunto, se c'è) di una registrazione. */
  fetchRecording(externalId: string): Promise<Recording>;
}

export function recordingId(source: RecordingSourceName, externalId: string): string {
  return `${source}:${externalId}`;
}
