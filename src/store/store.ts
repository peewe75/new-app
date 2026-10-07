import type { Proposal, Recording } from "../domain/types.js";

/** Persistenza locale di registrazioni, proposte e checkpoint di sincronizzazione. */
export interface Store {
  saveRecording(recording: Recording): Promise<void>;
  getRecording(id: string): Promise<Recording | null>;
  hasRecording(id: string): Promise<boolean>;

  saveProposal(proposal: Proposal): Promise<void>;
  /**
   * Salva una proposta nuova solo se non ne esiste già una con lo stesso id
   * (anche creata da un altro processo); false se esisteva, senza modificarla.
   */
  createProposal(proposal: Proposal): Promise<boolean>;
  getProposal(id: string): Promise<Proposal | null>;
  /** Dalla più recente (per recording.startedAt). */
  listProposals(): Promise<Proposal[]>;

  getCheckpoint(key: string): Promise<string | null>;
  setCheckpoint(key: string, value: string): Promise<void>;
}
