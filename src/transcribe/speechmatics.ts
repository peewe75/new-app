/**
 * Trascrizione con Speechmatics (API batch, regione UE «EU1»), solo fetch.
 * Flusso: invio del file con la configurazione (italiano, modello «enhanced»,
 * riconoscimento dei parlanti), controllo periodico dello stato, lettura della
 * trascrizione e cancellazione immediata del lavoro dal servizio (altrimenti
 * Speechmatics la cancella da sé dopo 7 giorni). Nessun webhook: Seguito gira
 * su un computer dello studio non raggiungibile da Internet.
 */
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { TranscriptionError, type Transcriber, type TranscribedSegment, type Transcript, type TranscriptionInput } from "./transcriber.js";

export const SPEECHMATICS_EU_URL = "https://eu1.asr.api.speechmatics.com/v2";

export interface SpeechmaticsOptions {
  apiKey: string;
  /** Indirizzo dell'API; predefinito EU1 (mai regioni fuori dall'UE). */
  baseUrl?: string;
  /** Modello: "enhanced" (predefinito, il più accurato) o "standard". */
  model?: "enhanced" | "standard";
  /** Parole da riconoscere meglio (termini giuridici, nomi ricorrenti). */
  vocabulary?: readonly string[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attesa tra un controllo e l'altro dello stato del lavoro. */
  pollIntervalMs?: number;
  /** Tempo massimo di attesa della trascrizione. */
  maxWaitMs?: number;
}

/** Termini ricorrenti nell'attività dello studio, aggiunti al vocabolario di Speechmatics. */
export const DEFAULT_LEGAL_VOCABULARY: readonly string[] = [
  "Cassazione",
  "Corte d'Appello",
  "Tribunale del Riesame",
  "GIP",
  "GUP",
  "pubblico ministero",
  "querela",
  "patteggiamento",
  "decreto penale di condanna",
  "decreto ingiuntivo",
  "atto di precetto",
  "pignoramento",
  "sovraindebitamento",
  "OCC",
  "Codice della crisi",
  "CCII",
  "IVA e CPA",
];

const UPLOAD_TIMEOUT_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_MAX_WAIT_MS = 3 * 60 * 60_000;
/** Un turno di parola si spezza a fine frase dopo una pausa o quando diventa lungo. */
const PAUSE_SPLIT_S = 1.5;
const MAX_WORDS_PER_SEGMENT = 60;

const JobCreatedSchema = z.object({ id: z.string().min(1) });

const JobStatusSchema = z.object({
  job: z.object({
    id: z.string(),
    status: z.string(),
    duration: z.number().optional(),
    errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional(),
  }),
});

const AlternativeSchema = z.object({
  content: z.string(),
  speaker: z.string().optional(),
});

const ResultSchema = z.object({
  type: z.string(),
  start_time: z.number(),
  end_time: z.number(),
  channel: z.string().optional(),
  attaches_to: z.string().optional(),
  is_eos: z.boolean().optional(),
  alternatives: z.array(AlternativeSchema).optional(),
});

const TranscriptSchema = z.object({
  job: z.object({ duration: z.number().optional() }).passthrough().optional(),
  results: z.array(ResultSchema),
});
type SpeechmaticsResult = z.infer<typeof ResultSchema>;

const MESSAGES = {
  badKey: "Chiave di Speechmatics non valida: controllare SPEECHMATICS_API_KEY.",
  noCredit: "Speechmatics ha rifiutato il lavoro (licenza o crediti esauriti): verificare l'account nel Portale di Speechmatics.",
  rejectedFile: "Speechmatics ha rifiutato il file audio: formato non supportato o file danneggiato.",
  unreachable: "Speechmatics non risponde: nuovo tentativo più tardi.",
  busy: "Speechmatics è momentaneamente sovraccarico: nuovo tentativo più tardi.",
  tooSlow: "La trascrizione richiede più del previsto: nuovo tentativo più tardi.",
  expired: "Il lavoro di trascrizione non è più disponibile su Speechmatics: verrà ripetuto.",
  unexpected: "Risposta di Speechmatics non valida: nuovo tentativo più tardi.",
} as const;

export class SpeechmaticsTranscriber implements Transcriber {
  readonly name = "speechmatics";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: SpeechmaticsOptions) {
    this.baseUrl = (opts.baseUrl ?? SPEECHMATICS_EU_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async transcribe(input: TranscriptionInput): Promise<Transcript> {
    const jobId = await this.createJob(input);
    try {
      const duration = await this.waitForJob(jobId);
      const transcript = await this.fetchTranscript(jobId);
      return {
        segments: toSegments(transcript.results),
        durationMs: secondsToMs(transcript.job?.duration ?? duration),
      };
    } finally {
      await this.deleteJob(jobId);
    }
  }

  /** Configurazione del lavoro: italiano, modello scelto, parlanti separati, vocabolario dello studio. */
  config(language: string): Record<string, unknown> {
    const vocabulary = [...new Set([...DEFAULT_LEGAL_VOCABULARY, ...(this.opts.vocabulary ?? [])])]
      .map((term) => term.trim())
      .filter((term) => term !== "");
    return {
      type: "transcription",
      transcription_config: {
        language,
        model: this.opts.model ?? "enhanced",
        diarization: "speaker",
        additional_vocab: vocabulary.map((content) => ({ content })),
      },
      tracking: { tags: ["seguito"] },
    };
  }

  private async createJob(input: TranscriptionInput): Promise<string> {
    const form = new FormData();
    form.append("config", JSON.stringify(this.config(input.language)));
    form.append("data_file", await openAsBlob(input.audioPath, { type: input.contentType }), uploadName(input.audioPath));
    const response = await this.call("POST", "/jobs", form, UPLOAD_TIMEOUT_MS);
    const parsed = JobCreatedSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new TranscriptionError(MESSAGES.unexpected, true);
    return parsed.data.id;
  }

  /** Attende la fine del lavoro; restituisce la durata dell'audio in secondi, se indicata. */
  private async waitForJob(jobId: string): Promise<number | undefined> {
    const interval = this.opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    const deadline = (this.opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS) / interval;
    for (let attempt = 0; attempt <= deadline; attempt++) {
      if (attempt > 0) await this.sleep(interval);
      const response = await this.call("GET", `/jobs/${encodeURIComponent(jobId)}?wait=0`);
      const parsed = JobStatusSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new TranscriptionError(MESSAGES.unexpected, true);
      const { status, duration, errors } = parsed.data.job;
      if (status === "done") return duration;
      if (status === "rejected") {
        const detail = errors?.map((e) => e.message).filter(Boolean).join("; ");
        throw new TranscriptionError(`${MESSAGES.rejectedFile}${detail ? ` (${detail.slice(0, 200)})` : ""}`, false);
      }
      if (status === "deleted" || status === "expired") throw new TranscriptionError(MESSAGES.expired, true);
    }
    throw new TranscriptionError(MESSAGES.tooSlow, true);
  }

  private async fetchTranscript(jobId: string): Promise<z.infer<typeof TranscriptSchema>> {
    const response = await this.call("GET", `/jobs/${encodeURIComponent(jobId)}/transcript?format=json-v2`);
    const parsed = TranscriptSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new TranscriptionError(MESSAGES.unexpected, true);
    return parsed.data;
  }

  /** Cancellazione immediata dal servizio; se non riesce, Speechmatics cancella comunque dopo 7 giorni. */
  private async deleteJob(jobId: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}?force=true`, {
          method: "DELETE",
          headers: this.headers(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok || response.status === 404) return;
      } catch {
        // nuovo tentativo
      }
      await this.sleep(2_000);
    }
    console.error(`[seguito] Lavoro Speechmatics ${jobId} non cancellato: verrà eliminato dal servizio entro 7 giorni.`);
  }

  private async call(method: "GET" | "POST", path: string, body?: FormData, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new TranscriptionError(MESSAGES.unreachable, true);
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => undefined);
    switch (response.status) {
      case 401:
        throw new TranscriptionError(MESSAGES.badKey, false);
      case 403:
        throw new TranscriptionError(MESSAGES.noCredit, false);
      case 400:
      case 413:
      case 415:
        throw new TranscriptionError(MESSAGES.rejectedFile, false);
      case 404:
        throw new TranscriptionError(MESSAGES.expired, true);
      case 429:
        throw new TranscriptionError(MESSAGES.busy, true);
      default:
        throw new TranscriptionError(`${MESSAGES.unreachable} (HTTP ${response.status})`, true);
    }
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.apiKey}`, Accept: "application/json" };
  }
}

