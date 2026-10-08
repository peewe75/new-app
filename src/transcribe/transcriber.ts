/**
 * Trascrizione dell'audio registrato con il telefono (le registrazioni del
 * Plaud arrivano già trascritte). Restituisce i segmenti con il parlante,
 * nello stesso formato delle trascrizioni Plaud.
 */
export interface TranscriptionInput {
  /** File audio sul disco (m4a, mp3, wav, ...). */
  audioPath: string;
  /** Tipo MIME dichiarato, es. "audio/mp4". */
  contentType: string;
  /** Lingua della conversazione (codice ISO 639-1). */
  language: string;
  /** Arresto di Seguito: il servizio interrompe l'attesa e libera le risorse. */
  signal?: AbortSignal;
}

export interface TranscribedSegment {
  startMs: number;
  endMs: number | null;
  /** Etichetta del parlante, es. "Speaker 1". */
  speaker: string;
  text: string;
}

export interface Transcript {
  segments: TranscribedSegment[];
  /** Durata dell'audio, se il servizio la indica. */
  durationMs: number | null;
}

export interface Transcriber {
  /** Nome del servizio, es. "speechmatics". */
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<Transcript>;
}

/**
 * Trascrizione non riuscita, con un messaggio in italiano per l'avvocato.
 * `retryable` indica se un nuovo tentativo può riuscire (servizio non
 * raggiungibile, limiti temporanei) o se darebbe lo stesso esito.
 */
export class TranscriptionError extends Error {
  override name = "TranscriptionError";

  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
