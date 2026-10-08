/**
 * Collegamento a Microsoft 365 costruito dalla configurazione: accesso
 * delegato, client Graph e ufficio (calendario Outlook e bozze).
 */
import type { Microsoft365Config } from "../../config.js";
import { FileTokenStore, Microsoft365Auth, type TokenStore } from "./auth.js";
import { GraphClient } from "./graph.js";
import { Microsoft365Office } from "./office.js";

export { Microsoft365Auth, Microsoft365AuthError } from "./auth.js";
export { Microsoft365Office } from "./office.js";

export interface Microsoft365 {
  auth: Microsoft365Auth;
  office: Microsoft365Office;
}

/** Permessi delegati: bozze e calendario; l'invio solo se la trascrizione va inviata. */
export function microsoft365Scopes(transcriptDelivery: Microsoft365Config["transcriptDelivery"]): string[] {
  return ["User.Read", "Mail.ReadWrite", "Calendars.ReadWrite", ...(transcriptDelivery === "invio" ? ["Mail.Send"] : [])];
}

/** null se la configurazione è incompleta (tenant, id o segreto mancanti). */
export function createMicrosoft365(
  config: Microsoft365Config,
  deps: { fetchImpl?: typeof fetch; tokenStore?: TokenStore } = {},
): Microsoft365 | null {
  const { tenantId, clientId, clientSecret } = config;
  if (!config.configured || tenantId === null || clientId === null || clientSecret === null) return null;
  if (!URL.canParse(config.redirectUri)) {
    throw new Error(
      `SEGUITO_M365_REDIRECT_URI non è un indirizzo valido («${config.redirectUri}»): indicare lo stesso indirizzo ` +
        "registrato nell'applicazione Microsoft, per esempio http://localhost:3000/auth/microsoft/callback.",
    );
  }
  const auth = new Microsoft365Auth({
    tenantId,
    clientId,
    clientSecret,
    redirectUri: config.redirectUri,
    scopes: microsoft365Scopes(config.transcriptDelivery),
    tokenStore: deps.tokenStore ?? new FileTokenStore(config.tokensFile),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  const graph = new GraphClient({
    accessToken: (forceRefresh) => auth.accessToken(forceRefresh),
    // Token rifiutato anche dopo il rinnovo: l'interfaccia torna a proporre «Collega Microsoft 365».
    onAuthFailure: () => auth.disconnect(),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  return { auth, office: new Microsoft365Office({ graph, transcriptDelivery: config.transcriptDelivery }) };
}