/**
 * Dalle parole con il parlante ("S1", "S2", "UU") ai turni di parola: un nuovo
 * segmento quando cambia il parlante, oppure a fine frase dopo una pausa o un
 * turno lungo (citazioni più precise). La punteggiatura si attacca alla parola.
 */
export function toSegments(results: readonly SpeechmaticsResult[]): TranscribedSegment[] {
  const segments: TranscribedSegment[] = [];
  let current: (TranscribedSegment & { words: number; endS: number; eos: boolean }) | null = null;
  let glueNext = false;
  for (const r of results) {
    const alt = r.alternatives?.[0];
    if (alt === undefined || r.type === "entity") continue;
    if (r.type === "punctuation") {
      if (current !== null) {
        const attach = r.attaches_to ?? "previous";
        current.text += attach === "previous" || attach === "both" ? alt.content : ` ${alt.content}`;
        current.endS = Math.max(current.endS, r.end_time);
        current.endMs = secondsToMs(current.endS);
        current.eos = r.is_eos === true;
        glueNext = attach === "next" || attach === "both";
      }
      continue;
    }
    const speaker = speakerLabel(alt.speaker ?? r.channel);
    const pause = current === null ? 0 : r.start_time - current.endS;
    const split =
      current === null ||
      current.speaker !== speaker ||
      (current.eos && (pause >= PAUSE_SPLIT_S || current.words >= MAX_WORDS_PER_SEGMENT));
    if (split) {
      if (current !== null) segments.push(finish(current));
      current = {
        startMs: Math.round(r.start_time * 1000),
        endMs: secondsToMs(r.end_time),
        speaker,
        text: alt.content,
        words: 1,
        endS: r.end_time,
        eos: false,
      };
    } else if (current !== null) {
      current.text += glueNext ? alt.content : ` ${alt.content}`;
      current.words += 1;
      current.endS = r.end_time;
      current.endMs = secondsToMs(r.end_time);
      current.eos = false;
    }
    glueNext = false;
  }
  if (current !== null) segments.push(finish(current));
  return segments;
}

function finish(segment: TranscribedSegment & { words: number; endS: number; eos: boolean }): TranscribedSegment {
  return { startMs: segment.startMs, endMs: segment.endMs, speaker: segment.speaker, text: segment.text.trim() };
}

/** "S1" -> "Speaker 1", come le trascrizioni Plaud; "UU" (non riconosciuto) resta distinguibile. */
function speakerLabel(raw: string | undefined): string {
  if (raw === undefined || raw === "" || raw === "UU") return "Parlante non identificato";
  const match = /^S(\d+)$/.exec(raw);
  return match ? `Speaker ${match[1]}` : raw;
}

function secondsToMs(seconds: number | undefined): number | null {
  return seconds === undefined || !Number.isFinite(seconds) ? null : Math.round(seconds * 1000);
}

/** Nome neutro per il file inviato: nessun nome di cliente nei metadati del servizio. */
function uploadName(audioPath: string): string {
  return `registrazione-${basename(audioPath).slice(0, 8)}.m4a`;
}
