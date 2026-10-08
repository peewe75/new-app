/**
 * Approvazione di una proposta: convalida della scelta e delle modifiche
 * dell'avvocato, poi esecuzione in sequenza delle sole azioni approvate.
 */
import {
  ActionPayloadSchema,
  type ActionPayload,
  type ApprovalRequest,
  type ExecutionResult,
  type Proposal,
  type ProposedAction,
  type Recording,
  type StudioProfile,
} from "../domain/types.js";
import type { CaseManagement } from "../enrich/case-management.js";
import type { ActionExecutor, ExecutionContext } from "./executor.js";
import { defaultExecutors } from "./executors.js";
import { ACTION_LABELS } from "./format.js";
import { ConnectorError } from "./office.js";

/** La proposta non è nello stato richiesto dall'operazione. */
export class ProposalStateError extends Error {
  override name = "ProposalStateError";
}

/** Richiesta di approvazione non valida (azioni o modifiche). */
export class ApprovalValidationError extends Error {
  override name = "ApprovalValidationError";
}

export interface ApproveProposalArgs {
  proposal: Proposal;
  request: ApprovalRequest;
  recording: Recording;
  studio: StudioProfile;
  outboxDir: string;
  caseManagement: CaseManagement;
  now: Date;
  executors?: ActionExecutor[];
}

const APPROVABLE: ReadonlySet<Proposal["status"]> = new Set(["da_revisionare", "eseguita_parzialmente"]);

const STATUS_LABELS: Record<Proposal["status"], string> = {
  da_revisionare: "da revisionare",
  eseguita: "già stata eseguita",
  eseguita_parzialmente: "stata eseguita in parte",
  scartata: "stata scartata",
};

const SYSTEM_ERRORS: Record<string, string> = {
  EACCES: "permessi insufficienti sulla cartella o sul file",
  EPERM: "operazione non consentita dal sistema",
  ENOSPC: "spazio su disco esaurito",
  EROFS: "il disco è in sola lettura",
  ENOENT: "file o cartella non trovati",
  EISDIR: "è stata trovata una cartella al posto di un file",
  EMFILE: "troppi file aperti",
};

export async function approveProposal(args: ApproveProposalArgs): Promise<Proposal> {
  const { proposal, request, now } = args;
  if (!canApprove(proposal)) {
    throw new ProposalStateError(`La proposta è ${STATUS_LABELS[proposal.status]}: non può essere approvata.`);
  }
  if (args.recording.id !== proposal.recordingId) {
    throw new ApprovalValidationError("La registrazione indicata non corrisponde alla proposta.");
  }
  const executed = new Set(proposal.executions.filter((e) => e.status === "ok").map((e) => e.actionId));
  const approved = validateSelection(proposal, request.actionIds);
  if ([...approved].every((id) => executed.has(id))) {
    throw new ApprovalValidationError(
      "Le azioni selezionate sono già state eseguite: selezionarne almeno una ancora da eseguire.",
    );
  }
  const actions = applyEdits(proposal.actions, approved, executed, request.edits ?? {});
  const updated: Proposal = { ...structuredClone(proposal), actions };

  const ctx: ExecutionContext = {
    proposal: updated,
    recording: args.recording,
    studio: args.studio,
    outboxDir: args.outboxDir,
    caseManagement: args.caseManagement,
    now,
    approvedActionIds: approved,
  };
  const executors = args.executors ?? defaultExecutors();
  const results: ExecutionResult[] = [];
  for (const action of executionOrder(actions.filter((a) => approved.has(a.id)))) {
    results.push(
      executed.has(action.id)
        ? result(action, now, "saltata", "Già eseguita")
        : await runAction(action, executors, ctx),
    );
  }
  const executions = [...updated.executions, ...results];
  return {
    ...updated,
    executions,
    updatedAt: now.toISOString(),
    status: hasUnresolvedErrors(executions) ? "eseguita_parzialmente" : "eseguita",
  };
}

/** Vera se un'azione è finita in errore, in questa o in una precedente approvazione, e non è mai riuscita. */
function hasUnresolvedErrors(executions: ExecutionResult[]): boolean {
  const succeeded = new Set(executions.filter((e) => e.status === "ok").map((e) => e.actionId));
  return executions.some((e) => e.status === "errore" && !succeeded.has(e.actionId));
}

export function discardProposal(proposal: Proposal, now: Date): Proposal {
  if (proposal.status !== "da_revisionare") {
    throw new ProposalStateError(
      `La proposta è ${STATUS_LABELS[proposal.status]}: si possono scartare solo le proposte da revisionare.`,
    );
  }
  return { ...structuredClone(proposal), status: "scartata", updatedAt: now.toISOString() };
}

/**
 * Una proposta eseguita resta approvabile per le azioni non ancora eseguite
 * (es. una scadenza lasciata da parte per verificarla sul fascicolo).
 */
function canApprove(proposal: Proposal): boolean {
  if (APPROVABLE.has(proposal.status)) return true;
  if (proposal.status !== "eseguita") return false;
  const done = new Set(proposal.executions.filter((e) => e.status === "ok").map((e) => e.actionId));
  return proposal.actions.some((a) => !done.has(a.id));
}

