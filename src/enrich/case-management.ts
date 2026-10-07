import type { Client, ClientMatch, Matter, MatterNote } from "../domain/types.js";

export interface ClientQuery {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  organization?: string | null;
}

/**
 * Collegamento al gestionale dello studio. L'implementazione di riferimento
 * (JsonCaseManagement) lavora su un file JSON; gli adattatori per i gestionali
 * reali implementeranno la stessa interfaccia.
 */
export interface CaseManagement {
  readonly name: string;
  /** Candidati ordinati per punteggio decrescente (score 0..1). */
  findClients(query: ClientQuery): Promise<ClientMatch[]>;
  getClient(id: string): Promise<Client | null>;
  createClient(input: Omit<Client, "id">): Promise<Client>;
  listMatters(clientId: string): Promise<Matter[]>;
  createMatter(input: { clientId: string; title: string; status: Matter["status"] }): Promise<Matter>;
  addMatterNote(matterId: string, note: Omit<MatterNote, "id" | "at">): Promise<MatterNote>;
}
