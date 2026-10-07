import type { CaseManagement } from "../enrich/case-management.js";
import type { ExecutionResult, Proposal, ProposedAction, Recording, StudioProfile } from "../domain/types.js";

export interface ExecutionContext {
  proposal: Proposal;
  recording: Recording;
  studio: StudioProfile;
  /** Cartella dove scrivere .ics/.eml (una sottocartella per proposta). */
  outboxDir: string;
  caseManagement: CaseManagement;
  now: Date;
  /** Azioni approvate in questa esecuzione (comprese quelle già eseguite in precedenza). */
  approvedActionIds: ReadonlySet<string>;
}

/** Esegue un tipo di azione approvata. */
export interface ActionExecutor {
  readonly name: string;
  canHandle(action: ProposedAction): boolean;
  execute(action: ProposedAction, ctx: ExecutionContext): Promise<ExecutionResult>;
}