function validateSelection(proposal: Proposal, actionIds: string[]): Set<string> {
  const known = new Set(proposal.actions.map((a) => a.id));
  const unknown = [...new Set(actionIds.filter((id) => !known.has(id)))];
  if (unknown.length > 0) {
    throw new ApprovalValidationError(`Azioni inesistenti nella proposta: ${unknown.join(", ")}.`);
  }
  if (actionIds.length === 0) {
    throw new ApprovalValidationError("Nessuna azione selezionata: selezionarne almeno una da approvare.");
  }
  return new Set(actionIds);
}

/** Restituisce nuove azioni con i payload modificati e convalidati. */
function applyEdits(
  actions: ProposedAction[],
  approved: ReadonlySet<string>,
  executed: ReadonlySet<string>,
  edits: Record<string, Record<string, unknown>>,
): ProposedAction[] {
  const known = new Set(actions.map((a) => a.id));
  for (const id of Object.keys(edits)) {
    if (!known.has(id)) throw new ApprovalValidationError(`Modifiche per un'azione inesistente: ${id}.`);
    if (!approved.has(id)) {
      throw new ApprovalValidationError(`Modifiche per l'azione ${id}, che non è tra quelle approvate.`);
    }
    if (executed.has(id)) {
      throw new ApprovalValidationError(`L'azione ${id} è già stata eseguita: non può essere modificata.`);
    }
  }
  return actions.map((action) => {
    const copy = structuredClone(action);
    const changes = Object.hasOwn(edits, action.id) ? edits[action.id] : undefined;
    return changes === undefined ? copy : { ...copy, payload: editedPayload(copy, changes) };
  });
}

function editedPayload(action: ProposedAction, changes: Record<string, unknown>): ActionPayload {
  const label = `${action.id} (${ACTION_LABELS[action.payload.type]})`;
  if (Object.hasOwn(changes, "type")) {
    throw new ApprovalValidationError(`Il tipo dell'azione ${label} non è modificabile.`);
  }
  const unknownFields = Object.keys(changes).filter((key) => !Object.hasOwn(action.payload, key));
  if (unknownFields.length > 0) {
    throw new ApprovalValidationError(`Campi inesistenti per l'azione ${label}: ${unknownFields.join(", ")}.`);
  }
  const parsed = ActionPayloadSchema.safeParse({ ...action.payload, ...changes });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "dati"))];
    throw new ApprovalValidationError(`Valori non validi per l'azione ${label} nei campi: ${fields.join(", ")}.`);
  }
  return reconcileEdits(action.payload, parsed.data, changes);
}

/**
 * Coerenza dopo le modifiche dell'avvocato: un appuntamento da fissare a cui
 * è stata data una data diventa fissato; una scadenza con la data corretta non
 * porta più il calcolo originario, che resta nelle note come superato.
 */
function reconcileEdits(
  original: ActionPayload,
  edited: ActionPayload,
  changes: Record<string, unknown>,
): ActionPayload {
  if (
    original.type === "appuntamento" &&
    edited.type === "appuntamento" &&
    edited.status === "da_fissare" &&
    !Object.hasOwn(changes, "status") &&
    edited.start !== null &&
    edited.start !== original.start
  ) {
    return { ...edited, status: "fissato" };
  }
  if (
    original.type === "scadenza" &&
    edited.type === "scadenza" &&
    edited.date !== original.date &&
    original.computation !== null &&
    !Object.hasOwn(changes, "computation")
  ) {
    const note = `Data corretta dall'avvocato: il calcolo originario («${original.computation}») non è più valido.`;
    return { ...edited, computation: null, notes: edited.notes ? `${edited.notes}\n${note}` : note };
  }
  return edited;
}

/** Prima gli incarichi: possono creare il cliente e la pratica usati dalle altre azioni. */
function executionOrder(actions: ProposedAction[]): ProposedAction[] {
  return [
    ...actions.filter((a) => a.payload.type === "incarico"),
    ...actions.filter((a) => a.payload.type !== "incarico"),
  ];
}

async function runAction(
  action: ProposedAction,
  executors: ActionExecutor[],
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const executor = executors.find((e) => e.canHandle(action));
  if (executor === undefined) {
    return result(action, ctx.now, "errore", "Nessun esecutore disponibile per questo tipo di azione.");
  }
  try {
    return await executor.execute(action, ctx);
  } catch (err) {
    return result(action, ctx.now, "errore", userMessage(err));
  }
}

/** Messaggio in italiano per l'avvocato, senza dettagli tecnici. */
function userMessage(err: unknown): string {
  // I servizi collegati (es. Microsoft 365) preparano già un messaggio per l'avvocato.
  if (err instanceof ConnectorError && err.message.trim() !== "") return err.message;
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
    const reason = SYSTEM_ERRORS[err.code] ?? `codice ${err.code}`;
    return `Errore di sistema durante l'esecuzione: ${reason}.`;
  }
  // Gli errori generici del progetto hanno già un messaggio in italiano per l'utente.
  if (err instanceof Error && err.constructor === Error && err.message.trim() !== "") return err.message;
  return "Errore imprevisto durante l'esecuzione dell'azione.";
}

function result(
  action: ProposedAction,
  now: Date,
  status: ExecutionResult["status"],
  message: string,
): ExecutionResult {
  return { actionId: action.id, executedAt: now.toISOString(), status, message, artifacts: [] };
}
