/**
 * Estrattore di esempio: legge un'analisi già pronta da
 * "<dir>/<externalId>.extraction.json" (demo e prove senza chiave API).
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ExtractionSchema, type Extraction } from "../domain/types.js";
import { ExtractionError } from "./claude-extractor.js";
import type { ExtractionInput, Extractor } from "./extractor.js";

export class FixtureExtractor implements Extractor {
  readonly name = "fixture";
  readonly model = null;
  private readonly dir: string;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
  }

  async extract(input: ExtractionInput): Promise<Extraction> {
    const { externalId } = input.recording;
    if (basename(externalId) !== externalId) {
      throw new ExtractionError(`Identificativo di registrazione non valido: «${externalId}».`);
    }
    const file = join(this.dir, `${externalId}.extraction.json`);
    const raw = await this.readFixture(file, externalId);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new ExtractionError(`Il file di analisi di esempio ${file} non contiene JSON valido.`, { cause: error });
    }
    const parsed = ExtractionSchema.safeParse(json);
    if (!parsed.success) {
      throw new ExtractionError(`Il file di analisi di esempio ${file} non è conforme allo schema atteso.`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  private async readFixture(file: string, externalId: string): Promise<string> {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        throw new ExtractionError(
          `Nessuna analisi di esempio per la registrazione «${externalId}» (${file}). ` +
            "Per l'analisi reale con Claude impostare la variabile ANTHROPIC_API_KEY.",
          { cause: error },
        );
      }
      throw new ExtractionError(`Impossibile leggere il file di analisi di esempio ${file}.`, { cause: error });
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
